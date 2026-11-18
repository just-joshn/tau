import assert from "node:assert/strict";
import { test } from "bun:test";
import { terminalText } from "../../src/terminal.js";

test("model text cannot inject terminal cursor or OSC sequences", () => {
  assert.equal(
    terminalText("hello\x1b[2J\x1b]0;bad\x07world\x00\r"),
    "helloworld",
  );
});
