#!/usr/bin/env python3
"""Observed lifecycle controls, preserving the refuted max-turn fallback prediction."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from isolation import TARGET_SHA256
from run_agents import strings,MODEL
from run_subagent_hooks import CASES,verify_source

MARKERS=['OWNED_SUBAGENT_START_CONTEXT','OWNED_SUBAGENT_START_DIAGNOSTIC','OWNED_SUBAGENT_STOP_CONTEXT','OWNED_FINAL_BLOCK_IGNORED','OWNED_FINAL_CONTEXT_IGNORED','OWNED_FALLBACK_BLOCK_IGNORED','OWNED_FALLBACK_CONTEXT_IGNORED']


def sha(raw):return hashlib.sha256(raw).hexdigest()


def summarize(path):
    record=json.loads(path.read_text());root=record['isolation']['root'];stdout=json.loads(record['stages'][0]['result']['stdout']);session=stdout.get('session_id');requests=[];calls={'parent':{},'child':{}};results={'parent':{},'child':{}}
    for row in record['requests']:
        if row['path'].split('?')[0]!='/v1/messages':continue
        body=row['body'];scope=row['scope'];text='\n'.join(strings({'system':body.get('system'),'messages':body.get('messages')}))
        requests.append({'scope':scope,'model':body.get('model'),'tool_names':[t['name'] for t in body.get('tools',[])],'markers':{marker:marker in text for marker in MARKERS},
            'request_controls':{key:value for key,value in body.items() if key not in ['system','messages','tools']},'safe_headers':row['safe_headers'],'message_layout':[{'role':m['role'],'blocks':[b.get('type') for b in m.get('content',[])] if isinstance(m.get('content'),list) else ['string']} for m in body.get('messages',[])]})
        for message in body.get('messages',[]):
            if not isinstance(message.get('content'),list):continue
            for block in message['content']:
                if block.get('type')=='tool_use':calls[scope][block['id']]={'name':block['name'],'input':json.loads(json.dumps(block['input']).replace(root,'<ROOT>'))}
                if block.get('type')=='tool_result':results[scope][block['tool_use_id']]={'is_error':bool(block.get('is_error')),'raw':json.loads(json.dumps(block).replace(root,'<ROOT>'))}
    inputs=[r for r in record['lifecycle'] if r.get('event')=='input'];by_kind={}
    for row in inputs:
        value=row['input'];view={key:value.get(key) for key in ['hook_event_name','agent_type','permission_mode','effort','stop_hook_active','last_assistant_message','background_tasks','session_crons'] if key in value}
        view.update(keys=sorted(value),session_matches_parent=value.get('session_id')==session,has_agent_id=bool(value.get('agent_id')),has_parent_transcript=bool(value.get('transcript_path')),
                    separate_child_transcript=bool(value.get('agent_transcript_path')) and value.get('agent_transcript_path')!=value.get('transcript_path'),child_transcript_present='agent_transcript_path'in value)
        by_kind.setdefault(row['kind'],[]).append(view)
    stage=record['stages'][0];outcome=stage['result'];profile=record['isolation']['profile'].replace(root,'<ROOT>').replace(record['isolation']['tag'],'<TAG>').replace('localhost:'+str(record['isolation']['network_port']),'localhost:<PORT>');source=record['source_preflight']
    parent_text='\n'.join(strings(results['parent'].get('owned-agent-parent-tool',{}).get('raw',{}).get('content')))
    agent_match=re.search(r'agentId:\s*([A-Za-z0-9_-]+)',parent_text);parent_agent_id=agent_match.group(1) if agent_match else None
    return {'artifact':str(path),'sha256':sha(path.read_bytes()),'request_count':len(requests),'requests':requests,'scopes':[r['scope'] for r in requests],'models':[r['model'] for r in requests],
            'tool_calls':calls,'tool_results':results,'tool_errors':{scope:[r['is_error'] for r in scoped.values()] for scope,scoped in results.items()},'hook_inputs_by_kind':by_kind,
            'raw_hook_inputs':inputs,'raw_start_completion_order':[r['kind'] for r in inputs if r['kind'].startswith('start-')],
            'one_child_identity_matches_report':bool(inputs) and bool(parent_agent_id) and all(row['input'].get('agent_id')==parent_agent_id for row in inputs),
            'hook_semantic_payloads':{kind:[{key:value for key,value in item.items() if key!='keys'} for item in items] for kind,items in by_kind.items()},
            'hook_children':len(record['hook_pids']),'hook_exits_by_kind':{kind:[r['code'] for r in record['lifecycle'] if r.get('event')=='exit' and r['kind']==kind] for kind in ['start-context','start-diagnostic','stop']},
            'hook_survivors':record['surviving_hook_pids'],'owned_file_unchanged':record['owned_file_before']==record['owned_file_after']=='OWNED_AGENT_FILE\n',
            'parent_has_second_final':'OWNED_SUBAGENT_SECOND_FINAL'in parent_text,'parent_partial_max_turn':'1-turn limit'in parent_text or '1-turn' in parent_text or '1-turn' in str(stdout.get('result')),
            'parent_report_tokens':int(m.group(1)) if (m:=re.search(r'subagent_tokens:\s*(\d+)',parent_text)) else None,'parent_report_tool_uses':int(m.group(1)) if (m:=re.search(r'tool_uses:\s*(\d+)',parent_text)) else None,
            'cli':{'exit':outcome['exit_code'],'timeout':outcome['timed_out'],'limited':outcome['output_limited'],'result':stdout.get('result'),'usage':stdout.get('usage'),'modelUsage':stdout.get('modelUsage'),'subagent_stats':stdout.get('subagent_stats'),'stdout_keys':sorted(stdout),'stderr':outcome['stderr'],'group_killed':outcome['remaining_process_group_killed'],'cleanup':stage['cleanup']},
            'source_verified':source['all_equal'] and len(source['lifecycle_spans'])>=52 and not source['recovered_code_executed'],'fixture_probe_passed':record['fixture_runtime_probe']['exit_code']==0 and not record['fixture_runtime_probe']['timed_out'],
            'isolation':{'passed':record['isolation']['passed'],'checks':record['isolation']['checks'],'root_removed':not Path(root).exists(),'headroom':record['isolation']['disk_headroom_at_context_start'],'profile_sha256':sha(profile.encode()),'target_copy':record['isolation'].get('target_copy')},'runtime':record['runtime'],
            'native_metadata_manifest':record['native_child_metadata_manifest'],'owned_tau_child_archives':record['owned_tau_child_archives']}


def assertions(case,view):
    children=[r for r in view['requests'] if r['scope']=='child'];checks={'expected_requests':view['request_count']==(4 if case=='continuation' else 3),
        'scope_order':view['scopes']==(['parent','child','child','parent'] if case=='continuation' else ['parent','child','parent']),
        'exact_model':all(model==MODEL for model in view['models']),'child_read_pool':all(r['tool_names']==['Read'] for r in children),'owned_file_unchanged':view['owned_file_unchanged']}
    if case=='continuation':
        stops=view['hook_inputs_by_kind'].get('stop',[]);starts=view['hook_inputs_by_kind'].get('start-context',[])+view['hook_inputs_by_kind'].get('start-diagnostic',[])
        checks.update(four_hook_children=view['hook_children']==4,expected_exit_codes=view['hook_exits_by_kind']=={'start-context':[0],'start-diagnostic':[2],'stop':[0,0]},
            start_context_projected=all(r['markers']['OWNED_SUBAGENT_START_CONTEXT'] for r in children),start_diagnostic_not_projected=all(not r['markers']['OWNED_SUBAGENT_START_DIAGNOSTIC'] for r in children),
            stop_context_continues=len(children)==2 and not children[0]['markers']['OWNED_SUBAGENT_STOP_CONTEXT'] and children[1]['markers']['OWNED_SUBAGENT_STOP_CONTEXT'],
            final_continue_false_wins=all(not r['markers']['OWNED_FINAL_BLOCK_IGNORED'] and not r['markers']['OWNED_FINAL_CONTEXT_IGNORED'] for r in children) and view['parent_has_second_final'],
            active_false_true=[r.get('stop_hook_active') for r in stops]==[False,True],last_assistant_text=[r.get('last_assistant_message') for r in stops]==['OWNED_SUBAGENT_FIRST_FINAL','OWNED_SUBAGENT_SECOND_FINAL'],
            start_omits_mode_effort_active=all(not any(key in r['keys'] for key in ['permission_mode','effort','stop_hook_active','last_assistant_message','agent_transcript_path']) for r in starts),
            owning_session_transcript=all(r['session_matches_parent'] and r['has_parent_transcript'] for r in starts+stops),separate_child_transcript=all(r['separate_child_transcript'] for r in stops),one_child_identity=view['one_child_identity_matches_report'])
    else:checks.update(normal_max_turn_exit_skips_stop=view['hook_children']==0 and not view['hook_inputs_by_kind'],one_tool_use_reported=view['parent_report_tool_uses']==1)
    return checks


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=Path('artifacts/differential-pass/subagent-hooks'));parser.add_argument('--tau',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();cases={};views=[]
    proof=verify_source();guard=next(r for r in proof['lifecycle_spans'] if r['id']=='subagent_successful_loop_exit_guard')
    selected=['request_count','scopes','models','tool_calls','tool_errors','hook_children','hook_exits_by_kind','owned_file_unchanged','parent_has_second_final','parent_report_tool_uses']
    for case in CASES:
        original=summarize((args.original/('original-'+case+'.json')).resolve());views.append(original);entry={'original':original,'original_corrected_assertions':assertions(case,original)}
        if case=='fallback':
            entry['refuted_initial_prediction']={'expected_hook_children':1,'observed_hook_children':original['hook_children'],'one_fallback_stop_assertion':original['hook_children']==1,'payload_assertions_observable':bool(original['hook_inputs_by_kind']),'status':'refuted: normal max-turn exit reaches unconditional completion guard'}
            entry['observability_note']='There is no second child request to echo the controlled Read response into committed API history. The parent reports one tool use; the original raw report names Read. Absence from committed child history is not evidence that the controlled response omitted it.'
        if args.tau and (args.tau/('tau-'+case+'.json')).exists():
            tau=summarize((args.tau/('tau-'+case+'.json')).resolve());views.append(tau);checks={key:original[key]==tau[key] for key in selected+['hook_inputs_by_kind','hook_semantic_payloads','one_child_identity_matches_report','tool_results','raw_start_completion_order']}
            checks['final_answer']=original['cli']['result']==tau['cli']['result']
            for key in ['usage','modelUsage','subagent_stats','stdout_keys','group_killed']:checks['cli_'+key]=original['cli'][key]==tau['cli'][key]
            for key in ['tool_names','request_controls','safe_headers','message_layout']:checks['request_'+key]=[r[key] for r in original['requests']]==[r[key] for r in tau['requests']]
            entry.update(tau=tau,tau_corrected_assertions=assertions(case,tau),checks=checks,differences=[key for key,value in checks.items() if not value])
        cases[case]=entry
    complete=all('tau'in e for e in cases.values());runtimes={sha(json.dumps(e['tau']['runtime'],sort_keys=True).encode()) for e in cases.values() if 'tau'in e}
    audits={'all_canaries_passed':all(v['isolation']['passed'] for v in views),'all_roots_removed':all(v['isolation']['root_removed'] for v in views),'headroom_at_least_1GiB':all(v['isolation']['headroom']>=1024**3 for v in views),'one_unchanged_profile':len({v['isolation']['profile_sha256'] for v in views})==1,
        'original_cow_copies_verified':all(e['original']['isolation']['target_copy']['distinct_inode'] and e['original']['isolation']['target_copy']['sha256']==TARGET_SHA256 for e in cases.values()),'all_source_and_fixture_verified':all(v['source_verified'] and v['fixture_probe_passed'] for v in views),'one_tau_runtime':not args.tau or len(runtimes)==1,
        'bounded_cli':all(v['cli']['exit']==0 and not v['cli']['timeout'] and not v['cli']['limited'] for v in views),'no_survivors':all(not v['hook_survivors'] and not v['cli']['cleanup']['remaining_members'] for v in views)}
    report={'scope':'Two global synchronous lifecycle controls only; source-derived max-turn fallback hypothesis is explicitly refuted and replaced, without rerunning originals.',
        'correction_guard':guard,'correction_proof_sha256':proof['lifecycle_proof_sha256'],'complete_pair_set':complete,'selected_fields':selected+['final_answer'],
        'all_selected_equal':complete and all(e['checks'][key] for e in cases.values() for key in selected+['final_answer']),
        'all_original_corrected_assertions':all(all(e['original_corrected_assertions'].values()) for e in cases.values()),'all_tau_corrected_assertions':complete and all(all(e['tau_corrected_assertions'].values()) for e in cases.values()),
        'initial_B_fallback_hypothesis_refuted':cases['fallback']['refuted_initial_prediction']['one_fallback_stop_assertion'] is False,
        'audits':audits,'cli_invocations':len(views),'messages_requests':sum(v['request_count'] for v in views),'lifecycle_children':sum(v['hook_children'] for v in views),'tau_runtime_sha256_set':sorted(runtimes),'cases':cases}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({key:value for key,value in report.items() if key not in ['cases','correction_guard','selected_fields']},indent=2))
    for case,e in cases.items():print(case,e.get('differences','Tau not recorded'))


if __name__=='__main__':main()
