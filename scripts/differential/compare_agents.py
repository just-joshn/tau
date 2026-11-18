#!/usr/bin/env python3
"""Owned foreground-agent controls; keep usage, provenance and framing gaps explicit."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from isolation import TARGET_SHA256
from run_agents import CASES,MODEL,REQUIRED,strings


def sha(raw):return hashlib.sha256(raw).hexdigest()


def summarize(path):
    record=json.loads(path.read_text());root=record['isolation']['root'];requests=[];calls={'parent':{},'child':{}};results={'parent':{},'child':{}}
    def normalize(value):
        if isinstance(value,str):return value.replace(root,'<ROOT>')
        if isinstance(value,list):return [normalize(v) for v in value]
        if isinstance(value,dict):return {key:normalize(v) for key,v in value.items()}
        return value
    for row in record['requests']:
        if row['path'].split('?')[0]!='/v1/messages':continue
        scope=row['scope'];body=row['body'];requests.append({'scope':scope,'model':body.get('model'),'owned_system_marker_present':row['owned_system_marker_present'],
            'tool_names':[t['name'] for t in body.get('tools',[])],'tool_schemas':body.get('tools',[]),'request_controls':{key:value for key,value in body.items() if key not in ['system','messages','tools']},
            'safe_headers':row['safe_headers'],'message_layout':[{'role':m['role'],'blocks':[b.get('type') for b in m.get('content',[])] if isinstance(m.get('content'),list) else ['string']} for m in body.get('messages',[])]})
        for message in body.get('messages',[]):
            if not isinstance(message.get('content'),list):continue
            for block in message['content']:
                if block.get('type')=='tool_use':calls[scope][block['id']]={'name':block['name'],'input':normalize(block['input'])}
                if block.get('type')=='tool_result':results[scope][block['tool_use_id']]={'is_error':bool(block.get('is_error')),'raw':normalize(block)}
    parent_result=results['parent'].get('owned-agent-parent-tool',{})
    parent_text='\n'.join(strings(parent_result.get('raw',{}).get('content')))
    stats={key:int(found.group(1)) if (found:=re.search(r'\b'+key+r':\s*(\d+)',parent_text)) else None for key in ['subagent_tokens','tool_uses','duration_ms']}
    agent_id=re.search(r'\bagentId:\s*([A-Za-z0-9_-]+)',parent_text)
    stage=record['stages'][0];outcome=stage['result'];stdout=json.loads(outcome['stdout']);profile=record['isolation']['profile'].replace(root,'<ROOT>').replace(record['isolation']['tag'],'<TAG>').replace('localhost:'+str(record['isolation']['network_port']),'localhost:<PORT>');source=record['source_preflight']
    return {'artifact':str(path),'sha256':sha(path.read_bytes()),'request_count':len(requests),'all_http_requests':len(record['requests']),'requests':requests,'scopes':[r['scope'] for r in requests],'models':[r['model'] for r in requests],
            'tool_calls':calls,'tool_results':results,'tool_errors':{scope:[r['is_error'] for r in scoped.values()] for scope,scoped in results.items()},
            'child_tool_sets':[sorted(r['tool_names']) for r in requests if r['scope']=='child'],'parent_tool_sets':[sorted(r['tool_names']) for r in requests if r['scope']=='parent'],
            'child_system_marker_present':all(r['owned_system_marker_present'] for r in requests if r['scope']=='child'),
            'parent_result_contains_child_final':'OWNED_AGENT_CHILD_FINAL'in parent_text,'child_read_contains_owned_file':any('OWNED_AGENT_FILE'in '\n'.join(strings(r['raw'].get('content'))) for r in results['child'].values()),
            'raw_agent_id':agent_id.group(1) if agent_id else None,'parent_result_report_stats':stats,'owned_file':record['owned_file'],
            'child_transcript_manifest':record['owned_child_transcript_manifest'],'owned_tau_child_archives':record.get('owned_tau_child_archives',{}),'user_settings':record.get('user_settings',{}),
            'policy_source_verified':len(source.get('policy_spans',[]))>=31 and (source.get('fresh_module_absence_proof') or {}).get('no_G9r') and (source.get('fresh_module_absence_proof') or {}).get('no_ruleContentField'),
            'policy_proof_sha256':source.get('policy_proof_sha256'),'source_verified':source['all_equal'] and not source['recovered_code_executed'] and len(source['runtime_spans'])>=34 and REQUIRED<={r['id'] for r in source['runtime_spans']} and len(source['definition_spans'])>=68,
            'cli':{'exit':outcome['exit_code'],'timeout':outcome['timed_out'],'limited':outcome['output_limited'],'result':stdout.get('result'),'usage':stdout.get('usage'),'modelUsage':stdout.get('modelUsage'),'subagent_stats':stdout.get('subagent_stats'),
                   'parent_token_projection':{key:(stdout.get('usage') or {}).get(key) for key in ['input_tokens','output_tokens']},
                   'global_model_token_projection':{key:{field:value.get(field) for field in ['inputTokens','outputTokens']} for key,value in stdout.get('modelUsage',{}).items()} if isinstance(stdout.get('modelUsage'),dict) else None,
                   'stdout_keys':sorted(stdout),'stderr':outcome['stderr'],'group_killed':outcome['remaining_process_group_killed'],'cleanup':stage['cleanup']},
            'isolation':{'passed':record['isolation']['passed'],'checks':record['isolation']['checks'],'root_removed':not Path(root).exists(),'headroom':record['isolation']['disk_headroom_at_context_start'],'profile_sha256':sha(profile.encode()),'target_copy':record['isolation'].get('target_copy')},
            'runtime':record['runtime'],'environment_overrides':record['environment_overrides']}


def case_assertions(case,view):
    checks={'expected_request_count':view['request_count']==(4 if case=='reader' else 2),'model_inherited_exact':all(model==MODEL for model in view['models']),
            'owned_file_unchanged':view['owned_file']['before']==view['owned_file']['after']=='OWNED_AGENT_FILE\n','fork_disabled_env':view['environment_overrides']=={'CLAUDE_CODE_FORK_SUBAGENT':'0'},
            'parent_tool_set_bounded':all(names==['Agent','Read'] for names in view['parent_tool_sets'])}
    call=view['tool_calls']['parent'].get('owned-agent-parent-tool',{})
    checks['foreground_explicit']=call.get('input',{}).get('run_in_background') is False
    if case=='reader':checks.update(scope_order=view['scopes']==['parent','child','child','parent'],child_system_marker=view['child_system_marker_present'],child_read_only=view['child_tool_sets']==[['Read'],['Read']],
                                   parent_success=view['tool_errors']['parent']==[False],child_success=view['tool_errors']['child']==[False],child_read_marker=view['child_read_contains_owned_file'],child_report_returned=view['parent_result_contains_child_final'])
    else:checks.update(scope_order=view['scopes']==['parent','parent'],no_child=not view['child_tool_sets'],parent_guard_error=view['tool_errors']['parent']==[True])
    return checks


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=Path('artifacts/differential-pass/agents'));parser.add_argument('--tau',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();cases={};views=[]
    selected=['request_count','scopes','models','tool_calls','tool_errors','child_tool_sets','parent_tool_sets','child_system_marker_present','parent_result_contains_child_final','child_read_contains_owned_file','owned_file']
    for case in CASES:
        original=summarize((args.original/('original-'+case+'.json')).resolve());views.append(original);entry={'original':original,'original_assertions':case_assertions(case,original)}
        if args.tau and (args.tau/('tau-'+case+'.json')).exists():
            tau=summarize((args.tau/('tau-'+case+'.json')).resolve());views.append(tau);checks={key:original[key]==tau[key] for key in selected+['tool_results','child_transcript_manifest']}
            checks['final_answer']=original['cli']['result']==tau['cli']['result'];checks['reported_last_child_tokens']=original['parent_result_report_stats']['subagent_tokens']==tau['parent_result_report_stats']['subagent_tokens'];checks['reported_child_tool_uses']=original['parent_result_report_stats']['tool_uses']==tau['parent_result_report_stats']['tool_uses']
            for key in ['usage','modelUsage','subagent_stats','parent_token_projection','global_model_token_projection','stdout_keys','group_killed']:checks['cli_'+key]=original['cli'][key]==tau['cli'][key]
            for key in ['tool_names','tool_schemas','request_controls','safe_headers','message_layout']:checks['request_'+key]=[r[key] for r in original['requests']]==[r[key] for r in tau['requests']]
            entry.update(tau=tau,tau_assertions=case_assertions(case,tau),checks=checks,differences=[key for key,value in checks.items() if not value])
        cases[case]=entry
    complete=all('tau'in e for e in cases.values());runtimes={sha(json.dumps(e['tau']['runtime'],sort_keys=True).encode()) for e in cases.values() if 'tau'in e}
    audits={'all_canaries_passed':all(v['isolation']['passed'] for v in views),'all_roots_removed':all(v['isolation']['root_removed'] for v in views),'headroom_at_least_1GiB':all(v['isolation']['headroom']>=1024**3 for v in views),
            'one_unchanged_profile':len({v['isolation']['profile_sha256'] for v in views})==1,'original_cow_copies_verified':all(e['original']['isolation']['target_copy']['distinct_inode'] and e['original']['isolation']['target_copy']['sha256']==TARGET_SHA256 for e in cases.values()),
            'all_source_verified':all(v['source_verified'] for v in views),'one_tau_runtime':not args.tau or len(runtimes)==1,
            'bounded_cli':all(v['cli']['exit']==0 and not v['cli']['timeout'] and not v['cli']['limited'] for v in views),'no_survivors':all(not v['cli']['cleanup']['remaining_members'] for v in views)}
    report={'scope':'Two owned ordinary foreground custom-agent cases only; independent user-authored system body, Read-only tool, inherited explicit model, fork gate disabled. No builtin agent prompt/runtime parity claim.',
            'normalization':'Disposable root paths only. Generated agent IDs/durations/provenance framing, usage shape, persisted metadata and full wire gaps remain raw.',
            'complete_pair_set':complete,'selected_fields':selected+['final_answer'],'all_selected_equal':complete and all(e['checks'][key] for e in cases.values() for key in selected+['final_answer']),
            'all_original_assertions':all(all(e['original_assertions'].values()) for e in cases.values()),'all_tau_assertions':complete and all(all(e['tau_assertions'].values()) for e in cases.values()),
            'audits':audits,'cli_invocations':len(views),'messages_requests':sum(v['request_count'] for v in views),'tau_runtime_sha256_set':sorted(runtimes),'cases':cases}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({key:value for key,value in report.items() if key not in ['cases','selected_fields']},indent=2))
    for case,e in cases.items():print(case,e.get('differences','Tau not recorded'))


if __name__=='__main__':main()
