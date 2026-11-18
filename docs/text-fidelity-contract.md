# Text encoding and Edit matching

Seven complete source spans and their containing module hashes were verified against the pinned executable. Evidence: source `ev_b0a14a433482875f7c69e40e8582200250bfbac2316b16407c433e221c5b5e74`, verification `ev_d37ada60b4bf8fefaf0ecfe77cec8b7e7d15a3382d8256f6e2a1c804a1d1575d`. Reproduce with `python3 -I artifacts/text-fidelity-pass/verify-spans.py`. Extracted code remains ignored and is never imported or executed.

| Source boundary | Executable byte offset | Bytes |
| --- | ---: | ---: |
| Encoding detection and BOM | 282607883 | 746 |
| Text decoding and newlines | 282608727 | 1048 |
| Quote/escape matching and style | 292521406 | 2703 |
| Creation, uniqueness and replacement | 292524109 | 1861 |
| Edit execution and encoded write | 298375276 | 4766 |
| Write execution and encoded write | 294659588 | 975 |
| Newline restoration/write verification | 283336304 | 1207 |

## Source-derived behavior

- UTF-16LE is selected by `FF FE`; otherwise the reader uses UTF-8. UTF-16BE, NUL-containing UTF-8 and invalid UTF-8 have nontext classifications.
- Reading normalizes all CRLF pairs to LF. Predominant style in the first 4,096 characters determines Edit's output style. CRLF restoration normalizes existing pairs first, avoiding doubled carriage returns.
- Nonempty replacement content retains the existing BOM unless it supplies one itself. Empty Write content removes the BOM with the rest of the bytes. Write retains encoding and uses supplied line endings; Edit restores the detected style.
- Edit prefers literal matches, then curly-quote-folded matches. Uniqueness and replacement use the actual matched spelling. Literal matches win even if a folded match appears earlier.
- A folded match with curly quotes carries that quote family into replacement ASCII quotes. Opening context includes start, whitespace, opening brackets and en/em dashes; apostrophes between Unicode letters become closing quotes.
- Next, Edit tries decoding eligible `\uXXXX` escapes in `old_string`, then finding escaped Unicode code units. Paired backslashes are not decoded. Escaped matching checks preceding-backslash parity and refuses a spelling with an earlier ineligible occurrence. Shared characters retain matched hex spellings; new Unicode uses the matched upper/lower preference. Astral characters use surrogate-pair escapes.
- Empty `old_string` creates missing files or replaces whitespace-only content. Nonempty existing content and identical requested strings fail.

## Independent implementation

`src/text-file.ts` provides fatal UTF-8/BOM-marked UTF-16LE decoding and encoding/BOM-preserving output. Read, stale checks, Write and Edit share it. Malformed UTF-16 and output containing lone surrogates fail before mutation. Read now uses262144 whole-file bytes, configurable token budgets and streaming explicit ranges; its old64KiB input/output prefix cap is superseded. Incremental decoding handles split code points and encoding markers. See [Read](read-contract.md).

`src/edit.ts` implements matching order, style transfer, creation and newlines. Escape searches generate literal regex characters and fixed-width hex classes, bounded by the bounded file, rather than evaluating an input regex. `src/write.ts` accepts encoded buffers and retains atomic rename, mode preservation and precommit checks.

Existing whitespace-only files still require a complete Read in tau. Missing-file Edit creates parents after approval with the existing containment/symlink/recheck gates. See [read state](read-state-contract.md).

Two earlier independent implementation mismatches were corrected: CRLF pairs normalize even in LF-majority files, and CRLF already in replacement text is not doubled during restoration. Raw CRLF in `old_string` does not match the normalized LF view.

## Limits

Write/Edit retain their64KiB existing-file bound; Read has the expanded limits above. Tau retains workspace roots, strict decoding, limited media handling, process-local baselines and simpler results. No remote writes, transcript repair, stale-edit recovery, notebook editing, post-write size/readback verification, in-place fallback, staged review, checkpoints or LSP notifications. Grep still searches UTF-8 prefixes and skips UTF-16LE files containing zero bytes. Original malformed UTF-16 runtime behavior remains untested; tau explicitly rejects it.

## Validation

All **150 tests** and typecheck pass: `ev_72f6f3ce8cbc316d834959cc4f9674c6d29b643be4212e76b3c93225a807de47`, `ev_a10348a44cfacc071cee609b482f92519f451aadb8bc067c75eeb5540828ad0c`. Tests cover real files, quote/escape priority, backslash boundaries, creation, stale content, invalid input, truncated surrogates and permissions. A loopback provider drives the compiled CLI through Read → Edit → Write → create → escaped edit and verifies intermediate/final bytes, mode and events. PTY validation of state across turns and resets also passes: `ev_4394748dffc657c15e68e17b304ea950592a41a2e3b151522b57436757518e57`.

Before implementation, a direct call to the old pure Edit helper with empty `old_string` stalled its counting loop. The old CLI schema rejected that input, so this was not an old CLI vulnerability. Creation is now handled before counting. The same-event-loop timeout could not interrupt the baseline; that local process was terminated. Separate escape regressions were observed failing before implementation. Logs and probes remain under ignored `artifacts/text-fidelity-pass/`.

No original executable/module execution, personal-account access or live model call was performed.
