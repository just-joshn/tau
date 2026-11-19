import { z } from "zod";
import { activeContextStart } from "./context-usage.js";
import { triBoolean } from "./env-settings.js";
import type {
  ApiToolContent,
  Message,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  ToolUse,
} from "./types.js";

export const TOOL_SEARCH = "ToolSearch";

/** Built-in tools the original marks `shouldDefer`, keyed to their searchHint. */
const DEFERRED_BUILTINS: ReadonlyMap<string, string> = new Map([
  ["CronCreate", "schedule a recurring or one-shot prompt"],
  ["CronDelete", "cancel a scheduled cron job"],
  ["CronList", "list active cron jobs"],
  ["EnterPlanMode", "switch to plan mode to design an approach before coding"],
  ["EnterWorktree", "create an isolated git worktree and switch into it"],
  [
    "ExitPlanMode",
    "present plan for approval and start coding (plan mode only)",
  ],
  [
    "ExitWorktree",
    "exit a worktree session and return to the original directory",
  ],
  [
    "Monitor",
    "watch, monitor, or keep an eye on a process/log/command or WebSocket — stream each stdout line as a live notification",
  ],
  ["NotebookEdit", "edit Jupyter notebook cells (.ipynb)"],
  ["SendMessage", "send messages to agent teammates"],
  ["TaskCreate", "create a task in the task list"],
  ["TaskGet", "retrieve a task by ID"],
  ["TaskList", "list all tasks"],
  ["TaskStop", "kill a running background task"],
  ["TaskUpdate", "update a task"],
  ["TodoWrite", "manage the session task checklist"],
  ["WebFetch", "fetch and extract content from a URL"],
  ["WebSearch", "search the web for current information"],
]);

/** Models the original refuses tool search for (`tengu_tool_search_unsupported_models` default). */
const UNSUPPORTED_MODELS = [
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3-haiku",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-7-sonnet",
];

export type ToolLoading = "eager" | "deferred";
export interface CatalogEntry {
  definition: ToolDefinition;
  loading: ToolLoading;
  searchHint?: string;
}

export function toolCatalog(
  definitions: readonly ToolDefinition[],
  alwaysLoad: (name: string) => boolean = () => false,
): CatalogEntry[] {
  return definitions.map((definition) => {
    const searchHint = DEFERRED_BUILTINS.get(definition.name);
    if (searchHint !== undefined)
      return { definition, loading: "deferred", searchHint };
    return {
      definition,
      loading:
        definition.name.startsWith("mcp__") && !alwaysLoad(definition.name)
          ? "deferred"
          : "eager",
    };
  });
}

/** The original's tpe() gate plus its unsupported-model list. */
export function toolSearchEnabled(
  env: Readonly<Record<string, string | undefined>>,
  model: string,
): boolean {
  if (triBoolean(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) return false;
  const value = env.ENABLE_TOOL_SEARCH?.trim();
  if (value?.startsWith("auto:")) {
    const threshold = Number(value.slice(5));
    if (!Number.isNaN(threshold) && threshold >= 100) return false;
  } else if (triBoolean(value) === false) return false;
  const lower = model.toLowerCase();
  return !UNSUPPORTED_MODELS.some((name) => lower.includes(name));
}

/** Discovery lives in history: tool_reference blocks after the last compaction boundary. */
export function discoveredToolNames(messages: Message[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages.slice(activeContextStart(messages)))
    for (const block of message.content)
      if (block.type === "tool_result")
        for (const item of block.apiContent ?? [])
          if (item.type === "tool_reference") names.add(item.tool_name);
  return names;
}

const LISTING_HEADER = `The following deferred tools are now available via ${TOOL_SEARCH}. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ${TOOL_SEARCH} with query "select:<name>[,<name>...]" to load tool schemas before calling them:`;
const AMBIENT =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";

export interface DeferredToolsDelta {
  attachment: {
    type: "deferred_tools_delta";
    addedNames: string[];
    removedNames: string[];
  };
  text: string;
}
/** Announce deferred names not yet listed in the active history; withdraw departed ones. */
export function deferredToolsDelta(
  current: readonly string[],
  history: readonly { addedNames: string[]; removedNames: string[] }[],
): DeferredToolsDelta | undefined {
  const listed = new Set<string>();
  for (const record of history) {
    for (const name of record.addedNames) listed.add(name);
    for (const name of record.removedNames) listed.delete(name);
  }
  const now = new Set(current);
  const addedNames = [...now].filter((name) => !listed.has(name)).sort();
  const removedNames = [...listed].filter((name) => !now.has(name)).sort();
  if (!addedNames.length && !removedNames.length) return undefined;
  const parts: string[] = [];
  if (addedNames.length)
    parts.push(`${LISTING_HEADER}\n${addedNames.join("\n")}`);
  if (removedNames.length)
    parts.push(
      `The following deferred tools are no longer available in this session. Do not search for them — ${TOOL_SEARCH} will return no match:\n${removedNames.join("\n")}`,
      AMBIENT,
    );
  return {
    attachment: { type: "deferred_tools_delta", addedNames, removedNames },
    text: `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`,
  };
}

const toolSearchInput = z.object({
  query: z.string(),
  max_results: z.number().optional(),
});
export const toolSearchDefinition: ToolDefinition = {
  name: TOOL_SEARCH,
  description: `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`,
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      query: {
        description:
          'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
        type: "string",
      },
      max_results: {
        description: "Maximum number of results to return (default: 5)",
        default: 5,
        type: "number",
      },
    },
    required: ["query", "max_results"],
    additionalProperties: false,
  },
};
const placeholderDefinition: ToolDefinition = {
  name: "DeferredToolPlaceholder",
  description:
    "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
  input_schema: { type: "object", properties: {} },
  defer_loading: true,
};

