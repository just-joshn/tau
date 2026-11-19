# Ghidra native-launcher investigation

## Scope and provenance

The initial loader pass used **actual Ghidra 12.1.4**, not Craft Anything's built-in register-level lifter. The original Mach-O was imported statically with automatic analysis disabled. A fresh-project run requested and completed decompilation of **13 selected function entries**.

Target SHA-256: `e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837`.

Ghidra chose `AARCH64:LE:64:AppleSilicon`, compiler `default`; the launcher selected Java **21.0.12.1**. Reports and the local Ghidra project are ignored analysis artifacts under `artifacts/ghidra/`. Neither the target nor its extracted JavaScript was executed. No account state or live API was accessed.

The new repository files are independent instrumentation, not recovered application implementation:

- `scripts/ghidra/InspectLauncher.java`: SHA-pinned, range-bounded disassembly, direct call references, selected-function decompilation and completion counts.
- `scripts/ghidra/claude-2.1.326-ranges.tsv`: version-specific address facts. First row pins the executable hash; subsequent rows contain inclusive hexadecimal bounds from `LC_FUNCTION_STARTS`.
- `scripts/inspect-bun.ts`: independent Mach-O/Bun metadata parser.

## Results

### Native and JavaScript entries differ — derived

| Item                                    | File offset | Preferred virtual address |
| --------------------------------------- | ----------: | ------------------------: |
| Native `LC_MAIN` entry                  |   109983752 |             `0x1068e3808` |
| Bun section                             |   129744896 |             `0x107d98000` |
| Graph contents, after its length prefix |   129744904 |             `0x107d98008` |
| JavaScript entry module 7 contents      |   281710139 |             `0x110e84e3b` |

`LC_MAIN` requests an 18 MiB stack. These are preferred image addresses, **not live ASLR-adjusted addresses**. The JavaScript entry ID is not a native function address.

Evidence: Ghidra entry/call listing `ev_631aabb4ab77d5f786e78cc02c132d99ce6b2443b1441d6383ea9ae6bcad905a`; independent full-target metadata `ev_95df1158a2529a7b4d1b72b5668dd411d20f1e823b250727d79c3c60de5dc4a5`.

### Native accessor confirms the section and length boundary — derived

Function `0x106715e7c` calls `getsectiondata` with constants at `0x1073faa94` and `0x1073faa9a`. Direct byte inspection identifies them as `__BUN` and `__bun` (**observed**). Its pseudocode checks a non-null section lookup, section size of at least eight, and leading u64 no larger than section size minus eight.

The caller at `0x1068c6e88` passes the returned pointer plus eight and the leading u64 length to consumer `0x10553b740`.

**Practical correction:** the length prefix bounds the meaningful payload; unused trailing section capacity must not move the graph footer. Tau's inspector previously required the prefix to consume the entire section. It now accepts bounded section padding and rejects oversized prefixes, pointers into padding, and a marker present only at the wrong section end.

Evidence:

- Accessor: `ev_f3256f4ad8cf1b9512617a1113d8caf2e511e4873b0d472bee851841f555c446`.
- Constant bytes: `ev_aac59764d7abe2110f0e87d347f47dfeb46784a60d9a9842b98237254aa26e51`.
- Caller: `ev_c1710b573bf9511e384b6b455347ca326aa084d015c893a2f758a3a59d2bcc41`.

### Native consumer corroborates the module layout — derived

Consumer `0x10553b740` checks two eight-byte constants representing the 16-byte `\n---- Bun! ----\n` marker at the declared payload end. It reads the footer at end minus 48 bytes and divides module-table byte length by **`0x34` (52)**. This independently corroborates the graph layout previously decoded from bytes/public Bun source.

Evidence: `ev_be3f287cc868ab017aff4e50aa71c64644515fc4c778b984f149dd0ced8bb653`.

## Continuation: native search-helper dispatch

A subsequent pass in the existing imported project selected **nine entries**: native entry, three helper shims, three next native functions and two exit helpers. The report `artifacts/grep-pass/dispatch.txt` completed 9/9. The SHA-pinned `scripts/ghidra/claude-2.1.326-search-ranges.tsv` preserves the exact selected ranges; substitute it in the reproduction command below and require a 9/9 completion marker.

