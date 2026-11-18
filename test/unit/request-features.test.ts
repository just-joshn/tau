import assert from "node:assert/strict";
import { test } from "bun:test";
import { sessionThinkingDisplay } from "../../src/request-features.js";

test("the session display follows the original's output mode rule", () => {
  const print = { interactive: false, verbose: false };
  assert.equal(sessionThinkingDisplay({ ...print, format: "text" }), "omitted");
  assert.equal(sessionThinkingDisplay({ ...print, format: "json" }), "omitted");
  assert.equal(
    sessionThinkingDisplay({ ...print, format: "json", verbose: true }),
    undefined,
  );
  assert.equal(
    sessionThinkingDisplay({ ...print, format: "stream-json", verbose: true }),
    undefined,
  );
  assert.equal(
    sessionThinkingDisplay({
      interactive: true,
      format: "text",
      verbose: false,
      showThinkingSummaries: true,
    }),
    "summarized",
  );
  assert.equal(
    sessionThinkingDisplay({
      interactive: true,
      format: "text",
      verbose: false,
    }),
    undefined,
  );
});
