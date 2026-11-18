import { readFileSync } from "node:fs";
import type {
  PermissionChoice,
  PermissionDialog,
  ToolApprovalRequest,
} from "../permission-dialog.js";
import type { AgentEvent, PermissionMode } from "../types.js";
import { decodeKeys, type Key } from "./keys.js";
import { render, type Size } from "./render.js";
import { Screen } from "./screen.js";
import {
  initialState,
  type AppState,
  type CommandEntry,
  type Field,
  type ModelChoice,
  type StatusTab,
  type TranscriptItem,
  type Welcome,
} from "./state.js";
import { finishTool, startTool } from "./tool-display.js";
import { DOUBLE_PRESS_MS, update, type Effect } from "./update.js";
import { DONE_VERBS, SPINNER_VERBS } from "./verbs.js";

export interface TuiOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  welcome: Welcome;
  cwd: string;
  bypassAvailable: boolean;
  commands: readonly CommandEntry[];
  /** The session's permission mode; the host owns it. */
  mode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  /** Esc or Ctrl-C while a turn runs. */
  interrupt(): void;
}

export type TurnOutcome =
  | { kind: "done" }
  | { kind: "interrupted" }
  /** Nothing to add: a refusal already marked its row, or the caller reports. */
  | { kind: "silent" }
  | { kind: "failed"; message: string };

function pick<T>(values: readonly [T, ...T[]]): T {
  return values[Math.floor(Math.random() * values.length)] ?? values[0];
}

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clockTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

type Settle<T> = (value: T) => void;

/**
 * The interactive terminal: owns raw input, the alternate screen and the app
 * state, turns keys into effects and agent events into transcript rows.
 */
export class Tui {
  private state: AppState;
  private readonly screen: Screen;
  private pendingInput = "";
  private submitted: string[] = [];
  private waiter: Settle<string | undefined> | undefined;
  private permission: Settle<PermissionChoice> | undefined;
  private model: Settle<string | undefined> | undefined;
  private exiting = false;
  private running = false;
  private scheduled = false;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private streaming: number | undefined;
  private turnStart = 0;

  constructor(private readonly options: TuiOptions) {
    this.state = initialState(options.welcome, {
      mode: options.mode(),
      bypassAvailable: options.bypassAvailable,
      commands: options.commands,
    });
    this.screen = new Screen(options.output);
  }

  private size(): Size {
    return {
      columns: this.options.output.columns || 80,
      rows: this.options.output.rows || 24,
    };
  }

