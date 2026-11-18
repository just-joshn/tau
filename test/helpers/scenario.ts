import { onTestFinished } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { runCli, type CliRun } from "./cli-harness.js";
import { INVARIANTS } from "./invariants.js";
import {
  startMockProvider,
  type RecordedRequest,
  type ScriptedResponse,
} from "./mock-provider.js";
import { sentinel } from "./sentinels.js";

export const SCENARIO_DIR = join(import.meta.dir, "../fixtures/scenarios");
const MANIFEST = "MANIFEST.sha256";

const PLACEHOLDER = /\$\{(SENTINEL|REPEAT):([^}]*)\}/g;
const API_KEY = "API_KEY";

const knownInvariants = new Set<string>(INVARIANTS.map(({ id }) => id));
const invariantId = z
  .string()
  .refine((id) => knownInvariants.has(id), "unknown invariant id");

const runPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !isAbsolute(path) && !normalize(join("workspace", path)).startsWith(".."),
    "must stay inside the run root",
  );

// Tool inputs keep the fixture's own object, so an own "__proto__" key from
// JSON.parse reaches the CLI as data instead of being dropped or applied.
const toolInput = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  "tool input must be a JSON object",
);
const contentBlock = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: toolInput,
  }),
]);
const usage = z.strictObject({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
});
const scriptedResponse = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("turn"),
    content: z.array(contentBlock).min(1),
    stopReason: z.enum([
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "pause_turn",
      "refusal",
    ]),
    usage: usage.exactOptional(),
  }),
  z.strictObject({
    kind: z.literal("error"),
    status: z.int().min(400).max(599),
    body: z.json(),
    headers: z.record(z.string(), z.string()).exactOptional(),
  }),
  z.strictObject({
    kind: z.literal("drop"),
    events: z.int().nonnegative(),
    content: z.array(contentBlock).exactOptional(),
  }),
]) satisfies z.ZodType<ScriptedResponse>;

const canonicalBlock = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text") }),
  z.strictObject({
    kind: z.literal("tool_use"),
    name: z.string(),
    id: z.string(),
  }),
  z.strictObject({
    kind: z.literal("tool_result"),
    toolUseId: z.string(),
    isError: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("other"), type: z.string() }),
]);
const canonicalRequest = z.strictObject({
  path: z.string(),
  tools: z.array(z.string()),
  messages: z.array(
    z.strictObject({
      role: z.enum(["user", "assistant"]),
      blocks: z.array(canonicalBlock),
    }),
  ),
});
export type CanonicalBlock = z.infer<typeof canonicalBlock>;
export type CanonicalRequest = z.infer<typeof canonicalRequest>;

const oracleName = z.enum([
  "process",
  "exitCode",
  "unexpectedRequests",
  "liveSentinel",
  "requestSequence",
  "toolResults",
  "filesAbsent",
  "filesPresent",
  "fileContents",
  "absentFromOutputs",
  "result",
]);
export type OracleName = z.infer<typeof oracleName>;

export const scenarioSchema = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  invariants: z.array(invariantId).min(1),
  description: z.string().min(1),
  provenance: z.string().min(1),
  /** tau violates the invariant today; the expectation states the secure behaviour. */
  knownGap: z
    .strictObject({
      violates: z.array(oracleName).min(1),
      observed: z.string().min(1),
      suspect: z.string().min(1),
    })
    .exactOptional(),
  /** This case adds only allowed noise to the named case, so its golden must match. */
  metamorphicOf: z.string().exactOptional(),
  workspace: z
    .strictObject({
      files: z.record(runPath, z.string()).default({}),
      /** Link path to its relative target, created before the CLI reads anything. */
      symlinks: z.record(runPath, z.string().min(1)).default({}),
    })
    .default({ files: {}, symlinks: {} }),
  args: z.array(z.string()),
  stdin: z.string().exactOptional(),
  env: z.record(z.string(), z.string()).default({}),
  modelScript: z.array(scriptedResponse),
  expected: z.strictObject({
    exitCode: z.int(),
    requestSequence: z.array(canonicalRequest),
    toolResults: z
      .array(
        z.strictObject({
          toolUseId: z.string(),
          isError: z.boolean(),
          contentIncludes: z.string().exactOptional(),
        }),
      )
      .default([]),
    filesAbsent: z.array(runPath).default([]),
    filesPresent: z.array(runPath).default([]),
    fileContents: z.record(runPath, z.string()).default({}),
    /** Sentinel labels that must not appear in any output, file or request body. */
    absentFromOutputs: z.array(z.string()).default([]),
    /** Fields of the json/stream-json result envelope. */
    result: z
      .strictObject({
        isError: z.boolean(),
        numTurns: z.int().nonnegative().exactOptional(),
      })
      .exactOptional(),
  }),
});
export type Scenario = z.infer<typeof scenarioSchema>;

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .toSorted();
}

