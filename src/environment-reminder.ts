import { z } from "zod";

export const WORKTREE =
  "This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT `cd` to the original repository root.";
export const WORKTREE_STASH =
  "The git stash stack is shared with the main checkout and all other worktrees, and other Claude sessions may push or pop it concurrently. Never use bare `git stash` / `git stash pop` — you could pop another session's changes. Prefer a temporary WIP commit to set work aside; if you must stash, use `git stash push -u -m \"<unique-tag>\"`, immediately capture your entry's SHA via `git stash list --format='%H %gs'`, restore with `git stash apply <sha>` (not pop), and afterwards drop the entry, re-finding its current `stash@{n}` by tag first.";
const NO_LONGER_WORKTREE =
  "The primary working directory is no longer a git worktree.";

/** Source `_3e`, the fields a Bash `cd` can change. */
export const environmentSnapshotSchema = z.object({
  workingDirectory: z.string(),
  isGitRepo: z.boolean(),
  isWorktree: z.boolean(),
});
export type EnvironmentSnapshot = z.infer<typeof environmentSnapshotSchema>;

/** Source `k3e`, restricted to the fields above. */
export const environmentChangeSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("workingDirectory"), from: z.string() }),
  z.object({ field: z.literal("isWorktree") }),
  z.object({ field: z.literal("isGitRepo") }),
]);
export type EnvironmentChange = z.infer<typeof environmentChangeSchema>;

// oxlint-disable-next-line no-control-regex -- Source Uc renders these controls as numeric entities.
const controlCharacters = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
/** Source `mp`: control characters as numeric entities, angle brackets as named ones. */
export const promptPath = (path: string): string =>
  path
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(controlCharacters, (part) => `&#${part.charCodeAt(0)};`);

/** Source `$Kt`: what moved since the snapshot the model last read. */
export function environmentChanges(
  announced: EnvironmentSnapshot,
  now: EnvironmentSnapshot,
): EnvironmentChange[] {
  return [
    ...(now.workingDirectory === announced.workingDirectory
      ? []
      : [
          {
            field: "workingDirectory" as const,
            from: announced.workingDirectory,
          },
        ]),
    ...(now.isWorktree === announced.isWorktree
      ? []
      : [{ field: "isWorktree" as const }]),
    ...(now.isGitRepo === announced.isGitRepo
      ? []
      : [{ field: "isGitRepo" as const }]),
  ];
}

/** Source `UKt`: the `# Environment update` body for a set of changes. */
export function environmentUpdateText(
  snapshot: EnvironmentSnapshot,
  changes: readonly EnvironmentChange[],
): string {
  const lines = changes.flatMap((change) => {
    switch (change.field) {
      case "workingDirectory":
        return [
          `Primary working directory: ${promptPath(snapshot.workingDirectory)} (was ${promptPath(change.from)})`,
        ];
      case "isWorktree":
        return snapshot.isWorktree
          ? [WORKTREE, WORKTREE_STASH]
          : [NO_LONGER_WORKTREE];
      case "isGitRepo":
        return [
          `Is a git repository: ${snapshot.isGitRepo} (was ${!snapshot.isGitRepo})`,
        ];
    }
  });
  return lines.length
    ? ["# Environment update", ...lines.map((line) => ` - ${line}`)].join("\n")
    : "";
}
