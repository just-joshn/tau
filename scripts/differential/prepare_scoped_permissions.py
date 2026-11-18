#!/usr/bin/env python3
"""Owned scoped file/Bash recipes and bounded mock. Import never executes a CLI."""
import hashlib
import json
import re
from pathlib import Path

from isolation import REPO, TARGET_SHA256
from prepare_plugins import PINNED_TARGET
from run_agents import AgentMock
from run_agent_definition_hooks import owned_snapshot
from run_plugins import results

MODEL = 'claude-sonnet-4-6'
CASES = ['files', 'bash']
FINAL = 'OWNED_SCOPED_PERMISSION_FINAL'
SELECTED = 'OWNED_SCOPED_SELECTED_BYTES'
BLOCKED = 'OWNED_SCOPED_BLOCKED_BYTES\n'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def locations(root):
    return {name: root/'work'/name for name in ['selected.md', 'bare-only.md', 'ignored.md', 'blocked.md']}


def file_state(root, path):
    value = owned_snapshot(root, path)
    if 'raw_text' in value:
        value['text'] = value.pop('raw_text')
    return value


def snapshot(root):
    return {name: file_state(root, path) for name, path in {
        **locations(root), 'settings': root/'config/settings.json',
    }.items()}


def recipe(root, case):
    if case not in CASES:
        raise ValueError('Unknown scoped permission case')
    settings = {'permissions': {
        'allow': ['Edit(./selected.md)', 'Write(./ignored.md)'],
        'deny': ['Read(./blocked.md)'],
    }} if case == 'files' else {'permissions': {
        'allow': ['Bash(printf:*)'],
        'deny': ['Bash(printf OWNED_SCOPED_DENY:*)'],
        'ask': ['Bash(printf OWNED_SCOPED_ASK:*)'],
    }}
    expected = 6 if case == 'files' else 5
    arguments = ['--print', 'OWNED_SCOPED_PERMISSION_'+case.upper(), '--model', MODEL,
                 '--tools', 'Read,Write,Edit' if case == 'files' else 'Bash',
                 '--permission-mode', 'default', '--output-format', 'json',
                 '--max-turns', str(expected)]
    if case == 'files':
        arguments += ['--allowedTools', 'Edit']
    return {'case': case, 'settings': settings, 'arguments': arguments,
            'expected_messages': expected, 'hard_case_messages': expected+1,
            'expected_tool_calls': expected-1, 'hooks': 0, 'peers': 0,
            'allowed_shell_calls': 0 if case == 'files' else 2,
            'tool_names': ['Read', 'Write', 'Edit'] if case == 'files' else ['Bash'],
            'paths': {name: str(path) for name, path in locations(root).items()}}


def action(root, case, generation):
    paths = locations(root)
    if case == 'files':
        return [
            ('Write', {'file_path': str(paths['selected.md']), 'content': SELECTED}),
            ('Write', {'file_path': str(paths['bare-only.md']), 'content': 'OWNED_MUST_NOT_WRITE_BARE\n'}),
            ('Write', {'file_path': str(paths['ignored.md']), 'content': 'OWNED_MUST_NOT_WRITE_IGNORED\n'}),
            ('Read', {'file_path': str(paths['blocked.md'])}),
            ('Read', {'file_path': str(paths['selected.md'])}),
        ][generation-1] if generation <= 5 else None
    commands = ['printf OWNED_SCOPED_OK', 'printf OWNED_SCOPED_DENY suffix',
                'printf OWNED_SCOPED_ASK suffix', 'printf OWNED_SCOPED_DENYPLUS']
    return ('Bash', {'command': commands[generation-1]}) if generation <= 4 else None


def text_parts(result):
    value = result.get('content') if isinstance(result, dict) else None
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [block['text'] for block in value if isinstance(block, dict)
                and block.get('type') == 'text' and isinstance(block.get('text'), str)]
    return []


