// Recovered launch interactivity and --no-session-persistence admission.
// Evidence: artifacts/interactive-launch/CONTRACT.md (Z4e/Or/Ugt/ge) and
// artifacts/session-persistence-flag/CONTRACT.md (o.sessionPersistence/Emr/kH),
// both byte-pinned to the 2.1.326 image with Ghidra COMPLETE reports.

export const NO_SESSION_PERSISTENCE_PRINT_ONLY =
  "Error: --no-session-persistence only works with --print." as const;

/** Recovered `Hw`: exact token before `--`. */
function hasExactFlag(argv: readonly string[], flag: string): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (token === flag) return true;
  }
  return false;
}

/** Recovered `ttt` prefix scan, used by `Z4e` for `--sdk-url`. */
function hasPrefixFlag(argv: readonly string[], prefix: string): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (token.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Recovered `Or({interactivity:{kind:"detect"}})` then `isInteractive()`.
 * The launch is non-interactive (`Z4e`) for exact -p/--print/--init-only, a
 * --sdk-url prefix, or a non-TTY stdout. Stdin is not part of the predicate.
 */
export function isInteractiveLaunch(
  argv: readonly string[],
  stdoutIsTTY: boolean,
): boolean {
  return !(
    hasExactFlag(argv, "-p") ||
    hasExactFlag(argv, "--print") ||
    hasExactFlag(argv, "--init-only") ||
    hasPrefixFlag(argv, "--sdk-url") ||
    !stdoutIsTTY
  );
}

export type SessionPersistenceAdmission =
  | { ok: true; sessionPersistenceDisabled: boolean }
  | { ok: false; error: typeof NO_SESSION_PERSISTENCE_PRINT_ONLY };

/**
 * Recovered consumer: `o.sessionPersistence===!1` rejects an interactive launch
 * (the stored bit, not `o.print`) and otherwise sets the disable fact. Absence
 * never writes false over another writer; it just leaves the default.
 */
export function admitSessionPersistence(
  noSessionPersistence: boolean,
  interactive: boolean,
): SessionPersistenceAdmission {
  if (!noSessionPersistence)
    return { ok: true, sessionPersistenceDisabled: false };
  if (interactive)
    return { ok: false, error: NO_SESSION_PERSISTENCE_PRINT_ONLY };
  return { ok: true, sessionPersistenceDisabled: true };
}