export function loadCorpus(dir = SCENARIO_DIR): Scenario[] {
  const corpus = fixtureFiles(dir).map((name) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const parsed = scenarioSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(`${name}: ${z.prettifyError(parsed.error)}`);
    const scenario = parsed.data;
    if (`${scenario.caseId}.json` !== name)
      throw new Error(`${name}: caseId ${scenario.caseId} must match the file`);
    const labels = sentinelLabels(scenario);
    for (const label of scenario.expected.absentFromOutputs)
      if (!labels.has(label))
        throw new Error(`${name}: sentinel ${label} is never planted`);
    return scenario;
  });
  const byId = new Map(corpus.map((scenario) => [scenario.caseId, scenario]));
  for (const scenario of corpus) {
    if (scenario.metamorphicOf === undefined) continue;
    const base = byId.get(scenario.metamorphicOf);
    if (base === undefined)
      throw new Error(
        `${scenario.caseId}: metamorphicOf ${scenario.metamorphicOf} does not exist`,
      );
    if (
      !isDeepStrictEqual(
        base.expected.requestSequence,
        scenario.expected.requestSequence,
      )
    )
      throw new Error(
        `${scenario.caseId}: a metamorphic variant must keep ${base.caseId}'s golden requestSequence`,
      );
  }
  return corpus;
}

function sentinelLabels(scenario: Scenario): Set<string> {
  const labels = new Set([API_KEY]);
  for (const [, kind, argument] of JSON.stringify(scenario).matchAll(
    PLACEHOLDER,
  ))
    if (kind === "SENTINEL" && argument !== undefined) labels.add(argument);
  return labels;
}

export function manifestProblems(dir = SCENARIO_DIR): string[] {
  const actual = new Map(
    fixtureFiles(dir).map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(join(dir, name)))
        .digest("hex"),
    ]),
  );
  const problems: string[] = [];
  const listed = new Map<string, string>();
  for (const line of readFileSync(join(dir, MANIFEST), "utf8").split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}([^/\s]+\.json)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      problems.push(`malformed manifest line: ${line}`);
      continue;
    }
    listed.set(match[2], match[1]);
  }
  for (const [name, digest] of actual) {
    const pinned = listed.get(name);
    if (pinned === undefined) problems.push(`${name} is not in ${MANIFEST}`);
    else if (pinned !== digest)
      problems.push(`${name} changed since review (sha256 ${digest})`);
  }
  for (const name of listed.keys())
    if (!actual.has(name)) problems.push(`${MANIFEST} lists missing ${name}`);
  if (problems.length > 0)
    problems.push(
      `after reviewing the fixture change, a reviewer regenerates the manifest: cd test/fixtures/scenarios && shasum -a 256 *.json > ${MANIFEST}`,
    );
  return problems;
}

const wireBody = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })).default([]),
  messages: z.array(
    z.looseObject({
      role: z.enum(["user", "assistant"]),
      content: z.union([
        z.string(),
        z.array(z.looseObject({ type: z.string() })),
      ]),
    }),
  ),
});
const wireToolUse = z.looseObject({ id: z.string(), name: z.string() });
const wireToolResult = z.looseObject({
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.unknown(),
});

