#!/usr/bin/env python3
"""Static source check and inert recipes only; no target, listener or fixture runs."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256
from prepare_plugins import PINNED_TARGET

SETS = {
    'subagents-research/spans.json': (34, {'agent_fork_disable_gate', 'agent_call_background_schema', 'agent_child_runquery_parameters'}),
    'agents-research/spans.json': (68, set()),
    'background-agents-research/spans.json': (68, {'background_launch_selector', 'background_ordinary_gate', 'background_default_session_flags', 'background_async_immediate_result',
        'background_child_scope_async', 'background_output_path', 'background_output_symlink', 'background_print_agent_holds', 'background_print_wait_state', 'background_print_wait_ceiling'}),
    'background-agents-research/print-session/spans.json': (30, {'background_print_new_turn_arm', 'background_print_submit_next_query', 'background_headless_new_query_params',
        'background_query_fresh_guard_counter', 'background_print_result_hold_predicate', 'background_print_ordinary_notification_not_plugin'}),
}


def verify():
    modules = {row['name']: row for row in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']}; groups = {}; spans = []
    for relative, (minimum, required) in SETS.items():
        path = REPO/'artifacts'/relative; rows = json.loads(path.read_text())
        if len(rows) < minimum or not required <= {row['id'] for row in rows}: raise RuntimeError('Background source handshake incomplete: '+relative)
        groups[relative] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'spans': rows}; spans.extend(rows)
    with PINNED_TARGET.open('rb') as target:
        if hashlib.file_digest(target, 'sha256').hexdigest() != TARGET_SHA256: raise RuntimeError('Pinned retained target differs')
        for name in {row['module'] for row in spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest() != modules[name]['sha256']: raise RuntimeError('Background module differs')
        for row in spans:
            target.seek(row['offset']); raw = target.read(row['length'])
            if hashlib.sha256(raw).hexdigest() != row['sha256'] or raw.decode() != row['text']: raise RuntimeError('Installed background bytes differ')
    return {'all_equal': True, 'target_source_path': str(PINNED_TARGET), 'target_sha256': TARGET_SHA256, 'groups': groups, 'spans': len(spans), 'original_executed': False, 'recovered_code_executed': False}


def recipes():
    common = {'model': 'claude-sonnet-4-6', 'tools': ['Agent', 'Read'], 'allowedTools': [], 'max_turns': 2,
              'definition_path': 'work/.claude/agents/owned-reader.md',
              'definition': '---\nname: owned-reader\ndescription: Owned background read control\ntools: Read\nmodel: inherit\nmaxTurns: 3\n---\nOWNED_AGENT_SYSTEM_READER\nFollow only the owned delegation request and return its requested marker.\n',
              'input_file': {'relative': 'work/owned-background-input.txt', 'text': 'OWNED_BACKGROUND_FILE\n'},
              'Agent_input': {'description': 'Owned background control', 'prompt': 'OWNED_BACKGROUND_CHILD_REQUEST', 'subagent_type': 'owned-reader', 'run_in_background': True},
              'environment': {'CLAUDE_CODE_FORK_SUBAGENT': '0'}, 'session_persistence': 'ordinary owned dummy config; do not pass --no-session-persistence',
              'hooks': {}, 'mcp': {}, 'external_fixture_processes': 0}
    return {'gated-background': {**common, 'expected_messages': 6, 'parent_generations': 4, 'child_generations': 2,
        'gate': {'same_mock_port': True, 'child_first_response_wait_seconds': 5, 'release_after': 'parent generation2 end_turn SSE response written and flushed',
                 'timeout_action': 'record failed gate and finish bounded owned child text; stop phase, no retry'},
        'actions': ['P1 Agent explicittrue', 'C1 waits for P2 response flush; then Read exact owned input', 'P2 async launch observed while child not finished; respond OWNED_PARENT_EARLY end_turn',
                    'C2 return OWNED_BACKGROUND_CHILD_FINAL end_turn', 'P3 require task-notification and child marker; Read unique owned launch output .output path', 'P4 require output Read includes child marker; OWNED_PARENT_AFTER_NOTIFICATION end_turn'],
        'partial_order_only': ['P1 before P2', 'P2_response_flushed before C1_response_sent', 'C1_response_sent before C2_request', 'C2_response_sent before P3_notification_request', 'P3 before P4']},
        'disabled-foreground': {**common, 'environment': {**common['environment'], 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS': '1'}, 'expected_messages': 3, 'parent_generations': 2, 'child_generations': 1,
            'gate': None, 'actions': ['P1 Agent explicittrue', 'C1 return OWNED_DISABLED_CHILD_FINAL end_turn', 'P2 require completed foreground report; OWNED_DISABLED_PARENT_FINAL end_turn'],
            'partial_order_only': ['P1 then C1 then P2'], 'no_completion_notification': True}}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--output', type=Path, default=REPO/'artifacts/differential-pass/background-agents-preparation'); args = parser.parse_args()
    proof = verify(); args.output.mkdir(parents=True, exist_ok=True); (args.output/'source-preflight.json').write_text(json.dumps(proof, indent=2)+'\n'); (args.output/'recipes.json').write_text(json.dumps(recipes(), indent=2)+'\n')
    print(json.dumps({'all_equal': True, 'installed_spans': proof['spans'], 'expected_messages': 9, 'expected_cli': 2, 'target_executed': False, 'fixture_executed': False, 'listener_started': False}))


if __name__ == '__main__': main()
