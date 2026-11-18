/**
 * The Monitor tool (chunk-tzrw0807 Fe/Ue, chunk-pvr1jj26 gqs/lBo/eka and
 * chunk-9rq0p1w9 JRr/Oko/K7): a background shell whose stdout lines reach
 * the model as task notifications while it keeps working. A monitor is a
 * local_bash task in the shared background-shell registry, so TaskStop,
 * the end-of-turn wait and the exit notification are the ones Bash uses.
 */
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { ShellExit, ShellExitReport } from "./background-shells.js";
import { formatTaskNotification } from "./background-shells.js";
import { formatDuration, hidden, type ShellHost } from "./bash-tool.js";
import type { GuardedTool } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";

export const MONITOR_TOOL = "Monitor";
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = 3600000;
/** Pje(): a single-shot print session caps deadlines at 10 minutes, others at 30. */
export const monitorDeadlineCap = (singleShot: boolean) =>
  singleShot ? 600000 : 1800000;

export interface MonitorFacts {
  singleShot: boolean;
  /** bXe(): with background tasks off, a single wait is a foreground Bash loop. */
  backgroundDisabled: boolean;
}

const minutes = (ms: number) => `${Math.round(ms / 60000)} minutes`;

/** gqs + _qs + hqs, for a local session with tool_search's bounded monitors (Dye). */
export function monitorDescription(facts: MonitorFacts): string {
  const foreground = facts.backgroundDisabled;
  const one =
    '- **One** ("tell me when the server is ready / the build finishes") → ' +
    (foreground
      ? 'run the command in the **foreground with Bash**, exiting when the condition is true, e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done`.'
      : 'use **Bash with `run_in_background`** and a command that exits when the condition is true, e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done`. You get a single completion notification when it exits.');
  const untilLoop = foreground
    ? "use a foreground Bash `until` loop instead"
    : "use Bash `run_in_background` with an `until` loop instead (one notification, ends in seconds)";
  const expiry = `Every monitor expires after \`timeout_ms\` (default ${minutes(DEFAULT_TIMEOUT_MS)}, at most ${minutes(monitorDeadlineCap(facts.singleShot))}): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set \`timeout_ms\` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected.`;
  return `Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
${one}
- **One per occurrence, until the monitor expires (re-arm to continue)** ("tell me every time an ERROR line appears") → Monitor with an unbounded command (\`tail -f\`, \`inotifywait -m\`, \`while true\`).
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → Monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"

  # Each file change is an event
  inotifywait -m -q --format '%e %f' /watched/dir

  # Poll GitHub for new PR comments and emit one line per new comment
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while true; do
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\\(.user.login): \\(.body)"'
    last=$now; sleep 30
  done

  # Node script that emits events as they arrive (e.g. WebSocket listener)
  node watch-for-events.js

  # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
  prev=""
  while true; do
    s=$(gh pr checks 123 --json name,bucket)
    cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur")
    prev=$cur
    jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
    sleep 30
  done

**Don't use an unbounded command for a single notification.** \`tail -f\`, \`inotifywait -m\`, and \`while true\` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," ${untilLoop}. Note that \`tail -f log | grep -m 1 ...\` does *not* fix this: if the log goes quiet after the match, \`tail\` never receives SIGPIPE and the pipeline hangs anyway.

**Script quality:**
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`. \`head\` cannot flush at all — \`| head -N\` delivers nothing until N matches accumulate, then ends the stream.
- In poll loops, handle transient failures (\`curl ... || true\`) — one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
- Write a specific \`description\` — it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. Stderr goes to the output file (readable via Read) but does not trigger notifications — for a command you run directly (e.g. \`python train.py 2>&1 | grep --line-buffered ...\`), merge stderr with \`2>&1\` so its failures reach your filter. (No effect on \`tail -f\` of an existing log — that file only contains what its writer redirected.)

**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.

  # Wrong — silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="

  # Right — one alternation covering progress + the failure signatures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"

For poll loops checking job state, emit on every terminal status (\`succeeded|failed|cancelled|timeout\`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; filter to exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.

Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.

The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). ${expiry} Use TaskStop to cancel early.${WS_SECTION}`;
}
const WS_SECTION = `
**ws source** — open a WebSocket and stream each incoming text frame as an event. No shell, no polling: the server pushes, you get notified.

  Monitor({
    ws: {url: 'wss://events.example.com/stream', protocols: ['v1']},
    description: 'deploy events',
  })

Each text frame becomes one notification (multiline frames stay as one event). Binary frames are reported as \`[binary frame, N bytes]\` rather than passed through. Socket close ends the watch with the close code surfaced; errors are surfaced before close. Same rate limiting as bash — a firehose will be suppressed and eventually stopped, so subscribe to a filtered feed where one exists.

Prefer this over \`command: 'websocat wss://…'\` — it avoids the extra process and line-buffering pitfalls. Use bash when you need to transform or filter frames with shell tools before they become events.`;

