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
