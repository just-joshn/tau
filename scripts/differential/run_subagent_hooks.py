#!/usr/bin/env python3
"""Two owned foreground lifecycle controls, source-verified before target copying."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

from isolation import REPO,TARGET_SHA256,clone_file
from run_agents import AgentMock,MODEL,ENV,SYSTEM_MARKER,verify_source as verify_agents,transcript_manifest,tau_child_archives
from run_skill_effort import verified_effort_isolation
from run_skill_hooks import verify_source as verify_hooks
from run_skills import run_stage
from run_hooks import alive
from run_tau import copy_runtime,digest

CASES=['continuation','fallback']


class LifecycleMock(AgentMock):
    def response(self,scope,generation):
        if scope=='parent' and generation==1:
            prompt='OWNED_AGENT_CHILD_REQUEST\n'+('Return OWNED_SUBAGENT_FIRST_FINAL.' if self.case=='continuation' else 'Read exactly once from '+str(self.file_path)+'.')
            return [{'type':'tool_use','id':'owned-agent-parent-tool','name':'Agent','input':{'description':'Owned lifecycle control','prompt':prompt,'subagent_type':'owned-reader','run_in_background':False}}],'tool_use'
        if scope=='child':
            if self.case=='fallback' and generation==1:return [{'type':'tool_use','id':'owned-agent-child-read','name':'Read','input':{'file_path':str(self.file_path)}}],'tool_use'
            text='OWNED_SUBAGENT_FIRST_FINAL' if generation==1 else 'OWNED_SUBAGENT_SECOND_FINAL'
            return [{'type':'text','text':text}],'end_turn'
        return [{'type':'text','text':'OWNED_LIFECYCLE_PARENT_FINAL'}],'end_turn'


def verify_source():
    base=verify_agents();schema=verify_hooks();proof=REPO/'artifacts/subagent-hooks-research/spans.json';spans=json.loads(proof.read_text())
    required={'subagent_start_payload','subagent_stop_payload','hook_common_session_payload','hook_session_transcript_path','hook_agent_transcript_path','subagent_start_child_consumer','subagent_normal_stop_feedback','subagent_stop_prevent_precedence','subagent_interrupted_stop_cleanup','subagent_stop_seen_marker','subagent_successful_loop_exit_guard','subagent_diagnostic_model_projection','subagent_start_output_schema','subagent_stop_output_schema'}
    if len(spans)<53 or not required<={row['id'] for row in spans}:raise RuntimeError('Lifecycle source handshake incomplete')
    manifest=json.loads((REPO/'artifacts/bundle-manifest.json').read_text());modules={row['name']:row for row in manifest['modules']}
    with Path('/Users/josh-desktop/.local/bin/claude').open('rb') as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned target differs')
        for name in {row['module'] for row in spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Lifecycle module differs')
        for row in spans:
            target.seek(row['offset']);raw=target.read(row['length'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256'] or raw.decode()!=row['text']:raise RuntimeError('Installed lifecycle bytes differ')
    return {'all_equal':True,'target_sha256':TARGET_SHA256,'agent_source':base,'command_schema':schema,'lifecycle_spans':spans,'lifecycle_proof_sha256':digest(proof),'recovered_code_executed':False,
            'review':'Global synchronous command+args lifecycle hooks only; custom Read-only foreground agent with fork0. A maxTurns4 continuation; B maxTurns1 Read and ignored independent fallback feedback. No peers, shell expansion, async hooks or extended profile.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('executable',choices=['original','tau']);parser.add_argument('case',choices=CASES);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/subagent-hooks');args=parser.parse_args();artifacts=args.artifacts.resolve();stem=args.executable+'-'+args.case
    if (artifacts/(stem+'.json')).exists():raise RuntimeError('Refusing capture overwrite')
    source=verify_source();state=LifecycleMock(args.case)
    with verified_effort_isolation(artifacts,state.handler(),ENV) as isolation:
        fixture_text='---\nname: owned-reader\ndescription: Owned lifecycle custom-agent fixture\ntools: Read\nmodel: inherit\nmaxTurns: '+('4' if args.case=='continuation' else '1')+'\n---\n'+SYSTEM_MARKER+'\nFollow the exact owned delegation request and return its owned marker.\n'
        definition=isolation.root/'work/.claude/agents/owned-reader.md';definition.parent.mkdir(parents=True);definition.write_text(fixture_text)
        state.file_path=isolation.root/'work/owned-agent-input.txt';state.file_path.write_text('OWNED_AGENT_FILE\n');before=state.file_path.read_text()
        node,entry,runtime=copy_runtime(isolation.root);fixture=isolation.root/'subagent-lifecycle-fixture.cjs';clone_file(REPO/'scripts/differential/subagent_lifecycle_fixture.cjs',fixture)
        probe=isolation.sandbox([str(node),str(fixture),'ready',str(isolation.root/'lifecycle-ready.jsonl'),args.case,'ready'])
        if probe['exit_code']!=0 or probe['timed_out'] or probe['stdout']!='owned-subagent-lifecycle-ready':raise RuntimeError('Copied lifecycle fixture failed unchanged profile')
        lifecycle=isolation.root/'subagent-hook-lifecycle.jsonl'
        def command(kind):return {'type':'command','command':str(node),'args':[str(fixture),'hook',str(lifecycle),args.case,kind],'timeout':3}
        configured={'SubagentStop':[{'matcher':'^owned-reader$','hooks':[command('stop')]}]}
        if args.case=='continuation':configured['SubagentStart']=[{'matcher':'^owned-reader$','hooks':[command('start-context'),command('start-diagnostic')]}]
        settings={'hooks':configured};(isolation.root/'config/settings.json').write_text(json.dumps(settings)+'\n')
        if args.executable=='original':cmd=[str(isolation.copy_target(Path('/Users/josh-desktop/.local/bin/claude')))];skipped=[]
        else:cmd=[str(node),'--preserve-symlinks','--preserve-symlinks-main',str(entry)];skipped=['--no-session-persistence']
        arguments=['--print','OWNED_SUBAGENT_LIFECYCLE_'+args.case.upper(),'--model',MODEL,'--output-format','json','--tools','Agent,Read']
        if args.executable=='original':arguments.append('--no-session-persistence')
        isolation.report['original_executed']=args.executable=='original';result,cleanup=run_stage(isolation,cmd,arguments)
        logs=[json.loads(line) for line in lifecycle.read_text().splitlines()] if lifecycle.exists() else [];pids=sorted({row['pid'] for row in logs if row.get('event')=='start'})
        deadline=time.monotonic()+2
        while any(alive(pid) for pid in pids) and time.monotonic()<deadline:time.sleep(.05)
        survivors=[pid for pid in pids if alive(pid)]
        record={'case':args.case,'executable':args.executable,'target_sha256':TARGET_SHA256 if args.executable=='original' else None,'isolation':isolation.report,'environment_overrides':ENV,'source_preflight':source,
                'runtime':runtime,'fixture_definition':fixture_text,'fixture_sha256':digest(fixture),'fixture_runtime_probe':probe,'settings':settings,'lifecycle':logs,'hook_pids':pids,'surviving_hook_pids':survivors,
                'stages':[{'arguments':arguments,'result':result,'cleanup':cleanup}],'requests':state.requests,'scope_generations':state.generations,'owned_file_before':before,'owned_file_after':state.file_path.read_text(),
                'native_child_metadata_manifest':transcript_manifest(isolation.root),'owned_tau_child_archives':tau_child_archives(isolation.root),'skipped_original_flags':skipped,
                'response_identity':'Unique msg_owned_agent_CASE_SCOPE_GENERATION; child scope from owned top-level system marker; no vendor prompt body copied.'}
        (artifacts/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for stream in ['stdout','stderr']:(artifacts/(stem+'.'+stream+'.txt')).write_text(result[stream])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case':args.case,'executable':args.executable,'exit':result['exit_code'],'messages':sum(r['path'].split('?')[0]=='/v1/messages' for r in state.requests),'scopes':[r['scope'] for r in state.requests if r['path'].split('?')[0]=='/v1/messages'],
                          'hook_inputs':[{'kind':row['kind'],'event':row['input'].get('hook_event_name'),'active':row['input'].get('stop_hook_active'),'mode_present':'permission_mode'in row['input'],'last_assistant':row['input'].get('last_assistant_message')} for row in logs if row.get('event')=='input'],
                          'hook_children':len(pids),'exit_codes':[row['code'] for row in logs if row.get('event')=='exit'],'survivors':survivors,'remaining_group_members':cleanup['remaining_members'],'group_killed':result['remaining_process_group_killed']}))


if __name__=='__main__':main()