const CONTROL =
  "command contains control characters that would be hidden in the approval dialog";
const wsSchema = z
  .object({
    url: z
      .string()
      .refine(
        (value) => !hidden(value),
        "url contains control characters that would be hidden in the approval dialog",
      )
      .refine((value) => {
        const url = URL.parse(value);
        return (
          url !== null &&
          (url.protocol === "ws:" || url.protocol === "wss:") &&
          !url.username &&
          !url.password &&
          !/[\t\n\r]/.test(value) &&
          /^\p{ASCII}*$/u.test(value)
        );
      }, "url must be a valid ASCII ws:// or wss:// URL with no userinfo or whitespace"),
    protocols: z
      .array(
        z
          .string()
          .regex(
            /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
            "protocol must be an RFC 6455 token",
          ),
      )
      .refine(
        (protocols) => new Set(protocols).size === protocols.length,
        "protocols must be unique",
      )
      .optional(),
  })
  .describe(
    "WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command.",
  );

/** Ee: se() + ue(), refined to exactly one source. */
export function monitorInputSchema(facts: Pick<MonitorFacts, "singleShot">) {
  const cap = monitorDeadlineCap(facts.singleShot);
  return z
    .object({
      description: z
        .string()
        .describe(
          "Short human-readable description of what you are monitoring (shown in notifications).",
        ),
      timeout_ms: z
        .number()
        .min(1000)
        .max(MAX_TIMEOUT_MS, `timeout_ms must be ≤ ${MAX_TIMEOUT_MS}`)
        .optional()
        .default(DEFAULT_TIMEOUT_MS)
        .describe(
          `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms. Deadlines above ${cap}ms are capped to ${cap}ms. You are notified at expiry and can re-arm.`,
        ),
      command: z
        .string()
        .refine((value) => !hidden(value), CONTROL)
        .optional()
        .describe(
          "Shell command or script. Each stdout line is an event; exit ends the watch.",
        ),
      ws: wsSchema.optional(),
    })
    .refine(
      (input) => [input.command, input.ws].filter(Boolean).length === 1,
      "exactly one of command or ws",
    );
}
export type MonitorInput = z.output<ReturnType<typeof monitorInputSchema>>;

export function monitorDefinition(facts: MonitorFacts): ToolDefinition {
  return {
    name: MONITOR_TOOL,
    description: monitorDescription(facts),
    input_schema: {
      ...z.toJSONSchema(monitorInputSchema(facts)),
      type: "object",
    },
  };
}

const LINE_CHARS = 500;
const BATCH_CHARS = 3000;
const BATCH_MS = 200;
const PENDING_BYTES = 1048576;
const truncated = (text: string, limit: number, marker: string) =>
  text.length <= limit ? text : `${text.slice(0, limit)}${marker}`;

/** Oko: complete stdout lines, trimmed and capped, batched for 200 ms. */
function createLineBatcher(
  deliver: (batch: string) => void,
  schedule: (callback: () => void) => () => void,
) {
  let partial = "",
    lines: string[] = [],
    cancel: (() => void) | undefined;
  const take = (final: boolean): string | undefined => {
    cancel?.();
    cancel = undefined;
    if (final && partial.trim()) {
      lines.push(truncated(partial.trim(), LINE_CHARS, "...(truncated)"));
      partial = "";
    }
    if (!lines.length) return undefined;
    const batch = truncated(lines.join("\n"), BATCH_CHARS, "\n...(truncated)");
    lines = [];
    return batch;
  };
  const flush = (final = false) => {
    const batch = take(final);
    if (batch !== undefined) deliver(batch);
  };
  return {
    onData(text: string) {
      partial += text;
      if (partial.length > PENDING_BYTES)
        partial = partial.slice(-PENDING_BYTES);
      let newline;
      while ((newline = partial.indexOf("\n")) !== -1) {
        const line = partial.slice(0, newline).trim();
        partial = partial.slice(newline + 1);
        if (line) lines.push(truncated(line, LINE_CHARS, "...(truncated)"));
      }
      if (lines.length && !cancel) cancel = schedule(() => flush());
    },
    flush,
    drain: () => take(true),
  };
}

