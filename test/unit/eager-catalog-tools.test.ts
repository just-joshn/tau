import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  bindGuardedTool,
  type GuardedToolHost,
} from "../../src/guarded-tool.js";
import {
  EMPTY_AGENT_LISTING,
  LIST_AGENTS_SEARCH_HINT,
  LIST_AGENTS_TOOL,
  listAgentsDefinition,
  listAgentsTool,
} from "../../src/list-agents-tool.js";
import {
  REPORT_FINDINGS_SEARCH_HINT,
  REPORT_FINDINGS_TOOL,
  reportFindingsDefinition,
  reportFindingsText,
  reportFindingsTool,
} from "../../src/report-findings-tool.js";
import {
  SCHEDULE_WAKEUP_SEARCH_HINT,
  SCHEDULE_WAKEUP_TOOL,
  WAKEUP_AGED_OUT_TEXT,
  WAKEUP_DELAY_REASON_REQUIRED,
  WAKEUP_PLUGIN_BLOCKED,
  WAKEUP_PROMPT_REQUIRED,
  clampWakeupDelay,
  scheduleWakeup,
  scheduleWakeupDefinition,
  scheduleWakeupScheduledText,
  scheduleWakeupStopText,
  scheduleWakeupTool,
  type WakeupBook,
} from "../../src/schedule-wakeup-tool.js";
import {
  deferredToolsDelta,
  searchTools,
  toolCatalog,
} from "../../src/tool-search.js";
import type { ToolDefinition, ToolUse } from "../../src/types.js";
import {
  WORKFLOW_REVIEW_PROMPT,
  WORKFLOW_SEARCH_HINT,
  WORKFLOW_TOOL,
  workflowDefinition,
  workflowTool,
} from "../../src/workflow-tool.js";
import oracle from "../fixtures/eager-catalog-tools.json";

const host = (
  mode: "bypassPermissions" | "default" = "bypassPermissions",
  approve: GuardedToolHost["approve"] = async () => true,
): GuardedToolHost => ({
  mode: () => mode,
  policy: () => ({ allowedTools: [], disallowedTools: [] }),
  hooks: () => undefined,
  approve,
});

async function call(
  runner: ReturnType<typeof bindGuardedTool>,
  input: unknown,
) {
  const use: ToolUse = {
    type: "tool_use",
    id: "toolu_test",
    name: runner.name,
    input,
  };
  return runner.execute(use, AbortSignal.timeout(2000));
}

const definitions = (): ToolDefinition[] => [
  listAgentsDefinition(),
  reportFindingsDefinition(),
  scheduleWakeupDefinition(),
  workflowDefinition(),
];

test("schemas match the 2.1.326 first-request tools", () => {
  assert.deepEqual(listAgentsDefinition(), oracle.ListAgents);
  assert.deepEqual(reportFindingsDefinition(), oracle.ReportFindings);
  assert.deepEqual(scheduleWakeupDefinition(), oracle.ScheduleWakeup);
  assert.deepEqual(workflowDefinition(), oracle.Workflow);
});

test("the four tools stay eager, and select: reports them already loaded", () => {
  const catalog = toolCatalog(definitions());
  assert.deepEqual(
    catalog.map((entry) => [entry.definition.name, entry.loading]),
    [
      [LIST_AGENTS_TOOL, "eager"],
      [REPORT_FINDINGS_TOOL, "eager"],
      [SCHEDULE_WAKEUP_TOOL, "eager"],
      [WORKFLOW_TOOL, "eager"],
    ],
  );
  assert.equal(
    deferredToolsDelta(
      catalog
        .filter((entry) => entry.loading === "deferred")
        .map((entry) => entry.definition.name),
      [],
    ),
    undefined,
  );
  const loaded = searchTools(
    "select:ListAgents,ReportFindings,ScheduleWakeup,Workflow",
    [],
    definitions().map((definition) => definition.name),
  );
  assert.deepEqual(loaded.matches, []);
  assert.deepEqual(loaded.alreadyLoaded, [
    LIST_AGENTS_TOOL,
    REPORT_FINDINGS_TOOL,
    SCHEDULE_WAKEUP_TOOL,
    WORKFLOW_TOOL,
  ]);
  const deferred = searchTools(
    "select:ReportFindings,Workflow",
    [
      {
        definition: reportFindingsDefinition(),
        loading: "deferred",
        searchHint: REPORT_FINDINGS_SEARCH_HINT,
      },
      {
        definition: workflowDefinition(),
        loading: "deferred",
        searchHint: WORKFLOW_SEARCH_HINT,
      },
    ],
    [],
  );
  assert.deepEqual(deferred.matches, [REPORT_FINDINGS_TOOL, WORKFLOW_TOOL]);
  assert.deepEqual(deferred.alreadyLoaded, []);
  assert.equal(LIST_AGENTS_SEARCH_HINT, "list agents you can SendMessage to");
  assert.equal(
    SCHEDULE_WAKEUP_SEARCH_HINT,
    "self-pace the dynamic /loop: pick a delay before the next tick, or stop/end/cancel the dynamic loop with stop:true (a fixed-interval /loop is a recurring cron \u2014 cancel it with CronDelete)",
  );
});

