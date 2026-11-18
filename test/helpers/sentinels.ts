import { randomBytes } from "node:crypto";

export const SENTINEL_PREFIX = "TAU_SENTINEL_";

/** A unique secret-shaped marker, e.g. TAU_SENTINEL_API_KEY_1a2b3c4d. */
export function sentinel(label: string): string {
  return `${SENTINEL_PREFIX}${label}_${randomBytes(4).toString("hex")}`;
}
