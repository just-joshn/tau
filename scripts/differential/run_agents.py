#!/usr/bin/env python3
"""Owned foreground custom-agent controls; use only after root execution go."""
import argparse
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import threading

from isolation import REPO,TARGET_SHA256
from mock_api import events
from run_skills import run_stage
from run_skill_effort import verified_effort_isolation
from run_tau import copy_runtime,digest

MODEL='claude-sonnet-4-6'
CASES=['reader','unknown']
POLICY_CASES={'named-ask':'Agent(owned-reader)','field-ask':'Agent(subagent_type:owned*)'}
ENV={'CLAUDE_CODE_FORK_SUBAGENT':'0'}
SYSTEM_MARKER='OWNED_AGENT_SYSTEM_READER'
REQUIRED={'agent_background_default_selection','agent_call_required_schema','agent_call_background_schema','agent_call_name_mode_isolation_schema','agent_launch_depth_guard',
          'agent_type_explicit_permission_and_availability','agent_fresh_type_exact_and_normalized_lookup','agent_child_model_and_effort_selection','agent_child_prompt_fresh_context',
          'agent_foreground_registration_abort_relay','agent_foreground_result','agent_nesting_cap','agent_fork_disable_gate','agent_scope_filter','agent_child_runquery_parameters'}


def strings(value):
    if isinstance(value,str):yield value
    elif isinstance(value,list):
        for item in value:yield from strings(item)
    elif isinstance(value,dict):
        for item in value.values():yield from strings(item)


class AgentMock:
    def __init__(self,case):self.case=case;self.requests=[];self.serial=0;self.generations={'parent':0,'child':0};self.lock=threading.Lock();self.file_path=None;self.message_cap=8
    def scope(self,body):return 'child' if any(SYSTEM_MARKER in text for text in strings(body.get('system'))) else 'parent'
    def response(self,scope,generation):
        if scope=='parent' and generation==1:
            args={'description':'Owned foreground read','prompt':'OWNED_AGENT_CHILD_REQUEST\nRead exactly once from '+str(self.file_path)+' then return OWNED_AGENT_CHILD_FINAL.','subagent_type':'owned-missing' if self.case=='unknown' else 'owned-reader','run_in_background':False}
            return [{'type':'tool_use','id':'owned-agent-parent-tool','name':'Agent','input':args}],'tool_use'
        if scope=='child' and generation==1:return [{'type':'tool_use','id':'owned-agent-child-read','name':'Read','input':{'file_path':str(self.file_path)}}],'tool_use'
        return [{'type':'text','text':'OWNED_AGENT_CHILD_FINAL' if scope=='child' else 'OWNED_AGENT_PARENT_FINAL'}],'end_turn'
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
                scope=state.scope(body)
                with state.lock:
                    retained=dict(body);retained.pop('metadata',None)
                    state.requests.append({'path':self.path,'scope':scope,'body':retained,'owned_system_marker_present':any(SYSTEM_MARKER in text for text in strings(body.get('system'))),'safe_headers':{name:self.headers.get(name) for name in ['anthropic-beta','anthropic-version','content-type','x-app'] if self.headers.get(name) is not None}})
                    if not count:state.serial+=1;state.generations[scope]+=1
                    serial=state.serial;generation=state.generations[scope]
                if count:self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":32}');return
                if self.path.split('?')[0]!='/v1/messages' or serial>state.message_cap:self.send_response(400);self.end_headers();return
                content,stop=state.response(scope,generation)
                identity='msg_owned_agent_'+state.case+'_'+scope+'_'+str(generation)
                if body.get('stream'):
                    wire=events(content,stop,body.get('model',MODEL));wire[0]['message']['id']=identity
                    self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(''.join('event: '+item['type']+'\ndata: '+json.dumps(item)+'\n\n' for item in wire).encode())
                else:
                    self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':identity,'type':'message','role':'assistant','model':body.get('model',MODEL),'content':content,'stop_reason':stop,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':3}}).encode())
        return Handler


