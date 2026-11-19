#!/usr/bin/env python3
"""Two bounded owned child controls; copied Bun Tau launch requires root GO."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time

from isolation import REPO,TARGET_SHA256,Isolation,clone_file
from bun_runtime import bun_environment,copy_bun_executable,copy_bun_source_runtime
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_child_workflows import CASES,ENV,MODEL,DELEGATION,START_MARKER,ChildWorkflowMock,direct_user_texts,recipe,verify
from prepare_plugins import PINNED_TARGET
from run_background_agents import snapshot
from run_hooks import alive
from run_plugins import results
from run_skills import run_stage
from run_tau import digest

PHASE_CAP=17
BUN_DEPENDENCY_PROGRAM='''import ignore from "ignore";
import { marked } from "marked";
import picomatch from "picomatch";
import stringWidth from "string-width";
import { parse } from "yaml";
import { z } from "zod";
const value: string = "OWNED_OFFLINE_BUN_READY";
if (!ignore().add("owned-ignored").ignores("owned-ignored") || typeof await marked.parse("owned") !== "string" || !picomatch("*.txt")("owned.txt") || stringWidth("owned") !== 5 || parse("marker: owned").marker !== "owned" || z.literal("OWNED_OFFLINE_BUN_READY").parse(value) !== value) throw Error("Owned dependency check failed");
process.stdout.write("owned-bun-offline-dependencies-ready");
'''


@contextmanager
def child_isolation(directory,state,mode,stem):
    isolation=Isolation(directory,state.handler())
    try:
        isolation.env.update(ENV)
        if mode in ['tau','bun-readiness']:isolation.env.update(bun_environment(isolation.root))
        isolation.verify();yield isolation
    except Exception as error:
        receipt={'case':state.case,'mode':mode,'isolation':isolation.report,'requests':state.requests,
                 'error':{'type':type(error).__name__,'message':str(error)},'snapshot_drift':getattr(error,'evidence',None)}
        (directory/(stem+'.failure.json')).write_text(json.dumps(receipt,indent=2)+'\n');raise
    finally:isolation.close()


def prepare_bun_adapter(isolation,directory,stem):
    bun,executable=copy_bun_executable(isolation.root)
    version=isolation.sandbox([str(bun),'--version']);help_result=isolation.sandbox([str(bun),'--help'])
    probes={'version':version,'help':help_result}
    (directory/(stem+'.bun-bootstrap.json')).write_text(json.dumps({'isolation':isolation.report,'bun':executable,'probes':probes,'port_entrypoint_executed':False},indent=2)+'\n')
    if any(r['exit_code']!=0 or r['timed_out']or r['output_limited']or r['remaining_process_group_killed']for r in probes.values())or version['stdout'].strip()!='1.4.4'or'--no-install'not in help_result['stdout']:
        raise RuntimeError('Copied Bun version/no-install readiness failed')
    entry,runtime=copy_bun_source_runtime(isolation.root,executable)
    authored=entry.parent.parent/'owned-bun-offline-dependencies.ts';authored.write_text(BUN_DEPENDENCY_PROGRAM)
    probes['offline_dependencies']=isolation.sandbox([str(bun),'--no-install',str(authored)])
    probe=probes['offline_dependencies']
    if probe['exit_code']!=0 or probe['timed_out']or probe['output_limited']or probe['remaining_process_group_killed']or probe['stdout']!='owned-bun-offline-dependencies-ready':
        raise RuntimeError('Copied Bun offline dependency readiness failed')
    (directory/(stem+'.bun-runtime.json')).write_text(json.dumps({'runtime':runtime,'probes':probes,'authored_offline_program':BUN_DEPENDENCY_PROGRAM,'port_entrypoint_executed':False},indent=2)+'\n')
    return bun,entry,runtime,probes


def models(record):return[r for r in record['requests']if r['path'].split('?')[0]=='/v1/messages']


def user_texts(body):
    return direct_user_texts(body)


def task_snapshot(root):
    directory=root/'config/tasks';files={};guards=[];retained=0
    if not directory.exists():return{'files':files,'guards':guards}
    if not directory.resolve().is_relative_to(root):return{'files':files,'guards':['task directory leaves owned root']}
    for base,dirs,names in os.walk(directory,followlinks=False):
        dirs[:]=[name for name in dirs if not(Path(base)/name).is_symlink()]
        for name in sorted(names):
            if not name.endswith('.json'):continue
            path=Path(base)/name;key=str(path.relative_to(root))
            if path.is_symlink():guards.append('unexpected task JSON symlink');continue
            if len(files)>=32:guards.append('task JSON file count exceeds32');return{'files':files,'guards':guards}
            if path.stat().st_size>65536 or retained+path.stat().st_size>1048576:guards.append('task JSON size/total bound exceeded');return{'files':files,'guards':guards}
            item=snapshot(root,path)
            if 'guard_error'in item:guards.append(key+':'+item['guard_error'])
            raw=item.pop('raw_text',None)
            if raw is not None:
                retained+=len(raw.encode());item['text']=raw
                try:item['json']=json.loads(raw)
                except ValueError:pass
            files[key]=item
    return{'files':files,'guards':guards}


def task_rows(tree):
    return{item['json']['id']:item['json']for item in tree['files'].values()if isinstance(item.get('json'),dict)and{'id','subject','status'}<=item['json'].keys()}


def child_metadata(root):
    files={};guards=[];directory=root/'config/projects';total=0
    if not directory.exists():return{'files':files,'guards':guards}
    for base,dirs,names in os.walk(directory,followlinks=False):
        dirs[:]=[name for name in dirs if not(Path(base)/name).is_symlink()]
        for name in sorted(names):
            path=Path(base)/name
            if'subagents'not in path.parts or not name.endswith('.meta.json'):continue
            if path.is_symlink():guards.append('unexpected native child metadata symlink');continue
            if len(files)>=16 or path.stat().st_size>1048576 or total+path.stat().st_size>2097152:guards.append('native child metadata bound');return{'files':files,'guards':guards}
            item=snapshot(root,path);text=item.pop('raw_text',None)
            if'guard_error'in item:guards.append(item['guard_error'])
            if text is not None:
                total+=len(text.encode())
                try:item['json']=json.loads(text)
                except ValueError:item['text']=text
            files[str(path.relative_to(root))]=item
    return{'files':files,'guards':guards}


class RuntimeMock(ChildWorkflowMock):
    def __init__(self,case):
        super().__init__(case);self.root=None;self.halt=None;self.responses=[];self.message_cap=PHASE_CAP
    def response(self,scope,generation):
        with self.lock:
            matching=[r for r in self.requests if r['scope']==scope and r['path'].split('?')[0]=='/v1/messages'];current=matching[generation-1]
            current['task_store_snapshot']=task_snapshot(self.root)
        expected={'parent':2,'child':2}if self.case=='builtin-default'else{'parent':3,'child':8}
        if generation>expected[scope]:self.halt='OWNED_CHILD_UNEXPECTED_GENERATION'
        if self.halt:content,stop=[{'type':'text','text':self.halt}],'end_turn'
        else:content,stop=super().response(scope,generation)
        self.responses.append({'scope':scope,'generation':generation,'content':content,'stop_reason':stop})
        return content,stop


def assertions(record):
    rows=models(record);parent=[r for r in rows if r['scope']=='parent'];child=[r for r in rows if r['scope']=='child'];case=record['case'];outcome=record['stages'][0]['result'];before=record['final_files'];hook_inputs=[r['input']for r in record['hook_lifecycle']if r.get('event')=='input']
    expected={'parent':2,'child':2}if case=='builtin-default'else{'parent':3,'child':8}
    checks={'cli_success':outcome['exit_code']==0 and not outcome['timed_out']and not outcome['output_limited'],'expected_messages':len(rows)==record['recipe']['expected_messages'],'scoped_counts':{'parent':len(parent),'child':len(child)}==expected,
            'no_mock_halt':record['halt']is None,'all_primary_models':bool(rows)and all(r['body'].get('model')==MODEL for r in rows),'parent_user_marker_absent':all(DELEGATION not in t for r in parent for t in user_texts(r['body'])),
            'child_user_marker_present':bool(child)and all(any(DELEGATION in t for t in user_texts(r['body']))for r in child),'input_unchanged':before['owned-child-input.txt']=='OWNED_CHILD_READ_FILE\n',
            'group_clean':not record['stages'][0]['cleanup']['remaining_members'],'hook_children_clean':not record['surviving_hook_pids']and len(record['hook_pids'])==record['recipe']['expected_hook_children'],
            'snapshot_guards_pass':not record['task_store_final']['guards']and not record['native_child_metadata']['guards']and all('guard_error'not in item for item in record['file_snapshots'].values())and'guard_error'not in record['hook_log_snapshot'],'final_parent_marker':'OWNED_PARENT_WORKFLOW_FINAL'in outcome['stdout']}
    if case=='builtin-default':
        committed=[b for r in parent for m in r['body'].get('messages',[])if m.get('role')=='assistant'for b in m.get('content',[])if isinstance(b,dict)and b.get('type')=='tool_use'and b.get('id')=='owned-childflow-parent-1']
        response=record['mock_responses'][0]['content'][0]if record['mock_responses']else{}
        checks.update({'model_omits_type':response.get('name')=='Agent'and'subagent_type'not in response.get('input',{}),'builtin_read_data':len(child)>1 and'OWNED_CHILD_READ_FILE'in json.dumps(results(child[1]['body']).get('owned-childflow-child-1')),
                       'builtin_child_toolset':bool(child)and set(t['name']for t in child[0]['body'].get('tools',[]))=={'Agent','Read'},'parent_child_report':len(parent)>1 and'OWNED_CHILD_DEFAULT_FINAL'in json.dumps(results(parent[1]['body']).get('owned-childflow-parent-1')),'no_hooks':not hook_inputs})
        if record['executable']=='original':
            try:stats=json.loads(outcome['stdout']).get('subagent_stats',{});checks['native_default_identity']=stats.get('by_type',{}).get('general-purpose')==1
            except ValueError:checks['native_default_identity']=False
    else:
        # Corrected from the original capture plus RPi attachment projection:
        # initial Start attachments precede delegation/preload users on wire.
        # Saved original raw assertions retain the refuted earlier prediction.
        first='\n'.join(user_texts(child[0]['body']))if child else'';positions=[first.find(marker)for marker in [START_MARKER,DELEGATION,'OWNED_CHILD_PASSIVE_A','OWNED_CHILD_PASSIVE_B']]
        final=task_rows(record['task_store_final']);task=final.get('1',{});parent_get=results(parent[2]['body']).get('owned-childflow-parent-2')if len(parent)>2 else None
        checks.update({'start_before_delegation_preload_order':all(i>=0 for i in positions)and positions==sorted(positions),'passive_dedup':first.count('OWNED_CHILD_PASSIVE_A')==1,'conditional_body_absent':'OWNED_CHILD_CONDITIONAL_BODY'not in first,
                       'child_declared_pool':bool(child)and set(t['name']for t in child[0]['body'].get('tools',[]))=={'Read','Write','Skill','TaskCreate','TaskGet','TaskUpdate','TaskList'},
                       'preload_write_held':len(child)>1 and results(child[1]['body']).get('owned-childflow-child-1',{}).get('is_error')is True and before['owned-preload-held.txt']is None,
                       'invoked_skill_body':len(child)>2 and all(marker in json.dumps(child[2]['body'].get('messages'))for marker in ['OWNED_CHILD_ACTIVE_SKILL_BODY','owned child argument']),
                       'write_after_skill':before['owned-child-written.txt']=='OWNED_CHILD_WRITTEN\n','live_child_effort':[r['body'].get('output_config',{}).get('effort')for r in child]==['high','high']+['low']*6,
                       'parent_effort_unaffected':all(r['body'].get('output_config',{}).get('effort')=='high'for r in parent),'shared_completed_task':len(final)==1 and task.get('subject')=='OWNED_CHILD_TASK'and task.get('status')=='completed',
                       'owned_task_metadata':task.get('metadata')=={'owned_child_marker':'OWNED_CHILD_TASK_METADATA'},'no_invented_owner':'owner'not in task,
                       'parent_shared_get':parent_get is not None and not parent_get.get('is_error',False)and all(t in json.dumps(parent_get)for t in ['OWNED_CHILD_TASK','completed']),
                       'one_child_start_hook':len(hook_inputs)==1 and hook_inputs[0].get('agent_type')=='owned-capable'and hook_inputs[0].get('hook_event_name')=='SubagentStart'})
    return checks


@contextmanager
def phase_guard(directory,executable,case):
    directory.mkdir(parents=True,exist_ok=True);lock=directory/('.'+executable+'-phase.lock')
    with lock.open('x')as stream:stream.write(str(os.getpid()))
    try:
        captures=[]
        for other in CASES:
            path=directory/(executable+'-'+other+'.json')
            if not path.exists():continue
            record=json.loads(path.read_text());captures.append(record)
            if not record.get('assertions')or not all(record['assertions'].values()):raise RuntimeError('Earlier phase assertions failed; review required before next case')
        used=sum(len(models(r))for r in captures);expected=4 if case=='builtin-default' else 11
        if len(captures)>=2 or used+expected>PHASE_CAP:raise RuntimeError('Phase CLI/request budget unavailable')
        if sum(len(r.get('hook_pids',[]))for r in captures)+(0 if case=='builtin-default'else 1)>2:raise RuntimeError('Phase hook-process budget unavailable')
        yield PHASE_CAP-used
    finally:lock.unlink()


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('executable',choices=['original','tau','readiness','bun-readiness']);parser.add_argument('case',choices=CASES);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/child-workflows');args=parser.parse_args()
    directory=args.artifacts.resolve();stem=args.executable+'-'+args.case
    if directory.exists()and any(directory.glob(stem+'.*')):raise RuntimeError('Refusing capture/bootstrap/failure receipt overwrite')
    source=verify();state=RuntimeMock(args.case)
    with phase_guard(directory,args.executable,args.case)as remaining:
      state.message_cap=remaining
      with child_isolation(directory,state,args.executable,stem)as isolation:
        state.root=isolation.root;state.file_path=isolation.root/'work/owned-child-input.txt';state.file_path.write_text('OWNED_CHILD_READ_FILE\n');node,runtime=copy_node_fixture_runtime(isolation.root);plan=recipe(isolation.root,node,args.case)
        if any(DELEGATION in text for key,text in plan['files'].items())or DELEGATION in plan['arguments'][1]:raise RuntimeError('Parent-owned fixture texts contain reserved delegation classifier marker')
        for name,text in plan['files'].items():path=Path(name);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)
        if plan['settings']:(isolation.root/'config/settings.json').write_text(json.dumps(plan['settings'])+'\n')
        fixture=Path(plan['fixture']);clone_file(REPO/'scripts/differential/child_capability_fixture.cjs',fixture)
        probe=isolation.sandbox([str(node),'-e','require("node:fs");process.stdout.write("owned-child-node-ready")'])
        if probe['exit_code']!=0 or probe['timed_out']or probe['stdout']!='owned-child-node-ready':raise RuntimeError('Copied Node fixture readiness failed before target copy')
        hook_probe=None
        if args.case=='child-capabilities':
            input_path=isolation.root/'child-hook-readiness-input.json';input_path.write_text(json.dumps({'hook_event_name':'SubagentStart','agent_type':'owned-capable','agent_id':'owned-readiness-agent'})+'\n')
            command='exec '+shlex.join([str(node),str(fixture),'hook',str(isolation.root/'hook-readiness.jsonl')])+' < '+shlex.quote(str(input_path));hook_probe=isolation.sandbox(['/bin/sh','-c',command])
            if hook_probe['exit_code']!=0 or hook_probe['timed_out']or START_MARKER not in hook_probe['stdout']:raise RuntimeError('Owned SubagentStart protocol readiness failed')
        arguments=list(plan['arguments'])
        port_runtime=None;port_probes=None
        if args.executable in ['tau','bun-readiness']:bun,entry,port_runtime,port_probes=prepare_bun_adapter(isolation,directory,stem)
        if args.executable=='original':command=[str(isolation.copy_target(PINNED_TARGET))];arguments.append('--no-session-persistence')
        elif args.executable=='tau':command=[str(bun),'--no-install',str(entry)]
        elif args.executable=='bun-readiness':command=[str(bun),'--no-install',str(fixture),'ready','http://127.0.0.1:'+str(isolation.port),args.case];arguments=[]
        else:command=[str(node),str(fixture),'ready','http://127.0.0.1:'+str(isolation.port),args.case];arguments=[]
        isolation.report['original_executed']=args.executable=='original';isolation.report['port_entrypoint_executed']=args.executable=='tau';outcome,cleanup=run_stage(isolation,command,arguments)
        log=snapshot(isolation.root,Path(plan['lifecycle_log']))if Path(plan['lifecycle_log']).exists()else{};logs=[json.loads(line)for line in log.get('raw_text','').splitlines()];pids=sorted({r['pid']for r in logs if r.get('event')=='start'});deadline=time.monotonic()+2
        while any(alive(pid)for pid in pids)and time.monotonic()<deadline:time.sleep(.05)
        file_snapshots={name:snapshot(isolation.root,isolation.root/'work'/name)if(isolation.root/'work'/name).exists()or(isolation.root/'work'/name).is_symlink()else{} for name in ['owned-child-input.txt','owned-preload-held.txt','owned-child-written.txt']}
        final_files={name:item.get('raw_text')for name,item in file_snapshots.items()}
        record={'case':args.case,'executable':args.executable,'target_sha256':TARGET_SHA256 if args.executable=='original'else None,'source_preflight':source,'isolation':isolation.report,'environment_overrides':ENV,'task_list_env_absent':'CLAUDE_CODE_TASK_LIST_ID'not in isolation.env,
                'runtime':runtime,'runtime_probe':probe,'port_runtime':port_runtime,'port_runtime_probes':port_probes,'hook_probe':hook_probe,'recipe':plan,'fixture_sha256':digest(fixture),'stages':[{'command':command,'arguments':arguments,'result':outcome,'cleanup':cleanup}],'requests':state.requests,'mock_responses':state.responses,'halt':state.halt,
                'scope_generations':state.generations,'hook_lifecycle':logs,'hook_log_snapshot':log,'hook_pids':pids,'surviving_hook_pids':[pid for pid in pids if alive(pid)],'final_files':final_files,'file_snapshots':file_snapshots,'task_store_final':task_snapshot(isolation.root),'native_child_metadata':child_metadata(isolation.root),
                'scope_classifier':'Unique owned delegation marker in direct USER text blocks only; no assistant input/tool_result/system/billing header heuristic','port_execution_adapter':'Copied Bun1.4.4 + --no-install + complete reverified src/runtime-dependency/package snapshot; Node reserved for owned fixtures; no shared build'if port_runtime else'Bun adapter unused; no port entrypoint executed','port_entrypoint_executed':args.executable=='tau',
                'bun_environment_overrides':{key:isolation.env[key]for key in ['BUN_INSTALL','BUN_INSTALL_CACHE_DIR','BUN_RUNTIME_TRANSPILER_CACHE_PATH']if key in isolation.env}}
        if args.executable in ['readiness','bun-readiness']:record['assertions']={'owned_runtime_protocol':outcome['exit_code']==0 and not outcome['timed_out']and not outcome['output_limited']and outcome['stdout']=='owned-child-workflow-ready','expected_mock_requests':len(models(record))==plan['expected_messages'],'expected_scopes':state.generations==plan['expected_scopes'],'no_halt':state.halt is None,'group_clean':not cleanup['remaining_members'],'task_env_absent':record['task_list_env_absent'],'no_port_entrypoint':not record['port_entrypoint_executed']}
        else:record['assertions']=assertions(record)
        (directory/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for stream in ['stdout','stderr']:(directory/(stem+'.'+stream+'.txt')).write_text(outcome[stream])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(directory/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case':args.case,'executable':args.executable,'messages':len(models(record)),'scopes':state.generations,'hook_children':len(pids),'assertions':record['assertions'],'original_executed':args.executable=='original','port_executed':args.executable=='tau'}))
    if not all(record['assertions'].values()):raise SystemExit(3)


if __name__=='__main__':main()
