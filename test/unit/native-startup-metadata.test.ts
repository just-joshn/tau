import assert from "node:assert/strict";
import { test, onTestFinished } from "bun:test";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NativeStartupMetadataOwner,
  normalizeNativeHookTitle,
  type NativeStartupMetadataHost,
  type NativeStartupDispatchFacts,
  type NativeStartupRootState,
} from "../../src/native-startup-metadata.js";
import {
  createNativeLifecycleConsumer,
  type NativeLifecycleCaptureHost,
  type NativeLifecycleCause,
} from "../../src/native-lifecycle-hooks.js";
import type { NativePromptFact } from "../../src/native-prompt-snapshot.js";
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
const facts = (
  source: NativeStartupDispatchFacts["source"] = "startup",
): NativeStartupDispatchFacts => ({
  sessionId: id(90),
  source,
  newPluginsOnly: { presence: "absent" },
  agentContext: "absent",
  resumedMessages: { presence: "absent" },
  envFileSessionId: { presence: "absent" },
});
const state = (title?: string): NativeStartupRootState => ({
  pendingInitialUserMessage: undefined,
  pendingHookSessionTitle: title,
  startSource: undefined,
  hasDispatched: false,
  hooksDispatched: 0,
  pluginsCovered: [],
  pluginsSucceeded: [],
});
function fixture(initial?: NativeStartupRootState) {
  const root = {},
    calls: string[] = [],
    prompts: { text: string; sentBy: string }[] = [],
    unsupported: unknown[] = [],
    rows: unknown[] = [];
  let current: string | undefined,
    serial = 0;
  const host: NativeStartupMetadataHost = {
    reloadSkills() {
      calls.push("reload");
    },
    invalidateEnvironment() {
      calls.push("env");
    },
    watchPaths(paths, mode) {
      calls.push(`${mode}:${paths.join(",")}`);
    },
    unsupported(v) {
      unsupported.push(v);
    },
    title: {
      teamOwned: () => known(false),
      current: () => known(current),
      collisionYield: () => known(undefined),
      setTitle(name) {
        current = name;
        calls.push(`title:${name}`);
      },
      setAgentName(name) {
        calls.push(`agent:${name}`);
      },
      sourcePathMatches: () => known(true),
      persistenceSkipped: () => known(false),
      async reappend(session) {
        calls.push(`reappend:${session}`);
      },
      writeFailure() {
        calls.push("write-failure");
      },
    },
  };
  const owner = new NativeStartupMetadataOwner({
    root,
    sessionId: id(90),
    initial: initial
      ? { kind: "actual-root-state", state: initial }
      : { kind: "actual-new-root" },
    host,
  });
  const queue = {
    root,
    sessionId: id(90),
    prependOwnedUserMessage(text: string, sentBy: "process") {
      prompts.push({ text, sentBy });
      return { status: "enqueued" as const };
    },
  };
  const lifecycle: NativeLifecycleCaptureHost = {
    stamp() {
      calls.push("stamp");
      return { uuid: id(++serial), timestamp: "2026-01-01T00:00:00.000Z" };
    },
    capture(row) {
      rows.push(row);
      calls.push("row");
    },
    unsupported(v) {
      unsupported.push(v);
    },
  };
  return {
    root,
    calls,
    prompts,
    unsupported,
    rows,
    host,
    owner,
    queue,
    lifecycle,
  };
}
const cause: NativeLifecycleCause = {
  event: "SessionStart",
  dispatchToolUseID: id(99),
  branch: "owned-result",
};
function consumer(
  f: ReturnType<typeof fixture>,
  source: NativeStartupDispatchFacts["source"] = "startup",
  extra: Partial<NativeStartupDispatchFacts> = {},
) {
  const lease = f.owner.begin(f.root, { ...facts(source), ...extra });
  lease.dispatchReady();
  const c = createNativeLifecycleConsumer(
    {
      event: "SessionStart",
      dispatchToolUseID: id(99),
      phase: "ordinary",
      start: {
        source,
        newPluginsOnly:
          extra.newPluginsOnly?.presence === "supplied" &&
          extra.newPluginsOnly.enabled,
      },
    },
    { ...f.lifecycle, ...lease.lifecycleHost },
  );
  return { lease, c };
}

