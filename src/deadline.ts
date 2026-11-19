import {
  MAX_TIMER_MS,
  firstHeaderWindow,
  type TimeoutPolicy,
} from "./timeout-policy.js";

export interface Clock {
  now(): number;
  monotonicNow(): number;
  setTimeout(
    callback: () => void,
    milliseconds: number,
    options?: { unref?: boolean },
  ): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimeout(callback, milliseconds, options) {
    if (!Number.isFinite(milliseconds)) return () => {};
    let remaining = Math.max(0, milliseconds);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const step = Math.min(MAX_TIMER_MS, Math.max(0, Math.ceil(remaining)));
      remaining -= step;
      timer = setTimeout(() => {
        if (!active) return;
        if (remaining > 0) arm();
        else {
          active = false;
          callback();
        }
      }, step);
      if (options?.unref) timer.unref();
    };
    arm();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  },
};

export class TransportTimeoutError extends Error {
  constructor(
    readonly stage:
      "request" | "first-header" | "byte-idle" | "event-idle" | "nonstream",
    readonly milliseconds: number,
  ) {
    super(`Messages API ${stage} timeout after ${milliseconds} ms`);
    this.name = "TransportTimeoutError";
  }
}
export class StreamSuspendedError extends Error {
  readonly code = "StreamSuspended";
  constructor(readonly sleptMs: number) {
    super("Messages API stream suspended while waiting for progress");
    this.name = "StreamSuspendedError";
  }
}

type Expiry = { lateMs: number; sleptMs: number; suspended: boolean };

/** Coalesce rapid resets while preserving the last progress deadline and dual-clock suspend checks. */
export class IdleDeadline {
  private cancel: (() => void) | undefined;
  private mono = 0;
  private wall = 0;
  private lastMono = 0;
  private lastWall = 0;
  private owed = 0;
  private closed = false;
  constructor(
    private readonly clock: Clock,
    private readonly milliseconds: number,
    private readonly slack: number,
    private readonly expire: (state: Expiry) => void,
    private readonly unref = false,
  ) {}
  touch(): void {
    if (this.closed) return;
    const mono = this.clock.monotonicNow(),
      wall = this.clock.now();
    const elapsed = mono - this.mono,
      wallElapsed = wall - this.wall;
    if (
      this.cancel &&
      this.slack > 0 &&
      elapsed < this.slack &&
      wallElapsed < this.slack &&
      wallElapsed >= elapsed - 5
    ) {
      this.lastMono = mono;
      this.lastWall = wall;
      this.owed = Math.max(elapsed, wallElapsed);
      return;
    }
    this.cancel?.();
    this.mono = mono;
    this.wall = wall;
    this.owed = 0;
    this.arm(this.milliseconds);
  }
  private arm(delay: number): void {
    this.cancel = this.clock.setTimeout(
      () => {
        const owed = this.owed;
        this.owed = 0;
        if (owed > 0) {
          const elapsed = this.clock.monotonicNow() - this.mono;
          const effective =
            elapsed >= this.milliseconds
              ? elapsed
              : Math.max(elapsed, this.clock.now() - this.wall);
          this.mono = this.lastMono;
          this.wall = this.lastWall;
          const extension = Math.min(
            owed,
            this.milliseconds + owed - effective,
          );
          if (extension > 0) {
            this.arm(Math.ceil(extension));
            return;
          }
        }
        const elapsed = this.clock.monotonicNow() - this.mono;
        const lateMs = Math.round(elapsed - this.milliseconds);
        const sleptMs = Math.max(
          0,
          Math.round(this.clock.now() - this.wall - elapsed),
        );
        this.cancel = undefined;
        this.expire({
          lateMs,
          sleptMs,
          suspended:
            lateMs < -this.milliseconds / 2 && sleptMs > this.milliseconds / 2,
        });
      },
      delay,
      { unref: this.unref },
    );
  }
  close(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
  }
}

/** One fetch attempt's linked cancellation and header/body lifetime. */
export class TransportDeadline {
  private readonly controller = new AbortController();
  private readonly timers = new Set<() => void>();
  private problem: Error | undefined;
  private closed = false;
  private byteIdle: IdleDeadline | undefined;
  private eventIdle: IdleDeadline | undefined;
  private heartbeat: IdleDeadline | undefined;
  private lastByte = -Infinity;
  private heartbeatBase = 0;
  private pings = 0;
  private readonly externalAbort: () => void;
  readonly signal = this.controller.signal;