Entry comparisons and direct calls map `rg` to `0x1068d31b0`, `ug`/`ugrep` to `0x1068d31a0`, and `bfs` to `0x1068d3170`. The entry also consumes the literal environment key `ARGV0` at `0x10741a08a`. These are derived native-dispatch facts, not a recovered regex or subprocess contract. Bundled JavaScript separately identifies `rg` as the Grep tool backend and `ugrep`/`bfs` as shell-wrapper helpers.

Evidence: entry `ev_6132adc413819ba717377815473ada1dc524fc1cb0ef85c7554704af1c87f01e`, shims `ev_9efe50476b6dd9c837d042952ab997dbfb333b54068c891e881f47b9f0144bcb`, completion `ev_9b4e9be730e60ec3af7d7c1eb34716d37b1e4a003cc3d47ebb06a183ef58491f`, literal bytes `ev_49f87301df305e1ddf3c2dd04091746eaf9f874133a9905fea1074da65560114`.

The shared terminal shim `0x1068d3314` has an analyst-supplied `noreturn` annotation. Missing imported `__exit` typing initially created apparent fallthrough/incorrect signatures; the following controlled annotation pass removes the observed caller spill without recovering the full ABI. See [Grep contract, original byte spans and independent implementation limits](grep-contract.md).

## Continuation: exit annotation and deeper rg boundary

A **10/10 baseline** added entry `0x1055feddc`, reached from `0x1055f1040` at call site `0x1055f10bc`. A subsequent **11/11 treatment** additionally selected the imported executable thunk `__exit` at `0x106a96fd4..0x106a96fdf` and annotated it `noreturn`.

The shared terminal's bogus boolean/memory-search continuation disappeared, as did the `rg` shim's corresponding error-path spill. Its decompiled signature also changed. This supports hypothesis `hyp_7`: missing terminal-flow metadata was causing these artifacts. It does **not** validate every inferred signature or prove target runtime behavior. The thunk's indirect external target remains untyped, and its own pseudocode can still display a `return` despite its metadata.

The newly selected rg entry has a 7,700-byte declared body. Its large pseudocode includes possible-PIC and unreachable-flow warnings at addresses beyond that body. Only the relevant calls/warnings were inspected; its full semantics, regex/glob grammar and native ABI are not claimed recovered.

Local reports: `artifacts/glob-pass/rg.txt` and `rg-exit.txt`. Stable manifests: `scripts/ghidra/claude-2.1.326-rg-ranges.tsv` (10 entries) and `claude-2.1.326-rg-exit-ranges.tsv` (11). Use fresh imports to reproduce a baseline: annotations persist in the reused project after the treatment. Substitute the corresponding manifest in the reproduction command below and require the matching 10/10 or 11/11 completion marker.

Evidence: baseline excerpt `ev_0e0fe2c7b8b7ec3b1572b0006ebfb2965f5d2fcefd388d964127168222a69b50`; baseline completion `ev_6b33a863bd7e8740fc3c8b5a263fabb14e806aa6660646722aa4f92aa4f01bbd`; treatment `ev_4735ab11fcdba8618bedfe30af2d7b50a1cfd54b27ab7063d4976530c491061d`; treatment completion `ev_7db8914256a1ce0d75e6e063dc3aff090525b6619eee9b493bb0ce5d0a734b12`; deeper call/warning listing `ev_be7ba2a8072a67a57568301fae6dea34e586bdc1cd677e43bf1d304925ca7007`.

The application-level Glob wrapper is specified separately in [the Glob contract](glob-contract.md); those source observations are not inferred from unreliable native pseudocode.

## Continuation: selected native byte-read callers

A bounded scan of aligned direct `BL` words in `__text`, using Mach-O import stubs and `LC_FUNCTION_STARTS`, selected two small `_pread$NOCANCEL` callers and two `_read`/`_read$NOCANCEL` callers. Ghidra completed **4/4** entries, then **5/5** with a stack-failure thunk annotation. This is selected direct-call coverage, not complete call discovery.

