"""Print-protocol (--output-format json/stream-json, --input-format stream-json) cases.

Each case names a mock_api.py scenario, the CLI arguments both targets get,
optional NDJSON stdin, and whether the run skips permission prompts. The
original additionally gets --no-session-persistence, which tau lacks.
"""

STREAM = ["--output-format", "stream-json", "--verbose"]
TWO_TURNS = ('{"type":"user","message":{"role":"user","content":"first turn"}}\n'
             '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second turn"}]}}\n')

CASES = {
    # Reruns of artifacts/workflow-oracles-2026-11-18 captures.
    "text-streamjson": {"scenario": "text", "args": ["--print", "TAU_DIFFERENTIAL_TEXT", *STREAM]},
    "files-streamjson": {"scenario": "files", "args": ["--print", "TAU_DIFFERENTIAL_FILES", *STREAM]},
    "failures-streamjson": {"scenario": "failures", "args": ["--print", "TAU_DIFFERENTIAL_FAILURES", *STREAM]},
    "files-json": {"scenario": "files", "args": ["--print", "TAU_DIFFERENTIAL_FILES", "--output-format", "json", "--tools", "Read,Edit,Write"]},
    "text-partial": {"scenario": "text", "args": ["--print", "TAU_DIFFERENTIAL_TEXT", *STREAM, "--tools", "Read,Edit,Write", "--include-partial-messages"]},
    "text-stdin2": {"scenario": "text", "args": ["--print", *STREAM, "--tools", "Read,Edit,Write", "--input-format", "stream-json"], "stdin": TWO_TURNS},
    "text-noverbose": {"scenario": "text", "args": ["--print", "TAU_DIFFERENTIAL_TEXT", "--output-format", "stream-json", "--tools", "Read,Edit,Write"]},
    # New captures: the error subtypes and permission_denials.
    "files-max-turns": {"scenario": "files", "args": ["--print", "TAU_DIFFERENTIAL_FILES", *STREAM, "--tools", "Read,Edit,Write", "--max-turns", "2"]},
    "bash-denied": {"scenario": "sdk-bash-denied", "args": ["--print", "TAU_DIFFERENTIAL_DENIED", *STREAM, "--tools", "Bash"], "skip_permissions": False},
    "input-bad-role": {"scenario": "text", "args": ["--print", *STREAM, "--input-format", "stream-json"],
                       "stdin": '{"type":"user","message":{"role":"assistant","content":"x"}}\n'},
}

SCENARIOS = ["sdk-bash-denied"]


def respond(scenario, generation):
    """(content, stop_reason) for a scenario mock_api.py does not own."""
    if scenario == "sdk-bash-denied" and generation == 1:
        return [{"type": "tool_use", "id": "fixture-bash-1", "name": "Bash", "input": {"command": "echo denied-probe > probe.txt"}}], "tool_use"
    if scenario == "sdk-bash-denied":
        return [{"type": "text", "text": "denied workflow done"}], "end_turn"
    raise ValueError("unknown scenario")
