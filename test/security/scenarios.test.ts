// T3 adversarial corpus: each reviewed fixture in test/fixtures/scenarios is
// replayed through the real CLI against the strict mock provider.
import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import {
  evaluate,
  loadCorpus,
  manifestProblems,
  replay,
  scenarioTitle,
  type OracleFailure,
} from "../helpers/scenario.js";

const corpus = loadCorpus();
const TIMEOUT_MS = 30_000;

const report = (failures: readonly OracleFailure[]) =>
  failures.map(({ oracle, detail }) => `${oracle}: ${detail}`).join("\n");

test("every scenario fixture matches its reviewed MANIFEST.sha256 digest", () => {
  assert.deepEqual(manifestProblems(), []);
});

for (const scenario of corpus) {
  const gap = scenario.knownGap;
  if (gap === undefined) {
    test(
      scenarioTitle(scenario),
      async () => {
        const failures = evaluate(await replay(scenario));
        assert.equal(failures.length, 0, report(failures));
      },
      TIMEOUT_MS,
    );
    continue;
  }
  // Stays green only while tau breaks exactly the oracles the finding names.
  // A fix, or a failure of any other oracle, turns it red.
  test.failing(
    scenarioTitle(scenario),
    async () => {
      const failures = evaluate(await replay(scenario));
      const violated = [...new Set(failures.map(({ oracle }) => oracle))];
      if (isDeepStrictEqual(violated.toSorted(), gap.violates.toSorted()))
        throw new Error(`known gap reproduced:\n${report(failures)}`);
      console.error(
        `${scenario.caseId}: expected exactly [${gap.violates.join(", ")}] to fail, got:\n${report(failures) || "no failures"}`,
      );
    },
    TIMEOUT_MS,
  );
}

describe("INV-12 replay determinism", () => {
  for (const scenario of corpus)
    test(
      `INV-12 ${scenario.caseId}: two replays give one canonical sequence${scenario.knownGap === undefined ? ", the golden one" : ""}`,
      async () => {
        const first = await replay(scenario);
        const second = await replay(scenario);
        assert.deepEqual(second.canonical, first.canonical);
        // A known gap's golden is the secure sequence tau does not produce yet.
        if (scenario.knownGap === undefined)
          assert.deepEqual(first.canonical, scenario.expected.requestSequence);
      },
      TIMEOUT_MS,
    );
});
