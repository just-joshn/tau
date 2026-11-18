#!/usr/bin/env python3
"""Owned captured-native-file import control; Tau execution requires root GO."""
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import stat
import subprocess
import threading

from bun_runtime import bun_environment
from isolation import REPO,TARGET_SHA256,Isolation,clone_file
from mock_api import events
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_plugins import PINNED_TARGET
from run_child_workflows import prepare_bun_adapter
from run_native_main import transcript_snapshot
from run_skills import run_stage

MODEL='claude-sonnet-4-6'
PROMPT='OWNED_NATIVE_RESUME_PROMPT'
FINAL='OWNED_NATIVE_RESUME_FINAL'
OLD_PROMPT='OWNED_NATIVE_MAIN_PROMPT'
OLD_FINAL='OWNED_NATIVE_MAIN_FINAL'
RAW_SHA256='33361348e7d525def7ff8c5e878df72d5018737b8bd75dd15fff3f5f7bcbb7fe'
RAW=REPO/'artifacts/differential-pass/native-main/original-main.transcripts/config/projects/-private-tmp-tau-differential-d6lbyb9f-work/c7a09c0e-77c0-4032-9326-af690eca41fa.jsonl'
MAX_BYTES=1048576
PROGRAM='''const fs=require("node:fs");
const rows=fs.readFileSync(process.argv[2],"utf8").trim().split("\\n").map(line=>JSON.parse(line));
const environment=rows.find(row=>row.type==="attachment"&&row.attachment?.type==="environment").rendered.map(value=>({type:"text",text:value.content}));
const body={model:"claude-sonnet-4-6",stream:true,tools:[],system:"OWNED_PROTOCOL_ONLY",messages:[{role:"user",content:[...environment,{type:"text",text:"OWNED_NATIVE_MAIN_PROMPT"}]},{role:"assistant",content:[{type:"text",text:"OWNED_NATIVE_MAIN_FINAL"}]},{role:"user",content:[{type:"text",text:"OWNED_NATIVE_RESUME_PROMPT"}]}]};
fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)}).then(async response=>{if(!response.ok||!(await response.text()).includes("OWNED_NATIVE_RESUME_FINAL"))throw Error("Owned native-import protocol rejected");process.stdout.write("owned-native-import-protocol-ready");}).catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
'''


def digest(raw):return hashlib.sha256(raw).hexdigest()


def bounded_file(root,path):
    before=path.lstat()
    if not stat.S_ISREG(before.st_mode)or before.st_nlink!=1 or before.st_size>MAX_BYTES:raise ValueError('Expected bounded single-linked regular file')
    canonical=path.resolve(strict=True)
    if canonical!=path or not canonical.is_relative_to(root):raise ValueError('File leaves owned lexical/canonical root')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb')as stream:
        opened=os.fstat(stream.fileno());raw=stream.read(MAX_BYTES+1);after=os.fstat(stream.fileno())
    identity=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_nlink)
    if len(raw)>MAX_BYTES or len(raw)!=before.st_size or identity(before)!=identity(opened)or identity(before)!=identity(after)or identity(before)!=identity(path.lstat())or path.resolve(strict=True)!=canonical:raise ValueError('File changed during bounded owned read')
    return raw,{'sha256':digest(raw),'bytes':len(raw),'device':before.st_dev,'inode':before.st_ino,'mtime_ns':before.st_mtime_ns,'regular_single_link':True,'canonical_owned':True,'ownership_rechecked':True}