/** eUe/tUe/nUe: ten events, then one more every two seconds. */
const BUCKET = { capacity: 10, refillMs: 2000 };
const SUPPRESSION_LIMIT_MS = 30000;
function createBucket(now: () => number) {
  let tokens = BUCKET.capacity,
    since = now();
  const refill = () => {
    const earned = Math.floor((now() - since) / BUCKET.refillMs);
    if (earned > 0) {
      tokens = Math.min(BUCKET.capacity, tokens + earned);
      since += earned * BUCKET.refillMs;
    }
  };
  return {
    tryConsume() {
      refill();
      if (tokens <= 0) return false;
      tokens--;
      return true;
    },
    full() {
      refill();
      return tokens === BUCKET.capacity;
    },
  };
}

export interface MonitorWatchOptions {
  /** K7: queue one notification for this watch; housekeeping marks the watch's own notices. */
  announce(text: string, housekeeping: boolean): void;
  /** Stops the task; false when it is already gone. */
  kill(): boolean;
  now?: () => number;
  schedule?: (callback: () => void) => () => void;
}

/** JRr: batches become events under a token bucket; a long flood stops the task. */
export function createMonitorWatch(options: MonitorWatchOptions) {
  const now = options.now ?? Date.now;
  const bucket = createBucket(now);
  let closed = false,
    delivered = 0,
    suppressed = 0,
    suppressedSince: number | undefined,
    lastAt = now();
  /** D: spend a token on this batch, first reporting what the bucket dropped. */
  const admit = () => {
    if (now() - lastAt > BUCKET.refillMs * 3 || bucket.full())
      suppressedSince = undefined;
    lastAt = now();
    if (!bucket.tryConsume()) {
      suppressed++;
      suppressedSince ??= now();
      return false;
    }
    if (suppressed > 0) {
      options.announce(
        `[${suppressed} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`,
        true,
      );
      suppressed = 0;
    }
    delivered++;
    return true;
  };
  const onBatch = (batch: string) => {
    if (closed) return;
    if (admit()) return options.announce(batch, false);
    if (
      suppressedSince !== undefined &&
      now() - suppressedSince > SUPPRESSION_LIMIT_MS
    ) {
      const seconds = Math.round((now() - suppressedSince) / 1000);
      closed = true;
      if (options.kill())
        options.announce(
          `[Monitor stopped — too much output (${suppressed} events suppressed over ${seconds}s). Restart with a more selective source.]`,
          true,
        );
    }
  };
  const lines = createLineBatcher(
    onBatch,
    options.schedule ??
      ((callback) => {
        const timer = setTimeout(callback, BATCH_MS);
        return () => clearTimeout(timer);
      }),
  );
  return {
    onData(text: string) {
      if (!closed) lines.onData(text);
    },
    flush: () => lines.flush(),
    isClosed: () => closed,
    eventCount: () => delivered,
    /** reportExit: the last lines go into the exit notification when there is one. */
    finish(withNotification: boolean): string | undefined {
      const rest = closed ? undefined : lines.drain();
      closed = true;
      if (rest === undefined || !admit()) return undefined;
      if (withNotification) return rest;
      options.announce(rest, false);
      return undefined;
    },
  };
}
export type MonitorWatch = ReturnType<typeof createMonitorWatch>;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
const escape = (text: string) => text.replace(/[&<>]/g, (c) => ESCAPES[c] ?? c);
/** H: the escaped event text as the notification body. */
const eventBody = (text: string) => `\n<event>${escape(text)}</event>`;

/** K7: one event or notice, under the "Monitor event" summary. */
export function formatMonitorEvent(
  taskId: string,
  description: string,
  text: string,
): string {
  return formatTaskNotification(
    { taskId, summary: `Monitor event: "${description}"` },
    eventBody(text),
  );
}