test("ListAgents returns the empty listing", async () => {
  const result = await call(bindGuardedTool(listAgentsTool(), host()), {
    channel: "local",
  });
  assert.equal(result.is_error, undefined);
  assert.equal(result.content, EMPTY_AGENT_LISTING);
});

test("ReportFindings counts verified rows", async () => {
  const none = await call(bindGuardedTool(reportFindingsTool(), host()), {
    findings: [],
  });
  assert.equal(none.content, reportFindingsText(0));
  const one = await call(bindGuardedTool(reportFindingsTool(), host()), {
    level: "high",
    findings: [
      {
        file: "src/a.ts",
        summary: "Off by one",
        failure_scenario: "n = 0 returns the last row",
      },
    ],
  });
  assert.equal(one.content, "1 finding reported.");
  assert.equal(reportFindingsText(2), "2 findings reported.");
});

test("ScheduleWakeup clamps, stops, and refuses a blocked plugin", async () => {
  const now = 1_700_000_000_000;
  const clamped = clampWakeupDelay(120, now);
  assert.equal(clamped.wasClamped, false);
  assert.equal(clamped.clampedDelaySeconds, 120);
  assert.equal(clamped.scheduledFor, 1_700_000_160_000);
  assert.deepEqual(clampWakeupDelay(10, now), {
    clampedDelaySeconds: 60,
    wasClamped: true,
    scheduledFor: 1_700_000_100_000,
  });

  const tool = scheduleWakeupTool({ now: () => now });
  const scheduled = await call(bindGuardedTool(tool, host()), {
    delaySeconds: 120,
    reason: "watching CI",
    prompt: "/loop check the run",
    noop: false,
  });
  assert.equal(
    scheduled.content,
    scheduleWakeupScheduledText({ ...clamped, now }),
  );
  const stopped = await call(bindGuardedTool(tool, host()), { stop: true });
  assert.equal(stopped.content, scheduleWakeupStopText(1));
  const idle = await call(
    bindGuardedTool(scheduleWakeupTool({ now: () => now }), host()),
    { stop: true },
  );
  assert.equal(idle.content, scheduleWakeupStopText(0));

  const missing = await call(bindGuardedTool(scheduleWakeupTool(), host()), {});
  assert.equal(missing.is_error, true);
  assert.equal(missing.content, WAKEUP_DELAY_REASON_REQUIRED);
  const noPrompt = await call(bindGuardedTool(scheduleWakeupTool(), host()), {
    delaySeconds: 120,
    reason: "watching CI",
  });
  assert.equal(noPrompt.content, WAKEUP_PROMPT_REQUIRED);
  const blocked = await call(
    bindGuardedTool(scheduleWakeupTool({ pluginBlocksSchedule: true }), host()),
    { delaySeconds: 120, reason: "watching CI", prompt: "again" },
  );
  assert.equal(blocked.content, WAKEUP_PLUGIN_BLOCKED);
  const stopAnyway = await call(
    bindGuardedTool(scheduleWakeupTool({ pluginBlocksSchedule: true }), host()),
    { stop: true },
  );
  assert.equal(stopAnyway.is_error, undefined);

  const stale: WakeupBook = {
    chains: new Map([
      [
        "old",
        {
          startedAt: now - 8 * 24 * 60 * 60 * 1000,
          lastScheduledFor: now - 1000,
          agedOut: false,
        },
      ],
    ]),
    pending: [],
  };
  const aged = scheduleWakeup(
    stale,
    { delaySeconds: 120, reason: "still here", prompt: "old" },
    now,
  );
  assert.equal(aged.kind, "aged_out");
  const agedCall = await call(
    bindGuardedTool(
      scheduleWakeupTool({ now: () => now, initial: stale }),
      host(),
    ),
    { delaySeconds: 120, reason: "still here", prompt: "old" },
  );
  assert.equal(agedCall.content, WAKEUP_AGED_OUT_TEXT);
});

