#!/usr/bin/env python3
"""Read-only selected plugin comparisons; original captures remain immutable."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256
from prepare_plugins import CASES, MCP_TOOL
from run_plugins import assertions, model_requests, results


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def channels(body, marker):
    found = []
    for i, tool in enumerate(body.get('tools', [])):
        if marker in json.dumps(tool): found.append(['tools', i])
    for i, row in enumerate(body.get('messages', [])):
        if row.get('role') != 'user': continue
        for j, block in enumerate(row.get('content', [])):
            if marker in json.dumps(block): found.append(['messages', i, 'content', j])
    return found


def summarize(record):
    rows = model_requests(record); first = rows[0]['body']; calls = [row['message'] for row in record['lifecycle'] if row['event'] == 'request' and row['message'].get('method') == 'tools/call']
    hook_inputs = [row['input'] for row in record['lifecycle'] if row['event'] == 'input']; answer = json.loads(record['stages'][0]['result']['stdout']).get('result')
    selected = {'scopes': [row['scope'] for row in rows], 'models': [row['body'].get('model') for row in rows], 'file': record['final_file'],
                'hook_tools': [row.get('tool_name') for row in hook_inputs], 'hook_modes': [row.get('permission_mode') for row in hook_inputs],
                'fixture_children': len(record['fixture_pids']), 'owned_catalog_presence': {marker: bool(channels(first, marker)) for marker in ['owned:reader', 'owned:prepare', MCP_TOOL]},
                'final_answer': answer, 'mcp_name_and_arguments': [{'name': row['params'].get('name'), 'arguments': row['params'].get('arguments')} for row in calls]}
    projection = []
    for i, row in enumerate(rows):
        for identifier, result in results(row['body']).items():
            content = result.get('content'); text = json.dumps(content)
            projection.append({'request': i, 'id': identifier, 'content_type': type(content).__name__, 'block_types': [block.get('type') for block in content if isinstance(block, dict)] if isinstance(content, list) else None,
                               'is_error': result.get('is_error', False), 'owned_echo_text': 'OWNED_PLUGIN_ECHO_REPLY' in text, 'owned_echo_structured': 'OWNED_PLUGIN_ECHO_STRUCTURED' in text,
                               'content_sha256': hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()})
    final_result = results(rows[-1]['body']).get('owned-plugin-parent-1', {})
    selected['final_skill_guard_error'] = final_result.get('is_error', False) if record['case'] == 'disabled' else None
    selected['echo_structured_visible'] = any(row['owned_echo_structured'] for row in projection) if record['case'] == 'mcp' else None
    selected['child_tool_names'] = [[tool['name'] for tool in row['body'].get('tools', [])] for row in rows if row['scope'] == 'child']
    return {'selected': selected, 'derived_assertions': assertions(record), 'raw_assertions': record['assertions'],
            'catalog_channels': {marker: channels(first, marker) for marker in ['owned:reader', 'owned:prepare', MCP_TOOL]},
            'first_user_block_types': [[block.get('type') for block in message.get('content', []) if isinstance(block, dict)] for message in first.get('messages', []) if message.get('role') == 'user'],
            'all_tool_orders': [[tool['name'] for tool in row['body'].get('tools', [])] for row in rows], 'mcp_call_meta': [row['params'].get('_meta') for row in calls],
            'mcp_rpc_methods': [row['message'].get('method') for row in record['lifecycle'] if row['event'] == 'request'],
            'lifecycle_order': [{'mode': row['mode'], 'event': row['event'], **({'code': row['code']} if 'code' in row else {})} for row in record['lifecycle'] if row['event'] not in ['request', 'response', 'input']],
            'tool_result_projection': projection, 'headers': [row.get('safe_headers') for row in rows],
            'request_controls': [{key: row['body'].get(key) for key in ['max_tokens', 'thinking', 'output_config', 'stream']} for row in rows],
            'group_killed': record['stages'][0]['result']['remaining_process_group_killed'], 'native_child_metadata_manifest': record['native_child_metadata_manifest'],
            'tau_child_archive_manifest': {key: {field: value[field] for field in ['bytes', 'sha256']} for key, value in record['owned_tau_child_archives'].items()},
            'count_token_requests': sum(row['path'].split('?')[0] == '/v1/messages/count_tokens' for row in record['requests']),
            'source_preflight_sha256': hashlib.sha256(json.dumps(record['source_preflight'], sort_keys=True).encode()).hexdigest(),
            'runtime_compiled_manifest_sha256': hashlib.sha256(json.dumps(record['runtime']['compiled_files'], sort_keys=True).encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--original', type=Path, default=REPO/'artifacts/differential-pass/plugins'); parser.add_argument('--tau', type=Path, default=REPO/'artifacts/differential-pass/plugins-tau-before'); args = parser.parse_args()
    pairs = {}; records = []
    for case in CASES:
        p = args.original/('original-'+case+'.json'); q = args.tau/('tau-'+case+'.json'); original = json.loads(p.read_text()); tau = json.loads(q.read_text()); records.extend([original, tau])
        a = summarize(original); b = summarize(tau)
        pairs[case] = {'original_raw_sha256': sha(p), 'tau_raw_sha256': sha(q), 'original': a, 'tau': b, 'selected_equal': {key: a['selected'][key] == b['selected'][key] for key in a['selected']},
                       'difference_fields': [key for key in a if key not in ['selected', 'raw_assertions', 'derived_assertions'] and a[key] != b[key]]}
    originals = [r for r in records if r['executable'] == 'original']; taus = [r for r in records if r['executable'] == 'tau']
    audit = {'six_fresh_verified_contexts': len({r['isolation']['root'] for r in records}) == 6 and all(r['isolation']['passed'] and len(r['isolation']['checks']) == 20 for r in records),
             'all_contexts_removed': all(not Path(r['isolation']['root']).exists() for r in records),
             'headroom_guard': all(r['isolation']['disk_headroom_at_context_start'] >= 1073741824 for r in records),
             'pinned_original_clones': all(r['target_sha256'] == TARGET_SHA256 and r['isolation']['target_copy']['sha256'] == TARGET_SHA256 and r['isolation']['target_copy']['distinct_inode'] for r in originals),
             'all_static_proofs_match': all(r['source_preflight']['all_equal'] for r in records),
             'all_child_cleanup': all(not r['surviving_fixture_pids'] and not r['stages'][0]['cleanup']['remaining_members'] for r in records),
             'within_request_budget': all(sum(len(model_requests(r)) for r in group) == 10 for group in [originals, taus]),
             'within_child_budget': all(sum(len(r['fixture_pids']) for r in group) == 3 for group in [originals, taus]),
             'frozen_tau_compiled_manifest': len({hashlib.sha256(json.dumps(r['runtime']['compiled_files'], sort_keys=True).encode()).hexdigest() for r in taus}) == 1}
    output = {'pairs': pairs, 'audits': audit, 'minimum_headroom': min(r['isolation']['disk_headroom_at_context_start'] for r in records),
              'totals': {'original_messages': 10, 'tau_messages': 10, 'cli_invocations': 6, 'fixture_processes': 6},
              'raw_oracle_corrections': {'workflow': 'Tool-description catalog expectation false; original owns catalogs in first user text attachments. Raw flags retained.',
                                         'mcp': 'Exact params omitted native _meta; model text expectation ignored structuredContent precedence. Raw flags retained.'},
              'pinned_symlink_drift': 'Installed symlink moved externally to2.1.327 between workflow and remaining originals. No mismatch execution; remaining copies/preflights use retained exact2.1.326 path.',
              'scope': 'Selected three owned local-plugin workflows only; no whole-wire or entire catalog parity claim.'}
    for directory in [args.original, args.tau]: (directory/'comparison.json').write_text(json.dumps(output, indent=2)+'\n')
    good = all(audit.values()) and all(all(pair['selected_equal'].values()) and all(pair['original']['derived_assertions'].values()) and all(pair['tau']['derived_assertions'].values()) for pair in pairs.values())
    print(json.dumps({'all_selected_equal': all(all(pair['selected_equal'].values()) for pair in pairs.values()), 'all_corrected_assertions': all(all(pair[side]['derived_assertions'].values()) for pair in pairs.values() for side in ['original', 'tau']), 'audits': audit, 'comparison_sha256': sha(args.tau/'comparison.json'), 'differences': {case: pair['difference_fields'] for case, pair in pairs.items()}}))
    if not good: raise SystemExit(3)


if __name__ == '__main__': main()
