#!/usr/bin/env python3
"""One owned native MAIN JSONL control; original execution requires root GO."""
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
import uuid

from isolation import REPO,TARGET_SHA256,Isolation
from mock_api import events
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_plugins import PINNED_TARGET
from run_skills import run_stage

MODEL='claude-sonnet-4-6'
PROMPT='OWNED_NATIVE_MAIN_PROMPT'
FINAL='OWNED_NATIVE_MAIN_FINAL'
MAX_FILES=8
MAX_FILE_BYTES=1048576
MAX_TOTAL_BYTES=2097152
CORE_IDS={'native_session_project_paths','native_session_session_agent_paths','native_session_lHo','native_session_insertMessageChain','native_session_appendEntry','native_session_materializeSessionFile','native_session_jsonl_write','native_session_enqueueWrite','native_session_drainQueuesOnce'}
# Filled only after a pinned source-owner handshake; missing proof refuses all
# target execution. Authored readiness remains explicitly non-native evidence.
EXTRA_PROOFS=REPO/'artifacts/native-main-capture-research/spans.json'
EXTRA_IDS={'native_main_persistence_flag','native_main_persistence_default','native_main_persistence_consumer','native_main_skip_persistence','native_main_print_flush'}
PROGRAM='''const body = {model:"claude-sonnet-4-6",stream:true,tools:[],messages:[{role:"user",content:[{type:"text",text:"OWNED_NATIVE_MAIN_PROMPT"}]}]};
fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)}).then(async response=>{if(!response.ok || !(await response.text()).includes("OWNED_NATIVE_MAIN_FINAL"))throw Error("Owned native-main mock rejected");process.stdout.write("owned-native-main-protocol-ready");}).catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
'''


def sha(data):return hashlib.sha256(data).hexdigest()


def verify_source(require_handshake=True):
    manifest=json.loads((REPO/'artifacts/bundle-manifest.json').read_text());modules={r['name']:r for r in manifest['modules']}
    core=json.loads((REPO/'artifacts/native-session-research/spans.json').read_text());spans=[r for r in core if r['id']in CORE_IDS]
    if {r['id']for r in spans}!=CORE_IDS:raise RuntimeError('Native main writer/path proof coverage incomplete')
    extra=json.loads(EXTRA_PROOFS.read_text())if EXTRA_PROOFS.exists()else[];handshake=EXTRA_IDS<={r['id']for r in extra}
    if require_handshake and not handshake:raise RuntimeError('Native main persistence/flush source handshake is pending; no target execution permitted')
    spans.extend(extra)
    with PINNED_TARGET.open('rb')as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Retained326 target hash differs')
        for name in {r['module']for r in spans}:
            if sha((REPO/'artifacts/claude-bundle'/name).read_bytes())!=modules[name]['sha256']:raise RuntimeError('Native main source module hash differs')
        for row in spans:
            target.seek(row['offset']);raw=target.read(row['length'])
            if sha(raw)!=row['sha256']or raw.decode()!=row['text']:raise RuntimeError('Native main installed source span differs')
    return{'all_equal':True,'target_sha256':TARGET_SHA256,'target_path':str(PINNED_TARGET),'spans':spans,'source_handshake_complete':handshake,'recovered_code_executed':False}


class MainMock:
    def __init__(self):self.requests=[];self.generation=0;self.lock=threading.Lock();self.halt=None
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
                    retained=dict(body);retained.pop('metadata',None)
                    state.requests.append({'path':self.path,'body':retained,'safe_headers':{name:self.headers.get(name)for name in ['anthropic-beta','anthropic-version','content-type','x-app']if self.headers.get(name)is not None}})
                    if path=='/v1/messages':state.generation+=1
                    generation=state.generation
                    if path not in ['/v1/messages','/v1/messages/count_tokens']or generation>1:state.halt='OWNED_NATIVE_MAIN_UNEXPECTED_REQUEST'
                if count:self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":32}');return
                if path!='/v1/messages'or generation>2:self.send_error(400);return
                content=[{'type':'text','text':FINAL if generation==1 else state.halt}];identity='msg_owned_native_main_'+str(generation)
                if body.get('stream'):
                    wire=events(content,'end_turn',MODEL);wire[0]['message']['id']=identity
                    self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(''.join('event: '+x['type']+'\ndata: '+json.dumps(x)+'\n\n'for x in wire).encode())
                else:
                    self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':identity,'type':'message','role':'assistant','model':MODEL,'content':content,'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':3}}).encode())
        return Handler


