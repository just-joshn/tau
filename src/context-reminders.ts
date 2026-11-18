import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { REMINDER_IDS, type Message, type ReminderId } from "./types.js";
import { activeContextStart, contextTokens } from "./context-usage.js";
import {
  escapeReminderTags,
  systemReminder,
  type Attachment,
} from "./attachments.js";
import {
  environmentChanges,
  promptPath,
  WORKTREE,
  WORKTREE_STASH,
  type EnvironmentSnapshot,
} from "./environment-reminder.js";
import {
  promptModel,
  totalTokensText,
  type PromptEnv,
} from "./system-prompt.js";

export interface ReminderContext {
  cwd: string;
  git: { repository: boolean; worktree: boolean };
  platform: string;
  /** Shell the Bash tool spawns. */
  bashShell: string;
  osVersion: string;
  model: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  attribution: { commit: string; pr: string };
  env: PromptEnv;
}
interface TurnReminder {
  id: ReminderId;
  /** Emitted again on every user turn, not only when absent from context. */
  everyTurn?: true;
  render(context: ReminderContext): string | null;
  /** What to say when the active context already holds this reminder's `sent` text. */
  renderSent?(context: ReminderContext, sent: string): string | null;
}

/** Source `f2t` for a local date; the original's assumed-UTC variant is not modeled. */
function dateChange({ date }: ReminderContext, sent: string): string | null {
  const told = /Today's date is (?:now )?(\d{4}-\d{2}-\d{2})/.exec(sent)?.[1];
  return told === undefined || told === date
    ? null
    : `The date has changed. Today's date is now ${date}. No need to announce the new date \u2014 the user's own clock shows it.`;
}

const UNTRUSTED_DOWNLOADS =
  "Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory, keep scripts you write in a different directory, and pass paths as arguments instead of running an interpreter or build tool from inside it. Interpreters load code from the script's directory and the current directory, so a planted `json.py` runs on `import json`. Run any Python that reads them with `-I`. This does not apply to code the user asked you to build or run.";

function shellDescription({ bashShell, env }: ReminderContext): string {
  const shell = basename(bashShell);
  if (!env.SHELL || basename(env.SHELL) === shell) return shell;
  return `${shell} (login shell: ${basename(env.SHELL)})`;
}

function environment(context: ReminderContext): string {
  const lines = [
    `Primary working directory: ${promptPath(context.cwd)}`,
    ...(context.git.worktree ? [WORKTREE, WORKTREE_STASH] : []),
    `Is a git repository: ${context.git.repository}`,
    `Platform: ${context.platform}`,
    `Shell: ${shellDescription(context)}`,
    `OS Version: ${context.osVersion}`,
    UNTRUSTED_DOWNLOADS,
  ];
  return [
    "# Environment",
    "You have been invoked in the following environment: ",
    ...lines.map((line) => ` - ${line}`),
  ].join("\n");
}

function modelIdentity({ model }: ReminderContext): string {
  const facts = promptModel(model);
  return [
    facts.displayName
      ? `You are powered by the model named ${facts.displayName}. The exact model ID is ${model}.`
      : `You are powered by the model ${model}.`,
    facts.knowledgeCutoff
      ? `Assistant knowledge cutoff is ${facts.knowledgeCutoff}.`
      : null,
  ]
    .filter((line) => line !== null)
    .join(" ");
}

function gitAttribution({ attribution }: ReminderContext): string {
  const lines = [
    attribution.commit
      ? `- End git commit messages with:\n${escapeReminderTags(attribution.commit)}`
      : null,
    attribution.pr
      ? `- End pull request descriptions with:\n${escapeReminderTags(attribution.pr)}`
      : null,
  ].filter((line) => line !== null);
  const replaces =
    "this replaces Claude Code's own earlier attribution guidance, such as a previous copy of this reminder";
  return lines.length
    ? `Attribution for git commits and pull requests you create from here on (${replaces}; the user's own instructions about these lines, such as a CLAUDE.md or memory rule, take precedence over this reminder, but do not add attribution lines this reminder leaves out):\n${lines.join("\n")}`
    : `From here on, do not add attribution lines to git commit messages or pull request descriptions (${replaces}, and applies even if a CLAUDE.md or memory rule asks for attribution lines).`;
}

/** Reminders this module owns; catalog and deferred-tool producers tag their own rows. */
export const TURN_REMINDERS: readonly TurnReminder[] = [
  { id: "environment", render: environment },
  { id: "model", render: modelIdentity },
  {
    id: "total_tokens",
    everyTurn: true,
    // Source `reanchorTaskBudget`: a user turn restarts the countdown.
    render: (context) => totalTokensText(context, 0),
  },
  {
    id: "date",
    render: ({ date }) => `Today's date is ${date}.`,
    renderSent: dateChange,
  },
  { id: "git_attribution", render: gitAttribution },
];

