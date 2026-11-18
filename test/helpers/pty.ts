import type { Subprocess } from "bun";
import { onTestFinished } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tempBase } from "./temp-base.js";
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
  /** Files written before launch, keyed by path relative to CLAUDE_CONFIG_DIR. */
  configFiles?: Readonly<Record<string, string>>;
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
  /** What the terminal shows now, after cursor moves and erases. */
  screen(): string;
  /**
   * Resolves with the screen once it matches `pattern`, or `pattern` returns
   * true for it. Rejects after `timeoutMs` or when tau exits first.
   */
  until(
    pattern: string | RegExp | ((screen: string) => boolean),
    timeoutMs?: number,
  ): Promise<string>;
  exited: Promise<PtyExit>;
}

/**
 * Runs the real tau entrypoint under a pseudo-terminal (Bun.spawn's
 * `terminal` option) in a fresh temporary root with the same directory layout
 * and whitelisted environment as runCli. The child leads its own process
 * group, which the deadline and test teardown kill.
 */
export function startPty(options: PtyOptions = {}): PtySession {
  const root = realpathSync(mkdtempSync(join(tempBase(), "tau-pty-")));
  const dirs = {
    home: join(root, "home"),
    cwd: join(root, "workspace"),
    config: join(root, "config"),
    state: join(root, "state"),
    managed: join(root, "managed"),
    tmp: join(root, "tmp"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  for (const [base, files] of [
    [dirs.cwd, options.files],
    [dirs.config, options.configFiles],
  ] as const)
    for (const [file, content] of Object.entries(files ?? {})) {
      const path = join(base, file);
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
    CLAUDE_CODE_TMPDIR: dirs.tmp,
    TAU_INSTRUCTION_ANCESTOR_BOUNDARY: root,
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
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
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
    screen: () => render(raw),
    until: (pattern, timeoutMs = 10_000) =>
      new Promise((matched, fail) => {
        const test =
          typeof pattern === "function"
            ? pattern
            : (screen: string) => locate(screen, pattern) !== undefined;
        // A frame can arrive in several reads: a match counts once output has
        // been quiet for a moment and the screen still matches.
        let settle: ReturnType<typeof setTimeout> | undefined;
        const check = () => {
          clearTimeout(settle);
          const screen = render(raw);
          if (test(screen))
            settle = setTimeout(() => {
              const settled = render(raw);
              if (!test(settled)) return;
              finish();
              matched(settled);
            }, 50);
          else if (done) {
            finish();
            fail(new Error(`tau exited before ${String(pattern)}:\n${screen}`));
          }
        };
        const timer = setTimeout(() => {
          finish();
          fail(
            new Error(
              `timed out waiting for ${String(pattern)}:\n${render(raw)}`,
            ),
          );
        }, timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          clearTimeout(settle);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      }),
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

/**
 * The visible screen: cursor moves and erases, absolute positioning, and the
 * alternate screen (entering it starts blank; leaving restores the main one).
 */
function render(raw: string): string {
  let rows: string[][] = [[]];
  let row = 0;
  let col = 0;
  let saved: { rows: string[][]; row: number; col: number } | undefined;
  const line = () => (rows[row] ??= []);
  const reach = () => {
    while (rows.length <= row) rows.push([]);
  };
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charAt(i);
    if (char === "\r") col = 0;
    else if (char === "\n") {
      row++;
      reach();
    } else if (char === "\x1b") {
      const control = /^\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(i + 1));
      if (control === null) continue;
      i += control[0].length;
      const params = control[1] ?? "";
      const n = Number.parseInt(params || "1", 10) || 1;
      switch (control[2]) {
        case "A":
          row = Math.max(0, row - n);
          break;
        case "B":
          row += n;
          reach();
          break;
        case "C":
          col += n;
          break;
        case "D":
          col = Math.max(0, col - n);
          break;
        case "G":
          col = n - 1;
          break;
        case "H": {
          const [r = 1, c = 1] = params
            .split(";")
            .map((part) => Number(part) || 1);
          row = r - 1;
          col = c - 1;
          reach();
          break;
        }
        case "J":
          if (params === "2") rows = rows.map(() => []);
          else {
            line().length = Math.min(line().length, col);
            rows.length = row + 1;
          }
          break;
        case "K":
          if (params === "2") line().length = 0;
          else line().length = Math.min(line().length, col);
          break;
        case "h":
          if (params === "?1049") {
            saved = { rows, row, col };
            rows = [[]];
            row = 0;
            col = 0;
          }
          break;
        case "l":
          if (params === "?1049" && saved) {
            ({ rows, row, col } = saved);
            saved = undefined;
          }
          break;
        default:
          break;
      }
    } else {
      const current = line();
      while (current.length < col) current.push(" ");
      current[col++] = char;
    }
  }
  return rows.map((cells) => cells.join("").trimEnd()).join("\n");
}