| Entry         | Selected imported call | Scope of derived observation                                                                                                                                                 |
| ------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x1055368e0` | `_pread$NOCANCEL`      | Accumulates bytes/position, caps each request at `0x7fffffff`, retries negative results when errno is numeric 4, distinguishes short EOF from fulfilling the requested count |
| `0x1066a262c` | `_pread$NOCANCEL`      | Similar byte/position loop; returns a count or structured error-shaped data whose full ABI is not recovered                                                                  |
| `0x10449ed7c` | `_read$NOCANCEL`       | Reads one byte from descriptor 0, with a numeric-4 error retry                                                                                                               |
| `0x1042ca3c4` | `_read`                | Repeats 32-byte reads while each result is 32; application purpose remains unknown                                                                                           |

Marking imported `___stack_chk_fail` at `0x106a95c60..0x106a95c6b` as `noreturn` removes the last caller's spurious stack-failure fallthrough into adjacent close/callback code. The thunk's indirect external target remains untyped; its own pseudocode is not a recovered ABI.

**These native callers have not been connected to the JavaScript Read tool.** Their byte I/O and error behavior does not establish line offsets, model-facing formatting, media routing, or AbortSignal cancellation. In particular, a descriptor-0 read is not evidence of project-file reading.

Reports: ignored `artifacts/read-pass/io.txt` and `io-typed.txt`. SHA-pinned manifests: `scripts/ghidra/claude-2.1.326-io-ranges.tsv` (4 entries) and `claude-2.1.326-io-typed-ranges.tsv` (5). Substitute the manifest in the fresh-import reproduction procedure below and require the corresponding 4/4 or 5/5 completion marker. Annotations persist when reusing a project.

Evidence: complete baseline `ev_646dc8af2eb3b36697a63acb5b950eacd7cef012c818b1d911159f0494176649`; complete refinement `ev_fcecbb2ae69e86974e662d6bd8357a055858c1c38247620bf9aedac469037a46`; selected address facts `ev_5e3371601e3dcd22afc80e213c488009ae43446fb36780fc7283049f4447d602`.

## Continuation: native write-path callers

`scripts/ghidra/select-callers.py` generalizes the earlier one-off selector: aligned direct `BL` words in `__text`, Mach-O import stubs and `LC_FUNCTION_STARTS` bounds. Rerun with `_pread _read`, it reproduces `claude-2.1.326-io-ranges.tsv` byte for byte. It selected the smallest direct caller of each of `_write`, `_pwrite`, `_ftruncate`, `_fsync`, `_fchmod`, `_rename` and `_renameat`. Seventeen write-path families have direct callers; these seven make up a whole-file write. This is selected direct-call coverage, not complete call discovery.

| Entry         | Import             | Derived observation                                                                                                                                                   |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x1009954c0` | `_pwrite$NOCANCEL` | One call clamped to `0x7fffffff`, retried on errno 4; no accumulation of short writes, unlike the `_pread` loop                                                       |
| `0x1066a303c` | `_ftruncate`       | Retry on errno 4; error record tag `0x13`                                                                                                                             |
| `0x1043e68a4` | `_fsync`           | Error record tag `0x12` after errno normalization                                                                                                                     |
| `0x1066a2c70` | `_fchmod`          | Retry on errno 4; tag `0x0b`                                                                                                                                          |
| `0x1066a0500` | `_renameat`        | Retry on errno 4; copies the path into the error record; tag `0x28`                                                                                                   |
| `0x100f2e480` | `_rename`          | Takes a pending temp path from a mutex-guarded global, closes the descriptor, renames onto the destination, and on failure unlinks the temp path and calls a fallback |

The `_pread`, `_pwrite`, `_ftruncate`, `_fsync`, `_fchmod` and `_renameat` wrappers fill one error record shape: errno as a 16-bit value at `+0x24` and a per-call tag byte at `+0x26`. Reading the tag as a syscall identifier is an inference.

The baseline completed **8/8** with `___stack_chk_fail` marked `noreturn`. The treatment also marks `0x1069e4644..0x1069e465b` `noreturn`, because it is the final `BL` of the `_renameat` and `_rename` callers with the next function immediately after. It completed **9/9**, and the `_renameat` spill into `boundary_1066a05e0` disappeared (71 to 46 lines). The `_rename` caller did not shrink (1,412 to 1,409 lines). Its spill follows Ghidra's call-to-branch rewrite of calls to `0x10641c2c0`, so read only up to `code_r0x00010641c2c0`. The annotation is analyst-supplied.

