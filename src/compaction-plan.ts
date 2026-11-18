import { resolve } from "node:path";
import { estimateMessageTokens } from "./context-usage.js";
import type { ContextRejection } from "./context-error.js";
import type { Message, ToolDefinition, ToolUse } from "./types.js";

export interface CompactionPolicy {
  allowLastResort?: boolean;
  keepNoRound?: boolean;
  keptTailTokens?: number;
  /** The recovered omission feature defaults off; embeddings can supply its assignment. */
  omitLargeToolResults?: boolean;
  retryMissingSummary?: boolean;
  summarizeKeptRounds?: boolean;
  cachePrefix?: boolean;
  freshTools?: ToolDefinition[];
  replacedToolIds?: ReadonlySet<string>;
  cwd?: string;
}
export interface SummaryPlan {
  toSummarize: Message[];
  toKeep: Message[];
  mode: "round" | "all";
  groupsPreserved: number;
  totalGroups: number;
  headTruncations: number;
  omissionPasses: number;
  leftOutIds: ReadonlySet<string>;
  openingOnly?: boolean;
}
const tokens = (messages: Message[]) =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
const hasResults = (message: Message) =>
  message.content.some((block) => block.type === "tool_result");
const denied = new Set([
  "user-rejected",
  "permission-rule",
  "automode-blocked",
  "automode-unavailable",
  "automode-parsing-error",
]);

export function exchangeGroups(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [],
    previousId: string | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      const id = message.responseId ?? `local:${index}`;
      if (
        current.length &&
        id !== previousId &&
        !message.resumedFromIncompleteThinking
      ) {
        groups.push(current);
        current = [];
      }
      previousId = id;
    }
    current.push(message);
  }
  if (current.length) groups.push(current);
  return groups;
}

export function splitPendingInput(messages: Message[]): {
  toSummarize: Message[];
  toKeep: Message[];
} {
  let closed = 0;
  for (const [index, message] of messages.entries())
    if (
      message.role === "assistant" ||
      (message.role === "user" && hasResults(message))
    )
      closed = index + 1;
  let pending = -1;
  for (const [offset, row] of messages.slice(closed).entries()) {
    if (row.role === "user" && !hasResults(row) && !row.contextTruncated)
      pending = closed + offset;
  }
  return pending < 0
    ? { toSummarize: messages, toKeep: [] }
    : {
        toSummarize: messages.slice(0, pending),
        toKeep: messages.slice(pending),
      };
}

interface ResultCandidate {
  id: string;
  tokens: number;
}
interface ResultGroup {
  members: ResultCandidate[];
  tokens: number;
}
function resultGroups(
  messages: Message[],
  policy: CompactionPolicy,
  leftOut: ReadonlySet<string>,
): ResultGroup[] {
  const calls = new Map<string, ToolUse>(),
    counts = new Map<string, number>();
  for (const row of messages)
    for (const block of row.content) {
      if (row.role === "assistant" && block.type === "tool_use")
        calls.set(block.id, block);
      if (row.role === "user" && block.type === "tool_result")
        counts.set(block.tool_use_id, (counts.get(block.tool_use_id) ?? 0) + 1);
    }
  const grouped = new Map<string, ResultCandidate[]>();
  for (const row of messages) {
    const results =
      row.role === "user"
        ? row.content.filter((block) => block.type === "tool_result")
        : [];
    if (results.length === 1 && denied.has(row.toolDenialKind ?? "")) continue;
    for (const result of results) {
      const id = result.tool_use_id,
        call = calls.get(id);
      if (call?.name === "AskUserQuestion" || leftOut.has(id)) continue;
      const input = call?.input;
      const path =
        call?.name === "Read" &&
        input &&
        typeof input === "object" &&
        "file_path" in input &&
        typeof input.file_path === "string"
          ? resolve(policy.cwd ?? process.cwd(), input.file_path)
          : undefined;
      const key = path === undefined ? `call:${id}` : `read:${path}`;
      const members = grouped.get(key) ?? [];
      grouped.set(key, members);
      // One ineligible member excludes the entire same-file group.
      members.push({
        id,
        tokens:
          counts.get(id) === 1 && !policy.replacedToolIds?.has(id)
            ? Math.round(result.content.length / 4)
            : -Infinity,
      });
    }
  }
  return [...grouped.values()]
    .map((members) => ({
      members,
      tokens: members.reduce((sum, member) => sum + member.tokens, 0),
    }))
    .filter((group) => group.tokens >= 750);
}

