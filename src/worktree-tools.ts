/**
 * EnterWorktree and ExitWorktree (chunk-fkkma3m4 Is/Ns, chunk-4h798pp0
 * pVn/EPt/z0o/jst): an isolated git worktree under .claude/worktrees/, the
 * session's shell moved into it, and the way back with keep or remove.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BackgroundShells } from "./background-shells.js";
import type { GuardedTool } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";

export const ENTER_WORKTREE = "EnterWorktree";
export const EXIT_WORKTREE = "ExitWorktree";

/** fa(): the worktree this session is in, and where ExitWorktree goes back to. */
export interface WorktreeSession {
  /** The shell's folder when the first worktree was entered. */
  originalCwd: string;
  /** The folder `cd` stayed inside before the first worktree. */
  originalRoot: string;
  /** The repository whose `git worktree remove` removes it. */
  repoRoot: string;
  worktreePath: string;
  worktreeBranch?: string;
  /** The commit it was made from; later commits are at stake on remove. */
  originalHeadCommit?: string;
  /** Entered by `path`: this session did not make it and will not remove it. */
  enteredExisting: boolean;
}

/** The session shell, as far as the worktree tools move it. */
export interface WorktreeShell {
  readonly cwd: string;
  readonly root: string;
  relocate(next: { cwd: string; root: string }): void;
  readonly shells: Pick<BackgroundShells, "list">;
}
export interface WorktreeToolsOptions {
  shell: WorktreeShell;
  /** ZDe(): a name for a worktree the model did not name. */
  randomName?(): string;
  /** Settings worktree.baseRef: "fresh" (default) or "head". */
  baseRef(): "fresh" | "head";
}

const baseRefSettings = z.looseObject({
  worktree: z.looseObject({ baseRef: z.enum(["fresh", "head"]) }),
});
/** Settings worktree.baseRef; anything else is the default, fresh. */
export function worktreeBaseRef(settings: unknown): "fresh" | "head" {
  const parsed = baseRefSettings.safeParse(settings);
  return parsed.success ? parsed.data.worktree.baseRef : "fresh";
}

