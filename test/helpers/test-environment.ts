import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CLI children inherit disposable configuration, never the developer's Claude
// settings or instruction files. Individual fixtures can override these roots.
const state = mkdtempSync(join(tmpdir(), "tau-test-environment-"));
for (const name of ["user", "managed", "state"]) mkdirSync(join(state, name));
process.env.CLAUDE_CONFIG_DIR = join(state, "user");
process.env.TAU_MANAGED_ROOT = join(state, "managed");
process.env.TAU_HOME = join(state, "state");
process.once("exit", () => rmSync(state, { recursive: true, force: true }));
