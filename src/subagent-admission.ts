/** Typed positive decimal environment descriptor; hosted concurrency overrides are separate. */
export function ordinarySubagentConcurrencyLimit(
  raw: string | undefined,
): number {
  if (raw !== undefined && /^[+-]?\d+$/.test(raw.trim())) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 1) return value;
  }
  return 20;
}
