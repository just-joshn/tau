# Read state and stale-file protection

Eight complete bundled spans were byte-verified against the pinned Claude 2.1.326 executable. Source evidence: `ev_1a6cd77018cd3c073ef1a82814a0d16eb5efa92405aaad692364c14913280f91`. Reproduce with `python3 -I artifacts/staleness-pass/verify-spans.py`. No original code was executed.

## Original contract, derived from source

- A complete view starts at offset 0 or 1, is not marked partial, and either has no explicit limit or has nonempty content with fewer lines than that limit. A separate flag tracks content missing from model context.
- The bounded cache retains content hashes, lengths and optional read baselines. Large content can be dropped while its hash remains. Read updates record a floored millisecond mtime.
- Write and Edit recheck read state at execution time, with distinct conditions. A model-list predicate and automatic-read permission/tool context can relax prior-Read requirements. Newer mtimes can trigger content comparison; unchanged content can pass. Edit can recover an applicable, unambiguous stale match in permitted contexts.
- Remote baselines, transcript repair and context-refresh flags add cases that tau does not implement. A model's presence in a guard list is not evidence of its capabilities.

## Tau contract

`src/read-state.ts` stores SHA-256 digests of decoded text with its leading BOM removed and CRLF normalized. At most 512 canonical paths are remembered; successful use refreshes recency. The CLI shares state across turns and permission changes, and resets it on `/clear` or `/resume`. State is not persisted or reconstructed from transcripts.

Every existing-file Write/Edit requires a complete model-visible Read or complete post-compaction restoration. Read now has separate byte/token budgets and its numbered output can exceed64KiB; see [Read](read-contract.md). Successful partial/token-paged Reads replace a complete baseline with partial state, and paginated Reads are not combined. Failed Reads create no baseline and retain any preceding entry; content is still compared before every write. Successful tau writes refresh the baseline, permitting consecutive changes to its own output. Missing-file creation requires no baseline.

Tau compares content on every existing-file write, including when mtime is restored or moves backward. BOM, encoding and CRLF-only changes can compare equal; actual content changes cannot. Approval is separate, including in bypass mode. These guards deliberately exceed the original shortcuts and stale-edit recovery.

After approval, the tools resolve the path again and read current bytes. A callback rechecks the path, final symlink component and exact expected bytes after writing/syncing the temporary file, immediately before rename. Failed rechecks remove the temporary file. This reduces the race window; it is not filesystem compare-and-swap. Concurrent changes after the check can still race with rename.

## Native evidence and verification

Actual Ghidra 12.1.4 decompiled selected `_fstat`, `_stat`, `_lstat` callers plus an annotated stack-failure thunk, completing 4/4. No selected caller is linked to the application tools, and no `mtimeMs` field ABI is claimed recovered. See [the native report](ghidra-native.md#continuation-native-file-metadata).

The inherited slice passed 135 tests (`ev_5c69c5c884852e0c53cc159a28c0a0f7bf28ece51a9c784ae1d042ca6b39e6ed`). A real PTY with a loopback provider confirmed Read across turns, stale rejection, reread recovery, `/clear` and `/resume` resets, and clean exit (`ev_1ddead100405c1e301e57dcf2f8a492b8b9176b24e2cc12d4072264d954671a3`). The later encoding continuation retains these guarantees.
