import { createHash } from "node:crypto";
import stringWidth from "string-width";

/** Inputs have already passed host admission, visibility, permission, and scoped-offer filters. */
export interface CatalogAgentMetadata {
  agentType: string;
  whenToUse: string;
  whenToUseLean?: string;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  source?: string;
  builtInPlugin?: boolean;
}
export interface CatalogSkillMetadata {
  name: string;
  displayName?: string;
  /** Optional output of the host's source-compatible alias resolver. */
  listingName?: string;
  description: string;
  listingDescription?: string;
  whenToUse?: string;
  nameOnly?: boolean;
  bundled?: boolean;
}
export interface AgentCatalogAttachment {
  type: "agent_listing_delta";
  addedTypes: string[];
  addedLines: string[];
  builtInTypes: string[];
  builtInPluginTypes: string[];
  removedTypes: string[];
  isInitial: boolean;
  showConcurrencyNote: boolean;
}
export interface SkillCatalogAttachment {
  type: "skill_listing";
  content: string;
  skillCount: number;
  isInitial: boolean;
  names: string[];
  digests: string[];
  shortened?: true;
  addsToEarlier?: true;
  callsSkillToolDirectly?: true;
}
/** Deliberately accepts missing legacy digest/line fields from committed history. */
export type CatalogHistoryAttachment =
  | {
      type: "agent_listing_delta";
      addedTypes?: readonly string[];
      addedLines?: readonly string[];
      removedTypes?: readonly string[];
    }
  | {
      type: "skill_listing";
      names?: readonly string[];
      digests?: readonly string[];
      isInitial?: boolean;
      addsToEarlier?: boolean;
    };
