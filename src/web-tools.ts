import { z } from "zod";
import { parseNativePermissionRule } from "./native-permission-rules.js";
import {
  appendFailureHookContext,
  appendPreHookContext,
  type PreToolHookResult,
  type ToolHookRuntime,
} from "./tool-hook-runtime.js";
import { unparsedToolInput } from "./tool-input.js";
import {
  matchingToolRule,
  ToolInputRejected,
  ToolPermissionDenied,
  permissionDeniedMarkers,
  type ToolPolicy,
} from "./tool-policy.js";
import type {
  PermissionMode,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  ToolUse,
} from "./types.js";
import {
  createWebFetch,
  isPreapprovedUrl,
  matchesDomainRule,
  WEB_FETCH_TOOL,
  webFetchDescription,
  webFetchInputSchema,
  webFetchRuleContent,
  type WebFetchHost,
} from "./web-fetch.js";
import {
  formatSearchOutput,
  runWebSearch,
  validateWebSearchInput,
  WEB_SEARCH_TOOL,
  webSearchDescription,
  webSearchInputSchema,
  type WebSearchHost,
} from "./web-search.js";

type WebToolName = typeof WEB_FETCH_TOOL | typeof WEB_SEARCH_TOOL;
type Decision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }
  | { behavior: "ask"; message: string; byRule: boolean };

/** Both tools are deferred in the original (shouldDefer); a ToolSearch host loads these. */
export function webToolDefinitions(): ToolDefinition[] {
  const definition = (
    name: WebToolName,
    description: string,
    schema: z.ZodType,
  ): ToolDefinition => ({
    name,
    description,
    input_schema: {
      ...z.toJSONSchema(schema, { io: "input" }),
      type: "object",
    },
  });
  return [
    definition(WEB_FETCH_TOOL, webFetchDescription(), webFetchInputSchema),
    definition(WEB_SEARCH_TOOL, webSearchDescription(), webSearchInputSchema),
  ];
}

function isWebTool(name: string): name is WebToolName {
  return name === WEB_FETCH_TOOL || name === WEB_SEARCH_TOOL;
}

/** WebFetch(domain:…) rule contents of one behavior, CLI and settings sources together. */
function domainRules(
  policy: ToolPolicy,
  behavior: "allow" | "deny" | "ask",
): string[] {
  const cli =
    behavior === "allow"
      ? policy.allowedTools
      : behavior === "deny"
        ? policy.disallowedTools
        : (policy.askedTools ?? []);
  return [
    ...cli,
    ...(policy.sourcedRules ?? [])
      .filter((rule) => rule.behavior === behavior)
      .map((rule) => rule.rule),
  ].flatMap((rule) => {
    const parsed = parseNativePermissionRule(rule);
    return parsed.kind === "call" && parsed.toolName === WEB_FETCH_TOOL
      ? [parsed.content]
      : [];
  });
}

/** Original lw.checkPermissions (non-artifact path) and sn.checkPermissions (passthrough). */
export function webToolPermission(
  name: WebToolName,
  input: unknown,
  policy: ToolPolicy,
): Decision {
  const whole = (behavior: "allow" | "ask") =>
    matchingToolRule(policy, behavior, name) !== undefined;
  const ask = (byRule: boolean): Decision => ({
    behavior: "ask",
    message: `Claude requested permissions to use ${name}, but you haven't granted it yet.`,
    byRule,
  });
  if (name === WEB_SEARCH_TOOL)
    return whole("ask")
      ? ask(true)
      : whole("allow")
        ? { behavior: "allow" }
        : ask(false);
  const url = webFetchInputSchema.parse(input).url;
  const content = webFetchRuleContent(url);
  const matches = (behavior: "allow" | "deny" | "ask") =>
    domainRules(policy, behavior).some((rule) =>
      matchesDomainRule(rule, content),
    );
  if (matches("deny"))
    return {
      behavior: "deny",
      message: `${WEB_FETCH_TOOL} denied access to ${content}.`,
    };
  if (matches("ask") || whole("ask")) return ask(true);
  if (matches("allow") || whole("allow") || isPreapprovedUrl(url))
    return { behavior: "allow" };
  return ask(false);
}

export interface WebToolsOptions {
  mode(): PermissionMode;
  policy(): ToolPolicy;
  hooks(): ToolHookRuntime | undefined;
  approve(description: string): Promise<boolean>;
  fetch: WebFetchHost;
  search: WebSearchHost;
}

