#!/usr/bin/env python3
"""Read retained scoped controls; never execute either CLI or normalize away failures."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256
from prepare_scoped_permissions import CASES, selected_read_payload, text_parts
from run_scoped_permissions import models, PHASE_CAP
from run_plugins import results


def view(path):
    record = json.loads(path.read_text())
    rows = models(record)
    root = record['isolation']['root']
    def normalize(value):
        if isinstance(value, str):
            return value.replace(root, '<ROOT>')
        if isinstance(value, list):
            return [normalize(child) for child in value]
        if isinstance(value, dict):
            return {key: normalize(child) for key, child in value.items()}
        return value
    tool_results = {}
    for row in rows:
        tool_results.update(results(row['body']))
    output = json.loads(record['result']['stdout'])
    def files(snapshot):
        return {name: {key: value.get(key) for key in ['exists', 'text', 'sha256']}
                for name, value in snapshot.items() if name != 'settings'}
    read = tool_results.get('owned-scoped-files-5')
    selected = {
        'message_count': len(rows),
        'models': [row['body'].get('model') for row in rows],
        'toolsets': [sorted(tool['name'] for tool in row['body'].get('tools', [])) for row in rows],
        'requested_tools': [block['name'] for response in record['mock_responses']
                            for block in response['content'] if block.get('type') == 'tool_use'],
        'tool_error_flags': {key: bool(value.get('is_error')) for key, value in tool_results.items()},
        'file_bytes_by_request': [files(row['file_state']) for row in rows],
        'final_file_bytes': files(record['files_after']),
        'effect_oracles': [row['observation']['checks'] for row in rows],
        'selected_read_bytes': selected_read_payload(read) if read else None,
        'command_markers': {key: [marker for marker in ['OWNED_SCOPED_OK', 'OWNED_SCOPED_DENYPLUS']
                                  if marker in '\n'.join(text_parts(value))]
                            for key, value in tool_results.items() if key.startswith('owned-scoped-bash-')},
        'final_text': output.get('result'),
        'query_usage': {key: output.get('usage', {}).get(key) for key in ['input_tokens', 'output_tokens']},
        'turns': output.get('num_turns'),
        'exit_code': record['result']['exit_code'],
    }
    return {
        'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'checks': record['checks'], 'selected': selected,
        'wire': {
            'messages': [normalize(row['body'].get('messages')) for row in rows],
            'system': [normalize(row['body'].get('system')) for row in rows],
            'tools': [row['body'].get('tools') for row in rows],
            'controls': [{key: value for key, value in row['body'].items()
                          if key not in ['messages', 'system', 'tools']} for row in rows],
            'headers': [row['safe_headers'] for row in rows],
            'tool_results': normalize(tool_results),
            'output': normalize(output), 'stderr': normalize(record['result']['stderr']),
            'archives': normalize(record['archives']), 'native_records': normalize(record['native_records']),
            'owned_metadata': normalize(record['state_after']),
        },
        'audit': {
            'passed': record['isolation']['passed'], 'canaries': len(record['isolation']['checks']),
            'headroom': record['isolation']['disk_headroom_at_context_start'],
            'removed': record['disposable_root_removed'] and not Path(root).exists(),
            'source_equal': record['source_preflight']['all_equal'],
            'source_before': record['target_sha256_before'], 'source_after': record['target_sha256_after'],
            'group_clean': not record['cleanup']['remaining_members'],
            'no_oracle_kill': not record['budget_kills'],
            'target_copy': record['isolation'].get('target_copy'),
            'port_runtime': record['port_runtime'],
            'messages': len(rows), 'hooks': record['recipe']['hooks'], 'peers': record['recipe']['peers'],
            'runner_sha256': record['runner_sha256'], 'harness_hashes': record['harness_hashes'],
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original', type=Path, required=True)
    parser.add_argument('--tau', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError('Refusing scoped comparison overwrite')
    pairs = {}
    views = []
    for case in CASES:
        original = view(args.original/('original-'+case+'.json'))
        pair = {'original': original}
        views.append(original)
        if args.tau:
            tau = view(args.tau/('tau-'+case+'.json'))
            pair.update(tau=tau,
                selected_equal={key: value == tau['selected'][key] for key, value in original['selected'].items()},
                wire_difference_fields=[key for key, value in original['wire'].items() if value != tau['wire'][key]])
            views.append(tau)
        pairs[case] = pair
    originals = [pair['original'] for pair in pairs.values()]
    taus = [pair['tau'] for pair in pairs.values() if 'tau' in pair]
    manifests = {view['audit']['port_runtime']['manifest_sha256'] for view in taus if view['audit']['port_runtime']}
    harnesses = {json.dumps(view['audit']['harness_hashes'], sort_keys=True) for view in views}
    audits = {
        'all_case_checks': all(all(view['checks'].values()) for view in views),
        'fresh_twenty_canaries': all(view['audit']['passed'] and view['audit']['canaries'] == 20 for view in views),
        'contexts_removed': all(view['audit']['removed'] for view in views),
        'headroom_guard': all(view['audit']['headroom'] >= 1073741824 for view in views),
        'source_proofs': all(view['audit']['source_equal'] and view['audit']['source_before'] ==
                             view['audit']['source_after'] == TARGET_SHA256 for view in views),
        'groups_clean': all(view['audit']['group_clean'] and view['audit']['no_oracle_kill'] for view in views),
        'original_pinned': all(view['audit']['target_copy']['sha256'] == TARGET_SHA256 and
                              view['audit']['target_copy']['distinct_inode'] for view in originals),
        'phase_request_and_cli_caps': len(originals) <= 2 and len(taus) <= 2 and
            sum(view['audit']['messages'] for view in originals) <= PHASE_CAP and
            sum(view['audit']['messages'] for view in taus) <= PHASE_CAP,
        'no_hook_or_peer_fixtures': all(view['audit']['hooks'] == view['audit']['peers'] == 0 for view in views),
        'one_port_snapshot': not taus or len(manifests) == 1 and all(view['audit']['port_runtime'] for view in taus),
        'one_harness_snapshot': len(harnesses) == 1,
    }
    output = {
        'pairs': pairs, 'audits': audits, 'complete': len(taus) == len(CASES),
        'all_selected_equal': len(taus) == len(CASES) and
            all(all(pair['selected_equal'].values()) for pair in pairs.values()),
        'selected_fields_per_case': len(originals[0]['selected']),
        'normalization': 'Only owned disposable root strings are replaced in retained wire views. Raw captures and hashes remain unchanged. File bytes and tool error flags are exact selections; no failed oracle is dropped.',
        'scope': 'Ordinary local default POSIX scoped file/Edit/Read and fixed literal printf commands. Does not establish full schemas/wire/framing, safety AST/sandbox, remote/CodeMode/auto/Plan, shell wrappers, native persistence or complete product parity.',
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2)+'\n')
    print(json.dumps({key: value for key, value in output.items() if key != 'pairs'}))
    if not all(audits.values()) or taus and not output['all_selected_equal']:
        raise SystemExit(3)


if __name__ == '__main__':
    main()
