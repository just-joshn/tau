import path from "node:path";

// Source SVo/Bp/xZn. These are ordinary local path holds; host/credential stores have additional guards.
const sensitiveDirectories = new Set([
  ".git",
  ".vscode",
  ".idea",
  ".claude",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);
const sensitiveNames = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".envrc",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".bunfig.toml",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  ".lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yaml",
  "gradle-wrapper.properties",
  "maven-wrapper.properties",
  ".devcontainer.json",
  "pyrightconfig.json",
]);
function fold(component: string): string {
  const lowered = component
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u017f/g, "s");
  return (
    lowered
      .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
      .replace(/:.*$/, "")
      .replace(/[. ]+$/, "") || lowered
  );
}

/** A safety-check ask, rather than a deny: normal bypass mode may waive this ordinary local hold. */
export function sensitiveWriteReason(
  file: string,
  cwd: string,
  settingsPaths: readonly string[] = [],
  options: { admittedAgentMemory?: boolean } = {},
): string | undefined {
  const absolute = path.resolve(cwd, file),
    root = path.resolve(cwd);
  if (
    settingsPaths.some(
      (candidate) => path.resolve(root, candidate) === absolute,
    )
  )
    return "This file supplies settings for the current session";
  // Source vct grants the current project's preview launch config before the general directory hold.
  if (absolute === path.join(root, ".claude", "launch.json")) return undefined;
  const components = absolute.split(path.sep),
    rootComponents = root.split(path.sep);
  let boundary = rootComponents.length;
  for (const [index, rootComponent] of rootComponents.entries()) {
    if (
      fold(rootComponent) === ".claude" &&
      fold(rootComponents[index + 1] ?? "") !== "worktrees"
    ) {
      boundary = index;
      break;
    }
  }
  let nestedWorktree = false;
  for (const [index, name] of components.entries()) {
    const component = fold(name);
    if (!sensitiveDirectories.has(component)) continue;
    if (component === ".claude") {
      // vct's admitted memory branch precedes this broad uJ directory hold.
      // Exact settings targets and every other sensitive category still apply.
      if (options.admittedAgentMemory) continue;
      if (nestedWorktree)
        return "This path changes a sensitive configuration directory";
      if (fold(components[index + 1] ?? "") === "worktrees") {
        if (index >= boundary) nestedWorktree = true;
        continue;
      }
    }
    return "This path changes a sensitive configuration directory";
  }
  if (
    components.some(
      (name, index) =>
        fold(name) === ".config" && fold(components[index + 1] ?? "") === "git",
    )
  )
    return "This path changes Git configuration";
  if (sensitiveNames.has(fold(components.at(-1) ?? "")))
    return "This file configures command execution or developer tools";
  return undefined;
}
