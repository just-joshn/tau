import { createHash } from "node:crypto";
import { decodeTextFile } from "./text-file.js";

function digest(bytes: Buffer): string {
  // Read displays text without its leading BOM and with CRLF normalized to LF.
  const text = decodeTextFile(bytes).text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex");
}

/** Process-local, bounded state. Keys are canonical absolute paths supplied by tools. */
export class ReadState {
  private readonly snapshots = new Map<
    string,
    { timestamp: number; baseline?: string }
  >();
  has(file: string): boolean {
    return this.snapshots.has(file);
  }
  private trim(): void {
    if (this.snapshots.size <= 512) return;
    const oldest = this.snapshots.keys().next();
    if (!oldest.done) this.snapshots.delete(oldest.value);
  }

  remember(file: string, bytes: Buffer, timestamp = Date.now()): void {
    this.forget(file);
    this.snapshots.set(file, {
      timestamp: Math.floor(timestamp),
      baseline: digest(bytes),
    });
    this.trim();
  }

  rememberPartial(file: string, timestamp: number): void {
    this.forget(file);
    this.snapshots.set(file, { timestamp: Math.floor(timestamp) });
    this.trim();
  }

  /** Stable mtime ordering, with the most recently touched entry first for ties. */
  candidates(): Array<{ file: string; timestamp: number }> {
    return [...this.snapshots]
      .reverse()
      .map(([file, value]) => ({ file, timestamp: value.timestamp }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  replaceFrom(next: ReadState): void {
    const entries = [...next.snapshots];
    this.snapshots.clear();
    for (const [file, value] of entries) this.snapshots.set(file, { ...value });
  }

  forget(file: string): void {
    this.snapshots.delete(file);
  }

  private complete(file: string): { timestamp: number; baseline?: string } {
    const snapshot = this.snapshots.get(file);
    if (snapshot?.baseline === undefined)
      throw new Error(
        "Read the entire file in one call before editing or overwriting it. Partial or truncated Reads do not qualify.",
      );
    return snapshot;
  }

  requireComplete(file: string): void {
    this.complete(file);
  }

  assertCurrent(file: string, bytes: Buffer): void {
    const previous = this.complete(file);
    if (previous.baseline !== digest(bytes))
      throw new Error(
        "File content changed since it was read. Read it again before editing or overwriting it.",
      );
    this.snapshots.delete(file);
    this.snapshots.set(file, previous);
  }
}
