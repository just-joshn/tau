import {
  NativeSessionJournal,
  type NativeSessionJournalHost,
} from "./native-session-journal.js";
import {
  NativeSessionOwnership,
  type NativeSessionOwnershipOptions,
} from "./native-session-ownership.js";
import type { NativeSessionPersistenceOptions } from "./native-session-persistence.js";

/** A port storage binding, separate from native rows and model request data. */
export interface NativeSessionBinding {
  readonly path: string;
  readonly sessionId: string;
  readonly cursorUuid: string | null;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface NativeSessionLifetimeOptions {
  ownership: NativeSessionOwnershipOptions;
  persistence: Omit<
    NativeSessionPersistenceOptions,
    "path" | "withExclusiveOwnership" | "initial"
  >;
  initial:
    | { kind: "fresh" }
    | { kind: "owned-existing"; binding: NativeSessionBinding };
  host: NativeSessionJournalHost;
}

/**
 * The participating port lock and physical event journal have one lifetime.
 * This controller is a port ownership policy; it is not a recovered native lock.
 */
export class NativeSessionLifetime {
  readonly journal: NativeSessionJournal;
  readonly #ownership: NativeSessionOwnership;
  readonly #path: string;
  readonly #sessionId: string;
  #close: Promise<void> | undefined;

  private constructor(
    journal: NativeSessionJournal,
    ownership: NativeSessionOwnership,
    path: string,
    sessionId: string,
  ) {
    this.journal = journal;
    this.#ownership = ownership;
    this.#path = path;
    this.#sessionId = sessionId;
  }

  static async open(
    options: NativeSessionLifetimeOptions,
    signal: AbortSignal,
  ): Promise<NativeSessionLifetime> {
    // Capture the binding before the first asynchronous ownership operation.
    const initial =
      options.initial.kind === "fresh"
        ? { kind: "fresh" as const }
        : {
            kind: "owned-existing" as const,
            binding: Object.freeze({ ...options.initial.binding }),
          };
    const path = options.ownership.path,
      sessionId = options.persistence.context.sessionId;
    const persistence = {
      ...options.persistence,
      context: structuredClone(options.persistence.context),
    };
    const host = {
      stamp: options.host.stamp.bind(options.host),
      ...(options.host.persistence === undefined
        ? {}
        : { persistence: options.host.persistence }),
    };
    let persistenceInitial: NativeSessionPersistenceOptions["initial"];
    if (initial.kind === "owned-existing") {
      const binding = initial.binding;
      if (
        binding.path !== path ||
        binding.sessionId !== sessionId ||
        typeof binding.cursorUuid !== "string" ||
        !binding.cursorUuid ||
        !Number.isSafeInteger(binding.byteLength) ||
        binding.byteLength <= 0 ||
        !/^[a-f0-9]{64}$/.test(binding.sha256)
      )
        throw new Error("Owned native resume requires its exact saved binding");
      persistenceInitial = {
        kind: "owned-existing",
        cursorUuid: binding.cursorUuid,
        expected: { byteLength: binding.byteLength, sha256: binding.sha256 },
      };
    } else persistenceInitial = initial;
    const ownership = await NativeSessionOwnership.acquire(
      options.ownership,
      signal,
    );
    try {
      const journal = await NativeSessionJournal.open(
        {
          ...persistence,
          path,
          withExclusiveOwnership: ownership.withExclusiveOwnership,
          initial: persistenceInitial,
        },
        host,
        signal,
      );
      return new NativeSessionLifetime(journal, ownership, path, sessionId);
    } catch (error) {
      try {
        await ownership.close();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Native session open failed and its ownership could not be released",
        );
      }
      throw error;
    }
  }

  /** Drain accepted events and verify their actual file before saving a binding. */
  async save(signal: AbortSignal): Promise<NativeSessionBinding> {
    if (this.#close) throw new Error("Native session lifetime is closing");
    const state = await this.journal.checkpoint(signal);
    return Object.freeze({
      path: this.#path,
      sessionId: this.#sessionId,
      cursorUuid: state.cursorUuid,
      byteLength: state.byteLength,
      sha256: state.sha256,
    });
  }

  /**
   * The host supplies a separate cleanup signal when its query was cancelled.
   * Both owners are always drained/closed; failure never reports a successful save.
   */
  close(verificationSignal: AbortSignal): Promise<void> {
    if (this.#close) return this.#close;
    // close() immediately seals journal acceptance before its first await.
    const drained = this.journal.close(verificationSignal);
    this.#close = (async () => {
      const errors: unknown[] = [];
      try {
        await drained;
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.#ownership.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Native session shutdown failed");
    })();
    return this.#close;
  }
}
