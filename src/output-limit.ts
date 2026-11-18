import { combinedContextOverflow, excludesGuessedOutputCap } from "./context-error.js";
import { usesAssumedOutputLimit } from "./reasoning.js";

/** One model query's tentative repair; accepted caps live in the provider's session latch. */
export class OutputLimitRepair {
  private tentative: number | undefined;
  private awaitingProof = false;
  constructor(private readonly model: string, private readonly key: string, private readonly learned: Map<string, number>) {}
  get limit(): number { return this.tentative ?? this.learned.get(this.key) ?? Infinity; }
  onError(status: number, info: { message: string; code?: string; type?: string }, sent: number): boolean {
    if (![400, 402, 413, 422, 429].includes(status)) return false;
    if (this.tentative !== undefined) { this.awaitingProof = false; return false; }
    const reported = Number(/^max_tokens: \d+ > (\d+), which is the maximum allowed number of output tokens for .+$/.exec(info.message)?.[1]);
    let candidate = Infinity;
    if (reported >= 4096) candidate = reported;
    else if (info.type !== "billing_error" && (combinedContextOverflow(info.message) || !excludesGuessedOutputCap(status, info.message, info.code))) {
      const prior = this.learned.get(this.key) ?? Infinity;
      candidate = prior < sent ? prior : usesAssumedOutputLimit(this.model) ? 32000 : Infinity;
    }
    if (candidate >= sent) return false;
    this.tentative = candidate; this.awaitingProof = true; return true;
  }
  onReplyBegun(): void {
    if (this.awaitingProof && this.tentative !== undefined) {
      this.learned.set(this.key, this.tentative); this.awaitingProof = false;
    }
  }
}