**No selected native caller is linked to the JavaScript Edit or Write tools.** The bundled writer uses the same syscall families in the same order (see [the Edit and Write contract](edit-write-contract.md)). That is coherence, not ownership.

Reports: ignored `artifacts/editwrite-pass/write.txt` and `write-typed.txt`. Manifests: `scripts/ghidra/claude-2.1.326-write-ranges.tsv` (8 entries) and `claude-2.1.326-write-typed-ranges.tsv` (9). Run scripts `artifacts/editwrite-pass/run-ghidra.sh` and `run-ghidra-typed.sh` each import fresh and require the completion marker. Evidence: baseline `ev_dad8b60796d20f8680459e4ac8d333802ee21bdba6e37d4f549e250240c55306`; treatment `ev_035013afe9861cda90672bb082e95da169b7f2c1095f775b90dcc24bb8203b55`; treatment manifest `ev_77c18a5f791a0ae7ebdbbf3ce79208bb23784865bb7050616ad86899e4e8aa32`; selected calls `ev_12f49b4e2eb5375598a0de8bdcbaa2b1cecda4b176bd03958bea0ed2674b2ed1`.

## Continuation: native file metadata

A fresh static import selected the smallest direct caller of each `_fstat`, `_stat` and `_lstat`, plus the imported stack-failure thunk marked `noreturn`. Actual Ghidra 12.1.4 completed **4/4**. SHA-pinned manifest: `scripts/ghidra/claude-2.1.326-stat-ranges.tsv`. Reproduce using that manifest in the command below; require `COMPLETE requested=4 succeeded=4 failed=0` in the fresh report. Local run script/report: ignored `artifacts/staleness-pass/run-ghidra.sh` and `stat.txt`.

| Entry         | Import   | Derived observation                                                                                           |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `0x100e2961c` | `_fstat` | Retries numeric errno 4; clamps a signed result field to nonnegative and returns a tagged result/error record |
| `0x1065b9ab0` | `_stat`  | Zeroes a local result area, copies it to the output on success, encodes errno on failure                      |
| `0x1065b9b88` | `_lstat` | Similar result copying/error encoding with a different imported call                                          |

Evidence: first report page `ev_7c8d5436d502b4093a1ebaa6aed9035d643f05de8a344038397e25cf858bfbd2`; final page and completion `ev_adc5830e39068b8d4e723aa7f42ed990de704b23331526a314f18962a61372c6`. The `_lstat` function retains a generated `boundary_` name because the selected preceding function caused that marker to be created first; it is explicitly selected and decompiled, not a newly discovered application label.

No selected caller has been connected to the JavaScript Read/Write/Edit tools. Neither native `mtimeMs` conversion nor a complete stat structure ABI is claimed recovered. [Read-state semantics](read-state-contract.md) come from byte-verified JavaScript separately. Thunk annotations and completion have the limitations below.

### Darwin stat type refinement

The next pass adds **analyst-supplied syscall prototypes**, leaving wrapper calling conventions inferred. Compile-only arm64 SDK assertions/layout establish a 144-byte `struct stat`, with `st_mtimespec` at 48 and `st_size` at 96. No generated executable is run. SDK evidence: `ev_54cbd5881338a89932ab4badd1df5455f0e35cbeee04a178d82cf13d37d74727`; assertions: `ev_faecb31fa541cbbd4a012a4af2a5af26b0168fd3520692434f313c5f940f1942`.

`scripts/ghidra/InspectStatAbi.java` checks the target SHA and AppleSilicon language, defines that layout and types only `_fstat`, `_stat`, `_lstat` and `___error` imports. A fresh import runs the preceding baseline (**4/4**), then decompiles the three callers with types (**3/3**). Script: `ev_a526e01fd971979bc0f32053af8875571d01ff74ea13a295fafb6d230d8c5430`; report: `ev_08ee4654b77dfa0a734168de1eca9b587d2d0d1d544d1144acd4290edcde3732` (ignored `artifacts/staleness-pass/stat-abi.txt`).