def verify_source(case=None):
    manifest=json.loads((REPO/'artifacts/bundle-manifest.json').read_text());modules={m['name']:m for m in manifest['modules']}
    runtime_path=REPO/'artifacts/subagents-research/spans.json';definitions_path=REPO/'artifacts/agents-research/spans.json'
    runtime=json.loads(runtime_path.read_text());definitions=json.loads(definitions_path.read_text())
    if len(runtime)<34 or not REQUIRED<={r['id'] for r in runtime} or len(definitions)<68:raise RuntimeError('Foreground agent source handshake incomplete')
    policy_path=REPO/'artifacts/agent-policy-research/spans.json'
    policy=json.loads(policy_path.read_text()) if case in POLICY_CASES else []
    policy_required={'agent_rule_exact_type_deny_and_ask_helpers','agent_rule_generic_whole_tool_match','agent_rule_generic_ask_deny_content_boundary','agent_rule_primitive_field_pattern_match','agent_rule_generic_permission_check_order','agent_type_ask_background_resume_eligibility','agent_type_ask_observer_gate','agent_tool_custom_permission_check'}
    if case in POLICY_CASES and (len(policy)<31 or not policy_required<={r['id'] for r in policy}):raise RuntimeError('Agent ask-control source handshake incomplete')
    spans=runtime+definitions+policy
    with Path('/Users/josh-desktop/.local/bin/claude').open('rb') as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned target mismatch')
        for name in {r['module'] for r in spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Source module differs')
        for row in spans:
            target.seek(row['offset']);raw=target.read(row['length'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256'] or raw.decode()!=row['text']:raise RuntimeError('Installed agent source differs')
    absence=None
    if policy:
        data=(REPO/'artifacts/claude-bundle/chunk-856xesd8.js').read_bytes()
        if b'G9r' in data or b'ruleContentField' in data:raise RuntimeError('Fresh Agent rule-consumer assumption changed')
        absence={'module_sha256':hashlib.sha256(data).hexdigest(),'no_G9r':True,'no_ruleContentField':True}
    return {'target_sha256':TARGET_SHA256,'all_equal':True,'runtime_spans':runtime,'definition_spans':definitions,'policy_spans':policy,'policy_proof_sha256':digest(policy_path) if policy else None,'fresh_module_absence_proof':absence,'recovered_code_executed':False,
            'runtime_proof_sha256':digest(runtime_path),'definitions_proof_sha256':digest(definitions_path),
            'review':'Explicit foreground false plus own fork-disable env; custom Read-only definition and inherited explicit full model; no native background/resume/team/worktree/remote, hooks, memory, or MCP.'}


def transcript_manifest(root):
    directory=root/'config/projects';result={}
    if directory.exists():
        for path in directory.rglob('*'):
            if path.is_symlink() or not path.is_file() or 'subagents'not in path.parts:continue
            raw=path.read_bytes();result[str(path.relative_to(root))]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
    return result


def tau_child_archives(root):
    directory=root/'tau-state/sessions';result={}
    if directory.exists():
        for path in directory.rglob('*.json'):
            if path.is_symlink() or not path.is_file() or 'subagents'not in path.parts:continue
            raw=path.read_bytes();item={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            if len(raw)<=1024*1024:
                try:item['json']=json.loads(raw)
                except ValueError:pass
            result[str(path.relative_to(root))]=item
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('executable',choices=['original','tau']);parser.add_argument('case',choices=[*CASES,*POLICY_CASES]);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/agents');args=parser.parse_args();artifacts=args.artifacts.resolve();stem=args.executable+'-'+args.case
    if (artifacts/(stem+'.json')).exists():raise RuntimeError('Refusing capture overwrite')
    proof=verify_source(args.case);state=AgentMock(args.case)
    with verified_effort_isolation(artifacts,state.handler(),ENV) as isolation:
        fixture='---\nname: owned-reader\ndescription: Owned read-only custom-agent fixture\ntools: Read\nmodel: inherit\nmaxTurns: 3\n---\n'+SYSTEM_MARKER+'\nRead only the exact owned file path supplied in the delegation request. Return the owned read marker and stop.\n'
        definition=isolation.root/'work/.claude/agents/owned-reader.md';definition.parent.mkdir(parents=True);definition.write_text(fixture)
        settings={'permissions':{'ask':[POLICY_CASES[args.case]]}} if args.case in POLICY_CASES else {}
        if settings:(isolation.root/'config/settings.json').write_text(json.dumps(settings)+'\n')
        state.file_path=isolation.root/'work/owned-agent-input.txt';state.file_path.write_text('OWNED_AGENT_FILE\n');before=state.file_path.read_bytes()
        runtime=None;probe=None;skipped=[]
        if args.executable=='original':command=[str(isolation.copy_target(Path('/Users/josh-desktop/.local/bin/claude')))]
        else:
            node,entry,runtime=copy_runtime(isolation.root);probe=isolation.sandbox([str(node),'-e','process.stdout.write("owned-agent-node-ready")'])
            if probe['exit_code']!=0 or probe['timed_out'] or probe['stdout']!='owned-agent-node-ready':raise RuntimeError('Copied Node bootstrap failed')
            command=[str(node),'--preserve-symlinks','--preserve-symlinks-main',str(entry)]
        arguments=['--print','OWNED_AGENT_PARENT_REQUEST_'+args.case.upper(),'--model',MODEL,'--output-format','json','--tools','Agent,Read']
        if args.executable=='original':arguments.append('--no-session-persistence')
        else:skipped.append('--no-session-persistence')
        isolation.report['original_executed']=args.executable=='original';result,cleanup=run_stage(isolation,command,arguments)
        record={'case':args.case,'executable':args.executable,'target_sha256':TARGET_SHA256 if args.executable=='original' else None,'isolation':isolation.report,'environment_overrides':ENV,
                'source_preflight':proof,'runtime':runtime,'runtime_probe':probe,'fixture_definition':fixture,'user_settings':settings,'mock_response_usage':{'input_tokens':10,'output_tokens':3},
                'stages':[{'arguments':arguments,'result':result,'cleanup':cleanup}],'requests':state.requests,'scope_generations':state.generations,'owned_file':{'before':before.decode(),'after':state.file_path.read_text(),'sha256_before':hashlib.sha256(before).hexdigest(),'sha256_after':digest(state.file_path)},
                'owned_child_transcript_manifest':transcript_manifest(isolation.root),'owned_tau_child_archives':tau_child_archives(isolation.root),'response_identity':'unique msg_owned_agent_CASE_SCOPE_GENERATION, classified only by owned top-level system marker','skipped_original_flags':skipped}
        (artifacts/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for stream in ['stdout','stderr']:(artifacts/(stem+'.'+stream+'.txt')).write_text(result[stream])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case':args.case,'executable':args.executable,'exit':result['exit_code'],'scope_generations':state.generations,'scopes':[r['scope'] for r in state.requests if r['path'].split('?')[0]=='/v1/messages'],'models':[r['body'].get('model') for r in state.requests if r['path'].split('?')[0]=='/v1/messages'],'owned_file_unchanged':record['owned_file']['sha256_before']==record['owned_file']['sha256_after'],'remaining_group_members':cleanup['remaining_members'],'group_killed':result['remaining_process_group_killed']}))


if __name__=='__main__':main()
