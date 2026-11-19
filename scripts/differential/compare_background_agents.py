#!/usr/bin/env python3
"""Read-only selected comparisons; requires saved original/Tau controls."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from isolation import REPO, TARGET_SHA256
from run_background_agents import CASES, checks, model_rows
from run_plugins import results


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize(record):
    rows = model_rows(record); parent = [r for r in rows if r['scope'] == 'parent']; child = [r for r in rows if r['scope'] == 'child']; output = json.loads(record['stages'][0]['result']['stdout']); background = record['case'] == 'gated-background'
    # Counts and logical scope are stable; concurrent request arrival order is not.
    selected = {'parent_requests': len(parent), 'child_requests': len(child), 'models_by_scope': {scope: [r['body'].get('model') for r in rows if r['scope'] == scope] for scope in ['parent','child']},
                'child_toolsets': [sorted(t['name'] for t in r['body'].get('tools', [])) for r in child], 'input_unchanged': record['input_after'],
                'async_output_exists': bool(record['output_snapshot'].get('exists')), 'canonical_output_owned': record['output_snapshot'].get('canonical_owned'),
                'final_result': output.get('result'), 'parent_usage': {k:output.get('usage',{}).get(k)for k in ['input_tokens','output_tokens']},
                'num_turns': output.get('num_turns'), 'result_index': output.get('result_index'),
                'notification_has_child_marker': bool(background and len(parent) > 2 and 'OWNED_BACKGROUND_CHILD_FINAL' in json.dumps(parent[2]['body'].get('messages'))),
                'output_read_has_child_marker': bool(background and len(parent) > 3 and 'OWNED_BACKGROUND_CHILD_FINAL' in json.dumps(results(parent[3]['body']).get('owned-background-output-read')))}
    notices = []
    if background and len(parent) > 2:
        for row in parent[2]['body'].get('messages', []):
            if row.get('role') != 'user': continue
            for block in row.get('content', []):
                if isinstance(block, dict) and '<task-notification>' in block.get('text', ''): notices.append(block['text'])
    return {'selected': selected, 'assertions': checks(record), 'raw_assertions': record['assertions'],
            'arrival_scopes': [r['scope'] for r in rows], 'timeline': record['timeline'], 'notification_text': notices,
            'request_controls': [{k: r['body'].get(k) for k in ['max_tokens','thinking','output_config','stream']} for r in rows],
            'headers': [r['safe_headers'] for r in rows], 'tool_result_content_types': [{key: type(value.get('content')).__name__ for key,value in results(r['body']).items()} for r in rows],
            'output_snapshot': {k:v for k,v in record['output_snapshot'].items() if k != 'raw_text'},
            'output_contains_child_marker': 'OWNED_BACKGROUND_CHILD_FINAL' in record['output_snapshot'].get('raw_text', ''),
            'native_child_metadata_manifest': record['native_child_metadata_manifest'],
            'tau_child_archive_manifest': {key: {k:value[k] for k in ['bytes','sha256']} for key,value in record['owned_tau_child_archives'].items()},
            'stdout_metadata': {k:v for k,v in output.items() if k not in ['result','session_id']},
            'runtime_compiled_manifest_sha256': hashlib.sha256(json.dumps(record['runtime']['compiled_files'], sort_keys=True).encode()).hexdigest(),
            'notification_usage_numbers': [{'subagent_tokens':re.findall(r'<subagent_tokens>(\d+)</subagent_tokens>',text),'total_tokens':re.findall(r'total_tokens["\s:>]+(\d+)',text)}for text in notices]}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--original', type=Path, default=REPO/'artifacts/differential-pass/background-agents'); parser.add_argument('--tau', type=Path, default=REPO/'artifacts/differential-pass/background-agents-tau-before'); args = parser.parse_args(); pairs = {}; records = []
    for case in CASES:
        p = args.original/('original-'+case+'.json'); q = args.tau/('tau-'+case+'.json'); a = json.loads(p.read_text()); b = json.loads(q.read_text()); records.extend([a,b]); x = summarize(a); y = summarize(b)
        pairs[case] = {'original_raw_sha256': sha(p), 'tau_raw_sha256': sha(q), 'original': x, 'tau': y, 'selected_equal': {k:x['selected'][k] == y['selected'][k] for k in x['selected']},
                       'difference_fields': [k for k in x if k not in ['selected','assertions','raw_assertions'] and x[k] != y[k]]}
    originals = [r for r in records if r['executable'] == 'original']; taus = [r for r in records if r['executable'] == 'tau']
    audits = {'four_fresh_contexts': len({r['isolation']['root'] for r in records}) == 4 and all(r['isolation']['passed'] and len(r['isolation']['checks']) == 20 for r in records),
              'contexts_removed': all(not Path(r['isolation']['root']).exists() for r in records), 'headroom_guard': all(r['isolation']['disk_headroom_at_context_start'] >= 1073741824 for r in records),
              'pinned_original_copies': all(r['target_sha256'] == TARGET_SHA256 and r['isolation']['target_copy']['sha256'] == TARGET_SHA256 and r['isolation']['target_copy']['distinct_inode'] for r in originals),
              'all_source_proofs_pass': all(r['source_preflight']['all_equal'] for r in records), 'no_external_fixture_children': all(r['external_fixture_children_configured'] == 0 for r in records),
              'all_process_groups_clean': all(not r['stages'][0]['cleanup']['remaining_members'] for r in records),
              'within_hard_request_caps': all(sum(len(model_rows(r)) for r in group) <= 11 and len(group) == 2 for group in [originals,taus]),
              'frozen_tau_manifest': len({hashlib.sha256(json.dumps(r['runtime']['compiled_files'], sort_keys=True).encode()).hexdigest() for r in taus}) == 1}
    output = {'pairs': pairs, 'audits': audits, 'scope': 'Two owned local background/disabled controls only; partial-order timing, no full wire or persistence parity claim.',
              'minimum_headroom': min(r['isolation']['disk_headroom_at_context_start'] for r in records)}
    for directory in [args.original,args.tau]: (directory/'comparison.json').write_text(json.dumps(output, indent=2)+'\n')
    good = all(audits.values()) and all(all(p['selected_equal'].values()) and all(p['original']['assertions'].values()) and all(p['tau']['assertions'].values()) for p in pairs.values())
    print(json.dumps({'audits': audits, 'all_selected_equal': all(all(p['selected_equal'].values()) for p in pairs.values()), 'comparison_sha256': sha(args.tau/'comparison.json')}))
    if not good: raise SystemExit(3)


if __name__ == '__main__': main()
