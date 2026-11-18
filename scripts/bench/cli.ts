// T7 CLI benchmark: cold `--version` start and a print-mode round trip against
// a loopback Messages API mock. Scenarios alternate run by run so warmup and
// drift favor neither. Usage:
//   bun scripts/bench/cli.ts [--runs N] [--warmup N] [--out file]
//                            [--baseline file --max-regression 0.10]
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { fixtureSse } from "../../test/helpers/sse-fixture.js";

const statsSchema = z.object({
  runs: z.number(),
  medianMs: z.number(),
  p90Ms: z.number(),
  minMs: z.number(),
  maxMs: z.number(),
  spreadMs: z.number(),
  peakRssBytes: z.number(),
  medianRssBytes: z.number(),
});
export type Stats = z.infer<typeof statsSchema>;
const reportSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  warmup: z.number(),
  metadata: z.object({
    runtime: z.string(),
    platform: z.string(),
    arch: z.string(),
    cpus: z.number(),
    cpuModel: z.string(),
    loadavgAtStart: z.array(z.number()),
    gitSha: z.string(),
  }),
  scenarios: z.record(z.string(), statsSchema),
});
export type Report = z.infer<typeof reportSchema>;
export type Regression = {
  scenario: string;
  baselineMs: number;
  currentMs: number;
  change: number;
};

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;

type Sample = { ms: number; rssBytes: number };

export function summarize(samples: readonly Sample[]): Stats {
  const ms = samples.map((sample) => sample.ms).toSorted((a, b) => a - b);
  const rss = samples
    .map((sample) => sample.rssBytes)
    .toSorted((a, b) => a - b);
  const minMs = ms[0] ?? Number.NaN;
  const maxMs = ms.at(-1) ?? Number.NaN;
  return {
    runs: samples.length,
    medianMs: percentile(ms, 0.5),
    p90Ms: percentile(ms, 0.9),
    minMs,
    maxMs,
    spreadMs: maxMs - minMs,
    peakRssBytes: rss.at(-1) ?? Number.NaN,
    medianRssBytes: percentile(rss, 0.5),
  };
}

/** Scenarios present in both reports whose median grew by more than maxRegression. */
export function regressions(
  baseline: Report,
  current: Report,
  maxRegression: number,
): Regression[] {
  return Object.entries(current.scenarios).flatMap(([scenario, stats]) => {
    const before = baseline.scenarios[scenario];
    if (!before) return [];
    const change = stats.medianMs / before.medianMs - 1;
    return change > maxRegression
      ? [
          {
            scenario,
            baselineMs: before.medianMs,
            currentMs: stats.medianMs,
            change,
          },
        ]
      : [];
  });
}

const scriptedReply = "bench reply";
const replySse = fixtureSse([
  {
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: scriptedReply },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 2 },
  },
  { type: "message_stop" },
]);

type Scenario = {
  name: string;
  args: string[];
  check: (stdout: string) => boolean;
};

async function measure(
  scenario: Scenario,
  env: Record<string, string>,
): Promise<Sample> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, ...scenario.args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const ms = performance.now() - started;
  // Q4/Q7 of the benchmark checklist: a failed or empty run is an error, not a fast sample.
  if (code !== 0 || !scenario.check(stdout))
    throw new Error(
      `${scenario.name} run failed (exit ${code}): ${stderr.slice(0, 500)}`,
    );
  const usage = child.resourceUsage();
  if (!usage) throw new Error(`${scenario.name}: no resource usage reported`);
  return { ms, rssBytes: usage.maxRSS };
}

