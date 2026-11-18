import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  selectNativeStartupRows,
  normalizeNativeStartupSignature,
  nativeSessionStartSignatures,
  type NativeStartupSelectionHost,
} from "../../src/native-startup-selection.js";
import {
  createNativeAttachmentEvent,
  renderNativePersistenceAttachment,
} from "../../src/native-persistence-events.js";
import { validateNativeHookProgressRow } from "../../src/native-hook-progress.js";
import { NativeRetainedMemoryOwner } from "../../src/native-retained-memory.js";
import {
  isNativeArray,
  isNativeObject,
  type NativeObject,
} from "../../src/native-session-codec.js";

const signal = () => new AbortController().signal;
function fixture() {
  let serial = 0;
  const stamp = () => ({
    uuid: `00000000-1111-1111-1111-${String(++serial).padStart(12, "0")}`,
    timestamp: "2026-11-18T00:00:00Z",
  });
  const context = (content: string[]) =>
    createNativeAttachmentEvent(
      {
        type: "hook_additional_context",
        hookName: "SessionStart",
        hookEvent: "SessionStart",
        toolUseID: "SessionStart",
        content,
      },
      stamp(),
    );
  const success = (content: string) =>
    createNativeAttachmentEvent(
      {
        type: "hook_success",
        hookName: "SessionStart:resume",
        hookEvent: "SessionStart",
        toolUseID: "ACTUAL_START",
        content,
        stdout: "",
      },
      stamp(),
    );
  const progress = () =>
    validateNativeHookProgressRow({
      type: "progress",
      ...stamp(),
      data: {
        type: "hook_progress",
        hookEvent: "SessionStart",
        hookName: "SessionStart:startup",
        command: "owned-start",
      },
      parentToolUseID: "ACTUAL_START",
      toolUseID: "ACTUAL_START",
    });
  let renders = 0;
  const host: NativeStartupSelectionHost = {
    render: ({ original, attachment }) => {
      renders++;
      assert.ok(Object.isFrozen(original) && Object.isFrozen(attachment));
      return {
        status: "known",
        value: {
          rendered: [...renderNativePersistenceAttachment(attachment)],
          renderedRole: "system",
        },
      };
    },
  };
  return { context, success, progress, host, renders: () => renders, stamp };
}
function content(row: NativeObject): readonly unknown[] {
  assert.ok(isNativeObject(row.attachment));
  assert.ok(isNativeArray(row.attachment.content));
  return row.attachment.content;
}

test("empty startup returns before signature work; absent old signatures preserve the entire actual new vector", () => {
  const f = fixture(),
    progress = f.progress(),
    a = f.context(["SAME", "SAME"]),
    b = f.success("SAME");
  assert.deepEqual(
    selectNativeStartupRows({
      existing: [{ type: "attachment" }],
      created: [],
    }),
    {
      status: "selected",
      reason: "empty-new-vector",
      rows: [],
      existingSignatureCount: 0,
      rewrites: [],
    },
  );
  const selected = selectNativeStartupRows(
    { existing: [progress], created: [progress, a, b] },
    f.host,
  );
  assert.equal(selected.status, "selected");
  if (selected.status !== "selected") assert.fail();
  assert.equal(selected.reason, "no-existing-signatures");
  assert.deepEqual(selected.rows, [progress, a, b]);
  assert.equal(f.renders(), 0);
});

test("an old startup signature with no meaningful new signature discards every new row, including progress", () => {
  const f = fixture(),
    old = f.context(["OLD"]),
    progress = f.progress(),
    duplicate = f.success("OLD");
  const selected = selectNativeStartupRows(
    {
      existing: [old],
      created: [
        progress,
        duplicate,
        {
          type: "system",
          ...f.stamp(),
          subtype: "informational",
          level: "warning",
          content: "ACTUAL_NONSIGNATURE",
        },
      ],
    },
    f.host,
  );
  assert.equal(selected.status, "selected");
  if (selected.status !== "selected") assert.fail();
  assert.equal(selected.reason, "no-new-signature");
  assert.deepEqual(selected.rows, []);
  assert.equal(f.renders(), 0);
});

