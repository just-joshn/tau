import {
  buildCatalogAttachments,
  type CatalogProjectionOptions,
} from "./catalog-projection.js";
import { activeContextStart } from "./context-usage.js";
import type { Message, ToolExecutor } from "./types.js";
import {
  captureNativeCatalogAttachments,
  type NativeAttachmentCaptureHost,
} from "./native-attachment-capture.js";

/** Catalog records share the lifetime of the corresponding retained user message. */
export function wrapCatalogTools(
  base: ToolExecutor,
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
  },
): ToolExecutor {
  return {
    get definitions() {
      return base.definitions;
    },
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
      const projection = buildCatalogAttachments({
        agents,
        skills,
        history: messages
          .slice(activeContextStart(messages))
          .flatMap((message) => message.catalogAttachments ?? [])
          .map((record) =>
            record.type === "agent_listing_delta"
              ? record
              : {
                  type: record.type,
                  names: record.names,
                  digests: record.digests,
                  isInitial: record.isInitial,
                  ...(record.addsToEarlier === undefined
                    ? {}
                    : { addsToEarlier: record.addsToEarlier }),
                },
          ),
        hasAgentTool: base.definitions.some(
          (tool) => tool.name === "Agent" || tool.name === "Task",
        ),
        hasSkillTool: base.definitions.some((tool) => tool.name === "Skill"),
        ...(options.skillBudget === undefined
          ? {}
          : { skillBudget: options.skillBudget }),
      });
      if (!projection.blocks.length) return;
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
      row.content.push(
        ...projection.blocks.map(({ type, text }) => ({ type, text })),
      );
      (row.catalogAttachments ??= []).push(...projection.attachments);
    },
  };
}