function gitSha(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "15" },
      warmup: { type: "string", default: "3" },
      out: { type: "string" },
      baseline: { type: "string" },
      "max-regression": { type: "string", default: "0.10" },
    },
  });
  const runs = z.coerce.number().int().min(5).parse(values.runs);
  const warmup = z.coerce.number().int().min(0).parse(values.warmup);
  const maxRegression = z.coerce
    .number()
    .min(0)
    .parse(values["max-regression"]);
  const root = resolve(import.meta.dir, "../..");
  const cli = join(root, "src/cli.ts");
  const version = z
    .object({ version: z.string() })
    .parse(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    ).version;

  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      await request.arrayBuffer();
      requests++;
      return new Response(replySse, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const temp = mkdtempSync(join(tmpdir(), "tau-bench-"));
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: join(temp, "home"),
      TAU_HOME: join(temp, "state"),
      CLAUDE_CONFIG_DIR: join(temp, "user"),
      TAU_MANAGED_ROOT: join(temp, "managed"),
      ANTHROPIC_API_KEY: "TAU_SENTINEL_bench_key",
      ANTHROPIC_BASE_URL: server.url.origin,
    };
    for (const dir of ["home", "state", "user", "managed", "workspace"])
      mkdirSync(join(temp, dir));
    const scenarios: Scenario[] = [
      {
        name: "cold-version",
        args: [cli, "--version"],
        check: (stdout) => stdout.trim() === `tau ${version}`,
      },
      {
        name: "print-roundtrip",
        args: [
          cli,
          "-p",
          "hello",
          "--cwd",
          join(temp, "workspace"),
          "--output-format",
          "json",
        ],
        check: (stdout) =>
          z
            .object({
              result: z.literal(scriptedReply),
              is_error: z.literal(false),
            })
            .safeParse(JSON.parse(stdout)).success,
      },
    ];

    const metadata = {
      runtime: `bun ${Bun.version}`,
      platform: process.platform,
      arch: process.arch,
      cpus: availableParallelism(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      loadavgAtStart: loadavg(),
      gitSha: gitSha(root),
    };
    const samples = new Map<string, Sample[]>(
      scenarios.map((scenario) => [scenario.name, []]),
    );
    for (let round = 0; round < warmup + runs; round++)
      for (const scenario of scenarios) {
        const sample = await measure(scenario, env);
        if (round >= warmup) samples.get(scenario.name)?.push(sample);
      }
    const roundTrips = warmup + runs;
    if (requests !== roundTrips)
      throw new Error(
        `mock served ${requests} requests for ${roundTrips} print runs`,
      );

    const report: Report = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      warmup,
      metadata,
      scenarios: Object.fromEntries(
        [...samples].map(([name, list]) => [name, summarize(list)]),
      ),
    };
    console.log(
      `${metadata.runtime} ${metadata.platform}-${metadata.arch} ${metadata.cpus} cpus, load ${metadata.loadavgAtStart.map((n) => n.toFixed(2)).join(" ")}, ${runs} runs after ${warmup} warmup, ${requests} mock requests`,
    );
    for (const [name, stats] of Object.entries(report.scenarios))
      console.log(
        `${name.padEnd(16)} median ${stats.medianMs.toFixed(1)} ms  p90 ${stats.p90Ms.toFixed(1)}  min ${stats.minMs.toFixed(1)}  max ${stats.maxMs.toFixed(1)}  spread ${stats.spreadMs.toFixed(1)} ms  peak RSS ${mb(stats.peakRssBytes)}`,
      );
    if (values.out) {
      mkdirSync(dirname(values.out), { recursive: true });
      writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (!values.baseline) return 0;

    const baseline = reportSchema.parse(
      JSON.parse(readFileSync(values.baseline, "utf8")),
    );
    if (
      baseline.metadata.platform !== metadata.platform ||
      baseline.metadata.runtime !== metadata.runtime
    )
      console.warn(
        `warning: baseline ran on ${baseline.metadata.runtime} ${baseline.metadata.platform}; compare same-runner results only`,
      );
    const failed = regressions(baseline, report, maxRegression);
    for (const { scenario, baselineMs, currentMs, change } of failed)
      console.error(
        `REGRESSION ${scenario}: median ${baselineMs.toFixed(1)} -> ${currentMs.toFixed(1)} ms (+${(change * 100).toFixed(1)}% > ${(maxRegression * 100).toFixed(0)}%)`,
      );
    return failed.length > 0 ? 1 : 0;
  } finally {
    await server.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main();