test("native signature Set contains only prior history, so duplicate new strings stay in source order", () => {
  const f = fixture(),
    old = f.context(["OLD"]),
    p = f.progress(),
    a = f.context(["NEW", "NEW"]),
    b = f.success("NEW"),
    dropped = f.context(["OLD"]);
  const selected = selectNativeStartupRows(
    { existing: [old], created: [p, a, dropped, b] },
    f.host,
  );
  assert.equal(selected.status, "selected");
  if (selected.status !== "selected") assert.fail();
  assert.deepEqual(selected.rows, [p, a, b]);
  assert.equal(f.renders(), 0);
});

test("Aue partial context selection replaces all old render fields without changing creation identity or unrelated raw data", () => {
  const f = fixture(),
    original = {
      ...f.context(["OLD", "NEW"]),
      renderedInHumanTurn: [{ content: "STALE_HUMAN" }],
      renderedWithdrawn: [{ content: "STALE_WITHDRAWN" }],
      renderedBesideToolResult: true,
      rawExtra: { exact: [1, "value"] },
      parentUuid: "ACTUAL_PRIOR_PARENT",
      sessionId: "ACTUAL_IMPORTED_OWNER",
    };
  const before = JSON.stringify(original),
    p = f.progress();
  const selected = selectNativeStartupRows(
    { existing: [f.success("OLD")], created: [p, original] },
    f.host,
  );
  assert.equal(selected.status, "selected");
  if (selected.status !== "selected") assert.fail();
  assert.equal(selected.rewrites.length, 1);
  assert.equal(f.renders(), 1);
  const row = selected.rows[1];
  assert.ok(row);
  assert.deepEqual(content(row), ["NEW"]);
  assert.equal(row.uuid, original.uuid);
  assert.equal(row.timestamp, original.timestamp);
  assert.equal(row.parentUuid, original.parentUuid);
  assert.equal(row.sessionId, original.sessionId);
  assert.deepEqual(row.rawExtra, original.rawExtra);
  assert.equal(Object.hasOwn(row, "renderedInHumanTurn"), false);
  assert.equal(Object.hasOwn(row, "renderedWithdrawn"), false);
  assert.equal(Object.hasOwn(row, "renderedBesideToolResult"), false);
  assert.match(JSON.stringify(row.rendered), /NEW/);
  assert.doesNotMatch(JSON.stringify(row.rendered), /OLD|STALE/);
  assert.equal(JSON.stringify(original), before);
  assert.ok(Object.isFrozen(row));
  assert.deepEqual(selected.rewrites[0]?.original, original);
  assert.deepEqual(selected.rewrites[0]?.selected, row);
});

test("actual empty amn fields remove stale rendering without filling a new role or rendered body", () => {
  const f = fixture(),
    original = f.context(["OLD", "NEW"]);
  const selected = selectNativeStartupRows(
    { existing: [f.context(["OLD"])], created: [original] },
    { render: () => ({ status: "known", value: {} }) },
  );
  assert.equal(selected.status, "selected");
  if (selected.status !== "selected") assert.fail();
  const row = selected.rows[0];
  assert.ok(row);
  assert.deepEqual(content(row), ["NEW"]);
  assert.equal(Object.hasOwn(row, "rendered"), false);
  assert.equal(Object.hasOwn(row, "renderedRole"), false);
});

test("missing/unsupported renderer returns full immutable unpublished input rather than guessing a changed context", () => {
  const f = fixture(),
    existing = [f.context(["OLD"])],
    created = [f.progress(), f.context(["OLD", "NEW"])];
  for (const host of [
    undefined,
    {
      render: () => ({
        status: "unsupported" as const,
        reason: "ACTUAL_AMN_OWNER_UNAVAILABLE",
      }),
    },
    {
      render: () => ({
        status: "known" as const,
        value: { uuid: "FORGED_OWNER" },
      }),
    },
  ]) {
    const result = selectNativeStartupRows({ existing, created }, host);
    assert.equal(result.status, "unsupported");
    if (result.status !== "unsupported") assert.fail();
    assert.deepEqual(result.existing, existing);
    assert.deepEqual(result.created, created);
    assert.ok(Object.isFrozen(result.created));
  }
  const error = new Error("ACTUAL_RENDER_OWNER_FAILURE");
  assert.throws(
    () =>
      selectNativeStartupRows(
        { existing, created },
        {
          render: () => {
            throw error;
          },
        },
      ),
    (value) => value === error,
  );
});