def load_source():
    raw,receipt=bounded_file(REPO,RAW)
    if receipt['sha256']!=RAW_SHA256:raise RuntimeError('Captured immutable native main SHA changed')
    rows=[json.loads(line)for line in raw.splitlines()if line.strip()];user=next(row for row in rows if row.get('type')=='user');assistant=next(row for row in rows if row.get('type')=='assistant')
    if user['message']['content']!=OLD_PROMPT or assistant['message']['content'][0]['text']!=OLD_FINAL:raise RuntimeError('Captured own message markers differ')
    environment=next(row for row in rows if row.get('type')=='attachment'and row['attachment'].get('type')=='environment')
    rendered=[value['content']for value in environment['rendered']if isinstance(value.get('content'),str)]
    if not rendered:raise RuntimeError('Recorded environment context missing')
    conversation=[row for row in rows if isinstance(row,dict)and row.get('type')in ['user','assistant','attachment','system','progress']]
    preconditions={'exact_captured_hash':receipt['sha256']==RAW_SHA256,'same_main_owner':bool(conversation)and all(row.get('sessionId')==user['sessionId']and row.get('isSidechain')is False and'agentId'not in row for row in conversation),
                   'no_message_slug':all('slug'not in row for row in conversation),'no_file_history':all('file-history'not in str(row.get('type',''))and'fileHistorySnapshots'not in row and'trackedFileBackups'not in row for row in rows),
                   'completed_own_text_turn':len([row for row in rows if row.get('type')=='user'])==1 and len([row for row in rows if row.get('type')=='assistant'])==1 and assistant['message'].get('stop_reason')=='end_turn'}
    if not all(preconditions.values()):raise RuntimeError('Original native resume owned restore preconditions differ')
    return raw,receipt,{'session_id':user['sessionId'],'source_cwd':user['cwd'],'rendered_environment':rendered,'rendered_environment_sha256':[digest(value.encode())for value in rendered],'restore_preconditions':preconditions}


def verify_source():
    modules={row['name']:row for row in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']};groups={};spans=[]
    required={'native-resume-entry-research/spans.json':{'native_resume_entry_print_loader','native_resume_entry_S0e','native_resume_entry_print_adopt_storage','native_resume_entry_Jb','native_resume_entry_gwn','native_resume_entry_native_session_Upn','native_resume_entry_native_session_Esr'},
              'native-resume-context-research/spans.json':{'native_resume_context_RPi','native_resume_context_ZWo','native_resume_context_rendered_schema','native_resume_context_projection_gates','native_resume_context_prompt_snapshot_reader'},
              'native-main-capture-research/spans.json':{'native_main_persistence_flag','native_main_persistence_default','native_main_persistence_consumer','native_main_skip_persistence','native_main_print_flush'},
              'native-main-import-research/restore-spans.json':{'native_import_plan_restore_slug_guard','native_import_same_owner_filehistory_guard'}}
    for name,ids in required.items():
        path=REPO/'artifacts'/name;rows=json.loads(path.read_text())
        if not ids<={row['id']for row in rows}:raise RuntimeError('Native resume/context source handshake incomplete')
        groups[name]={'sha256':digest(path.read_bytes()),'spans':rows};spans.extend(rows)
    with PINNED_TARGET.open('rb')as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Retained326 source target differs')
        for name in {row['module']for row in spans}:
            if digest((REPO/'artifacts/claude-bundle'/name).read_bytes())!=modules[name]['sha256']:raise RuntimeError('Resume/context source module differs')
        for row in spans:
            target.seek(row['offset']);raw=target.read(row['length'])
            if digest(raw)!=row['sha256']or raw.decode()!=row['text']:raise RuntimeError('Resume/context installed source bytes differ')
    return{'all_equal':True,'target_sha256':TARGET_SHA256,'spans':len(spans),'groups':groups,'original_executed':False,'recovered_code_executed':False}


def text_blocks(value):
    if isinstance(value,str):return[value]
    if isinstance(value,list):return[block['text']for block in value if isinstance(block,dict)and block.get('type')=='text'and isinstance(block.get('text'),str)]
    return[]


def history_observations(body,facts):
    texts={role:[text for message in body.get('messages',[])if message.get('role')==role for text in text_blocks(message.get('content'))]for role in ['user','assistant']}
    all_text=[*text_blocks(body.get('system')),*[text for message in body.get('messages',[])for text in text_blocks(message.get('content'))]];joined='\n'.join(all_text)
    checks={'imported_user_prompt':any(OLD_PROMPT in text for text in texts['user']),'imported_assistant_final':any(OLD_FINAL in text for text in texts['assistant']),'new_prompt':any(PROMPT in text for text in texts['user']),'recorded_environment_text':all(value in joined for value in facts['rendered_environment']),'recorded_old_cwd_context':facts['source_cwd']in joined,'old_prompt_final_new_prompt_order':0<=joined.find(OLD_PROMPT)<joined.find(OLD_FINAL)<joined.find(PROMPT),'empty_toolset':not body.get('tools',[]),'known_model':body.get('model')==MODEL}
    return{'checks':checks,'recorded_environment_sha256':facts['rendered_environment_sha256'],'marker_positions':{value:joined.find(value)for value in [OLD_PROMPT,OLD_FINAL,PROMPT,facts['source_cwd']]},'context_channels':{'top_system':any(facts['source_cwd']in text for text in text_blocks(body.get('system'))),'user':any(facts['source_cwd']in text for text in texts['user']),'assistant':any(facts['source_cwd']in text for text in texts['assistant'])}}


class ResumeMock:
    def __init__(self,facts):self.facts=facts;self.requests=[];self.generation=0;self.lock=threading.Lock();self.halt=None
    def handler(self):
        state=self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*_args):pass
            def do_POST(self):
                length=int(self.headers.get('content-length','0'))
                if length<0 or length>32*1024*1024:self.send_error(413);return
                try:body=json.loads(self.rfile.read(length))
                except ValueError:self.send_error(400);return
                path=self.path.split('?')[0];count=path=='/v1/messages/count_tokens'
                with state.lock:
                    retained=dict(body);retained.pop('metadata',None);observation=history_observations(body,state.facts)if path=='/v1/messages'else None
                    state.requests.append({'path':self.path,'body':retained,'observation':observation,'safe_headers':{name:self.headers.get(name)for name in ['anthropic-beta','anthropic-version','content-type','x-app']if self.headers.get(name)is not None}})
                    if path=='/v1/messages':state.generation+=1
                    generation=state.generation
                    if path not in ['/v1/messages','/v1/messages/count_tokens']or generation>1 or observation and not all(observation['checks'].values()):state.halt='OWNED_NATIVE_RESUME_ORACLE_FAILURE'
                if count:self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":32}');return
                if path!='/v1/messages'or generation>2:self.send_error(400);return
                content=[{'type':'text','text':state.halt or FINAL}];identity='msg_owned_native_resume_'+str(generation)
                if body.get('stream'):
                    wire=events(content,'end_turn',MODEL);wire[0]['message']['id']=identity
                    self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(''.join('event: '+row['type']+'\ndata: '+json.dumps(row)+'\n\n'for row in wire).encode())
                else:
                    self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':identity,'type':'message','role':'assistant','model':MODEL,'content':content,'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':3}}).encode())
        return Handler


