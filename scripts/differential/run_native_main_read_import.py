#!/usr/bin/env python3
"""Actual owned MAIN Read import; Tau mode requires a separate root GO. No original mode."""
import argparse
import base64
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import threading

from bun_runtime import bun_environment
from isolation import Isolation, REPO, TARGET_SHA256, clone_file
from mock_api import events
from prepare_plugins import PINNED_TARGET
from run_child_workflows import prepare_bun_adapter
from run_native_import import archive_snapshot, bounded_file, verify_source as verify_resume_source, writer_directory_snapshot
from run_native_main import transcript_snapshot
from run_skills import run_stage

MODEL='claude-sonnet-4-6'
PROMPT='OWNED_NATIVE_MAIN_READ_RESUME_PROMPT'
FINAL='OWNED_NATIVE_MAIN_READ_RESUME_FINAL'
SESSION_ID='eb4a72c3-fb27-40a5-b34a-b5e7f2c03553'
RAW_SHA='550ff3c1207359e466f972dbef880f968f394eb495e5c0ad403d833fa213fa4e'
CAPTURE_SHA='55da88bf93e85dc91cfaf65ee2000409c8a9740db5f3a474130bf664879838c3'
RESULT_SHA='06ca4af4bbb7ad8bf0a26b9fa5b4638d4fb310525a0e77c77e0b918531811709'
CAPTURE=REPO/'artifacts/differential-pass/native-main-read/original-main-read.json'
RAW=REPO/'artifacts/differential-pass/native-main-read/original-main-read.transcripts/config/projects/-private-tmp-tau-differential--ti0di9d-work/eb4a72c3-fb27-40a5-b34a-b5e7f2c03553.jsonl'
PROGRAM='''const fs=require("node:fs");const messages=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-6",stream:true,tools:[],messages}),signal:AbortSignal.timeout(5000)}).then(async response=>{if(!response.ok||!(await response.text()).includes("OWNED_NATIVE_MAIN_READ_RESUME_FINAL"))throw Error("Owned Read import protocol rejected");process.stdout.write("owned-native-main-read-import-ready");}).catch(error=>{process.stderr.write(String(error));process.exitCode=1;});'''


def sha(raw):return hashlib.sha256(raw).hexdigest()


def load_source():
    raw,receipt=bounded_file(REPO,RAW)
    if receipt['sha256']!=RAW_SHA or sha(CAPTURE.read_bytes())!=CAPTURE_SHA:raise RuntimeError('Immutable owned MAIN Read capture changed')
    capture=json.loads(CAPTURE.read_text());rows=[json.loads(line)for line in raw.splitlines()if line.strip()]
    graph=[row for row in rows if row.get('type')in ['user','assistant','attachment','system','progress']]
    if not graph or any(row.get('sessionId')!=SESSION_ID or row.get('isSidechain')is not False or 'agentId'in row for row in graph):raise RuntimeError('Owned main scope differs')
    if any('slug'in row or 'fileHistorySnapshots'in row or 'trackedFileBackups'in row or 'history'in str(row.get('type',''))or'backup'in str(row.get('type',''))for row in rows):raise RuntimeError('New restore effects need a separate source/guard adapter')
    requests=[row['body']for row in capture['requests']if row['path'].split('?')[0]=='/v1/messages']
    if len(requests)!=2:raise RuntimeError('Owned original count differs')
    result=next(block for message in requests[1]['messages']for block in message.get('content',[])if isinstance(block,dict)and block.get('type')=='tool_result'and block.get('tool_use_id')=='owned_native_main_read_1')
    if sha(result['content'].encode())!=RESULT_SHA:raise RuntimeError('Original Read/context result changed')
    fragments=[block for row in graph if row.get('type')=='assistant'and row['message'].get('id')=='msg_owned_native_main_read_1'for block in row['message']['content']]
    final=next(row for row in graph if row.get('uuid')=='540eb1db-3f63-48da-8685-137ad67bf523')
    if final['message']['content']!=[{'type':'text','text':'OWNED_NATIVE_MAIN_READ_FINAL'}]:raise RuntimeError('Final native block differs')
    rendered=[entry['content']for row in graph if row.get('attachment',{}).get('type')in ['environment','model','date']for entry in row.get('rendered',[])if isinstance(entry.get('content'),str)]
    if len(rendered)!=3:raise RuntimeError('Recorded rendered context shapes differ')
    baseline=[*requests[1]['messages'],{'role':'assistant','content':final['message']['content']},{'role':'user','content':[{'type':'text','text':PROMPT}]}]
    facts={'session_id':SESSION_ID,'source_cwd':graph[0]['cwd'],'rendered':rendered,'fragments':fragments,'result':result['content'],'baseline':baseline,'selected_checkpoint':final['uuid'],'observed_no_slug_history':True}
    return raw,receipt,facts


