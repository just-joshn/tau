// Re-record each security scenario's golden requestSequence from a real replay,
// print what changed per scenario, and rewrite MANIFEST.sha256. A reviewer reads
// the printed change summary (and `git diff`) before committing; the security
// oracles themselves are unchanged and still run in test/security.
// Run: REGEN_SCENARIO_GOLDENS=1 bun test ./scripts/regen-scenario-goldens.test.ts
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  replay,
  SCENARIO_DIR,
  scenarioSchema,
  type CanonicalRequest,
} from "../test/helpers/scenario.js";

const only = new Set((process.env.REGEN_ONLY ?? "").split(",").filter(Boolean));
const files = readdirSync(SCENARIO_DIR)
  .filter((name) => name.endsWith(".json"))
  .toSorted();

const shape = (sequence: readonly CanonicalRequest[]) =>
  sequence.map((request) =>
    request.messages
      .map((message) => message.blocks.map((block) => block.kind).join(","))
      .join(" | "),
  );

test.skipIf(process.env.REGEN_SCENARIO_GOLDENS !== "1")(
  "re-record scenario goldens",
  async () => {
    for (const name of files) {
      if (only.size && !only.has(name.replace(/\.json$/, ""))) continue;
      const path = join(SCENARIO_DIR, name);
      const scenario = scenarioSchema.parse(
        JSON.parse(readFileSync(path, "utf8")),
      );
      const observed = (await replay(scenario)).canonical;
      const before = scenario.expected.requestSequence;
      if (isDeepStrictEqual(before, observed)) continue;
      console.log(`${name}: requests ${before.length}->${observed.length}`);
      const was = shape(before),
        now = shape(observed);
      for (const [index, line] of now.entries())
        if (line !== was[index])
          console.log(`  [${index}] - ${was[index]}\n  [${index}] + ${line}`);
      const updated = {
        ...scenario,
        expected: { ...scenario.expected, requestSequence: observed },
      };
      writeFileSync(path, JSON.stringify(updated, null, 2) + "\n");
      Bun.spawnSync(["bun", "fmt", path]);
    }

    const manifest = files
      .map(
        (name) =>
          `${createHash("sha256")
            .update(readFileSync(join(SCENARIO_DIR, name)))
            .digest("hex")}  ${name}\n`,
      )
      .join("");
    writeFileSync(join(SCENARIO_DIR, "MANIFEST.sha256"), manifest);
  },
  600_000,
);