/** Nv: a name in curly quotes, flagged when display cleanup changed it. */
export function quoted(text: string): string {
  const shown = text
    .replace(/\s+/g, " ")
    .replace(/["\u02BB\u02BC`\uff40\u02cb\u1fef\u2035]/g, "'")
    .replace(/\p{Cc}/gu, "")
    .trim();
  if (!shown) return "(no printable name)";
  return shown === text ? `“${text}”` : `“${shown}” (not its exact spelling)`;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
function git(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    child.on("error", (error) =>
      resolve({ code: 127, stdout, stderr: stderr || error.message }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
const gitLine = async (args: readonly string[], cwd: string) => {
  const result = await git(args, cwd);
  return result.code === 0 ? result.stdout.trim() : undefined;
};
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );
const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

/** Ai(): the working tree root, and the main checkout that owns .claude/worktrees/. */
async function repository(cwd: string) {
  const top = await gitLine(["rev-parse", "--show-toplevel"], cwd);
  if (top === undefined) return undefined;
  const common = await gitLine(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  const main =
    common !== undefined && path.basename(common) === ".git"
      ? path.dirname(common)
      : top;
  return { top: await realpath(top), main: await realpath(main) };
}
const worktreesDirectory = (repoRoot: string) =>
  path.join(repoRoot, ".claude", "worktrees");

/** vts: the name rules a worktree name and its branch must meet. */
export function worktreeNameProblem(name: string): string | undefined {
  if (name.length > 64)
    return `Invalid worktree name: must be 64 characters or fewer (got ${name.length})`;
  for (const segment of name.split("/")) {
    if (segment === "." || segment === "..")
      return `Invalid worktree name "${name}": must not contain "." or ".." path segments`;
    if (segment.toLowerCase().replace(/\.+$/, "") === ".git")
      return `Invalid worktree name "${name}": "${segment}" is a reserved git directory name`;
    if (!/^[a-zA-Z0-9._-]+$/.test(segment))
      return `Invalid worktree name "${name}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`;
  }
  return undefined;
}

export const enterWorktreeInputSchema = z
  .strictObject({
    name: z
      .string()
      .superRefine((name, context) => {
        const problem = worktreeNameProblem(name);
        if (problem !== undefined)
          context.addIssue({ code: "custom", message: problem });
      })
      .optional()
      .describe(
        'Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with `path`.',
      ),
    path: z
      .string()
      .optional()
      .describe(
        "Path to an existing worktree to switch into instead of creating a new one. Must appear in `git worktree list` for the current repo — or, on first entry from the launch directory, for a repo nested inside it (multi-repo workspace). Mutually exclusive with `name`.",
      ),
  })
  .refine((input) => !(input.name && input.path), {
    message: "Provide at most one of `name` or `path`, not both.",
  });
export type EnterWorktreeInput = z.output<typeof enterWorktreeInputSchema>;

export const exitWorktreeInputSchema = z.strictObject({
  action: z
    .enum(["keep", "remove"])
    .describe(
      '"keep" leaves the worktree and branch on disk; "remove" deletes the worktree and, unless a hook made it or git refuses, its branch.',
    ),
  discard_changes: z
    .boolean()
    .optional()
    .describe(
      'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise. It also removes the worktree under any task still running there, so set it only after the user has confirmed.',
    ),
});
export type ExitWorktreeInput = z.output<typeof exitWorktreeInputSchema>;

const ENTER_DESCRIPTION = `Use this tool ONLY when explicitly instructed to work in a worktree — either by the user directly, or by project instructions (CLAUDE.md / memory). This tool creates an isolated git worktree and switches the current session into it.

## When to Use

- The user explicitly says "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree")
- CLAUDE.md or memory instructions direct you to work in a worktree for the current task

## When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead
- The user asks to fix a bug or work on a feature — use normal git workflow unless worktrees are explicitly requested by the user or project instructions
- Never use this tool unless "worktree" is explicitly mentioned by the user or in CLAUDE.md / memory instructions

## Requirements

- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json
- Must not already be in a worktree session when creating a new worktree (\`name\`); switching into another existing worktree via \`path\` is allowed

## Behavior

- In a git repository: creates a new git worktree inside \`.claude/worktrees/\` on a new branch. The base ref is governed by the \`worktree.baseRef\` setting: \`fresh\` (default) branches from origin/<default-branch>; \`head\` branches from your current local HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the new worktree
- Use ExitWorktree to leave the worktree mid-session (keep or remove). On session exit, if still in the worktree, the user will be prompted to keep or remove it

## Entering an existing worktree

Pass \`path\` instead of \`name\` to switch the session into a worktree that already exists (e.g., one you just created with \`git worktree add\`). On first entry from the launch directory, the path must appear in \`git worktree list\` for the repository that owns it — the current repository or, in a multi-repo workspace, a repository nested inside it; paths registered by neither are rejected. ExitWorktree will not remove a worktree entered this way; use \`action: "keep"\` to return to the original directory.

Switching with \`path\` also works when the session is already in a worktree (the previous worktree is left on disk, untouched, and only the new one is tracked for exit-time cleanup), and from agents whose working directory was pinned at launch (subagent isolation or explicit cwd). In both cases the target must be a worktree under \`.claude/worktrees/\` of the same repository, and from a pinned agent the switch only affects this agent, not the parent session. After a further switch, previously-visited worktrees are no longer writable — re-issue EnterWorktree with \`path\` to return to one.

## Parameters

- \`name\` (optional): A name for a new worktree. If neither \`name\` nor \`path\` is provided, a random name is generated.
- \`path\` (optional): Path to an existing worktree to enter instead of creating one — of the current repository, or (on first entry from the launch directory) of a repository nested inside it. Mutually exclusive with \`name\`.
`;
const EXIT_DESCRIPTION = `Exit a worktree session created by EnterWorktree and return the session to the original working directory.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees you created manually with \`git worktree add\`
- Worktrees from a previous session (even if created by EnterWorktree then)
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

## When to Use

- The user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session
- Do NOT call this proactively — only when the user asks

## Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`
  - \`"keep"\` — leave the worktree directory and branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.
  - \`"remove"\` — delete the worktree directory, and its branch too unless a hook made the worktree or git refuses the delete. Use this for a clean exit when the work is done or abandoned.
- \`discard_changes\` (optional, default false): only meaningful with \`action: "remove"\`. If the worktree has uncommitted files or commits not on the original branch, the tool will REFUSE to remove it unless this is set to \`true\`. If the tool returns an error listing changes, confirm with the user before re-invoking with \`discard_changes: true\`. The tool also refuses while a task may be running in the worktree: wait for the task, or ask the user before stopping it, then call the tool again, or use \`keep\`.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree
- Clears CWD-dependent caches (system prompt sections, memory files, plans directory) so the session state reflects the original directory
- If a tmux session was attached to the worktree: killed on \`remove\`, left running on \`keep\` (its name is returned so the user can reattach)
- Once exited, EnterWorktree can be called again to create a fresh worktree
`;

const definition = (
  name: string,
  description: string,
  schema: z.ZodType,
): ToolDefinition => ({
  name,
  description,
  input_schema: { ...z.toJSONSchema(schema), type: "object" },
});

const CONFIRM =
  'Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.';
const WAIT_FOR_TASK =
  'Wait for the task to finish, or ask the user before stopping it, then call this tool again — or use action: "keep" to preserve the worktree.';
const plural = (count: number, word: string) =>
  `${count} ${count === 1 ? word : `${word}s`}`;

/** xs: uncommitted files and commits since the worktree's base, or null when git cannot say. */
async function workAtStake(session: WorktreeSession) {
  const status = await git(["status", "--porcelain"], session.worktreePath);
  if (status.code !== 0 || session.originalHeadCommit === undefined)
    return null;
  const commits = await gitLine(
    ["rev-list", "--count", "HEAD", `^${session.originalHeadCommit}`],
    session.worktreePath,
  );
  if (commits === undefined) return null;
  return {
    changedFiles: status.stdout.split("\n").filter((line) => line.trim())
      .length,
    commits: Number(commits),
  };
}

export function createWorktreeTools(options: WorktreeToolsOptions) {
  const { shell } = options;
  let active: WorktreeSession | undefined;

  /** Ds: a running task that may be working inside the worktree. */
  const runningTaskNote = (worktreePath: string) => {
    const task = shell.shells
      .list()
      .find(
        (candidate) =>
          candidate.status === "running" &&
          candidate.cwd !== undefined &&
          (candidate.cwd === worktreePath ||
            inside(worktreePath, candidate.cwd)),
      );
    return task === undefined
      ? ""
      : ` Nothing was removed: task ${task.id} is still running and may be working in this worktree, and removing the worktree now could lose that work or land it in the main checkout.`;
  };

  /** z0o: an existing linked worktree of this repository, by path. */
  async function existingWorktree(requested: string) {
    let target: string;
    try {
      target = await realpath(path.resolve(shell.cwd, requested));
    } catch (error) {
      throw new Error(
        `Cannot enter worktree: ${requested}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const repo = await repository(shell.cwd);
    if (!repo)
      throw new Error(
        "Cannot enter an existing worktree: the current directory is not in a git repository.",
      );
    if (target === repo.top || target === repo.main)
      throw new Error(
        `Cannot enter worktree: ${requested} is the main working tree, not a linked worktree.`,
      );
    if (target === (await realpath(shell.cwd)))
      throw new Error(
        `Cannot enter worktree: ${requested} is the current working directory.`,
      );
    const managedDirectory = worktreesDirectory(repo.main);
    if (active && !inside(managedDirectory, target))
      throw new Error(
        `Cannot enter worktree: ${requested} is not under ${managedDirectory}. Switching from this session is limited to worktrees managed by Claude Code (created under .claude/worktrees/ of this repository).`,
      );
    const listing = await git(["worktree", "list", "--porcelain"], repo.top);
    if (listing.code !== 0)
      throw new Error(
        `\`git -C ${repo.top} worktree list\` failed: ${listing.stderr.trim() || `exit ${listing.code}`}`,
      );
    let entry: { path: string; branch?: string; prunable: boolean } | undefined;
    for (const block of listing.stdout.split("\n\n")) {
      const lines = block.split("\n");
      const listed = lines
        .find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length);
      if (listed === undefined) continue;
      if ((await realpath(listed).catch(() => listed)) !== target) continue;
      const branch = lines
        .find((line) => line.startsWith("branch "))
        ?.slice("branch ".length)
        .replace(/^refs\/heads\//, "");
      entry = {
        path: target,
        ...(branch === undefined ? {} : { branch }),
        prunable: lines.some((line) => line.startsWith("prunable")),
      };
    }
    if (!entry)
      throw new Error(
        `Cannot enter worktree: ${requested} is not a registered worktree of ${repo.top}. Run 'git -C ${repo.top} worktree list' to see registered worktrees.`,
      );
    if (entry.prunable)
      throw new Error(
        `Cannot enter worktree: ${requested} is marked prunable by git (its directory or administrative files are missing or broken).`,
      );
    return { ...entry, repoRoot: repo.main };
  }

  /** pH(): origin's default branch, else main or master if origin has one, else main. */
  async function defaultBranch(repoRoot: string): Promise<string> {
    const head = await gitLine(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      repoRoot,
    );
    if (head) return head.replace(/^origin\//, "");
    for (const name of ["main", "master"])
      if (
        (
          await git(
            ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`],
            repoRoot,
          )
        ).code === 0
      )
        return name;
    return "main";
  }

  /** EPt's base: origin/<default> (fetched when absent), else local HEAD; `head` mode takes HEAD. */
  async function baseCommit(repoRoot: string, fromCwd: string) {
    const head = () => gitLine(["rev-parse", "HEAD"], fromCwd);
    if (options.baseRef() === "head") return head();
    const branch = await defaultBranch(repoRoot);
    const name = branch && !branch.startsWith("-") ? branch : "HEAD";
    const remote = `refs/remotes/origin/${name}`;
    const known = await gitLine(
      ["rev-parse", "--verify", "-q", remote],
      repoRoot,
    );
    if (known) return known;
    if (
      (await git(["fetch", "--no-tags", "origin", name], repoRoot)).code === 0
    )
      return (
        (await gitLine(["rev-parse", "--verify", "-q", remote], repoRoot)) ??
        gitLine(["rev-parse", "FETCH_HEAD"], repoRoot)
      );
    return head();
  }

  /** pVn/EPt: make (or resume) the named worktree on branch worktree-<name>. */
  async function createWorktree(name: string) {
    const fromCwd = shell.cwd;
    const repo = await repository(fromCwd);
    if (!repo)
      throw new Error(
        "Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.",
      );
    const slug = name.replaceAll("/", "+");
    const directory = worktreesDirectory(repo.main);
    const worktreePath = path.join(directory, slug);
    const branch = `worktree-${slug}`;
    if (await exists(path.join(worktreePath, ".git"))) {
      const resumed = await gitLine(["rev-parse", "HEAD"], worktreePath);
      if (resumed === undefined)
        throw new Error(
          `worktree "${name}" already exists at ${quoted(worktreePath)} but cannot be reused. Remove that directory (with \`git worktree remove\` if it's a registered worktree, or by deleting it if it's a stray directory) or pass a different --worktree name.`,
        );
      return {
        repoRoot: repo.main,
        worktreePath,
        branch,
        base: resumed,
        resumed: true,
      };
    }
    const base = await baseCommit(repo.main, fromCwd);
    if (base === undefined)
      throw new Error(
        `Failed to resolve base branch for worktree "${name}": the repository has no commit to branch from.`,
      );
    await mkdir(directory, { recursive: true });
    const added = await git(
      [
        "worktree",
        "add",
        "--no-track",
        "-B",
        branch,
        worktreePath,
        `${base}^{commit}`,
      ],
      repo.main,
    );
    if (added.code !== 0)
      throw new Error(
        `Failed to create worktree: ${added.stderr.trim() || `git exited with code ${added.code}`}`,
      );
    await copyLocalSettings(repo.main, worktreePath);
    return {
      repoRoot: repo.main,
      worktreePath,
      branch,
      base,
      resumed: false,
    };
  }

  /** OMs: settings.local.json is untracked, so the worktree gets a copy. */
  async function copyLocalSettings(repoRoot: string, worktreePath: string) {
    const source = path.join(repoRoot, ".claude", "settings.local.json");
    const info = await lstat(source).catch(() => undefined);
    if (!info?.isFile()) return;
    const target = path.join(worktreePath, ".claude", "settings.local.json");
    if (await exists(target)) return;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  /** Ms/Po: put the shell back, falling back when the original folder is gone. */
  async function returnShell(session: WorktreeSession, removing: boolean) {
    const fallback = removing ? homedir() : session.worktreePath;
    const missing = !(await exists(session.originalCwd));
    const cwd = missing ? fallback : session.originalCwd;
    shell.relocate({
      cwd,
      root: missing ? cwd : session.originalRoot,
    });
    active = undefined;
    if (!missing)
      return `Session is now back in ${quoted(session.originalCwd)}.`;
    const gone = `The original directory ${quoted(session.originalCwd)} no longer exists, so the session is now in ${quoted(cwd)}.`;
    return removing
      ? `${gone} Consider restarting Claude from an existing directory.`
      : gone;
  }

  const enter: GuardedTool<EnterWorktreeInput> = {
    name: ENTER_WORKTREE,
    definition: () =>
      definition(ENTER_WORKTREE, ENTER_DESCRIPTION, enterWorktreeInputSchema),
    schema: () => enterWorktreeInputSchema,
    async validate(input) {
      if (active && !input.path)
        return "Already in a worktree session. Pass `path` to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.";
      return undefined;
    },
    async check(input) {
      if (input.path === undefined) return { behavior: "allow" };
      const target = path.resolve(shell.cwd, input.path);
      const repo = await repository(shell.cwd).catch(() => undefined);
      const real = await realpath(target).catch(() => target);
      if (repo && inside(worktreesDirectory(repo.main), real))
        return { behavior: "allow" };
      const resolves = real === target ? "" : ` (resolves to "${real}")`;
      return {
        behavior: "ask",
        prompt: `Enter the worktree at "${target}"${resolves}? This moves the session's working directory and write access there, and loads project configuration (CLAUDE.md, settings) from that location.`,
      };
    },
    async run(input) {
      if (input.path !== undefined) {
        const found = await existingWorktree(input.path);
        active = {
          originalCwd: active?.originalCwd ?? shell.cwd,
          originalRoot: active?.originalRoot ?? shell.root,
          repoRoot: found.repoRoot,
          worktreePath: found.path,
          ...(found.branch === undefined
            ? {}
            : { worktreeBranch: found.branch }),
          enteredExisting: true,
        };
        shell.relocate({ cwd: found.path, root: found.path });
        const onBranch = found.branch
          ? ` on branch ${quoted(found.branch)}`
          : "";
        return `Entered worktree at ${quoted(found.path)}${onBranch}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`;
      }
      const name =
        input.name ??
        options.randomName?.() ??
        `session-${randomBytes(4).toString("hex")}`;
      const made = await createWorktree(name);
      active = {
        originalCwd: shell.cwd,
        originalRoot: shell.root,
        repoRoot: made.repoRoot,
        worktreePath: made.worktreePath,
        worktreeBranch: made.branch,
        originalHeadCommit: made.base,
        enteredExisting: false,
      };
      shell.relocate({ cwd: made.worktreePath, root: made.worktreePath });
      const verb = made.resumed ? "Resumed" : "Created";
      const resumedNote = made.resumed
        ? " A worktree with this name already existed and was resumed as-is — it may carry an earlier session’s commits. Pass a different name if you wanted a fresh worktree."
        : "";
      return `${verb} worktree at ${quoted(made.worktreePath)} on branch ${quoted(made.branch)}.${resumedNote} The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`;
    },
  };

  const exit: GuardedTool<ExitWorktreeInput> = {
    name: EXIT_WORKTREE,
    definition: () =>
      definition(EXIT_WORKTREE, EXIT_DESCRIPTION, exitWorktreeInputSchema),
    schema: () => exitWorktreeInputSchema,
    async validate(input) {
      const session = active;
      if (!session)
        return "No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.";
      if (input.action === "remove" && session.enteredExisting)
        return `This session is not the owner of the worktree at ${quoted(session.worktreePath)} — it either entered a pre-existing worktree via EnterWorktree({path}) or resumed into a checkout whose liveness lock another running Claude Code session still holds — so this tool will not remove it. Use action: "keep" to return to ${quoted(session.originalCwd)}. If no other session is using it, remove it yourself with \`git worktree remove\`; while a live session's lock is present, git will refuse and name the owner.`;
      if (input.action !== "remove" || input.discard_changes) return undefined;
      const task = runningTaskNote(session.worktreePath);
      const stake = await workAtStake(session);
      if (stake === null)
        return `Could not verify worktree state at ${quoted(session.worktreePath)}.${task} Refusing to remove without explicit confirmation. Confirm with the user, then re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`;
      if (stake.changedFiles > 0 || stake.commits > 0) {
        const parts: string[] = [];
        if (stake.changedFiles > 0)
          parts.push(`${plural(stake.changedFiles, "uncommitted file")}`);
        if (stake.commits > 0)
          parts.push(
            `${plural(stake.commits, "commit")} on ${session.worktreeBranch ? quoted(session.worktreeBranch) : "the worktree branch"}`,
          );
        return `Worktree has ${parts.join(" and ")}. Removing will discard this work permanently.${task} ${CONFIRM}`;
      }
      if (task !== "") return `${task.trimStart()} ${WAIT_FOR_TASK}`;
      return undefined;
    },
    check: async () => ({ behavior: "allow" }),
    async run(input) {
      const session = active;
      if (!session) throw new Error("Not in a worktree session");
      const { worktreePath, worktreeBranch } = session;
      const onBranch = worktreeBranch
        ? ` on branch ${quoted(worktreeBranch)}`
        : "";
      if (input.action === "keep") {
        const back = await returnShell(session, false);
        return `Exited worktree. Your work is preserved at ${quoted(worktreePath)}${onBranch}. ${back}`;
      }
      const stake = (await workAtStake(session)) ?? {
        changedFiles: 0,
        commits: 0,
      };
      const task = runningTaskNote(worktreePath);
      if (task !== "" && !input.discard_changes)
        throw new Error(`${task.trimStart()} ${WAIT_FOR_TASK}`);
      const back = await returnShell(session, true);
      const removed = await git(
        ["worktree", "remove", "--force", worktreePath],
        session.repoRoot,
      );
      if (removed.code !== 0)
        return `Exited worktree but could not remove it — kept at ${quoted(worktreePath)}. ${back}`;
      if (worktreeBranch)
        await git(
          ["branch", "-D", "--end-of-options", worktreeBranch],
          session.repoRoot,
        );
      const discarded: string[] = [];
      if (stake.commits > 0) discarded.push(plural(stake.commits, "commit"));
      if (stake.changedFiles > 0)
        discarded.push(plural(stake.changedFiles, "uncommitted file"));
      const note = discarded.length
        ? ` Discarded ${discarded.join(" and ")}.`
        : "";
      return `Exited and removed worktree at ${quoted(worktreePath)}.${note} ${back}`;
    },
  };

  return {
    enter,
    exit,
    /** The active worktree session, if EnterWorktree put the session in one. */
    current: (): Readonly<WorktreeSession> | undefined => active,
  };
}
