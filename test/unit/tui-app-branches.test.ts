import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import type { PermissionDialog } from "../../src/permission-dialog.js";
import { Tui, type TuiOptions } from "../../src/tui/app.js";
import type { PermissionMode } from "../../src/types.js";

function harness(overrides: { columns?: number; rows?: number } = {}) {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const input = Object.assign(new EventEmitter(), {
    setRawMode: (on: boolean) => void raw.push(on),
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
  });
  const output = Object.assign(new EventEmitter(), {
    columns: overrides.columns ?? 80,
    rows: overrides.rows ?? 24,
    write: (text: string) => {
      writes.push(text);
      return true;
    },
  });
  let mode: PermissionMode = "default";
  const interrupts: number[] = [];
  const options: TuiOptions = {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    welcome: { product: "tau", version: "0", model: "m", cwd: "/w" },
    cwd: "/w",
    bypassAvailable: false,
    commands: [],
    mode: () => mode,
    setMode: (m) => {
      mode = m;
    },
    interrupt: () => void interrupts.push(1),
  };
  const tui = new Tui(options);
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    tui,
    input,
    output,
    writes,
    raw,
    interrupts,
    flush,
    mode: () => mode,
    screen: () => writes.join(""),
  };
}

test("zero-sized terminals fall back to 80x24 and raw mode is optional", async () => {
  const h = harness({ columns: 0, rows: 0 });
  (h.input as { setRawMode?: unknown }).setRawMode = undefined;
  h.tui.start();
  h.tui.notice("hello");
  await h.flush();
  expect(h.screen()).toContain("hello");
  h.tui.stop();
});

test("stop is idempotent, releases the waiter, and next() then resolves empty", async () => {
  const h = harness();
  expect(await h.tui.next()).toBeUndefined();
  h.tui.start();
  const pending = h.tui.next();
  h.tui.stop();
  expect(await pending).toBeUndefined();
  h.tui.stop();
  expect(h.raw).toEqual([true, false]);
  expect(await h.tui.next()).toBeUndefined();
});

test("submitted lines queue until next(), and a waiter gets the line directly", async () => {
  const h = harness();
  h.tui.start();
  h.input.emit("data", "first\r");
  expect(await h.tui.next()).toBe("first");
  const waiting = h.tui.next();
  h.input.emit("data", Buffer.from("second\r"));
  expect(await waiting).toBe("second");
  h.input.emit("data", "\x1b[");
  h.input.emit("data", "Z");
  expect(h.mode()).toBe("acceptEdits");
  h.output.emit("resize");
  h.tui.stop();
});

test("double Ctrl-C exits; the arm expires on its own", async () => {
  const h = harness();
  h.tui.start();
  const waiting = h.tui.next();
  h.input.emit("data", "\x03");
  await h.flush();
  expect(h.screen()).toContain("Ctrl-C");
  h.input.emit("data", "\x03");
  expect(await waiting).toBeUndefined();
  expect(await h.tui.next()).toBeUndefined();
  h.tui.stop();
  const e = harness();
  e.tui.start();
  e.input.emit("data", "\x1b");
  e.input.emit("data", "x\x1b");
  await new Promise((r) => setTimeout(r, 900));
  e.tui.stop();
});

test("Ctrl-D exit without a waiter and interrupt while busy", () => {
  const h = harness();
  h.tui.start();
  h.input.emit("data", "\x04\x04");
  h.tui.beginTurn();
  h.input.emit("data", "\x03");
  expect(h.interrupts).toHaveLength(1);
  h.tui.endTurn({ kind: "silent" });
  h.tui.stop();
});

test("turn lifecycle: spinner ticks and every outcome renders", async () => {
  const h = harness();
  h.tui.start();
  h.tui.beginTurn();
  h.tui.beginTurn();
  await new Promise((r) => setTimeout(r, 300));
  h.tui.endTurn({ kind: "done" });
  h.tui.endTurn({ kind: "interrupted" });
  h.tui.endTurn({ kind: "failed", message: "kaput" });
  h.tui.endTurn({ kind: "silent" });
  h.tui.user("hi");
  h.tui.command("/x", ["out"]);
  h.tui.command("/y", ["bad"], "error");
  h.tui.setModel("model-2");
  h.tui.setCommands([{ name: "zz", description: "d" }]);
  await h.flush();
  const text = h.screen();
  expect(text).toContain("kaput");
  expect(text).toContain("model-2");
  h.tui.clear();
  h.tui.stop();
});

