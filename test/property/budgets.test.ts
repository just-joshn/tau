import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import { runAgent } from "../../src/agent.js";
import {
  ApiAttemptBudget,
  ApiAttemptBudgetExhausted,
  RequestAttemptLedger,
} from "../../src/attempt-ledger.js";
import { AnthropicProvider } from "../../src/provider.js";
import type { RecoveryFailure } from "../../src/recovery.js";
import type { ToolExecutor } from "../../src/types.js";
import { forAll, type Rng } from "../helpers/seeded.js";

// docs/attempt-ledger-contract.md: the attempt allowance is decremented
// before each dispatch, refuses at zero and is shared with child allowances;
// ordinary retries are capped by maxRetries; fallback happens at most once.
// docs/retry-contract.md: --max-turns bounds model rounds, not HTTP attempts.

type Failure = Exclude<RecoveryFailure, { kind: "streamFailed" }>;
type Op =
  | { kind: "attempt"; ledger: number }
  | { kind: "retry"; ledger: number; failure: Failure }
  | { kind: "fallback"; ledger: number };

interface LedgerCase {
  parent: number | undefined;
  children: Array<{ count: number; maxRetries: number }>;
  ops: Op[];
}

function failure(rng: Rng): Failure {
  return rng.bool()
    ? {
        kind: "noResponse",
        suspended: false,
        networkDown: false,
        turnedAwayOverloaded: false,
      }
    : {
        kind: "httpError",
        status: rng.pick([408, 409, 429, 500, 502, 503]),
        fallbackModelCouldHelp: false,
      };
}

function generateLedger(rng: Rng): LedgerCase {
  const children = Array.from({ length: rng.int(1, 3) }, () => ({
    count: rng.int(0, 8),
    maxRetries: rng.int(0, 15),
  }));
  return {
    parent: rng.bool(0.7) ? rng.int(0, 12) : undefined,
    children,
    ops: Array.from({ length: rng.int(1, 60) }, (): Op => {
      const ledger = rng.int(0, children.length - 1);
      const kind = rng.pick([
        "attempt",
        "attempt",
        "retry",
        "fallback",
      ] as const);
      return kind === "retry"
        ? { kind, ledger, failure: failure(rng) }
        : { kind, ledger };
    }),
  };
}

test("INV-10 attempt allowances, retries and fallback never exceed their limits", async () => {
  await forAll("attempt ledger budgets", 500, generateLedger, (input) => {
    const parent =
      input.parent === undefined
        ? undefined
        : new ApiAttemptBudget(input.parent);
    const budgets = input.children.map(({ count }) =>
      parent ? parent.child(count) : new ApiAttemptBudget(count),
    );
    const ledgers = input.children.map(
      ({ maxRetries }, index) =>
        new RequestAttemptLedger(maxRetries, budgets[index]),
    );
    const taken = input.children.map(() => 0);
    const retried = input.children.map(() => 0);
    const fallbacks = input.children.map(() => 0);
    for (const op of input.ops) {
      const ledger = ledgers[op.ledger];
      const budget = budgets[op.ledger];
      if (!ledger || !budget) throw new Error("bad ledger index");
      const before = budget.remaining;
      try {
        if (op.kind === "attempt") {
          ledger.takeAttempt();
          taken[op.ledger] = (taken[op.ledger] ?? 0) + 1;
          assert.ok(before > 0, "an attempt was admitted at zero allowance");
        } else if (op.kind === "retry") {
          if (ledger.retry(op.failure)) {
            retried[op.ledger] = (retried[op.ledger] ?? 0) + 1;
            assert.ok(before > 0, "a retry was admitted at zero allowance");
          }
        } else if (ledger.fallback())
          fallbacks[op.ledger] = (fallbacks[op.ledger] ?? 0) + 1;
      } catch (error) {
        assert.ok(error instanceof ApiAttemptBudgetExhausted, String(error));
        assert.equal(before, 0, "exhaustion reported with allowance left");
      }
      assert.ok(budget.remaining >= 0);
    }
    const total = taken.reduce((sum, value) => sum + value, 0);
    if (input.parent !== undefined) {
      assert.ok(
        total <= input.parent,
        `${total} attempts > parent ${input.parent}`,
      );
      assert.equal(parent?.remaining, input.parent - total);
    }
    for (const [index, child] of input.children.entries()) {
      const count = taken[index] ?? 0;
      assert.ok(count <= child.count, `${count} attempts > ${child.count}`);
      assert.ok((retried[index] ?? 0) <= child.maxRetries);
      assert.ok((fallbacks[index] ?? 0) <= 1);
      assert.equal(
        budgets[index]?.remaining,
        Math.min(
          child.count - count,
          input.parent === undefined ? Infinity : input.parent - total,
        ),
      );
    }
  });
});

