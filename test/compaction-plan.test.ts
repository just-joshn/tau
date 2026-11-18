import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canOmitToolResults,
  exchangeGroups,
  splitPendingInput,
  SummaryPlanner,
} from "../src/compaction-plan.js";
import type { Message } from "../src/types.js";

const user = (text = "next"): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string, responseId = text): Message => ({
  role: "assistant",
  responseId,
  content: [{ type: "text", text }],
});
const call = (id: string, name = "Read", file_path = "a.ts") => ({
  type: "tool_use" as const,
  id,
  name,
  input: { file_path },
});
const result = (id: string, length: number) => ({
  type: "tool_result" as const,
  tool_use_id: id,
  content: id.repeat(length).slice(0, length),
});

test("a prefix summary preserves the last complete reply group and leaves pending input out of its request", () => {
  const rows = [
      user("first"),
      assistant("older"),
      user("second"),
      assistant("recent"),
      user("pending"),
    ],
    before = structuredClone(rows);
  const plan = new SummaryPlanner(rows, { allowLastResort: false }).next()!;
  assert.deepEqual(plan.toSummarize, rows.slice(0, 3));
  assert.deepEqual(plan.toKeep, rows.slice(3));
  assert.equal(plan.groupsPreserved, 1);
  assert.equal(plan.totalGroups, 3);
  assert.deepEqual(rows, before);
});

test("a single completed exchange needs last-resort permission and pending tools can be summarized together", () => {
  const rows = [user(), assistant("answer"), user("pending")];
  assert.equal(
    new SummaryPlanner(rows, { allowLastResort: false }).next(),
    undefined,
  );
  assert.deepEqual(splitPendingInput(rows), {
    toSummarize: rows.slice(0, 2),
    toKeep: rows.slice(2),
  });
  const tools: Message[] = [
    user(),
    { role: "assistant", content: [call("a")] },
    { role: "user", content: [result("a", 10)] },
  ];
  const plan = new SummaryPlanner(tools).next()!;
  assert.deepEqual(plan.toSummarize, tools);
  assert.deepEqual(plan.toKeep, []);
  assert.equal(plan.mode, "all");
});

test("summary context failures move a finite round ladder before last-resort head truncation", () => {
  const rows = [user("initial")];
  for (const id of ["a", "b", "c", "d", "e"])
    rows.push(assistant(id.repeat(4000), id), user());
  const planner = new SummaryPlanner(rows),
    preserved: number[] = [];
  let count = 0,
    head = 0;
  for (let plan = planner.next(); plan; plan = planner.next()) {
    count++;
    assert.ok(count < 12);
    if (plan.mode === "round") preserved.push(plan.groupsPreserved);
    head = Math.max(head, plan.headTruncations);
    if (!planner.reject(plan, { kind: "prompt" })) break;
  }
  assert.equal(preserved[0], 1);
  assert.ok(
    preserved.every((n, index) => index === 0 || n > preserved[index - 1]!),
  );
  assert.ok(head > 0 && head <= 3);
});

test("large tool results are omitted only with the supplied feature assignment and sufficient group savings", () => {
  const rows: Message[] = [
      user(),
      { role: "assistant", content: [call("a"), call("b", "Read", "./a.ts")] },
      { role: "user", content: [result("a", 2000), result("b", 1200)] },
    ],
    before = structuredClone(rows);
  assert.equal(canOmitToolResults(rows, 100), false);
  assert.equal(
    canOmitToolResults(rows, 100, { omitLargeToolResults: true }),
    true,
  );
  assert.equal(
    canOmitToolResults(rows, 4000, { omitLargeToolResults: true }),
    false,
  );
  const plan = new SummaryPlanner(
    rows,
    { omitLargeToolResults: true, keepNoRound: true },
    { kind: "prompt", gap: 100 },
  ).next()!;
  assert.equal(plan.headTruncations, 0);
  assert.equal(plan.omissionPasses, 1);
  assert.deepEqual([...plan.leftOutIds], ["a", "b"]);
  const results = plan.toSummarize.at(-1)!.content;
  assert.ok(
    results.every(
      (block) =>
        block.type === "tool_result" && block.content.includes("already ran"),
    ),
  );
  assert.deepEqual(rows, before);
});