test("real consumer writes only last initial slot and applies completion effects before the genuine final context stamp", async () => {
  const f = fixture(),
    { lease, c } = consumer(f, "startup", {
      envFileSessionId: { presence: "supplied", value: id(90) },
    });
  await c.consume({ kind: "initial-user-message", text: "FIRST", cause });
  await c.consume({ kind: "initial-user-message", text: "LAST", cause });
  await c.consume({ kind: "session-title", text: "TITLE" });
  await c.consume({ kind: "watch-paths", paths: ["/actual/a"] });
  await c.consume({ kind: "reload-skills" });
  await c.consume({
    kind: "context",
    content: ["CTX"],
    cause,
    retainForStop: false,
  });
  assert.deepEqual(f.prompts, []);
  await c.finish({ kind: "completed" });
  assert.deepEqual(f.calls, [
    "reload",
    "env",
    "replace:/actual/a",
    "stamp",
    "row",
  ]);
  assert.equal(f.owner.snapshot(f.root).pendingInitialUserMessage, "LAST");
  assert.equal(f.owner.snapshot(f.root).pendingHookSessionTitle, "TITLE");
  assert.deepEqual(f.owner.takeInitialInput(f.root, f.queue), {
    status: "enqueued",
  });
  assert.deepEqual(f.prompts, [{ text: "LAST", sentBy: "process" }]);
  assert.deepEqual(f.owner.takeInitialInput(f.root, f.queue), {
    status: "absent",
  });
  lease.retire();
});

test("empty completion clears old title and still invalidates an actual env-file owner; abort does neither", async () => {
  const f = fixture(state("OLD")),
    { c } = consumer(f, "clear", {
      envFileSessionId: { presence: "supplied", value: id(90) },
    });
  await c.finish({ kind: "completed" });
  assert.equal(f.owner.snapshot(f.root).pendingHookSessionTitle, undefined);
  assert.deepEqual(f.calls, ["env"]);
  const g = fixture(state("OLD")),
    aborted = consumer(g, "clear", {
      envFileSessionId: { presence: "supplied", value: id(90) },
    });
  await aborted.c.consume({
    kind: "initial-user-message",
    text: "EARLIER",
    cause,
  });
  await aborted.c.finish({ kind: "aborted-in-loop" });
  assert.equal(g.owner.snapshot(g.root).pendingInitialUserMessage, "EARLIER");
  assert.equal(g.owner.snapshot(g.root).pendingHookSessionTitle, "OLD");
  assert.deepEqual(g.calls, []);
});

test("UUID transitions preserve actual root ledger and launcher-first distinguishes absent from supplied empty resume", () => {
  const f = fixture(),
    a = f.owner.begin(f.root, facts());
  assert.equal(a.launcherFirst, true);
  a.retire();
  f.owner.matched(f.root, {
    source: "startup",
    count: 2,
    covered: [["actual-plugin", "folded"]],
    succeededStandIns: ["old-id"],
  });
  f.owner.transition(f.root, id(91));
  const next = f.owner.begin(f.root, { ...facts("clear"), sessionId: id(91) });
  assert.equal(next.launcherFirst, false);
  assert.equal(f.owner.snapshot(f.root).hooksDispatched, 2);
  assert.deepEqual(f.owner.snapshot(f.root).pluginsCovered, [
    ["actual-plugin", "folded"],
  ]);
  assert.throws(() => f.owner.snapshot({}), /Foreign/);
  const g = fixture();
  assert.equal(g.owner.begin(g.root, facts("resume")).launcherFirst, false);
  const h = fixture();
  assert.equal(
    h.owner.begin(h.root, {
      ...facts("resume"),
      resumedMessages: { presence: "supplied", length: 0 },
    }).launcherFirst,
    true,
  );
});

