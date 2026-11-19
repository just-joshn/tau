import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { goodbye, slashCommand } from "../../src/slash-commands.js";
import { stampNewMemoryContent } from "../../src/memory-stamp.js";
import { workflowTool, type WorkflowInput } from "../../src/workflow-tool.js";

test("slashCommand resolves names and aliases and rejects unknown input", () => {
  expect(slashCommand("definitely-not-a-command")).toBeUndefined();
  expect(slashCommand("clear")).toBe("clear");
});

test("goodbye falls back when the random index lands outside the list", () => {
  const original = Math.random;
  try {
    Math.random = () => 0.999999;
    expect(goodbye()).toBe("Catch you later!");
    Math.random = () => 1;
    expect(goodbye()).toBe("Goodbye!");
  } finally {
    Math.random = original;
  }
});

const stamp = (content: string) =>
  stampNewMemoryContent({
    content,
    sessionId: "s1",
    modified: "2026-01-01T00:00:00.000Z",
  });

test("stamp leaves non-frontmatter, invalid YAML, non-object and stamped content alone", () => {
  expect(stamp("- index line\n")).toBe("- index line\n");
  const invalid = "---\n: : [\n---\n\nbody\n";
  expect(stamp(invalid)).toBe(invalid);
  const list = "---\n- a\n- b\n---\n\nbody\n";
  expect(stamp(list)).toBe(list);
  const scalar = "---\njust text\n---\n\nbody\n";
  expect(stamp(scalar)).toBe(scalar);
  const done = "---\nname: x\nmetadata:\n  originSessionId: abc\n---\n\nbody\n";
  expect(stamp(done)).toBe(done);
});

test("stamp handles missing name/description, node_type override and empty origin", () => {
  const out = stamp(
    "---\nname: 12\nmetadata:\n  node_type: other\n  originSessionId: ''\n  k: v\n---\n",
  );
  expect(out).toContain("originSessionId: s1");
  expect(out).toContain("node_type: memory");
  expect(out).not.toContain("other");
  expect(out).not.toContain("description");
  expect(out).toContain("k: v");
  const nullDesc = stamp("---\nname: A B\ndescription: null\n---\nbody");
  expect(nullDesc).not.toContain("description");
  expect(nullDesc).toContain("name: a-b");
  const noMeta = stamp("---\nname: n\ndescription: d\nmetadata: 3\n---\n\nb\n");
  expect(noMeta).toContain("description: d");
  expect(noMeta.endsWith("\nb\n")).toBe(true);
  const crlf = stamp("\uFEFF---\r\nname: n\r\n---\r\n\r\nbody\r\n");
  expect(crlf).toContain("originSessionId: s1");
});

test("workflow validate covers script limits, files and sources", async () => {
  const t = workflowTool();
  const v = (input: WorkflowInput) => t.validate?.(input);
  expect(await v({})).toBe("Must provide script, name, or scriptPath");
  expect(await v({ script: "x" })).toContain(
    "must be the FIRST statement",
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "wf-"));
  try {
    const missing = path.join(dir, "missing.js");
    expect(await v({ scriptPath: missing })).toContain("not found");
    expect(await v({ scriptPath: dir })).toContain("not a regular file");
    const blocked = path.join(dir, "a", "b");
    await mkdir(path.join(dir, "a"));
    await writeFile(path.join(dir, "a", "f"), "x");
    expect(await v({ scriptPath: path.join(dir, "a", "f", "b") })).toContain(
      "Failed to read workflow script file",
    );
    void blocked;
    const big = path.join(dir, "big.js");
    await writeFile(big, "a".repeat(524289));
    expect(await v({ scriptPath: big })).toContain("exceeds");
    const bad = path.join(dir, "bad.js");
    await writeFile(bad, "x\u001b[0m");
    expect(await v({ scriptPath: bad })).toContain("control character");
    const ok = path.join(dir, "ok.js");
    await writeFile(
      ok,
      "export const meta = { name: 'ok', description: 'ok' }\nreturn 1\n",
    );
    expect(await v({ scriptPath: ok })).toBeUndefined();
    const unreadable = path.join(dir, "locked.js");
    await writeFile(unreadable, "x", { mode: 0o000 });
    const result = await v({ scriptPath: unreadable });
    if (process.getuid?.() !== 0)
      expect(result).toContain("Failed to read workflow script file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow schema rejects hidden characters and bad run ids", () => {
  const schema = workflowTool().schema();
  expect(schema.safeParse({ script: "a\u0007b" }).success).toBe(false);
  expect(schema.safeParse({ script: "a\tb\nc" }).success).toBe(true);
  expect(schema.safeParse({ name: "a\u200Bb" }).success).toBe(false);
  expect(schema.safeParse({ name: "ok" }).success).toBe(true);
  expect(schema.safeParse({ resumeFromRunId: "nope" }).success).toBe(false);
  expect(schema.safeParse({ resumeFromRunId: "wf_abc123" }).success).toBe(true);
  expect(schema.safeParse({ script: "a\u0085b" }).success).toBe(false);
});
