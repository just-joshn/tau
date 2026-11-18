# Auto memory contract

Scope: the main session's file-backed auto memory in tau's default CLI. That covers the folder, its gate, the `# auto memory` prompt section, MEMORY.md in the instruction context, the file allowance and init `memory_paths`. Source is the pinned 2.1.326 bundle, read as data. Line numbers refer to `artifacts/claude-restored-2026-11-18/pretty/chunk-4h798pp0.js`. Other chunks are named. Needles live in `docs/auto-memory-needles.json`. Each occurs once in one bundle chunk.

Subagent memory (`memory:` in agent definitions) is a separate feature in `src/agent-memory*.ts`.

## Data shape

| Model               | tau                                                          | Source                                |
| ------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Gate                | `agentMemoryEnabled` over the session facts                  | `Gg`/`vme`/`Jb`/`Qb` (chunk-d73xe1mr) |
| One session's store | `AutoMemoryStore` (`src/auto-memory.ts`)                     | `Yf.resolveEntry`, `pd`, `OW`         |
| Store inputs        | `AutoMemoryFacts`, built in `src/agent-memory-launch.ts`     | `ld`, `nS`, `Ipt`, `kd`, `Ai`         |
| Prompt section      | `autoMemoryPrompt` + `src/auto-memory-text.ts`               | `bQn` → `$o` (chunk-2e8vamz8)         |
| Index in context    | `InstructionKind` `AutoMem`, `autoMemoryIndex` catalog input | `dct`/`ict` 61681, loader 62353       |
| Index bounds        | `truncateAutoMemoryIndex`, `sanitizeAutoMemoryIndex`         | `p5r` (chunk-2e8vamz8), `Qbe`         |
| File allowance      | `autoMemoryWriteAllowed` / `autoMemoryReadAllowed`           | `vct`/`Tme`/`Kza`, read branch        |
| Init field          | `SdkInitFacts.memoryPaths` → `memory_paths`                  | `LFn`/`u$t` (chunk-xfksw6er)          |

`AutoMemoryStore` holds `enabled` (Gg), `directory` (absolute, NFC, trailing `/`), `indexPath`, `ownProjectDirectory`, `pathOverridden` and `remoteSurface`. The folder resolves even while the gate is off, because the write allowance ignores the gate.

## Gate

Auto memory is on unless one of these holds, in order:

1. Safe mode (`CLAUDE_CODE_SAFE_MODE`), a restricted or confined profile, or a session toggle.
2. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is truthy (`1/true/yes/on`). A falsy value (`0/false/no/off`) forces it on and skips steps 3 and 4.
3. `CLAUDE_CODE_SIMPLE`, or `CLAUDE_CODE_REMOTE` without `CLAUDE_CODE_REMOTE_MEMORY_DIR` or `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`.
4. The `autoMemoryEnabled` setting is `false`. Absent means on.

The memory-store model gate (`tengu_sepia_cormorant`/`tengu_umber_petrel`) has no reader in tau, so it stays at its absent default.

## Folder

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, normalized, without `~` expansion.
2. The first non-null `autoMemoryDirectory` among policy, flag, local and project (only when the workspace is trusted and `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` is not truthy), then user settings. `~/` expands to home. `~/` alone and `~/..` are refused. A refused or invalid value falls through to step 3, not to the next source.
3. `<base>/projects/<key>/memory/`. `<base>` is `CLAUDE_CODE_REMOTE_MEMORY_DIR` or the config home. `<key>` encodes the canonical git root, else the cwd, with every non-alphanumeric as `-` (`nH`). Under the config home, `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the key when `CLAUDE_CONFIG_DIR` is set.

A valid root is absolute, at least three characters, not a drive letter alone and free of NUL. In a linked worktree, `ownProjectDirectory` is the cwd-keyed folder under the config home. It is writable only while the gate is on.

The CLI creates the folder at launch while the gate is on, because the prompt says it exists. A failure is silent, as in `He`.

## Prompt section

The section sits between session guidance and environment. Its text is generated from the pinned request (`src/auto-memory-text.ts`):

```
# auto memory

You have a persistent, file-based memory system at `<folder>`. This directory already exists — ...
<types, what not to save, how to save, when to access, before recommending, persistence>
```

`test/unit/system-prompt.test.ts` pins its SHA-256 against the oracle's folder. `CLAUDE_COWORK_MEMORY_GUIDELINES` replaces the body with `# auto memory\n<value>`. `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` appends its value after the persistence section.

