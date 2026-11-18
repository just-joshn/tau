#!/usr/bin/env python3
"""Owned memory controls; original/Tau execution each require parent GO."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import subprocess

from bun_runtime import bun_environment
from isolation import REPO,Isolation
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_memory_workflows import CASES,ENV,MODEL,NAME,OLD,UPDATED,TOPIC,PROJECT,PLAN,PARENT_FINAL,MemoryMock,locations,marker,memory_state,recipe,verify
from prepare_child_workflows import direct_user_texts
from prepare_plugins import PINNED_TARGET
from run_child_workflows import prepare_bun_adapter
from run_native_import import archive_snapshot
from run_plugins import results
from run_skills import run_stage

PHASE_CAP=20
PROGRAM='''const current=process.argv[2];
const scopes=current==="user"?["parent",...Array(5).fill("first"),"parent","second","parent","parent"]:["parent","first","first","parent"];
(async()=>{for(const scope of scopes){const marker="OWNED_MEMORY_DELEGATION_"+current.toUpperCase().replaceAll("-","_")+"_"+scope.toUpperCase();const body={model:"claude-sonnet-4-6",stream:true,system:"OWNED_MEMORY_PROTOCOL_ONLY",messages:[{role:"user",content:[{type:"text",text:scope==="parent"?"OWNED_PROTOCOL_PARENT":marker}]}]};const response=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error("Owned memory protocol rejected");await response.text();}process.stdout.write("owned-memory-workflow-ready");})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
'''


def models(record):return[row for row in record['requests']if row['path'].split('?')[0]=='/v1/messages']


@contextmanager
def phase_guard(directory,mode,case):
    lock=directory/('.'+mode+'-phase.lock')
    with lock.open('x')as stream:stream.write(str(os.getpid()))
    try:
        previous=[]
        for other in CASES:
            path=directory/(mode+'-'+other+'.json')
            if not path.exists():continue
            record=json.loads(path.read_text())
            if not all(record['checks'].values()):raise RuntimeError('Prior memory control failed; review before another case')
            previous.append(record)
        used=sum(len(models(record))for record in previous);expected=10 if case=='user'else 4
        if len(previous)>=3 or used+expected>PHASE_CAP:raise RuntimeError('Memory phase CLI/request budget exhausted')
        yield PHASE_CAP-used
    finally:lock.unlink()


def assertions(record):
    rows=models(record);case=record['case'];plan=record['recipe'];final=record['memory_final'];outcome=record['result'];scopes={key:sum(row['scope']==key for row in rows)for key in ['parent','first','second']};definitions=record['definition_before'];current=record['memory_final']['definition'];parent=[row for row in rows if row['scope']=='parent'];first=[row for row in rows if row['scope']=='first']
    checks={'cli_success':outcome['exit_code']==0 and not outcome['timed_out']and not outcome['output_limited'],'no_mock_halt':record['mock_halt']is None,'known_models':bool(rows)and all(row['body'].get('model')==MODEL for row in rows),'scope_classifier':all(not any(marker(case,scope)in text for scope in ['first','second'])for row in parent for text in direct_user_texts(row['body'])),
            'group_clean':not record['cleanup']['remaining_members'],'file_guards_pass':all('guard_error'not in item for item in final.values())and not record['archives']['guards'],'definition_immutable':definitions==current,'no_refused_file':not final['refused']['exists'],'parent_final':PARENT_FINAL in outcome['stdout'],
            'no_memory_preapprovals':not any(arg in plan['arguments']for arg in ['--allowedTools','--allow-all-tools']),'all_effect_oracles':all(all(row['observation']['checks'].values())for row in rows)}
    if case!='project-plan':checks.update(expected_messages=len(rows)==plan['expected_messages'],expected_scopes=scopes==plan['expected_scopes'])
    else:checks['bounded_plan_flow']=scopes in [{'parent':2,'first':2,'second':0},{'parent':2,'first':0,'second':0}]
    if case=='user':checks.update(index_updated=final['index'].get('text')==UPDATED+'\n',topic_written=final['topic'].get('text')==TOPIC,parent_read_topic=len(parent)==4 and TOPIC.strip()in json.dumps(results(parent[3]['body']).get('owned-memory-parent-3')))
    elif case=='project':checks['new_project_index']=final['index'].get('text')==PROJECT
    else:
        response=results(first[1]['body']).get('owned-memory-first-1')if len(first)>1 else None;written=final['index'].get('text')==PLAN;held=not final['index']['exists']
        status='allowed'if written and response and not response.get('is_error',False)else'held'if held and response and response.get('is_error')is True else'agent-held'if held and not first and len(parent)==2 and results(parent[1]['body']).get('owned-memory-parent-1',{}).get('is_error')is True else'unexpected'
        record['plan_observation']={'outcome':status,'write_result':response,'actual_scopes':scopes,'expected_four_requests':len(rows)==4,'memory_directory_in_child_system':first[0]['observation']['memory_directory_in_system']if first else None,'child_toolset':first[0]['observation']['tool_names']if first else[],'prediction':'Local native iA allows memory before generic plan hold; upstream wrappers unresolved. No forced permission outcome.'};checks['plan_outcome_consistent']=status!='unexpected'
    return checks


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['original','tau','readiness','bun-readiness']);parser.add_argument('case',choices=CASES);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/memory-workflows');args=parser.parse_args();directory=args.artifacts.resolve();directory.mkdir(parents=True,exist_ok=True);stem=args.mode+'-'+args.case
    if any(directory.glob(stem+'.*')):raise RuntimeError('Refusing memory capture/bootstrap/failure overwrite')
    proof=verify();ready=args.mode in ['readiness','bun-readiness'];state=MemoryMock(args.case,readiness=ready);record=None
    with phase_guard(directory,args.mode,args.case)as remaining:
      state.message_cap=remaining;isolation=Isolation(directory,state.handler())
      try:
        config=isolation.root/'.claude';config.mkdir();isolation.env.update(ENV);isolation.env['CLAUDE_CONFIG_DIR']=str(config)
        if args.mode in ['tau','bun-readiness']:isolation.env.update(bun_environment(isolation.root))
        isolation.verify();state.root=isolation.root;plan=recipe(isolation.root,args.case);paths=locations(isolation.root,args.case);paths['definition'].parent.mkdir(parents=True);paths['definition'].write_text(plan['definition'])
        if any(marker(args.case,scope)in plan['definition']or marker(args.case,scope)in plan['arguments'][1]for scope in ['first','second']):raise RuntimeError('Delegation marker leaked to parent-owned fixture text')
        if args.case=='user':paths['directory'].mkdir(parents=True);paths['index'].write_text(OLD+'\n')
        before=memory_state(isolation.root,args.case);definition_before=before['definition'];runtime=None;probes=None;fixture_runtime=None;fixture_probe=None
        if args.mode in ['tau','bun-readiness']:bun,entry,runtime,probes=prepare_bun_adapter(isolation,directory,stem);command=[str(bun),'--no-install',str(entry)]
        else:
            node,fixture_runtime=copy_node_fixture_runtime(isolation.root);fixture_probe=isolation.sandbox([str(node),'-e','process.stdout.write("owned-memory-node-ready")'])
            if fixture_probe['exit_code']!=0 or fixture_probe['timed_out']or fixture_probe['output_limited']or fixture_probe['stdout']!='owned-memory-node-ready':raise RuntimeError('Copied Node memory fixture bootstrap failed')
            command=[str(node)]
        arguments=list(plan['arguments'])
        if args.mode=='original':command=[str(isolation.copy_target(PINNED_TARGET))];arguments.append('--no-session-persistence')
        if ready:
            authored=isolation.root/'owned-memory-protocol.cjs';authored.write_text(PROGRAM);command=[str(bun),'--no-install',str(authored),args.case]if args.mode=='bun-readiness'else[str(node),str(authored),args.case];arguments=[]
        isolation.report['original_executed']=args.mode=='original';isolation.report['port_entrypoint_executed']=args.mode=='tau';outcome,cleanup=run_stage(isolation,command,arguments)
        final=memory_state(isolation.root,args.case);record={'mode':args.mode,'case':args.case,'source_preflight':proof,'isolation':isolation.report,'environment_overrides':{**ENV,'CLAUDE_CONFIG_DIR':str(config)},'recipe':plan,'memory_before':before,'definition_before':definition_before,'memory_final':final,'port_runtime':runtime,'port_runtime_probes':probes,'fixture_runtime':fixture_runtime,'fixture_runtime_probe':fixture_probe,'arguments':arguments,'command':command,'requests':state.requests,'mock_responses':state.responses,'mock_halt':state.halt,'scope_generations':state.generations,'result':outcome,'cleanup':cleanup,'archives':archive_snapshot(isolation.root),'plan_observation':None,'hooks_configured':False,'classifier':'Unique direct USER delegation markers only; assistant tool inputs/tool_result/system/billing markers excluded','original_executed':args.mode=='original','port_entrypoint_executed':args.mode=='tau'}
        if ready:record['checks']={'authored_protocol_ready':outcome['exit_code']==0 and not outcome['timed_out']and not outcome['output_limited']and outcome['stdout']=='owned-memory-workflow-ready','expected_requests':len(models(record))==plan['expected_messages'],'expected_scopes':state.generations==plan['expected_scopes'],'no_mock_halt':state.halt is None,'definition_unchanged':definition_before==final['definition'],'no_fixture_mutations':before==final,'group_clean':not cleanup['remaining_members'],'no_app_entrypoint':not record['original_executed']and not record['port_entrypoint_executed']}
        else:record['checks']=assertions(record)
        (directory/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for name in ['stdout','stderr']:(directory/(stem+'.'+name+'.txt')).write_text(outcome[name])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(directory/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'mode':args.mode,'case':args.case,'messages':len(models(record)),'scopes':state.generations,'checks':record['checks'],'plan_observation':record['plan_observation'],'original_executed':record['original_executed'],'port_entrypoint_executed':record['port_entrypoint_executed']}))
      except Exception as error:
        (directory/(stem+'.failure.json')).write_text(json.dumps({'error':{'type':type(error).__name__,'message':str(error)},'isolation':isolation.report,'requests':state.requests,'snapshot_drift':getattr(error,'evidence',None),'partial_record':record},indent=2)+'\n');raise
      finally:isolation.close()
    if not all(record['checks'].values()):raise SystemExit(3)


if __name__=='__main__':main()
