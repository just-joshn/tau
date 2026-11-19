#!/usr/bin/env python3
"""Bounded owned explicit-local-plugin controls; execute only under root go."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import time

from isolation import REPO, TARGET_SHA256, clone_file
from prepare_plugins import CASES, ENV, MODEL, MCP_TOOL, PINNED_TARGET, recipe, verify_source
from run_agents import AgentMock, strings, transcript_manifest, tau_child_archives
from run_hooks import alive
from run_skill_effort import verified_effort_isolation
from run_skills import run_stage
from run_tau import copy_runtime, digest

FILE_TEXT = 'OWNED_PLUGIN_WRITTEN\n'


class PluginMock(AgentMock):
    def response(self, scope, generation):
        action = None
        if scope == 'child' and generation == 1:
            action = ('Read', {'file_path': str(self.file_path)})
        elif scope == 'parent' and generation == 1:
            action = (MCP_TOOL, {'value': 'OWNED_PLUGIN_ECHO_INPUT'}) if self.case == 'mcp' else ('Skill', {'skill': 'owned:prepare', 'args': 'owned plugin argument'})
        elif self.case == 'workflow' and scope == 'parent' and generation == 2:
            action = ('Write', {'file_path': str(self.file_path), 'content': FILE_TEXT})
        elif self.case == 'workflow' and scope == 'parent' and generation == 3:
            action = ('Agent', {'description': 'Read owned plugin result', 'prompt': 'OWNED_PLUGIN_CHILD_REQUEST\nRead exactly once from '+str(self.file_path)+' and return OWNED_PLUGIN_CHILD_FINAL.', 'subagent_type': 'owned:reader', 'run_in_background': False})
        if action:
            return [{'type': 'tool_use', 'id': 'owned-plugin-'+scope+'-'+str(generation), 'name': action[0], 'input': action[1]}], 'tool_use'
        return [{'type': 'text', 'text': 'OWNED_PLUGIN_CHILD_FINAL' if scope == 'child' else 'OWNED_PLUGIN_PARENT_FINAL'}], 'end_turn'


def protocol_probe(isolation, node, fixture, case, mode):
    log = isolation.root/('plugin-'+mode+'-readiness.jsonl'); input_path = isolation.root/('plugin-'+mode+'-readiness-input.jsonl')
    if mode == 'hook':
        requests = [{'hook_event_name': 'PreToolUse', 'tool_name': 'Write', 'tool_input': {'file_path': str(isolation.root/'work/probe.txt'), 'content': 'OWNED_READINESS'}}]
    else:
        requests = [{'jsonrpc': '2.0', 'id': 0, 'method': 'server/discover'},
                    {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'owned-proof', 'version': '1'}}},
                    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                    {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'echo', 'arguments': {'value': 'OWNED_PLUGIN_ECHO_INPUT'}}}]
    input_path.write_text(''.join(json.dumps(row)+'\n' for row in requests))
    shell = 'exec '+shlex.join([str(node), str(fixture), mode, str(log), case])+' < '+shlex.quote(str(input_path))
    result = isolation.sandbox(['/bin/sh', '-c', shell]); outputs = [json.loads(line) for line in result['stdout'].splitlines()]
    logs = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []; pids = {row['pid'] for row in logs}
    valid_output = outputs == [{}] if mode == 'hook' else (len(outputs) == 4 and outputs[2]['result']['tools'][0]['name'] == 'echo' and outputs[3]['result']['content'][0]['text'] == 'OWNED_PLUGIN_ECHO_REPLY')
    if result['exit_code'] != 0 or result['timed_out'] or not valid_output or any(alive(pid) for pid in pids): raise RuntimeError('Copied owned plugin '+mode+' fixture readiness failed; target execution forbidden')
    return {'requests': requests, 'responses': outputs, 'result': result, 'lifecycle': logs, 'pids_finished': True}


def model_requests(record):
    return [row for row in record['requests'] if row['path'].split('?')[0] == '/v1/messages']


def results(body):
    return {block['tool_use_id']: block for message in body.get('messages', []) if message.get('role') == 'user' for block in message.get('content', []) if isinstance(block, dict) and block.get('type') == 'tool_result'}


def assertions(record):
    rows = model_requests(record); case = record['case']; lifecycle = record['lifecycle']; starts = [row for row in lifecycle if row['event'] == 'start']; hook_inputs = [row['input'] for row in lifecycle if row['event'] == 'input']
    checks = {'cli_success': record['stages'][0]['result']['exit_code'] == 0 and not record['stages'][0]['result']['timed_out'],
              'expected_messages': len(rows) == (6 if case == 'workflow' else 2),
              'all_models_explicit': bool(rows) and all(row['body'].get('model') == MODEL for row in rows),
              'no_surviving_children': record['surviving_fixture_pids'] == [],
              'no_remaining_process_group': record['stages'][0]['cleanup']['remaining_members'] == [],
              'expected_fixture_children': len(starts) == (2 if case == 'workflow' else 1 if case == 'mcp' else 0)}
    if case == 'workflow':
        checks.update({'scope_order': [row['scope'] for row in rows] == ['parent', 'parent', 'parent', 'child', 'child', 'parent'],
                       'owned_final_bytes': record['final_file'] == FILE_TEXT,
                       'parent_skill_catalog': 'owned:prepare' in json.dumps(rows[0]['body']),
                       'parent_agent_catalog': 'owned:reader' in json.dumps(rows[0]['body']),
                       'skill_body_and_args': len(rows) > 1 and all(marker in json.dumps(rows[1]['body'].get('messages')) for marker in ['OWNED_PLUGIN_SKILL_BODY', 'owned plugin argument', record['recipe']['plugin_root']]),
                       'child_read_only': len(rows) > 3 and [tool['name'] for tool in rows[3]['body'].get('tools', [])] == ['Read'],
                       'child_read_result': len(rows) > 4 and FILE_TEXT.strip() in json.dumps(results(rows[4]['body']).get('owned-plugin-child-1')),
                       'parent_child_report': len(rows) > 5 and 'OWNED_PLUGIN_CHILD_FINAL' in json.dumps(results(rows[5]['body']).get('owned-plugin-parent-3')),
                       'write_read_hook_order': [row.get('tool_name') for row in hook_inputs] == ['Write', 'Read'],
                       'plugin_hook_roots': len(starts) == 2 and all(row.get('root') == record['recipe']['plugin_root'] for row in starts),
                       'hook_permission_mode': len(hook_inputs) == 2 and all(row.get('permission_mode') == 'default' for row in hook_inputs),
                       'no_mcp_peer': not any(row['mode'] == 'mcp' for row in starts)})
    elif case == 'mcp':
        calls = [row['message'] for row in lifecycle if row['event'] == 'request' and row['message'].get('method') == 'tools/call']
        checks.update({'scope_order': [row['scope'] for row in rows] == ['parent', 'parent'],
                       'qualified_tool_offered_without_search': bool(rows) and MCP_TOOL in [tool['name'] for tool in rows[0]['body'].get('tools', [])],
                       'one_echo_name_and_arguments': len(calls) == 1 and calls[0]['params'].get('name') == 'echo' and calls[0]['params'].get('arguments') == {'value': 'OWNED_PLUGIN_ECHO_INPUT'},
                       'echo_structured_model_result': len(rows) > 1 and 'OWNED_PLUGIN_ECHO_STRUCTURED' in json.dumps(results(rows[1]['body']).get('owned-plugin-parent-1')),
                       'plugin_mcp_root': len(starts) == 1 and starts[0].get('root') == record['recipe']['plugin_root'],
                       'plugin_mcp_data': len(starts) == 1 and starts[0].get('data') == record['expected_data_root'],
                       'no_owned_file': record['final_file'] is None})
    else:
        catalogs = json.dumps(rows[0]['body']) if rows else ''
        messages = json.dumps([row['body'].get('messages', []) for row in rows])
        result = results(rows[1]['body']).get('owned-plugin-parent-1') if len(rows) > 1 else None
        checks.update({'scope_order': [row['scope'] for row in rows] == ['parent', 'parent'],
                       'owned_catalogs_absent': all(marker not in catalogs for marker in ['owned:prepare', 'owned:reader', MCP_TOOL]),
                       'owned_body_absent': 'OWNED_PLUGIN_SKILL_BODY' not in messages,
                       'skill_guard_error': isinstance(result, dict) and result.get('is_error') is True,
                       'no_lifecycle_activity': lifecycle == [], 'no_owned_file': record['final_file'] is None})
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('executable', choices=['original', 'tau']); parser.add_argument('case', choices=CASES); parser.add_argument('--artifacts', type=Path, default=REPO/'artifacts/differential-pass/plugins'); args = parser.parse_args()
    artifacts = args.artifacts.resolve(); stem = args.executable+'-'+args.case
    if (artifacts/(stem+'.json')).exists(): raise RuntimeError('Refusing capture overwrite')
    source = verify_source(); state = PluginMock(args.case)
    with verified_effort_isolation(artifacts, state.handler(), ENV) as isolation:
        node, entry, runtime = copy_runtime(isolation.root); plan = recipe(isolation.root, node, args.case)
        for name, text in plan['files'].items():
            path = Path(name); path.parent.mkdir(parents=True, exist_ok=True)
            if name == plan['fixture']: clone_file(REPO/'scripts/differential/plugin_workflow_fixture.cjs', path)
            else: path.write_text(text)
        if plan['settings']: (isolation.root/'config/settings.json').write_text(json.dumps(plan['settings'])+'\n')
        state.file_path = isolation.root/'work/owned-plugin-output.txt'; fixture = Path(plan['fixture'])
        ready = isolation.sandbox([str(node), str(fixture), 'ready'])
        if ready['exit_code'] != 0 or ready['timed_out'] or ready['stdout'] != 'owned-plugin-workflow-ready': raise RuntimeError('Copied plugin runtime readiness failed')
        probes = {'runtime': ready}
        if args.case in ['workflow', 'disabled']: probes['hook'] = protocol_probe(isolation, node, fixture, args.case, 'hook')
        if args.case in ['mcp', 'disabled']: probes['mcp'] = protocol_probe(isolation, node, fixture, args.case, 'mcp')
        skipped = []; arguments = list(plan['arguments'])
        if args.executable == 'original':
            command = [str(isolation.copy_target(PINNED_TARGET))]; arguments.append('--no-session-persistence')
        else:
            command = [str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(entry)]; skipped.append('--no-session-persistence')
        isolation.report['original_executed'] = args.executable == 'original'; outcome, cleanup = run_stage(isolation, command, arguments)
        log_path = Path(plan['log']); logs = [json.loads(line) for line in log_path.read_text().splitlines()] if log_path.exists() else []; pids = sorted({row['pid'] for row in logs if row['event'] == 'start'})
        deadline = time.monotonic()+2
        while any(alive(pid) for pid in pids) and time.monotonic() < deadline: time.sleep(.05)
        record = {'case': args.case, 'executable': args.executable, 'target_sha256': TARGET_SHA256 if args.executable == 'original' else None, 'source_preflight': source,
                  'isolation': isolation.report, 'runtime': runtime, 'recipe': plan, 'fixture_sha256': digest(fixture), 'readiness_probes': probes, 'requests': state.requests,
                  'response_identity': 'Unique msg_owned_agent_CASE_SCOPE_GENERATION per model response; child scope from owned system marker',
                  'stages': [{'arguments': arguments, 'result': outcome, 'cleanup': cleanup}], 'lifecycle': logs, 'fixture_pids': pids,
                  'surviving_fixture_pids': [pid for pid in pids if alive(pid)], 'scope_generations': state.generations,
                  'final_file': state.file_path.read_text() if state.file_path.exists() else None, 'expected_data_root': str(isolation.root/'config/plugins/data/owned-inline'),
                  'native_child_metadata_manifest': transcript_manifest(isolation.root), 'owned_tau_child_archives': tau_child_archives(isolation.root), 'skipped_original_flags': skipped}
        record['assertions'] = assertions(record)
        (artifacts/(stem+'.json')).write_text(json.dumps(record, indent=2)+'\n')
        for stream in ['stdout', 'stderr']: (artifacts/(stem+'.'+stream+'.txt')).write_text(outcome[stream])
        kernel = subprocess.run(['/usr/bin/log', 'show', '--last', '2m', '--style', 'compact', '--predicate', 'eventMessage CONTAINS "'+isolation.tag+'"'], capture_output=True, text=True, timeout=10)
        (artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case': args.case, 'executable': args.executable, 'messages': len(model_requests(record)), 'scope_generations': state.generations, 'fixture_children': len(pids), 'survivors': record['surviving_fixture_pids'], 'assertions': record['assertions'], 'group_killed': outcome['remaining_process_group_killed']}))
    if not all(record['assertions'].values()): raise SystemExit(3)


if __name__ == '__main__': main()
