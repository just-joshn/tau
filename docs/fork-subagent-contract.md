# Fork subagent contract

Scope: the built-in `subagent_type: "fork"` path and the two main-session prompt sections that mention it, `# Using your tools` and `# Session-specific guidance`. Source is the pinned 2.1.326 bundle. Needles live in `docs/fork-subagent-needles.json`. Each needle occurs once in `chunk-4h798pp0.js` or `chunk-856xesd8.js`.

Ordinary built-in agents stay in `createBuiltinAgentCatalog()`. Fork is a separate definition, `FORK_AGENT_DEFINITION`, selected only when the caller asks for it and the gate is on.

## Data shape

| Model                 | tau                                          | Source       |
| --------------------- | -------------------------------------------- | ------------ |
| Gate                  | `ForkSubagentGate` in `src/fork-subagent.ts` | `LWn`        |
| Enabled               | `isForkSubagentEnabled`                      | `bTe`        |
| Background default    | `isForkBackgroundDefault`                    | `DWt`        |
| Directive             | `buildForkDirective`                         | `GSt`        |
| Transcript            | `buildForkMessages`                          | `SNs`        |
| Already inside a fork | `hasForkDirective`                           | `YEe`, `_Ns` |
| Definition            | `FORK_AGENT_DEFINITION`                      | `Tq`         |
| Prompt mode           | `AgentGuidanceMode`                          | `Zls`, `eds` |
| Launch guard          | `SubagentRuntime.select`                     | `qr`         |

`ForkSubagentGate` is `"disabled"`, `"default"`, or `"env"`.

## Gate

`resolveForkSubagentGate(env, options)` returns `"disabled"` when any of these hold:

1. `CLAUDE_CODE_FORK_SUBAGENT` is falsy (`0`, `false`, `no`, `off`).
2. `options.forkSubagentDisabled` is true.
3. `options.coordinator` is true.

It returns `"env"` when the same variable is truthy (`1`, `true`, `yes`, `on`). Otherwise it returns `"default"`. Disabled wins over a truthy value.

The gate is enabled unless it is `"disabled"`. Background is the default when the gate is `"env"`, or when it is `"default"` and the session is interactive. Print mode with an unset variable is foreground wording (`"fork"`, not `"fork-background"`).

tau does not read the `tengu_federated_ullman` kill switch. An absent flag stays enabled.

## Prompt sections

`hasEmbeddedSearch` defaults to on unless `CLAUDE_CODE_ENTRYPOINT` is `local-agent` or `CLAUDE_CODE_EMBEDDED_SEARCH` is falsy. When that default is on and Bash is available, `# Using your tools` names `(Read, Edit, Write)`. Otherwise it names `(Read, Edit, Write, Glob, Grep)`.

`# Session-specific guidance` uses one agent line when the Agent tool exists and the caller is not itself a subagent:

| Mode              | When                                      | Line                                                                                                 |
| ----------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `fork`            | Enabled, background default off           | Inherits context and keeps tool output out of the parent                                             |
| `fork-background` | Background default on                     | Same, plus runs in the background                                                                    |
| `with-nudge`      | Gate disabled                             | Specialized-agent steer, plus the `subagent_type=Explore` bullet unless explore agents are disabled  |
| `plain`           | Retained source string                    | Shorter steer. tau does not select it. The 2.1.326 nudge flag is `"default"`, which is `with-nudge`. |
| `none`            | No Agent tool, or `isFork` / `isSubagent` | No agent line                                                                                        |

The print-mode oracle hashes are pinned in `test/unit/system-prompt.test.ts`.

## Launch

When the requested type canonicalizes to `fork` and the gate is enabled:

1. `isolation: "remote"` fails with the remote message. Worktree isolation still fails in this host. The ordinary runtime has no worktree launcher.
2. A parent with `isFork`, or a transcript that already contains `<fork-boilerplate>`, fails with the recursive message.
3. The plan uses `FORK_AGENT_DEFINITION`. The call's `model` is ignored. The child model is `parent.parentModel`. The permission mode is `parent.parentMode`. `effort`, including `lower` and `higher`, is dropped. `lower` and `higher` are not in tau's effort enum, so a fork call strips them before schema parse.
4. `buildForkMessages` clones the parent messages. It appends a user message. That message holds a synthetic tool result for each tool call on the trailing assistant message, then the directive. The fork's own Agent or Task call says `Fork started`. Any other call in that same assistant message says it belongs to the parent. A single non-Agent call uses the other-call sentence.
5. Only the final foreground report returns to the parent. Child tool output stays on the child transcript.

A disabled gate does not inherit. A catalog agent whose type is `fork` still fails with the pre-existing inherited-context error.

`src/cli.ts` passes `() => session.messages` into `agentHost.wrap`. For a fork, materialize uses `options.system()` and `contextMessages: []`. The cloned parent transcript is the child history.

## Stub

`src/background-agent-runtime.ts` still rejects `agentType === "fork"`. The foreground runtime rejects a fork whose launch mode is background, with the same scheduler error, before `launch`. Interactive sessions and `CLAUDE_CODE_FORK_SUBAGENT=true` advertise background forks in the prompt. This host cannot run that background path. Print mode with the variable unset launches the fork in the foreground.

`permissionMode: "bubble"` on `Tq` is the parent mode. The definition omits `permissionMode` because that word is not in tau's mode union.

## Verification

`test/unit/fork-subagent.test.ts` covers the gate, the directive, and the synthetic tool results. `test/unit/subagent-runtime.test.ts` covers inheritance, the ignored model and effort, remote isolation, and recursive rejection. `test/integration/cli-fork-agent.test.ts` runs `src/cli.ts` and checks the two section hashes, the inherited parent prompt, and the absence of the child Read output on the parent's next request.
