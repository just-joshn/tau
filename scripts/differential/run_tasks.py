#!/usr/bin/env python3
"""Bounded authored native Task CRUD cases in fresh verified isolation."""
import argparse
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import threading
import time

from isolation import REPO, TARGET_SHA256, clone_file
from mock_api import events
from run_skills import run_stage
from run_skill_effort import verified_effort_isolation
from run_skill_hooks import verify_source as verify_hook_source
from run_tau import copy_runtime, digest
from run_hooks import alive

MODEL='claude-sonnet-4-6'
CASES=['crud','missing','completion-block']
ENV={'CLAUDE_CODE_ENABLE_TASKS':'1','CLAUDE_CODE_ENABLE_TODO_TOOLS':'1','CLAUDE_CODE_TASK_LIST_ID':'owned-task-list'}


def actions(case):
    create={'subject':'OWNED_TASK_ALPHA','description':'OWNED_TASK_ALPHA_DESCRIPTION','activeForm':'Owned alpha active','metadata':{'keep':'initial','remove':'keep-through-block','counter':1}}
    if case=='missing':return [('TaskGet',{'taskId':'999'}),('TaskUpdate',{'taskId':'999','status':'in_progress','metadata':{'owned':'missing'}}),('TaskList',{})]
    if case=='completion-block':return [('TaskCreate',create),('TaskUpdate',{'taskId':'1','status':'completed','subject':'OWNED_SHOULD_NOT_RENAME','description':'OWNED_SHOULD_NOT_REDESCRIBE','activeForm':'OWNED_SHOULD_NOT_ACTIVE','metadata':{'blocked_attempt':True,'remove':None},'addBlocks':['1'],'addBlockedBy':['1']}),('TaskGet',{'taskId':'1'}),('TaskUpdate',{'taskId':'1','status':'completed','metadata':{'passed':True}}),('TaskList',{})]
    return [('TaskCreate',create),('TaskCreate',{'subject':'OWNED_TASK_BETA','description':'OWNED_TASK_BETA_DESCRIPTION'}),('TaskGet',{'taskId':'1'}),
            ('TaskUpdate',{'taskId':'1','subject':'OWNED_TASK_ALPHA_UPDATED','description':'OWNED_TASK_ALPHA_DESCRIPTION_UPDATED','activeForm':'Owned alpha updated','status':'in_progress','addBlocks':['2'],'addBlockedBy':['2'],'metadata':{'remove':None,'counter':2,'added':True}}),
            ('TaskList',{}),('TaskUpdate',{'taskId':'1','status':'completed'}),('TaskUpdate',{'taskId':'1','status':'pending','metadata':{'nonmonotone':True}}),('TaskGet',{'taskId':'1'})]


def task_snapshot(root):
    if root is None:return {}
    result={};directory=root/'config/tasks/owned-task-list'
    if directory.exists():
        for path in sorted(directory.rglob('*')):
            if path.is_symlink() or not path.is_file():continue
            raw=path.read_bytes()
            item={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            if path.suffix=='.json' and len(raw)<=1024*1024:
                try:item['json']=json.loads(raw)
                except ValueError:pass
            result[str(path.relative_to(root))]=item
    return result


class TaskMock:
    def __init__(self,case):self.case=case;self.requests=[];self.generation=0;self.lock=threading.Lock();self.root=None
    def handler(self):
        state=self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*_args):pass
            def do_POST(self):
                length=int(self.headers.get('content-length','0'))
                if length<0 or length>32*1024*1024:self.send_response(413);self.end_headers();return
                try:body=json.loads(self.rfile.read(length))
                except ValueError:self.send_response(400);self.end_headers();return
                count=self.path.split('?')[0]=='/v1/messages/count_tokens'
                with state.lock:
                    retained=dict(body);retained.pop('metadata',None)
                    state.requests.append({'path':self.path,'body':retained,'task_store_snapshot':task_snapshot(state.root),'safe_headers':{name:self.headers.get(name) for name in ['anthropic-beta','anthropic-version','content-type','x-app'] if self.headers.get(name) is not None}})
                    if not count:state.generation+=1
                    generation=state.generation
                if count:self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":32}');return
                plan=actions(state.case)
                if self.path.split('?')[0]!='/v1/messages' or generation>len(plan)+1:self.send_response(400);self.end_headers();return
                if generation<=len(plan):
                    name,value=plan[generation-1];content=[{'type':'tool_use','id':'owned-task-tool-'+str(generation),'name':name,'input':value}];stop='tool_use'
                else:content=[{'type':'text','text':'OWNED_TASK_FINAL_'+state.case.upper()}];stop='end_turn'
                identity='msg_owned_task_'+state.case+'_'+str(generation)
                if body.get('stream'):
                    wire=events(content,stop,body.get('model',MODEL));wire[0]['message']['id']=identity
                    self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(''.join('event: '+item['type']+'\ndata: '+json.dumps(item)+'\n\n' for item in wire).encode())
                else:
                    self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':identity,'type':'message','role':'assistant','model':body.get('model',MODEL),'content':content,'stop_reason':stop,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':3}}).encode())
        return Handler


