# Grep: static contract and independent subset

## Evidence boundary

This investigation combines **actual Ghidra 12.1.4 native analysis** with direct inspection of bundled JavaScript in the installed arm64 executable, version 2.1.326, SHA-256 `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. No original executable or recovered module was run. Static control flow and source intent do not establish runtime parity.

### Native dispatch — derived

The native entry at `0x1068e3808` compares the executable basename against the following strings and reaches separate shims:

| Name | Native shim | Next selected native call |
| --- | --- | --- |
| `rg` | `0x1068d31b0` | `0x1055f1040` |
| `ug`, `ugrep` | `0x1068d31a0` | `0x105447ef0` |
| `bfs` | `0x1068d3170` | `0x1054cd42c` |

The entry also reads and clears the literal environment key `ARGV0`. Its interaction with the basename is visible in selected control flow; this is not a general precedence specification for arbitrary launch environments.

The first helper pass completed 5/5 entries. A follow-up including the next selected native functions and shared terminal shim completed **9/9**. Canonical local report: ignored `artifacts/grep-pass/dispatch.txt`. Reproducible address facts: `scripts/ghidra/claude-2.1.326-search-ranges.tsv`; use this instead of the loader manifest in [the Ghidra reproduction procedure](ghidra-native.md), and require `COMPLETE requested=9 succeeded=9 failed=0`.

Evidence:

- Entry comparisons/calls: `ev_6132adc413819ba717377815473ada1dc524fc1cb0ef85c7554704af1c87f01e`.
- Shims/direct calls: `ev_9efe50476b6dd9c837d042952ab997dbfb333b54068c891e881f47b9f0144bcb`.
- Completion: `ev_9b4e9be730e60ec3af7d7c1eb34716d37b1e4a003cc3d47ebb06a183ef58491f`.
- `ARGV0` bytes: `ev_49f87301df305e1ddf3c2dd04091746eaf9f874133a9905fea1074da65560114`.

**Decompiler limit:** the 12-byte terminal shim at `0x1068d3314` calls imported `__exit`. Its `noreturn` manifest annotation is analyst-supplied. Missing imported prototypes still cause some pseudocode, including an error branch in the `rg` shim, to spill into adjacent code. Do not interpret speculative return types, extra parameters, or apparent post-exit flow as original behavior. Native call references establish a boundary, not complete backend semantics.

### Application adapter — observed in bundled source

The parent checked bounded spans in the original executable, not merely the worker's conclusions:

| Module/functions | Absolute file offset | Bytes | Evidence |
| --- | ---: | ---: | --- |
| `chunk-4h798pp0.js`, `NKr`/`Xct` schema and pagination | 294686429 | 2767 | `ev_216b57aaa0c5fd1431602d6b26cfab5add9d31887eb8f7f5583f258ff14f6aaf` |
| Same, `WKr` execution | 294693935 | 5346 | `ev_a3924c115a7241609638442f31eb7c996a1e707623bc69acdb2aa9d3d0e8a36d` |
| `chunk-z4j4mjgn.js`, `Kpe` backend selection | 288925406 | 390 | `ev_3bc15ebb12ed80a223af8122cb504333feb917a7fa1a440aa5923836fd949103` |
| Same, `i3` spawn boundary | 288941309 | 3149 | `ev_72da28f809664e29360f014f142d33da218634b031a811d8a2544876d10acaed` |
| Same, `lte` errors/results | 288946408 | 3207 | `ev_a5df586ddf5d444fee57d4afc8d3348ce0f2bb2b254b357b902550cb12528b5a` |
| `chunk-4h798pp0.js`, `Ows` shell wrappers | 296561934 | 451 | `ev_7160d5227094eab18d17f2efef68207c0ed294b9e033581761b811340902fd9b` |

Source-observed contract:

- `pattern` is a regex. File/directory `path` defaults to the current working directory.
- Output modes are `files_with_matches` (default), `content`, and `count`.
- `-i` defaults false; content `-n` defaults true.
- Pagination defaults to `head_limit: 250`, `offset: 0`. Offset applies first; limit zero means no pagination limit.
- Files mode sorts matches by descending modification time, then ascending pathname via `localeCompare`, before pagination.
- Count uses `-c -H`, **not `--count-matches`**. Ordinary single-line counts are matching-line counts, despite model-facing wording about occurrences.
- Content uses JSON backend output with line numbers, then formats/removes prefixes as requested. Single-file output omits the filename.
- The original additionally supports glob/type filters, context, only-matching and multiline switches. These are not all implemented in tau.
- Standalone backend selection normally invokes `process.execPath` with `argv0: "rg"` and `--no-config`; a system-rg path can be selected instead. Spawn is direct, not a Bash tool call.
- Shell wrappers mapping shell `grep` to `ugrep` and shell `find` to `bfs` are a **separate feature**, not the Grep tool's backend.
- Exit 1 becomes an empty result. Input errors and failures are distinguished, with more elaborate partial-result/retry behavior than tau implements.

Exact native ABI, bundled regex version/edge cases, environment-dependent behavior and runtime equivalence remain unverified.

## Tau's implemented subset

`src/grep.ts` and the Grep dispatch in `src/tools.ts` are independently written. No recovered implementation is imported or shipped.

Supported input:

```json
{"pattern":"^export (async )?function", "path":"src", "output_mode":"content", "-n":true, "-i":false, "head_limit":250, "offset":0}
```

- All three output modes; default files mode and source-derived pagination defaults.
- Files-mode ordering as above. Content/count candidate files use deterministic lexical traversal order, not a claimed original ordering guarantee.
- Content displays workspace-relative filenames for directory searches and omits filenames for explicit files. Count displays `path:matching-line-count`.
- Results are plain tau tool-result text, **not original structured result schemas or exact summary text**.
- `head_limit: 0` disables pagination, **not resource limits**. Both numeric pagination fields must be integers from 0 through 10,000; strings are not coerced.
- Nonempty patterns up to 4,096 string units. NUL-bearing patterns/paths are rejected.

Unknown fields are rejected, including `glob`, `type`, `multiline`, context switches, `-o`, host routing and repair aliases. PCRE-only lookaround/backreferences fail in the explicitly selected default ripgrep engine; they do not fall back to JavaScript RegExp or literal search.

### Process and filesystem boundary

- Requires a **trusted standalone `rg`** in an absolute `PATH` directory. Relative entries are skipped; symlinks are resolved to an absolute executable before spawning. Local verification used ripgrep **15.2.0**. Other tools do not require rg, and missing rg returns a tool error.
- Does not invoke the installed Claude executable or extracted code, and does not use a shell.
- Disables rg config, fixes case/engine/output flags, and passes the pattern as a single `--regexp=...` argument. User patterns cannot introduce switches or preprocessors.
- The child receives an explicit minimal environment, not inherited API keys/config variables. macOS may add `__CF_USER_TEXT_ENCODING` itself.
- Tau enumerates workspace files under its existing exclusions/containment checks and opens regular files with `O_NOFOLLOW`. Only bounded text is supplied on stdin; rg does not reopen file paths or traverse directories. The file-by-file subprocess approach is less efficient than a bulk native search; narrow `path` in large workspaces to avoid the deadline.
- Searches the first **64 KiB of original bytes**, decoded as UTF-8; it never searches the synthetic Read truncation marker. A warning identifies incomplete prefix searches. Detected NUL-containing prefixes are skipped as binary. No ignore-file parsing is implemented.
- Existing limits remain 5,000 visited entries/64 levels and approximately 64 KiB final tool text plus its truncation marker. Grep additionally retains at most 20,000 rows/about 1 MiB before pagination and bounds each backend's combined stdout/stderr to 512 KiB.
- The search deadline is 20 seconds; child timeouts/abort/overflow kill the child and return errors, not fabricated empty results. Successful output is drained through `close`. Filesystem operations themselves are asynchronous OS calls, not hard-time-bounded or OS-sandboxed.

This bounded prefix search can differ from full-file rg, including at a truncated end-of-line or split UTF-8 sequence. A missing match does not prove absence from unread bytes. Timeout/error partial-result recovery and the original content renderer's long-line/context behavior are not reproduced.

### Deferred glob support

A tentative single-glob addition was removed before completion: reusing the existing JavaScript backtracking glob matcher could block the event loop and defeat cancellation. Grep now rejects even that field, with a regression for a repeated-star adversarial pattern. That pre-existing **Glob tool** matcher was subsequently replaced by a bounded state machine; see [the Glob contract and regression](glob-contract.md). Grep's glob option remains unsupported: no full native glob compatibility is implied.

## Local acceptance coverage

`test/grep.test.ts` exercises real rg against temporary fixtures: regex versus literal matching, all modes, matching-line counts, case/line-number control, modification-time ordering, pagination/default/zero limit, unsupported fields/regex syntax, missing paths, NUL rejection, prefix/binary/symlink behavior and output caps. Controlled independent backend fixtures test draining, exit codes, minimal environment, timeout, cancellation and excessive output. An isolated process verifies relative PATH entries cannot execute a project-planted `rg`.

These tests establish tau's bounded contract only. They do not execute the original CLI, compare its runtime output, or contact Anthropic.

Verification artifacts:

- Typecheck: `ev_865df321a6fd929be8a4d4400e3be85511ea8424b39ed86c6e04978f6181ee61`.
- **76 passing tests**: `ev_4aa1b7cd9881c30de69fbabb93e3ca77a83efd9c7a345bee883b16afb8b96570`.
- Interactive PTY help/modes/approval/write/cancellation/status/clean exit: `ev_fbb7a8437b01c3733efd446bfada32af5b3cf027bc5317395e9bf37edf96d6cb`.
- Static real-target metadata: `ev_ef11e44e37d347d785db25084e4543ed1eecb97e933851317fb6180d189eb0c5`.

