# Glob: original boundary and independent bounded matcher

## Original shipped contract: static observations

Target: Claude CLI 2.1.326, arm64 Mach-O, SHA-256 `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`. Neither the executable nor recovered modules were run.

The JavaScript wrapper delegates matching to **rg**, not a JavaScript RegExp implementation:

- Input: required `pattern`, optional directory `path`, plus conditionally exposed host routing. It rejects NUL-bearing patterns/paths and validates applicable explicit directory roots.
- `EKr` constructs `--files --null --glob PATTERN --sort=modified`. Its no-ignore and hidden environment switches default to true, adding `--no-ignore` and `--hidden`.
- Permission-derived exclusions and installation-subtree exclusions are separate from ignore-file behavior. The original uses permission-checked search roots; **tau's blanket workspace confinement is an independent policy**, not recovered original behavior.
- Results are decoded from NUL-delimited backend names, permission-filtered, path-remapped, and limited. Output includes filenames, duration, truncation and optional completeness/timeout fields.
- The schema description mentions truncation at 100 files, but execution receives configurable `globLimits`. That description alone does not establish every effective runtime default.
- The inspected wrapper does not reverse backend ordering. The literal is `--sort=modified`, not `--sortr=modified`; do not infer “newest first” from a generic tool description.
- Native grammar, sorting ties/direction edge cases, ignore precedence, traversal and partial-result behavior remain incompletely verified.

Parent-verified spans in the original executable:

| Module/symbols                            | Absolute file offset | Bytes | Evidence                                                              |
| ----------------------------------------- | -------------------: | ----: | --------------------------------------------------------------------- |
| `chunk-4h798pp0.js`, path/backend helpers |            294675902 |  3126 | `ev_c1fa1152e6ec454f21b0af0be09bac1d3ed3bbf258fd6f874bfa73b810977a0c` |
| Same, `EKr` flags and spawn options       |            294677023 |   900 | `ev_9ebedac0a13b91b925f0abd06563a65acd9b89462c983c704607063b4f76382f` |
| Same, `PKr/MKr/OKr/IKr/o1`                |            294680947 |  4428 | `ev_c9e8631383aad323b4d26c61a5210fd3b817632fe647510fd4046583b134f2b2` |
| Same, `Tx` NUL validation                 |            294607502 |   198 | `ev_2c50f80bae350b1569cafb2897ccefe1725e8b0fff5db2d043d4242f63414d8b` |

The native `rg` route and its typing limits are documented in [the Ghidra investigation](ghidra-native.md). Native decompilation does not establish the full glob language here.

## Independent tau subset

`src/glob.ts` implements the existing small language without executing recovered code or requiring rg:

| Pattern element | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `*`             | Zero or more non-slash string units                               |
| `?`             | Exactly one non-slash UTF-16 string unit                          |
| `**`            | Zero or more string units, including slashes and line terminators |
| `**/`           | Nothing, or a prefix ending in a slash                            |
| Everything else | Literal characters, including braces, brackets and backslashes    |

Matching consumes the **entire** workspace-relative candidate. For example, `**/*.ts` includes root and nested files, while `*.ts` excludes nested files. No brace expansion, character classes, negation, escape grammar or native glob parity is claimed.

Unlike the old regex translation, globstar includes newline-bearing filenames, and an exact name cannot accidentally match a name with an extra final newline through RegExp's `$` behavior. These are deliberate corrections to tau's own matcher.

### Bounded algorithm

The matcher propagates active states through a finite-state representation; it does not recursively backtrack or compile user patterns to a regex. Two states handle optional directory prefixes so they cannot leave the prefix after consuming a non-slash character.

- At most **1,024 UTF-16 pattern units**.
- Work is polynomial in pattern/candidate lengths; matching memory is proportional to pattern length.
- A compiled matcher owns one query's **10,000,000-cell** budget across all candidates. Each candidate is charged `(candidate.length + 1) * (state count)` before matching. This bounds the whole query, not merely one pathname.
- Over-budget requests return an explicit tool error suggesting a narrower path/pattern. They are not successful empty listings.
- Existing 5,000-entry/64-level traversal, exclusions, recursive symlink skipping, 1,000-result and final-output bounds remain.
- Only `pattern` and optional directory `path` are accepted. NULs, unknown fields, oversize patterns and non-directory roots fail explicitly.
- Filesystem operations are not an OS sandbox or a hard real-time deadline. The work cap bounds CPU matching; it is not a universal wall-clock guarantee.

Implementation evidence: `ev_2ca018b5aca2cfa9da687743a40333d28fc98f2e6f2aa0094de6751194d605d6`; dispatch/schema: `ev_5c0f809738c454c2dd5c07135ff8f694adac449126990db4cbc20837fe7fb579`.

## Regression and verification

A temporary directory contains a filename of 40 `a` characters. An isolated built-tau child evaluates `"*a".repeat(30) + "b"`, with a 500 ms abort timer and a 1,500 ms external deadline:

- **Baseline:** old built tau blocked until external termination, `ETIMEDOUT`: `ev_fbb64e7427a5e19dfcab7516d3710e30cb3ee63cd7496dc8b2764f9059066966`.
- **Treatment:** new built tau exited normally with an empty result, about **2.06 ms** measured execution time: `ev_734e453a3afd0cf3ced29bfbdc8e0dd41e66181b6c39ffbc999705400ad4db98`.

The timing is one local observation, not a portable performance promise. The shipped regression test requires normal completion rather than a particular millisecond result.

`test/contract/glob.test.ts` adds 12 tests, including **115,940 deterministic comparisons** against a size-bounded independent regex oracle, newline/UTF-16/literal cases, exact shared-budget checks, real filesystem/symlink boundaries and the isolated child regression. The oracle never receives long adversarial patterns. A dispatch regression additionally covers NULs, unknown fields and directory validation.

Final local verification:

- Typecheck: `ev_540636f9cb80f177d267de5a25d97a3553ea2bf0298a2be133d60e7b08eb184c`.
- **89 passing tests**: `ev_c0415c9649a5a911546b6eb17a02937cb00192422a9f3ca1159b31156e93cd45`.
- Interactive PTY commands/approval/write/cancellation/clean exit: `ev_ab411b860d8af6d445121edd9f3baeb44b3d4e3d498a1c6170f7fce314c4425d`.
- Static target parsing: `ev_728a1d781717d991e69f4148c421e70cfa29ea4184811de548f0eb5f20cfb2c1`; unchanged target hash: `ev_9cccd6a5e62bf61ff5945be3e60b8d9b4cb0d5b8222c3775a62906ec11c2ccae`.
- Whitespace scan including new/untracked files: `ev_6637001e78757d4fe2726d1bd5916de1ef2a72d34964127b18d4056186544f2a`.

No original-runtime comparison or live Anthropic call was performed.

The prior matcher issue `unk_09d34a1a2d2e9cba` is resolved for this independent subset. Grep still rejects a `glob` field; this change does not silently expand that tool's contract.