export interface ReminderBlock {
  id: ReminderId;
  block: { type: "text"; text: string };
}

/** Reminders owed at this turn start, given what the active context already holds. */
export function turnStartReminders(
  context: ReminderContext,
  history: readonly Message[],
): ReminderBlock[] {
  // The newest text each reminder id put into the active context.
  const sent = new Map<ReminderId, string>();
  for (const message of history.slice(activeContextStart([...history])))
    for (const [index, id] of (message.reminders ?? []).entries()) {
      const block = message.content[index];
      sent.set(id, block?.type === "text" ? block.text : "");
    }
  return TURN_REMINDERS.flatMap((reminder) => {
    const told = sent.get(reminder.id);
    const text =
      reminder.everyTurn || told === undefined
        ? reminder.render(context)
        : (reminder.renderSent?.(context, told) ?? null);
    return text === null
      ? []
      : [
          {
            id: reminder.id,
            block: { type: "text", text: systemReminder(text) },
          },
        ];
  });
}

/**
 * Source `cumulativeUsed`: context growth since the turn's countdown was anchored
 * (its last turn-start reminder), never decreasing within the turn.
 */
export function turnTokensUsed(history: readonly Message[]): number {
  const anchorRow = history.findLastIndex((message) =>
    message.reminders?.includes("total_tokens"),
  );
  let anchor = 0,
    used = 0;
  for (const [index, message] of history.entries()) {
    if (message.role !== "assistant" || !message.usage) continue;
    const total = contextTokens(message.usage);
    if (index < anchorRow) anchor = total;
    else used = Math.max(used, total - anchor);
  }
  return used;
}

type TaskSummary = Extract<
  Attachment,
  { type: "task_reminder" }
>["tasks"][number];

export interface RoundFacts extends Pick<ReminderContext, "model" | "env"> {
  /** What the turn-start block announced, and where the Bash shell stands now. */
  environment?: { start: EnvironmentSnapshot; now: EnvironmentSnapshot };
  /** The task list, present only while TaskUpdate is offered. */
  tasks?: readonly TaskSummary[];
}

/** Source `Lz(...).latest`: the newest environment the active context told the model. */
function announcedEnvironment(
  start: EnvironmentSnapshot,
  history: readonly Message[],
): EnvironmentSnapshot {
  const last = history
    .slice(activeContextStart([...history]))
    .findLast((message) => message.attachment?.type === "environment");
  return last?.attachment?.type === "environment"
    ? last.attachment.snapshot
    : start;
}

/** Source `jso` after a Bash `cd`: the fields that moved since the last announcement. */
function environmentUpdate(
  environment: RoundFacts["environment"],
  history: readonly Message[],
): Attachment[] {
  if (!environment) return [];
  const changes = environmentChanges(
    announcedEnvironment(environment.start, history),
    environment.now,
  );
  return changes.length
    ? [{ type: "environment", snapshot: environment.now, changes }]
    : [];
}

/** Source `T1e`. */
const TASK_REMINDER_TURNS = 10;
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);

/**
 * Source `rAs`: the original stores each streamed content block as its own
 * assistant message and skips thinking-only ones, so turns count blocks.
 */
function taskReminderTurns(history: readonly Message[]): {
  sinceTaskManagement: number;
  sinceReminder: number;
} {
  let sinceTaskManagement = 0,
    sinceReminder = 0,
    managed = false,
    reminded = false;
  for (const message of history
    .slice(activeContextStart([...history]))
    .reverse()) {
    if (message.attachment?.type === "task_reminder") reminded = true;
    if (message.role !== "assistant") continue;
    for (const block of message.content.toReversed()) {
      if (block.type === "thinking" || block.type === "redacted_thinking")
        continue;
      if (block.type === "tool_use" && TASK_TOOLS.has(block.name))
        managed = true;
      if (!managed) sinceTaskManagement++;
      if (!reminded) sinceReminder++;
    }
    if (managed && reminded) break;
  }
  return { sinceTaskManagement, sinceReminder };
}

/** Source `sAs`: a nudge after ten model turns without TaskCreate or TaskUpdate. */
function taskReminder(
  { tasks, env }: RoundFacts,
  history: readonly Message[],
): Attachment[] {
  if (!tasks || env.CLAUDE_CODE_TODO_REMINDER_MODE === "off") return [];
  const turns = taskReminderTurns(history);
  return turns.sinceTaskManagement >= TASK_REMINDER_TURNS &&
    turns.sinceReminder >= TASK_REMINDER_TURNS
    ? [{ type: "task_reminder", tasks: [...tasks] }]
    : [];
}