def verify_source():
    base=verify_resume_source();modules={row['name']:row for row in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']};groups={}
    with PINNED_TARGET.open('rb')as executable:
        if hashlib.file_digest(executable,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned source target changed')
        for relative in ['native-tool-context-research/spans.json','native-context-classifiers-research/spans.json']:
            path=REPO/'artifacts'/relative;rows=json.loads(path.read_text())
            for name in {row['module']for row in rows}:
                if sha((REPO/'artifacts/claude-bundle'/name).read_bytes())!=modules[name]['sha256']:raise RuntimeError('Context module changed')
            for row in rows:
                executable.seek(row['offset']);raw=executable.read(row['length'])
                if sha(raw)!=row['sha256']or raw.decode()!=row['text']:raise RuntimeError('Context source span differs')
            groups[relative]={'sha256':sha(path.read_bytes()),'count':len(rows),'all_equal':True}
    return {'resume':base,'tool_context':groups,'original_executed':False,'recovered_code_executed':False}


def observation(body,facts):
    messages=body.get('messages',[]);blocks=[block for message in messages for block in message.get('content',[])if isinstance(block,dict)]
    result=[block for block in blocks if block.get('type')=='tool_result'and block.get('tool_use_id')=='owned_native_main_read_1']
    assistants=[message for message in messages if message.get('role')=='assistant'];all_text=[block['text']for block in blocks if block.get('type')=='text'and isinstance(block.get('text'),str)];joined='\n'.join(all_text)
    expected=['OWNED_NATIVE_MAIN_READ_PROMPT','OWNED_NATIVE_MAIN_READ_PRELUDE','OWNED_NATIVE_MAIN_READ_FINAL',PROMPT];positions=[joined.find(text)for text in expected]
    checks={'known_model':body.get('model')==MODEL,'empty_tools':not body.get('tools',[]),'exact_result_context':len(result)==1 and result[0].get('content')==facts['result'],'assistant_fragment_blocks_exact':bool(assistants)and assistants[0].get('content')==facts['fragments'],'recorded_rendered_context':all(value in joined for value in facts['rendered']),'marker_order':all(position>=0 for position in positions)and positions==sorted(positions),'native_final_before_new_prompt':len(assistants)>=2 and assistants[-1].get('content')==[{'type':'text','text':'OWNED_NATIVE_MAIN_READ_FINAL'}]}
    return {'checks':checks,'result_content_sha256':sha(result[0]['content'].encode())if len(result)==1 and isinstance(result[0].get('content'),str)else None,'marker_positions':positions}


class ImportMock:
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
                path=self.path.split('?')[0]
                with state.lock:
                    retained=dict(body);retained.pop('metadata',None);seen=observation(body,state.facts)if path=='/v1/messages'else None;state.requests.append({'path':self.path,'body':retained,'observation':seen})
                    if path=='/v1/messages':state.generation+=1
                    generation=state.generation
                    if path not in ['/v1/messages','/v1/messages/count_tokens']or generation>1 or seen and not all(seen['checks'].values()):state.halt='OWNED_NATIVE_MAIN_READ_IMPORT_FAILURE'
                if path=='/v1/messages/count_tokens':self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":32}');return
                if path!='/v1/messages'or generation>2:self.send_error(400);return
                content=[{'type':'text','text':state.halt or FINAL}];self.send_response(200)
                if body.get('stream'):
                    wire=events(content,'end_turn',MODEL);wire[0]['message']['id']='msg_owned_native_main_read_import_'+str(generation);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(''.join('event: '+row['type']+'\ndata: '+json.dumps(row)+'\n\n'for row in wire).encode())
                else:
                    self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':'msg_owned_native_main_read_import_'+str(generation),'type':'message','role':'assistant','model':MODEL,'content':content,'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':3}}).encode())
        return Handler


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['tau','readiness']);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/native-main-read-import');args=parser.parse_args();directory=args.artifacts.resolve();directory.mkdir(parents=True,exist_ok=True);stem=args.mode+'-main-read-import'
    if any(directory.glob(stem+'.*')):raise RuntimeError('Refusing capture/failure/bootstrap overwrite')
    source=verify_source();raw,source_before,facts=load_source();state=ImportMock(facts);isolation=Isolation(directory,state.handler())
    try:
        isolation.env.update(bun_environment(isolation.root));isolation.verify();copied=isolation.root/'imported/native-main-read.jsonl';copied.parent.mkdir();clone_file(RAW,copied);copied.chmod(0o400);copied_raw,copied_before=bounded_file(isolation.root,copied);writer_before=writer_directory_snapshot(isolation.root,copied.parent)
        if copied_raw!=raw or(source_before['device'],source_before['inode'])==(copied_before['device'],copied_before['inode']):raise RuntimeError('Capture copy differs/shared inode')
        old_cwd_existed=Path(facts['source_cwd']).exists();bun,entry,runtime,probes=prepare_bun_adapter(isolation,directory,stem);command=[str(bun),'--no-install',str(entry)];arguments=['--resume',str(copied),'--model',MODEL,'--tools','','--print',PROMPT,'--max-turns','1','--output-format','json']
        if args.mode=='readiness':
            fixture=isolation.root/'owned-read-import-messages.json';fixture.write_text(json.dumps(facts['baseline']));authored=isolation.root/'owned-read-import-protocol.cjs';authored.write_text(PROGRAM);command=[str(bun),'--no-install',str(authored),str(fixture)];arguments=[]
        isolation.report['port_entrypoint_executed']=args.mode=='tau';result,cleanup=run_stage(isolation,command,arguments);_,source_after=bounded_file(REPO,RAW);_,copied_after=bounded_file(isolation.root,copied);writer_after=writer_directory_snapshot(isolation.root,copied.parent);archives=archive_snapshot(isolation.root);native=transcript_snapshot(isolation.root);requests=[row for row in state.requests if row['path'].split('?')[0]=='/v1/messages']
        checks={'cli_success':result['exit_code']==0 and not result['timed_out']and not result['output_limited'],'one_messages_request':len(requests)==1,'hard_two_request_cap':len(requests)<=2,'no_mock_halt':state.halt is None,'history_oracle':bool(requests)and all(all(row['observation']['checks'].values())for row in requests),'group_clean':not cleanup['remaining_members'],'source_raw_unchanged':source_before==source_after and source_after['sha256']==RAW_SHA,'copied_raw_unchanged':copied_before==copied_after and copied_after['sha256']==RAW_SHA,'writer_directory_unchanged':writer_before==writer_after,'archive_guards':not archives['guards'],'no_native_write':not native['files']and not native['guards'],'old_cwd_absent':not old_cwd_existed and not Path(facts['source_cwd']).exists()}
        output=None
        if args.mode=='tau':
            output=json.loads(result['stdout']);saved=[item['json']for item in archives['files'].values()if isinstance(item.get('json'),dict)and item['json'].get('id')==SESSION_ID];checks.update({'final_marker':output.get('result')==FINAL,'native_session_id':output.get('session_id')==SESSION_ID,'one_current_workspace_archive':len(saved)==1 and saved[0].get('cwd')==str(isolation.root/'work'),'archive_contains_import_and_new_reply':bool(saved)and all(all(marker in json.dumps(value.get('messages'))for marker in ['OWNED_NATIVE_MAIN_READ_PROMPT','OWNED_NATIVE_MAIN_READ_FINAL',PROMPT,FINAL])for value in saved)})
        else:checks.update({'authored_protocol_ready':result['stdout']=='owned-native-main-read-import-ready','no_archive_fabricated':not archives['files']})
        record={'mode':args.mode,'source_preflight':source,'source_before':source_before,'source_after':source_after,'copied_before':copied_before,'copied_after':copied_after,'source_path':str(RAW),'capture_sha256':CAPTURE_SHA,'source_session_id':SESSION_ID,'checkpoint':facts['selected_checkpoint'],'isolation':isolation.report,'runtime':runtime,'runtime_probes':probes,'arguments':arguments,'command':command,'result':result,'cleanup':cleanup,'requests':state.requests,'mock_halt':state.halt,'output':output,'archives':archives,'native_snapshots':native,'writer_before':writer_before,'writer_after':writer_after,'checks':checks,'original_executed':False,'port_entrypoint_executed':args.mode=='tau','configured_hooks':0,'current_workspace':str(isolation.root/'work')}
        (directory/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for key,item in archives['files'].items():
            destination=directory/(stem+'.archives')/key;destination.parent.mkdir(parents=True,exist_ok=True)
            with destination.open('xb')as stream:stream.write(base64.b64decode(item['raw_base64']))
        for name in ['stdout','stderr']:(directory/(stem+'.'+name+'.txt')).write_text(result[name])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(directory/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'mode':args.mode,'checks':checks,'messages':len(requests),'original_executed':False,'port_entrypoint_executed':args.mode=='tau'}))
    except Exception as error:
        (directory/(stem+'.failure.json')).write_text(json.dumps({'error':{'type':type(error).__name__,'message':str(error)},'isolation':isolation.report,'requests':state.requests,'snapshot_drift':getattr(error,'evidence',None)},indent=2)+'\n');raise
    finally:isolation.close()
    if not all(checks.values()):raise SystemExit(3)


if __name__=='__main__':main()