// One provider response per request, chosen by the generator.
type Reply = "tool" | "end" | "fail";

interface AgentCase {
  maxTurns: number;
  maxApiAttempts: number | undefined;
  toolsPerTurn: number;
  replies: Reply[];
}

function sse(events: readonly unknown[]): string {
  return events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .map((data, index) => `event: ${eventType(events[index])}\n${data}`)
    .join("");
}

function eventType(event: unknown): string {
  return typeof event === "object" && event !== null && "type" in event
    ? String(event.type)
    : "";
}

function turn(reply: "tool" | "end", request: number, tools: number): string {
  const blocks =
    reply === "end"
      ? [{ type: "text", text: "" }]
      : Array.from({ length: tools }, (_, index) => ({
          type: "tool_use",
          id: `toolu_${request}_${index}`,
          name: "Probe",
          input: {},
        }));
  return sse([
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    ...blocks.flatMap((content_block, index) => [
      { type: "content_block_start", index, content_block },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: reply === "end" ? "end_turn" : "tool_use" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

test("INV-10 --max-turns and --max-api-attempts bound model rounds, dispatches and tool runs", async () => {
  await forAll(
    "agent budgets",
    200,
    (rng): AgentCase => ({
      maxTurns: rng.int(1, 6),
      maxApiAttempts: rng.bool(0.7) ? rng.int(0, 8) : undefined,
      toolsPerTurn: rng.int(1, 2),
      replies: Array.from({ length: 10 }, () =>
        rng.pick(["tool", "tool", "tool", "end", "fail"] as const),
      ),
    }),
    async (input) => {
      let requests = 0;
      const respond = async (): Promise<Response> => {
        const reply = input.replies[requests] ?? "tool";
        requests++;
        return reply === "fail"
          ? new Response(
              JSON.stringify({
                type: "error",
                error: { type: "invalid_request_error", message: "no" },
              }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            )
          : new Response(turn(reply, requests, input.toolsPerTurn), {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
      };
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(respond, { preconnect: globalThis.fetch.preconnect }),
      );
      let executed = 0;
      const tools: ToolExecutor = {
        definitions: [
          {
            name: "Probe",
            description: "probe",
            input_schema: { type: "object" },
          },
        ],
        execute: async (call) => {
          executed++;
          return { type: "tool_result", tool_use_id: call.id, content: "ok" };
        },
      };
      let succeeded: boolean;
      try {
        await runAgent({
          provider: new AnthropicProvider({
            apiKey: "fixture",
            baseUrl: "http://127.0.0.1:9",
            maxRetries: 0,
            allowNonStreamingFallback: false,
          }),
          tools,
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          model: "fixture",
          system: "",
          maxTokens: 100,
          maxTurns: input.maxTurns,
          ...(input.maxApiAttempts === undefined
            ? {}
            : { maxApiAttempts: input.maxApiAttempts }),
          autoCompact: false,
          signal: new AbortController().signal,
          onEvent: () => {},
        });
        succeeded = true;
      } catch {
        succeeded = false;
      } finally {
        fetchSpy.mockRestore();
      }
      // Oracle: rounds run in order until a non-tool reply, the turn limit or
      // the attempt allowance, whichever comes first.
      const limit = Math.min(input.maxTurns, input.maxApiAttempts ?? Infinity);
      const stop = input.replies.findIndex((reply) => reply !== "tool");
      const firstStop = stop < 0 ? Infinity : stop;
      const rounds = Math.min(firstStop + 1, limit);
      assert.equal(requests, rounds, "dispatches");
      const toolRounds = input.replies
        .slice(0, rounds)
        .filter((reply) => reply === "tool").length;
      assert.equal(
        executed,
        toolRounds * input.toolsPerTurn,
        "tool executions",
      );
      assert.equal(
        succeeded,
        firstStop < limit && input.replies[firstStop] === "end",
        "only an end_turn within budget is a success",
      );
    },
  );
});