The formerly unnamed clamped field in `0x100e2961c` resolves to `st_size`. The stat/lstat wrappers copy named size/time fields into output records. This uses an externally checked ABI annotation; the names are not recovered local symbols. It does not connect the wrappers to application tools, recover JavaScript millisecond conversion or validate wrapper return/parameter conventions.

Reproduce by appending a second `-postScript InspectStatAbi.java "$run_dir/stat-abi.txt"` after the stat-manifest `InspectLauncher.java` invocation in a fresh import. Require both completion markers. The local complete runner is `artifacts/staleness-pass/run-stat-abi.sh`. Annotations persist in reused projects; fresh imports are required for untyped baselines.

## Continuation: clocks and sleep

Actual Ghidra completed a **4/4** direct-call timing baseline, then a fresh **5/5** baseline with a timebase initializer and **5/5** with SDK-checked import types. Manifests: `scripts/ghidra/claude-2.1.326-clock-ranges.tsv` and `claude-2.1.326-clock-abi-ranges.tsv`. `InspectClockAbi.java` checks the SHA/language and annotates syscall types; wrapper signatures remain inferred.

Compile-only arm64 SDK assertions establish CLOCK_MONOTONIC=6, 16-byte timespec/timeval layouts, 32-bit timeval microseconds and 8-byte Mach timebase data: `ev_1230778a7921ebd371fff9d79b4f9f7a415f9e409720070fe95d4396ae385111`; SDK dump pages `ev_7b482eee42a2a0e1d3822e76384c24015db68c78250604a1e20de7c2b36a00f8`, `ev_28efe3aec9c1877192f0af488b17223625799ea4549323a2c96813e7e98933ac`. No generated executable was run.

| Entry         | Derived observation                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `0x106685b00` | Requests CLOCK_MONOTONIC and returns the seconds/nanoseconds pair                                                                    |
| `0x10668a9a4` | One TLS/global-conditioned path repeats nanosleep with constant timespec `{1,0}`; other paths remain untyped                         |
| `0x104d5f438` | Reads mach_absolute_time, applies global ratio fields and divides by 1000; ratio initialization/units at this site remain unverified |
| `0x104de2180` | Uses gettimeofday or an object callback, then returns/clamps timeval seconds and microseconds                                        |
| `0x1063b8628` | Initializes a distinct global timebase object and aborts on failure                                                                  |

The initializer initially spilled into pthread_once, continuous-clock and unrelated predicate code. The SDK declares abort `__dead2` (`ev_9bca9d7f4de6d7b4ab089a19d80dba797166a1e6f28941eaaf1505a8b195afa7`). Applying the standard noreturn annotation removes that continuation, reducing the report section from 33 to 17 lines. Before: `ev_e33d474a65592e894d3e3dfc06849f35c28fe9fc2308d396463a5ad23a54517b`; final **5/5**: `ev_0d4cd9720089366fe8beee7aea0e4a003108c68c12096c9cdc5608b1dbc7dd4f`.

At that baseline, nanosleep's two unknown TLS helper paths still spill beyond its selected body. The following pass resolves the thread-exit continuation. Neither its inferred pointer return nor other TLS paths are a recovered ABI. These functions have not been connected to application retry timers; they do not specify retry delays.

Ignored reports/runners: `artifacts/ledger-pass/clock.txt`, `clock-abi-before-abort.txt`, `clock-abi.txt`, `run-ghidra.sh`, `run-clock-abi.sh`. Reproduce the final pass using a fresh import, the five-entry clock-ABI manifest in InspectLauncher, then `-postScript InspectClockAbi.java "$run_dir/clock-abi.txt"`. Require both 5/5 markers. The original four-entry manifest instead requires 4/4. Current script includes the abort annotation; the saved pre-abort report preserves that baseline.

## Continuation: thread-exit control flow

The retained timing project was reused for **2/2** selected helper decompilations, avoiding another full import. `claude-2.1.326-sleep-helper-ranges.tsv` pins the original SHA and `LC_FUNCTION_STARTS` bounds: `0x10668c390..0x10668c40f` (128 bytes) and `0x106689e80..0x106689e8f` (16 bytes). `InspectControlFlow.java` then records bounded instruction and flow facts (**2 ranges**), independently of decompiled types.