def archive_snapshot(root):
    directory=root/'tau-state/sessions';files={};guards=[];total=0;visited=0;entries=0
    if not directory.exists()and not directory.is_symlink():return{'files':files,'guards':guards,'bytes':total}
    if directory.is_symlink()or not directory.resolve().is_relative_to(root):return{'files':files,'guards':['Foreign/symlink archive root'],'bytes':total}
    for base,dirs,names in os.walk(directory,followlinks=False):
        visited+=1;entries+=len(dirs)+len(names)
        if visited>32 or entries>128:guards.append('Archive enumeration bound');break
        for name in list(dirs):
            if(Path(base)/name).is_symlink():guards.append('Archive symlink directory');dirs.remove(name)
        for name in sorted(names):
            if not name.endswith('.json'):continue
            if len(files)>=8:guards.append('Archive file count bound');return{'files':files,'guards':guards,'bytes':total}
            path=Path(base)/name
            try:
                if total+path.lstat().st_size>2097152:raise ValueError('Archive aggregate bound')
                raw,receipt=bounded_file(root,path);total+=len(raw);files[str(path.relative_to(root))]={**receipt,'raw_base64':base64.b64encode(raw).decode(),'json':json.loads(raw)}
            except(OSError,ValueError)as error:guards.append(str(error))
    return{'files':files,'guards':guards,'bytes':total}