def transcript_snapshot(root):
    """Lossless bounded owned regular files, with no symlink traversal/read."""
    directory=root/'config/projects';files={};guards=[];total=0
    if not directory.exists()and not directory.is_symlink():return{'files':files,'guards':guards,'total_bytes':total}
    if directory.is_symlink()or not directory.resolve(strict=True).is_relative_to(root):return{'files':files,'guards':['Projects directory is symlink/foreign'],'total_bytes':total}
    visited=0;entries=0;candidates_seen=0
    for base,dirs,names in os.walk(directory,followlinks=False):
        visited+=1;entries+=len(dirs)+len(names)
        if visited>32 or entries>128:guards.append('Projects tree enumeration bound exceeded');return{'files':files,'guards':guards,'total_bytes':total}
        for name in list(dirs):
            if(Path(base)/name).is_symlink():guards.append('Projects descendant symlink directory refused');dirs.remove(name)
        for name in sorted(names):
            if not name.endswith('.jsonl'):continue
            candidates_seen+=1
            path=Path(base)/name;key=str(path.relative_to(root))
            if candidates_seen>MAX_FILES:guards.append('JSONL file count exceeds8');return{'files':files,'guards':guards,'total_bytes':total}
            try:
                before=path.lstat()
                if not stat.S_ISREG(before.st_mode)or before.st_nlink!=1:raise ValueError('JSONL leaf is not single-linked regular file')
                canonical=path.resolve(strict=True)
                if not canonical.is_relative_to(root)or canonical!=path:raise ValueError('JSONL leaf resolves outside owned lexical path')
                if before.st_size>MAX_FILE_BYTES or total+before.st_size>MAX_TOTAL_BYTES:raise ValueError('JSONL file/aggregate exceeds1MiB/2MiB bound')
                descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
                with os.fdopen(descriptor,'rb')as stream:
                    opened=os.fstat(stream.fileno())
                    if(before.st_dev,before.st_ino,before.st_size)!=(opened.st_dev,opened.st_ino,opened.st_size):raise ValueError('JSONL changed before bounded read')
                    raw=stream.read(MAX_FILE_BYTES+1);after=os.fstat(stream.fileno())
                final=path.lstat()
                identity=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_nlink)
                if len(raw)>MAX_FILE_BYTES or len(raw)!=before.st_size or identity(before)!=identity(after)or identity(before)!=identity(final)or path.resolve(strict=True)!=canonical:raise ValueError('JSONL changed during bounded read/ownership recheck')
                total+=len(raw)
                if total>MAX_TOTAL_BYTES:raise ValueError('JSONL aggregate exceeds2MiB after read')
                rows=[];malformed=[]
                for index,line in enumerate(raw.decode('utf-8','replace').splitlines()):
                    if not line.strip():continue
                    try:rows.append({'line':index+1,'value':json.loads(line)})
                    except ValueError:malformed.append(index+1)
                files[key]={'bytes':len(raw),'sha256':sha(raw),'raw_base64':base64.b64encode(raw).decode(),'rows':rows,'malformed_lines':malformed,'ends_lf':raw.endswith(b'\n'),'regular_single_link':True,'canonical_owned':True,'ownership_rechecked':True,'metadata':{'device':before.st_dev,'inode':before.st_ino,'mtime_ns':before.st_mtime_ns}}
            except(OSError,ValueError)as error:guards.append(key+': '+str(error))
    return{'files':files,'guards':guards,'total_bytes':total}


