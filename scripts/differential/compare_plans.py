#!/usr/bin/env python3
"""Owned Plan lifecycle/approval comparison with explicit cleanup/wire caveats."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from isolation import TARGET_SHA256
from run_plans import CASES


def sha(raw):return hashlib.sha256(raw).hexdigest()


def summarize(path):
    record=json.loads(path.read_text());root=record['isolation']['root'];designated=record['designated_plan'];name=Path(designated).name if designated else None
    def normalize(value):
        if isinstance(value,str):return value.replace(designated,'<PLAN_FILE>').replace(root,'<ROOT>') if designated else value.replace(root,'<ROOT>')
        if isinstance(value,list):return [normalize(v) for v in value]
        if isinstance(value,dict):return {('<PLAN_FILE>' if key==name else key):normalize(v) for key,v in value.items()}
        return value
    requests=[];calls={};results={}
    for request in record['requests']:
        if request['path'].split('?')[0]!='/v1/messages':continue
        body=request['body'];requests.append({'model':body.get('model'),'plans':normalize(request['plan_snapshot']),
            'tool_names':[t['name'] for t in body.get('tools',[])],'tool_schemas':body.get('tools',[]),
            'request_controls':{key:value for key,value in body.items() if key not in ['system','messages','tools']},'safe_headers':request['safe_headers'],
            'message_layout':[{'role':m['role'],'blocks':[b.get('type') for b in m.get('content',[])] if isinstance(m.get('content'),list) else ['string']} for m in body.get('messages',[])]})
        for message in body.get('messages',[]):
            if not isinstance(message.get('content'),list):continue
            for block in message['content']:
                if block.get('type')=='tool_use':calls[block['id']]={'name':block['name'],'input':normalize(block['input'])}
                if block.get('type')=='tool_result':results[block['tool_use_id']]={'is_error':bool(block.get('is_error')),'raw':normalize(block)}
    mcp_requests=[row['message'] for row in record['mcp_lifecycle'] if row.get('event')=='request']
    approvals=[normalize(row['params']['arguments']) for row in mcp_requests if row.get('method')=='tools/call']
    decisions=[normalize(row) for row in record['mcp_lifecycle'] if row.get('event')=='decision']
    for row in decisions:row.pop('pid',None)
    stage=record['stages'][0];outcome=stage['result'];stdout=json.loads(outcome['stdout']);profile=record['isolation']['profile'].replace(root,'<ROOT>').replace(record['isolation']['tag'],'<TAG>').replace('localhost:'+str(record['isolation']['network_port']),'localhost:<PORT>')
    return {'artifact':str(path),'sha256':sha(path.read_bytes()),'request_count':len(requests),'all_http_requests':len(record['requests']),'requests':requests,
            'models':[r['model'] for r in requests],'tool_calls':calls,'tool_names':[r['name'] for r in calls.values()],'tool_errors':[r['is_error'] for r in results.values()],
            'tool_results':results,'exit_model_inputs':[r['input'] for r in calls.values() if r['name']=='ExitPlanMode'],
            'approval_inputs':approvals,'decisions':decisions,'plans_by_request':[r['plans'] for r in requests],'final_plans':normalize(record['final_plans']),
            'raw_slug':Path(name).stem if name else None,'main_path_in_owned_directory':bool(designated and Path(designated).parent==Path(root)/'work/owned-plans'),
            'valid_main_slug_shape':bool(name and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*\.md',name) and len(name[:-3])<=100 and '-agent-'not in name),
            'slug_family_scope':'Only main filename exercised at runtime; slug-agent-*.md eligibility is static source evidence.',
            'halt':record['halt'],'mcp_main_process_count':len(record['mcp_pids']),'mcp_survivors':record['surviving_mcp_pids'],
            'mcp_exit_events':[{key:value for key,value in row.items() if key!='pid'} for row in record['mcp_lifecycle'] if row.get('event') in ['exit','stdin-close','signal']],
            'cli':{'exit':outcome['exit_code'],'timeout':outcome['timed_out'],'limited':outcome['output_limited'],'result':stdout.get('result'),'stdout_keys':sorted(stdout),'stderr':outcome['stderr'],
                   'remaining_group_killed':outcome['remaining_process_group_killed'],'cleanup':stage['cleanup']},
            'fixture_probe_passed':record['fixture_protocol_probe']['pids_finished'] and record['fixture_protocol_probe']['result']['exit_code']==0 and not record['fixture_protocol_probe']['result']['timed_out'],
            'fixture_sha256':record['fixture_sha256'],'source_preflight_verified':record['source_preflight']['all_equal'] and len(record['source_preflight']['bridge_spans'])>=16 and len(record['source_preflight']['plan_spans'])>=22 and not record['source_preflight']['recovered_code_executed'],
            'isolation':{'passed':record['isolation']['passed'],'checks':record['isolation']['checks'],'root_removed':not Path(root).exists(),'headroom':record['isolation']['disk_headroom_at_context_start'],
                         'profile_sha256':sha(profile.encode()),'target_copy':record['isolation'].get('target_copy')},'runtime':record['runtime']}


def case_assertions(case,view):
    expected_errors=[False,False,False,False,False,True] if case=='approve' else [False,False,False,False,True,False,False,True]
    expected_decisions=['allow'] if case=='approve' else ['deny','allow']
    plans=view['final_plans'];final=plans.get('<PLAN_FILE>',{})
    expected_names=['EnterPlanMode','Write','Read','Edit','ExitPlanMode']+(['Read','ExitPlanMode'] if case=='reject' else [])+['ExitPlanMode']
    checks={'expected_requests':view['request_count']==(7 if case=='approve' else 9),'no_halt':view['halt'] is None,
            'expected_tool_sequence':view['tool_names']==expected_names,'expected_error_pattern':view['tool_errors']==expected_errors,
            'owned_valid_main_path':view['main_path_in_owned_directory'] and view['valid_main_slug_shape'],
            'exact_final_plan':len(plans)==1 and final.get('text')=='OWNED_PLAN_FINAL\n' and final.get('bytes')==17,
            'only_exit_permission_calls':len(view['approval_inputs'])==len(expected_decisions) and all(r['tool_name']=='ExitPlanMode' for r in view['approval_inputs']),
            'effective_disk_plan_approved':all(r['input']=={'plan':'OWNED_PLAN_FINAL\n','planFilePath':'<PLAN_FILE>'} for r in view['approval_inputs']),
            'expected_decisions':[r['decision']['behavior'] for r in view['decisions']]==expected_decisions and all(r['admitted'] for r in view['decisions']),
            'original_exit_inputs_empty':all(r=={} for r in view['exit_model_inputs']),
            'permission_tool_hidden':all('mcp__ownedplans__decide'not in r['tool_names'] for r in view['requests']),
            'post_approval_exit_guard':view['tool_errors'][-1] is True and len(view['approval_inputs'])==len(expected_decisions)}
    if case=='reject':
        checks['denial_keeps_bytes']=view['plans_by_request'][5].get('<PLAN_FILE>',{}).get('text')=='OWNED_PLAN_FINAL\n'
        checks['denial_keeps_plan_mode_for_retry']=view['tool_errors'][4] and not view['tool_errors'][6] and len(view['approval_inputs'])==2
    return checks


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=Path('artifacts/differential-pass/plans'));parser.add_argument('--tau',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();cases={};views=[]
    selected=['request_count','models','tool_names','tool_errors','exit_model_inputs','approval_inputs','decisions','plans_by_request','final_plans','mcp_main_process_count','mcp_survivors']
    for case in CASES:
        original=summarize((args.original/('original-'+case+'.json')).resolve());views.append(original);entry={'original':original,'original_assertions':case_assertions(case,original)}
        if args.tau and (args.tau/('tau-'+case+'.json')).exists():
            tau=summarize((args.tau/('tau-'+case+'.json')).resolve());views.append(tau);checks={key:original[key]==tau[key] for key in selected+['tool_calls','tool_results','mcp_exit_events']}
            checks['final_answer']=original['cli']['result']==tau['cli']['result'];checks['stdout_framing']=original['cli']['stdout_keys']==tau['cli']['stdout_keys'];checks['group_kill_flag']=original['cli']['remaining_group_killed']==tau['cli']['remaining_group_killed']
            for key in ['tool_schemas','tool_names','request_controls','safe_headers','message_layout']:checks['request_'+key]=[r[key] for r in original['requests']]==[r[key] for r in tau['requests']]
            entry.update(tau=tau,tau_assertions=case_assertions(case,tau),checks=checks,differences=[key for key,value in checks.items() if not value])
        cases[case]=entry
    complete=all('tau'in e for e in cases.values());runtimes={sha(json.dumps(e['tau']['runtime'],sort_keys=True).encode()) for e in cases.values() if 'tau'in e}
    audits={'all_canaries_passed':all(v['isolation']['passed'] for v in views),'all_roots_removed':all(v['isolation']['root_removed'] for v in views),'headroom_at_least_1GiB':all(v['isolation']['headroom']>=1024**3 for v in views),
            'one_unchanged_profile':len({v['isolation']['profile_sha256'] for v in views})==1,'original_cow_copies_verified':all(e['original']['isolation']['target_copy']['distinct_inode'] and e['original']['isolation']['target_copy']['sha256']==TARGET_SHA256 for e in cases.values()),
            'source_and_fixture_proofs_passed':all(v['source_preflight_verified'] and v['fixture_probe_passed'] for v in views),'one_tau_runtime':not args.tau or len(runtimes)==1,
            'cli_bounded':all(v['cli']['exit']==0 and not v['cli']['timeout'] and not v['cli']['limited'] for v in views),'no_survivors_after_supervision':all(not v['mcp_survivors'] and not v['cli']['cleanup']['remaining_members'] for v in views)}
    report={'scope':'Two owned main file-backed Plan approval/rejection cases through stdio MCP only; unique response IDs. No Doc, remote, agent/team, PTY, or arbitrary permission/rule updates.',
            'normalization':'Owned designated plan path/filename replaced with <PLAN_FILE>; disposable root replaced with <ROOT>. Raw slugs and complete captures remain saved. No defaults/diagnostics/cleanup flags hidden.',
            'cleanup_caveat':'Original launchers exited 0 but supervisor killed remaining process groups; graceful main MCP exit was not observed. No survivors after supervision is distinct from native graceful shutdown.',
            'complete_pair_set':complete,'selected_fields':selected+['final_answer'],'all_selected_equal':complete and all(e['checks'][field] for e in cases.values() for field in selected+['final_answer']),
            'all_original_assertions':all(all(e['original_assertions'].values()) for e in cases.values()),'all_tau_assertions':complete and all(all(e['tau_assertions'].values()) for e in cases.values()),
            'audits':audits,'cli_invocations':len(views),'messages_requests':sum(v['request_count'] for v in views),'mcp_main_processes':sum(v['mcp_main_process_count'] for v in views),'permission_calls':sum(len(v['approval_inputs']) for v in views),'tau_runtime_sha256_set':sorted(runtimes),'cases':cases}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({key:value for key,value in report.items() if key not in ['cases','selected_fields']},indent=2))
    for case,e in cases.items():print(case,e.get('differences','Tau not recorded'))


if __name__=='__main__':main()
