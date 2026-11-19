# Headless SDK I/O

Print mode with `--output-format json` or `stream-json` speaks the original's SDK message protocol. Tau builds every message in one reducer, `SdkSession`/`SdkQuery` in `src/sdk-messages.ts`, from agent events plus session facts. `src/cli.ts` only writes what the reducer returns. Sources are recovered modules of the pinned Claude Code 2.1.326 under `artifacts/claude-bundle/`. No original code was executed for this port; behavior was checked against oracle captures in `artifacts/workflow-oracles-2026-11-18/`.

## Message shapes and their sources

| Message                      | Tau                                                                                                   | Original source                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `system/init`                | `SdkSession.init`, once per prompt, after the tool pool is built                                      | `u$t`, `chunk-xfksw6er.js`; `Agent` is reported as `Task` (`IFn`)                      |
| `system/status` `requesting` | each model request, only with `--include-partial-messages`                                            | engine `stream_request_start`, `chunk-q67vgc7s.js`; schema note in `chunk-bprgtdg6.js` |
| `assistant`                  | one message per content block, at that block's `content_block_stop`, before the stop's `stream_event` | `fV`, `chunk-cr640x0r.js`                                                              |
| `user`                       | one message per tool result, with `tool_use_result`                                                   | `fV` `case "user"`, `chunk-cr640x0r.js`                                                |
| `stream_event`               | the raw SSE event, with `api_message_id` and `ttft_ms` on `message_start`                             | schema `n6`, `chunk-bprgtdg6.js`                                                       |
| `system/compact_boundary`    | completed compaction, `trigger` `manual` or `auto`                                                    | schema `r6`, `chunk-bprgtdg6.js`; engine yield, `chunk-q67vgc7s.js`                    |
| `result`                     | one per query: the prompt's query, then one per drained background notification                       | `Zne` and the variant chain after `[engine] turn end`, `chunk-q67vgc7s.js`             |

An assistant message carries the response's `message_start` envelope: `id`, `model`, the start usage, `stop_reason: null`, and `context_management: null`. A closed `tool_use` block is normalized before it is emitted, so Edit input gains `replace_all: false` as in the original. A JSON (non-streaming) response has no stream events, so its blocks are emitted from the committed message instead.

## Result subtypes

The reducer picks the variant in the original's order:

1. `error_max_turns` when the agent throws `AgentMaxTurnsError`. `num_turns` is the refused next turn (`maxTurns + 1`), `errors` is `["Reached maximum number of turns (N)"]`, and `terminal_reason` is `max_turns` (`max_turns_reached` attachment, `chunk-27vawgnx.js`).
2. `success` with `is_error: true` when the model request failed for good. The agent reports an `api_error` event with the HTTP status, or `null` for transport failures. `result` is the failure text and `api_error_status` is the status. The original turns API failures into an error reply the same way (`H` latch in `chunk-q67vgc7s.js`).
3. `error_during_execution` for every other failure, `errors: [message]`; an interrupt reports `["Interrupted"]`.
4. `success` otherwise, with `result` set to the last text block, `terminal_reason: completed`, `api_error_status: null`, and `ttft_ms`.

Error variants have no `result` field. `stop_reason` is the last response's stop reason, or `null` before any response.

## Usage, cost, and denials

- `usage` sums the query's responses. `modelUsage` and `total_cost_usd` add up across the whole process, and `result_index` counts results (`IO.stamp`, `chunk-xt4nsgp1.js`).
- `model_usage_since_last_result` appears only for `stream-json` output, because the original tracks it only there (`jRi`, `chunk-xt4nsgp1.js`).
- Cost follows `vYt` (`chunk-d73xe1mr.js`) with the baked pricing tiers (`chunk-9vmv3a50.js`). Unknown models use the default tier, `tier_5_25`.
- `permission_denials` lists each tool call whose result tau marked `permissionDenied`, once per `tool_use_id`, as `{tool_name, tool_use_id, tool_input}` (the `canUseTool` wrapper, `chunk-q67vgc7s.js`).

## Flags

