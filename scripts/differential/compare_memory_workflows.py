#!/usr/bin/env python3
"""Selected memory workflow comparisons; Plan outcome remains observational."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO,TARGET_SHA256
from prepare_memory_workflows import CASES
from run_memory_workflows import models
from run_plugins import results


def view(path):
    record=json.loads(path.read_text());rows=models(record);root=record['isolation']['root'];tool_results={}
    def normalize(value):
        if isinstance(value,str):return value.replace(root,'<ROOT>')
        if isinstance(value,list):return[normalize(item)for item in value]
        if isinstance(value,dict):return{key:normalize(item)for key,item in value.items()}
        return value
    for row in rows:tool_results.update(results(row['body']))
    output=json.loads(record['result']['stdout']);scopes=['parent','first','second'];file_values=lambda snapshot:{key:{field:value.get(field)for field in ['exists','text','sha256']}for key,value in snapshot.items()if key!='definition'}
    selected={'requests_by_scope':{scope:sum(row['scope']==scope for row in rows)for scope in scopes},'primary_models':[row['body'].get('model')for row in rows],'toolsets':[sorted(tool['name']for tool in row['body'].get('tools',[]))for row in rows],
              'effect_checks':[row['observation']['checks']for row in rows],'own_system_markers':[row['observation']['system_markers']for row in rows],'memory_location_in_system':[row['observation']['memory_directory_in_system']for row in rows],
              'file_bytes_by_request':[file_values(row['memory_state'])for row in rows],'file_bytes_final':file_values(record['memory_final']),'tool_error_flags':{key:bool(value.get('is_error'))for key,value in tool_results.items()},
              'plan_outcome':record['plan_observation']['outcome']if record['plan_observation']else None,'final':output.get('result'),'query_usage':{key:output.get('usage',{}).get(key)for key in ['input_tokens','output_tokens']},'turns':output.get('num_turns'),'result_index':output.get('result_index')}
    return{'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'checks':record['checks'],'selected':selected,'plan_observation':normalize(record['plan_observation']),'process_exit':record['result']['exit_code'],'stderr':normalize(record['result']['stderr']),
           'wire':{'messages':[normalize(row['body'].get('messages'))for row in rows],'system':[normalize(row['body'].get('system'))for row in rows],'tool_orders':[[tool['name']for tool in row['body'].get('tools',[])]for row in rows],'tool_results':normalize(tool_results),'controls':[{key:value for key,value in row['body'].items()if key not in ['system','tools','messages']}for row in rows],'headers':[row['safe_headers']for row in rows],'output_metadata':{key:value for key,value in output.items()if key not in ['result','session_id']},'archives':normalize(record['archives'])},
           'audit':{'passed':record['isolation']['passed'],'canaries':len(record['isolation']['checks']),'removed':not Path(root).exists(),'headroom':record['isolation']['disk_headroom_at_context_start'],'source_equal':record['source_preflight']['all_equal'],'group_clean':not record['cleanup']['remaining_members'],'target_copy':record['isolation'].get('target_copy'),'port_runtime':record.get('port_runtime'),'messages':len(rows),'memory_preapprovals_absent':record['checks']['no_memory_preapprovals'],'definition_immutable':record['checks']['definition_immutable'],'environment':record['environment_overrides']}}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=REPO/'artifacts/differential-pass/memory-workflows-original');parser.add_argument('--tau',type=Path);parser.add_argument('--cases',nargs='+',choices=CASES,default=CASES);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if args.output.exists():raise RuntimeError('Refusing memory comparison overwrite')
    pairs={};views=[]
    for case in args.cases:
        original=view(args.original/('original-'+case+'.json'));entry={'original':original};views.append(original)
        if args.tau:
            tau=view(args.tau/('tau-'+case+'.json'));views.append(tau);entry.update(tau=tau,selected_equal={key:original['selected'][key]==tau['selected'][key]for key in original['selected']},wire_difference_fields=[key for key in original['wire']if original['wire'][key]!=tau['wire'][key]])
        pairs[case]=entry
    excluded={case:view(args.original/('original-'+case+'.json'))for case in CASES if case not in args.cases and(args.original/('original-'+case+'.json')).exists()}
    originals=[pair['original']for pair in pairs.values()];all_originals=originals+list(excluded.values());taus=[pair['tau']for pair in pairs.values()if'tau'in pair];hashes={record['audit']['port_runtime']['manifest_sha256']for record in taus if record['audit']['port_runtime']}
    audits={'all_case_checks':all(all(record['checks'].values())for record in views),'fresh_twenty_canaries':all(record['audit']['passed']and record['audit']['canaries']==20 for record in views),'contexts_removed':all(record['audit']['removed']for record in views),'headroom_guard':all(record['audit']['headroom']>=1073741824 for record in views),'source_proofs':all(record['audit']['source_equal']for record in views),'groups_clean':all(record['audit']['group_clean']for record in views),
            'original_pinned':all(record['audit']['target_copy']['sha256']==TARGET_SHA256 and record['audit']['target_copy']['distinct_inode']for record in all_originals),'phase_cap':sum(record['audit']['messages']for record in all_originals)<=20 and sum(record['audit']['messages']for record in taus)<=20,'no_write_preapprovals':all(record['audit']['memory_preapprovals_absent']for record in views),'immutable_definitions':all(record['audit']['definition_immutable']for record in views),'explicit_memory_control':all(record['audit']['environment']['CLAUDE_CODE_DISABLE_AUTO_MEMORY']=='false'and record['audit']['environment']['CLAUDE_CODE_FORK_SUBAGENT']=='0'for record in views),'one_port_snapshot':not taus or len(hashes)==1 and all(record['audit']['port_runtime']for record in taus)}
    output={'pairs':pairs,'audits':audits,'selected_cases':args.cases,'excluded_original_evidence':excluded,'exclusion_policy':'Explicitly unselected original cases remain visible with their raw checks, exit status, diagnostics and capture hash. They do not count as successful selected comparisons.','complete':len(taus)==len(args.cases),'all_selected_equal':len(taus)==len(args.cases) and all(all(pair['selected_equal'].values())for pair in pairs.values()),'scope':'Explicitly selected owned foreground memory controls. Plan C may be excluded because an upstream auto-review gate prevented child launch; this does not answer Plan memory policy. Remote/nH/storage/account/background memory are outside scope.'};args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({key:value for key,value in output.items()if key not in ['pairs','excluded_original_evidence']}))
    if not all(audits.values())or taus and not output['all_selected_equal']:raise SystemExit(3)


if __name__=='__main__':main()