test("new-plugin ignores initial prompts, clears title, adds watch paths and owns env invalidation before final rows", async () => {
  const f = fixture(state("OLD")),
    { c } = consumer(f, "startup", {
      newPluginsOnly: { presence: "supplied", enabled: true },
    });
  await c.consume({ kind: "initial-user-message", text: "IGNORE", cause });
  await c.consume({ kind: "session-title", text: "IGNORE TITLE" });
  await c.consume({ kind: "watch-paths", paths: ["/new"] });
  await c.finish({ kind: "completed" });
  assert.equal(f.owner.snapshot(f.root).pendingInitialUserMessage, undefined);
  assert.equal(f.owner.snapshot(f.root).pendingHookSessionTitle, undefined);
  assert.deepEqual(f.calls, ["env", "add:/new"]);
});

test("exact title normalization preserves source code-point clipping and qpn updates title then agent name before optional reappend", async () => {
  assert.equal(
    normalizeNativeHookTitle(" \u0000A\u200dB\nC\u2028D "),
    "A B C D",
  );
  assert.equal(
    Array.from(normalizeNativeHookTitle("😀".repeat(201))).length,
    200,
  );
  const f = fixture(),
    { c } = consumer(f);
  await c.consume({ kind: "session-title", text: "  TITLE\nNAME  " });
  await c.finish({ kind: "completed" });
  const applied = await f.owner.takeHookTitle(f.root, "resume-reappend");
  assert.deepEqual(applied, { status: "reappended", title: "TITLE NAME" });
  assert.deepEqual(f.calls, [
    "title:TITLE NAME",
    "agent:TITLE NAME",
    `reappend:${id(90)}`,
  ]);
  assert.deepEqual(await f.owner.takeHookTitle(f.root, "resume-reappend"), {
    status: "absent",
  });
});

test("title team/collision/unknown facts are actual guards; no false defaults and no persistence when unmaterialized or disabled", async () => {
  for (const branch of [
    "team",
    "collision",
    "unknown",
    "unmaterialized",
    "disabled",
  ] as const) {
    const f = fixture(state("TITLE"));
    // Owner snapshots functions at construction; configure a new owner from these actual host facts.
    if (branch === "team") f.host.title.teamOwned = () => known(true);
    if (branch === "collision")
      f.host.title.collisionYield = () => known("actual collision winner");
    if (branch === "unknown")
      f.host.title.collisionYield = () => ({
        status: "unsupported",
        reason: "no actual naming owner",
      });
    if (branch === "unmaterialized")
      f.host.title.sourcePathMatches = () => known(false);
    if (branch === "disabled")
      f.host.title.persistenceSkipped = () => known(true);
    const owner = new NativeStartupMetadataOwner({
      root: f.root,
      sessionId: id(90),
      initial: { kind: "actual-root-state", state: state("TITLE") },
      host: f.host,
    });
    const result = await owner.takeHookTitle(f.root, "resume-reappend");
    assert.equal(
      result.status,
      branch === "team"
        ? "team-owned"
        : branch === "collision"
          ? "collision-yielded"
          : branch === "unknown"
            ? "unsupported"
            : branch === "disabled"
              ? "cached-persistence-skipped"
              : "cached-unmaterialized",
    );
    assert.equal(
      f.calls.some((v) => v.startsWith("reappend")),
      false,
    );
  }
});

test("actual takeover keeps last late input separate and clear generation rejects stale delivery without inventing a queued prompt", async () => {
  const f = fixture(),
    { lease, c } = consumer(f);
  lease.overtake();
  await c.overtakeStart();
  await c.consume({ kind: "initial-user-message", text: "LATE1", cause });
  await c.consume({ kind: "initial-user-message", text: "LATE2", cause });
  await c.finish({ kind: "completed" });
  assert.equal(f.owner.snapshot(f.root).pendingInitialUserMessage, undefined);
  assert.deepEqual(lease.takeLateInput(f.queue), { status: "enqueued" });
  assert.deepEqual(f.prompts, [{ text: "LATE2", sentBy: "process" }]);
  assert.deepEqual(lease.takeLateInput(f.queue), { status: "absent" });
  const g = fixture(),
    later = consumer(g);
  later.lease.overtake();
  await later.c.overtakeStart();
  await later.c.consume({ kind: "initial-user-message", text: "DROP", cause });
  g.owner.clearLate(g.root);
  await later.c.finish({ kind: "completed" });
  assert.deepEqual(later.lease.takeLateInput(g.queue), { status: "stale" });
  assert.deepEqual(g.prompts, []);
});

