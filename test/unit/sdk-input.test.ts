import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseOptions, printProtocolFlagError } from "../../src/options.js";
import {
  parseSdkInputLine,
  SdkInputFatal,
  sdkUserTurns,
} from "../../src/sdk-input.js";

test("user lines become text turns; blank, keep_alive, control and non-object lines are skipped", () => {
  assert.deepEqual(
    parseSdkInputLine(
      '{"type":"user","message":{"role":"user","content":"hi"}}',
    ),
    { content: [{ type: "text", text: "hi" }] },
  );
  assert.deepEqual(
    parseSdkInputLine(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"a"}]}}',
    ),
    { content: [{ type: "text", text: "a" }] },
  );
  for (const line of [
    "   ",
    '{"type":"keep_alive"}',
    '{"type":"control_request","request":{"subtype":"interrupt"}}',
    "[1]",
    "5",
    '{"message":{}}',
  ])
    assert.equal(parseSdkInputLine(line), undefined, line);
});

test("malformed lines are fatal with the original's diagnostics", () => {
  const fatal = (line: string) => {
    try {
      parseSdkInputLine(line);
    } catch (error) {
      assert.ok(error instanceof SdkInputFatal);
      return error.message;
    }
    assert.fail(`${line} was accepted`);
  };
  assert.equal(
    fatal("{oops"),
    "Error parsing streaming input line (type=unknown, 5 chars): SyntaxError",
  );
  assert.equal(
    fatal("null"),
    "Error parsing streaming input line (type=unknown, 4 chars): TypeError",
  );
  assert.equal(
    fatal('{"type":"user"}'),
    "Error: Expected message role 'user', got 'undefined'",
  );
  assert.equal(
    fatal('{"type":"user","message":null}'),
    "Error: Expected message role 'user', got 'undefined'",
  );
  assert.equal(
    fatal(
      '{"type":"user","message":{"role":"user","content":[{"type":"image"}]}}',
    ),
    "Error: tau stream-json input accepts string or text-block user content only",
  );
});

async function* chunks(...values: string[]) {
  for (const value of values) yield value;
}

test("sdkUserTurns reads split, unterminated and over-budget input", async () => {
  const turns = [];
  for await (const turn of sdkUserTurns(
    chunks(
      '{"type":"user","message":{"role":"user",',
      '"content":"one"}}\n{"type":"keep_alive"}\n',
      '{"type":"user","message":{"role":"user","content":"two"}}',
    ),
  ))
    turns.push(turn);
  assert.deepEqual(turns, [
    { content: [{ type: "text", text: "one" }] },
    { content: [{ type: "text", text: "two" }] },
  ]);
  await assert.rejects(
    (async () => {
      for await (const _ of sdkUserTurns(chunks("{not json}\n")));
    })(),
    SdkInputFatal,
  );
});

test("printProtocolFlagError applies the original's flag rules in order", () => {
  const error = (args: string[], interactive = false) =>
    printProtocolFlagError(parseOptions(["-p", ...args]), interactive);
  const uuid = "6f1c2c1e-1b7e-4d8e-9f61-0d1c1c1c1c1c";
  assert.equal(error([]), undefined);
  assert.equal(
    error(["--input-format", "stream-json", "--output-format", "stream-json"]),
    undefined,
  );
  assert.equal(
    error(
      ["--input-format", "stream-json", "--output-format", "stream-json"],
      true,
    ),
    "Error: --input-format=stream-json requires --print.",
  );
  assert.equal(
    error(
      ["--include-partial-messages", "--output-format", "stream-json"],
      true,
    ),
    "Error: --include-partial-messages requires --print and --output-format=stream-json.",
  );
  assert.equal(error(["--session-id", uuid]), undefined);
  assert.equal(
    error(["--session-id", uuid, "--resume", uuid]),
    "Error: --session-id with --continue or --resume also needs --fork-session.",
  );
});
