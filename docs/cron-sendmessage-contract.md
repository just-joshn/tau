# CronCreate, CronDelete, CronList, and SendMessage

Tau's port of the four deferred tools from Claude Code 2.1.326, for one local
session. Sources are the recovered bundle chunks named below, read as text.
Each needle in `docs/cron-sendmessage-needles.json` occurs once in one chunk.
`bun scripts/differential/check_cron_sendmessage_bundle.ts <bundle-dir>` checks
the needles and the schema strings tau sends.

## Shapes

A cron job is one record: `id` (8 hex chars), `cron` (5 local-time fields
`M H DoM Mon DoW`, Sunday is 7), `prompt`, `createdAt`, optional `lastFiredAt`,
`recurring`, `permanent`, `createdBySessionId`, `createdByPid`,
`createdByProcStart`, `createdInProject`, `plugin`, plus in-memory `durable`
and optional `agentId`. Durable jobs live in
`<project>/.claude/scheduled_tasks.json` as `{ "tasks": [ ... ] }` (pretty JSON,
trailing newline). Disk records omit `durable`. One `CronJobStore` owns the
memory list and that file, under a promise chain, and replaces the file by
writing a temp and renaming. Session jobs are not written.

SendMessage has one recipient: `"main"`, one in-process agent (name or agent
id), a duplicate name, or a miss. The tool result is pretty JSON
`{ "success", "message" }` with `is_error` false. A validation refusal is
`is_error` with `<tool_use_error>`. The CLI caller is main, with an empty
agent list and no-op delivery hooks. In-process delivery is the `SendDirectory`
used by unit tests.

## Catalog and permission

All four are deferred builtins (`src/tool-search.ts`). They appear after
ToolSearch `select:CronCreate,CronDelete,CronList,SendMessage`, and eagerly
when `ENABLE_TOOL_SEARCH` is false. Names are legal in `--tools`,
`--allowedTools`, and `--disallowedTools`. `CLAUDE_CODE_DISABLE_CRON` set to
any non-empty string (including `0` and `false`) removes the three cron tools.
SendMessage stays. `check` is `{ behavior: "allow" }` in every permission mode
tau has. There is no auto mode, so the original classifier sentences are not
reachable.

## Cron

Chunks: `chunk-b7zts8xt` (create), `chunk-c93dfh89` (delete), `chunk-8a6symse`
(list), `chunk-223am0ab` (prompts), `chunk-psw0db44` (scheduler and file).

Create requires `cron` and `prompt`. `recurring` defaults true. `durable`
defaults false. Validation order: bad cron (`Invalid cron expression '...'`),
no match in the next year, 50 jobs, then a durable teammate refusal when a
caller agent id is set. The CLI does not set one. The result is one sentence:
recurring or one-shot, the human schedule, the next run, session-only or
`Persisted to .claude/scheduled_tasks.json`, and the 7-day line for recurring
jobs. Delete of an unknown id, or of any id when the tasks file is unreadable,
is a validation error (the unreadable sentence is the bundle's F3s text).
Delete of a session job does not touch disk. List is disk jobs, then session
jobs, one line each: id, em dash, human schedule, `(recurring)` or
`(one-shot)`, `[session-only]` only when `durable` is false, next run, prompt
clipped to 80 display columns.

Next-run math is local time. Both day-of-month and day-of-week restricted
means either matches. The search starts at the next minute and stops after
527040 minutes. A `*/N * * * *` job whose period is at least 5 minutes and
within 15 seconds of the cache lead fires `period - 15s` after the anchor.
Recurring jitter is `min(hash * 0.5 * period, 30 min)` on the first fire.
One-shot times on minute 0 or 30 move up to 90 seconds earlier. Other one-shots
stay on the match. Display times are rounded to the nearest minute.

## SendMessage

Chunk `chunk-z74wfcch`. Agent teams are off, so `message` is a string
(default empty, not required on the input schema). Harbor discovery is on, so
`notify_when_idle` is in the schema and the prompt. `to` is one line, at most
300 characters. `summary` is at most 200 and is not delivered. Empty `message`
is refused unless `notify_when_idle` is set, and a subagent cannot subscribe.
`"*"`, `uds:` / `bridge:` with an empty target, a path-like address, an `@`
team address, and a JSON protocol frame are refused. Main cannot address main.
An unknown name gets the in-process not-found sentence. A running agent is
queued for its next tool round. A stopped agent is not resumed. Two agents
with the same name must be addressed as `name [agentId]`.

## Not in this port

Jobs do not enqueue prompts while the REPL is idle, and the 7-day expiry is
prompt text only. The self-hosted one-shot MCP refusal (`tengu_snug_crystal`,
default false) is absent. Loop jobs are absent. Cross-session sockets, the
bridge, cloud sessions, and ListAgents discovery are described and not routed.
Prefix match, resume-on-send, team roster, and idle subscription are absent.
An unreadable tasks file counts as zero jobs and a later durable create
replaces it. A symlink at `.claude` or at the tasks file is refused. The
plugin-name check is the length and control-character rule, not the original
`pZe` helper. `summary` is rejected past 200 characters; the description still
says it is truncated.
