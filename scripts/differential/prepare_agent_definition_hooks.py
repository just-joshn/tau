#!/usr/bin/env python3
"""Static source preflight and inert recipes only; no CLI, hook, listener or mock response runs."""
import argparse
import ast
import hashlib
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256

PINNED_TARGET = Path('/Users/josh-desktop/.local/share/claude/versions/2.1.326')
MODEL = 'claude-sonnet-4-6'
ROOT = '__OWNED_ROOT__'
NODE = '__COPIED_PUBLIC_NODE__'
FIXTURE = ROOT + '/agent-definition-hooks-fixture.cjs'
LOG = ROOT + '/agent-definition-hooks.jsonl'
INPUT = ROOT + '/work/owned-hook-input.txt'
ENV = {'CLAUDE_CODE_FORK_SUBAGENT': '0'}
PROOFS = {
    'agent-definition-hooks-research/spans.json': (38, {
        'agent_definition_hooks_i5i', 'agent_definition_hooks_UD_register_afterStart',
        'agent_definition_hooks_subagent_start_payload', 'agent_definition_hooks_subagent_interrupted_stop_cleanup',
        'agent_definition_hooks_session_registry_class', 'agent_definition_hooks_execution_success_callback_admission'}),
    'scoped-hook-dispatch-research/spans.json': (43, {
        'scoped_hook_dispatch_G', 'scoped_hook_dispatch_project_view_identity',
        'scoped_hook_dispatch_inline_Skill_owner_registration', 'scoped_hook_dispatch_Dlo_global_command_reduction',
        'scoped_hook_dispatch_ordinary_settings_schema', 'scoped_hook_dispatch_gW', 'scoped_hook_dispatch_hC', 'scoped_hook_dispatch_tZ'}),
    'subagent-hooks-research/spans.json': (53, {
        'subagent_start_payload', 'subagent_stop_payload', 'subagent_successful_loop_exit_guard',
        'hook_common_session_payload', 'subagent_stop_prevent_precedence'}),
    'subagents-research/spans.json': (34, {
        'agent_call_background_schema', 'agent_fork_disable_gate', 'agent_child_runquery_parameters',
        'agent_foreground_result', 'agent_nesting_cap'}),
    'agents-research/spans.json': (68, set()),
    'background-agents-research/spans.json': (68, {
        'background_async_immediate_result', 'background_default_session_flags', 'background_ordinary_gate'}),
    'background-agents-research/print-session/spans.json': (30, {
        'background_print_submit_next_query', 'background_print_new_turn_arm', 'background_print_result_hold_predicate'}),
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify():
    modules = {row['name']: row for row in json.loads((REPO / 'artifacts/bundle-manifest.json').read_text())['modules']}
    spans = []
    groups = {}
    for relative, (minimum, required) in PROOFS.items():
        path = REPO / 'artifacts' / relative
        rows = json.loads(path.read_text())
        if len(rows) < minimum or not required <= {row['id'] for row in rows}:
            raise RuntimeError('Agent-definition-hook source handshake incomplete: ' + relative)
        groups[relative] = {'sha256': digest(path), 'spans': len(rows)}
        spans.extend(rows)
    with PINNED_TARGET.open('rb') as target:
        if hashlib.file_digest(target, 'sha256').hexdigest() != TARGET_SHA256:
            raise RuntimeError('Pinned retained target differs')
        for name in {row['module'] for row in spans}:
            if digest(REPO / 'artifacts/claude-bundle' / name) != modules[name]['sha256']:
                raise RuntimeError('Recovered source module differs')
        for row in spans:
            target.seek(row['offset'])
            raw = target.read(row['length'])
            if hashlib.sha256(raw).hexdigest() != row['sha256'] or raw.decode() != row['text']:
                raise RuntimeError('Pinned executable source bytes differ')
    return {'all_equal': True, 'target_source_path': str(PINNED_TARGET), 'target_sha256': TARGET_SHA256,
            'groups': groups, 'spans': len(spans), 'original_executed': False, 'recovered_code_executed': False}


def command(kind, once=False):
    return {'type': 'command', 'command': NODE, 'args': [FIXTURE, 'hook', LOG, kind],
            'timeout': 3, **({'once': True} if once else {})}


def definition(name, tools, marker, hooks, turns=4):
    fields = {'name': name, 'description': 'Owned definition hook fixture ' + name,
              'tools': tools, 'model': 'inherit', 'maxTurns': turns, 'hooks': hooks}
    # JSON is valid frontmatter YAML. No vendor prompt is copied.
    return '---\n' + '\n'.join(key + ': ' + json.dumps(value) for key, value in fields.items()) + '\n---\n' + marker + '\nFollow only the supplied owned request and finish with its owned marker.\n'


def delegation_marker(case, scope):
    return 'OWNED_AGENT_DEF_HOOK_DELEGATION_' + case.upper().replace('-', '_') + '_' + scope.upper()


def agent(name, background=False, case='dedup-once-foreground'):
    scope = name.removeprefix('owned-hook-')
    return {'description': 'Owned definition hook control', 'prompt': delegation_marker(case, scope) + '\nPerform only the owned control and return its final marker.',
            'subagent_type': name, 'run_in_background': background}


def recipes():
    common = {'model': MODEL, 'permission_mode': 'default', 'tools': ['Agent', 'Read'], 'allowedTools': [], 'environment': ENV,
              'settings_source': 'owned dummy config user settings', 'configuration_directory': ROOT + '/config',
              'input_file': {'path': INPUT, 'text': 'OWNED_DEFINITION_HOOK_FILE\n'},
              'command_fixture_source': 'scripts/differential/agent_definition_hooks_fixture.cjs',
              'command_fixture_destination': FIXTURE, 'hook_log': LOG,
              'runtime': 'copied public Node direct args, unchanged deny-default isolation and independent canary',
              'model_identity': 'explicit full parent ID; all child definitions inherit',
              'no_execution_go': True, 'mcp': {}, 'no_builtin_prompt_copy': True,
              'response_identity': 'unique msg_owned_def_hooks_CASE_SCOPE_GENERATION; classify only by unique DIRECT USER delegation markers; system/catalog/tool inputs/tool results excluded'}
    read = command('common-read', once=True)
    read_group = {'PreToolUse': [{'matcher': '^Read$', 'hooks': [read]}]}
    reader_hooks = {**read_group, 'Stop': [{'matcher': '^owned-hook-reader$', 'hooks': [command('foreground-stop')]}]}
    foreground = {**common,
        'expected_messages': 6, 'hard_message_cap': 8, 'max_cli': 1,
        'definitions': {'work/.claude/agents/owned-hook-reader.md': definition('owned-hook-reader', ['Read'], 'OWNED_DEF_HOOK_SYSTEM_READER', reader_hooks)},
        'settings': {'hooks': read_group},
        'scopes': {'parent': 3, 'reader': 3},
        'responses': [
            {'scope': 'parent', 'generation': 1, 'tool': 'Agent', 'input': agent('owned-hook-reader')},
            {'scope': 'reader', 'generation': 1, 'tool': 'Read', 'input': {'file_path': INPUT}},
            {'scope': 'reader', 'generation': 2, 'tool': 'Read', 'input': {'file_path': INPUT}},
            {'scope': 'reader', 'generation': 3, 'text': 'OWNED_DEF_HOOK_READER_FINAL'},
            {'scope': 'parent', 'generation': 2, 'tool': 'Read', 'input': {'file_path': INPUT}},
            {'scope': 'parent', 'generation': 3, 'text': 'OWNED_DEF_HOOK_FOREGROUND_PARENT_FINAL'}],
        'assertions': ['Common Read hook process count is exactly 3: child twice, parent once.',
            'Child once metadata does not suppress its second Read hook.',
            'Global settings and definition identical command do not both execute for one Read.',
            'The overwritten settings once state remains available for the parent Read.',
            'One foreground SubagentStop command, correct owning session and child transcript fields.',
            'Owned input file bytes unchanged; all hook pids exited; natural CLI/group cleanup.'],
        'limitations': ['Only one parent Read: this does not independently establish all global once semantics.']}
    stop = command('common-stop', once=True)
    global_hooks = {'SubagentStart': [{'matcher': '^owned-hook-(outer|inner|background)$', 'hooks': [command('global-start')]}],
                    'SubagentStop': [{'matcher': '^owned-hook-(outer|inner|background)$', 'hooks': [stop]}]}
    child_stop = {'Stop': [{'hooks': [stop]}]}
    outer_hooks = {**child_stop, 'SubagentStart': [{'matcher': '^owned-hook-inner$', 'hooks': [command('definition-start-MUST-NOT-RUN')]}]}
    nested = {**common, 'expected_messages': 8, 'hard_message_cap': 10, 'max_cli': 1,
        'definitions': {
            'work/.claude/agents/owned-hook-outer.md': definition('owned-hook-outer', ['Agent', 'Read'], 'OWNED_DEF_HOOK_SYSTEM_OUTER', outer_hooks),
            'work/.claude/agents/owned-hook-inner.md': definition('owned-hook-inner', ['Read'], 'OWNED_DEF_HOOK_SYSTEM_INNER', child_stop),
            'work/.claude/agents/owned-hook-background.md': definition('owned-hook-background', ['Read'], 'OWNED_DEF_HOOK_SYSTEM_BACKGROUND', child_stop)},
        'settings': {'hooks': global_hooks}, 'scopes': {'parent': 4, 'outer': 2, 'inner': 1, 'background': 1},
        'responses': [
            {'scope': 'parent', 'generation': 1, 'tool': 'Agent', 'input': agent('owned-hook-outer', case='nested-start-background-stop')},
            {'scope': 'outer', 'generation': 1, 'tool': 'Agent', 'input': agent('owned-hook-inner', case='nested-start-background-stop')},
            {'scope': 'inner', 'generation': 1, 'text': 'OWNED_DEF_HOOK_INNER_FINAL'},
            {'scope': 'outer', 'generation': 2, 'text': 'OWNED_DEF_HOOK_OUTER_FINAL'},
            {'scope': 'parent', 'generation': 2, 'tool': 'Agent', 'input': agent('owned-hook-background', True, case='nested-start-background-stop')},
            {'scope': 'background', 'generation': 1, 'wait_for': 'parent generation3 response flushed', 'text': 'OWNED_DEF_HOOK_BACKGROUND_FINAL'},
            {'scope': 'parent', 'generation': 3, 'text': 'OWNED_DEF_HOOK_PARENT_EARLY'},
            {'scope': 'parent', 'generation': 4, 'require': 'task-notification containing OWNED_DEF_HOOK_BACKGROUND_FINAL', 'text': 'OWNED_DEF_HOOK_PARENT_NOTIFIED'}],
        'gate': {'same_mock_loopback_port': True, 'timeout_seconds': 5,
                 'release_after': 'parent generation3 response body/SSE fully written and flushed',
                 'timeout_action': 'record failed gate and bounded terminal child reply; stop phase without retry'},
        'assertions': ['Exactly 3 global Start processes: outer, nested inner, background.',
            'ZERO definition-start-MUST-NOT-RUN processes, including nested Start.',
            'Exactly 3 common Stop processes total; settings+definition deduplicate for each child.',
            'Two foreground child completions and one real async launch; parent early final precedes background final.',
            'Background Stop logs before parent completion-notification request; one notification continuation.',
            'Owning session IDs agree, per-child agent IDs differ; correct root/child transcript payload ownership.',
            'No extra child query from {} hook output; natural CLI/group exit; input file unchanged.'],
        'partial_order_only': ['parent1 < outer1 < inner1 < outer2 < parent2',
            'parent3_response_flushed < background1_response_sent < parent4_notification_request']}
    return {'dedup-once-foreground': foreground, 'nested-start-background-stop': nested}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=REPO / 'artifacts/agent-definition-hooks-differential-prep')
    args = parser.parse_args()
    proof = verify()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    outputs = [output / 'source-preflight.json', output / 'recipes.json', output / 'SUMMARY.json']
    if any(path.exists() for path in outputs):
        raise RuntimeError('Refusing to overwrite static preparation output')
    ast.parse(Path(__file__).read_text())
    outputs[0].write_text(json.dumps(proof, indent=2) + '\n')
    outputs[1].write_text(json.dumps(recipes(), indent=2) + '\n')
    summary = {'prepared_only': True, 'original_executed': False, 'tau_executed': False,
               'fixture_executed': False, 'listener_started': False, 'node_syntax_checked': False,
               'cases': 2, 'expected_messages': 14, 'hard_message_cap': 18, 'max_cli': 2,
               'source_spans': proof['spans'], 'fixture_sha256': digest(REPO / 'scripts/differential/agent_definition_hooks_fixture.cjs'),
               'requires_root_execution_go': True}
    outputs[2].write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
