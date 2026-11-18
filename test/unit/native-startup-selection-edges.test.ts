import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  nativeSessionStartSignatures,
  selectNativeStartupRows,
  type NativeStartupRendering,
  type NativeStartupSelectionHost,
} from "../../src/native-startup-selection.js";
import type { NativeObject } from "../../src/native-session-codec.js";

let serial = 0;
const row = (attachment: NativeObject, identity = true): NativeObject => ({
  type: "attachment",
  ...(identity
    ? {
        uuid: `00000000-6666-6666-6666-${String(++serial).padStart(12, "0")}`,
        timestamp: "2026-11-18T00:00:00Z",
      }
    : {}),
  attachment,
});
const context = (content: NativeObject["content"]) =>
  row({
    type: "hook_additional_context",
    hookEvent: "SessionStart",
    content,
  });
const failure = (exitCode: NativeObject["exitCode"]) =>
  row({
    type: "hook_non_blocking_error",
    hookEvent: "SessionStart",
    command: "edge",
    exitCode,
    stderr: "EDGE",
  });
const renderer = (
  value: NativeStartupRendering,
): NativeStartupSelectionHost => ({
  render: () => ({ status: "known", value }),
});
function unsupported(
  input: { existing: NativeObject[]; created: NativeObject[] },
  host?: NativeStartupSelectionHost,
) {
  const result = selectNativeStartupRows(input, host);
  assert.equal(result.status, "unsupported");
  return result.status === "unsupported" ? result.reason : "";
}

test("error signatures accept primitive exit codes and refuse structured ones", () => {
  assert.deepEqual(nativeSessionStartSignatures(failure("2")), [
    "edge\x002\x00EDGE",
  ]);
  assert.deepEqual(nativeSessionStartSignatures(failure(true)), [
    "edge\x00true\x00EDGE",
  ]);
  const old = failure(false);
  assert.match(
    unsupported({ existing: [old], created: [failure({ code: 2 })] }),
    /primitive exit code/,
  );
});

test("startup attachments of other kinds have no signature", () => {
  assert.deepEqual(
    nativeSessionStartSignatures(
      row({ type: "hook_cancelled", hookEvent: "SessionStart" }),
    ),
    [],
  );
});

test("malformed startup history is reported as unsupported with the inputs intact", () => {
  const created = [context(["NEW"])];
  for (const [existing, reason] of [
    [{ type: "attachment", attachment: "EDGE" }, /lacks its actual payload/],
    [context("NOT_A_VECTOR"), /actual content vector/],
    [
      row({ type: "hook_success", hookEvent: "SessionStart", content: 7 }),
      /actual source string/,
    ],
  ] as const) {
    const result = selectNativeStartupRows({ existing: [existing], created });
    assert.equal(result.status, "unsupported");
    if (result.status !== "unsupported") continue;
    assert.match(result.reason, reason);
    assert.deepEqual(result.existing, [existing]);
    assert.deepEqual(result.created, created);
  }
});

test("a partial context rewrite needs the original creation identity", () => {
  const old = context(["OLD"]);
  const anonymous = row(
    {
      type: "hook_additional_context",
      hookEvent: "SessionStart",
      content: ["OLD", "NEW"],
    },
    false,
  );
  assert.match(
    unsupported(
      { existing: [old], created: [anonymous] },
      renderer({ rendered: [{ content: "NEW" }] }),
    ),
    /original creation identity/,
  );
});

/** The renderer is an external host. These cases model one that ignores its declared result type. */
function fromUntypedHost(value: NativeObject): value is NativeStartupRendering {
  return typeof value === "object";
}

test("a renderer may return text-part blocks but not a foreign role, flag or block shape", () => {
  const select = (value: NativeStartupRendering) =>
    selectNativeStartupRows(
      { existing: [context(["OLD"])], created: [context(["OLD", "NEW"])] },
      renderer(value),
    );
  const parts = select({
    rendered: [{ content: [{ type: "text", text: "NEW" }] }],
    renderedRole: "user",
    renderedBesideToolResult: false,
  });
  assert.ok(parts.status === "selected");
  assert.deepEqual(parts.rows[0]?.rendered, [
    { content: [{ type: "text", text: "NEW" }] },
  ]);
  assert.equal(parts.rows[0]?.renderedRole, "user");
  const cases: [NativeObject, RegExp][] = [
    [{ renderedRole: "assistant" }, /invalid recorded role/],
    [{ renderedBesideToolResult: "yes" }, /invalid beside-result flag/],
    [{ rendered: [{ content: [{ type: "image" }] }] }, /invalid recorded text/],
    [{ renderedWithdrawn: "NEW" }, /invalid recorded text/],
  ];
  for (const [value, reason] of cases) {
    if (!fromUntypedHost(value)) continue;
    const result = select(value);
    assert.ok(result.status === "unsupported");
    assert.match(result.reason, reason);
  }
});