def verify_source(case):
    manifest=json.loads((REPO/'artifacts/bundle-manifest.json').read_text());modules={m['name']:m for m in manifest['modules']}
    proof_path=REPO/'artifacts/tasks-research/spans.json';spans=json.loads(proof_path.read_text())
    required={'task_environment_enable','task_model_enable_gate','task_create_input_variants_and_output','task_get_schema_and_projection','task_update_input_and_output','task_list_schema','task_list_identity_and_storage_path','configuration_root_env','task_default_native_permission','task_strict_object_constructor','task_update_mutation_completion_and_edges'}
    if len(spans)<25 or not required<={r['id'] for r in spans}:raise RuntimeError('Task source/schema handshake incomplete')
    with Path('/Users/josh-desktop/.local/bin/claude').open('rb') as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned target mismatch')
        for name in {r['module'] for r in spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Source module mismatch')
        for span in spans:
            target.seek(span['offset']);raw=target.read(span['length'])
            if hashlib.sha256(raw).hexdigest()!=span['sha256'] or raw.decode()!=span['text']:raise RuntimeError('Installed task source mismatch')
    hooks=verify_hook_source() if case=='completion-block' else None
    if hooks is not None:
        name='chunk-m33vdkhs.js';data=(REPO/'artifacts/claude-bundle'/name).read_bytes();i=data.index(b'Yc=[');j=data.index(b'],r9a=',i)+1;raw=data[i:j]
        if b'"TaskCompleted"' not in raw:raise RuntimeError('TaskCompleted event missing from schema')
        with Path('/Users/josh-desktop/.local/bin/claude').open('rb') as target:
            target.seek(modules[name]['offset']+i)
            if target.read(len(raw))!=raw:raise RuntimeError('Installed event schema mismatch')
        hooks['spans'].append({'id':'task_completed_event_schema','module':name,'offset':modules[name]['offset']+i,'length':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'equal':True,'text':raw.decode()})
    return {'target_sha256':TARGET_SHA256,'all_equal':True,'proof_sha256':digest(proof_path),'spans':spans,'hook_schema':hooks,'recovered_code_executed':False,
            'review':'Exact source-owner handshake gates, strict schemas and native permissions; fixed dummy list identity/config root; no owner/team/remote/stop/deleted operations. Cycles, metadata null removal and nonmonotone status are source-permitted.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('executable',choices=['original','tau']);parser.add_argument('case',choices=CASES);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/tasks');args=parser.parse_args();artifacts=args.artifacts.resolve();stem=args.executable+'-'+args.case
    if (artifacts/(stem+'.json')).exists():raise RuntimeError('Refusing capture overwrite')
    source=verify_source(args.case);state=TaskMock(args.case)
    with verified_effort_isolation(artifacts,state.handler(),ENV) as isolation:
        state.root=isolation.root;runtime=None;probe=None;hook_config={};lifecycle=isolation.root/'task-hooks.jsonl';fixture_sha=None
        if args.executable=='tau' or args.case=='completion-block':
            node,entry,runtime=copy_runtime(isolation.root)
            if args.case=='completion-block':
                fixture=isolation.root/'task-hook-fixture.cjs';clone_file(REPO/'scripts/differential/task_hook_fixture.cjs',fixture);fixture_sha=digest(fixture)
                probe=isolation.sandbox([str(node),str(fixture),'ready',str(isolation.root/'task-hook-ready.jsonl')])
                expected='owned-task-hook-ready';hook_config={'hooks':{'TaskCompleted':[{'hooks':[{'type':'command','command':str(node),'args':[str(fixture),'hook',str(lifecycle)],'timeout':3}]}]}}
                (isolation.root/'config/settings.json').write_text(json.dumps(hook_config)+'\n')
            else:probe=isolation.sandbox([str(node),'-e','process.stdout.write("owned-task-node-ready")']);expected='owned-task-node-ready'
            if probe['exit_code']!=0 or probe['timed_out'] or probe['stdout']!=expected:raise RuntimeError('Copied fixture/runtime failed unchanged sandbox')
        if args.executable=='original':command=[str(isolation.copy_target(Path('/Users/josh-desktop/.local/bin/claude')))]
        else:command=[str(node),'--preserve-symlinks','--preserve-symlinks-main',str(entry)]
        arguments=['--print','OWNED_TASK_'+args.case.upper(),'--model',MODEL,'--output-format','json','--tools','TaskCreate,TaskGet,TaskUpdate,TaskList'];skipped=[]
        if args.executable=='original':arguments.append('--no-session-persistence')
        else:skipped.append('--no-session-persistence')
        isolation.report['original_executed']=args.executable=='original';result,cleanup=run_stage(isolation,command,arguments)
        logs=[json.loads(line) for line in lifecycle.read_text().splitlines()] if lifecycle.exists() else [];pids=sorted({row['pid'] for row in logs if row.get('event')=='start'})
        deadline=time.monotonic()+2
        while any(alive(pid) for pid in pids) and time.monotonic()<deadline:time.sleep(.05)
        survivors=[pid for pid in pids if alive(pid)]
        record={'case':args.case,'executable':args.executable,'target_sha256':TARGET_SHA256 if args.executable=='original' else None,'isolation':isolation.report,'environment_overrides':ENV,
                'runtime':runtime,'runtime_probe':probe,'source_preflight':source,'settings':hook_config,'fixture_sha256':fixture_sha,'response_identity':'unique msg_owned_task_CASE_GENERATION per response',
                'stages':[{'arguments':arguments,'result':result,'cleanup':cleanup,'request_start':0,'request_end':len(state.requests)}],'requests':state.requests,'task_store_final':task_snapshot(isolation.root),
                'hook_lifecycle':logs,'hook_pids':pids,'surviving_hook_pids':survivors,'skipped_original_flags':skipped}
        (artifacts/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for stream in ['stdout','stderr']:(artifacts/(stem+'.'+stream+'.txt')).write_text(result[stream])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case':args.case,'executable':args.executable,'exit':result['exit_code'],'messages':sum(r['path'].split('?')[0]=='/v1/messages' for r in state.requests),'remaining_group_members':cleanup['remaining_members'],'hook_pids':pids,'hook_exit_codes':[r['code'] for r in logs if r.get('event')=='exit'],'surviving_hook_pids':survivors,'task_store':record['task_store_final']}))


if __name__=='__main__':main()
