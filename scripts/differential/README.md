# Disposable differential harness

This macOS-only harness compares the pinned installed original CLI with the built
TypeScript port against an in-process loopback Messages API fixture. Run it from
the repository root using Python 3.11+ and the installed Xcode command-line tools.
Build tau with `npm run build` before comparing a new implementation.

```sh
python3 scripts/differential/isolation.py verify
python3 scripts/differential/run_original.py version
python3 scripts/differential/run_original.py help
python3 scripts/differential/run_original.py text --ordinary --artifacts artifacts/differential-pass/ordinary
python3 scripts/differential/run_tau.py text
python3 scripts/differential/run_original.py files --ordinary --artifacts artifacts/differential-pass/ordinary
python3 scripts/differential/run_tau.py files
python3 scripts/differential/run_original.py failures --ordinary --artifacts artifacts/differential-pass/ordinary
python3 scripts/differential/run_tau.py failures
python3 scripts/differential/summarize.py
```

`run_original.py` defaults to `--bare` for explicit minimal-mode observations.
Ordinary mode is necessary to compare ordinary startup and tools: the pinned
original advertises `Write` in ordinary mode and omits it in bare mode, despite
the same explicit `--tools Read,Edit,Write` filter. Tau currently lacks `--bare`
and `--no-session-persistence`; the tau record explicitly lists those omitted
flags. Its own session state remains inside the disposable tree.

Every run creates a new directory under `/private/tmp`, a fresh loopback server,
and a deny-default Seatbelt profile. A native independent canary must pass in
that live profile before copying or running the original. Source and copied
original SHA-256 must both match the pinned image. The runner constructs a fresh
dummy environment with disposable HOME/config/cache/tmp directories and a dummy
API key; no host environment credentials, proxy settings or Claude state are
inherited. Logs record environment key names without personal values.

Target and runtime copies use APFS copy-on-write clones (`cp -c`). Every file's
inode must differ from its source and its full SHA-256 must match. A separate
clone-write canary verifies source bytes remain unchanged. Original contexts run
sequentially to limit temporary disk and memory pressure.
New contexts require at least 1 GiB of free disk space before creating a tree.

The reviewed profile permits only the disposable tree, selected public system
libraries/programs, one literal public ICU data file, and metadata of the two
temporary-directory ancestors. Neither ancestor permits directory listing.
Writes are restricted to the disposable tree and `/dev/null`. All Mach service
lookups remain denied; network access permits only the exact mock loopback port.
The canaries test host sentinel read/metadata, Data-volume alias read, outside
writes, denied ancestor listings, another live loopback port, external IPv4 and
IPv6, UDP/DNS, UNIX sockets, credential-service lookup, and inherited child
restrictions, alongside positive controls. They use a generated sentinel, never
personal state. The copied Node runtime and enumerated public runtime packages
receive no checkout or host-home access.

Each process is bounded to 20 seconds and 8 MiB output. Its process group is
killed on completion as well as timeout. The disposable tree and mock listener
are removed on exit. A sandbox failure is evidence to investigate; it does not
authorize expanding the profile. Additional grants require independent positive
and negative canaries and coordination review before original execution.

Raw output, API requests, exact profiles, kernel denials and per-context canary
results remain under ignored `artifacts/differential-pass/`. They can contain
original proprietary prompts or descriptions; do not ship or publish them.
`summary.json` omits prompts and descriptions, retaining schema field names,
hashed tool-result content, final fixture bytes and comparison results. Passing
these small deterministic fixtures establishes this behavior only; it is not a
claim of complete CLI equivalence or coverage of every isolation mechanism.

Earlier observations are preserved separately: data-only SSE caused the
original SDK to retry nonstream while the initial port accepted it. The updated
port now follows the same stream-to-nonstream sequence; named SSE remains the
semantic baseline. Earlier failed startup records preserve missing disposable
HOME, ICU data and supported temporary-directory environment configuration.

Reproduce the unlabeled SSE compatibility case with `--sse-framing data-only`
on both runners and a separate `--artifacts artifacts/differential-pass/sse-data-only`
directory. Use `text --ordinary` for the original and `text` for tau. Preserve
the previous directory before comparing a changed build. The recorded
`sse-data-only-before/`, `sse-data-only-after/` and `sse-named-after/` comparison
can be summarized with `python3 scripts/differential/summarize_sse.py`.

For explicit stdio MCP workflows, run `run_mcp.py original allowed` and
`run_mcp.py tau allowed`, then repeat with `denied` and `required`. The latter
sets the tool's required-interaction metadata and passes both bypass permission
mode and its exact allowance. `summarize_mcp.py` generates a compact checkpoint.
The independently authored fixture logs discovery, initialization, tool calls
and process shutdown; it returns resource text plus structured content to test
projection as well as dispatch. Use a separate `--artifacts` directory before
and after a changed build. Each run copies the runtime and fixture into a fresh
verified tree; no installed MCP configuration or personal servers are read.

`run_settings.py CASE` observes original layered settings and instruction
behavior. Add `--executable tau --artifacts artifacts/differential-pass/settings-tau`
to run the same fixture against the port. `compare_settings.py` retains model,
schema, marker, tool-result and final-file differences; custom artifact directory
arguments support separate before/after records. Cases cover source gates, inline/file settings, dummy environment and
CLI model precedence, permission contradictions, initial/nested/imported rules,
owned-session resume, system-prompt snapshots, and eager versus nested edit
state. `resume-off` passes `--system-prompt-snapshot off` on both invocations.
The managed-inline case exercises only the synthetic SDK-parent restrictive
tier supported by the original flag; it does not reproduce administrator policy.
Run `summarize_settings.py` for a compact marker-bit report and a fuller pointer
index. All files, sessions and configuration exist only in the disposable tree.
The fixture API mirrors the requested model in its response; a preserved early
resume diagnostic documents why a mismatched response model was unsuitable for
model-persistence conclusions.

`prepare_mcp_scopes.py` creates readiness fixtures for global user/project-local
MCP state, ancestor project files, source gates, explicit/strict configuration
and rejected project names. It runs neither CLI nor any configured MCP command.
Regenerate recipes in live verified contexts before executing them. Managed
filesystem controls remain preparation and source/unit evidence because this
pinned macOS build exposes no supported disposable administrator root.

`run_mcp_scopes.py original CASE` and `run_mcp_scopes.py tau CASE` execute those
owned discovery recipes after live canaries. `compare_mcp_scopes.py` accepts
separate original and tau artifact directories, preserving before/after runs.
The recorded nine-case matrix covers source gates, collisions, strict mode and
project rejection; it retains per-origin RPC/process logs and checks PID cleanup.
An initial enterprise-presence mismatch and its Node stat/lstat/realpath probe
are preserved separately. The corrected loader treats an absent leaf as absent
before attempting ancestor-sensitive canonicalization.
