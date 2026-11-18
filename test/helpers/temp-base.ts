import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Base directory for test mkdtemp roots.
 * When TMPDIR nests under the real home (pstack jobs do this), a workspace
 * created there has home as an ancestor, so project instruction walks load
 * ~/.claude/rules. Prefer a base outside home in that case.
 */
export function tempBase(): string {
  const base = resolve(tmpdir());
  const home = resolve(homedir());
  if (base === home || base.startsWith(`${home}${sep}`)) {
    const fallback = resolve(join("/tmp", "tau-test-tmp"));
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  return base;
}
