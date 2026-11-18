import {
  buildCatalogAttachments,
  type CatalogHistoryAttachment,
  type CatalogProjectionOptions,
} from "./catalog-projection.js";
import { activeContextStart } from "./context-usage.js";
import { prependReminders } from "./context-reminders.js";
import type { Message, ToolExecutor } from "./types.js";
import {
  captureNativeCatalogAttachments,
  type NativeAttachmentCaptureHost,
} from "./native-attachment-capture.js";
import {
  deferredToolsDelta,
  wrapToolSearch,
  type ToolSearchOptions,
} from "./tool-search.js";

/** Catalog records share the lifetime of the corresponding retained user message. */
export function wrapCatalogTools(
  inner: ToolExecutor,
  messages: Message[],
  options: {
    agents():
      | CatalogProjectionOptions["agents"]
      | Promise<CatalogProjectionOptions["agents"]>;
    skills():
      | CatalogProjectionOptions["skills"]
      | Promise<CatalogProjectionOptions["skills"]>;
    skillBudget?: CatalogProjectionOptions["skillBudget"];
    nativeCapture?: NativeAttachmentCaptureHost;
    toolSearch?: ToolSearchOptions;
  },
): ToolExecutor {
  const search = options.toolSearch
    ? wrapToolSearch(inner, messages, options.toolSearch)
    : undefined;
  const base = search ?? inner;
  return {
    get definitions() {
      return base.definitions;
    },
    deferredToolNames: () => search?.deferredNames() ?? [],
    execute: (call, signal) => base.execute(call, signal),
    setReadContext: (context) => base.setReadContext?.(context),
    prepareCompaction: (request) =>
      base.prepareCompaction?.(request) ??
      Promise.resolve({ messages: [], commit() {} }),
    async beforeModelRequest(signal) {
      await base.beforeModelRequest?.(signal);
      signal.throwIfAborted();
      const [agents, skills] = await Promise.all([
        options.agents(),
        options.skills(),
      ]);
      signal.throwIfAborted();
      const history = messages
        .slice(activeContextStart(messages))
        .flatMap((message) => message.catalogAttachments ?? []);
      const deferred =
        search &&
        deferredToolsDelta(
          search.deferredNames(),
          history.flatMap((record) =>
            record.type === "deferred_tools_delta" ? [record] : [],
          ),
        );
      const projection = buildCatalogAttachments({
        agents,
        skills,
        history: history.flatMap((record): CatalogHistoryAttachment[] =>
          record.type === "deferred_tools_delta"
            ? []
            : record.type === "agent_listing_delta"
              ? [record]
              : [
                  {
                    type: record.type,
                    names: record.names,
                    digests: record.digests,
                    isInitial: record.isInitial,
                    ...(record.addsToEarlier === undefined
                      ? {}
                      : { addsToEarlier: record.addsToEarlier }),
                  },
                ],
        ),
        hasAgentTool: base.definitions.some(
          (tool) => tool.name === "Agent" || tool.name === "Task",
        ),
        hasSkillTool: base.definitions.some((tool) => tool.name === "Skill"),
        showConcurrencyNote: true,
        ...(options.skillBudget === undefined
          ? {}
          : { skillBudget: options.skillBudget }),
      });
      if (!projection.blocks.length && !deferred) return;
      let row = messages.at(-1);
      const createdMessage = row?.role !== "user";
      if (row?.role !== "user") {
        row = { role: "user", content: [] };
      }
      if (options.nativeCapture)
        await captureNativeCatalogAttachments(
          options.nativeCapture,
          projection,
          {
            kind: "catalog",
            message: row,
            createdMessage,
          },
        );
      signal.throwIfAborted();
      if (createdMessage) messages.push(row);
      const reminders = [
        ...(deferred
          ? [
              {
                id: "deferred_tools" as const,
                block: { type: "text" as const, text: deferred.text },
              },
            ]
          : []),
        ...projection.blocks.map(({ kind, type, text }) => ({
          id:
            kind === "agent"
              ? ("agent_listing" as const)
              : ("skill_listing" as const),
          block: { type, text },
        })),
      ];
      // Tool results must lead their row; elsewhere the listing joins the turn's leading reminders.
      if (row.content.some((block) => block.type === "tool_result"))
        row.content.push(...reminders.map(({ block }) => block));
      else prependReminders(row, reminders);
      (row.catalogAttachments ??= []).push(
        ...(deferred ? [deferred.attachment] : []),
        ...projection.attachments,
      );
    },
  };
}
