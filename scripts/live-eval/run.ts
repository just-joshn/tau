//   bun scripts/live-eval/run.ts [--subset NAME]... [--case ID]... [--trials N]
//     [--model ID] [--max-total-usd N] [--max-case-usd N] [--max-turns N]
//     [--cases DIR] [--out DIR]
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { redactSecrets } from "../scan-artifacts.js";
import {
  loadCases,
  subsets,
  type CaseResult,
  type LoadedCase,
} from "./schema.js";
import {
  auditPolicy,
  classifyFailure,
  costUsd,
  credentialDisclosed,
  evaluateOracle,
  finalResult,
  isPricedModel,
  parseStream,
  pricing,
  usageTotals,
  type PricedModel,
} from "./scoring.js";

const root = resolve(import.meta.dir, "../..");

type RunContext = {
  runId: string;
  harnessVersion: string;
  toolSchemaVersion: string;
  model: PricedModel;
  apiKey: string;
  maxCaseUsd: number;
  maxTurns: number;
};

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function spawnCli(
  args: string[],
  env: Record<string, string>,
  capUsd: number,
  timeoutMs: number,
  model: PricedModel,
) {
  const child = Bun.spawn(
    [process.execPath, join(root, "src/cli.ts"), ...args],
    {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let killed: "cost cap" | "timeout" | undefined;
  const timer = setTimeout(() => {
    killed ??= "timeout";
    child.kill();
  }, timeoutMs);
  const stderr = new Response(child.stderr).text();
  let stdout = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    stdout += decoder.decode(chunk, { stream: true });
    if (
      killed === undefined &&
      costUsd(usageTotals(parseStream(stdout)), model) > capUsd
    ) {
      killed = "cost cap";
      child.kill();
    }
  }
  const code = await child.exited;
  clearTimeout(timer);
  return { stdout, stderr: await stderr, code, killed };
}

function readWorkspaceFile(
  workspace: string,
  path: string,
): string | undefined {
  try {
    return readFileSync(join(workspace, path), "utf8");
  } catch {
    return undefined;
  }
}

async function runCase(
  evalCase: LoadedCase,
  trial: number,
  context: RunContext,
  out: string,
): Promise<CaseResult> {
  const temp = mkdtempSync(join(tmpdir(), "tau-live-eval-"));
  const workspace = join(temp, "workspace");
  try {
    for (const dir of ["home", "state", "user", "managed", "workspace"])
      mkdirSync(join(temp, dir));
    for (const [path, content] of Object.entries(evalCase.workspace.files)) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content);
    }
    const capUsd = Math.min(evalCase.budget.maxCostUsd, context.maxCaseUsd);
    const maxTurns = Math.min(evalCase.budget.maxTurns, context.maxTurns);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: join(temp, "home"),
      TAU_HOME: join(temp, "state"),
      CLAUDE_CONFIG_DIR: join(temp, "user"),
      TAU_MANAGED_ROOT: join(temp, "managed"),
      ANTHROPIC_API_KEY: context.apiKey,
      ...(process.env.ANTHROPIC_BASE_URL
        ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }
        : {}),
    };
    const args = [
      "-p",
      evalCase.intent,
      "--cwd",
      workspace,
      "--output-format",
      "stream-json",
      "--model",
      context.model,
      "--max-turns",
      String(maxTurns),
      "--max-tokens",
      String(evalCase.budget.maxOutputTokensPerCall),
      "--max-retries",
      "2",
      "--setting-sources",
      "",
      "--tools",
      (evalCase.exposedTools ?? evalCase.allowedTools).join(","),
      "--allowedTools",
      evalCase.allowedTools.join(","),
    ];
    const started = performance.now();
    const run = await spawnCli(
      args,
      env,
      capUsd,
      evalCase.budget.timeoutMs,
      context.model,
    );
    const durationMs = Math.round(performance.now() - started);

    const lines = parseStream(run.stdout);
    const final = finalResult(lines);
    const usage = usageTotals(lines);
    const cost = costUsd(usage, context.model);
    const audit = auditPolicy(lines, evalCase.allowedTools);
    const answer = final?.result ?? "";
    const disclosure = credentialDisclosed(answer);
    const violated = audit.executedForbiddenTools.length > 0 || disclosure;

    let status: CaseResult["status"] = "completed";
    let reason: string | undefined;
    if (run.killed) reason = `killed: ${run.killed} exceeded`;
    else if (!final) {
      reason = `no result line (exit ${run.code}): ${redactSecrets(run.stderr).slice(0, 300)}`;
      status = classifyFailure(run.stderr);
      if (status === "failed") reason = `harness ${reason}`;
    } else if (
      final.is_error &&
      final.error &&
      classifyFailure(final.error) === "inconclusive"
    ) {
      status = "inconclusive";
      reason = `provider: ${redactSecrets(final.error).slice(0, 300)}`;
    } else if (final.is_error)
      reason = `agent error: ${redactSecrets(final.error ?? "").slice(0, 300)}`;

    const oracle =
      status === "completed"
        ? evaluateOracle(
            evalCase.oracle.checks,
            answer,
            (path) => readWorkspaceFile(workspace, path),
            evalCase.workspace.files,
          )
        : [];
    const withinBudget =
      !run.killed &&
      (final?.num_turns ?? 0) <= maxTurns &&
      cost <= capUsd &&
      durationMs <= evalCase.budget.timeoutMs;
    const measured = status === "completed";
    const trace = redactSecrets(run.stdout).replaceAll(temp, "<eval-temp>");
    const traceName = `${evalCase.caseId}.t${trial}`;
    writeFileSync(join(out, "traces", `${traceName}.jsonl`), trace);

    return {
      caseId: evalCase.caseId,
      caseVersion: evalCase.version,
      subset: evalCase.subset,
      runId: context.runId,
      trial,
      harnessVersion: context.harnessVersion,
      modelId: `anthropic:${context.model}`,
      toolSchemaVersion: context.toolSchemaVersion,
      datasetVersion: `${evalCase.caseId}@v${evalCase.version}`,
      status,
      ...(reason === undefined ? {} : { reason }),
      scores: {
        taskSuccess: measured
          ? !run.killed && oracle.every((entry) => entry.passed)
            ? 1
            : 0
          : null,
        policyCompliance: violated ? 0 : measured ? 1 : null,
        budgetCompliance: measured ? (withinBudget ? 1 : 0) : null,
      },
      policy: {
        attemptedForbiddenTools: audit.attemptedForbiddenTools,
        executedForbiddenTools: audit.executedForbiddenTools,
        credentialDisclosure: disclosure,
      },
      oracle,
      usage: {
        ...usage,
        toolCalls: audit.toolCalls,
        turns: final?.num_turns ?? 0,
        costUsd: Number(cost.toFixed(6)),
        pricing: `${context.model} list price as of ${pricing.asOf}`,
      },
      durationMs,
      traceDigest: `sha256:${createHash("sha256").update(trace).digest("hex")}`,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function skipped(
  evalCase: LoadedCase,
  trial: number,
  context: RunContext,
  reason: string,
): CaseResult {
  return {
    caseId: evalCase.caseId,
    caseVersion: evalCase.version,
    subset: evalCase.subset,
    runId: context.runId,
    trial,
    harnessVersion: context.harnessVersion,
    modelId: `anthropic:${context.model}`,
    toolSchemaVersion: context.toolSchemaVersion,
    datasetVersion: `${evalCase.caseId}@v${evalCase.version}`,
    status: "skipped-budget",
    reason,
    scores: {
      taskSuccess: null,
      policyCompliance: null,
      budgetCompliance: null,
    },
    policy: {
      attemptedForbiddenTools: [],
      executedForbiddenTools: [],
      credentialDisclosure: false,
    },
    oracle: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCalls: 0,
      turns: 0,
      costUsd: 0,
      pricing: `${context.model} list price as of ${pricing.asOf}`,
    },
    durationMs: 0,
    traceDigest: "",
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      cases: { type: "string", default: join(root, "evals/live") },
      out: { type: "string", default: "eval-results" },
      subset: { type: "string", multiple: true },
      case: { type: "string", multiple: true },
      trials: { type: "string", default: "1" },
      model: { type: "string", default: "claude-opus-5-5" },
      "max-total-usd": { type: "string", default: "5" },
      "max-case-usd": { type: "string", default: "1" },
      "max-turns": { type: "string", default: "25" },
    },
  });
  const selectedSubsets = z
    .array(z.enum(subsets))
    .parse(values.subset ?? [...subsets]);
  const trials = z.coerce.number().int().min(1).max(10).parse(values.trials);
  const maxTotalUsd = z.coerce
    .number()
    .positive()
    .parse(values["max-total-usd"]);
  const maxCaseUsd = z.coerce.number().positive().parse(values["max-case-usd"]);
  const maxTurns = z.coerce.number().int().min(1).parse(values["max-turns"]);
  const model = values.model;
  if (!isPricedModel(model)) {
    console.error(
      `live-eval: no price for ${model}; refusing to run without an enforceable spend cap`,
    );
    return 2;
  }
  const cases = loadCases(values.cases, selectedSubsets).filter(
    (evalCase) => !values.case || values.case.includes(evalCase.caseId),
  );
  const out = resolve(values.out);
  mkdirSync(join(out, "results"), { recursive: true });
  mkdirSync(join(out, "traces"), { recursive: true });
  const startedAt = new Date().toISOString();
  const caps = { maxTotalUsd, maxCaseUsd, maxTurns, trials };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const summary = {
      status: "unavailable",
      reason: "ANTHROPIC_API_KEY is not set; no live measurement was taken",
      startedAt,
      model,
      caps,
      caseIds: cases.map((evalCase) => evalCase.caseId),
    };
    writeFileSync(
      join(out, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.error(`live-eval: unavailable: ${summary.reason}`);
    return 2;
  }

  const version = z
    .object({ version: z.string() })
    .parse(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    ).version;
  const context: RunContext = {
    runId: randomUUID(),
    harnessVersion: `${git(["rev-parse", "HEAD"])}${git(["status", "--porcelain"]) ? "-dirty" : ""}`,
    toolSchemaVersion: `tau-${version}`,
    model,
    apiKey,
    maxCaseUsd,
    maxTurns,
  };
  const results: CaseResult[] = [];
  let spentUsd = 0;
  for (let trial = 0; trial < trials; trial++)
    for (const evalCase of cases) {
      const reserve = Math.min(evalCase.budget.maxCostUsd, maxCaseUsd);
      const result =
        spentUsd + reserve > maxTotalUsd
          ? skipped(
              evalCase,
              trial,
              context,
              `total cap $${maxTotalUsd} leaves less than this case's $${reserve} cap`,
            )
          : await runCase(evalCase, trial, context, out);
      spentUsd += result.usage.costUsd;
      results.push(result);
      writeFileSync(
        join(out, "results", `${evalCase.caseId}.t${trial}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      console.log(
        `${result.status.padEnd(14)} ${evalCase.subset.padEnd(12)} ${evalCase.caseId.padEnd(36)} task=${result.scores.taskSuccess ?? "-"} policy=${result.scores.policyCompliance ?? "-"} budget=${result.scores.budgetCompliance ?? "-"} $${result.usage.costUsd.toFixed(4)}${result.reason ? `  ${result.reason}` : ""}`,
      );
    }

  const count = (status: CaseResult["status"]) =>
    results.filter((result) => result.status === status).length;
  const scored = results.filter((result) => result.scores.taskSuccess !== null);
  const violations = results.filter(
    (result) => result.scores.policyCompliance === 0,
  ).length;
  const incomplete = results.length - count("completed");
  const summary = {
    status:
      violations > 0
        ? "policy-violation"
        : incomplete > 0
          ? "incomplete"
          : "completed",
    runId: context.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    harnessVersion: context.harnessVersion,
    model,
    caps,
    counts: {
      total: results.length,
      completed: count("completed"),
      failed: count("failed"),
      inconclusive: count("inconclusive"),
      skippedBudget: count("skipped-budget"),
    },
    taskSuccessRate:
      scored.length > 0
        ? scored.filter((result) => result.scores.taskSuccess === 1).length /
          scored.length
        : null,
    executedPolicyViolations: violations,
    totalCostUsd: Number(spentUsd.toFixed(6)),
  };
  writeFileSync(
    join(out, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary));
  return violations > 0 ? 1 : incomplete > 0 ? 3 : 0;
}

if (import.meta.main) process.exitCode = await main();
