#!/usr/bin/env python3
"""Compare selected owned definition-hook behavior; retain raw wire differences."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256
from run_agent_definition_hooks import CASES, PHASE_CAP, json_outputs, lifecycle_counts, models
from run_plugins import results


def view(path):
    record = json.loads(path.read_text())
    root = record['isolation']['root']
    rows = models(record)

    def normalize(value):
        if isinstance(value, str):
            return value.replace(root, '<ROOT>')
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        return value

    tools = {}
    messages = {}
    controls = {}
    counters = {}
    tool_results = {}
    for row in rows:
        scope = row['scope']
        counters[scope] = counters.get(scope, 0) + 1
        key = scope + '/' + str(counters[scope])
        tools[key] = sorted(tool['name'] for tool in row['body'].get('tools', []))
        messages[key] = normalize(row['body'].get('messages'))
        controls[key] = {key: value for key, value in row['body'].items() if key not in ['system', 'tools', 'messages']}
        tool_results.update(results(row['body']))
    outputs, parsed = json_outputs(record['result']['stdout'])
    responses = {row['scope'] + '/' + str(row['generation']): normalize({'content': row['content'], 'stop_reason': row['stop_reason']}) for row in record['responses']}
    hook_inputs = [row for row in record['hook_log']['rows'] if row.get('event') == 'input']
    hook_actors = {}
    for row in hook_inputs:
        payload = row['input']
        key = row['kind'] + '/' + payload['hook_event_name'] + '/' + payload.get('agent_type', 'main')
        hook_actors[key] = hook_actors.get(key, 0) + 1
    selected = {
        'scope_generations': {key: value for key, value in record['scope_generations'].items() if value},
        'models_by_scope': {scope: [row['body'].get('model') for row in rows if row['scope'] == scope] for scope in counters},
        'toolsets_by_scope_generation': tools,
        'authored_responses': responses,
        'tool_error_flags': {key: bool(value.get('is_error', False)) for key, value in tool_results.items()},
        'hook_counts': lifecycle_counts(record['hook_log']),
        'hook_actors': hook_actors,
        'input_unchanged': record['input_before'].get('sha256') == record['input_after'].get('sha256'),
        'gate_events': record['gate_events'],
        'stdout_protocol_marker': record['result']['stdout'] if record['mode'] in ['readiness', 'bun-readiness'] else None,
        'final_results': [value.get('result') for value in outputs] if parsed else [],
    }
    wire = {
        'messages': messages,
        'systems': [normalize(row['body'].get('system')) for row in rows],
        'controls': controls,
        'tool_orders': [[tool['name'] for tool in row['body'].get('tools', [])] for row in rows],
        'safe_headers': [row['safe_headers'] for row in rows],
        'tool_results': normalize(tool_results),
        'hooks': normalize(record['hook_log']['rows']),
        'outputs': normalize(outputs),
        'stderr': normalize(record['result']['stderr']),
        'archives': normalize(record['archives']),
        'request_order': [row['scope'] for row in rows],
        'lifecycle_snapshots': [row['lifecycle_snapshot'] for row in rows],
    }
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'checks': record['checks'], 'selected': selected, 'wire': wire,
            'audit': {'canaries': len(record['isolation']['checks']), 'passed': record['isolation']['passed'], 'removed': not Path(root).exists(),
                      'source_equal': record['source_preflight']['all_equal'], 'source_spans': record['source_preflight']['spans'],
                      'headroom': record['isolation']['disk_headroom_at_context_start'], 'messages': len(rows),
                      'natural_group_exit': not record['result']['remaining_process_group_killed'], 'groups_clean': not record['cleanup']['remaining_members'],
                      'hook_survivors': record['hook_survivors'], 'mock_halt': record['mock_halt'], 'budget_kills': record['budget_kills'],
                      'original_executed': record['original_executed'], 'port_entrypoint_executed': record['port_entrypoint_executed'],
                      'target_copy': record['isolation'].get('target_copy'), 'runtime': record['runtime'], 'environment': record['environment_overrides']}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--left', type=Path, required=True)
    parser.add_argument('--left-mode', choices=['readiness', 'original'], required=True)
    parser.add_argument('--right', type=Path)
    parser.add_argument('--right-mode', choices=['bun-readiness', 'tau'])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if bool(args.right) != bool(args.right_mode):
        parser.error('--right and --right-mode must be supplied together')
    if args.right and (args.left_mode, args.right_mode) not in [('readiness', 'bun-readiness'), ('original', 'tau')]:
        parser.error('Only readiness/runtime or original/port pairs may be compared')
    if args.output.exists():
        raise RuntimeError('Refusing comparison overwrite')
    pairs = {}
    all_views = []
    by_mode = {}
    for case in CASES:
        left = view(args.left / (args.left_mode + '-' + case + '.json'))
        pair = {'left': left}
        all_views.append(left)
        by_mode.setdefault(args.left_mode, []).append(left)
        if args.right:
            right = view(args.right / (args.right_mode + '-' + case + '.json'))
            all_views.append(right)
            by_mode.setdefault(args.right_mode, []).append(right)
            pair.update(right=right, selected_equal={key: left['selected'][key] == right['selected'][key] for key in left['selected']},
                        wire_difference_fields=[key for key in left['wire'] if left['wire'][key] != right['wire'][key]])
        pairs[case] = pair
    originals = by_mode.get('original', [])
    taus = by_mode.get('tau', [])
    ready = by_mode.get('readiness', []) + by_mode.get('bun-readiness', [])
    audits = {
        'all_case_checks': all(all(value['checks'].values()) for value in all_views),
        'fresh_twenty_canaries': all(value['audit']['passed'] and value['audit']['canaries'] == 20 for value in all_views),
        'contexts_removed': all(value['audit']['removed'] for value in all_views),
        'source_proof_equal': all(value['audit']['source_equal'] and value['audit']['source_spans'] >= 346 for value in all_views),
        'headroom_at_least_one_GiB': all(value['audit']['headroom'] >= 1073741824 for value in all_views),
        'natural_group_exit': all(value['audit']['natural_group_exit'] and value['audit']['groups_clean'] for value in all_views),
        'no_survivors_or_halts': all(not value['audit']['hook_survivors'] and not value['audit']['mock_halt'] and not value['audit']['budget_kills'] for value in all_views),
        'phase_caps': all(len(values) <= 2 and sum(value['audit']['messages'] for value in values) <= PHASE_CAP for values in by_mode.values()),
        'readiness_never_executed_cli': all(not value['audit']['original_executed'] and not value['audit']['port_entrypoint_executed'] and not value['audit']['target_copy'] for value in ready),
        'original_target_pinned': all(value['audit']['target_copy'] and value['audit']['target_copy']['sha256'] == TARGET_SHA256 and value['audit']['target_copy']['distinct_inode'] for value in originals),
        'original_execution_declared': all(value['audit']['original_executed'] and not value['audit']['port_entrypoint_executed'] for value in originals),
        'tau_execution_declared': all(value['audit']['port_entrypoint_executed'] and not value['audit']['original_executed'] for value in taus),
        'one_tau_source_snapshot': not taus or all(value['audit']['runtime'] for value in taus) and len({value['audit']['runtime']['manifest_sha256'] for value in taus}) == 1,
    }
    complete = bool(args.right)
    equal = complete and all(all(pair['selected_equal'].values()) for pair in pairs.values())
    result = {'pairs': pairs, 'audits': audits, 'complete': complete, 'all_selected_equal': equal,
              'scope': 'Owned definition hook command reduction/once, nested Start root scope, foreground/background Stop, and gated parent continuation. Readiness proves authored protocol/runtime isolation only; it is not original or port behavior.',
              'raw_difference_policy': 'Raw capture hashes and normalized wire views are retained. Selected functional equality does not claim prompt, usage, metadata, random ID, timing, transcript encoding, tool ordering or complete wire parity. Concurrent background request ordering is retained but compared through scope/generation, with the actual parent-response flush gate checked separately.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key != 'pairs'}))
    if not all(audits.values()) or complete and not equal:
        raise SystemExit(3)


if __name__ == '__main__':
    main()
