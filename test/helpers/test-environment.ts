import { afterEach, beforeEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetProviderProcessLatches } from "../../src/provider.js";

const state = mkdtempSync(join(tmpdir(), "tau-test-environment-"));
for (const name of ["user", "managed", "state"]) mkdirSync(join(state, name));
process.env.CLAUDE_CONFIG_DIR = join(state, "user");
process.env.TAU_MANAGED_ROOT = join(state, "managed");
process.env.TAU_HOME = join(state, "state");
process.once("exit", () => rmSync(state, { recursive: true, force: true }));

// Bun 1.4 ignores bunfig's restoreMocks/clearMocks/unstubEnvs.
let environment: Record<string, string | undefined> = {};
beforeEach(() => {
  environment = { ...process.env };
});
afterEach(() => {
  mock.restore();
  mock.clearAllMocks();
  resetProviderProcessLatches();
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(environment, key)) delete process.env[key];
  for (const [key, value] of Object.entries(environment))
    if (process.env[key] !== value) process.env[key] = value;
});
