import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { NativeSessionLifetime } from "../../src/native-session-lifetime.js";
import { type NativeJournalRequestOptions } from "../../src/native-session-journal.js";
import { createNativeContextClassifiers } from "../../src/native-context-classifiers.js";
import {
  createNativeLifecycleAttachment,
  createNativeLifecycleConsumer,
} from "../../src/native-lifecycle-hooks.js";
import { recordNativeJsonResponse } from "../../src/native-response-recording.js";
import {
  decodeNativeSession,
  encodeNativeSessionRows,
  indexNativeSession,
  isNativeObject,
} from "../../src/native-session-codec.js";
import { reconstructNativeHistory } from "../../src/native-history-projection.js";
import { projectNativeOwnedToolRequestContext } from "../../src/native-tool-context.js";

const SID = "11111111-1111-1111-1111-111111111111";
const MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
const profile = (): NativeJournalRequestOptions => ({
  requestedModel: MODEL,
  recovery: {
    callIdToolResults: true,
    descendantOrder: "depth-first",
    timestampFallback: "reject",
  },
  host: {
    systemTurns: false,
    reminderFold: false,
    withoutAttachmentHooks: true,
    admit: () => true,
  },
  classifiers: createNativeContextClassifiers({
    systemTurns: false,
    pollEventsEnabled: false,
  }),
  echoApiBlockOrder: false,
  preserveTrailingThinking: false,
  signal: signal(),
});

async function fixture(restoredUserText?: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-query-frame-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, `${SID}.jsonl`);
  let identities = 0;
  const lifetime = await NativeSessionLifetime.open(
    {
      ownership: { directory: root, path, admit: () => true },
      persistence: {
        context: {
          sessionId: SID,
          cwd: root,
          version: "2.1.326",
          userType: "external",
          sidechain: false,
        },
        admit: () => true,
      },
      initial: { kind: "fresh" },
      host: {
        stamp: () => ({
          uuid: `00000000-1111-1111-1111-${String(++identities).padStart(12, "0")}`,
          timestamp: "2026-11-18T00:00:00Z",
        }),
        persistence: {
          freshHead: {
            status: "known",
            value: "ordinary-unchanged-owner-without-attachment-rewrites",
          },
          select: ({ history }) => ({
            facts: {
              userType: { status: "known", value: "external" },
              evalFeature: { status: "known", value: false },
              sessionCodeMode: { status: "known", value: false },
              toolResults: { kind: "derive", context: history },
            },
            host: {
              original: (row) => ({
                status: "known",
                value:
                  row.type === "user" &&
                  restoredUserText &&
                  isNativeObject(row.message)
                    ? {
                        ...row,
                        message: {
                          ...row.message,
                          content: [{ type: "text", text: restoredUserText }],
                        },
                      }
                    : undefined,
              }),
            },
          }),
        },
      },
    },
    signal(),
  );
  onTestFinished(() => lifetime.close(signal()).catch(() => {}));
  const journal = lifetime.journal;
  await journal.recordUser(
    { role: "user", content: [{ type: "text", text: "ACTUAL_HUMAN" }] },
    "ACTUAL_PROMPT",
    signal(),
  );
  const response = async (text: string) => {
    const recording = recordNativeJsonResponse(
      { requestedModel: MODEL, host: journal.responseHost },
      {
        id: `actual-api-${identities}`,
        role: "assistant",
        type: "message",
        model: MODEL,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 },
        content: [{ type: "text", text }],
      },
      [{ type: "text", text }],
    );
    assert.equal(recording.status, "complete");
    if (recording.status !== "complete") assert.fail();
    const row = recording.rows[0];
    assert.ok(row);
    await journal.recordResponse(recording, signal());
    return row;
  };
  const blocking = async () => {
    const host = journal.lifecycleHost(signal());
    const cause = {
      event: "Stop" as const,
      dispatchToolUseID: "ACTUAL_STOP",
      branch: "actual-owned-block",
    };
    const diagnostic = createNativeLifecycleAttachment(
      host,
      {
        type: "hook_blocking_error",
        hookName: "Stop",
        hookEvent: "Stop",
        toolUseID: "ACTUAL_STOP",
        blockingError: {
          blockingError: "ACTUAL_BLOCK_REASON",
          command: "owned-hook",
        },
      },
      cause,
    );
    const consumer = createNativeLifecycleConsumer(
      { event: "Stop", dispatchToolUseID: "ACTUAL_STOP", phase: "ordinary" },
      host,
    );
    await consumer.consume({
      kind: "blocking",
      text: "ACTUAL_BLOCK_REASON",
      command: "owned-hook",
      cause,
    });
    await consumer.consume({
      kind: "message",
      creation: diagnostic,
      retainForStop: false,
    });
    return {
      diagnostic,
      decision: await consumer.finish({ kind: "completed" }),
    };
  };
  return { root, path, journal, lifetime, response, blocking };
}