test("Workflow rejects a missing source and does not launch a script", async () => {
  const missing = await call(bindGuardedTool(workflowTool(), host()), {});
  assert.match(
    String(missing.content),
    /Must provide script, name, or scriptPath/,
  );
  let prompt = "";
  const reviewed = await call(
    bindGuardedTool(
      workflowTool(),
      host("default", async (asked) => {
        prompt = asked;
        return true;
      }),
    ),
    {
      script:
        "export const meta = { name: 'review', description: 'Review' }\nreturn { ok: true }",
    },
  );
  assert.equal(prompt, WORKFLOW_REVIEW_PROMPT);
  assert.match(String(reviewed.content), /"kind":"completed"/);

  const named = await call(bindGuardedTool(workflowTool(), host()), {
    name: "review-changes",
  });
  assert.match(
    String(named.content),
    /Workflow "review-changes" not found\. Available: \(none\)/,
  );

  const directory = await mkdtemp(join(tmpdir(), "tau-workflow-"));
  const missingFile = await call(bindGuardedTool(workflowTool(), host()), {
    scriptPath: join(directory, "missing.js"),
  });
  assert.match(String(missingFile.content), /Workflow script file not found:/);

  const launched = await call(bindGuardedTool(workflowTool(), host()), {
    script:
      "export const meta = { name: 'review', description: 'Review' }\nreturn { ok: true }",
  });
  assert.notEqual(launched.is_error, true);
  assert.match(String(launched.content), /"result":\{"ok":true\}/);

  const scriptPath = join(directory, "flow.js");
  await writeFile(
    scriptPath,
    "export const meta = { name: 'review', description: 'Review' }\n",
  );
  const fromFile = await call(bindGuardedTool(workflowTool(), host()), {
    scriptPath,
    name: "ignored-because-path-wins",
  });
  assert.match(String(fromFile.content), /"kind":"completed"/);
});

test("Workflow resolves named files under the workflows dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-workflow-named-"));
  const dir = join(root, "workflows");
  const script = (name: string) =>
    `export const meta = { name: '${name}', description: 'd' }\nreturn 1`;
  const empty = await call(
    bindGuardedTool(workflowTool({ workflowsDir: dir }), host()),
    { name: "alpha" },
  );
  assert.match(String(empty.content), /Available: \(none\)/);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.js"), script("alpha"));
  await writeFile(join(dir, "b.js"), script("beta"));
  await writeFile(join(dir, "bad.js"), "return 1");
  await writeFile(join(dir, "c.mjs"), script("gamma"));
  const tool = () =>
    bindGuardedTool(workflowTool({ workflowsDir: dir }), host());
  const ok = await call(tool(), { name: "alpha" });
  assert.match(String(ok.content), /"kind":"completed"/);
  const wrong = await call(tool(), { name: "zeta" });
  assert.match(
    String(wrong.content),
    /Workflow "zeta" not found\. Available: alpha, beta/,
  );
  const direct = join(root, "direct.js");
  await writeFile(direct, "export const meta = { name: 'direct', description: 'd' }\nreturn 2");
  const bare = join(root, "bare.js");
  await writeFile(bare, "return 2");
  const bareResult = await call(tool(), { scriptPath: bare });
  assert.match(String(bareResult.content), /must be the FIRST statement/);
  const winner = await call(tool(), { name: "zeta", scriptPath: direct });
  assert.match(String(winner.content), /"kind":"completed"/);
});
