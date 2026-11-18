#!/usr/bin/env python3
"""Selected session Skill hook observations with explicit raw-wire differences."""
import argparse
import hashlib
import json
from pathlib import Path
import re

import compare_hooks
from run_skill_hooks import CASES

compare_hooks.MARKER = re.compile(r'OWNED_SKILL_HOOK_CONTEXT_[0-9]+|OWNED_SKILL_PRE_BLOCK_FIRST|OWNED_SESSION_HOOK_BODY|OWNED_SESSION_HOOK_ARGS')


def summarize(path):
    path = path.resolve()
    record = json.loads(path.read_text()); view = compare_hooks.describe(path)
    root = record['isolation']['root']
    view['isolation_readback'] = {'passed': record['isolation']['passed'], 'checks': record['isolation']['checks'],
        'headroom': record['isolation']['disk_headroom_at_context_start'], 'context_removed': not Path(root).exists(),
        'target_copy': record['isolation'].get('target_copy')}
    profile = record['isolation']['profile'].replace(root, '<ROOT>').replace(record['isolation']['tag'], '<TAG>').replace('localhost:'+str(record['isolation']['network_port']), 'localhost:<PORT>')
    view['normalized_profile_sha256'] = hashlib.sha256(profile.encode()).hexdigest()
    inputs = [event for event in record['hook_lifecycle'] if event.get('event') == 'input']
    view['hook_call_ids'] = [event['input'].get('tool_use_id') for event in inputs]
    view['hook_origin_environment'] = [{key:value.replace(root, '<ROOT>') if isinstance(value,str) else value for key,value in event['originEnvironment'].items()} for event in inputs]
    view['hook_exit_codes'] = [event['code'] for event in record['hook_lifecycle'] if event.get('event') == 'exit']
    view['stage_cleanup'] = [stage['cleanup'] for stage in record['stages']]
    view['source_guard_span_hashes'] = {span['id']:span['sha256'] for span in record['source_schema_guard_validation']['spans']}
    view['source_guard_verified'] = len(record['source_schema_guard_validation']['spans']) == 5 and all(span['equal'] for span in record['source_schema_guard_validation']['spans'])
    view['source_recovered_code_executed'] = record['source_schema_guard_validation']['recovered_code_executed']
    return view


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original',type=Path,default=Path('artifacts/differential-pass/skill-hooks'))
    parser.add_argument('--tau',type=Path); parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args(); cases={}; views=[]
    fields = ['generation_requests','model_tool_inputs','tool_errors','hook_events','hook_call_ids','hook_exit_codes','hook_effective_inputs',
              'post_tool_responses','marker_first_request','marker_channels','final_files','hook_process_count','hook_exit_count','survivors',
              'hook_origin_environment','hook_input_keys','request_parameters','tool_result_hashes']
    selected = ['generation_requests','model_tool_inputs','tool_errors','hook_events','hook_call_ids','hook_exit_codes','hook_effective_inputs',
                'post_tool_responses','marker_first_request','marker_channels','final_files','hook_process_count','hook_exit_count','survivors','hook_origin_environment']
    for case in CASES:
        original = summarize(args.original/('original-'+case+'.json')); views.append(original); entry={'original':original}
        if args.tau and (args.tau/('tau-'+case+'.json')).exists():
            tau = summarize(args.tau/('tau-'+case+'.json')); views.append(tau)
            checks = {field:original[field] == tau[field] for field in fields}
            checks['stage_answers'] = [(s['exit'],s['timeout'],s['limited'],s['text']) for s in original['stages']] == [(s['exit'],s['timeout'],s['limited'],s['text']) for s in tau['stages']]
            checks['stdout_framing'] = [s['result_fields'] for s in original['stages']] == [s['result_fields'] for s in tau['stages']]
            entry.update(tau=tau,checks=checks,differences=[key for key,value in checks.items() if not value])
        cases[case]=entry
    complete = all('tau' in entry for entry in cases.values())
    runtime_hashes = sorted({hashlib.sha256(json.dumps(entry['tau']['runtime'],sort_keys=True).encode()).hexdigest() for entry in cases.values() if 'tau' in entry})
    audits = {'all_live_canaries':all(v['isolation_readback']['passed'] for v in views),
              'all_contexts_removed':all(v['isolation_readback']['context_removed'] for v in views),
              'all_headroom_at_least_1GiB':all(v['isolation_readback']['headroom']>=1024**3 for v in views),
              'one_unchanged_normalized_profile':len({v['normalized_profile_sha256'] for v in views})==1,
              'tau_runtime_consistent':not args.tau or len(runtime_hashes)==1,
              'original_cow_copies_verified':all(entry['original']['isolation_readback']['target_copy']['distinct_inode'] and entry['original']['isolation_readback']['target_copy']['sha256']==compare_hooks.TARGET_SHA256 for entry in cases.values()),
              'all_source_guard_byte_verification':all(v['source_guard_verified'] and not v['source_recovered_code_executed'] for v in views),
              'all_cli_bounded_clean':all(not s['timeout'] and not s['limited'] and s['exit']==0 for v in views for s in v['stages']),
              'all_children_finished':all(not v['survivors'] and v['hook_process_count']==v['hook_exit_count'] and all(not s['remaining_members'] for s in v['stage_cleanup']) for v in views)}
    report = {'scope':'Two owned session Skill command-hook cases only; unique response IDs; raw captures retain all wire differences.',
              'complete_pair_set':complete,'selected_comparisons':selected+['stage_answers'],
              'all_selected_comparisons_equal':complete and all(entry['checks'][key] for entry in cases.values() for key in selected+['stage_answers']),
              'audits':audits,'cli_invocations':sum(v['stage_count'] for v in views),'messages_requests':sum(v['generation_requests'] for v in views),
              'hook_children':sum(v['hook_process_count'] for v in views),'tau_runtime_manifest_sha256_set':runtime_hashes,'cases':cases}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:value for key,value in report.items() if key not in ['cases','selected_comparisons']},indent=2))
    for name,entry in cases.items():print(name,entry.get('differences','Tau not recorded'))


if __name__=='__main__':main()
