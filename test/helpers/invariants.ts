// The strategy's invariants (docs/STRATEGY.md section 3 of the reference
// strategy) as they apply to tau, with the kind of evidence each one needs.

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type InvariantId = `INV-${"0" | "1"}${Digit}`;
export type Severity = "P0" | "P1";
export type Evidence =
  /** Deterministic tests in this suite name the invariant. */
  | { kind: "tests" }
  /** A script outside bun test proves it. */
  | { kind: "script"; path: string }
  /** Only a judged live run can show it. */
  | { kind: "live-eval"; reason: string }
  | { kind: "not-applicable"; reason: string };

export interface Invariant {
  id: InvariantId;
  severity: Severity;
  statement: string;
  /** What the invariant means for tau, when tau's own tests can check it. */
  tau?: string;
  evidence: Evidence;
}

export const INVARIANTS = [
  {
    id: "INV-01",
    severity: "P0",
    statement: "No tool outside the caller's explicit scope can execute.",
    tau: "--tools, --allowed-tools, --disallowed-tools, permission modes and print-mode denial gate every tool call before it executes.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-02",
    severity: "P0",
    statement:
      "Tool arguments match their schema and size limits before invocation.",
    tau: "Tool input schemas reject missing, mistyped, oversized and prototype-polluting arguments before any side effect.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-03",
    severity: "P0",
    statement:
      "Untrusted source text cannot change permissions or instructions.",
    tau: "File contents, tool and MCP results and model text cannot change the permission mode, allowlists or settings.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-04",
    severity: "P0",
    statement: "Secrets are excluded from logs and traces.",
    tau: "The API key and auth headers never reach stdout, stderr, session files or diagnostics, including provider error echoes.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-05",
    severity: "P0",
    statement: "Network egress cannot reach internal endpoints.",
    evidence: {
      kind: "not-applicable",
      reason:
        "tau has no model-controlled fetch or browser tool. The provider base URL is operator configuration, model-directed egress exists only through Bash, which INV-01 gates, and network-layer egress control belongs to an OS sandbox outside tau.",
    },
  },
  {
    id: "INV-06",
    severity: "P0",
    statement: "File and process actions stay within the approved workspace.",
    tau: "Read, Write, Edit, Glob and Grep outside the working directories, traversal, symlink escapes and protected paths need permission and are denied without it. Grep passes patterns as argv data.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-07",
    severity: "P0",
    statement:
      "Every side effect has a unique invocation identity and safe retry semantics.",
    tau: "Each tool_use id executes at most once. Provider retries, fallbacks and continuations never replay a completed tool call.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-08",
    severity: "P1",
    statement: "A citation refers to a source returned in this run.",
    tau: "Every tool_result refers to a tool_use id issued in this run. Stale or foreign ids are dropped before the next request.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-09",
    severity: "P1",
    statement: "Output claims are supported by cited evidence.",
    evidence: {
      kind: "live-eval",
      reason: "Semantic support needs a judged live run (evals/live).",
    },
  },
  {
    id: "INV-10",
    severity: "P0",
    statement: "Budgets are never bypassed.",
    tau: "--max-turns, --max-api-attempts, --max-retries, output-limit continuations, read and write byte limits and Glob and Grep work budgets stop work at the limit.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-11",
    severity: "P0",
    statement: "Cancellation stops new actions and child processes are reaped.",
    tau: "SIGINT during a model stream or tool run stops further requests and tool calls and kills Bash and hook children.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-12",
    severity: "P1",
    statement: "Agent trace and controlled replay are deterministic.",
    tau: "The same scenario fixture yields the same canonical request sequence, tool outcomes and result envelope.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-13",
    severity: "P1",
    statement: "Failed or partial tools do not become false success.",
    tau: "Tool errors become is_error results. Provider failure, truncation or exhaustion ends non-zero with an error result, or, when closed blocks were recovered (docs/stream-recovery-contract.md), exits 0 with the result flagged is_partial: true and an incomplete-response warning. It never ends as an unflagged success.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-14",
    severity: "P1",
    statement: "Concurrent runs do not share state or credentials.",
    tau: "Concurrent CLI sessions with separate homes and workspaces keep separate session files, permissions and outputs.",
    evidence: { kind: "tests" },
  },
  {
    id: "INV-15",
    severity: "P1",
    statement: "The portable node:* surface works on supported Node.",
    tau: "The Node-targeted bundle of the CLI runs help, version, a usage error and a scripted provider round trip.",
    evidence: { kind: "script", path: "scripts/node-smoke.mjs" },
  },
] as const satisfies readonly Invariant[];
