// Bun preload that serves a mutant in place of one src file. run.ts passes it
// through BUN_OPTIONS, so the test runner and every bun child it spawns load
// the mutant. TAU_MUTANT_FILE is the absolute src path and TAU_MUTANT_SOURCE
// the file holding the mutated text. Each load touches <source>.loaded, which
// tells run.ts that a test reached the mutant.
import { plugin } from "bun";
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.TAU_MUTANT_FILE;
const source = process.env.TAU_MUTANT_SOURCE;

if (file !== undefined && source !== undefined) {
  const contents = readFileSync(source, "utf8");
  const filter = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  plugin({
    name: "tau-mutant",
    setup(build) {
      build.onLoad({ filter }, () => {
        writeFileSync(`${source}.loaded`, "");
        return { contents, loader: "ts" };
      });
    },
  });
}