The 16-byte helper is four straight-line instructions: save frame/link registers, establish the frame, place zero in x0, and call imported `_pthread_exit` at `0x106a97d90`. The local SDK declares `pthread_exit(void*)` noreturn. `RefineThreadExit.java` guards the SHA, instruction count and final target, applies that import prototype and the derived wrapper noreturn annotation, then decompiles the wrapper and nanosleep caller (**2/2**). Their false continuation into adjacent functions disappears. No target code runs, and the other helper is not marked noreturn: it has conditional return and indirect/tail flow that remains unresolved.

Evidence: native flow `ev_02161816cdf6d44510199df3cba9576f0bdfa1574d518e715df38fec27f8de05`; initial helper decompilation `ev_7068861ca4416877f357adb2e3c56b1478b751c3ba689fa4fde3af9d8343fbaf`; typed treatment `ev_7c94a22194412dfd6af0c3f141c3ffc767c3a41e836badc1f0183e3ed145a58c`; SDK declaration `ev_80600fea925e999a986c8f3972c3c925687deb682a877d2d3182707a745c1b0d`.

Ignored reports/runners are under `artifacts/deadline-pass/`: `sleep-helpers.txt`, `sleep-flow.txt`, `thread-exit.txt` and `run-{sleep-helpers,flow,thread-exit}.sh`. Use `-process 2.1.326 -noanalysis` on `artifacts/ghidra/run.FXQI6l/Timing.gpr`, then the matching postscript. Require the report completion marker. The reused database now includes the annotations; preserve the baseline reports when comparing. Disk free space fell to about 2 GiB during this continuation, so reuse this import and avoid duplicate databases. No unrelated local files were deleted.

## Continuation: TLS terminal formatting path

A reused-project baseline follows the remaining TLS helper into `0x1069e40e0` (48 bytes), then `0x1069e42e4` (60 bytes): **2/2**, expanded **3/3**. A bounded native flow report covers all three ranges. The final entry is straight-line through a call at `0x1069e4308` and `udf 0` at `0x1069e430c`, with no return path. The 48-byte entry calls that terminal function as its last instruction.

`RefineTrapFlow.java` checks the SHA/language, straight-line instruction/fallthrough facts, final direct target and UDF. It marks only those two callees noreturn and decompiles all three entries (**3/3**). The TLS helper's adjacent spill disappears; its conditional return and unresolved indirect tail remain. These are native control-flow-derived annotations, not recovered source signatures or an application timer/permission ownership claim.

Manifest: `claude-2.1.326-tls-unwind-ranges.tsv`. Ignored runners/reports: `artifacts/recovery-pass/{run-ghidra.sh,run-flow.sh,run-trap-refinement.sh,tls-unwind-before.txt,tls-unwind.txt,tls-flow.txt,trap-refined.txt}`. Reuse the same Timing project and require each completion marker; annotations now persist there. Baseline `ev_6d53aa8d326ca868d7e2c97d027ccc16e2576d64978473714405eb77f961f9de`; native flow `ev_f4bd0ad77487e5db632e2b94a4c076ad86552abe48ea6c043289594afad18fa5`; treatment `ev_0ec5ac62f0050e9a09d25e7f7d81d665156896576b4118278c362fcc44733ada`.

## Continuation: selected native network callers

Aligned direct import calls select the smallest caller of recv, recvfrom, poll and connect: **4/4** actual Ghidra decompilations, then **4/4** with checked Darwin import types. Manifest `claude-2.1.326-network-ranges.tsv`; instrumentation `InspectNetworkAbi.java`. This selected scope is not all networking paths or a link to the application provider.

| Entry         | Derived observation                                                                          |
| ------------- | -------------------------------------------------------------------------------------------- |
| `0x104e5ed18` | One-byte recv with flags0x82, EINTR retry, separate zero/positive/EAGAIN/other-error results |
| `0x103eca428` | recvfrom/close and errno paths; wrapper/out-record conventions remain inferred               |
| `0x104c2c328` | Zero-timeout poll of one descriptor, checking returned error/hangup flags                    |
| `0x10426eb28` | Connect with a16-byte address record; EAFNOSUPPORT handled specially                         |

