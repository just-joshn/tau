# Built-in skill, agent and plugin catalog

Claude Code 2.1.326, measured against `artifacts/workflow-oracles-2026-11-18` (print mode, dummy API key, `scripts/differential/isolation.py` environment). Recovered chunks live under `artifacts/claude-bundle/`. Needles in `docs/builtin-catalog-needles.json` each occur once, in the named chunk only.

## Data shape

`BuiltinSkillSpec` (`src/builtin-skills/types.ts`) is one row of the original registry: name, origin (`bundled`, `workflow`, `plugin`, `command`), description, whenToUse, menu text, argument hint, aliases, allowed and disallowed tools, model, `context: "fork"`, user-invocable and model-invocable flags, an `enabled` gate, optional files, a prompt renderer, and an `unported` list.

`BUILTIN_SKILLS` (`src/builtin-skills/index.ts`) is the original merge order (`yss` in `chunk-4h798pp0.js`): the deep-research workflow, then `Lqe()` registration order in `chunk-qb6rgffc.js`, then the built-in plugin skill, then the built-in prompt commands `init` and `security-review`. `builtinSkillDefinitions` registers these after local and plugin skills. A row with files is written under `realpath(CLAUDE_CODE_TMPDIR or /tmp)/claude-<uid>/bundled-skills/<version>/<random>/<name>` and the prompt is prefixed `Base directory for this skill: <dir>`, matching `kol()`/`wd()` in `chunk-2ptscye8.js`. A failed write is retried next time. `render` on the admitted definition skips argument and variable substitution; the spec does its own.

`source: "bundled"` rows are skills. `source: "builtinCommand"` rows are prompt commands: they appear in `slash_commands` and not in init `skills`. Bundled rows keep their full listing line when the skill budget is tight.

Built-in agent prompts live in `src/builtin-agent-prompts.ts` and are the `getSystemPrompt` text for general-purpose, statusline-setup, claude, Explore and Plan. Explore and Plan use the shell-search variant when the host's guide tools are Bash. `web-fetch` and `claude-code-guide` stay independently authored; the oracle's ordinary catalog does not list them.

## Gates in the oracle configuration

The oracle sets no skill-disabling variable, is non-interactive, and is not `local-agent`. Every oracle skill is enabled there.

- `claude-api` is off when `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL` is `1`, `true`, `yes` or `on`.
- `doctor` is off when `DISABLE_DOCTOR_COMMAND` is one of those values (`isEnabled: () => !DISABLE_DOCTOR_COMMAND`).
- `workflow-authoring` is off when `CLAUDE_CODE_DISABLE_WORKFLOWS` is truthy or `CLAUDE_CODE_WORKFLOWS` is false. `tengu_workflows_enabled` stays at its default, on.
- `plugin-authoring` is off when `CLAUDE_CODE_ENTRYPOINT` is `local-agent`.
- `verify` model invocation stays off (`tengu_opal_circuit` defaults off). `debug`, `batch`, `doctor`, `run-skill-generator` and `deep-research` are user-invoked only, so they are in init `skills` and absent from the model listing. `keybindings-help` is the reverse: model-listed, not user-invocable.

## What matches the oracle

Init `skills` is the 16 names in the oracle's order. Init `agents` is `claude`, `Explore`, `general-purpose`, `Plan`, `statusline-setup`. Init `plugins` is `cc-plugin-agents-md`, `cc-plugin-privacy`, `cc-plugin-plugin-authoring`, each `{path: "builtin", source: "<name>@builtin"}`. `slash_commands` is those skills plus `init` and `security-review`, the commands tau implements, in the oracle's order. The first request's agent and skill system-reminders equal the oracle text. The Skill tool uses the original description, input schema and `Launching skill: <name>` result. `/help` puts bundled skills and built-in commands under Commands (menu text) and other skills under Custom commands. `/skills` lists only local and plugin skills.

## Bodies

Exact, regenerated from the binary by `scripts/builtin-skills/generate-assets.ts` (it reads the Mach-O, it does not run it): dataviz, verify, run, run-skill-generator, workflow-authoring, claude-api, and the plugin-authoring skill with its files. Agent prompts are the original text.

`claude-api` (`ne` in `chunk-pcxjjtda.js`) substitutes `{{MODEL}}` ids, detects the project language from directory entries in the original order, and inlines that language's README. Tau has no `ant` checker, so the prompt always takes the "security comparison unavailable" branch. The retiring-models scan stays off, its shipped default. The managed-agents-onboard quickstart and URL section is not rendered.

Registered with the original listing text, body still empty: update-config, keybindings-help, debug, code-review, simplify, batch, fewer-permission-prompts, doctor, loop, deep-research, init, security-review. Their prompts are computed (settings schema, keybinding tables, transcripts, effort parsing, cron, a workflow runtime) and are named in each spec's `unported`.

`cc-plugin-agents-md` loads AGENTS.md beside CLAUDE.md. `cc-plugin-privacy` refuses calls that would send the account email and blocks a user-tier read of session identity. Both are init rows only; their hooks are not ported.

## Differences outside this lane

The system prompt still names Glob and Grep, omits the auto-memory section, and lists fewer deferred tools. Tau does not implement the rest of the oracle's slash commands. Scenario goldens gained the Skill tool and one skill-listing text block; they were transformed, not re-recorded, because a sandbox replay also sees ancestor skills.
