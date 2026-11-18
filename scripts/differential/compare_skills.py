#!/usr/bin/env python3
"""Selected owned Skill observations; raw artifacts retain all wire differences."""
import argparse
import hashlib
import json
from pathlib import Path
import re

CASES = ['pure', 'grant-write', 'deny-skill', 'deny-write', 'slash', 'model', 'ignore-trust', 'resume']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def messages(record):
    return [r for r in record['requests'] if r['path'].split('?')[0] == '/v1/messages']


def markers(value):
    return re.findall(r'OWNED_[A-Z_]+(?:_[12])?', value)


def summarize(path):
    record = json.loads(path.read_text()); requests = messages(record)
    roots = record['isolation']['root']
    def normalized(value):
        return value.replace(roots, '<DISPOSABLE>')
    request_views = []
    unique_results = {}
    for request in requests:
        body = request['body']; layout = []; owned = []; skill_bodies = []; calls = []
        for mi, message in enumerate(body.get('messages', [])):
            content = message.get('content', [])
            if not isinstance(content, list): content = [{'type': 'text', 'text': content}]
            layout.append({'role': message['role'], 'blocks': [b.get('type') for b in content]})
            for bi, block in enumerate(content):
                text = str(block.get('text', block.get('content', '')))
                found = markers(text)
                if found:
                    owned.append({'message': mi, 'role': message['role'], 'block': bi, 'type': block.get('type'), 'markers': found,
                                  'args_alpha_beta': 'OWNED_SKILL_ARGS alpha beta' in text, 'args_hello_user': 'OWNED_SKILL_ARGS hello user' in text})
                if 'OWNED_SKILL_BODY_' in text:
                    skill_bodies.append({'role': message['role'], 'type': block.get('type'), 'markers': found,
                                         'args_alpha_beta': 'OWNED_SKILL_ARGS alpha beta' in text,
                                         'args_hello_user': 'OWNED_SKILL_ARGS hello user' in text,
                                         'preceding_results_in_same_message': [b['tool_use_id'] for b in content[:bi] if b.get('type') == 'tool_result']})
                if block.get('type') == 'tool_use':
                    calls.append({'id': block['id'], 'name': block['name'], 'input': block['input']})
                if block.get('type') == 'tool_result':
                    unique_results[block['tool_use_id']] = {'id': block['tool_use_id'], 'is_error': bool(block.get('is_error')),
                        'content': normalized(text), 'keys': sorted(block),
                        'haiku_identity': 'exact model ID is claude-haiku-4-5-20251001' in text}
        tool_schemas = [{'name': t['name'], 'schema': t.get('input_schema')} for t in body.get('tools', [])]
        request_views.append({'stage': request['stage'], 'model': body.get('model'), 'layout': layout, 'owned': owned, 'skill_bodies': skill_bodies, 'calls': calls,
                              'request_keys': sorted(body), 'request_controls': {k:v for k,v in body.items() if k not in ['messages','system','tools']},
                              'tool_schemas': tool_schemas})
    stages = []
    for stage in record['stages']:
        result = stage['result']; stdout = json.loads(result['stdout']) if result['stdout'].strip() else {}
        stages.append({'exit_code': result['exit_code'], 'timed_out': result['timed_out'], 'output_limited': result['output_limited'],
                       'process_group': stage['cleanup']['process_group'], 'remaining_members': stage['cleanup']['remaining_members'],
                       'result': stdout.get('result'), 'is_error': stdout.get('is_error'), 'stdout_keys': sorted(stdout),
                       'stderr': normalized(result['stderr']), 'request_start': stage['request_start'], 'request_end': stage['request_end']})
    runtime = record.get('runtime')
    safe_runtime = {k: runtime[k] for k in ['node_sha256','compiled_files','packages'] if k in runtime} if runtime else None
    profile = record['isolation']['profile'].replace(roots, '<DISPOSABLE>').replace(record['isolation']['tag'], '<TAG>')
    profile = profile.replace('localhost:' + str(record['isolation']['network_port']), 'localhost:<PORT>')
    return {'artifact': str(path), 'sha256': digest(path), 'case': record['case'], 'executable': record['executable'],
            'request_count': len(requests), 'all_request_count': len(record['requests']), 'stages': stages,
            'models': [r['model'] for r in request_views], 'requests': request_views, 'tool_results': list(unique_results.values()),
            'final_files': record['final_files'], 'skipped_original_flags': record['skipped_original_flags'],
            'isolation': {'passed': record['isolation']['passed'], 'checks': record['isolation']['checks'],
                          'headroom': record['isolation']['disk_headroom_at_context_start'], 'root_removed': not Path(roots).exists(),
                          'profile_normalized_sha256': hashlib.sha256(profile.encode()).hexdigest(),
                          'target_copy': record['isolation'].get('target_copy')},
            'runtime': safe_runtime}