  constructor(
    private readonly parent: AbortSignal,
    private readonly policy: TimeoutPolicy,
    private readonly clock: Clock,
    private readonly streaming: boolean,
    requestBytes: number,
    escalated: boolean,
  ) {
    this.externalAbort = () => {
      this.controller.abort();
      this.stopTimers();
    };
    parent.addEventListener("abort", this.externalAbort, { once: true });
    if (parent.aborted) {
      this.externalAbort();
      return;
    }
    if (!streaming)
      this.schedule(
        () =>
          this.fail(
            new TransportTimeoutError("nonstream", policy.nonStreamingMs),
          ),
        policy.nonStreamingMs,
      );
    else {
      this.schedule(
        () => this.fail(new TransportTimeoutError("request", policy.requestMs)),
        policy.requestMs,
      );
      const window = firstHeaderWindow(policy, requestBytes, escalated);
      if (window !== undefined) {
        let wall = clock.now(),
          slept = 0;
        const sample = () => {
          const now = clock.now(),
            delta = now - wall;
          wall = now;
          if (delta > 5000) slept += delta;
        };
        const poll = () => {
          sample();
          this.schedule(poll, 1000, true);
        };
        this.schedule(poll, 1000, true);
        this.schedule(() => {
          sample();
          this.fail(
            slept > window / 2
              ? new StreamSuspendedError(slept)
              : new TransportTimeoutError("first-header", window),
          );
        }, window);
      }
    }
  }
  get failure(): Error | undefined {
    return this.problem;
  }
  check(): void {
    if (this.parent.aborted)
      throw new DOMException("Request aborted", "AbortError");
    if (this.problem) throw this.problem;
    if (this.signal.aborted)
      throw new DOMException("Request aborted", "AbortError");
  }
  headersReceived(): void {
    this.check();
    if (this.streaming) this.clearScheduled();
  }
  beginStream(): void {
    this.check();
    const idle =
      (stage: "byte-idle" | "event-idle", duration: number) =>
      (state: Expiry) =>
        this.fail(
          state.suspended
            ? new StreamSuspendedError(state.sleptMs)
            : new TransportTimeoutError(stage, duration),
        );
    if (this.policy.byteWatchdog) {
      this.byteIdle = new IdleDeadline(
        this.clock,
        this.policy.byteIdleMs,
        Math.min(this.policy.timerSlackMs, this.policy.byteIdleMs / 100),
        idle("byte-idle", this.policy.byteIdleMs),
      );
      this.byteIdle.touch();
    }
    if (this.policy.eventWatchdog) {
      const slack =
        this.policy.byteIdleMs + 1000 <= this.policy.eventIdleMs
          ? Math.min(this.policy.timerSlackMs, this.policy.eventIdleMs / 100)
          : 0;
      this.eventIdle = new IdleDeadline(
        this.clock,
        this.policy.eventIdleMs,
        slack,
        idle("event-idle", this.policy.eventIdleMs),
      );
      this.eventIdle.touch();
    }
    this.heartbeatBase = this.clock.monotonicNow();
    if (this.policy.byteWatchdog) {
      this.heartbeat = new IdleDeadline(
        this.clock,
        10000,
        Math.min(this.policy.timerSlackMs, 1000),
        () => {
          if (this.closed || this.signal.aborted) return;
          if (this.lastByte > this.heartbeatBase) {
            if (++this.pings <= 30) this.eventIdle?.touch();
            this.heartbeatBase = this.clock.monotonicNow();
          }
          this.heartbeat?.touch();
        },
        true,
      );
      this.heartbeat.touch();
    }
  }
  byteReceived(): void {
    this.check();
    this.lastByte = this.clock.monotonicNow();
    this.byteIdle?.touch();
  }
  eventReceived(ping: boolean): void {
    this.check();
    if (ping) {
      if (++this.pings <= 30) this.eventIdle?.touch();
    } else {
      this.pings = 0;
      this.eventIdle?.touch();
    }
    this.heartbeatBase = this.clock.monotonicNow();
    this.heartbeat?.touch();
  }
  private schedule(callback: () => void, delay: number, unref = false): void {
    const cancel = this.clock.setTimeout(
      () => {
        this.timers.delete(cancel);
        if (!this.closed && !this.signal.aborted) callback();
      },
      delay,
      { unref },
    );
    this.timers.add(cancel);
  }
  private clearScheduled(): void {
    for (const cancel of this.timers) cancel();
    this.timers.clear();
  }
  private stopTimers(): void {
    this.clearScheduled();
    this.byteIdle?.close();
    this.eventIdle?.close();
    this.heartbeat?.close();
  }
  private fail(error: Error): void {
    if (!this.problem && !this.closed && !this.parent.aborted) {
      this.problem = error;
      this.controller.abort(error);
      this.stopTimers();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    this.parent.removeEventListener("abort", this.externalAbort);
  }
}
