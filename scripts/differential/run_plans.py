#!/usr/bin/env python3
"""Owned file-backed Plan flows through a source-backed stdio MCP approval peer."""
import argparse
import hashlib
import http.server
import json
from pathlib import Path
import re
import shlex
import subprocess
import threading
import time

from isolation import REPO,TARGET_SHA256,clone_file,verified_isolation
from mock_api import events
from run_skills import run_stage
from run_tau import copy_runtime,digest
from run_hooks import alive
from verify_plan_bridge import verify

MODEL='claude-sonnet-4-6'
CASES=['approve','reject']


def plan_snapshot(directory):
    return {path.name:{'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'text':raw.decode()} for path in sorted(directory.glob('*.md')) if not path.is_symlink() and path.is_file() and len(raw:=path.read_bytes())<=65536}


class PlanMock:
    def __init__(self,case):self.case=case;self.requests=[];self.generation=0;self.lock=threading.Lock();self.plan_directory=None;self.designated=None;self.halt=None
    def action(self,generation,body):
        if generation==1:return ('EnterPlanMode',{})
        if self.designated is None:
            found=set(re.findall(re.escape(str(self.plan_directory))+r'/[a-z0-9-]+\.md',json.dumps(body)))
            found={path for path in found if '-agent-' not in Path(path).name}
            if len(found)!=1:self.halt='OWNED_PLAN_DESIGNATED_PATH_UNAVAILABLE';return None
            self.designated=next(iter(found))
        path=self.designated
        actions=[('EnterPlanMode',{}),('Write',{'file_path':path,'content':'OWNED_PLAN_DRAFT\n'}),('Read',{'file_path':path}),('Edit',{'file_path':path,'old_string':'OWNED_PLAN_DRAFT','new_string':'OWNED_PLAN_FINAL'}),('ExitPlanMode',{})]
        if self.case=='reject':actions += [('Read',{'file_path':path}),('ExitPlanMode',{})]
        actions += [('ExitPlanMode',{})]
        return actions[generation-1] if generation<=len(actions) else None
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
                    state.requests.append({'path':self.path,'body':retained,'plan_snapshot':plan_snapshot(state.plan_directory),'safe_headers':{name:self.headers.get(name) for name in ['anthropic-beta','anthropic-version','content-type','x-app'] if self.headers.get(name) is not None}})
                    if not count:state.generation+=1
                    generation=state.generation
                if count:self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":32}');return
                if self.path.split('?')[0]!='/v1/messages' or generation>(7 if state.case=='approve' else 9):self.send_response(400);self.end_headers();return
                action=state.action(generation,body)
                if action and not state.halt:
                    name,value=action;content=[{'type':'tool_use','id':'owned-plan-tool-'+str(generation),'name':name,'input':value}];stop='tool_use'
                else:content=[{'type':'text','text':state.halt or 'OWNED_PLAN_FINAL_RESPONSE_'+state.case.upper()}];stop='end_turn'
                identity='msg_owned_plan_'+state.case+'_'+str(generation)
                if body.get('stream'):
                    wire=events(content,stop,body.get('model',MODEL));wire[0]['message']['id']=identity
                    self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(''.join('event: '+item['type']+'\ndata: '+json.dumps(item)+'\n\n' for item in wire).encode())
                else:
                    self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':identity,'type':'message','role':'assistant','model':body.get('model',MODEL),'content':content,'stop_reason':stop,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':3}}).encode())
        return Handler