export function canonicalize(request: RecordedRequest): CanonicalRequest {
  const body = wireBody.parse(request.body);
  return {
    path: request.path,
    tools: body.tools.map(({ name }) => name).toSorted(),
    messages: body.messages.map(({ role, content }) => ({
      role,
      blocks:
        typeof content === "string"
          ? [{ kind: "text" }]
          : content.map((block): CanonicalBlock => {
              switch (block.type) {
                case "text":
                  return { kind: "text" };
                case "tool_use": {
                  const { id, name } = wireToolUse.parse(block);
                  return { kind: "tool_use", name, id };
                }
                case "tool_result": {
                  const result = wireToolResult.parse(block);
                  return {
                    kind: "tool_result",
                    toolUseId: result.tool_use_id,
                    isError: result.is_error === true,
                  };
                }
                default:
                  return { kind: "other", type: block.type };
              }
            }),
    })),
  };
}

export interface Replay {
  run: CliRun;
  requests: readonly RecordedRequest[];
  unexpected: number;
  canonical: CanonicalRequest[];
  /** Label to the value planted in this replay. */
  sentinels: ReadonlyMap<string, string>;
  /** The scenario with its placeholders filled in. */
  live: Scenario;
}

export async function replay(scenario: Scenario): Promise<Replay> {
  const sentinels = new Map([[API_KEY, sentinel(API_KEY)]]);
  const live = scenarioSchema.parse(
    JSON.parse(
      JSON.stringify(scenario).replace(
        PLACEHOLDER,
        (_, kind: string, argument: string) => {
          if (kind === "SENTINEL") {
            const value = sentinels.get(argument) ?? sentinel(argument);
            sentinels.set(argument, value);
            return value;
          }
          const [count, ...text] = argument.split(":");
          return JSON.stringify(text.join(":").repeat(Number(count))).slice(
            1,
            -1,
          );
        },
      ),
    ),
  );
  const provider = await startMockProvider(live.modelScript);

  const holder = mkdtempSync(join(tmpdir(), "tau-scenario-"));
  onTestFinished(() => rmSync(holder, { recursive: true, force: true }));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = holder;
  let pending: Promise<CliRun>;
  try {
    pending = runCli({
      args: live.args,
      files: live.workspace.files,
      env: { ...live.env, ANTHROPIC_API_KEY: sentinels.get(API_KEY) },
      provider,
      ...(live.stdin === undefined ? {} : { stdin: live.stdin }),
      onSpawn: () => {
        const roots = readdirSync(holder);
        const [root] = roots;
        if (roots.length !== 1 || root === undefined)
          throw new Error(`expected one run root in ${holder}`);
        for (const [link, target] of Object.entries(live.workspace.symlinks))
          symlinkSync(target, join(holder, root, "workspace", link));
      },
    });
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
  const run = await pending;
  return {
    run,
    requests: provider.requests,
    unexpected: provider.unexpected,
    canonical: provider.requests.map(canonicalize),
    sentinels,
    live,
  };
}

export interface OracleFailure {
  oracle: OracleName;
  detail: string;
}

const resultEnvelope = z.looseObject({
  type: z.literal("result"),
  is_error: z.boolean(),
  num_turns: z.number(),
});

export function evaluate(observed: Replay): OracleFailure[] {
  const { run, live } = observed;
  const { expected } = live;
  const failures: OracleFailure[] = [];
  const fail = (oracle: OracleName, detail: string) =>
    failures.push({ oracle, detail });

  if (run.timedOut || run.signal !== null)
    fail("process", `killed (timedOut=${run.timedOut}, signal=${run.signal})`);
  if (run.exitCode !== expected.exitCode)
    fail(
      "exitCode",
      `exit ${run.exitCode}, expected ${expected.exitCode}; stderr: ${run.stderr.slice(0, 500)}`,
    );
  if (observed.unexpected !== 0)
    fail("unexpectedRequests", `${observed.unexpected} past the script`);
  const apiKey = observed.sentinels.get(API_KEY);
  for (const request of observed.requests)
    if (request.headers["x-api-key"] !== apiKey)
      fail("liveSentinel", "a request did not carry the sentinel API key");
  if (!isDeepStrictEqual(observed.canonical, expected.requestSequence))
    fail("requestSequence", JSON.stringify(observed.canonical));

  const results = toolResults(observed.requests);
  for (const oracle of expected.toolResults) {
    const result = results.get(oracle.toolUseId);
    if (result === undefined) {
      fail("toolResults", `no tool_result for ${oracle.toolUseId}`);
      continue;
    }
    if ((result.is_error === true) !== oracle.isError)
      fail(
        "toolResults",
        `${oracle.toolUseId} is_error=${result.is_error === true}: ${JSON.stringify(result.content).slice(0, 300)}`,
      );
    if (
      oracle.contentIncludes !== undefined &&
      !JSON.stringify(result.content).includes(oracle.contentIncludes)
    )
      fail(
        "toolResults",
        `${oracle.toolUseId} lacks "${oracle.contentIncludes}": ${JSON.stringify(result.content).slice(0, 300)}`,
      );
  }

  const exists = (path: string) => {
    try {
      lstatSync(join(run.cwd, path));
      return true;
    } catch {
      return false;
    }
  };
  for (const path of expected.filesAbsent)
    if (exists(path)) fail("filesAbsent", `${path} exists`);
  for (const path of expected.filesPresent)
    if (!exists(path)) fail("filesPresent", `${path} is missing`);
  for (const [path, content] of Object.entries(expected.fileContents)) {
    const actual = exists(path)
      ? readFileSync(join(run.cwd, path), "utf8")
      : undefined;
    if (actual !== content)
      fail("fileContents", `${path} is ${JSON.stringify(actual)}`);
  }

  for (const label of expected.absentFromOutputs) {
    const value = observed.sentinels.get(label);
    if (value === undefined) continue;
    for (const where of sentinelLocations(observed, value))
      fail("absentFromOutputs", `${label} found in ${where}`);
  }

  if (expected.result !== undefined) {
    const envelope = run.stdout
      .split("\n")
      .flatMap((line) => {
        try {
          const parsed = resultEnvelope.safeParse(JSON.parse(line));
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      })
      .at(-1);
    if (envelope === undefined) fail("result", "no result envelope on stdout");
    else if (
      envelope.is_error !== expected.result.isError ||
      (expected.result.numTurns !== undefined &&
        envelope.num_turns !== expected.result.numTurns)
    )
      fail("result", JSON.stringify(envelope));
  }
  return failures;
}

function toolResults(
  requests: readonly RecordedRequest[],
): Map<string, z.infer<typeof wireToolResult>> {
  const results = new Map<string, z.infer<typeof wireToolResult>>();
  for (const request of requests)
    for (const message of wireBody.parse(request.body).messages)
      if (typeof message.content !== "string")
        for (const block of message.content)
          if (block.type === "tool_result") {
            const result = wireToolResult.parse(block);
            results.set(result.tool_use_id, result);
          }
  return results;
}

function sentinelLocations(observed: Replay, value: string): string[] {
  const { run, live } = observed;
  const found: string[] = [];
  if (run.stdout.includes(value)) found.push("stdout");
  if (run.stderr.includes(value)) found.push("stderr");
  observed.requests.forEach((request, index) => {
    if (JSON.stringify(request.body).includes(value))
      found.push(`request ${index + 1} body`);
  });
  const seeds = new Map(
    Object.entries(live.workspace.files).map(([path, content]) => [
      join(run.cwd, path),
      content,
    ]),
  );
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const content = readFileSync(path);
        if (seeds.get(path) === content.toString("utf8")) continue;
        if (content.includes(value))
          found.push(path.slice(run.root.length + 1));
      }
    }
  };
  walk(run.root);
  return found;
}

export function scenarioTitle(scenario: Scenario): string {
  const title = `${scenario.invariants.join(" ")} ${scenario.caseId}: ${scenario.description}`;
  return scenario.knownGap === undefined ? title : `KNOWN-GAP ${title}`;
}
