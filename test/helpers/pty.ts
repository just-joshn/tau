import type { Subprocess } from "bun";
import { onTestFinished } from "bun:test";
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

// BUN_OPTIONS and TAU_COVERAGE_DIR carry the coverage preload into the CLI,
// which flushes on a normal exit only, so tests should end with /exit or EOF.
const INHERITED_ENV = ["PATH", "BUN_OPTIONS", "TAU_COVERAGE_DIR"];

export interface PtyOptions {
  args?: readonly string[];
  /** Workspace files written before launch, keyed by path relative to cwd. */
  files?: Readonly<Record<string, string>>;
  /** Applied last; undefined removes a variable. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Points the CLI at this provider with a sentinel API key. */
  provider?: { url: string };
  /** Kills the whole process group after this long. Default 30s. */
  deadlineMs?: number;
}

export interface PtyExit {
  exitCode: number | null;
  signal: Subprocess["signalCode"];
  timedOut: boolean;
}

export interface PtySession {
  root: string;
  home: string;
  cwd: string;
  config: string;
  state: string;
  /** Sends raw keystrokes: "\r" submits a line, "\x03" is Ctrl-C, "\x04" is Ctrl-D. */
  write(keys: string): void;
  /**
   * Resolves with the screen text (ANSI stripped) once `pattern` appears after
   * the previous match, and moves the cursor past it. Rejects after `timeoutMs`.
   */
  expect(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  /** Everything printed so far, ANSI stripped and with CRLF folded to LF. */
  text(): string;
  exited: Promise<PtyExit>;
}

/**
 * Runs the real tau entrypoint under a pseudo-terminal (Bun.spawn's
 * `terminal` option) in a fresh temporary root with the same directory layout
 * and whitelisted environment as runCli. The child leads its own process
 * group, which the deadline and test teardown kill.
 */
export function startPty(options: PtyOptions = {}): PtySession {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tau-pty-")));
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
    CLAUDE_CONFIG_DIR: dirs.config,
    TAU_HOME: dirs.state,
    TAU_MANAGED_ROOT: dirs.managed,
    TMPDIR: dirs.tmp,
    TERM: "xterm-256color",
    ...(options.provider === undefined
      ? {}
      : {
          ANTHROPIC_BASE_URL: options.provider.url,
          ANTHROPIC_API_KEY: sentinel("API_KEY"),
        }),
    ...options.env,
  };

  let raw = "";
  let cursor = 0;
  const waiters = new Set<() => void>();
  const decoder = new TextDecoder();
  const child = Bun.spawn(
    [process.execPath, entrypoint, ...(options.args ?? [])],
    {
      cwd: dirs.cwd,
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      terminal: {
        cols: 100,
        rows: 40,
        data(_terminal, data) {
          raw += decoder.decode(data, { stream: true });
          for (const wake of waiters) wake();
        },
      },
    },
  );
  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, options.deadlineMs ?? 30_000);
  let done = false;
  const exited = child.exited.then((exitCode) => {
    done = true;
    clearTimeout(deadline);
    for (const wake of waiters) wake();
    return { exitCode, signal: child.signalCode, timedOut };
  });
  onTestFinished(async () => {
    killGroup();
    await exited;
    child.terminal?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const text = () => plain(raw);
  return {
    root,
    home: dirs.home,
    cwd: dirs.cwd,
    config: dirs.config,
    state: dirs.state,
    write: (keys) => {
      child.terminal?.write(keys);
    },
    text,
    exited,
    expect: (pattern, timeoutMs = 10_000) =>
      new Promise((matched, fail) => {
        const check = () => {
          const screen = text();
          const found = locate(screen.slice(cursor), pattern);
          if (found !== undefined) {
            cursor += found;
            finish();
            matched(screen);
          } else if (done) {
            finish();
            fail(new Error(`tau exited before ${String(pattern)}:\n${screen}`));
          }
        };
        const timer = setTimeout(() => {
          finish();
          fail(
            new Error(`timed out waiting for ${String(pattern)}:\n${text()}`),
          );
        }, timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      }),
  };
}

/** Offset just past the first match, or undefined. */
function locate(text: string, pattern: string | RegExp): number | undefined {
  if (typeof pattern === "string") {
    const index = text.indexOf(pattern);
    return index < 0 ? undefined : index + pattern.length;
  }
  const match = pattern.exec(text);
  return match === null ? undefined : match.index + match[0].length;
}

function plain(raw: string): string {
  return Bun.stripANSI(raw).replace(/\r\n/g, "\n").replace(/\r/g, "");
}
