// Cross-checks the invariant registry against the suite: an invariant whose
// evidence is "tests" must be named by a test title, a title may only name
// registered invariants, and a script's evidence path must exist.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { INVARIANTS } from "../helpers/invariants.js";
import { loadCorpus, scenarioTitle } from "../helpers/scenario.js";

const root = resolve(import.meta.dir, "../..");
const testDir = join(root, "test");

// The first string argument of test(...), test.failing(...),
// test.skipIf(x)(...) or describe(...), which bun fmt may wrap onto the
// next line.
const TITLE =
  /\b(?:test|it|describe)(?:\.\w+(?:\([^()]*\))?)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Every test title with the file it comes from. */
function titles(): { file: string; title: string }[] {
  const fromSource = readdirSync(testDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".test.ts"))
    .flatMap((file) =>
      [...readFileSync(join(testDir, file), "utf8").matchAll(TITLE)].map(
        (match) => ({ file: `test/${file}`, title: match[2] ?? "" }),
      ),
    );
  // test/security/scenarios.test.ts builds its titles from each fixture.
  const fromScenarios = loadCorpus().map((scenario) => ({
    file: `test/fixtures/scenarios/${scenario.caseId}.json`,
    title: scenarioTitle(scenario),
  }));
  return [...fromSource, ...fromScenarios];
}

const named = new Map<string, string[]>();
for (const { file, title } of titles())
  for (const [id] of title.matchAll(/\bINV-\d\d\b/g)) {
    const proofs = named.get(id) ?? [];
    proofs.push(`${file}: ${title}`);
    named.set(id, proofs);
  }

const proofReport = () =>
  [...named]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, proofs]) => `${id}\n  ${proofs.join("\n  ")}`)
    .join("\n");

test("every invariant with test evidence is named by a test title", () => {
  const unproven = INVARIANTS.filter(
    ({ id, evidence }) => evidence.kind === "tests" && !named.has(id),
  ).map(({ id }) => id);
  assert.deepEqual(
    unproven,
    [],
    `titles naming each invariant:\n${proofReport()}`,
  );
});

test("every invariant id in a test title is registered", () => {
  const registered = new Set<string>(INVARIANTS.map(({ id }) => id));
  const unknown = [...named.keys()].filter((id) => !registered.has(id));
  assert.deepEqual(
    unknown,
    [],
    `titles naming each invariant:\n${proofReport()}`,
  );
});

test("every script evidence path exists", () => {
  const missing = INVARIANTS.flatMap(({ id, evidence }) =>
    evidence.kind === "script" && !existsSync(join(root, evidence.path))
      ? [`${id}: ${evidence.path}`]
      : [],
  );
  assert.deepEqual(missing, []);
});