  start(): void {
    const { input, output } = this.options;
    this.running = true;
    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.on("data", this.onData);
    input.resume();
    output.on("resize", this.onResize);
    this.screen.enter();
    this.paint();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.spinner);
    clearTimeout(this.expiry);
    const { input, output } = this.options;
    input.removeListener("data", this.onData);
    output.removeListener("resize", this.onResize);
    input.setRawMode?.(false);
    input.pause();
    this.screen.leave();
    this.waiter?.(undefined);
    this.waiter = undefined;
  }

  /** The next submitted prompt, or undefined once the user exits. */
  next(): Promise<string | undefined> {
    const queued = this.submitted.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.exiting || !this.running) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private onData = (chunk: string | Buffer) => {
    const { keys, rest } = decodeKeys(this.pendingInput + chunk.toString());
    this.pendingInput = rest;
    for (const key of keys) this.dispatch(key);
  };

  private onResize = () => {
    this.screen.invalidate();
    this.paint();
  };

  private dispatch(key: Key): void {
    const before = { ...this.state, mode: this.options.mode() };
    const { state, effects } = update(before, key, performance.now());
    this.state = state;
    for (const effect of effects) this.apply(effect);
    if (state.exitArmed || state.escapeArmedAt !== undefined) {
      clearTimeout(this.expiry);
      this.expiry = setTimeout(() => {
        this.state = {
          ...this.state,
          exitArmed: undefined,
          escapeArmedAt: undefined,
        };
        this.schedule();
      }, DOUBLE_PRESS_MS);
      this.expiry.unref?.();
    }
    this.schedule();
  }

  private apply(effect: Effect): void {
    switch (effect.kind) {
      case "submit":
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = undefined;
          waiter(effect.text);
        } else this.submitted.push(effect.text);
        return;
      case "interrupt":
        this.options.interrupt();
        return;
      case "exit": {
        this.exiting = true;
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.(undefined);
        return;
      }
      case "mode":
        this.options.setMode(effect.mode);
        return;
      case "permission": {
        const pending = this.permission;
        this.permission = undefined;
        pending?.(effect.choice);
        return;
      }
      case "model": {
        const pending = this.model;
        this.model = undefined;
        pending?.(effect.model);
        return;
      }
      case "dismiss":
        return;
    }
  }

  private schedule(): void {
    if (this.scheduled || !this.running) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.paint();
    });
  }

  private paint(): void {
    if (!this.running) return;
    this.state = { ...this.state, mode: this.options.mode() };
    const size = this.size();
    this.screen.paint(render(this.state, size), size.rows);
  }

  private set(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next };
    this.schedule();
  }

  private push(...items: TranscriptItem[]): void {
    this.set({ items: [...this.state.items, ...items] });
  }

  setModel(label: string): void {
    this.set({ welcome: { ...this.state.welcome, model: label } });
  }

  setCommands(commands: readonly CommandEntry[]): void {
    this.set({ commands });
  }

  /** Starts a fresh transcript under the welcome header (/clear). */
  clear(): void {
    this.streaming = undefined;
    this.set({ items: [] });
  }

  user(text: string): void {
    this.push({ kind: "user", text });
  }

  command(
    input: string,
    output: readonly string[],
    tone: "info" | "error" = "info",
  ): void {
    this.push({ kind: "command", input, output, tone });
  }

  notice(text: string, tone: "info" | "error" = "info"): void {
    this.push({ kind: "notice", text, tone });
  }

  beginTurn(): void {
    this.turnStart = performance.now();
    this.streaming = undefined;
    this.set({
      busy: { verb: pick(SPINNER_VERBS), startedAt: this.turnStart, frame: 0 },
    });
    clearInterval(this.spinner);
    this.spinner = setInterval(() => {
      const busy = this.state.busy;
      if (busy) this.set({ busy: { ...busy, frame: busy.frame + 1 } });
    }, 120);
    this.spinner.unref?.();
  }

  endTurn(outcome: TurnOutcome): void {
    clearInterval(this.spinner);
    this.spinner = undefined;
    this.streaming = undefined;
    const rows: TranscriptItem[] = [];
    switch (outcome.kind) {
      case "done":
        rows.push({
          kind: "done",
          verb: pick(DONE_VERBS),
          elapsed: elapsed(performance.now() - this.turnStart),
          at: clockTime(new Date()),
        });
        break;
      case "interrupted":
        rows.push({ kind: "interrupted" });
        break;
      case "silent":
        break;
      case "failed":
        rows.push({ kind: "notice", text: outcome.message, tone: "error" });
        break;
    }
    this.set({ busy: undefined, items: [...this.state.items, ...rows] });
  }

  /** Maps one agent event of the running turn onto the transcript. */
  event(event: AgentEvent): void {
    const items = this.state.items;
    switch (event.type) {
      case "text":
      case "text_reset": {
        const index = this.streaming;
        const current = index === undefined ? undefined : items[index];
        if (index !== undefined && current?.kind === "assistant") {
          if (event.type === "text_reset" && !event.text) {
            this.streaming = undefined;
            this.set({ items: items.filter((_, at) => at !== index) });
            return;
          }
          const next = [...items];
          next[index] = {
            ...current,
            text:
              event.type === "text" ? current.text + event.text : event.text,
          };
          this.set({ items: next });
          return;
        }
        if (!event.text) return;
        this.streaming = items.length;
        this.push({ kind: "assistant", text: event.text.replace(/^\n+/, "") });
        return;
      }
      case "assistant":
        this.streaming = undefined;
        return;
      case "tool_start":
        this.streaming = undefined;
        this.set({
          items: startTool(items, event.tool, this.options.cwd, readText),
        });
        return;
      case "tool_result":
        this.set({ items: finishTool(items, event.result) });
        return;
      case "warning":
        this.notice(event.message, "error");
        return;
      case "compaction":
        if (event.stage === "start")
          this.notice("Compacting conversation context...");
        else if (event.stage === "complete")
          this.notice(
            `Context compacted (${event.beforeTokens} → ${event.afterTokens} estimated tokens).`,
          );
        else if (event.stage === "failed")
          this.notice(
            "Context compaction failed; original conversation preserved.",
            "error",
          );
        return;
      default:
        return;
    }
  }

  /** Shows a view until its pending answer settles or `signal` aborts. */
  private await<T>(
    view: AppState["view"],
    hold: (settle: Settle<T> | undefined) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        hold(undefined);
        this.set({ view: { kind: "prompt" } });
        reject(signal?.reason);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      hold((value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      });
      this.set({ view, exitArmed: undefined, shortcuts: false });
    });
  }

  private ask(
    view: Extract<AppState["view"], { kind: "permission" }>,
    signal?: AbortSignal,
  ): Promise<PermissionChoice> {
    return this.await(
      view,
      (pending) => {
        this.permission = pending;
      },
      signal,
    );
  }

  /** The tool permission dialog; Edit and Write calls show their pending patch. */
  choosePermission(
    dialog: PermissionDialog,
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): Promise<PermissionChoice> {
    const pending = this.state.items.findLast(
      (entry) => entry.kind === "tool" && entry.status === "pending",
    );
    const patch =
      pending?.kind === "tool" && dialog.subtitle !== undefined
        ? pending.patch
        : undefined;
    return this.ask(
      {
        kind: "permission",
        dialog,
        title:
          dialog.title ??
          (request.tool === "Bash" ? "Bash command" : "Tool use"),
        focus: 0,
        ...(patch === undefined ? {} : { patch }),
      },
      signal,
    );
  }

  /** A yes/no question in the permission dialog's frame, without a tool header. */
  async confirm(description: string, signal?: AbortSignal): Promise<boolean> {
    const dialog: PermissionDialog = {
      body: description,
      question: "Do you want to proceed?",
      options: [
        { label: "Yes", choice: { kind: "accept-once" } },
        { label: "No", choice: { kind: "reject" } },
      ],
    };
    const choice = await this.ask(
      { kind: "permission", dialog, focus: 0 },
      signal,
    );
    return choice.kind !== "reject";
  }

  /** The model picker; resolves with the chosen model or undefined when kept. */
  pickModel(choices: readonly ModelChoice[]): Promise<string | undefined> {
    const focus = Math.max(
      0,
      choices.findIndex((choice) => choice.current),
    );
    return this.await({ kind: "model", choices, focus }, (pending) => {
      this.model = pending;
    });
  }

  showHelp(custom: readonly CommandEntry[]): void {
    this.set({ view: { kind: "help", tab: "general", custom } });
  }

  showStatus(fields: Readonly<Record<StatusTab, readonly Field[]>>): void {
    this.set({ view: { kind: "status", tab: "status", fields } });
  }
}
