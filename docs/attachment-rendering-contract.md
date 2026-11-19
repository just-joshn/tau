# Attachment rendering contract

This reference describes how mid-turn attachments reach the Messages request, in
Claude Code 2.1.326 and in tau. Chunk names refer to
`artifacts/claude-bundle/`. The readable copy of the main chunk is
`artifacts/claude-restored-2026-11-18/pretty/chunk-4h798pp0.js`. Each source
literal in `docs/attachment-rendering-needles.json` occurs once in one chunk:

```sh
jq -r '.[]' docs/attachment-rendering-needles.json | while IFS= read -r n; do
  rg -c -F -- "$n" artifacts/claude-bundle; done
```

## Data shape

| Original                                                   | tau                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Transcript `attachment` rows, typed by `attachment.type`   | `Attachment` union in `src/attachments.ts`                                                          |
| Renderer table `BGo` (chunk-4h798pp0)                      | `renderAttachment` switch in `src/attachments.ts`                                                   |
| Attachment row in the transcript                           | `Message.attachment`, built by `attachmentMessage`; `content` keeps the rendering for local readers |
| Hook messages yielded next to a tool result (`GGn`, `Sfn`) | `ToolResult.hookAttachments`: `{ phase } & Attachment` in hook order                                |
| `origin.kind === "task-notification"` on a user row        | `Message.origin: "task-notification"`                                                               |
| API normalizer (the large function that calls `Vke`)       | `projectMessages` in `src/thinking-history.ts`, then `projectHookAttachmentHistory`                 |

Saved sessions keep tau's message model. Folding and wrapping happen only in
`projectMessages`, so a resumed session renders the same request. A saved
`hookAttachments` entry from before the union (`{phase, event, toolName,
content}`) parses as `hook_additional_context` with `hookName`
`${event}:${toolName}` (`legacyHookAttachmentSchema` in `src/types.ts`).

## Wrappers (chunk-9vn1dyjv, chunk-4h798pp0)

- `qs(e)` is `<system-reminder>\n${e}\n</system-reminder>`. tau: `systemReminder`.
- `XVt` replaces `<` before `system-reminder` or `/system-reminder` with `&lt;`.
  `tD` adds the same escape for a trailing `<` or `</`. `Yke(e)` is
  `qs(tD(e))`. tau: `escapeReminderTags`, `escapeReminderText`.
- `YVt` replaces a whole `</system-reminder>` with `&lt;/system-reminder&gt;`.
- `KVt` prefixes `jMe`, the `[SYSTEM NOTIFICATION - NOT USER INPUT]` block with
  its four explanation lines and a blank line. It does nothing when the text
  already starts with `jMe`.
- `A3s(e)` is `<system-reminder>\n${KVt(YVt(e))}\n</system-reminder>`, unless `e`
  is already wrapped. tau: `wrapTaskNotification`.

## Renderers (chunk-4h798pp0, `BGo` table)

| Kind                                                                          | Rendered messages                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `hook_blocking_error`                                                         | `Yke(`${hookName} hook blocking error from command: "${command}": ${blockingError}`)` |
| `hook_additional_context`                                                     | `Yke(`${hookName} hook additional context: ${content.join("\n")}`)`, none when empty  |
| `async_hook_response`                                                         | one `qs(tD(text))` per `systemMessage`, then `additionalContext` (`_9` order)         |
| `total_tokens_reminder`                                                       | `qs(text)`                                                                            |
| `hook_system_message`, `hook_non_blocking_error`, `async_hook_response_batch` | none                                                                                  |

`hookName` is `${event}:${toolName}` for tool events (`GGn` builds
`PostToolUse:${tool.name}`). The command hook runner sets `blockingError` per
hook. On exit 2 it is `` `[${LI(hook)}]: ${stderr || "No stderr output"}` ``.
`LI` joins `command` and `args` with spaces and does not expand
`${CLAUDE_PROJECT_DIR}`. On `"decision": "block"` it is `reason || "Blocked by
hook"`. tau stores both on `HookResult.blockingError` in `src/hooks.ts`.
`tool-hook-runtime` turns each blocking result into a `hook_blocking_error`,
followed by one `hook_additional_context` for the batch.

## Folding into the tool result (chunk-4h798pp0)

1. Attachments bubble up past plain user rows to the nearest assistant row or
   tool-result row (`RPi`). tau: `relocate` in
   `src/hook-attachment-projection.ts`.
2. The normalizer reduces each rendered attachment message into the previous
   user row with `Vke`. `Vke` calls `xGo`, which appends to the row's trailing
   `tool_result` when every new block is text. Special results and protected
   texts (`gGo`, `pGo`, `eUt`, `DBt`) stay separate. tau: `appendAttachment`
   and `protectedResult`.
3. `o4e` joins a string result as `[content.trim(), ...texts.map(trim)]`,
   drops empties, and joins with `\n\n`. The trim is why a Read ending `2\t`
   is sent as `2`. tau: `appendProjectedToolResultContent`.
4. With no user row before it, an attachment becomes its own user row. `C0`
   then merges adjacent user rows: results first, plus a `\n` seam between
   adjacent text blocks. tau: `mergeUsers`, `normalizeHistoryMessages`.

## Task notifications (chunk-4h798pp0, `Rue` and the user-row case)

A queued `task-notification` turn stays raw in the transcript. On its way to
the API, the normalizer joins its texts with `\n` and wraps them once with
`A3s`. Rewake output (`tGn`) is
`<task-notification>\n<summary>…</summary>\n</task-notification>\n` followed by
`qs(body)`. `A3s` then escapes that inner close to `&lt;/system-reminder&gt;`.
Background agent completions use the same wrapper. tau commits one row per
notification in `commitNotifications` (`src/cli.ts`).

## Countdown reminder (chunk-4h798pp0, `mAs`, `PWn`, `lVn`)

- Text: `<total_tokens>${n} tokens left</total_tokens>` (`lVn`). `infinite`
  mode prints `Infinite` and `fixed` mode prints 5000000. The mode comes from
  `CLAUDE_CODE_TOTAL_TOKENS_REMINDER`, then the model gate. The budget is
  15000000 unless `CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET` sets it.
- When: the attachment producer runs it on a regular user prompt and on
  every later request of the turn (`e === null`). It skips the first request
  of a wake turn (`skipAttachments`). The order is `total_tokens_reminder`,
  then `async_hook_responses`.
- Count: `hse` reads the last assistant usage as input plus cache creation
  plus cache read plus output (`l0`). A user prompt re-anchors the ledger
  (`reanchorTaskBudget`; `DWn` defaults to true), so a turn starts at the full
  budget. Later requests send `budget - max(usage - anchor)` (`cumulativeUsed`).
- tau: `turnTokensUsed` and `roundAttachments` in `src/context-reminders.ts`.
  `runAgent` pushes them before every request after the first one of a query.
  The anchor is the last row whose `reminders` hold `total_tokens`.

## Known differences

- tau does not add compaction rollover to the ledger (`rollOverContext`).
  Subagent budgets are also not ported (`h6t`, `excludeStartContext`).
- tau does not append the plugin suffix `\nThis hook comes from the ${plugin}
plugin.` to exit 2 feedback.
- Stop hook feedback in `runAgent` is still a plain user text row, not a
  `hook_blocking_error` attachment.
- Background agent notifications lack the original's `<note>` field. That
  belongs to the background agent lane.