def selected_read_payload(result, readiness=False):
    parts = text_parts(result)
    if readiness:
        return parts[0] if len(parts) == 1 else None
    numbered = []
    for text in parts:
        for line in text.splitlines():
            match = re.fullmatch(r'([1-9][0-9]*)(?:\t(.*))?', line)
            if match:
                numbered.append((int(match[1]), match[2] or ''))
    # The authored selected file has exactly one non-newline-terminated line.
    # Reminders/wrappers are retained raw and never compared as file bytes.
    return numbered[0][1] if len(numbered) == 1 and numbered[0][0] == 1 else None


class ScopedPermissionMock(AgentMock):
    def __init__(self, case, readiness=False):
        super().__init__(case)
        self.readiness = readiness
        self.root = None
        self.halt = None
        self.responses = []
        self.generations = {'parent': 0}
        self.on_halt = None

    def scope(self, body):
        return 'parent'

    def response(self, scope, generation):
        plan = recipe(self.root, self.case)
        row = [row for row in self.requests if row['path'].split('?')[0] == '/v1/messages'][generation-1]
        files = snapshot(self.root)
        seen = results(row['body'])
        checks = {'known_model': row['body'].get('model') == MODEL,
                  'bounded_generation': generation <= plan['expected_messages'],
                  'exact_toolset': set(tool.get('name') for tool in row['body'].get('tools', [])) == set(plan['tool_names']),
                  'strong_leaf_guards': all('guard_error' not in value for value in files.values())}
        previous = seen.get('owned-scoped-'+self.case+'-'+str(generation-1))
        if generation > 1:
            checks['previous_tool_result'] = isinstance(previous, dict)
            error = previous.get('is_error', False) if isinstance(previous, dict) else None
            wanted_error = generation in ([3, 4, 5] if self.case == 'files' else [3, 4])
            checks['previous_error_class'] = error == wanted_error
        if self.case == 'files':
            checks['blocked_seed_immutable'] = files['blocked.md'].get('text') == BLOCKED
            checks['blocked_seed_not_in_model_input'] = BLOCKED.strip() not in json.dumps(row['body'])
            checks['no_bare_write'] = not files['bare-only.md']['exists']
            checks['no_ignored_write'] = not files['ignored.md']['exists']
            checks['selected_effect'] = not files['selected.md']['exists'] if generation == 1 else files['selected.md'].get('text') == SELECTED
            if generation == 6:
                checks['read_selected_exact_bytes'] = selected_read_payload(previous, self.readiness) == SELECTED
            if generation >= 5:
                blocked = seen.get('owned-scoped-files-4', {})
                checks['blocked_bytes_not_returned'] = BLOCKED.strip() not in json.dumps(blocked)
        else:
            checks['no_owned_file_effects'] = all(not files[name]['exists'] for name in locations(self.root))
            if generation == 2:
                checks['allowed_stdout_marker'] = 'OWNED_SCOPED_OK' in json.dumps(previous)
            if generation == 5:
                checks['deny_word_boundary_stdout'] = 'OWNED_SCOPED_DENYPLUS' in json.dumps(previous)
        row['file_state'] = files
        row['observation'] = {'checks': checks, 'previous_tool_result': previous}
        if not all(checks.values()):
            self.halt = 'OWNED_SCOPED_ORACLE_FAILURE'
            if self.on_halt:
                self.on_halt()
        chosen = action(self.root, self.case, generation) if generation <= plan['expected_messages'] and not self.halt else None
        content = [{'type': 'tool_use', 'id': 'owned-scoped-'+self.case+'-'+str(generation),
                    'name': chosen[0], 'input': chosen[1]}] if chosen else [{'type': 'text', 'text': self.halt or FINAL}]
        stop = 'tool_use' if chosen else 'end_turn'
        self.responses.append({'generation': generation, 'content': content, 'stop_reason': stop})
        return content, stop