test("one replaced or duplicate result excludes its same-file group; questions and known denials stay intact", () => {
  const rows: Message[] = [
    user(),
    { role: "assistant", content: [call("a"), call("b")] },
    { role: "user", content: [result("a", 4000), result("b", 4000)] },
  ];
  assert.equal(
    canOmitToolResults(rows, 1, {
      omitLargeToolResults: true,
      replacedToolIds: new Set(["a"]),
    }),
    false,
  );
  rows[2]!.content.push(result("a", 4000));
  assert.equal(
    canOmitToolResults(rows, 1, { omitLargeToolResults: true }),
    false,
  );
  const question: Message[] = [
    user(),
    { role: "assistant", content: [call("q", "AskUserQuestion")] },
    { role: "user", content: [result("q", 5000)] },
  ];
  assert.equal(
    canOmitToolResults(question, 1, { omitLargeToolResults: true }),
    false,
  );
  question[1]!.content = [call("q", "Bash")];
  question[2]!.toolDenialKind = "user-rejected";
  assert.equal(
    canOmitToolResults(question, 1, { omitLargeToolResults: true }),
    false,
  );
});

test("omission takes the largest results first and never changes ids or error flags", () => {
  const rows: Message[] = [
    user(),
    { role: "assistant", content: [call("a", "Bash"), call("b", "Bash")] },
    {
      role: "user",
      content: [{ ...result("a", 4000), is_error: true }, result("b", 12000)],
    },
  ];
  const plan = new SummaryPlanner(
    rows,
    { keepNoRound: true, omitLargeToolResults: true },
    { kind: "prompt", gap: 100 },
  ).next()!;
  assert.deepEqual([...plan.leftOutIds], ["b"]);
  assert.deepEqual(plan.toSummarize[2]!.content[0], rows[2]!.content[0]);
  assert.equal(plan.toSummarize[2]!.content[1]!.type, "tool_result");
});

test("head truncation remains whole-group, marks missing context and never drops the last group", () => {
  const rows = [
    user("opening"),
    assistant("old"),
    user(),
    assistant("last"),
    user(),
  ];
  const planner = new SummaryPlanner(rows, { keepNoRound: true });
  let plan = planner.next()!;
  assert.equal(planner.reject(plan, { kind: "prompt", gap: 999999 }), true);
  plan = planner.next()!;
  assert.equal(plan.headTruncations, 1);
  assert.equal(plan.toSummarize[0]!.contextTruncated, true);
  assert.ok(plan.toSummarize.some((row) => row.responseId === "last"));
  assert.ok(!plan.toSummarize.some((row) => row.responseId === "old"));
  assert.equal(planner.reject(plan, { kind: "prompt", gap: 999999 }), false);
});

test("retained token allowance includes UTF8 excess and cannot preserve the opening groups", () => {
  const rows = [user("opening")];
  for (const id of ["a", "b", "c", "d"])
    rows.push(assistant("😀".repeat(100), id), user());
  const asciiBudget = new SummaryPlanner(rows, { keptTailTokens: 160 }).next()!;
  assert.equal(asciiBudget.groupsPreserved, 1);
  const broad = new SummaryPlanner(rows, { keptTailTokens: 10000 }).next()!;
  assert.equal(broad.groupsPreserved, 3);
  assert.equal(exchangeGroups(broad.toSummarize).length, 2);
});

test("initial server token gaps scale against message estimates and system overhead", () => {
  const rows = [user("x".repeat(4000))];
  for (const id of ["a", "b", "c", "d"])
    rows.push(assistant(id.repeat(4000), id), user(""));
  const known = new SummaryPlanner(
    rows,
    {},
    { kind: "prompt", actualTokens: 20000, gap: 6400 },
    4000,
  ).next()!;
  const highOverhead = new SummaryPlanner(
    rows,
    {},
    { kind: "prompt", actualTokens: 100000, gap: 6400 },
    4000,
  ).next()!;
  assert.equal(known.groupsPreserved, 2);
  assert.equal(highOverhead.groupsPreserved, 1);
});
