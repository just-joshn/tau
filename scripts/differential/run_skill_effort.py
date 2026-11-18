#!/usr/bin/env python3
"""Three owned Skill effort cases; fixed model, unique IDs, fresh isolation."""
import argparse
from contextlib import contextmanager
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import threading

from isolation import REPO, TARGET_SHA256, Isolation
from mock_api import events
from run_tau import copy_runtime
from run_skills import run_stage

MODEL = 'claude-sonnet-4-6'
CASES = ['skill-low','env-medium','cap-medium']


@contextmanager
def verified_effort_isolation(artifacts, handler, overrides):
    # Same Isolation/profile/canaries; set the sole owned fixture variable before
    # the first verification, since verify() deliberately owns one Unix socket.
    isolation=Isolation(artifacts,handler)
    try:
        isolation.env.update(overrides);isolation.verify();yield isolation
    finally:isolation.close()


class EffortMock:
    def __init__(self, case): self.case=case;self.requests=[];self.generation=0;self.lock=threading.Lock()
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
                    state.requests.append({'path':self.path,'body':retained,'safe_headers':{name:self.headers.get(name) for name in ['anthropic-beta','anthropic-version','content-type','x-app'] if self.headers.get(name) is not None}})
                    if not count:state.generation+=1
                    generation=state.generation
                if count:
                    self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":32}');return
                if self.path.split('?')[0]!='/v1/messages' or generation>3:self.send_response(400);self.end_headers();return
                if generation==1:content=[{'type':'tool_use','id':'owned-effort-tool-1','name':'Skill','input':{'skill':'owned-effort','args':'owned argument'}}];stop='tool_use'
                else:content=[{'type':'text','text':'OWNED_EFFORT_FINAL'}];stop='end_turn'
                identity='msg_owned_effort_'+state.case+'_'+str(generation)
                if body.get('stream'):
                    wire=events(content,stop,body.get('model',MODEL));wire[0]['message']['id']=identity
                    self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(''.join('event: '+item['type']+'\ndata: '+json.dumps(item)+'\n\n' for item in wire).encode())
                else:
                    self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':identity,'type':'message','role':'assistant','model':body.get('model',MODEL),'content':content,'stop_reason':stop,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':3}}).encode())
        return Handler


def verify_source():
    manifest=json.loads((REPO/'artifacts/bundle-manifest.json').read_text());modules={m['name']:m for m in manifest['modules']}
    wanted={'effort_parser_env_override','effort_settings_and_server_caps','effort_query_env_hook_precedence_and_clamping','scheduler_request_model_and_live_effort_options','request_output_config_effort_serialization','request_existing_output_config_merge_and_refusal'}
    spans=[r for r in json.loads((REPO/'artifacts/skill-model-effort-research/spans.json').read_text()) if r['id'] in wanted]
    spans += [r for r in json.loads((REPO/'artifacts/skills-research/spans.json').read_text()) if r['id'] in ['effort_parser','skill_fields_paths_hook_guard']]
    name='chunk-m33vdkhs.js';data=(REPO/'artifacts/claude-bundle'/name).read_bytes();start=data.index(b'maxEffortLevel:()=>B(Hi)');end=data.index(b'modelSettings:',start)
    spans.append({'id':'user_max_effort_setting_schema','module':name,'offset':modules[name]['offset']+start,'length':end-start,'sha256':hashlib.sha256(data[start:end]).hexdigest(),'text':data[start:end].decode()})
    with Path('/Users/josh-desktop/.local/bin/claude').open('rb') as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned target mismatch')
        for name in {span['module'] for span in spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Source module mismatch')
        for span in spans:
            target.seek(span['offset']);raw=target.read(span['length'])
            if hashlib.sha256(raw).hexdigest()!=span['sha256'] or raw.decode()!=span['text']:raise RuntimeError('Source span mismatch')
    return {'target_sha256':TARGET_SHA256,'spans':spans,'all_equal':True,'original_executed':False,'recovered_code_executed':False,
            'fixture_review':'known explicit model claude-sonnet-4-6; effort low/high scalar; user maxEffortLevel medium admitted schema; only owned CLAUDE_CODE_EFFORT_LEVEL override; no grants/hooks/executable Skill body'}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('executable',choices=['original','tau']);parser.add_argument('case',choices=CASES)
    parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/skill-effort');args=parser.parse_args();artifacts=args.artifacts.resolve()
    stem=args.executable+'-'+args.case
    if (artifacts/(stem+'.json')).exists():raise RuntimeError('Refusing overwrite')
    source=verify_source();state=EffortMock(args.case)
    overrides={'CLAUDE_CODE_EFFORT_LEVEL':'medium'} if args.case=='env-medium' else {}
    with verified_effort_isolation(artifacts,state.handler(),overrides) as isolation:
        settings={'maxEffortLevel':'medium'} if args.case=='cap-medium' else {}
        if settings:(isolation.root/'config/settings.json').write_text(json.dumps(settings)+'\n')
        level='low' if args.case=='skill-low' else 'high'
        skill_text='---\ndescription: Owned effort differential fixture\neffort: '+level+'\n---\nOWNED_EFFORT_BODY_'+level.upper()+'\nOWNED_EFFORT_ARGS $ARGUMENTS\n'
        skill=isolation.root/'work/.claude/skills/owned-effort/SKILL.md';skill.parent.mkdir(parents=True);skill.write_text(skill_text)
        runtime=None;probe=None;skipped=[]
        if args.executable=='original':command=[str(isolation.copy_target(Path('/Users/josh-desktop/.local/bin/claude')))]
        else:
            node,entry,runtime=copy_runtime(isolation.root);probe=isolation.sandbox([str(node),'-e','process.stdout.write("owned-effort-node-ready")'])
            if probe['exit_code']!=0 or probe['timed_out'] or probe['stdout']!='owned-effort-node-ready':raise RuntimeError('Copied Node bootstrap failed')
            command=[str(node),'--preserve-symlinks','--preserve-symlinks-main',str(entry)]
        arguments=['--print','OWNED_EFFORT_'+args.case.upper(),'--model',MODEL,'--output-format','json','--tools','Skill','--allowedTools','Skill']
        if args.executable=='original':arguments.append('--no-session-persistence')
        else:skipped.append('--no-session-persistence')
        isolation.report['original_executed']=args.executable=='original';result,cleanup=run_stage(isolation,command,arguments)
        record={'case':args.case,'executable':args.executable,'target_sha256':TARGET_SHA256 if args.executable=='original' else None,'isolation':isolation.report,
                'runtime':runtime,'runtime_probe':probe,'source_preflight':source,'environment_overrides':overrides,'user_settings':settings,'fixture_skill':skill_text,
                'response_identity':'unique msg_owned_effort_CASE_GENERATION per response','skipped_original_flags':skipped,
                'stages':[{'arguments':arguments,'result':result,'cleanup':cleanup,'request_start':0,'request_end':len(state.requests)}],
                'requests':state.requests,'final_files':{},'hooks_configured':False}
        (artifacts/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for stream in ['stdout','stderr']:(artifacts/(stem+'.'+stream+'.txt')).write_text(result[stream])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10)
        (artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case':args.case,'executable':args.executable,'exit':result['exit_code'],'remaining_group_members':cleanup['remaining_members'],
                          'requests':[{'model':r['body'].get('model'),'output_config':r['body'].get('output_config'),'thinking':r['body'].get('thinking'),'headers':r['safe_headers']} for r in state.requests]}))


if __name__=='__main__':main()
