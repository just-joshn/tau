#!/usr/bin/env python3
"""Compare selected owned native-file resume controls, keeping raw wire gaps."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO,TARGET_SHA256
from run_native_import import RAW_SHA256,MODEL,OLD_PROMPT,OLD_FINAL,PROMPT


def view(path):
    record=json.loads(path.read_text());rows=[row for row in record['requests']if row['path'].split('?')[0]=='/v1/messages'];request=rows[0];output=json.loads(record['result']['stdout']);observation=request['observation'];markers=observation['marker_positions'];root=record['isolation']['root']
    def normalize(value):
        if isinstance(value,str):return value.replace(root,'<ROOT>')
        if isinstance(value,list):return[normalize(item)for item in value]
        if isinstance(value,dict):return{key:normalize(item)for key,item in value.items()}
        return value
    return{'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'checks':record['checks'],
           'selected':{'messages':len(rows),'history_context_checks':observation['checks'],'recorded_environment_sha256':observation['recorded_environment_sha256'],
                       'owned_marker_order':sorted([OLD_PROMPT,OLD_FINAL,PROMPT],key=lambda marker:markers[marker]),'recorded_context_channels':observation['context_channels'],'primary_model':request['body']['model'],
                       'tools':[item['name']for item in request['body'].get('tools',[])],'max_tokens':request['body'].get('max_tokens'),'thinking_type':request['body'].get('thinking',{}).get('type'),'effort':request['body'].get('output_config',{}).get('effort'),
                       'adopted_id':output.get('session_id'),'final':output.get('result'),'query_usage':{key:output.get('usage',{}).get(key)for key in ['input_tokens','output_tokens']},'turns':output.get('num_turns'),'result_index':output.get('result_index'),
                       'input_raw_sha256':record['captured_source_before']['sha256'],'source_raw_stable':record['checks']['source_raw_unchanged'],'copied_raw_stable':record['checks']['copied_raw_unchanged'],'old_cwd_absent':record['checks']['old_cwd_remains_absent'],'current_workspace_distinct':record['checks']['current_workspace_distinct']},
           'wire':{'messages':normalize(request['body'].get('messages')),'system':normalize(request['body'].get('system')),'controls':{key:value for key,value in request['body'].items()if key not in ['system','tools','messages']},'headers':request['safe_headers'],
                   'output_metadata':{key:value for key,value in output.items()if key not in ['result','session_id']},'archives':normalize(record['archives']),'native_main_snapshots':normalize(record.get('native_main_snapshots')),'writer_directory':normalize({'path':record.get('adopted_writer_directory'),'before':record.get('writer_directory_before'),'after':record.get('writer_directory_after')}),'runtime':record.get('port_runtime')},
           'audit':{'passed':record['isolation']['passed'],'canaries':len(record['isolation']['checks']),'removed':not Path(root).exists(),'headroom':record['isolation']['disk_headroom_at_context_start'],'source_proofs':record['source_preflight']['all_equal'],'group_clean':not record['cleanup']['remaining_members'],
                    'source_and_copy_hashes':[record[key]['sha256']for key in ['captured_source_before','captured_source_after','copied_native_before','copied_native_after']],'target_copy':record['isolation'].get('target_copy'),'port_runtime':record.get('port_runtime'),'original_executed':record['original_executed'],'port_executed':record['port_entrypoint_executed']}}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=REPO/'artifacts/differential-pass/native-main-import-original/original-import.json');parser.add_argument('--tau',type=Path,default=REPO/'artifacts/differential-pass/native-main-import-tau/tau-import.json');parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if args.output.exists():raise RuntimeError('Refusing comparison overwrite')
    original=view(args.original);tau=view(args.tau);views=[original,tau];equal={key:original['selected'][key]==tau['selected'][key]for key in original['selected']};audits={
        'all_case_checks':all(all(item['checks'].values())for item in views),'fresh_canaries':all(item['audit']['passed']and item['audit']['canaries']==20 for item in views),'contexts_removed':all(item['audit']['removed']for item in views),'headroom_guard':all(item['audit']['headroom']>=1073741824 for item in views),
        'source_proofs':all(item['audit']['source_proofs']for item in views),'groups_clean':all(item['audit']['group_clean']for item in views),'captured_raw_fixed':all(all(value==RAW_SHA256 for value in item['audit']['source_and_copy_hashes'])for item in views),'bounded_requests':all(item['selected']['messages']==1 for item in views),
        'explicit_known_model':all(item['selected']['primary_model']==MODEL for item in views),'original_pinned':original['audit']['target_copy']['sha256']==TARGET_SHA256 and original['audit']['target_copy']['distinct_inode'],'execution_kinds':original['audit']['original_executed']and not original['audit']['port_executed']and tau['audit']['port_executed']and not tau['audit']['original_executed'],'copied_bun_runtime_recorded':tau['audit']['port_runtime']is not None}
    result={'original':original,'tau':tau,'selected_equal':equal,'audits':audits,'all_selected_equal':all(equal.values()),'wire_difference_fields':[key for key in original['wire']if original['wire'][key]!=tau['wire'][key]],'scope':'One original explicit-file resume vs the already completed Tau import, owned immutable MAIN input. No original fresh-create rerun/Tau rerun or full prompt/wire/persistence parity.'}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({key:value for key,value in result.items()if key not in ['original','tau']}))
    if not all(equal.values())or not all(audits.values()):raise SystemExit(3)


if __name__=='__main__':main()
