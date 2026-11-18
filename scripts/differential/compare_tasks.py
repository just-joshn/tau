#!/usr/bin/env python3
"""Owned native Task control/data comparison, preserving raw wire and disk gaps."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from isolation import TARGET_SHA256
from run_tasks import CASES, MODEL, actions


def sha(raw):return hashlib.sha256(raw).hexdigest()


def rows(snapshot):
    return {item['json']['id']:item['json'] for item in snapshot.values() if isinstance(item.get('json'),dict) and {'id','subject','status'}<=item['json'].keys()}


def summarize(path):
    record=json.loads(path.read_text());root=record['isolation']['root'];requests=[];calls={};results={}
    def normalize(value):
        if isinstance(value,str):return value.replace(root,'<ROOT>')
        if isinstance(value,list):return [normalize(v) for v in value]
        if isinstance(value,dict):return {key:normalize(v) for key,v in value.items()}
        return value
    for request in record['requests']:
        if request['path'].split('?')[0]!='/v1/messages':continue
        body=request['body'];requests.append({'model':body.get('model'),'task_rows':rows(request['task_store_snapshot']),
            'request_controls':{key:value for key,value in body.items() if key not in ['system','messages','tools']},'safe_headers':request['safe_headers'],
            'tool_schemas':[{'name':t['name'],'input_schema':t.get('input_schema')} for t in body.get('tools',[])],
            'message_layout':[{'role':m['role'],'blocks':[b.get('type') for b in m.get('content',[])] if isinstance(m.get('content'),list) else ['string']} for m in body.get('messages',[])]})
        for message in body.get('messages',[]):
            if not isinstance(message.get('content'),list):continue
            for block in message['content']:
                if block.get('type')=='tool_use':calls.setdefault(block['id'],{'name':block['name'],'input':block['input']})
                if block.get('type')=='tool_result':
                    text=normalize(block.get('content'))
                    # Only isolate the known budget annotation; raw remains saved.
                    display=re.sub(r'\n\n<system-reminder>\n<total_tokens>[^<]*</total_tokens>\n</system-reminder>\s*$','',text) if isinstance(text,str) else text
                    results[block['tool_use_id']]={'is_error':bool(block.get('is_error')),'raw':normalize(block),'display_without_budget':display}
    stage=record['stages'][0];outcome=stage['result'];stdout=json.loads(outcome['stdout']);profile=record['isolation']['profile'].replace(root,'<ROOT>').replace(record['isolation']['tag'],'<TAG>').replace('localhost:'+str(record['isolation']['network_port']),'localhost:<PORT>')
    hook_inputs=[row['input'] for row in record['hook_lifecycle'] if row.get('event')=='input']
    source=record['source_preflight'];hookproof=source.get('hook_schema')
    return {'artifact':str(path),'sha256':sha(path.read_bytes()),'request_count':len(requests),'requests':requests,'models':[r['model'] for r in requests],
            'tool_calls':calls,'tool_results':results,'tool_errors':[r['is_error'] for r in results.values()],
            'display_without_budget':[r['display_without_budget'] for r in results.values()],
            'task_rows_by_request':[r['task_rows'] for r in requests],'task_rows_final':rows(record['task_store_final']),'store_file_manifest':record['task_store_final'],
            'hook_semantic_inputs':[{key:value for key,value in row.items() if key.startswith('task_') or key=='hook_event_name'} for row in hook_inputs],
            'hook_input_keys':[sorted(row) for row in hook_inputs],
            'hook_exit_codes':[row['code'] for row in record['hook_lifecycle'] if row.get('event')=='exit'],
            'hook_children':len(record['hook_pids']),'hook_survivors':record['surviving_hook_pids'],
            'cli':{'exit':outcome['exit_code'],'timeout':outcome['timed_out'],'limited':outcome['output_limited'],'result':stdout.get('result'),'stdout_keys':sorted(stdout),'stderr':outcome['stderr'],'cleanup':stage['cleanup']},
            'isolation':{'passed':record['isolation']['passed'],'checks':record['isolation']['checks'],'headroom':record['isolation']['disk_headroom_at_context_start'],
                         'root_removed':not Path(root).exists(),'normalized_profile_sha256':sha(profile.encode()),'target_copy':record['isolation'].get('target_copy')},
            'source_preflight_verified':source['all_equal'] and len(source['spans'])>=25 and not source['recovered_code_executed'] and (hookproof is None or len(hookproof['spans'])==6 and all(r['equal'] for r in hookproof['spans'])),
            'runtime':record['runtime'],'fixture_sha256':record['fixture_sha256'],'environment_overrides':record['environment_overrides']}


def case_assertions(case,view):
    checks={'expected_request_count':view['request_count']==len(actions(case))+1,'all_domain_outcomes_nonerror':not any(view['tool_errors'])}
    final=view['task_rows_final']
    if case=='crud':
        a=final.get('1',{});b=final.get('2',{})
        checks.update(final_two_tasks=set(final)=={'1','2'},cycle_a=a.get('blocks')==['2'] and a.get('blockedBy')==['2'],cycle_b=b.get('blocks')==['1'] and b.get('blockedBy')==['1'],
                      metadata_null_removed=a.get('metadata')=={'keep':'initial','counter':2,'added':True,'nonmonotone':True},
                      status_nonmonotone=[view['task_rows_by_request'][index].get('1',{}).get('status') for index in [4,6,7]]==['in_progress','completed','pending'])
    elif case=='missing':checks['missing_store_empty']=not final and all(not r for r in view['task_rows_by_request'])
    else:
        original={'id':'1','subject':'OWNED_TASK_ALPHA','description':'OWNED_TASK_ALPHA_DESCRIPTION','activeForm':'Owned alpha active','status':'pending','blocks':[],'blockedBy':[],'metadata':{'keep':'initial','remove':'keep-through-block','counter':1}}
        checks['full_block_rollback']=view['task_rows_by_request'][2].get('1')==original
        expected={**original,'status':'completed','metadata':{**original['metadata'],'passed':True}}
        checks['success_after_block']=final=={'1':expected}
        checks['hook_failure_then_success']=view['hook_exit_codes']==[2,0] and view['hook_children']==2
    return checks


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=Path('artifacts/differential-pass/tasks'));parser.add_argument('--tau',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();cases={};views=[]
    selected=['request_count','models','tool_calls','tool_errors','task_rows_by_request','task_rows_final','hook_semantic_inputs','hook_exit_codes','hook_children','hook_survivors']
    wire=['display_without_budget','tool_results','store_file_manifest','hook_input_keys']
    for case in CASES:
        original=summarize((args.original/('original-'+case+'.json')).resolve());views.append(original);entry={'original':original,'original_case_assertions':case_assertions(case,original)}
        if args.tau and (args.tau/('tau-'+case+'.json')).exists():
            tau=summarize((args.tau/('tau-'+case+'.json')).resolve());views.append(tau);checks={key:original[key]==tau[key] for key in selected+wire}
            checks['final_answer']=original['cli']['result']==tau['cli']['result'];checks['stdout_framing']=original['cli']['stdout_keys']==tau['cli']['stdout_keys']
            for key in ['request_controls','safe_headers','tool_schemas','message_layout']:checks[key]=[r[key] for r in original['requests']]==[r[key] for r in tau['requests']]
            entry.update(tau=tau,tau_case_assertions=case_assertions(case,tau),checks=checks,differences=[key for key,value in checks.items() if not value])
        cases[case]=entry
    complete=all('tau'in e for e in cases.values());runtimes={sha(json.dumps(e['tau']['runtime'],sort_keys=True).encode()) for e in cases.values() if 'tau'in e}
    audits={'all_canaries_passed':all(v['isolation']['passed'] for v in views),'all_contexts_removed':all(v['isolation']['root_removed'] for v in views),
            'headroom_at_least_1GiB':all(v['isolation']['headroom']>=1024**3 for v in views),'one_unchanged_profile':len({v['isolation']['normalized_profile_sha256'] for v in views})==1,
            'original_cow_copies_verified':all(e['original']['isolation']['target_copy']['distinct_inode'] and e['original']['isolation']['target_copy']['sha256']==TARGET_SHA256 for e in cases.values()),
            'all_source_preflight_verified':all(v['source_preflight_verified'] for v in views),'one_tau_runtime':not args.tau or len(runtimes)==1,
            'fixed_known_model':all(all(m==MODEL for m in v['models']) for v in views),
            'cli_bounded_clean':all(v['cli']['exit']==0 and not v['cli']['timeout'] and not v['cli']['limited'] and not v['cli']['cleanup']['remaining_members'] for v in views),
            'hook_children_clean':all(not v['hook_survivors'] and len(v['hook_exit_codes'])==v['hook_children'] for v in views)}
    report={'scope':'Three owned native Task CRUD/missing/completion-hook cases only. Unique response IDs; raw wire and disk differences retained.',
            'normalization':'Disposable roots only; display_without_budget additionally removes the explicit token-budget suffix and raw tool_results remain retained.',
            'complete_pair_set':complete,'selected_fields':selected+['final_answer'],'all_selected_equal':complete and all(e['checks'][field] for e in cases.values() for field in selected+['final_answer']),
            'all_original_case_assertions':all(all(e['original_case_assertions'].values()) for e in cases.values()),
            'all_tau_case_assertions':complete and all(all(e['tau_case_assertions'].values()) for e in cases.values()),
            'audits':audits,'cli_invocations':len(views),'messages_requests':sum(v['request_count'] for v in views),'hook_children':sum(v['hook_children'] for v in views),'tau_runtime_sha256_set':sorted(runtimes),'cases':cases}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({key:value for key,value in report.items() if key not in ['cases','selected_fields']},indent=2))
    for case,e in cases.items():print(case,e.get('differences','Tau not recorded'))


if __name__=='__main__':main()
