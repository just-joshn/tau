import assert from "node:assert/strict";
import { test } from "node:test";
import {
  provisionalRows,
  replaceProvisional,
  terminalText,
} from "../src/terminal.js";

test("provisional rollback counts terminal cells, graphemes and delayed line wrapping", () => {
  for (const [text, columns, expected] of [
    ["123456789012", 12, 0],
    ["123456789012X", 12, 1],
    ["1234567890🌍X", 12, 1],
    ["12345678901🌍", 12, 1],
    ["12345678901e\u0301", 12, 0],
    ["12345678901👩‍💻", 12, 1],
    ["1234567890古X", 12, 1],
    ["123456789012\nX", 12, 1],
    ["\n\n", 12, 2],
    ["1234567890🇬🇧X", 12, 1],
    ["a\tb", 12, 0],
    ["a\tb", 8, 0],
    ["\x1b[31m古\x1b[0m", 2, 0],
  ] as const)
    assert.equal(
      provisionalRows(text, columns),
      expected,
      JSON.stringify(text),
    );
  assert.equal(
    replaceProvisional("1234567890🌍X", "clean", 12),
    "\r\x1b[1A\x1b[Jclean",
  );
});

test("model text cannot inject terminal cursor or OSC sequences through a reset", () => {
  assert.equal(
    terminalText("hello\x1b[2J\x1b]0;bad\x07world\x00\r"),
    "helloworld",
  );
  assert.equal(replaceProvisional("old", "\x1b[2Jnew", 80), "\r\x1b[Jnew");
});