const SELECT = /^select:(.+)$/i;
function nameIn(names: readonly string[], wanted: string): string | undefined {
  if (names.includes(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  return names.find((name) => name.toLowerCase() === lower);
}
function nameParts(name: string) {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name) ?? [];
  if (server !== undefined && tool !== undefined) {
    const coarse = [server, tool].map((part) => part.toLowerCase());
    const parts = coarse.flatMap((part) => part.split(/[\s_.]+/));
    return { parts, coarse, full: parts.join(" "), mcp: true };
  }
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return {
    parts,
    coarse: [name.toLowerCase()],
    full: parts.join(" "),
    mcp: false,
  };
}
function wordPattern(term: string): RegExp {
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}

/** Pzt: exact name, mcp__ prefix, then +required filtering and weighted keyword ranking. */
function keywordSearch(
  query: string,
  deferred: readonly CatalogEntry[],
  maxResults: number,
): string[] {
  const lower = query.toLowerCase();
  if (lower.startsWith("mcp__") && lower.length > 5) {
    const prefixed = deferred
      .filter((entry) => entry.definition.name.toLowerCase().startsWith(lower))
      .slice(0, maxResults)
      .map((entry) => entry.definition.name);
    if (prefixed.length) return prefixed;
  }
  const terms = lower.split(/\s+/).filter(Boolean);
  const required = terms
    .filter((term) => term.startsWith("+") && term.length > 1)
    .map((term) => term.slice(1));
  const ranked = required.length
    ? [
        ...required,
        ...terms.filter((term) => !(term.startsWith("+") && term.length > 1)),
      ]
    : terms;
  const withPattern = (term: string) => ({ term, pattern: wordPattern(term) });
  const facts = deferred.map((entry) => ({
    name: entry.definition.name,
    parts: nameParts(entry.definition.name),
    description: entry.definition.description.toLowerCase(),
    hint: entry.searchHint?.toLowerCase() ?? "",
  }));
  const candidates = facts.filter((fact) =>
    required
      .map(withPattern)
      .every(
        ({ term, pattern }) =>
          fact.parts.parts.some((part) => part.includes(term)) ||
          fact.parts.coarse.some((part) => part.includes(term)) ||
          pattern.test(fact.description) ||
          (fact.hint !== "" && pattern.test(fact.hint)),
      ),
  );
  return candidates
    .map((fact) => {
      let score = 0;
      const exact = fact.parts.mcp ? 12 : 10;
      for (const { term, pattern } of ranked.map(withPattern)) {
        if (fact.parts.parts.includes(term)) score += exact;
        else if (fact.parts.parts.some((part) => part.includes(term)))
          score += fact.parts.mcp ? 6 : 5;
        if (fact.parts.coarse.includes(term)) score += exact;
        else if (fact.parts.coarse.some((part) => part.includes(term)))
          score += fact.parts.mcp ? 4 : 3;
        if (fact.parts.full.includes(term) && score === 0) score += 3;
        if (fact.hint && pattern.test(fact.hint)) score += 4;
        if (pattern.test(fact.description)) score += 2;
      }
      return { name: fact.name, score };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults)
    .map((row) => row.name);
}

export interface ToolSearchOutcome {
  matches: string[];
  /** Named tools that are already callable without a search. */
  alreadyLoaded: string[];
}
/** The ToolSearch call: `loaded` is every callable name (eager plus discovered). */
export function searchTools(
  rawQuery: string,
  deferred: readonly CatalogEntry[],
  loaded: readonly string[],
  maxResults = 5,
): ToolSearchOutcome {
  const bounded = rawQuery.slice(0, 16384);
  const unloaded = deferred.filter(
    (entry) => !loaded.includes(entry.definition.name),
  );
  const unloadedNames = unloaded.map((entry) => entry.definition.name);
  const select = SELECT.exec(bounded)?.[1];
  if (select !== undefined) {
    const matches: string[] = [],
      alreadyLoaded: string[] = [];
    for (const wanted of select
      .split(",")
      .slice(0, 64)
      .map((name) => name.trim())
      .filter(Boolean)) {
      const loadedName = nameIn(loaded, wanted);
      const found = loadedName ? undefined : nameIn(unloadedNames, wanted);
      if (loadedName && !alreadyLoaded.includes(loadedName))
        alreadyLoaded.push(loadedName);
      if (found && !matches.includes(found)) matches.push(found);
    }
    return { matches, alreadyLoaded };
  }
  const words = bounded.trim().split(/\s+/);
  const query = (
    words.length <= 32 ? bounded : words.slice(0, 32).join(" ")
  ).trim();
  const loadedName = nameIn(loaded, query);
  if (loadedName) return { matches: [], alreadyLoaded: [loadedName] };
  const exact = nameIn(unloadedNames, query);
  if (exact) return { matches: [exact], alreadyLoaded: [] };
  return {
    matches: keywordSearch(query, unloaded, maxResults),
    alreadyLoaded: [],
  };
}

function searchResult(
  call: ToolUse,
  outcome: ToolSearchOutcome,
  definitions: readonly ToolDefinition[],
): ToolResult {
  const note = outcome.alreadyLoaded.length
    ? `Already available in this conversation: ${outcome.alreadyLoaded.join(", ")}. ${outcome.alreadyLoaded.length === 1 ? "Call it" : "Call whichever you need"} directly.`
    : undefined;
  if (!outcome.matches.length) {
    const content = ["No matching deferred tools found", note]
      .filter(Boolean)
      .join("\n\n");
    return { type: "tool_result", tool_use_id: call.id, content };
  }
  const functions = outcome.matches.flatMap((name) => {
    const definition = definitions.find((tool) => tool.name === name);
    return definition
      ? [
          `<function>${JSON.stringify({ description: definition.description, name, parameters: definition.input_schema })}</function>`,
        ]
      : [];
  });
  const apiContent: ApiToolContent[] = outcome.matches.map((name) => ({
    type: "tool_reference",
    tool_name: name,
  }));
  if (note) apiContent.push({ type: "text", text: note });
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: `<functions>${functions.map((line) => `\n${line}`).join("")}\n</functions>`,
    apiContent,
  };
}

export interface ToolSearchOptions {
  /** Evaluated per request: env/model gate and whether policy offers ToolSearch. */
  enabled: () => boolean;
  alwaysLoad?: (name: string) => boolean;
}
export type ToolSearchExecutor = ToolExecutor & {
  /** Every deferred name, discovered or not; empty when tool search is off. */
  deferredNames(): string[];
};

/**
 * Projects the request catalog: eager tools, ToolSearch, discovered deferred
 * tools flagged defer_loading, and the placeholder before the last tool.
 */
export function wrapToolSearch(
  base: ToolExecutor,
  messages: Message[],
  options: ToolSearchOptions,
): ToolSearchExecutor {
  const deferred = () =>
    options.enabled()
      ? toolCatalog(base.definitions, options.alwaysLoad).filter(
          (entry) => entry.loading === "deferred",
        )
      : [];
  const project = () => {
    const pending = deferred();
    if (!pending.length) return undefined;
    const pendingNames = new Set(pending.map((entry) => entry.definition.name));
    const discovered = discoveredToolNames(messages);
    const tools = base.definitions.flatMap((tool): ToolDefinition[] =>
      !pendingNames.has(tool.name)
        ? [tool]
        : discovered.has(tool.name)
          ? [{ ...tool, defer_loading: true }]
          : [],
    );
    tools.push(toolSearchDefinition);
    tools.splice(tools.length - 1, 0, placeholderDefinition);
    return { tools, pending, discovered };
  };
  return {
    setReadContext: (context) => base.setReadContext?.(context),
    beforeModelRequest: async (signal) => base.beforeModelRequest?.(signal),
    ...(base.prepareCompaction
      ? { prepareCompaction: base.prepareCompaction }
      : {}),
    get definitions() {
      return project()?.tools ?? base.definitions;
    },
    deferredNames: () => deferred().map((entry) => entry.definition.name),
    async execute(call, signal) {
      const projection = project();
      if (!projection) return base.execute(call, signal);
      if (call.name === TOOL_SEARCH) {
        const parsed = toolSearchInput.safeParse(call.input);
        if (!parsed.success)
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: `InputValidationError: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
            is_error: true,
            inputRejected: true,
          };
        const loaded = projection.tools
          .filter((tool) => tool.name !== placeholderDefinition.name)
          .map((tool) => tool.name);
        return searchResult(
          call,
          searchTools(
            parsed.data.query,
            projection.pending,
            loaded,
            parsed.data.max_results,
          ),
          base.definitions,
        );
      }
      if (
        projection.pending.some(
          (entry) => entry.definition.name === call.name,
        ) &&
        !projection.discovered.has(call.name)
      )
        return {
          type: "tool_result",
          tool_use_id: call.id,
          content: `InputValidationError: ${call.name} did not run: it was not loaded when it was called. Unless ${TOOL_SEARCH} has loaded it since, load it together with the other tools you expect to need, in one ${TOOL_SEARCH} call (for example, query "select:${call.name}", with the other names after it, comma-separated). Call it again once that result has come back, not in the same reply.`,
          is_error: true,
          inputRejected: true,
        };
      return base.execute(call, signal);
    },
  };
}
