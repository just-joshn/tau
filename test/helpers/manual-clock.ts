import type { Clock } from "../../src/deadline.js";

/** Scheduler time is separate from wall/monotonic time so suspension can be reproduced. */
export class ManualClock implements Clock {
  wall = 0;
  mono = 0;
  private time = 0;
  private next = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.wall;
  }
  monotonicNow(): number {
    return this.mono;
  }
  get pending(): number {
    return this.timers.size;
  }
  get scheduled(): number {
    return this.next;
  }
  setTimeout(callback: () => void, milliseconds: number): () => void {
    if (!Number.isFinite(milliseconds)) return () => {};
    const id = ++this.next;
    this.timers.set(id, { at: this.time + milliseconds, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    for (;;) {
      const entry = [...this.timers]
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
        .find(([, value]) => value.at <= end);
      if (!entry) break;
      const [id, timer] = entry;
      const delta = timer.at - this.time;
      this.wall += delta;
      this.mono += delta;
      this.time = timer.at;
      this.timers.delete(id);
      timer.callback();
    }
    this.wall += end - this.time;
    this.mono += end - this.time;
    this.time = end;
  }
  suspend(milliseconds: number): void {
    this.wall += milliseconds;
    this.time += milliseconds;
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.time);
    for (const [id, timer] of due) {
      if (this.timers.delete(id)) timer.callback();
    }
  }
}