| Flag                         | Behavior                                                                                                                                                                                               | Source                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `--verbose`                  | Required for print `stream-json`; otherwise stderr gets `Error: When using --print, --output-format=stream-json requires --verbose` and the exit is 1. With `json`, prints every message as one array. | `chunk-xt4nsgp1.js` (runHeadless)                                  |
| `--include-partial-messages` | Adds `stream_event` and `system/status`. Requires print and `stream-json`.                                                                                                                             | `chunk-97e8zgw1.js`                                                |
| `--input-format stream-json` | Reads newline-delimited user messages from stdin. Each message runs one turn in the same session and emits its own `system/init`. Requires `stream-json` output and print.                             | `chunk-97e8zgw1.js`; reader `h$e.processLine`, `chunk-9enk3ymf.js` |
| `--session-id UUID`          | Names the new session. Rejects a non-UUID, use with `--resume` or `--continue`, and an ID with a saved session.                                                                                        | `tl` and `Et` (`chunk-97e8zgw1.js`, `chunk-kcn485vd.js`)           |

The stdin reader reuses `NativeStructuredInput` (`src/native-structured-input.ts`) with `parseSdkInputLine` (`src/sdk-input.ts`). The reader skips blank lines, `keep_alive`, and every non-user type. A line that does not parse is fatal with `Error parsing streaming input line (type=T, N chars): ErrorName`. A user message whose role is not `user` is fatal with `Error: Expected message role 'user', got 'R'`.

## Known differences

Tau reports its own value where the original's field depends on a subsystem tau lacks:

- `claude_code_version` is tau's version, `0.1.0`.
- `slash_commands` and `skills` both list tau's user-invocable skills; tau has no built-in slash commands.
- `plugins` paths are local plugin roots; tau ships no built-in plugins.
- `system/init` omits `capabilities`, `terminal_slash_commands`, `memory_paths`, `original_cwd`, `additional_directories`, `fast_mode_*`, `ultrathink_*`, `per_turn_effort_active`, `view_mode`, `analytics_disabled`, and `product_feedback_disabled`.
- `result` omits `fast_mode_*`, `subagent_stats`, `safety_stops`, `queued_turn_count`, `ttft_stream_ms`, `time_to_request_ms`, and `first_content_frame_ms`.
- `duration_api_ms` is measured from each request's start to its committed response.
- `usage.service_tier`, `speed`, `inference_geo`, and the cache-creation split are defaults, not values read from the API.
- Cost ignores the long-prompt tier, the US geo multiplier, 1-hour cache writes, and web search requests.
- `user.tool_use_result` is the tool's text, prefixed `Error: ` on failure. The original returns structured tool output, such as Read's `{type, file}`. User messages carry no `tool_result_meta`.
- Tool result text comes from tau's tools and differs from the original's text; for example, Write reports `File written`.
- The original wraps the API failure text as `API Error: …`. Tau's `result` is tau's own failure message, and `num_turns` counts only completed responses.
- The stdin reader drops `control_request`, `control_response`, and the other control frames, so the SDK control protocol (interrupt, permission prompts, `can_use_tool`) is not available. Image and document content blocks in user input are fatal.
- `--fork-session` and `--replay-user-messages` do not exist in tau.

## Verification

- `bun test ./test/integration/cli-sdk-io.test.ts` runs tau's real entrypoint against `test/helpers/differential-mock.ts`. That mock sends the same SSE bytes as `scripts/differential/mock_api.py`. The test compares the normalized projection with the committed original projections in `test/fixtures/sdk-io/`. The six oracle captures match: text, files, and failures in stream-json, files in json, partial messages, and two stdin turns. The test also covers flag errors, `--session-id`, `json --verbose`, max turns, and print denials.
- `scripts/differential/compare_sdk_io.py ORIGINAL TAU` diffs the type sequence and the fields in `scripts/differential/sdk_io_fields.json`. The script lists keys the original sends that tau omits.
- `scripts/differential/run_sdk_io.py {original,tau} CASE` runs one case from `scripts/differential/scenarios_sdk_io.py` in a verified isolation context.