test("query membership precedes rendering while every physical parent remains unchanged", async () => {
  const f = await fixture();
  const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
  assert.ok(Object.isFrozen(frame));
  await f.response("ACTUAL_FIRST");
  await f.journal.beginLifecycleTransition(frame, signal());
  const { diagnostic, decision } = await f.blocking();
  const prefix = await readFile(f.path);
  await f.journal.assertLifecycleCommitted(decision, signal(), frame);
  await f.journal.commitLifecycleTransition(frame, decision, signal());
  const result = await f.journal.projectRequest({ ...profile(), frame });
  assert.equal(result.queryFrame?.uuids.includes(diagnostic.event.uuid), false);
  assert.deepEqual(result.projection.parentRewrites, []);
  assert.doesNotMatch(
    JSON.stringify(result.projection.messages),
    /hook blocking error from command/,
  );
  const physical = result.originalDocument.lines.find(
    (line) =>
      isNativeObject(line.value) && line.value.uuid === diagnostic.event.uuid,
  )?.value;
  assert.ok(isNativeObject(physical));
  assert.ok(typeof physical.parentUuid === "string");
  assert.ok(result.queryFrame?.uuids.includes(physical.parentUuid));
  await f.response("ACTUAL_SECOND");
  const second = (
    await f.journal.readCommitted(signal())
  ).document.lines.findLast(
    (line) => isNativeObject(line.value) && line.value.type === "assistant",
  )?.value;
  assert.ok(isNativeObject(second));
  assert.equal(second.parentUuid, diagnostic.event.uuid);
  assert.deepEqual((await readFile(f.path)).subarray(0, prefix.length), prefix);
  f.journal.endQueryFrame(frame);
  await f.journal.recordUser(
    { role: "user", content: [{ type: "text", text: "NEXT_HUMAN" }] },
    "NEXT_PROMPT",
    signal(),
  );
  const next = await f.journal.beginQueryFrame(profile().recovery, signal());
  assert.ok(
    (
      await f.journal.projectRequest({ ...profile(), frame: next })
    ).queryFrame?.uuids.includes(diagnostic.event.uuid),
  );
  f.journal.endQueryFrame(next);
});

test("raw live user body stays distinct from mM's disk original-row sidecar", async () => {
  const f = await fixture("ACTUAL_RESTORED_DISK_BODY");
  const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
  await f.response("ACTUAL_ASSISTANT_BODY");
  await f.journal.beginLifecycleTransition(frame, signal());
  const { decision } = await f.blocking();
  await f.journal.commitLifecycleTransition(frame, decision, signal());
  const result = await f.journal.projectRequest({ ...profile(), frame });
  const wire = JSON.stringify(result.projection.messages);
  assert.match(wire, /ACTUAL_HUMAN/);
  assert.doesNotMatch(wire, /ACTUAL_RESTORED_DISK_BODY/);
  assert.match(
    (await readFile(f.path)).toString(),
    /ACTUAL_RESTORED_DISK_BODY/,
  );
  assert.doesNotMatch((await readFile(f.path)).toString(), /ACTUAL_HUMAN/);
  f.journal.endQueryFrame(frame);
});