export function canOmitToolResults(
  messages: Message[],
  gap: number | undefined,
  policy: CompactionPolicy = {},
): boolean {
  if (!policy.omitLargeToolResults || gap === undefined) return false;
  const candidates = resultGroups(messages, policy, new Set());
  return (
    candidates.length > 0 &&
    candidates.reduce((sum, group) => sum + group.tokens, 0) * 4 >= gap
  );
}

function omitResults(
  plan: SummaryPlan,
  gap: number | undefined,
  policy: CompactionPolicy,
): SummaryPlan | undefined {
  if (
    !policy.omitLargeToolResults ||
    plan.headTruncations > 0 ||
    plan.omissionPasses >= 3 ||
    exchangeGroups(plan.toSummarize).length >= 3
  )
    return;
  const candidates = resultGroups(plan.toSummarize, policy, plan.leftOutIds);
  const total = candidates.reduce((sum, group) => sum + group.tokens, 0);
  if (gap !== undefined && total * 4 < gap) return;
  const target =
    plan.omissionPasses === 2
      ? Infinity
      : gap === undefined
        ? total / 2
        : gap * 1.1;
  const selected = new Set<string>();
  let removed = 0;
  for (const group of candidates.sort((a, b) => b.tokens - a.tokens)) {
    if (removed >= target) break;
    group.members.forEach((member) => selected.add(member.id));
    removed += group.tokens;
  }
  if (!selected.size) return;
  const toSummarize = plan.toSummarize.map((row) =>
    row.role !== "user"
      ? row
      : {
          ...row,
          content: row.content.map((block) =>
            block.type !== "tool_result" || !selected.has(block.tool_use_id)
              ? block
              : {
                  ...block,
                  apiContent: undefined,
                  content:
                    "[Tool output omitted to fit the summary request. This call already ran and may have changed files or other state. Its output is unavailable here.]",
                },
          ),
        },
  );
  return {
    ...plan,
    toSummarize,
    omissionPasses: plan.omissionPasses + 1,
    leftOutIds: new Set([...plan.leftOutIds, ...selected]),
  };
}

function substantive(messages: Message[]): boolean {
  return (
    messages.some((row) => row.role === "assistant") ||
    tokens(
      messages.filter((row) => row.role === "user" && !row.contextTruncated),
    ) >= 1000
  );
}
export function truncateSummaryHead(
  messages: Message[],
  gap: number | undefined,
): Message[] | undefined {
  const clean = messages[0]?.contextTruncated ? messages.slice(1) : messages;
  const groups = exchangeGroups(clean);
  if (groups.length < 2) return;
  let count =
      gap === undefined ? Math.max(1, Math.floor(groups.length * 0.2)) : 0,
    removed = 0;
  if (gap !== undefined)
    for (const group of groups) {
      removed += tokens(group);
      count++;
      if (removed >= gap) break;
    }
  const remaining = groups.slice(Math.min(count, groups.length - 1)).flat();
  if (remaining[0]?.role === "assistant")
    remaining.unshift({
      role: "user",
      content: [
        {
          type: "text",
          text: "Earlier conversation was removed from this summary request because it exceeded the model's input limit.",
        },
      ],
      contextTruncated: true,
    });
  return remaining;
}

function stepFromEnd(sizes: number[], end: number, gap: number): number {
  let count = 0,
    removed = 0;
  for (const size of sizes.slice(0, end).reverse()) {
    removed += size;
    count++;
    if (removed >= gap) break;
  }
  return count >= end - 1 ? Math.max(1, Math.floor(end / 2)) : count;
}
const unicodeExtra = (messages: Message[]) => {
  const json = JSON.stringify(messages.map((row) => row.content));
  return (Buffer.byteLength(json) - json.length) / 4;
};

