import assert from "node:assert/strict";
import { test } from "bun:test";
import { formatBackgroundNotification } from "../../src/background-notifications.js";

test("a failed task notification carries its tool use id and escaped error", () => {
  const text = formatBackgroundNotification({
    taskId: "task-1",
    toolUseId: "toolu_1",
    description: "Survey <src>",
    status: "failed",
    outputFile: "/tmp/task-1.output",
    error: "boom & <stop>",
  });
  assert.equal(
    text,
    [
      "<task-notification>",
      "<task-id>task-1</task-id>",
      "<tool-use-id>toolu_1</tool-use-id>",
      "<output-file>/tmp/task-1.output</output-file>",
      "<status>failed</status>",
      "<summary>Survey &lt;src&gt;</summary>",
      "<error>boom &amp; &lt;stop&gt;</error>",
      "</task-notification>",
    ].join("\n"),
  );
});

test("a killed task notification without a tool use id or error lists only its core fields", () => {
  assert.equal(
    formatBackgroundNotification({
      taskId: "task-2",
      description: "Summarise",
      status: "killed",
      outputFile: "/tmp/task-2.output",
    }),
    [
      "<task-notification>",
      "<task-id>task-2</task-id>",
      "<output-file>/tmp/task-2.output</output-file>",
      "<status>killed</status>",
      "<summary>Summarise</summary>",
      "</task-notification>",
    ].join("\n"),
  );
});