test("elapsed time formats seconds, minutes and hours", async () => {
  const real = performance.now.bind(performance);
  let offset = 0;
  performance.now = () => real() + offset;
  try {
    const h = harness();
    h.tui.start();
    for (const [ms, expected] of [
      [5_000, "5s"],
      [125_000, "2m 5s"],
      [3_900_000, "1h 5m"],
    ] as const) {
      offset = 0;
      h.tui.beginTurn();
      offset = ms;
      h.tui.endTurn({ kind: "done" });
      await h.flush();
      expect(h.screen()).toContain(expected);
    }
    h.tui.stop();
  } finally {
    performance.now = real;
  }
});

test("agent events stream text, reset it, and report tools and warnings", async () => {
  const h = harness();
  h.tui.start();
  h.tui.event({ type: "text", text: "" });
  h.tui.event({ type: "text_reset", text: "" });
  h.tui.event({ type: "text", text: "\n\nHel" });
  h.tui.event({ type: "text", text: "lo" });
  h.tui.event({ type: "text_reset", text: "Replaced" });
  await h.flush();
  expect(h.screen()).toContain("Replaced");
  h.tui.event({ type: "text_reset", text: "" });
  h.tui.event({ type: "text", text: "again" });
  h.tui.event({
    type: "assistant",
    message: { role: "assistant", content: [] },
    stopReason: "end_turn",
  });
  h.tui.event({ type: "text", text: "after" });
  h.tui.event({
    type: "tool_start",
    tool: {
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    },
  });
  h.tui.event({
    type: "tool_result",
    result: { type: "tool_result", tool_use_id: "t1", content: "done" },
  });
  h.tui.event({ type: "warning", message: "careful" });
  h.tui.event({ type: "compaction", stage: "start" });
  h.tui.event({
    type: "compaction",
    stage: "complete",
    beforeTokens: 10,
    afterTokens: 5,
  });
  h.tui.event({ type: "compaction", stage: "failed" });
  h.tui.event({ type: "compaction", stage: "skipped" });
  h.tui.event({ type: "model_request" });
  await h.flush();
  const text = h.screen();
  expect(text).toContain("careful");
  expect(text).toContain("Compacting");
  expect(text).toContain("compaction failed");
  h.tui.stop();
});

const dialog: PermissionDialog = {
  body: "b",
  question: "Proceed?",
  options: [
    { label: "Yes", choice: { kind: "accept-once" } },
    { label: "No", choice: { kind: "reject" } },
  ],
};

test("permission dialogs resolve from keys, aborts, and pre-aborted signals", async () => {
  const h = harness();
  h.tui.start();
  const yes = h.tui.choosePermission(dialog, { tool: "Bash" } as never);
  h.input.emit("data", "1");
  expect(await yes).toEqual({ kind: "accept-once" });
  const titled = h.tui.choosePermission({ ...dialog, title: "Custom" }, {
    tool: "Write",
  } as never);
  h.input.emit("data", "\x1b");
  expect(await titled).toEqual({ kind: "reject" });
  h.tui.event({
    type: "tool_start",
    tool: {
      type: "tool_use",
      id: "w1",
      name: "Write",
      input: { file_path: "/nonexistent/x", content: "a\nb" },
    },
  });
  const patched = h.tui.choosePermission({ ...dialog, subtitle: "s" }, {
    tool: "Write",
  } as never);
  h.input.emit("data", "2");
  expect(await patched).toEqual({ kind: "reject" });
  const abort = new AbortController();
  const aborted = h.tui.choosePermission(
    dialog,
    { tool: "Bash" } as never,
    abort.signal,
  );
  abort.abort(new Error("stop"));
  await expect(aborted).rejects.toThrow("stop");
  const pre = new AbortController();
  pre.abort(new Error("early"));
  await expect(h.tui.confirm("sure?", pre.signal)).rejects.toThrow("early");
  const ok = h.tui.confirm("sure?");
  h.input.emit("data", "1");
  expect(await ok).toBe(true);
  const no = h.tui.confirm("sure?");
  h.input.emit("data", "2");
  expect(await no).toBe(false);
  h.tui.stop();
});

test("model picker, help and status views", async () => {
  const h = harness();
  h.tui.start();
  const choices = [
    { label: "A", description: "", model: "a", current: false },
    { label: "B", description: "", model: "b", current: true },
  ];
  const picked = h.tui.pickModel(choices);
  h.input.emit("data", "\r");
  expect(await picked).toBe("b");
  const none = h.tui.pickModel([choices[0]!]);
  h.input.emit("data", "\x1b");
  expect(await none).toBeUndefined();
  h.tui.showHelp([]);
  h.input.emit("data", "\x1b");
  h.tui.showStatus({ status: [["k", "v"]], usage: [] });
  h.input.emit("data", "\r");
  await h.flush();
  h.tui.stop();
});

test("a stray permission or model key with nothing pending is harmless", () => {
  const h = harness();
  h.tui.start();
  h.input.emit("data", "\x1b");
  h.tui.stop();
});
