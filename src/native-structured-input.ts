import type { NativeObject } from "./native-session-codec.js";

/** Native M: written-line acknowledgements, separate from transport delivery. */
export class NativeInputReadMarker {
  readonly #mark: string;
  #written = 0;
  #read = 0;
  #allRead: PromiseWithResolvers<void> | undefined;
  constructor(mark: string) {
    this.#mark = mark;
  }
  noteWritten(text: string): void {
    let at = text.indexOf(this.#mark);
    while (at !== -1) {
      const newline = text.indexOf("\n", at);
      if (newline === -1) return;
      this.#written++;
      at = text.indexOf(this.#mark, newline);
    }
  }
  noteRead(text: string): void {
    if (this.#read < this.#written && text.includes(this.#mark))
      this.#readUpTo(this.#read + 1);
  }
  noteReadingEnded(): void {
    this.#readUpTo(Number.POSITIVE_INFINITY);
  }
  counts(): { written: number; read: number } {
    return { written: this.#written, read: this.#read };
  }
  whenRead(): Promise<void> | undefined {
    if (this.#written <= this.#read) return;
    return (this.#allRead ??= Promise.withResolvers<void>()).promise;
  }
  #readUpTo(count: number): void {
    this.#read = count;
    if (this.#written <= count) {
      this.#allRead?.resolve();
      this.#allRead = undefined;
    }
  }
}

export interface NativeStructuredInputHost<T extends object> {
  /** Actual complete processLine owner, including reached control/environment branches. */
  processLine(line: string): T | undefined | Promise<T | undefined>;
  /** Actual single-line native JSON serialization; no native conversation ID is created. */
  serialize(value: NativeObject): string;
  /** Actual hFn reads s.CLAUDE_CODE_CONFIG_PROBE, parsed through native N.bool. */
  configProbe(): boolean;
  probeDiscarded(): void;
  /** Actual nonrejecting Gd scheduling boundary. */
  yieldTick(): Promise<void>;
  parsed(message: T): void;
  lineBudgetExceeded(at: "block" | "tail"): void;
  /** Production owns native fatal diagnostics/drain/exit; a reader cannot continue past this. */
  fatalInput(message: string): Promise<never>;
  /** Actual mn/k_o/pendingRequests/parked-question policy after the source marks input closed. */
  inputClosed(): void;
}
export type NativeOwnedInputDelivery = {
  readonly status: "enqueued" | "probe-discarded" | "retired";
};

/**
 * h$e's input algorithm and origin ownership, independent from its parser/control
 * request owner. Raw prepend/readAgain retain source semantics. The checked
 * delivery method is a port lifetime extension and never claims consumption.
 */
export class NativeStructuredInput<T extends object> {
  readonly structuredInput: AsyncGenerator<T, void>;
  readonly #input: AsyncIterable<string>;
  readonly #host: NativeStructuredInputHost<T>;
  readonly #maxLineChars: number;
  readonly #prepended: {
    line: string;
    hostLocal: boolean;
    personsOwn: boolean;
  }[] = [];
  readonly #local = new WeakSet<object>();
  readonly #person = new WeakSet<object>();
  readonly #answers = new NativeInputReadMarker('"control_response"');
  readonly #sdkServers = new NativeInputReadMarker('"sdkMcpServers"');
  readonly #pluginsReloads = new NativeInputReadMarker(
    '{"subtype":"reload_plugins"}',
  );
  #waker: (() => void) | undefined;
  #inputClosed = false;
  #unconsumed = false;
  #reportsWrites = false;
  #retired = false;

  constructor(options: {
    input: AsyncIterable<string>;
    host: NativeStructuredInputHost<T>;
    /** Actual native constructor argument; pinned default Oe is 268435456 JS characters. */
    maxLineChars?: number;
  }) {
    this.#input = options.input;
    const host = options.host;
    this.#host = {
      processLine: host.processLine.bind(host),
      serialize: host.serialize.bind(host),
      configProbe: host.configProbe.bind(host),
      probeDiscarded: host.probeDiscarded.bind(host),
      yieldTick: host.yieldTick.bind(host),
      parsed: host.parsed.bind(host),
      lineBudgetExceeded: host.lineBudgetExceeded.bind(host),
      fatalInput: host.fatalInput.bind(host),
      inputClosed: host.inputClosed.bind(host),
    };
    this.#maxLineChars = options.maxLineChars ?? 268435456;
    const reader = this.#read(),
      finish = reader.return.bind(reader),
      fail = reader.throw.bind(reader);
    // Port delivery admission also observes retirement before the native body starts.
    reader.return = (value) => {
      this.#retired = true;
      return finish(value);
    };
    reader.throw = (error) => {
      this.#retired = true;
      return fail(error);
    };
    this.structuredInput = reader;
  }
  get inputClosed(): boolean {
    return this.#inputClosed;
  }
  get hasUnconsumedInput(): boolean {
    return this.#unconsumed;
  }
  get readerRetired(): boolean {
    return this.#retired;
  }
  #prepend(text: string, sentBy: "process" | "person"): boolean {
    if (this.#host.configProbe()) {
      this.#host.probeDiscarded();
      return false;
    }
    this.#prepended.push({
      line: this.#host.serialize({
        type: "user",
        session_id: "",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      }),
      hostLocal: true,
      personsOwn: sentBy === "person",
    });
    this.#waker?.();
    return true;
  }
  prependUserMessage(
    text: string,
    sentBy: "process" | "person" = "process",
  ): void {
    this.#prepend(text, sentBy);
  }
  prependOwnedUserMessage(
    text: string,
    sentBy: "process" | "person" = "process",
  ): NativeOwnedInputDelivery {
    if (this.#retired || this.#inputClosed) return { status: "retired" };
    return {
      status: this.#prepend(text, sentBy) ? "enqueued" : "probe-discarded",
    };
  }
  readAgain(value: NativeObject): void {
    this.#prepended.push({
      line: this.#host.serialize(value),
      hostLocal: false,
      personsOwn: false,
    });
    this.#waker?.();
  }
  noteInputWritten(text: string): void {
    this.#reportsWrites = true;
    for (const marker of [
      this.#answers,
      this.#sdkServers,
      this.#pluginsReloads,
    ])
      marker.noteWritten(text);
  }
  whenReceivedAnswersRead(): Promise<void> | undefined {
    return this.#answers.whenRead();
  }
  whenReceivedSdkServersRead(): Promise<void> | undefined {
    return this.#sdkServers.whenRead();
  }
  barePluginsReloads(): { written: number; read: number } | undefined {
    return this.#reportsWrites ? this.#pluginsReloads.counts() : undefined;
  }
  isLocallyPrependedMessage(message: T): boolean {
    return this.#local.has(message);
  }
  isPersonsOwnPrepend(message: T): boolean {
    return this.#person.has(message);
  }

  async *#read(): AsyncGenerator<T, void> {
    let buffer = "",
      chunks: string[] = [],
      length = 0,
      hasNewline = false;
    let parsedLines = 0,
      parsedChars = 0,
      resetPending = false;
    const note = (line: string) => {
      parsedLines++;
      parsedChars += line.length;
      if (resetPending) return;
      resetPending = true;
      void this.#host.yieldTick().then(() => {
        parsedLines = 0;
        parsedChars = 0;
        resetPending = false;
      });
    };
    const drain = async function* (
      this: NativeStructuredInput<T>,
    ): AsyncGenerator<T, void> {
      for (;;) {
        if (parsedLines >= 64 || parsedChars >= 1048576) {
          await this.#host.yieldTick();
          parsedLines = 0;
          parsedChars = 0;
        }
        let drainedPrepends = false;
        while (this.#prepended.length) {
          const entry = this.#prepended.shift();
          if (!entry)
            throw new Error("Native prepended input invariant failed");
          drainedPrepends = true;
          note(entry.line);
          const message = await this.#host.processLine(entry.line);
          if (message) {
            if (entry.hostLocal) this.#local.add(message);
            if (entry.personsOwn) this.#person.add(message);
            this.#host.parsed(message);
            yield message;
          }
        }
        if (drainedPrepends) continue;
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        note(line);
        const message = await this.#host.processLine(line);
        if (message) {
          this.#host.parsed(message);
          this.#unconsumed = buffer.trim().length > 0;
          yield message;
        }
        for (const marker of [
          this.#answers,
          this.#sdkServers,
          this.#pluginsReloads,
        ])
          marker.noteRead(line);
      }
      this.#unconsumed = buffer.trim().length > 0;
    }.bind(this);
    const iterator = this.#input[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<string>> | undefined,
      ended = false;
    const fatal = async (at: "block" | "tail"): Promise<never> => {
      this.#host.lineBudgetExceeded(at);
      return this.#host.fatalInput(
        `Error: stream-json input carried over ${Math.round(this.#maxLineChars / 1024 / 1024)}M characters with no newline. Each stream-json message must be a single newline-terminated JSON line: either the producer is not newline-terminating its messages, or one message exceeded this budget.`,
      );
    };
    try {
      for (;;) {
        if (hasNewline || this.#prepended.length) {
          if (chunks.length) {
            buffer += chunks.join("");
            chunks = [];
          }
          yield* drain();
          length = buffer.length;
          if (length > this.#maxLineChars) await fatal("tail");
          hasNewline = false;
        }
        pending ??= iterator.next();
        const prepend = await Promise.race([
          pending.then(() => false),
          new Promise<boolean>((resolve) => {
            this.#waker = () => resolve(true);
          }),
        ]);
        this.#waker = undefined;
        if (prepend) continue;
        const next = await pending;
        pending = undefined;
        if (next.done) {
          ended = true;
          break;
        }
        length += next.value.length;
        const newline = next.value.includes("\n");
        if (!newline && length > this.#maxLineChars) await fatal("block");
        chunks.push(next.value);
        if (newline) hasNewline = true;
        else if (!this.#unconsumed && /\S/.test(next.value))
          this.#unconsumed = true;
      }
    } finally {
      this.#waker = undefined;
      this.#retired = true;
      for (const marker of [
        this.#answers,
        this.#sdkServers,
        this.#pluginsReloads,
      ])
        marker.noteReadingEnded();
      if (!ended) await iterator.return?.();
    }
    if (chunks.length) {
      buffer += chunks.join("");
      chunks = [];
    }
    if (buffer) {
      const message = await this.#host.processLine(buffer);
      this.#unconsumed = false;
      if (message) yield message;
    }
    this.#inputClosed = true;
    this.#host.inputClosed();
  }
}