def compare(original, tau):
    checks = {}
    for key in ['request_count','models','final_files']:
        checks[key] = original[key] == tau[key]
    checks['tool_result_errors'] = [(r['id'],r['is_error']) for r in original['tool_results']] == [(r['id'],r['is_error']) for r in tau['tool_results']]
    checks['final_answers'] = [s['result'] for s in original['stages']] == [s['result'] for s in tau['stages']]
    checks['haiku_identity_reminders'] = [r['haiku_identity'] for r in original['tool_results']] == [r['haiku_identity'] for r in tau['tool_results']]
    checks['skill_body_channel_args_and_tool_order'] = [r['skill_bodies'] for r in original['requests']] == [r['skill_bodies'] for r in tau['requests']]
    checks['owned_marker_channels'] = [r['owned'] for r in original['requests']] == [r['owned'] for r in tau['requests']]
    checks['assistant_tool_inputs'] = [r['calls'] for r in original['requests']] == [r['calls'] for r in tau['requests']]
    checks['message_block_layouts'] = [r['layout'] for r in original['requests']] == [r['layout'] for r in tau['requests']]
    checks['request_controls'] = [r['request_controls'] for r in original['requests']] == [r['request_controls'] for r in tau['requests']]
    checks['tool_schemas_and_order'] = [r['tool_schemas'] for r in original['requests']] == [r['tool_schemas'] for r in tau['requests']]
    checks['tool_result_raw_fields'] = original['tool_results'] == tau['tool_results']
    checks['stdout_framing'] = [s['stdout_keys'] for s in original['stages']] == [s['stdout_keys'] for s in tau['stages']]
    return {'checks': checks, 'differences': [k for k,v in checks.items() if not v]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original', type=Path, default=Path('artifacts/differential-pass/skills'))
    parser.add_argument('--tau', type=Path, default=Path('artifacts/differential-pass/skills-tau-before'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); cases = {}; missing = []
    for case in CASES:
        op = args.original / ('original-' + case + '.json'); tp = args.tau / ('tau-' + case + '.json')
        if not op.exists() or not tp.exists(): missing.append(case); continue
        original = summarize(op); tau = summarize(tp)
        cases[case] = {'original': original, 'tau': tau, 'comparison': compare(original,tau)}
    records = [side for c in cases.values() for side in [c['original'],c['tau']]]
    tau_runtimes = {hashlib.sha256(json.dumps(c['tau']['runtime'],sort_keys=True).encode()).hexdigest() for c in cases.values()}
    original_hashes = {c['original']['isolation']['target_copy']['sha256'] for c in cases.values()}
    audits = {'all_eight_cases_present': not missing,
              'contexts_live_canaries_passed': all(r['isolation']['passed'] for r in records),
              'contexts_removed': all(r['isolation']['root_removed'] for r in records),
              'headroom_at_least_1GiB': all(r['isolation']['headroom'] >= 1024**3 for r in records),
              'one_normalized_profile': len({r['isolation']['profile_normalized_sha256'] for r in records}) == 1,
              'one_tau_runtime_manifest': len(tau_runtimes) == 1,
              'one_original_hash_distinct_copies': len(original_hashes) == 1 and all(c['original']['isolation']['target_copy']['distinct_inode'] for c in cases.values()),
              'bounded_successful_cli': all(s['exit_code'] == 0 and not s['timed_out'] and not s['output_limited'] and not s['remaining_members'] for r in records for s in r['stages'])}
    report = {'scope': 'Selected owned Skill cases only. Raw records retain complete requests; this is not broad CLI parity.',
              'response_identity': 'Runner supplies unique response IDs on every generation, avoiding repeated-ID history merge behavior.',
              'normalization': 'Disposable roots, sandbox tags, and exact loopback ports only; raw source bytes remain saved.',
              'missing_cases': missing, 'audits': audits, 'cli_invocations': sum(len(r['stages']) for r in records),
              'messages_requests': sum(r['request_count'] for r in records), 'tau_runtime_manifest_sha256_set': sorted(tau_runtimes),
              'original_sha256_set': sorted(original_hashes), 'cases': cases}
    args.output.parent.mkdir(parents=True,exist_ok=True); args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'missing_cases': missing, 'audits': audits, 'cli_invocations': report['cli_invocations'], 'messages_requests': report['messages_requests'],
                      'differences': {case:c['comparison']['differences'] for case,c in cases.items()}},indent=2))


if __name__ == '__main__': main()