/** Source `mAs` without a new prompt: the attachments owed before a later request in a turn. */
export function roundAttachments(
  facts: RoundFacts,
  history: readonly Message[],
): Attachment[] {
  const text = totalTokensText(facts, turnTokensUsed(history));
  return [
    ...environmentUpdate(facts.environment, history),
    ...taskReminder(facts, history),
    ...(text === null
      ? []
      : [{ type: "total_tokens_reminder" as const, text }]),
  ];
}

const rank = (id: ReminderId) => REMINDER_IDS.indexOf(id);

/** Merges reminders into the row's leading reminder run, kept in model-visible order. */
export function prependReminders(
  row: Message,
  reminders: readonly ReminderBlock[],
): void {
  if (!reminders.length) return;
  const held = row.reminders ?? [];
  const run = [
    ...held.flatMap((id, index) => {
      const block = row.content[index];
      return block?.type === "text" ? [{ id, block }] : [];
    }),
    ...reminders,
  ].sort((left, right) => rank(left.id) - rank(right.id));
  row.content = [
    ...run.map(({ block }) => block),
    ...row.content.slice(held.length),
  ];
  row.reminders = run.map(({ id }) => id);
}

/** A user round's leading reminders gathered into one row ahead of the round's own content. */
export function foldRoundReminders(rows: readonly Message[]): Message[] {
  const run: ReminderBlock[] = [],
    rest: Message[] = [];
  for (const row of rows) {
    const held = row.reminders?.length ?? 0;
    if (!held) {
      rest.push(row);
      continue;
    }
    for (const [index, id] of (row.reminders ?? []).entries()) {
      const block = row.content[index];
      if (block?.type === "text") run.push({ id, block });
    }
    if (row.content.length > held)
      rest.push({ ...row, content: row.content.slice(held) });
  }
  if (!run.length) return rest;
  run.sort((left, right) => rank(left.id) - rank(right.id));
  return [{ role: "user", content: run.map(({ block }) => block) }, ...rest];
}

/** The first ordinary prompt's text: past leading reminders and any instruction notice. */
export function firstPromptText(messages: readonly Message[]): string {
  for (const message of messages) {
    if (
      message.role !== "user" ||
      message.contextPlacement !== undefined ||
      message.content.some((block) => block.type === "tool_result")
    )
      continue;
    const texts = message.content
      .slice(message.reminders?.length ?? 0)
      .flatMap((block) => (block.type === "text" ? [block.text] : []));
    const text = texts[message.instructionFiles?.length ? 1 : 0];
    if (text !== undefined) return text;
  }
  return "";
}

/** Commit and PR attribution lines from settings, as the original resolves them. */
export function attributionTexts(
  model: string,
  settings: { attribution?: unknown; includeCoAuthoredBy?: unknown },
): { commit: string; pr: string } {
  const facts = promptModel(model),
    name = facts.id.startsWith("claude-fable-")
      ? "Claude"
      : facts.displayName
        ? `Claude ${facts.displayName}`
        : "Claude Code";
  const commit = `Co-Authored-By: ${name} <noreply@anthropic.com>`,
    pr =
      "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)";
  const custom = settings.attribution;
  if (custom !== null && typeof custom === "object" && !Array.isArray(custom)) {
    const fields: { commit?: unknown; pr?: unknown } = custom;
    return {
      commit: typeof fields.commit === "string" ? fields.commit : commit,
      pr: typeof fields.pr === "string" ? fields.pr : pr,
    };
  }
  return settings.includeCoAuthoredBy === false
    ? { commit: "", pr: "" }
    : { commit, pr };
}

/** Nearest `.git` above cwd; a `.git` file naming a worktrees gitdir marks a linked worktree. */
export async function gitFacts(cwd: string): Promise<ReminderContext["git"]> {
  for (let directory = cwd; ; directory = dirname(directory)) {
    const marker = join(directory, ".git");
    const stat = await lstat(marker).catch(() => undefined);
    if (stat?.isDirectory()) return { repository: true, worktree: false };
    if (stat?.isFile()) {
      const text = await readFile(marker, "utf8").catch(() => "");
      return {
        repository: text.startsWith("gitdir:"),
        worktree: /^gitdir:.*[\\/]worktrees[\\/]/m.test(text),
      };
    }
    if (dirname(directory) === directory)
      return { repository: false, worktree: false };
  }
}

export async function environmentSnapshot(
  directory: string,
): Promise<EnvironmentSnapshot> {
  const git = await gitFacts(directory);
  return {
    workingDirectory: directory,
    isGitRepo: git.repository,
    isWorktree: git.worktree,
  };
}

export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