test("input ownership/probe retirement and metadata writer failure are truthful independent dispositions", async () => {
  const f = fixture(state("TITLE"));
  const lease = f.owner.begin(f.root, facts());
  lease.dispatchReady();
  await lease.lifecycleHost.startMetadata({ initialUserMessage: "PROMPT" });
  assert.throws(
    () => f.owner.takeInitialInput(f.root, { ...f.queue, root: {} }),
    /another owner/,
  );
  assert.deepEqual(
    f.owner.takeInitialInput(f.root, {
      ...f.queue,
      prependOwnedUserMessage: () => ({ status: "probe-discarded" }),
    }),
    { status: "probe-discarded" },
  );
  assert.deepEqual(f.owner.takeInitialInput(f.root, f.queue), {
    status: "absent",
  });
  const host = {
    ...f.host,
    title: {
      ...f.host.title,
      async reappend() {
        throw new Error("actual metadata write");
      },
    },
  };
  const owner = new NativeStartupMetadataOwner({
    root: f.root,
    sessionId: id(90),
    initial: { kind: "actual-root-state", state: state("TITLE") },
    host,
  });
  assert.deepEqual(await owner.takeHookTitle(f.root, "resume-reappend"), {
    status: "write-failed",
    title: "TITLE",
  });
  assert.ok(f.calls.includes("write-failure"));
});

test("duplicate completion cannot repeat reload and root close retires outstanding leases", async () => {
  const f = fixture(),
    { lease, c } = consumer(f);
  await c.consume({ kind: "reload-skills" });
  await c.finish({ kind: "completed" });
  await assert.rejects(
    lease.lifecycleHost.startCompletion({
      source: "startup",
      newPluginsOnly: false,
      overtaken: false,
      end: { kind: "completed" },
      sessionTitle: undefined,
      watchPaths: [],
      reloadSkills: true,
    }),
    /already applied/,
  );
  assert.deepEqual(f.calls, ["reload"]);
  await f.owner.close(f.root);
  assert.throws(
    () => lease.lifecycleHost.startMetadata({ initialUserMessage: "AFTER" }),
    /closed/,
  );
});

test("supplied false disables first-launch credentials but preserves ordinary truthy metadata branches", async () => {
  const f = fixture(),
    { lease, c } = consumer(f, "startup", {
      newPluginsOnly: { presence: "supplied", enabled: false },
    });
  assert.equal(lease.launcherFirst, false);
  await c.consume({ kind: "initial-user-message", text: "REAL PROMPT", cause });
  await c.consume({ kind: "session-title", text: "REAL TITLE" });
  await c.consume({ kind: "watch-paths", paths: ["/real"] });
  await c.finish({ kind: "completed" });
  assert.equal(
    f.owner.snapshot(f.root).pendingInitialUserMessage,
    "REAL PROMPT",
  );
  assert.equal(f.owner.snapshot(f.root).pendingHookSessionTitle, "REAL TITLE");
  assert.deepEqual(f.calls, ["replace:/real"]);
});

test("fire-and-forget title write is an owned job and concurrent closes await its actual filesystem settlement", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-startup-metadata-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "owned-title.txt"),
    gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>(),
    f = fixture(state("TITLE"));
  const owner = new NativeStartupMetadataOwner({
    root: f.root,
    sessionId: id(90),
    initial: { kind: "actual-root-state", state: state("TITLE") },
    host: {
      ...f.host,
      title: {
        ...f.host.title,
        async reappend(session) {
          entered.resolve();
          await gate.promise;
          await writeFile(path, `${session}:TITLE`);
        },
      },
    },
  });
  const writing = owner.takeHookTitle(f.root, "resume-reappend");
  await entered.promise;
  await assert.rejects(access(path));
  const closing = owner.close(f.root),
    again = owner.close(f.root);
  assert.equal(closing, again);
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  gate.resolve();
  await closing;
  await writing;
  assert.equal(await readFile(path, "utf8"), `${id(90)}:TITLE`);
  assert.equal(closed, true);
});