Compile-only arm64 SDK assertions check ssize_t8, socklen_t/nfds_t4, sockaddr16, pollfd8 with fd/events/revents offsets0/4/6, MSG_PEEK2, MSG_DONTWAIT128, EINTR4, EAGAIN35, EAFNOSUPPORT47 and poll flags. Function-pointer type assertions check the imported prototypes. No generated executable runs. Typed stack-failure noreturn metadata removes the connect caller's false continuation into adjacent setsockopt code.

Evidence: baseline `ev_414d44afb94217de1ad0442cbb7521c7fbcb6ddf72a692e146da413e3f5920aa`; typed `ev_7108c5caa040cab4a62a5e8f59890b9a8d45b52b70b633bf2ddae8f2a20076c5`; compile-only result `ev_fcfa77abe1e671661d478d5915871ee8e06de9ee4fc497b32cfc2c8c505471ed`. Ignored runners/reports under `artifacts/stream-pass/`: run-ghidra.sh, run-network-typed.sh, network.txt, network-typed.txt, network-abi.c and network-abi-check.json. Reuse the retained Timing project; require both4/4 markers. Types are analyst-supplied and persist; wrapper ABI, all indirect paths and application ownership remain unresolved.

## What completion does not prove

The initial loader report ends with `COMPLETE requested=13 succeeded=13 failed=0` (`ev_05200c401df979fef24f2963facac25ea428f2d70fef238534acfd014197dbfb`). That means Ghidra returned pseudocode for the selected entries, not that its types, prototypes or all inferred control flow are correct.

- Disassembly starts inside declared executable ranges; the decompiler can follow shared/tail flow beyond a declared body. Selected entries are a scope boundary, not a proof of complete control-flow coverage.
- The loader reported failed symbol markup and missing Rust native support. External libraries were not imported. Many names/types are generated or unknown.
- `0x1068c6e88` produced an unreadable inferred-address warning; switch recovery and type propagation remain incomplete. Do not use its speculative paths as a complete behavior specification.
- An initial unannotated `LC_MAIN` decompilation incorrectly fell through its exit helper into adjacent code. After inspecting helper `0x10668ad94`, whose native call listing reaches `_exit`, the manifest explicitly marks it `noreturn`. The annotation is analyst-supplied, not an automatically recovered original signature. The helper evidence is included in `ev_f3256f4ad8cf1b9512617a1113d8caf2e511e4873b0d472bee851841f555c446`.
- These findings do not establish full native-runtime, JSC, permission-system or coding-agent parity. Bundled JavaScript remains the more direct source for application-level reconstruction.

## Reproduce the Ghidra pass

Use a Ghidra installation with its host-native decompiler available, and a supported JDK (this run used Java 21). Run from the repository root. The example uses paths without whitespace for JVM property values.

```sh
export GHIDRA_HOME="$PWD/artifacts/ghidra/tool"
export GHIDRA_HEADLESS_MAXMEM=4G
mkdir -p artifacts/ghidra
run_dir="$(mktemp -d "$PWD/artifacts/ghidra/run.XXXXXX")"
mkdir "$run_dir/home" "$run_dir/tmp"
export _JAVA_OPTIONS="-Duser.home=$run_dir/home -Djava.io.tmpdir=$run_dir/tmp"

"$GHIDRA_HOME/support/analyzeHeadless" "$run_dir" Launcher \
  -import "$HOME/.local/bin/claude" -noanalysis -max-cpu 2 \
  -scriptPath "$PWD/scripts/ghidra" \
  -postScript InspectLauncher.java \
    "$PWD/scripts/ghidra/claude-2.1.326-ranges.tsv" "$run_dir/report.txt" \
  -log "$run_dir/headless.log" -scriptlog "$run_dir/script.log"

grep -qx 'COMPLETE requested=13 succeeded=13 failed=0' "$run_dir/report.txt"
```

Ghidra headless can return exit code 0 even after a script error; the report completion check is required. Each run uses a fresh directory, so an old report cannot satisfy that check. The script refuses a different executable hash before applying the address manifest. It allows at most 64 ranges, each at most 64 KiB, and a 30-second decompilation timeout per function. A report may still contain inference warnings; inspect them.