def verify_source():
    required = {
        'permission-rules-research': {'permission_rules_edit_permission_order', 'permission_rules_read_permission_order', 'permission_rules_collection_H'},
        'file-permission-host-research': {'file_permission_host_canonical_Pc', 'file_permission_host_path_ce'},
        'bash-permission-session-research': {'bash_session_prefix_and_security_floor_order', 'bash_session_prepare_match_candidates'},
        'scoped-permissions-research': {'scoped_write_carrier', 'scoped_write_permission_consumer', 'scoped_registry_preserves_identity', 'scoped_whole_tool_identity_match'},
    }
    groups = {}
    spans = []
    for group, ids in required.items():
        path = REPO/'artifacts'/group/'spans.json'
        rows = json.loads(path.read_text())
        if not ids <= {row['id'] for row in rows}:
            raise RuntimeError('Scoped permission source handshake incomplete: '+group)
        groups[group] = {'sha256': digest(path), 'spans': rows}
        spans += rows
    for group, ids in {
        'native-main-capture-research': {'native_main_config_root_env', 'native_main_persistence_flag', 'native_main_persistence_consumer'},
        'workspace-config-research': {'settings_file_paths', 'permission_allow_trust'},
    }.items():
        rows = [row for row in json.loads((REPO/'artifacts'/group/'spans.json').read_text()) if row['id'] in ids]
        if len(rows) != len(ids):
            raise RuntimeError('Scoped settings/config proof incomplete')
        groups[group] = {'spans': rows}
        spans += rows
    compatibility_path = REPO/'artifacts/native-bash-command-preparation-research/compatibility-spans.json'
    compatibility = json.loads(compatibility_path.read_text())
    required_compatibility = {'native_bash_compat_Ng', 'native_bash_compat_joi', 'native_bash_compat_aW', 'native_bash_compat_fYr', 'native_bash_compat_xr'}
    if len(compatibility) < 31 or not required_compatibility <= {row['id'] for row in compatibility}:
        raise RuntimeError('Finite native compatibility source handshake incomplete')
    groups['native-bash-command-preparation-research/compatibility-spans.json'] = {'sha256': digest(compatibility_path), 'spans': compatibility}
    spans += compatibility
    modules = {row['name']: row for row in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']}
    with PINNED_TARGET.open('rb') as target:
        if hashlib.file_digest(target, 'sha256').hexdigest() != TARGET_SHA256:
            raise RuntimeError('Retained326 target changed')
        for name in {row['module'] for row in spans}:
            if digest(REPO/'artifacts/claude-bundle'/name) != modules[name]['sha256']:
                raise RuntimeError('Recovered scoped permission module changed')
        for row in spans:
            target.seek(row['offset'])
            raw = target.read(row['length'])
            if hashlib.sha256(raw).hexdigest() != row['sha256'] or raw.decode() != row['text']:
                raise RuntimeError('Installed scoped permission bytes differ')
    return {'target_sha256': TARGET_SHA256, 'all_equal': True, 'spans': len(spans),
            'groups': groups, 'original_executed': False, 'recovered_code_executed': False}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=REPO/'artifacts/differential-pass/scoped-permissions-preparation')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    names = ['source-preflight.json', 'recipes.json', 'harness-hashes.json']
    if any((output/name).exists() for name in names):
        raise RuntimeError('Refusing scoped preparation overwrite')
    source = verify_source()
    plans = {case: recipe(Path('/private/tmp/OWNED_DISPOSABLE_ROOT'), case) for case in CASES}
    hashes = {name: digest(REPO/'scripts/differential'/name) for name in [
        'prepare_scoped_permissions.py', 'run_scoped_permissions.py', 'compare_scoped_permissions.py',
        'test_scoped_permissions_guards.py', 'isolation.py', 'run_agent_definition_hooks.py',
        'run_child_workflows.py', 'bun_runtime.py', 'node_fixture_runtime.py', 'run_skills.py',
    ]}
    (output/'source-preflight.json').write_text(json.dumps(source, indent=2)+'\n')
    (output/'recipes.json').write_text(json.dumps(plans, indent=2)+'\n')
    (output/'harness-hashes.json').write_text(json.dumps(hashes, indent=2)+'\n')
    print(json.dumps({'source_spans': source['spans'], 'all_equal': source['all_equal'],
        'cases': CASES, 'expected_messages_per_implementation_phase': 11,
        'hard_phase_messages': 13, 'cli_per_phase': 2, 'hooks_or_peer_fixtures': 0,
        'allowed_harmless_shell_calls_per_phase': 2,
        'original_executed': False, 'port_entrypoint_executed': False}))


if __name__ == '__main__':
    main()