## MEMORY.md

While the gate is on, the instruction catalog loads `<folder>MEMORY.md` after every CLAUDE.md, rule and local file, with kind `AutoMem`. Imports do not apply, and neither do `claudeMdExcludes` nor Read deny rules. Frontmatter and block HTML comments are stripped. Then `p5r` keeps 200 lines, then 25,000 UTF-16 units back to a line break. A cut appends this warning:

```
> WARNING: MEMORY.md is <205 lines (limit: 200) | 24.5KB (limit: 24.4KB) — index entries are too long | N lines and SIZE>. Only part of it was loaded: <k of N lines were cut off, starting at line L ("first cut line…") | everything after the first C characters of line 1 was cut off>. Keep index entries to one line under ~200 chars; move detail into topic files.
```

Control and invisible characters are dropped, and reminder-tag openers become `<\`. `CLAUDE_COWORK_MEMORY_INDEX_CONTENT` replaces the file read. Empty, it loads no index. An empty index adds nothing. Subagents get the same entry through their own catalog.

## File allowance

In `vct`, after the protected-config floors and before the broad `.claude` directory hold:

- Write and Edit run without a prompt for a `.md` path inside the folder (or the own-project folder while on). There must be no cowork override, and no segment under the root may be `.git`, `hooks`, `.claude`, `node_modules` or another `CEe` name.
- Read runs without a prompt for any path inside the folder unless `CLAUDE_CODE_REMOTE` is set.

tau composes this into `createLaunchAgentMemoryHost().fileAccess`, so path admission and `memoryFileAllowance` share the agent-memory floors. Those floors are deny and ask rules, the tools list, plan mode, settings files and leaf symlinks or hard links. The landing path must stay inside the folder or its realpath. A non-Markdown write still asks, and print mode denies it.

## Init

While the gate is on, the stream-json init message carries `memory_paths: {"auto": "<folder>"}` after `uuid`.

## Verification

- `bun test ./test/unit/auto-memory.test.ts ./test/unit/system-prompt.test.ts` covers resolution, gates, the prompt hash, truncation, sanitizing and catalog order.
- `bun test ./test/integration/cli-auto-memory.test.ts` drives the real CLI. A print run writes a topic file and MEMORY.md with no approval, and the next run's request carries the index. A `.txt` write is denied, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` removes the section, the index and `memory_paths`.
- `compare_prompt.py` against `original-text-streamjson.json` reports `# auto memory` equal.
- Differential, from the repo root with isolation available:

```sh
python3 scripts/differential/run_memory_auto.py original
python3 scripts/differential/run_memory_auto.py tau
python3 scripts/differential/compare_prompt.py artifacts/differential-pass/memory-auto/original-memory-auto.json artifacts/differential-pass/memory-auto/tau-memory-auto.json
```

Each summary's `checks` must be all true. The index block's wrapper differs by design (see below).

## Not modeled

- Rendering: tau shows the index as `Instruction file (AutoMem): <path>` inside its own instruction notice. The original shows `Contents of <path> (user's auto-memory, persists across conversations):` in the `claudeMd` reminder. That is the same divergence as every CLAUDE.md file.
- Team memory, `CLAUDE_MEMORY_STORES`, memory tools, sync notes and `skipIndex`.
- The lean prompt (`ZSe`), the split prompt for `excludeDynamicSections` (`_Ma`), and the REPL wording.
- The full `Xh` tag neutralizer. tau defuses only the literal tag names in `Phe`.
- The Read tool's memory-index size note (`exn`), `memory_update` attachments, extraction and `/memory`.
- Plan mode: tau keeps plan mode read-only, the folder included. Whether the original's `vct` allowance applies there is inferred, not observed.
- The working-copy key (`canonicalWcRoot`) and the retry read after a failed sync (`Fvn`).
- `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` is not tied to non-interactive runs, as `pre()` ties it.

## Write stamp

New `.md` Writes into the memory folder run `stampNewMemoryContent` (`src/memory-stamp.ts`): `node_type: memory`, `originSessionId`, and `modified` are added when frontmatter is present and `originSessionId` is absent. Index files without frontmatter are unchanged.