**Do not rely on analyzeHeadless's exit status alone:** the initial missing-decompiler script failed, yet the process exited zero after successfully saving the imported project.

### macOS ARM64 component build used here

The installed release contained a Linux native decompiler but no `os/mac_arm_64/decompile`. Its local `docs/GettingStarted.md` explicitly documents building native components for macOS. We copied the tool installation into ignored `artifacts/ghidra/tool/`, then built only the native decompiler from the shipped C++ sources. The managed installation was not changed.

On macOS, with Xcode command-line tools available, the build used:

```sh
# Set MANAGED_GHIDRA to the existing installation root.
# Destination must be fresh; do not run this over an existing tool copy.
cp -cR "$MANAGED_GHIDRA" artifacts/ghidra/tool
(
  cd artifacts/ghidra/tool/Ghidra/Features/Decompiler/src/decompile/cpp
  make -j4 ghidra_opt ARCH_TYPE='-arch arm64' ADDITIONAL_FLAGS='' \
    OPT_CXXFLAGS='-O1 -Wall -Wno-sign-compare' CXX='clang++ -std=c++11'
  mkdir -p ../../../os/mac_arm_64
  cp ghidra_opt ../../../os/mac_arm_64/decompile
)
```

This compiles Ghidra's tool code, not the inspected Claude executable. The local copy/projects occupy about 1.3 GiB and must remain excluded from tau distribution.

## Verification of the independent implementation

- TypeScript check: `ev_30ad6acf836ae3d7fcedd18991096617ec86927fc9768a8a1539e3a1976563bb`.
- **67 passing tests**, including native-entry mapping, malformed/unsafe ranges, every truncated synthetic prefix and padded payload boundaries: `ev_90f45a97618802f14789b6eb1542f3ff67b7f4b5ee3bc6b97246dd34044ed77c`.
- Interactive PTY approval/write/cancellation/status/exit checks: `ev_a3d2498b35286e2337d153a63f245464334e095d29b2cd629b041c115b588f84`.

No original runtime comparison or live Anthropic integration was performed.

## Embedded-source bridge continuation

The later parser/reasoning pass reuses Ghidra12.1.4's Timing project and imported program2.1.326. `scripts/ghidra/InspectEmbeddedSpans.java` checks a pinned manifest against nonexecutable `__bun` memory, using the verified file/preferred-address mapping. All26 bounded spans match their expected SHA256 values: `ev_b37cb778d1230628062ef1a441a249b2da0abb4f4e38b67b3fb6e6ab28e47ea7`, ending `COMPLETE requested=26 matched=26 failed=0`.

This verifies provenance of recovered parser/model/launch JavaScript within the imported image; it does not decompile JavaScript as native functions. The earlier actual native decompilation results remain separate. Ignored runner/manifests/reports are in `artifacts/parser-pass/{run-embedded-spans.sh,embedded-spans.tsv,embedded-spans.txt}`. Read [the parser/reasoning contract](parser-reasoning-contract.md) for that283-test checkpoint and the [current handoff](HANDOFF.md) for later work.

The next thinking-recovery pass independently matches33/33 selected spans with the same script/project: `ev_e6cf7d03682abe936f460648a3091de1d9eb8f7e780f8e8fe1eca882df87232b`, completion marker `COMPLETE requested=33 matched=33 failed=0`. Earlier23/30/32 reports remain in ignored resumption-pass artifacts. The [thinking recovery contract](thinking-recovery-contract.md) records the source boundaries,309-test/CLI/session validation and explicit effective-context/provider gaps. These byte checks do not resolve indirect native ABI or application ownership.

The context/compaction pass matches36/36 selected spans from eight containing modules, ending `COMPLETE requested=36 matched=36 failed=0`: `ev_b2a1043844091e0ffd064ffe34c0cfa3de94656f9a512bd6667e43870c26e67b`. Prior26/32/33 context reports are retained. The same pinned-image script checks context/model/usage/summary/beta source provenance; it makes no additional native ABI claim. The [context contract](context-contract.md) records the independent333-test implementation and actual `/compact` PTY validation.