test("empty-success disk exclusion does not delete the actual retained row on the next query", async () => {
  const f = await fixture();
  const first = await f.journal.beginQueryFrame(profile().recovery, signal());
  await f.response("ACTUAL_FINAL");
  await f.journal.beginLifecycleTransition(first, signal());
  const host = f.journal.lifecycleHost(signal());
  const cause = {
    event: "Stop" as const,
    dispatchToolUseID: "ACTUAL_STOP",
    branch: "actual-empty-success",
  };
  const creation = createNativeLifecycleAttachment(
    host,
    {
      type: "hook_success",
      hookName: "Stop",
      hookEvent: "Stop",
      toolUseID: "ACTUAL_STOP",
      content: "",
      stdout: "",
      stderr: "",
    },
    cause,
  );
  await host.capture(creation);
  f.journal.endQueryFrame(first);
  await f.journal.recordUser(
    { role: "user", content: [{ type: "text", text: "ACTUAL_NEXT" }] },
    "ACTUAL_NEXT_PROMPT",
    signal(),
  );
  const next = await f.journal.beginQueryFrame(profile().recovery, signal());
  const result = await f.journal.projectRequest({ ...profile(), frame: next });
  assert.ok(result.queryFrame?.uuids.includes(creation.event.uuid));
  assert.doesNotMatch((await readFile(f.path)).toString(), /hook_success/);
  assert.doesNotMatch(
    JSON.stringify(result.projection.messages),
    /hook_success/,
  );
  f.journal.endQueryFrame(next);
});

for (const failure of [
  "foreign",
  "stale",
  "retired",
  "pending",
  "tampered",
  "unexpected-producer",
  "wrong-lifecycle",
] as const) {
  test(`query owner rejects ${failure} before another projection or append`, async () => {
    const f = await fixture();
    const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
    const initial = await readFile(f.path);
    if (failure === "foreign") {
      await assert.rejects(
        f.journal.projectRequest({
          ...profile(),
          frame: Object.freeze({ revision: 0 }),
        }),
        /query owner/,
      );
    } else if (failure === "stale") {
      const before = frame.revision;
      await f.journal.recordUser(
        { role: "user", content: [{ type: "text", text: "ACTUAL_APPENDED" }] },
        "ACTUAL_APPENDED_PROMPT",
        signal(),
      );
      await assert.rejects(
        f.journal.projectRequest({
          ...profile(),
          frame,
          frameRevision: before,
        }),
        /revision/,
      );
    } else if (failure === "retired") {
      f.journal.endQueryFrame(frame);
      await assert.rejects(
        f.journal.projectRequest({ ...profile(), frame }),
        /query owner/,
      );
    } else if (failure === "tampered") {
      await appendFile(f.path, '{"type":"unexpected-owner"}\n');
      await assert.rejects(
        f.journal.projectRequest({ ...profile(), frame }),
        (error: unknown) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          /changed outside this owner's cursor/.test(error.cause.message),
      );
    } else {
      await f.journal.beginLifecycleTransition(frame, signal());
      if (failure === "pending")
        await assert.rejects(
          f.journal.projectRequest({ ...profile(), frame }),
          /has not committed/,
        );
      else if (failure === "unexpected-producer") {
        await assert.rejects(
          f.response("UNOWNED_DURING_STOP"),
          /outside its owning query transition/,
        );
        assert.deepEqual(await readFile(f.path), initial);
      } else {
        const { decision } = await f.blocking();
        await assert.rejects(
          f.journal.commitLifecycleTransition(
            frame,
            { ...decision, event: "SessionStart" },
            signal(),
          ),
          /owning Stop transition/,
        );
      }
    }
    if (failure !== "retired") f.journal.endQueryFrame(frame);
  });
}