export function createWebTools(options: WebToolsOptions) {
  const webFetch = createWebFetch(options.fetch);
  const enabled = (name: WebToolName) => {
    const policy = options.policy();
    return (
      (policy.tools === undefined || policy.tools.includes(name)) &&
      matchingToolRule(policy, "deny", name) === undefined
    );
  };
  // Advertised whenever enabled; the catalog layer (tool-search.ts) defers both behind ToolSearch.
  const advertised = (name: string) => isWebTool(name) && enabled(name);
  const validate = (name: WebToolName, value: unknown) => {
    if (name === WEB_SEARCH_TOOL) {
      const parsed = webSearchInputSchema.safeParse(value);
      if (!parsed.success)
        throw new ToolInputRejected(z.prettifyError(parsed.error));
      try {
        validateWebSearchInput(parsed.data);
      } catch (error) {
        throw new ToolInputRejected(
          error instanceof Error ? error.message : "WebSearch input rejected",
        );
      }
      return parsed.data;
    }
    const parsed = webFetchInputSchema.safeParse(value);
    if (!parsed.success)
      throw new ToolInputRejected(z.prettifyError(parsed.error));
    return parsed.data;
  };
  async function perform(
    name: WebToolName,
    input: unknown,
    signal: AbortSignal,
  ): Promise<string> {
    if (name === WEB_FETCH_TOOL)
      return (await webFetch.run(webFetchInputSchema.parse(input), signal))
        .result;
    return formatSearchOutput(
      await runWebSearch(
        webSearchInputSchema.parse(input),
        options.search,
        signal,
      ),
    );
  }
  async function execute(
    original: ToolUse,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const name = original.name;
    if (!isWebTool(name)) throw new Error(`Not a web tool: ${name}`);
    const hooks = options.hooks();
    let call: ToolUse = original,
      pre: PreToolHookResult | undefined,
      started = false;
    try {
      signal.throwIfAborted();
      if (!enabled(name))
        throw new ToolPermissionDenied(
          `Tool disabled or denied by policy: ${name}`,
        );
      const unparsed = unparsedToolInput(call.input);
      if (unparsed)
        throw new ToolInputRejected(
          `input JSON failed to parse — ${unparsed.len} bytes`,
        );
      call = { ...call, input: validate(name, call.input) };
      pre = await hooks?.before(call, signal, async (input) =>
        validate(name, input),
      );
      signal.throwIfAborted();
      if (pre?.preventContinuation)
        return appendPreHookContext(
          {
            type: "tool_result",
            tool_use_id: original.id,
            content: pre.stopReason ?? "Tool call stopped by hook",
            is_error: true,
          },
          pre,
          call,
          pre.stopReason ?? "Continuation stopped by hook",
        );
      if (pre?.permission === "deny" || pre?.permission === "defer")
        throw new ToolPermissionDenied(pre.reason ?? "Tool denied by hook");
      if (pre?.updatedInput !== undefined)
        call = { ...call, input: validate(name, pre.updatedInput) };
      const decision = webToolPermission(name, call.input, options.policy());
      if (decision.behavior === "deny")
        throw new ToolPermissionDenied(decision.message);
      const granted =
        pre?.permission !== "ask" &&
        (decision.behavior === "allow" ||
          (!decision.byRule &&
            (options.mode() === "bypassPermissions" ||
              pre?.permission === "allow")));
      if (!granted) {
        const approved = await options
          .approve(describe(name, call.input))
          .catch(() => false);
        signal.throwIfAborted();
        if (!approved)
          throw new ToolPermissionDenied(
            `Claude requested permissions to use ${name}, but you haven't granted it yet.`,
            "pre-ask",
          );
      }
      started = true;
      const content = await perform(name, call.input, signal);
      signal.throwIfAborted();
      started = false;
      const result = appendPreHookContext(
        {
          type: "tool_result",
          tool_use_id: original.id,
          content,
          ...(pre?.updatedInput === undefined
            ? {}
            : { effectiveToolInput: call.input }),
        },
        pre,
        call,
      );
      return hooks ? await hooks.after(call, result, signal) : result;
    } catch (error) {
      signal.throwIfAborted();
      const result = appendPreHookContext(
        {
          type: "tool_result",
          tool_use_id: original.id,
          is_error: true,
          content: error instanceof Error ? error.message : `${name} failed`,
          ...permissionDeniedMarkers(error),
          ...(error instanceof ToolInputRejected
            ? { inputRejected: true }
            : {}),
          ...(pre?.updatedInput === undefined
            ? {}
            : { effectiveToolInput: call.input }),
        },
        pre,
        call,
      );
      return started && hooks?.failure
        ? appendFailureHookContext(
            result,
            await hooks.failure(call, error, signal),
          )
        : result;
    }
  }
  function describe(name: WebToolName, input: unknown): string {
    if (name === WEB_SEARCH_TOOL)
      return `Claude wants to search the web for: ${webSearchInputSchema.parse(input).query}`;
    const host = URL.parse(webFetchInputSchema.parse(input).url)?.hostname;
    return host
      ? `Claude wants to fetch content from ${host}`
      : "Claude wants to fetch content from this URL";
  }
  return {
    wrap(base: ToolExecutor): ToolExecutor {
      return {
        ...base,
        get definitions() {
          return [
            ...base.definitions,
            ...webToolDefinitions().filter((tool) => advertised(tool.name)),
          ];
        },
        execute(call, signal) {
          return isWebTool(call.name)
            ? execute(call, signal)
            : base.execute(call, signal);
        },
      };
    },
    execute,
  };
}
