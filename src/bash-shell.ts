/**
 * Which shell runs Bash commands (chunk-4hcrrj0t a/g/UGr): bash or zsh only,
 * preferring CLAUDE_CODE_SHELL, then SHELL, then well-known locations.
 */
import { accessSync, constants } from "node:fs";

const DIRECTORIES = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const which = (name: string, env: NodeJS.ProcessEnv) =>
  Bun.which(name, { PATH: env.PATH ?? "" });

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
