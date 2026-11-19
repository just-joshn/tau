#!/usr/bin/env python3
"""Inert owned plugin recipes and installed-byte preflight. Neither CLI is run."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256

CASES = ['workflow', 'mcp', 'disabled']
MODEL = 'claude-sonnet-4-6'
PINNED_TARGET = Path('/Users/josh-desktop/.local/share/claude/versions/2.1.326')
ENV = {'CLAUDE_CODE_FORK_SUBAGENT': '0'}
CHILD_MARKER = 'OWNED_AGENT_SYSTEM_READER'
MCP_TOOL = 'mcp__plugin_owned_probe__echo'
PROOFS = {
    'plugins-research/spans.json': (27, {'plugin_enable_identity_lookup', 'plugin_local_root_loader_and_enable', 'plugin_manifest_identity_and_hook_wrapper_schema', 'plugin_hook_wrapper_load'}),
    'plugin-registration-research/spans.json': (18, {'plugin_registration_skills_direct_and_child_scanner', 'plugin_registration_agent_definition', 'plugin_registration_agent_ignored_fields', 'plugin_registration_name_and_metadata_derivation'}),
    'plugin-mcp-research/spans.json': (26, {'plugin_mcp_qualified_dynamic_provenance', 'plugin_mcp_stdio_schema', 'plugin_mcp_actual_discovery_and_merge', 'plugin_mcp_strict_autodiscovery_gate', 'plugin_mcp_skip_flag_exceptions'}),
    'skills-integration/admission-spans.json': (14, {'grant_source_refusal_policy', 'personal_configuration_env', 'local_command_effect_fields_and_grant_getter'}),
    'skills-integration/spans.json': (19, {'skill_automatic_grant_source_gate', 'skill_permission_precedence', 'layer_permission_application', 'tool_scheduler_applies_layers'}),
    'subagents-research/spans.json': (34, {'agent_fork_disable_gate', 'agent_background_default_selection', 'agent_foreground_result', 'agent_child_model_and_effort_selection', 'agent_scope_filter'}),
    'agents-research/spans.json': (68, set()),
}


def direct_source_rows(modules):
    # Complete adjacent declarations/functions or bounded executable expressions.
    specs = [
        ('hook_command_args_timeout_schema', 'chunk-m33vdkhs.js', 'function wg(){', ',n=u({type:T("prompt")'),
        ('hook_event_matcher_schema', 'chunk-m33vdkhs.js', 'xn=m(()=>u({matcher:', 'function s9a('),
        ('cli_plugin_dir_repeatable_option', 'chunk-g7cw7kap.js', '.option("--plugin-dir <path>"', '.addOption(new Rs("--plugin-dir-no-mcp'),
        ('cli_plugin_dir_host_binding', 'chunk-g7cw7kap.js', 'let Ce=tq(go(y.getOptionValue("pluginDir"))', 'let Re='),
        ('cli_plugin_env_host_binding', 'chunk-g7cw7kap.js', 'let me=M$e(eks(),Re);', 'if(B8())'),
        ('inline_plugin_host_accessors', 'chunk-3zn9cw12.js', 'function U3(e){', 'function YFe('),
        ('plugin_env_parser_and_normalization', 'chunk-pttfvptn.js', 'var Swo=', '\nexport{'),
        ('mcp_always_load_connection_join', 'chunk-qzr4qt1r.js', 'function Vds(n){', 'function H('),
        ('mcp_always_load_configuration_projection', 'chunk-j76re4j2.js', 'serverAlwaysLoad:e.config.alwaysLoad===!0,', 'promptOverrides:wt,'),
        ('mcp_always_load_tool_projection', 'chunk-j76re4j2.js', 'alwaysLoad:!B&&(oe&&', ',async description()'),
        ('mcp_always_load_deferral_consumers', 'chunk-qm8c0eq3.js', 'function jX(', 'function T('),
    ]
    rows = []
    for identifier, name, start, end in specs:
        data = (REPO/'artifacts/claude-bundle'/name).read_bytes(); i = data.index(start.encode()); j = data.index(end.encode(), i+len(start.encode())); raw = data[i:j]
        if not 0 < len(raw) <= 4096: raise RuntimeError('Unexpected plugin consumer span bound')
        rows.append({'id': identifier, 'module': name, 'offset': modules[name]['offset']+i, 'length': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'text': raw.decode()})
    return rows


def verify_source():
    modules = {row['name']: row for row in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']}
    groups = {}; all_rows = []
    for relative, (minimum, required) in PROOFS.items():
        path = REPO/'artifacts'/relative; rows = json.loads(path.read_text())
        if not isinstance(rows, list) or len(rows) < minimum or not required <= {row['id'] for row in rows}:
            raise RuntimeError('Incomplete plugin source handshake: ' + relative)
        groups[relative] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'spans': rows}
        all_rows.extend(rows)
    direct_rows = direct_source_rows(modules); all_rows.extend(direct_rows)
    with PINNED_TARGET.open('rb') as target:
        if hashlib.file_digest(target, 'sha256').hexdigest() != TARGET_SHA256: raise RuntimeError('Pinned target differs')
        for name in {row['module'] for row in all_rows}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest() != modules[name]['sha256']: raise RuntimeError('Source module differs')
        for row in all_rows:
            target.seek(row['offset']); raw = target.read(row['length'])
            if hashlib.sha256(raw).hexdigest() != row['sha256'] or raw.decode() != row['text']: raise RuntimeError('Installed source span differs')
    return {'all_equal': True, 'target_sha256': TARGET_SHA256, 'target_source_path': str(PINNED_TARGET), 'groups': groups, 'direct_spans': direct_rows, 'span_count': len(all_rows), 'original_executed': False, 'recovered_code_executed': False}


def recipe(root, node, case):
    """Return owned bytes and argv; only a future approved runner writes/uses them."""
    if case not in CASES: raise ValueError(case)
    plugin = root/'owned-plugin'; fixture = plugin/'fixture.cjs'; log = root/'plugin-lifecycle.jsonl'
    files = {str(plugin/'.claude-plugin/plugin.json'): json.dumps({'name': 'owned'})+'\n',
             str(fixture): (REPO/'scripts/differential/plugin_workflow_fixture.cjs').read_text()}
    if case in ['workflow', 'disabled']:
        files[str(plugin/'skills/prepare/SKILL.md')] = '---\ndescription: Owned plugin preparation fixture\nallowed-tools: Write\n---\nOWNED_PLUGIN_SKILL_BODY\nOWNED_PLUGIN_SKILL_ARGS $ARGUMENTS\nOWNED_PLUGIN_SKILL_ROOT ${CLAUDE_PLUGIN_ROOT}\n'
        files[str(plugin/'agents/reader.md')] = '---\nname: reader\ndescription: Read the owned plugin output\ntools: Read\nmodel: inherit\nmaxTurns: 3\n---\n'+CHILD_MARKER+'\nRead exactly the owned file named by the delegation and return its marker.\n'
        hook = {'type': 'command', 'command': str(node), 'args': ['${CLAUDE_PLUGIN_ROOT}/fixture.cjs', 'hook', str(log), case], 'timeout': 3}
        files[str(plugin/'hooks/hooks.json')] = json.dumps({'hooks': {'PreToolUse': [{'matcher': '^(Write|Read)$', 'hooks': [hook]}]}})+'\n'
    if case in ['mcp', 'disabled']:
        config = {'command': str(node), 'args': ['${CLAUDE_PLUGIN_ROOT}/fixture.cjs', 'mcp', str(log), case], 'alwaysLoad': True}
        files[str(plugin/'.mcp.json')] = json.dumps({'mcpServers': {'probe': config}})+'\n'
    settings = {'enabledPlugins': {'owned@inline': False}} if case == 'disabled' else {}
    tools = '' if case == 'mcp' else 'Skill,Write,Read,Agent'
    allowed = MCP_TOOL if case == 'mcp' else 'Skill(owned:prepare)'
    arguments = ['--print', 'OWNED_PLUGIN_'+case.upper(), '--model', MODEL, '--output-format', 'json', '--tools', tools, '--allowedTools', allowed,
                 '--plugin-dir', str(plugin)]
    return {'files': files, 'settings': settings, 'arguments': arguments, 'environment': ENV, 'plugin_root': str(plugin), 'fixture': str(fixture), 'log': str(log),
            'expected_messages': 6 if case == 'workflow' else 2, 'expected_hook_children': 2 if case == 'workflow' else 0, 'expected_mcp_children': 0 if case == 'workflow' else 1 if case == 'mcp' else 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--output', type=Path, default=REPO/'artifacts/differential-pass/plugins-preparation'); args = parser.parse_args()
    proof = verify_source(); args.output.mkdir(parents=True, exist_ok=True)
    (args.output/'source-preflight.json').write_text(json.dumps(proof, indent=2)+'\n')
    (args.output/'consumer-spans.json').write_text(json.dumps(proof['direct_spans'], indent=2)+'\n')
    (args.output/'consumer-spans.tsv').write_text('id\toffset\tlength\tsha256\n'+''.join(f"{row['id']}\t{row['offset']}\t{row['length']}\t{row['sha256']}\n" for row in proof['direct_spans']))
    recipes = {case: recipe(Path('/private/tmp/OWNED_DISPOSABLE_ROOT'), Path('/private/tmp/OWNED_DISPOSABLE_ROOT/runtime/node'), case) for case in CASES}
    (args.output/'recipes.json').write_text(json.dumps(recipes, indent=2)+'\n')
    print(json.dumps({'installed_byte_spans': proof['span_count'], 'all_equal': proof['all_equal'], 'cases': list(recipes), 'expected_original_messages': 10, 'original_executed': False, 'fixture_executed': False}))


if __name__ == '__main__': main()