test("native persisted-output signature normalization is prefix- and line-specific and never changes retained text", () => {
  const f = fixture(),
    a =
      "<persisted-output>\nFull output saved to: /first/output\nBODY\n</persisted-output>",
    b =
      "<persisted-output>\nFull output saved to: /second/output\nBODY\n</persisted-output>";
  assert.equal(
    normalizeNativeStartupSignature(a),
    normalizeNativeStartupSignature(b),
  );
  assert.equal(normalizeNativeStartupSignature(" " + a), " " + a);
  assert.equal(
    normalizeNativeStartupSignature("ordinary saved to: /first"),
    "ordinary saved to: /first",
  );
  const meaningful = f.success("ANOTHER");
  const selected = selectNativeStartupRows({
    existing: [f.success(a)],
    created: [f.success(b), meaningful],
  });
  assert.equal(selected.status, "selected");
  if (selected.status !== "selected") assert.fail();
  assert.deepEqual(selected.rows, [meaningful]);
  assert.equal(
    normalizeNativeStartupSignature(
      "<persisted-output>saved to: /first\nsaved to: /second",
    ),
    "<persisted-output>saved to: <persisted>\nsaved to: /second",
  );
});

test("error signatures preserve native command/exit/stderr tuple and ignore stdout or hook naming", () => {
  const f = fixture();
  const make = (extra: NativeObject): NativeObject => ({
    type: "attachment",
    ...f.stamp(),
    attachment: {
      type: "hook_non_blocking_error",
      hookEvent: "SessionStart",
      command: "COMMAND",
      stderr: "EXACT_STDERR",
      ...extra,
    },
  });
  const a = make({ stdout: "FIRST", hookName: "SessionStart:startup" }),
    b = make({ stdout: "SECOND", hookName: "SessionStart:resume" });
  assert.deepEqual(nativeSessionStartSignatures(a), [
    "COMMAND\x00undefined\x00EXACT_STDERR",
  ]);
  assert.deepEqual(
    nativeSessionStartSignatures(a),
    nativeSessionStartSignatures(b),
  );
  assert.notDeepEqual(
    nativeSessionStartSignatures(a),
    nativeSessionStartSignatures(make({ exitCode: null })),
  );
  assert.deepEqual(nativeSessionStartSignatures(make({ command: null })), [
    "\x00undefined\x00EXACT_STDERR",
  ]);
  assert.ok(isNativeObject(a.attachment));
  assert.deepEqual(
    nativeSessionStartSignatures({
      ...a,
      attachment: { ...a.attachment, hookEvent: "Stop" },
    }),
    [],
  );
});

test("finalized memory receives the transformed startup vector once, with no transcript or same-UUID replacement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tau-startup-final-owner-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const f = fixture(),
    old = f.context(["OLD"]),
    created = [f.progress(), f.context(["OLD", "NEW"])];
  const selected = selectNativeStartupRows(
    { existing: [old], created },
    f.host,
  );
  assert.equal(selected.status, "selected");
  if (selected.status !== "selected") assert.fail();
  const expected = new Map(
    [old, ...selected.rows].map((row) => [row.uuid, row]),
  );
  const owner = NativeRetainedMemoryOwner.open(
    { sessionId: "ACTUAL_SOURCE_SESSION" },
    {
      admitProducer: () => true,
      admitRetention: ({ rows }) => {
        for (const row of rows) assert.deepEqual(row, expected.get(row.uuid));
        return true;
      },
    },
  );
  onTestFinished(() => owner.close().catch(() => {}));
  const producer = await owner.admitProducer(
    { name: "actual-startup-final-owner", kinds: ["attachment", "progress"] },
    signal(),
  );
  await owner.retain(producer, [old], { signal: signal() });
  await owner.retain(producer, selected.rows, { signal: signal() });
  const view = await owner.flush(signal());
  assert.equal(view.entries.length, 3);
  assert.equal(new Set(view.entries.map((e) => e.row.uuid)).size, 3);
  const last = view.entries.at(-1);
  assert.ok(last);
  assert.deepEqual(content(last.row), ["NEW"]);
  assert.deepEqual(content(created[1] ?? {}), ["OLD", "NEW"]);
  assert.deepEqual(await readdir(cwd), []);
  await owner.close();
  assert.deepEqual(await readdir(cwd), []);
});