/** Pure planning state; no mutation of the live transcript, tools, provider or caller budget. */
export class SummaryPlanner {
  private readonly groups: Message[][];
  private readonly sizes: number[];
  private preserve = 1;
  private all: SummaryPlan | undefined;
  private lastRejection: { gap?: number; end: number } | undefined;
  private openingTried = false;
  private openingGap: number | undefined;
  constructor(
    private readonly messages: Message[],
    private readonly policy: CompactionPolicy = {},
    private readonly inputError?: ContextRejection,
    systemTokens = 0,
    instructionTokens = 0,
  ) {
    this.groups = exchangeGroups(messages);
    this.sizes = this.groups.map(tokens);
    if (policy.keepNoRound) this.preserve = this.groups.length;
    else if (policy.keptTailTokens) {
      let remaining = policy.keptTailTokens,
        count = 0;
      for (const [index, group] of [...this.groups.entries()]
        .slice(2)
        .reverse()) {
        remaining -= (this.sizes[index] ?? tokens(group)) + unicodeExtra(group);
        if (remaining < 0) break;
        count++;
      }
      this.preserve = Math.max(this.preserve, count);
    }
    const lastSize = this.sizes.at(-1);
    if (
      inputError?.gap !== undefined &&
      inputError.actualTokens !== undefined &&
      this.groups.length > 3 &&
      lastSize !== undefined
    ) {
      const total = this.sizes.reduce((sum, size) => sum + size, 0);
      const scale =
        total > 0
          ? Math.max(1, (inputError.actualTokens - systemTokens) / total)
          : 1;
      const gap = inputError.gap / scale + instructionTokens - lastSize;
      if (gap > 0)
        this.preserve =
          1 + stepFromEnd(this.sizes, this.groups.length - 1, gap);
    }
  }
  next(): SummaryPlan | undefined {
    if (this.groups.length < 2) return;
    if (this.all) return this.all;
    const end = Math.max(0, this.groups.length - this.preserve),
      prefix = this.groups.slice(0, end).flat();
    if (
      prefix.some((row) => row.role === "assistant") ||
      (this.openingTried && end === 1)
    )
      return {
        toSummarize: prefix,
        toKeep: this.groups.slice(end).flat(),
        mode: "round",
        groupsPreserved: this.preserve,
        totalGroups: this.groups.length,
        headTruncations: 0,
        omissionPasses: 0,
        leftOutIds: new Set(),
        ...(this.openingTried && end === 1 ? { openingOnly: true } : {}),
      };
    if (this.policy.allowLastResort === false && !this.policy.keepNoRound)
      return;
    const split = splitPendingInput(this.messages);
    const gaps: number[] = [];
    if (this.inputError?.gap !== undefined) gaps.push(this.inputError.gap);
    if (this.lastRejection?.gap !== undefined)
      gaps.push(
        this.lastRejection.gap +
          this.sizes
            .slice(this.lastRejection.end)
            .reduce((sum, size) => sum + size, 0),
      );
    if (this.openingGap !== undefined) gaps.push(this.openingGap);
    const gap = gaps.length
      ? Math.max(...gaps) - tokens(split.toKeep)
      : undefined;
    if (
      end === 1 &&
      gap !== undefined &&
      gap > 0 &&
      this.openingEligible(Math.max(...gaps))
    ) {
      this.openingTried = true;
      return this.next();
    }
    this.all = {
      ...split,
      mode: "all",
      groupsPreserved: 0,
      totalGroups: this.groups.length,
      headTruncations: 0,
      omissionPasses: 0,
      leftOutIds: new Set(),
    };
    if (
      (gap !== undefined && gap > 0) ||
      (gap === undefined && this.lastRejection)
    )
      this.all = this.reduce(gap !== undefined ? Math.max(0, gap) : undefined);
    return this.all &&
      substantive([...this.all.toSummarize, ...this.all.toKeep])
      ? this.all
      : undefined;
  }
  reject(plan: SummaryPlan, error: ContextRejection): boolean {
    if (plan.mode === "all") {
      if (
        plan.headTruncations === 0 &&
        plan.omissionPasses === 0 &&
        error.gap !== undefined &&
        this.openingEligible(error.gap + tokens(plan.toKeep))
      ) {
        this.openingTried = true;
        this.openingGap = error.gap + tokens(plan.toKeep);
        this.preserve = this.groups.length - 1;
        this.all = undefined;
        return true;
      }
      this.all = this.reduce(error.gap);
      return this.all !== undefined;
    }
    const end = this.groups.length - this.preserve;
    this.lastRejection = {
      ...(error.gap === undefined ? {} : { gap: error.gap }),
      end,
    };
    const gap =
      error.gap ??
      Math.ceil(
        this.sizes.slice(0, end).reduce((sum, size) => sum + size, 0) / 10,
      );
    this.preserve += stepFromEnd(this.sizes, end, gap);
    return true;
  }
  discardOpening(): void {
    this.preserve = this.groups.length;
    this.all = undefined;
  }
  private openingEligible(gap: number): boolean {
    const opening = this.groups[0] ?? [],
      size = this.sizes[0] ?? 0;
    return (
      !this.openingTried &&
      substantive(opening) &&
      size - Math.ceil(size / 10) >= gap + 70000
    );
  }
  private reduce(gap: number | undefined): SummaryPlan | undefined {
    const plan = this.all;
    if (!plan) return;
    const omitted = omitResults(plan, gap, this.policy);
    if (omitted) return omitted;
    if (plan.headTruncations >= 3) return;
    const toSummarize = truncateSummaryHead(plan.toSummarize, gap);
    if (!toSummarize || !substantive([...toSummarize, ...plan.toKeep])) return;
    return { ...plan, toSummarize, headTruncations: plan.headTruncations + 1 };
  }
}