test("settled metadata owner errors remain observable to close without rerunning their source effects", async () => {
  const f = fixture(state("TITLE"));
  let attempts = 0;
  const owner = new NativeStartupMetadataOwner({
    root: f.root,
    sessionId: id(90),
    initial: { kind: "actual-root-state", state: state("TITLE") },
    host: {
      ...f.host,
      title: {
        ...f.host.title,
        current() {
          attempts++;
          throw new Error("actual current-title owner failed");
        },
      },
    },
  });
  await assert.rejects(
    owner.takeHookTitle(f.root, "resume-reappend"),
    /metadata owner failed/,
  );
  await assert.rejects(owner.close(f.root), /metadata owner failed/);
  assert.equal(attempts, 1);
  assert.deepEqual(f.calls, []);
});

test("root startSource changes at the real ready phase and source skip does not invent a dispatch", () => {
  const f = fixture();
  f.owner.skipped(f.root, "resume");
  assert.equal(f.owner.snapshot(f.root).startSource, "resume");
  assert.equal(f.owner.snapshot(f.root).hasDispatched, false);
  const lease = f.owner.begin(f.root, facts());
  assert.equal(f.owner.snapshot(f.root).hasDispatched, true);
  assert.equal(f.owner.snapshot(f.root).startSource, "resume");
  assert.throws(
    () =>
      lease.lifecycleHost.startMetadata({ initialUserMessage: "TOO EARLY" }),
    /ready phase/,
  );
  lease.dispatchReady();
  assert.equal(f.owner.snapshot(f.root).startSource, "startup");
  assert.throws(() => lease.dispatchReady(), /repeated/);
});

test("control-stream closure without abort still completes source metadata before CUn", async () => {
  const f = fixture(state("OLD")),
    { c } = consumer(f, "compact", {
      envFileSessionId: { presence: "supplied", value: id(90) },
    });
  await c.consume({
    kind: "context",
    content: ["CTX"],
    cause,
    retainForStop: false,
  });
  const decision = await c.finish({ kind: "control-stream-closed" });
  assert.equal(decision.wasCancelled, true);
  assert.equal(f.owner.snapshot(f.root).pendingHookSessionTitle, undefined);
  assert.deepEqual(f.calls, ["env", "stamp", "row"]);
});

test("metadata host failure is fatal before final context creation and cannot repeat partially applied source effects", async () => {
  const f = fixture(state("OLD"));
  const owner = new NativeStartupMetadataOwner({
    root: f.root,
    sessionId: id(90),
    initial: { kind: "actual-root-state", state: state("OLD") },
    host: {
      ...f.host,
      reloadSkills() {
        f.calls.push("reload-started");
        throw new Error("actual reload host failed");
      },
    },
  });
  const lease = owner.begin(f.root, facts());
  lease.dispatchReady();
  const c = createNativeLifecycleConsumer(
    {
      event: "SessionStart",
      dispatchToolUseID: id(99),
      phase: "ordinary",
      start: { source: "startup", newPluginsOnly: false },
    },
    { ...f.lifecycle, ...lease.lifecycleHost },
  );
  await c.consume({ kind: "reload-skills" });
  await c.consume({
    kind: "context",
    content: ["CTX"],
    cause,
    retainForStop: false,
  });
  await assert.rejects(c.finish({ kind: "completed" }), /capture owner failed/);
  assert.deepEqual(f.calls, ["reload-started"]);
  assert.deepEqual(f.rows, []);
  await assert.rejects(owner.close(f.root), /metadata owner failed/);
});

test("title metadata target is captured before cache callbacks can transition the current session", async () => {
  const f = fixture(state("TITLE"));
  let owner: NativeStartupMetadataOwner | undefined;
  owner = new NativeStartupMetadataOwner({
    root: f.root,
    sessionId: id(90),
    initial: { kind: "actual-root-state", state: state("TITLE") },
    host: {
      ...f.host,
      title: {
        ...f.host.title,
        setTitle(name) {
          f.host.title.setTitle(name);
          owner?.transition(f.root, id(91));
        },
      },
    },
  });
  await owner.takeHookTitle(f.root, "resume-reappend");
  assert.ok(f.calls.includes(`reappend:${id(90)}`));
  assert.equal(f.calls.includes(`reappend:${id(91)}`), false);
});
