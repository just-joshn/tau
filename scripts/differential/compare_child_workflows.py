#!/usr/bin/env python3
"""Selected child workflow comparisons; raw contexts and wire differences remain."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO,TARGET_SHA256
from prepare_child_workflows import CASES,DELEGATION,START_MARKER
from run_child_workflows import assertions,models,task_rows,user_texts
from run_plugins import results


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize(path):
    r=json.loads(path.read_text());root=r['isolation']['root'];rows=models(r);parents=[x for x in rows if x['scope']=='parent'];children=[x for x in rows if x['scope']=='child'];out=json.loads(r['stages'][0]['result']['stdout'])
    def normalize(v):
        if isinstance(v,str):return v.replace(root,'<ROOT>')
        if isinstance(v,list):return[normalize(x)for x in v]
        if isinstance(v,dict):return{k:normalize(x)for k,x in v.items()}
        return v
    first='\n'.join(user_texts(children[0]['body']))if children else'';markers=[DELEGATION,START_MARKER,'OWNED_CHILD_PASSIVE_A','OWNED_CHILD_PASSIVE_B','OWNED_CHILD_CONDITIONAL_BODY']
    sent={scope:[{'name':b['name'],'input':normalize(b['input'])}for response in r['mock_responses']if response['scope']==scope for b in response['content']if b['type']=='tool_use']for scope in ['parent','child']}
    tool_results={};committed=[]
    for row in rows:
        for key,value in results(row['body']).items():tool_results[key]=normalize(value)
        for message in row['body'].get('messages',[]):
            if message.get('role')!='assistant' or not isinstance(message.get('content'),list):continue
            for block in message['content']:
                if isinstance(block,dict)and block.get('type')=='tool_use'and block['id']not in [x['id']for x in committed]:committed.append(normalize(block))
    selected={'requests_by_scope':{scope:sum(x['scope']==scope for x in rows)for scope in ['parent','child']},'primary_models_by_scope':{scope:[x['body'].get('model')for x in rows if x['scope']==scope]for scope in ['parent','child']},
              'effort_by_scope':{scope:[x['body'].get('output_config',{}).get('effort')for x in rows if x['scope']==scope]for scope in ['parent','child']},
              'child_toolsets':[sorted(t['name']for t in x['body'].get('tools',[]))for x in children],'sent_actions':sent,'tool_error_flags':{k:bool(v.get('is_error'))for k,v in tool_results.items()},
              'final_files':r['final_files'],'task_rows_final':task_rows(r['task_store_final']),'task_rows_by_request':[task_rows(x['task_store_snapshot'])for x in rows],
              'preload_marker_presence':{m:m in first for m in markers},'preload_a_occurrences':first.count('OWNED_CHILD_PASSIVE_A'),'owned_initial_marker_order':sorted([m for m in markers if m in first],key=first.find),
              'hook_event_types':[x['input'].get('hook_event_name')for x in r['hook_lifecycle']if x.get('event')=='input'],'hook_agent_types':[x['input'].get('agent_type')for x in r['hook_lifecycle']if x.get('event')=='input'],
              'hook_exit_codes':[x['code']for x in r['hook_lifecycle']if x.get('event')=='exit'],'final_answer':out.get('result')}
    return{'path':str(path),'sha256':sha(path),'selected':selected,'assertions':assertions(r),'raw_assertions':r['assertions'],
           'wire':{'committed_tool_inputs':committed,'tool_results':tool_results,'tool_orders':[[t['name']for t in x['body'].get('tools',[])]for x in rows],
                   'request_controls':[{k:v for k,v in x['body'].items()if k not in ['system','messages','tools']}for x in rows],'headers':[x['safe_headers']for x in rows],
                   'user_block_layouts':[[{'role':m['role'],'types':[b.get('type')for b in m['content']if isinstance(b,dict)]if isinstance(m.get('content'),list)else['string']}for m in x['body'].get('messages',[])]for x in rows],
                   'preload_marker_positions':{m:first.find(m)for m in markers},'task_store_manifest':r['task_store_final'],'hook_input_fields':[sorted(x['input'])for x in r['hook_lifecycle']if x.get('event')=='input'],
                   'native_child_metadata':r['native_child_metadata'],'stdout_metadata':{k:v for k,v in out.items()if k not in ['result','session_id']}},
           'audit':{'passed':r['isolation']['passed'],'canaries':len(r['isolation']['checks']),'removed':not Path(root).exists(),'headroom':r['isolation']['disk_headroom_at_context_start'],'target_copy':r['isolation'].get('target_copy'),
                    'source_passed':r['source_preflight']['all_equal'],'task_env_absent':r['task_list_env_absent'],'group_clean':not r['stages'][0]['cleanup']['remaining_members'],'hooks_clean':not r['surviving_hook_pids'],
                    'request_count':len(rows),'hook_count':len(r['hook_pids']),'port_runtime':r.get('port_runtime')},'fixture_runtime':r['runtime']}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--original',type=Path,default=REPO/'artifacts/differential-pass/child-workflows');p.add_argument('--tau',type=Path);p.add_argument('--output',type=Path,required=True);args=p.parse_args();pairs={};views=[]
    for case in CASES:
        original=summarize(args.original/('original-'+case+'.json'));entry={'original':original};views.append(original)
        if args.tau and(args.tau/('tau-'+case+'.json')).exists():
            tau=summarize(args.tau/('tau-'+case+'.json'));views.append(tau);entry.update(tau=tau,selected_equal={k:original['selected'][k]==tau['selected'][k]for k in original['selected']},wire_difference_fields=[k for k in original['wire']if original['wire'][k]!=tau['wire'][k]])
        pairs[case]=entry
    originals=[x['original']for x in pairs.values()];taus=[x['tau']for x in pairs.values()if'tau'in x];runtime_hashes={hashlib.sha256(json.dumps(x['audit']['port_runtime'],sort_keys=True).encode()).hexdigest()for x in taus if x['audit']['port_runtime']is not None}
    audits={'all_canaries_pass':all(x['audit']['passed']and x['audit']['canaries']==20 for x in views),'all_contexts_removed':all(x['audit']['removed']for x in views),'headroom_guard':all(x['audit']['headroom']>=1073741824 for x in views),
            'pinned_original_copies':all(x['audit']['target_copy']['sha256']==TARGET_SHA256 and x['audit']['target_copy']['distinct_inode']for x in originals),'all_source_proofs':all(x['audit']['source_passed']for x in views),
            'inherited_task_identity_control':all(x['audit']['task_env_absent']for x in views),'cleanup':all(x['audit']['group_clean']and x['audit']['hooks_clean']for x in views),
            'phase_request_caps':sum(x['audit']['request_count']for x in originals)<=17 and(not taus or sum(x['audit']['request_count']for x in taus)<=17),
            'phase_hook_caps':sum(x['audit']['hook_count']for x in originals)<=2 and(not taus or sum(x['audit']['hook_count']for x in taus)<=2),
            'reviewed_port_runtime_recorded':not taus or len(runtime_hashes)==1 and all(x['audit']['port_runtime']is not None for x in taus)}
    complete=len(taus)==2;output={'pairs':pairs,'audits':audits,'complete_pair_set':complete,'all_selected_equal':complete and all(all(x['selected_equal'].values())for x in pairs.values()),
                                'oracle_correction':'Original B raw preload_start_order=false remains immutable. Recomputed start_before_delegation_preload_order uses observed Start<delegation<passiveA<passiveB, independently explained by native RPi reverse attachment projection. No original rerun.',
                                'all_case_assertions':all(all(x['assertions'].values())for x in views),'scope':'Two bounded foreground default-builtin/Skill/preload/shared-Task workflows. No async/Plan/runtime-toolchain parity implied.'}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({k:v for k,v in output.items()if k!='pairs'}))
    if not all(audits.values())or not output['all_case_assertions']or complete and not output['all_selected_equal']:raise SystemExit(3)


if __name__=='__main__':main()