def fixture_protocol_probe(isolation,node,fixture,case,directory):
    lifecycle=isolation.root/'permission-probe.jsonl';input_path=isolation.root/'permission-probe-input.jsonl'
    args={'tool_name':'ExitPlanMode','input':{'plan':'OWNED_PLAN_FINAL\n','planFilePath':str(directory/'proof.md')},'tool_use_id':'owned-permission-proof'}
    requests=[{'jsonrpc':'2.0','id':0,'method':'server/discover'},{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'owned-proof','version':'1'}}},{'jsonrpc':'2.0','id':2,'method':'tools/list'},{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'decide','arguments':args}},{'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'decide','arguments':args}}]
    input_path.write_text(''.join(json.dumps(row)+'\n' for row in requests))
    shell='exec '+shlex.join([str(node),str(fixture),'mcp',str(lifecycle),case,str(directory)])+' < '+shlex.quote(str(input_path))
    outcome=isolation.sandbox(['/bin/sh','-c',shell]);responses=[json.loads(line) for line in outcome['stdout'].splitlines()]
    decisions=[json.loads(row['result']['content'][0]['text']) for row in responses if row.get('id') in [3,4]]
    expected=['allow','allow'] if case=='approve' else ['deny','allow']
    logs=[json.loads(line) for line in lifecycle.read_text().splitlines()];pids={row['pid'] for row in logs}
    if outcome['exit_code']!=0 or outcome['timed_out'] or len(responses)!=5 or [row['behavior'] for row in decisions]!=expected or any(alive(pid) for pid in pids):raise RuntimeError('Owned permission fixture protocol proof failed; original execution forbidden')
    return {'requests':requests,'responses':responses,'result':outcome,'lifecycle':logs,'pids_finished':True}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('executable',choices=['original','tau']);parser.add_argument('case',choices=CASES);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/plans');args=parser.parse_args();artifacts=args.artifacts.resolve();stem=args.executable+'-'+args.case
    if (artifacts/(stem+'.json')).exists():raise RuntimeError('Refusing capture overwrite')
    source=verify();state=PlanMock(args.case)
    with verified_isolation(artifacts,state.handler()) as isolation:
        directory=isolation.root/'work/owned-plans';directory.mkdir();state.plan_directory=directory
        settings={'plansDirectory':'owned-plans'};(isolation.root/'config/settings.json').write_text(json.dumps(settings)+'\n')
        node,entry,runtime=copy_runtime(isolation.root);fixture=isolation.root/'plan-permission-fixture.mjs';clone_file(REPO/'scripts/differential/plan_permission_fixture.mjs',fixture)
        probe=fixture_protocol_probe(isolation,node,fixture,args.case,directory)
        lifecycle=isolation.root/'permission-lifecycle.jsonl'
        config={'mcpServers':{'ownedplans':{'type':'stdio','command':str(node),'args':[str(fixture),'mcp',str(lifecycle),args.case,str(directory)],'alwaysLoad':True}}}
        arguments=['--print','OWNED_PLAN_WORKFLOW_'+args.case.upper(),'--model',MODEL,'--output-format','json','--tools','EnterPlanMode,ExitPlanMode,Write,Read,Edit','--mcp-config',json.dumps(config),'--strict-mcp-config','--permission-prompt-tool','mcp__ownedplans__decide','--permission-prompts','host'];skipped=[]
        if args.executable=='original':command=[str(isolation.copy_target(Path('/Users/josh-desktop/.local/bin/claude')))];arguments.append('--no-session-persistence')
        else:command=[str(node),'--preserve-symlinks','--preserve-symlinks-main',str(entry)];skipped.append('--no-session-persistence')
        isolation.report['original_executed']=args.executable=='original';result,cleanup=run_stage(isolation,command,arguments)
        logs=[json.loads(line) for line in lifecycle.read_text().splitlines()] if lifecycle.exists() else [];pids=sorted({row['pid'] for row in logs if row.get('event')=='start'})
        deadline=time.monotonic()+2
        while any(alive(pid) for pid in pids) and time.monotonic()<deadline:time.sleep(.05)
        survivors=[pid for pid in pids if alive(pid)]
        record={'case':args.case,'executable':args.executable,'target_sha256':TARGET_SHA256 if args.executable=='original' else None,'isolation':isolation.report,'source_preflight':source,
                'runtime':runtime,'fixture_sha256':digest(fixture),'fixture_protocol_probe':probe,'settings':settings,'mcp_config':config,'mcp_lifecycle':logs,'mcp_pids':pids,'surviving_mcp_pids':survivors,
                'stages':[{'arguments':arguments,'result':result,'cleanup':cleanup}],'requests':state.requests,'designated_plan':state.designated,'halt':state.halt,'final_plans':plan_snapshot(directory),
                'response_identity':'unique msg_owned_plan_CASE_GENERATION','skipped_original_flags':skipped}
        (artifacts/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for stream in ['stdout','stderr']:(artifacts/(stem+'.'+stream+'.txt')).write_text(result[stream])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case':args.case,'executable':args.executable,'exit':result['exit_code'],'messages':sum(r['path'].split('?')[0]=='/v1/messages' for r in state.requests),'halt':state.halt,'designated_plan':state.designated,'final_plans':record['final_plans'],'decisions':[r['decision']['behavior'] for r in logs if r.get('event')=='decision'],'mcp_pids':pids,'survivors':survivors,'remaining_group_members':cleanup['remaining_members']}))


if __name__=='__main__':main()
