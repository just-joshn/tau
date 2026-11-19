/**
 * Which shell runs Bash commands (chunk-4hcrrj0t a/g/UGr): bash or zsh only,
 * preferring CLAUDE_CODE_SHELL, then SHELL, then well-known locations.
 */
import { accessSync, constants } from "node:fs";
import path from "node:path";

const DIRECTORIES = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

/** Resolve `name` on PATH (or return an absolute path when it is executable). */
function which(name: string, env: NodeJS.ProcessEnv): string | null {
  if (name.includes("/") || name.includes("\\")) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try the next directory */
    }
  }
  return null;
}

function candidates(env: NodeJS.ProcessEnv): string[] {
  const zsh = which("zsh", env),
    bash = which("bash", env);
  const configured = [env.CLAUDE_CODE_SHELL, env.SHELL].filter(
    (shell): shell is string =>
      shell !== undefined && (shell.includes("bash") || shell.includes("zsh")),
  );
  const prefersBash = env.SHELL?.includes("bash") === true;
  const names = prefersBash ? ["bash", "zsh"] : ["zsh", "bash"];
  const [first, last] = prefersBash ? [bash, zsh] : [zsh, bash];
  return [
    ...configured,
    first,
    ...names.flatMap((name) => DIRECTORIES.map((dir) => `${dir}/${name}`)),
    last,
  ].filter((shell): shell is string => shell !== null);
}

/** UGr(): the shell the description's gates consult (resolved through PATH). */
export function describedShell(env: NodeJS.ProcessEnv): string | undefined {
  return candidates(env).find((shell) => which(shell, env) !== null);
}

export class NoShellError extends Error {
  constructor() {
    super(
      "No suitable shell found. Claude CLI requires a Posix shell environment. Please ensure you have a valid shell installed and the SHELL environment variable set.",
    );
    this.name = "NoShellError";
  }
}

/** g(): the first candidate the process may execute. */
export function selectShell(env: NodeJS.ProcessEnv): string {
  for (const shell of candidates(env)) {
    try {
      accessSync(shell, constants.X_OK);
      return shell;
    } catch {
      /* Not executable here; try the next candidate. */
    }
  }
  throw new NoShellError();
}
