import { onTestFinished } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sentinel } from "./sentinels.js";

const entrypoint = resolve(import.meta.dir, "../../src/cli.ts");

const INHERITED_ENV = ["PATH", "SystemRoot", "BUN_OPTIONS", "TAU_COVERAGE_DIR"];

export interface RunCliOptions {
  args?: readonly string[];
  /** Workspace files written before launch, keyed by path relative to cwd. */
  files?: Readonly<Record<string, string>>;
  /** Applied last; undefined removes a variable. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Points the CLI at this provider with a sentinel API key. */
  provider?: { url: string };
  stdin?: string;
  /** Kills the whole process tree after this long. Default 20s. */
  deadlineMs?: number;
  onSpawn?: (child: ChildProcess) => void;
}

export interface CliRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  /** True when the deadline killed the process tree. */
  timedOut: boolean;
  root: string;
  home: string;
  cwd: string;
}

/**
 * Runs the real tau entrypoint in a fresh temporary root with its own home,
 * workspace, config, state, managed and temp directories and a whitelisted
 * environment. The root is removed when the current test finishes.
 */
export async function runCli(options: RunCliOptions = {}): Promise<CliRun> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tau-cli-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dirs = {
    home: join(root, "home"),
    cwd: join(root, "workspace"),
    config: join(root, "config"),
    state: join(root, "state"),
    managed: join(root, "managed"),
    tmp: join(root, "tmp"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  for (const [file, content] of Object.entries(options.files ?? {})) {
    const path = join(dirs.cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  const env: Record<string, string | undefined> = {
    ...Object.fromEntries(INHERITED_ENV.map((key) => [key, process.env[key]])),
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.config,
    TAU_HOME: dirs.state,
    TAU_MANAGED_ROOT: dirs.managed,
    TMPDIR: dirs.tmp,
    CI: "true",
    ...(options.provider === undefined
      ? {}
      : {
          ANTHROPIC_BASE_URL: options.provider.url,
          ANTHROPIC_API_KEY: sentinel("API_KEY"),
        }),
    ...options.env,
  };
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  const started = performance.now();
  const child = spawn(process.execPath, [entrypoint, ...(options.args ?? [])], {
    cwd: dirs.cwd,
    env: childEnv,
    stdio: "pipe",
    detached: process.platform !== "win32",
  });
  options.onSpawn?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.stdin ?? "");

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, options.deadlineMs ?? 20_000);
  const [exitCode, signal] = await new Promise<
    [number | null, NodeJS.Signals | null]
  >((done, fail) => {
    child.on("error", fail);
    child.on("close", (code, signal) => done([code, signal]));
  }).finally(() => clearTimeout(deadline));

  return {
    exitCode,
    signal,
    stdout,
    stderr,
    elapsedMs: performance.now() - started,
    timedOut,
    root,
    home: dirs.home,
    cwd: dirs.cwd,
  };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}
