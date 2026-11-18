import assert from "node:assert/strict";
import { test } from "bun:test";
import type { InstructionFile } from "../src/instructions.js";
import {
  captureNativeInstructions,
  nativeInstructionFileFacts,
  type NativeInstructionCaptureHost,
  type NativeInstructionCaptureResult,
  type NativeInstructionPayloadFile,
  type NativeInstructionReason,
} from "../src/native-instruction-capture.js";
import type { Message } from "../src/types.js";

function fixture() {
  const records: NativeInstructionCaptureResult[] = [];
  let previous: readonly NativeInstructionPayloadFile[] | undefined,
    reason: NativeInstructionReason | undefined = "session_start",
    stamps = 0;
  const host: NativeInstructionCaptureHost = {
    state: () => ({ status: "known", previous, reason }),
    trust: () => ({ status: "verified", nativeProjection: "unclipped" }),
    stamp: () => ({
      uuid: `${String(++stamps).padStart(8, "0")}-1111-1111-1111-111111111111`,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    capture: (record) => {
      records.push(record);
    },
  };
  const file: InstructionFile = {
    path: "/owned/CLAUDE.md",
    canonicalPath: "/owned/CLAUDE.md",
    kind: "Project",
    content: "  ADMITTED_COMPLETE_BODY\n",
    contentDiffersFromDisk: true,
    rawContent: "---\npaths: '*.ts'\n---\n  ADMITTED_COMPLETE_BODY\n",
    globs: ["*.ts"],
    isRule: true,
  };
  const message: Message = {
    role: "user",
    content: [{ type: "text", text: "REAL_HUMAN_INPUT" }],
  };
  const facts = () => ({
    phase: "eager" as const,
    files: [
      nativeInstructionFileFacts(file, {
        body: file.content.trim(),
        clipped: false,
        partial: file.contentDiffersFromDisk,
      }),
    ],
  });
  return {
    host,
    file,
    message,
    records,
    facts,
    stamps: () => stamps,
    state: (
      next: readonly NativeInstructionPayloadFile[] | undefined,
      nextReason: NativeInstructionReason | undefined = reason,
    ) => {
      previous = next;
      reason = nextReason;
    },
  };
}
const captured = (record: NativeInstructionCaptureResult | undefined) => {
  assert.ok(record && record.status === "captured");
  return record;
};

test("creation capture preserves full admitted/projected/raw baseline facts before callbacks mutate source objects", async () => {
  const f = fixture();
  f.host.capture = (record, delivery) => {
    assert.equal(delivery.kind, "eager");
    assert.deepEqual(f.message.content, [
      { type: "text", text: "REAL_HUMAN_INPUT" },
    ]);
    f.records.push(record);
    f.file.content = "MUTATED_AFTER_CREATION";
  };
  await captureNativeInstructions(f.host, f.facts(), {
    kind: "eager",
    message: f.message,
  });
  const record = captured(f.records[0]);
  assert.equal(record.currentFiles[0]?.content, "ADMITTED_COMPLETE_BODY");
  assert.equal(
    record.facts.files[0]?.admittedContent,
    "  ADMITTED_COMPLETE_BODY\n",
  );
  assert.match(record.facts.files[0]?.rawDiskText ?? "", /paths:/);
  assert.equal(record.facts.files[0]?.readBaselineCandidate.partial, true);
  assert.match(
    record.facts.files[0]?.readBaselineCandidate.text ?? "",
    /paths:/,
  );
  assert.equal(record.facts.files[0]?.clipped, false);
  assert.equal(record.currentFiles[0]?.unverified, undefined);
  assert.equal(record.currentFiles[0]?.startOnly, undefined);
  assert.equal(record.currentFiles[0]?.cutForRoom, undefined);
  assert.match(
    JSON.stringify(record.event.attachment),
    /ADMITTED_COMPLETE_BODY/,
  );
  assert.equal(JSON.stringify(record.event).includes("MUTATED_AFTER"), false);
  assert.ok(Object.isFrozen(record.facts.files[0]));
  assert.ok(Object.isFrozen(record.currentFiles));
  assert.throws(() => {
    if (record.currentFiles[0])
      record.currentFiles[0].content = "MUST_NOT_CHANGE";
  }, TypeError);
});

test("native updates compare full prior bodies and source reason, and removals remain actual structured deltas", async () => {
  const f = fixture();
  f.state(
    [{ path: f.file.path, type: "Project", content: "PREVIOUS_NATIVE_BODY" }],
    "settings_sync",
  );
  await captureNativeInstructions(f.host, f.facts(), {
    kind: "eager",
    message: f.message,
  });
  const changed = captured(f.records[0]);
  assert.equal(changed.attachment?.type, "instructions");
  assert.match(JSON.stringify(changed.event.attachment), /"changed":true/);
  assert.match(
    JSON.stringify(changed.event.attachment),
    /"reason":"settings_sync"/,
  );
  f.state(changed.currentFiles, "account_change");
  await captureNativeInstructions(
    f.host,
    { phase: "eager", files: [] },
    { kind: "eager", message: f.message },
  );
  const removed = captured(f.records[1]);
  assert.deepEqual(removed.attachment?.removed, [f.file.path]);
  assert.deepEqual(removed.attachment?.files, []);
  assert.equal(removed.attachment?.reason, "account_change");
});

test("native prior state and reason are snapshotted before trust callbacks and are never recovered from display hashes", async () => {
  const f = fixture(),
    prior: NativeInstructionPayloadFile[] = [
      { path: f.file.path, type: "Project", content: "BEFORE_TRUST" },
    ];
  const nativeState: {
    status: "known";
    previous: NativeInstructionPayloadFile[];
    reason: NativeInstructionReason;
  } = { status: "known", previous: prior, reason: "policy_refresh" };
  f.host.state = () => nativeState;
  f.host.trust = () => {
    const first = nativeState.previous[0];
    assert.ok(first);
    first.content = f.file.content.trim();
    nativeState.reason = "hooks_invalidate";
    return { status: "verified", nativeProjection: "unclipped" };
  };
  await captureNativeInstructions(f.host, f.facts(), {
    kind: "eager",
    message: f.message,
  });
  const record = captured(f.records[0]);
  assert.equal(record.attachment?.changed, true);
  assert.equal(record.attachment?.reason, "policy_refresh");
});

test("unchanged and empty initial source states allocate no event identity, while a known empty prior map is an update", async () => {
  const f = fixture();
  await captureNativeInstructions(
    f.host,
    { phase: "eager", files: [] },
    { kind: "eager", message: f.message },
  );
  assert.equal(f.records[0]?.status, "unchanged");
  assert.equal(f.stamps(), 0);
  f.state([], "session_start");
  await captureNativeInstructions(f.host, f.facts(), {
    kind: "eager",
    message: f.message,
  });
  const record = captured(f.records[1]);
  assert.equal(record.attachment?.changed, true);
  f.state(record.currentFiles);
  await captureNativeInstructions(f.host, f.facts(), {
    kind: "eager",
    message: f.message,
  });
  assert.equal(f.records[2]?.status, "unchanged");
  assert.equal(f.stamps(), 1);
});

test("unknown trust/native projection or port clipping produces explicit unsupported facts without a fabricated attachment", async () => {
  const f = fixture();
  f.host.trust = () => ({
    status: "unsupported",
    reason: "NATIVE_MANAGED_TRUST_UNKNOWN",
  });
  await captureNativeInstructions(f.host, f.facts(), {
    kind: "eager",
    message: f.message,
  });
  const trust = f.records[0];
  assert.equal(trust?.status, "unsupported");
  if (trust?.status === "unsupported")
    assert.deepEqual(trust.reasons, ["NATIVE_MANAGED_TRUST_UNKNOWN"]);
  const clipped = nativeInstructionFileFacts(f.file, {
    body: "PORT_TRUNCATION_NOTICE",
    clipped: true,
    partial: true,
  });
  await captureNativeInstructions(
    f.host,
    { phase: "eager", files: [clipped] },
    { kind: "eager", message: f.message },
  );
  assert.equal(f.records[1]?.status, "unsupported");
  assert.equal(f.stamps(), 0);
});

test("nested activation keeps complete structured facts and cannot pretend its port notice is a native nested-memory event", async () => {
  const f = fixture();
  let stateCalled = false;
  f.host.state = () => {
    stateCalled = true;
    return {
      status: "unsupported",
      reason: "MUST_NOT_CLASSIFY_NESTED_AS_EAGER",
    };
  };
  const request = f.facts();
  await captureNativeInstructions(
    f.host,
    { ...request, phase: "nested" },
    {
      kind: "nested",
      call: {
        type: "tool_use",
        id: "owned-read",
        name: "Read",
        input: { file_path: "src/a.ts" },
      },
      result: {
        type: "tool_result",
        tool_use_id: "owned-read",
        content: "RAW_TOOL_RESULT",
      },
      effectivePath: "/owned/src/a.ts",
    },
  );
  const record = f.records[0];
  assert.equal(record?.status, "unsupported");
  assert.equal(record?.facts.files[0]?.admittedContent, f.file.content);
  if (record?.status === "unsupported")
    assert.match(record.reasons[0] ?? "", /nested_memory/);
  assert.equal(stateCalled, false);
  assert.equal(f.stamps(), 0);
});