for (const type of [
  "content-replacement",
  "fork-context-ref",
  "observer-ref",
]) {
  test(`owned membership cannot hide physical ${type} ownership`, async () => {
    const f = await fixture();
    const committed = await f.journal.readCommitted(signal());
    assert.ok(committed.state.cursorUuid);
    const selection = {
      leafUuid: committed.state.cursorUuid,
      scope: { kind: "main" as const, sessionId: SID },
      recovery: profile().recovery,
    };
    const retained = reconstructNativeHistory(
      indexNativeSession(committed.document),
      selection,
    );
    const document = decodeNativeSession(
      encodeNativeSessionRows([
        ...committed.document.lines.flatMap((line) =>
          isNativeObject(line.value) && line.value.type !== "last-prompt"
            ? [line.value]
            : [],
        ),
        { type, sessionId: SID },
      ]),
      { parser: "source-line-fallback" },
    );
    await assert.rejects(
      projectNativeOwnedToolRequestContext(document, retained, {
        ...profile(),
        selection,
      }),
      new RegExp(`unsupported-${type}`),
    );
  });
}

test("owned live media requires KGn's real retained-media carrier before request projection", async () => {
  const f = await fixture();
  const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
  const call = {
    type: "tool_use",
    id: "actual-read",
    name: "Read",
    input: { file_path: "owned.png" },
  };
  await f.journal.recordResponse(
    recordNativeJsonResponse(
      { requestedModel: MODEL, host: f.journal.responseHost },
      {
        id: "actual-media-api",
        type: "message",
        role: "assistant",
        model: MODEL,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 },
        content: [call],
      },
      [call],
    ),
    signal(),
  );
  await f.journal.recordToolResult(
    {
      result: {
        type: "tool_result",
        tool_use_id: "actual-read",
        content: "ACTUAL_MEDIA_RESULT",
      },
    },
    signal(),
  );
  const committed = await f.journal.readCommitted(signal());
  assert.ok(committed.state.cursorUuid);
  const selection = {
    leafUuid: committed.state.cursorUuid,
    scope: { kind: "main" as const, sessionId: SID },
    recovery: profile().recovery,
  };
  const document = decodeNativeSession(
    encodeNativeSessionRows(
      committed.document.lines.flatMap((line) =>
        isNativeObject(line.value) && line.value.type !== "last-prompt"
          ? [line.value]
          : [],
      ),
    ),
    { parser: "source-line-fallback" },
  );
  const recovered = reconstructNativeHistory(
    indexNativeSession(document),
    selection,
  );
  // Full-source media is outside the journal's narrower text DTO. This authored
  // owner vector exercises the separate request adapter's retained-cache floor.
  const live = {
    ...recovered,
    nodes: recovered.nodes.map((node) =>
      node.uuid !== selection.leafUuid
        ? node
        : {
            ...node,
            row: {
              ...node.row,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "actual-read",
                    content: [
                      {
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: "image/png",
                          data: "unsent:actual-owned-cache",
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
    ),
  };
  await assert.rejects(
    projectNativeOwnedToolRequestContext(document, live, {
      ...profile(),
      selection,
    }),
    /unsupported-native-live-media-owner/,
  );
  f.journal.endQueryFrame(frame);
});

test("projection callbacks see detached frozen live rows with actual physical parent fields", async () => {
  const f = await fixture();
  const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
  const before = await readFile(f.path);
  const result = await f.journal.projectRequest({
    ...profile(),
    frame,
    host: (nodes) => {
      const first = nodes[0];
      assert.ok(first && isNativeObject(first.row.message));
      assert.ok(
        Object.isFrozen(nodes) &&
          Object.isFrozen(first) &&
          Object.isFrozen(first.row.message),
      );
      assert.equal(
        Reflect.set(first.row, "parentUuid", "FORGED_PARENT"),
        false,
      );
      assert.equal(
        Reflect.set(first.row.message, "content", "FORGED_BODY"),
        false,
      );
      return {
        systemTurns: false,
        reminderFold: false,
        withoutAttachmentHooks: true,
        admit: () => true,
      };
    },
  });
  assert.match(JSON.stringify(result.projection.messages), /ACTUAL_HUMAN/);
  assert.doesNotMatch(JSON.stringify(result.projection.messages), /FORGED/);
  assert.deepEqual(await readFile(f.path), before);
  f.journal.endQueryFrame(frame);
});
