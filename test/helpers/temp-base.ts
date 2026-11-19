import { tmpdir } from "node:os";

/**
 * Base directory for test mkdtemp roots.
 * Instruction Project walks stop before importHome (src/instructions.ts),
 * so a TMPDIR nested under the real home is safe. Callers share this helper
 * so a future base policy stays in one place.
 */
export function tempBase(): string {
  return tmpdir();
}
