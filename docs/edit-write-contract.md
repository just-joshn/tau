# Edit and Write contract

Tau's Edit and Write are independent implementations. This document records the original behavior they target, the subset tau implements, and the gaps it leaves on purpose. Every original claim comes from static evidence in the pinned executable (`e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`). No original code or recovered module was executed, and no recovered code was copied into `src/`.

## Original behavior (source-derived)

Seventeen bounded spans of bundled JavaScript were located in the recovered modules and compared byte for byte with the executable at their absolute offsets. All 17 are equal. The verifier and its output are the ignored `artifacts/editwrite-pass/verify_spans.py` and `spans.json` (`ev_c64f2e220809b56747905e07dc4033d64f0c9f3677d369686fd198fe416b0065`).

Edit:

- Input is `file_path`, `old_string`, `new_string` and an optional `replace_all` that defaults to false (`ev_4f6940021e578e3da4937d1bf5e2888d7dc05790518ca5d56efa101a9c777c36`).
- Replacement is literal. A function replacer means `$&` and `$1` are never expanded.
- Uniqueness is checked on `old_string`. Two or more matches fail unless `replace_all` is true. Identical `old_string` and `new_string` fail. A missing match fails.
- When `new_string` is empty and `old_string` does not end in a newline, the edit removes `old_string` plus its following newline if that sequence exists (`ev_f7779aff5193095d5593844efb5c9c3f0e26f1ddf790ce0040b9f783a82a762e`).
- A file is treated as CRLF when its first 4,096 characters hold more CRLF than lone LF. Content is matched as LF and written back as CRLF.
- Beyond tau's subset, the original also folds curly quotes, tries escaped and unescaped `old_string` forms, requires a prior full Read, rejects stale files by mtime unless content is unchanged, creates a file from an empty `old_string`, supports UTF-16LE and refuses files over 1 GiB.

Write:

- Input is `file_path` and `content`. It creates parent directories, requires a prior Read before overwriting, keeps the existing encoding and BOM, and writes content with LF endings as given.

Shared file writer (`ev_89a9f8a39998ce5e284273f9495cb9804c91e21fc022953183c7b6f3386f4126`):

- It opens a sibling `.tmp.<pid>.<hex>` with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` and the existing mode, writes, applies the original mode with `fchmod`, calls `fsync`, closes and renames over the target.
- It refuses symlink targets. On selected errors it falls back to an in-place write.

These are static observations. No original runtime comparison was made.

## Native layer (Ghidra)

A fresh Ghidra import decompiled one small direct caller of each of `_write`, `_pwrite`, `_ftruncate`, `_fsync`, `_fchmod`, `_rename` and `_renameat`. The baseline completed 8/8 and the treatment 9/9. See [the native report](ghidra-native.md#continuation-native-write-path-callers). Those wrappers share an errno and syscall-tag error record. The selected rename caller replaces a file via temp path plus rename. None of these native callers is linked to the JavaScript tools.

## Tau interface and behavior

```json
{"file_path":"src/example.ts","old_string":"foo","new_string":"bar","replace_all":true}
```

- `src/edit.ts` holds `applyEdit(content, {old_string, new_string, replace_all})`, a pure function implementing the Edit rules above: literal replacement, the uniqueness check on `old_string`, newline-on-delete, CRLF round trip and BOM preservation. Error text carries the same information as the original but uses tau's own wording for the match-count hint.
- `src/write.ts` holds `writeAtomic(file, data, beforeCommit?)`, shared by Write and Edit. It accepts text or encoded bytes, writes a hidden sibling temp file opened `O_EXCL|O_NOFOLLOW`, preserves mode, calls `fsync`, runs the optional recheck, renames over the target and deletes the temp file on failure.
- Write and Edit refuse a symlinked final path component. The existing workspace containment, exclusions, permission prompts and the 64 KiB Edit read limit are unchanged.

## Deliberate gaps

- Later continuations implement read-before-edit, content staleness, curly-quote/escape matching, BOM-marked UTF-16LE and empty-`old_string` creation. See [read state](read-state-contract.md) and [text fidelity](text-fidelity-contract.md) for evidence and stricter tau guards.
- No in-place fallback, full remote/context repair or original structured tool-result parity.
- Write and Edit schemas strip unknown keys, as they did before this slice. Read and Glob reject them. Aligning the two is a separate change.
- Lone LF characters in an edited CRLF file are written back as CRLF, matching the original.

## Verification

- Tests were written first: 15 of 118 failed against the old truncate-in-place code (`ev_0ccbe7975c9018183f4c6a7b99936fc868fbe118db7bff641da940351c714192`). A later regression for the uniqueness rule also failed before its fix. The final run passes 119 of 119 with a clean typecheck (`ev_f475e34d10b280112fe8007c2ee4a24796fe3d45c8ac94f446e7061aece21208`).
- A compiled-CLI probe with a loopback-only provider edits a mode-0640 CRLF file with a BOM, using an LF `old_string`, `replace_all` and a `$&` in `new_string`. The bytes on disk equal the expected CRLF output with the BOM intact, the mode stays 0640, no temp file remains, and the provider-visible result matches the CLI event (`ev_23c185ad9f85ad1700a2947a5bebb17d8e1fded3b7ea0efd063534a4c9756ef5`; probe `artifacts/editwrite-pass/cli-edit-probe.mjs`).
- Source evidence: tau `src/edit.ts` `ev_79f46984d10b5b50bf941868f296281be7ae91ec21bf4b1fd3251e5f8ada8217`, `src/write.ts` `ev_6c6916f6bbc89b70c6ca605d904e15274e25293d236187ea6fe0e86d2186d51c`.