def writer_directory_snapshot(root,directory):
    """Observe only the explicitly adopted owned writer dirname, without reads."""
    if directory.is_symlink()or not directory.resolve(strict=True).is_relative_to(root):raise ValueError('Writer directory leaves owned root')
    entries={}
    with os.scandir(directory)as stream:
        for item in stream:
            if len(entries)>=16:raise ValueError('Adopted writer directory entry bound exceeded')
            info=item.stat(follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode)or info.st_nlink!=1:raise ValueError('Unexpected writer dirname link/special entry')
            entries[item.name]={'device':info.st_dev,'inode':info.st_ino,'bytes':info.st_size,'mtime_ns':info.st_mtime_ns}
    return entries


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['tau','original','readiness','original-readiness']);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/native-main-import');args=parser.parse_args();directory=args.artifacts.resolve();directory.mkdir(parents=True,exist_ok=True);stem=args.mode+'-import'
    if any(directory.glob(stem+'.*')):raise RuntimeError('Refusing import capture/bootstrap/failure overwrite')
    source=verify_source();raw,source_before,facts=load_source();state=ResumeMock(facts);isolation=Isolation(directory,state.handler());record=None
    try:
        if args.mode in ['tau','readiness']:isolation.env.update(bun_environment(isolation.root))
        isolation.verify();copied=isolation.root/'imported/native-main.jsonl';copied.parent.mkdir();clone_file(RAW,copied);copied.chmod(0o400);copied_raw,copied_before=bounded_file(isolation.root,copied);writer_before=writer_directory_snapshot(isolation.root,copied.parent)
        if copied_raw!=raw or copied_before['sha256']!=RAW_SHA256 or(source_before['device'],source_before['inode'])==(copied_before['device'],copied_before['inode']):raise RuntimeError('Copied captured raw differs/shared inode')
        old_cwd_existed=Path(facts['source_cwd']).exists();runtime=None;probes=None;fixture_runtime=None;fixture_probe=None
        arguments=['--resume',str(copied),'--model',MODEL,'--tools','','--print',PROMPT,'--max-turns','1','--output-format','json']
        if args.mode in ['tau','readiness']:
            bun,entry,runtime,probes=prepare_bun_adapter(isolation,directory,stem);command=[str(bun),'--no-install',str(entry)]
        else:
            node,fixture_runtime=copy_node_fixture_runtime(isolation.root);fixture_probe=isolation.sandbox([str(node),'-e','process.stdout.write(JSON.stringify({marker:"owned-native-import-node-ready",cwd:process.cwd()}))'])
            if fixture_probe['exit_code']!=0 or fixture_probe['timed_out']or fixture_probe['output_limited']or fixture_probe['remaining_process_group_killed']or json.loads(fixture_probe['stdout'])!={'marker':'owned-native-import-node-ready','cwd':str(isolation.root/'work')}:raise RuntimeError('Copied original-fixture Node/cwd readiness failed')
            command=[str(node)]
            if args.mode=='original':command=[str(isolation.copy_target(PINNED_TARGET))];arguments.append('--no-session-persistence')
        if args.mode in ['readiness','original-readiness']:
            authored=isolation.root/'owned-native-import-protocol.cjs';authored.write_text(PROGRAM);command=[str(bun),'--no-install',str(authored),str(copied)]if args.mode=='readiness'else[str(node),str(authored),str(copied)];arguments=[]
        isolation.report['original_executed']=args.mode=='original';isolation.report['port_entrypoint_executed']=args.mode=='tau';outcome,cleanup=run_stage(isolation,command,arguments)
        _,source_after=bounded_file(REPO,RAW);_,copied_after=bounded_file(isolation.root,copied);writer_after=writer_directory_snapshot(isolation.root,copied.parent);archives=archive_snapshot(isolation.root);native_snapshots=transcript_snapshot(isolation.root);requests=[row for row in state.requests if row['path'].split('?')[0]=='/v1/messages']
        checks={'cli_success':outcome['exit_code']==0 and not outcome['timed_out']and not outcome['output_limited'],'one_messages_request':len(requests)==1,'hard_two_request_cap':len(requests)<=2,'no_mock_halt':state.halt is None,'history_context_oracle':bool(requests)and all(all(row['observation']['checks'].values())for row in requests),'group_clean':not cleanup['remaining_members'],'source_raw_unchanged':source_before==source_after and source_after['sha256']==RAW_SHA256,'copied_raw_unchanged':copied_before==copied_after and copied_after['sha256']==RAW_SHA256,'distinct_copied_inode':(source_before['device'],source_before['inode'])!=(copied_before['device'],copied_before['inode']),'current_workspace_distinct':str(isolation.root/'work')!=facts['source_cwd'],'old_cwd_remains_absent':not old_cwd_existed and not Path(facts['source_cwd']).exists(),'archive_guards_pass':not archives['guards']}
        if args.mode=='tau':
            output=json.loads(outcome['stdout']);saved=[item['json']for item in archives['files'].values()if isinstance(item.get('json'),dict)and item['json'].get('id')==facts['session_id']]
            checks.update({'final_marker':output.get('result')==FINAL,'one_independent_archive':len(saved)==1,'archive_current_cwd':bool(saved)and all(value.get('cwd')==str(isolation.root/'work')for value in saved),'archive_history_and_reply':bool(saved)and all(all(marker in json.dumps(value.get('messages'))for marker in [OLD_PROMPT,OLD_FINAL,PROMPT,FINAL])for value in saved)})
        elif args.mode=='original':
            output=json.loads(outcome['stdout']);checks.update({'final_marker':output.get('result')==FINAL,'adopted_native_identity':output.get('session_id')==facts['session_id'],'restore_preconditions':all(facts['restore_preconditions'].values()),'persistence_explicitly_disabled':'--no-session-persistence'in arguments,'owned_adopted_writer_directory':copied.parent.resolve().is_relative_to(isolation.root),'adopted_writer_directory_unchanged':writer_before==writer_after,'no_new_native_main':not native_snapshots['files']and not native_snapshots['guards'],'no_port_archive':not archives['files']})
        else:checks.update({'authored_protocol_ready':outcome['stdout']=='owned-native-import-protocol-ready','no_port_archive_fabricated':not archives['files']})
        record={'mode':args.mode,'source_preflight':source,'captured_source_path':str(RAW),'captured_source_before':source_before,'captured_source_after':source_after,'copied_native_before':copied_before,'copied_native_after':copied_after,'native_facts':{key:value for key,value in facts.items()if key!='rendered_environment'},'isolation':isolation.report,'port_runtime':runtime,'port_runtime_probes':probes,'fixture_runtime':fixture_runtime,'fixture_runtime_probe':fixture_probe,'arguments':arguments,'command':command,'result':outcome,'cleanup':cleanup,'requests':state.requests,'mock_halt':state.halt,'archives':archives,'native_main_snapshots':native_snapshots,'current_workspace':str(isolation.root/'work'),'adopted_writer_directory':str(copied.parent),'writer_directory_before':writer_before,'writer_directory_after':writer_after,'checks':checks,'original_executed':args.mode=='original','port_entrypoint_executed':args.mode=='tau','hooks_configured':False,'oracle_scope':'Owned prompt/final/new prompt; recorded environment rendered metadata only. No prompt_snapshot systemPrompt body copied into oracle. Source cwd is passive; absent-before/after + current archive cwd are observed effects, not syscall trace proof.'}
        (directory/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for name in ['stdout','stderr']:(directory/(stem+'.'+name+'.txt')).write_text(outcome[name])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(directory/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'mode':args.mode,'messages':len(requests),'checks':checks,'original_executed':args.mode=='original','port_entrypoint_executed':args.mode=='tau'}))
    except Exception as error:
        (directory/(stem+'.failure.json')).write_text(json.dumps({'error':{'type':type(error).__name__,'message':str(error)},'isolation':isolation.report,'requests':state.requests,'snapshot_drift':getattr(error,'evidence',None),'partial_record':record},indent=2)+'\n');raise
    finally:isolation.close()
    if not all(checks.values()):raise SystemExit(3)


if __name__=='__main__':main()