def text_content(row):
    value=row.get('message',{}).get('content',[])
    if isinstance(value,str):return value
    return'\n'.join(b.get('text','')for b in value if isinstance(b,dict)and b.get('type')=='text')if isinstance(value,list)else''


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['original','readiness']);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/native-main');args=parser.parse_args();directory=args.artifacts.resolve();directory.mkdir(parents=True,exist_ok=True);stem=args.mode+'-main'
    if any(directory.glob(stem+'.*')):raise RuntimeError('Refusing native main capture/receipt overwrite')
    source=verify_source(require_handshake=args.mode=='original');state=MainMock();isolation=Isolation(directory,state.handler());record=None
    try:
        isolation.verify();node,runtime=copy_node_fixture_runtime(isolation.root);probe=isolation.sandbox([str(node),'-e','process.stdout.write("owned-native-main-node-ready")'])
        if probe['exit_code']!=0 or probe['timed_out']or probe['output_limited']or probe['stdout']!='owned-native-main-node-ready':raise RuntimeError('Copied Node fixture readiness failed')
        arguments=['--print',PROMPT,'--model',MODEL,'--tools','','--output-format','json','--max-turns','1']
        command=[str(isolation.copy_target(PINNED_TARGET))]if args.mode=='original'else[str(node),'-e',PROGRAM]
        if args.mode=='readiness':arguments=[]
        isolation.report['original_executed']=args.mode=='original';result,cleanup=run_stage(isolation,command,arguments);snapshots=transcript_snapshot(isolation.root)
        model_requests=[r for r in state.requests if r['path'].split('?')[0]=='/v1/messages']
        checks={'cli_success':result['exit_code']==0 and not result['timed_out']and not result['output_limited'],'one_messages_request':len(model_requests)==1,'hard_two_request_cap':len(model_requests)<=2,'no_mock_halt':state.halt is None,'empty_toolset':all(not r['body'].get('tools',[])for r in model_requests),'known_model':all(r['body'].get('model')==MODEL for r in model_requests),'group_clean':not cleanup['remaining_members'],'snapshot_guards_pass':not snapshots['guards']}
        output=None
        if args.mode=='original':
            output=json.loads(result['stdout']);session_id=output.get('session_id');uuid.UUID(session_id)
            candidates={key:item for key,item in snapshots['files'].items()if Path(key).name==session_id+'.jsonl'and len(Path(key).parts)==4}
            rows=[line['value']for item in candidates.values()for line in item['rows']if isinstance(line['value'],dict)]
            checks.update({'final_marker':output.get('result')==FINAL,'main_session_file':len(candidates)==1,'main_prompt_row':any(row.get('type')=='user'and PROMPT in text_content(row)for row in rows),'main_assistant_row':any(row.get('type')=='assistant'and FINAL in text_content(row)for row in rows),'main_rows_owned':bool(rows)and all(row.get('sessionId',session_id)==session_id and row.get('isSidechain',False)is False and'agentId'not in row for row in rows),'valid_jsonl':all(not item['malformed_lines']for item in candidates.values()),'persistence_optout_absent':'--no-session-persistence'not in arguments})
        else:checks.update({'owned_protocol_ready':result['stdout']=='owned-native-main-protocol-ready','no_native_transcript_fabricated':not snapshots['files']})
        record={'mode':args.mode,'source_preflight':source,'isolation':isolation.report,'runtime':runtime,'runtime_probe':probe,'arguments':arguments,'result':result,'cleanup':cleanup,'requests':state.requests,'mock_halt':state.halt,'output':output,'transcripts':snapshots,'checks':checks,'original_executed':args.mode=='original','port_executed':False,'hooks_configured':False,'response_identity':'Unique msg_owned_native_main_GENERATION','native_transcript_claim':args.mode=='original'}
        (directory/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for key,item in snapshots['files'].items():
            destination=directory/(stem+'.transcripts')/Path(key);destination.parent.mkdir(parents=True,exist_ok=True)
            with destination.open('xb')as stream:stream.write(base64.b64decode(item['raw_base64']))
        for name in ['stdout','stderr']:(directory/(stem+'.'+name+'.txt')).write_text(result[name])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(directory/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'mode':args.mode,'checks':checks,'messages':len(model_requests),'transcript_files':len(snapshots['files']),'transcript_bytes':snapshots['total_bytes'],'original_executed':args.mode=='original','port_executed':False}))
    except Exception as error:
        (directory/(stem+'.failure.json')).write_text(json.dumps({'error':{'type':type(error).__name__,'message':str(error)},'isolation':isolation.report,'requests':state.requests,'partial_record':record},indent=2)+'\n');raise
    finally:isolation.close()
    if not all(checks.values()):raise SystemExit(3)


if __name__=='__main__':main()