/** QFo: the exit summary of a monitor. */
export function monitorExitSummary(
  description: string,
  ending: ShellExit,
  producedOutput: boolean,
): string {
  const code = ` (exit ${ending.code})`;
  switch (ending.completion.status) {
    case "completed":
      return producedOutput
        ? `Monitor "${description}" stream ended`
        : `Monitor "${description}" ended without producing output${code}`;
    case "failed":
      return `Monitor "${description}" script failed${code}`;
    case "killed":
      return `Monitor "${description}" stopped`;
  }
}

/** lBo for a bounded monitor: the one notice at expiry. */
export function monitorExpiryNotice(
  timeoutMs: number,
  events: number,
  stderrFile?: string,
): string {
  const stderr =
    events === 0 && stderrFile
      ? `Its command wrote to stderr, which isn't delivered as events and may mean it failed: see \`${stderrFile}\`. `
      : "";
  const after = formatDuration(timeoutMs, true);
  if (events === 0)
    return `[Monitor expired after ${after} with no events delivered. ${stderr}Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]`;
  return `[Monitor expired after ${after} with ${events} ${events === 1 ? "event" : "events"} delivered. Re-arm it if you still need the watch.]`;
}

/** mapToolResultToToolResultBlockParam for a bounded monitor (Dye). */
export function monitorStartedText(taskId: string, timeoutMs: number): string {
  return `Monitor started (task ${taskId}, expires in ${formatDuration(timeoutMs, true)} unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`;
}

export interface MonitorToolOptions {
  shell: ShellHost;
  facts(): MonitorFacts;
}

/** Ue: start the shell, arm the deadline, and stream its stdout through a watch. */
async function startCommandMonitor(
  options: MonitorToolOptions,
  input: MonitorInput & { command: string },
  timeoutMs: number,
  toolUseId: string,
): Promise<string> {
  const { shell } = options;
  let taskId: string | undefined,
    stdoutBytes = 0,
    deadline: ReturnType<typeof setTimeout> | undefined;
  const announce = (text: string) => {
    if (taskId !== undefined)
      shell.shells.announce(
        formatMonitorEvent(taskId, input.description, text),
      );
  };
  const stop = () => {
    if (taskId === undefined || shell.shells.get(taskId)?.status !== "running")
      return false;
    void shell.shells.stop(taskId);
    return true;
  };
  const watch = createMonitorWatch({ announce, kill: stop });
  const task = await shell.startMonitor({
    command: input.command,
    description: input.description,
    toolUseId,
    onStdout(text) {
      stdoutBytes += Buffer.byteLength(text);
      watch.onData(text);
    },
    onExit(ending): ShellExitReport | undefined {
      clearTimeout(deadline);
      const rest = watch.finish(ending !== undefined);
      if (ending === undefined) return undefined;
      return {
        summary: monitorExitSummary(input.description, ending, stdoutBytes > 0),
        ...(rest === undefined ? {} : { body: eventBody(rest) }),
      };
    },
  });
  taskId = task.id;
  deadline = setTimeout(async () => {
    if (watch.isClosed()) return;
    watch.flush();
    if (watch.isClosed()) return;
    const total = await stat(task.outputFile).then(
      (info) => info.size,
      () => 0,
    );
    announce(
      monitorExpiryNotice(
        timeoutMs,
        watch.eventCount(),
        total > stdoutBytes ? task.outputFile : undefined,
      ),
    );
    stop();
  }, timeoutMs);
  return task.id;
}

export function monitorTool(
  options: MonitorToolOptions,
): GuardedTool<MonitorInput> {
  return {
    name: MONITOR_TOOL,
    definition: () => monitorDefinition(options.facts()),
    schema: () => monitorInputSchema(options.facts()),
    async validate(input) {
      return input.ws === undefined
        ? undefined
        : "Monitor ws sources are not available in this build. Use command instead.";
    },
    async check(input) {
      return {
        behavior: "ask",
        prompt: `Run Monitor (shell is NOT sandboxed and can access files outside the workspace): ${input.command ?? input.ws?.url ?? ""}`,
      };
    },
    async run(input, call) {
      const command = input.command;
      if (command === undefined) throw new Error("Monitor needs a command");
      const timeoutMs = Math.min(
        input.timeout_ms,
        monitorDeadlineCap(options.facts().singleShot),
      );
      const taskId = await startCommandMonitor(
        options,
        { ...input, command },
        timeoutMs,
        call.id,
      );
      return monitorStartedText(taskId, timeoutMs);
    },
  };
}