export interface CatalogProjectionOptions {
  agents: readonly CatalogAgentMetadata[];
  skills: readonly CatalogSkillMetadata[];
  history: readonly CatalogHistoryAttachment[];
  hasAgentTool: boolean;
  hasSkillTool: boolean;
  /** Source YRs has an additional global suppression gate. The host supplies its decision. */
  suppressSkills?: boolean;
  useLeanAgentDescriptions?: boolean;
  showConcurrencyNote?: boolean;
  /** Source feature VSt affects legacy dynamic-history reset and addsToEarlier metadata. */
  additiveSkillRefresh?: boolean;
  callsSkillToolDirectly?: boolean;
  skillBudget?: {
    contextTokens?: number;
    charsPerToken?: number;
    fraction?: number;
    /** Native SLASH_COMMAND_TOOL_CHAR_BUDGET equivalent, already parsed by host. */
    override?: number;
    /** Per-scan remaining budget: source passes this separately to t1n. */
    remaining?: number;
    maxDescriptionChars?: number;
    priority?: (name: string) => number;
    /** Source uses Bun.stringWidth plus emoji correction. Host may supply its exact equivalent. */
    measure?: (text: string) => number;
  };
}
export interface CatalogProjection {
  /** Append to committed local attachment history only once the corresponding model turn is retained. */
  attachments: (AgentCatalogAttachment | SkillCatalogAttachment)[];
  /** Ordinary user-role metadata path; alternate model system-turn promotion belongs to the host. */
  blocks: { kind: "agent" | "skill"; type: "text"; text: string }[];
}
function description(skill: CatalogSkillMetadata): string {
  const text = skill.listingDescription ?? skill.description;
  return skill.whenToUse ? `${text} - ${skill.whenToUse}` : text;
}
export function catalogSkillDigest(skill: CatalogSkillMetadata): string {
  return createHash("sha256")
    .update(
      JSON.stringify([skill.displayName ?? skill.name, description(skill)]),
    )
    .digest("hex")
    .slice(0, 16);
}
function agentTools(agent: CatalogAgentMetadata): string {
  const tools = agent.tools,
    denied = agent.disallowedTools;
  if (tools?.length && denied?.length) {
    const deniedSet = new Set(denied),
      selected = tools.filter((tool) => !deniedSet.has(tool));
    return selected.length ? selected.join(", ") : "None";
  }
  if (tools?.length) return tools.join(", ");
  if (denied?.length) return `All tools except ${denied.join(", ")}`;
  return "All tools";
}
function compareName(left: string, right: string): number {
  const leftAscii = /^\p{ASCII}*$/u.test(left),
    rightAscii = /^\p{ASCII}*$/u.test(right);
  if (leftAscii !== rightAscii) return leftAscii ? -1 : 1;
  return leftAscii
    ? left.localeCompare(right)
    : left < right
      ? -1
      : left > right
        ? 1
        : 0;
}
function finitePositive(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0)
    throw new RangeError(`Invalid ${name}`);
  return result;
}
function formatSkills(
  skills: readonly CatalogSkillMetadata[],
  options: CatalogProjectionOptions["skillBudget"],
  remaining: number | undefined,
): string {
  if (!skills.length) return "";
  const config = options ?? {};
  const defaultBudget = Math.max(
    1,
    Math.floor(
      finitePositive(config.contextTokens, 200000, "contextTokens") *
        finitePositive(config.charsPerToken, 4, "charsPerToken") *
        finitePositive(config.fraction, 0.01, "fraction"),
    ),
  );
  const configured =
    config.override === undefined
      ? defaultBudget
      : finitePositive(config.override, defaultBudget, "override");
  if (remaining !== undefined && (!Number.isFinite(remaining) || remaining < 0))
    throw new RangeError("Invalid remaining skill budget");
  const budget = Math.min(configured, remaining ?? Infinity),
    measure = config.measure ?? stringWidth;
  const maxDescription = finitePositive(
    config.maxDescriptionChars,
    1536,
    "maxDescriptionChars",
  );
  if (!Number.isInteger(maxDescription))
    throw new RangeError("Invalid maxDescriptionChars");
  const lines = skills.map((skill) => {
    const nameOnly = `- ${skill.listingName ?? skill.name}`;
    if (skill.nameOnly) return { skill, nameOnly, full: nameOnly };
    const fullDescription = description(skill),
      bounded =
        fullDescription.length > maxDescription
          ? `${fullDescription.slice(0, maxDescription - 1)}…`
          : fullDescription;
    return { skill, nameOnly, full: `${nameOnly}: ${bounded}` };
  });
  const fullWidth =
    lines.reduce((sum, line) => sum + measure(line.full), 0) + lines.length - 1;
  if (fullWidth <= budget) return lines.map((line) => line.full).join("\n");
  const fixed = new Set<number>();
  skills.forEach((skill, index) => {
    if (skill.nameOnly || (remaining === undefined && skill.bundled))
      fixed.add(index);
  });
  const flexible = lines.flatMap((line, index) =>
    fixed.has(index) ? [] : [{ index, line }],
  );
  if (!flexible.length) return lines.map((line) => line.full).join("\n");
  const minimum =
    lines.reduce(
      (sum, line, index) =>
        sum + measure(fixed.has(index) ? line.full : line.nameOnly),
      0,
    ) +
    lines.length -
    1;
  let spare = budget - minimum;
  const expanded = new Set<number>();
  const priority = config.priority ?? (() => 0);
  flexible.sort(
    (left, right) =>
      priority(right.line.skill.name) - priority(left.line.skill.name),
  );
  for (const { index, line } of flexible) {
    const extra = measure(line.full) - measure(line.nameOnly);
    if (extra <= spare) {
      expanded.add(index);
      spare -= extra;
    }
  }
  return lines
    .map((line, index) =>
      fixed.has(index) || expanded.has(index) ? line.full : line.nameOnly,
    )
    .join("\n");
}
function wrap(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}
/** Pure planning: no registry access, policy effects, implicit state commit, or tool-description mutation. */
export function buildCatalogAttachments(
  options: CatalogProjectionOptions,
): CatalogProjection {
  const attachments: CatalogProjection["attachments"] = [],
    blocks: CatalogProjection["blocks"] = [];
  if (options.hasAgentTool) {
    const seen = new Set<string>();
    for (const record of options.history) {
      if (record.type !== "agent_listing_delta") continue;
      if (Array.isArray(record.addedLines))
        for (const name of record.addedTypes ?? []) seen.add(name);
      for (const name of record.removedTypes ?? []) seen.delete(name);
    }
    const current = new Set(options.agents.map((agent) => agent.agentType));
    const added = options.agents
      .filter((agent) => !seen.has(agent.agentType))
      .slice()
      .sort((left, right) => compareName(left.agentType, right.agentType));
    const removed = [...seen].filter((name) => !current.has(name)).sort();
    if (added.length || removed.length) {
      const attachment: AgentCatalogAttachment = {
        type: "agent_listing_delta",
        addedTypes: added.map((agent) => agent.agentType),
        addedLines: added.map(
          (agent) =>
            `- ${agent.agentType}: ${(options.useLeanAgentDescriptions && agent.whenToUseLean) || agent.whenToUse} (Tools: ${agentTools(agent)})`,
        ),
        builtInTypes: added
          .filter((agent) => agent.source === "built-in")
          .map((agent) => agent.agentType),
        builtInPluginTypes: added
          .filter((agent) => agent.source === "plugin" && agent.builtInPlugin)
          .map((agent) => agent.agentType),
        removedTypes: removed,
        isInitial: seen.size === 0,
        showConcurrencyNote: options.showConcurrencyNote ?? false,
      };
      attachments.push(attachment);
      const parts: string[] = [];
      if (added.length)
        parts.push(
          `${attachment.isInitial ? "Agent types available through Agent" : "Agent types added"}:\n${attachment.addedLines.join("\n")}`,
        );
      if (removed.length)
        parts.push(
          `Agent types removed; do not select these names:\n${removed.map((name) => `- ${name}`).join("\n")}`,
        );
      if (
        added.length &&
        attachment.isInitial &&
        attachment.showConcurrencyNote
      )
        parts.push(
          "Independent agent calls may be grouped into one assistant turn.",
        );
      blocks.push({
        kind: "agent",
        type: "text",
        text: wrap(parts.join("\n\n")),
      });
    }
  }
  if (options.hasSkillTool && !options.suppressSkills) {
    const records: Extract<
      CatalogHistoryAttachment,
      { type: "skill_listing" }
    >[] = [];
    for (const record of options.history) {
      if (record.type !== "skill_listing") continue;
      if (
        options.additiveSkillRefresh &&
        record.isInitial === false &&
        record.addsToEarlier !== true
      )
        records.length = 0;
      else records.push(record);
    }
    const seen = new Map<string, Set<string | undefined>>();
    for (const record of records)
      for (const [index, name] of (record.names ?? []).entries()) {
        let digests = seen.get(name);
        if (!digests) seen.set(name, (digests = new Set()));
        digests.add(record.digests?.[index]);
      }
    const added = options.skills.filter(
      (skill) =>
        !seen.get(skill.name)?.has(undefined) &&
        !seen.get(skill.name)?.has(catalogSkillDigest(skill)),
    );
    if (added.length) {
      const content = formatSkills(
          added,
          options.skillBudget,
          options.skillBudget?.remaining,
        ),
        isInitial = seen.size === 0;
      const shortened =
        options.skillBudget?.remaining !== undefined &&
        content !== formatSkills(added, options.skillBudget, undefined);
      const attachment: SkillCatalogAttachment = {
        type: "skill_listing",
        content,
        skillCount: added.length,
        isInitial,
        names: added.map((skill) => skill.name),
        digests: added.map(catalogSkillDigest),
        ...(shortened ? { shortened: true } : {}),
        ...(options.additiveSkillRefresh && !isInitial
          ? { addsToEarlier: true }
          : {}),
        ...(options.callsSkillToolDirectly
          ? { callsSkillToolDirectly: true }
          : {}),
      };
      attachments.push(attachment);
      const guide = isInitial
        ? "Skills available through Skill"
        : attachment.addsToEarlier
          ? "Additional skills available through Skill; earlier listings still apply"
          : "Skills available through Skill";
      blocks.push({
        kind: "skill",
        type: "text",
        text: wrap(
          `${guide}:\n${content}${shortened ? "\nName-only entries remain callable." : ""}`,
        ),
      });
    }
  }
  return { attachments, blocks };
}
