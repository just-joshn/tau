import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributionTexts,
  firstPromptText,
  foldRoundReminders,
  gitFacts,
  localDate,
  prependReminders,
  turnStartReminders,
  type ReminderBlock,
  type ReminderContext,
} from "../../src/context-reminders.js";
import { projectMessages } from "../../src/thinking-history.js";
import type { Message } from "../../src/types.js";

const context = (
  overrides: Partial<ReminderContext> = {},
): ReminderContext => ({
  cwd: "/work",
  git: { repository: false, worktree: false },
  platform: "darwin",
  bashShell: "/bin/sh",
  osVersion: "Darwin 27.2.0",
  model: "claude-sonnet-4-5-20250929",
  date: "2026-11-18",
  usedTokens: 0,
  attribution: attributionTexts("claude-sonnet-4-5-20250929", {}),
  env: { SHELL: "/bin/sh" },
  ...overrides,
});
const inner = (reminder: ReminderBlock) =>
  reminder.block.text.replace(
    /^<system-reminder>\n|\n<\/system-reminder>$/g,
    "",
  );

test("the first turn carries the original's reminders, in order and verbatim", () => {
  const due = turnStartReminders(context(), []);
  assert.deepEqual(
    due.map(({ id }) => id),
    ["environment", "model", "total_tokens", "date", "git_attribution"],
  );
  const [environment, model, tokens, date, attribution] = due.map(inner);
  assert.equal(
    environment?.split("\n").slice(0, 7).join("\n"),
    "# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /work\n - Is a git repository: false\n - Platform: darwin\n - Shell: sh\n - OS Version: Darwin 27.2.0",
  );
  assert.equal(
    model,
    "You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929. Assistant knowledge cutoff is January 2025.",
  );
  assert.equal(tokens, "<total_tokens>15000000 tokens left</total_tokens>");
  assert.equal(date, "Today's date is 2026-11-18.");
  assert.equal(
    attribution,
    "Attribution for git commits and pull requests you create from here on (this replaces Claude Code's own earlier attribution guidance, such as a previous copy of this reminder; the user's own instructions about these lines, such as a CLAUDE.md or memory rule, take precedence over this reminder, but do not add attribution lines this reminder leaves out):\n- End git commit messages with:\nCo-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>\n- End pull request descriptions with:\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
  );
});

test("later turns repeat only the token countdown, and worktrees and shells are described", () => {
  const row: Message = {
    role: "user",
    content: [{ type: "text", text: "first" }],
  };
  prependReminders(row, turnStartReminders(context(), []));
  const later = turnStartReminders(context({ usedTokens: 13 }), [row]);
  assert.deepEqual(later.map(inner), [
    "<total_tokens>14999987 tokens left</total_tokens>",
  ]);
  const [environment] = turnStartReminders(
    context({
      git: { repository: true, worktree: true },
      env: { SHELL: "/bin/zsh" },
      model: "vendor-model",
    }),
    [],
  ).map(inner);
  assert.match(environment ?? "", /This is a git worktree/);
  assert.match(environment ?? "", /git stash stack is shared/);
  assert.match(environment ?? "", /Shell: sh \(login shell: zsh\)/);
  const unnamed = turnStartReminders(context({ model: "vendor-model" }), []);
  assert.deepEqual(
    unnamed.map(({ id }) => id),
    ["environment", "model", "date", "git_attribution"],
  );
  assert.equal(
    unnamed[1] ? inner(unnamed[1]) : "",
    "You are powered by the model vendor-model.",
  );
  assert.equal(
    turnStartReminders(context({ env: {} }), [])
      .map(inner)[0]
      ?.includes("Shell: sh\n"),
    true,
  );
});

test("attribution follows settings and model naming", () => {
  assert.deepEqual(
    attributionTexts("claude-fable-5-2", {}).commit,
    "Co-Authored-By: Claude <noreply@anthropic.com>",
  );
  assert.deepEqual(
    attributionTexts("vendor", {}).commit,
    "Co-Authored-By: Claude Code <noreply@anthropic.com>",
  );
  assert.deepEqual(attributionTexts("vendor", { includeCoAuthoredBy: false }), {
    commit: "",
    pr: "",
  });
  assert.deepEqual(
    attributionTexts("vendor", { attribution: { commit: "C" } }),
    {
      commit: "C",
      pr: "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
    },
  );
  const none = turnStartReminders(
    context({ attribution: { commit: "", pr: "x <system-reminder>" } }),
    [],
  ).at(-1);
  assert.match(
    none?.block.text ?? "",
    /End pull request descriptions with:\nx &lt;system-reminder>/,
  );
  const off = turnStartReminders(
    context({ attribution: { commit: "", pr: "" } }),
    [],
  ).at(-1);
  assert.match(
    off?.block.text ?? "",
    /^<system-reminder>\nFrom here on, do not add attribution lines/,
  );
});

test("reminders lead the user round on the wire, with the original's seam newline", () => {
  const prompt: Message = {
    role: "user",
    content: [
      { type: "text", text: "instructions" },
      { type: "text", text: "the prompt" },
    ],
    instructionFiles: [
      {
        path: "/work/CLAUDE.md",
        kind: "Project",
        contentHash: "h",
        partial: false,
      },
    ],
  };
  const block = (text: string) => ({ type: "text" as const, text });
  prependReminders(prompt, [
    { id: "date", block: block("D") },
    { id: "environment", block: block("E") },
  ]);
  prependReminders(prompt, [{ id: "agent_listing", block: block("A") }]);
  prependReminders(prompt, []);
  assert.deepEqual(prompt.reminders, ["environment", "agent_listing", "date"]);
  assert.equal(firstPromptText([prompt]), "the prompt");
  const extra: Message = { role: "user", content: [], reminders: [] };
  prependReminders(extra, [{ id: "skill_listing", block: block("S") }]);
  const wire = projectMessages([prompt, extra]);
  assert.deepEqual(wire[0]?.content, [
    block("E"),
    block("A"),
    block("S"),
    block("D\n"),
    block("instructions"),
    block("the prompt"),
  ]);
  assert.deepEqual(foldRoundReminders([extra]), [
    { role: "user", content: [block("S")] },
  ]);
  assert.deepEqual(foldRoundReminders([]), []);
});

test("the first prompt skips tool results, subagent context and reminder-only rows", () => {
  const rows: Message[] = [
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "r" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "ctx" }],
      contextPlacement: "subagent-start",
    },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    {
      role: "user",
      content: [{ type: "text", text: "R" }],
      reminders: ["date"],
    },
    { role: "user", content: [{ type: "text", text: "TAU" }] },
  ];
  assert.equal(firstPromptText(rows), "TAU");
  assert.equal(firstPromptText([]), "");
});

test("git facts find the nearest repository marker and linked worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-reminders-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"),
    tree = join(root, "tree"),
    odd = join(root, "odd");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "nested"));
  await mkdir(tree);
  await writeFile(join(tree, ".git"), "gitdir: /x/.git/worktrees/tree\n");
  await mkdir(odd);
  await writeFile(join(odd, ".git"), "not a pointer\n");
  assert.deepEqual(await gitFacts(join(repo, "nested")), {
    repository: true,
    worktree: false,
  });
  assert.deepEqual(await gitFacts(tree), { repository: true, worktree: true });
  assert.deepEqual(await gitFacts(odd), { repository: false, worktree: false });
  assert.deepEqual(await gitFacts("/"), { repository: false, worktree: false });
});

test("local dates are zero-padded calendar dates", () => {
  assert.equal(localDate(new Date(2026, 0, 5, 12)), "2026-01-05");
});
