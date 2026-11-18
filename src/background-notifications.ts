import type { BackgroundAgentCompletion } from "./background-agent-runtime.js";

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** A task report is untrusted child output, retained in its own escaped envelope. */
export function formatBackgroundNotification(
  notification: Readonly<BackgroundAgentCompletion>,
): string {
  const toolUse: [string, string][] =
    notification.toolUseId === undefined
      ? []
      : [["tool-use-id", notification.toolUseId]];
  const fields: [string, string][] = [
    ["task-id", notification.taskId],
    ...toolUse,
    ["output-file", notification.outputFile],
    ["status", notification.status],
    ["summary", notification.description],
  ];
  const report = notification.report;
  if (report)
    fields.push([
      "result",
      report.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    ]);
  if (notification.error) fields.push(["error", notification.error]);
  const usage = notification.usage;
  return `<task-notification>\n${fields.map(([name, value]) => `<${name}>${escape(value)}</${name}>`).join("\n")}${
    usage === undefined
      ? ""
      : `\n<usage><subagent_tokens>${usage.totalTokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`
  }\n</task-notification>`;
}
