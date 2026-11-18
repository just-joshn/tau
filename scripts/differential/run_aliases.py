#!/usr/bin/env python3
"""One text-only generation per model alias; source proof required first."""
import argparse
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import threading

from isolation import REPO,TARGET_SHA256,verified_isolation
from mock_api import events
from run_skills import run_stage
from run_tau import copy_runtime,digest

CASES={'sonnet':'sonnet','haiku':'haiku','sonnet-1m':'sonnet[1m]'}
REQUIRED_PROOFS={
    'alias_baked_targets','alias_baked_accessor','alias_jxe_lookup','alias_model_key_mapping','alias_provider_table_construction','alias_provider_selection',
    'alias_hardcoded_provider_resolution','alias_provider_table_and_overrides','alias_catalog_to_provider_key','alias_active_catalog_guard',
    'alias_served_target_lookup','alias_served_target_to_wire','alias_env_and_terminal_fallbacks','alias_h1_dispatch','alias_context_suffix',
    'alias_long_suffix_append','alias_wire_projection_policy','catalog_claude_haiku_4_5','catalog_claude_haiku_5_5',
    'catalog_claude_sonnet_4_6','catalog_claude_sonnet_5_5','effort_wire_projection',
}


class AliasMock:
    def __init__(self,case):self.case=case;self.requests=[];self.generation=0;self.lock=threading.Lock()
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
                if count:self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":32}');return
                if self.path.split('?')[0]!='/v1/messages' or generation>1:self.send_response(400);self.end_headers();return
                content=[{'type':'text','text':'OWNED_ALIAS_FINAL_'+state.case.upper()}];identity='msg_owned_alias_'+state.case+'_'+str(generation)
                if body.get('stream'):
                    wire=events(content,'end_turn',body.get('model'));wire[0]['message']['id']=identity
                    self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(''.join('event: '+item['type']+'\ndata: '+json.dumps(item)+'\n\n' for item in wire).encode())
                else:
                    self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':identity,'type':'message','role':'assistant','model':body.get('model'),'content':content,'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':3}}).encode())
        return Handler


def verify_source():
    if not REQUIRED_PROOFS:raise RuntimeError('Source-owner alias proof handshake pending; no program execution permitted')
    manifest=json.loads((REPO/'artifacts/bundle-manifest.json').read_text());modules={m['name']:m for m in manifest['modules']}
    proof=REPO/'artifacts/model-alias-research/spans.json';spans=json.loads(proof.read_text())
    if not REQUIRED_PROOFS<={row['id'] for row in spans}:raise RuntimeError('Required alias source coverage missing')
    extras={
        'skill-model-effort-research':{'effort_default_precedence','effort_query_env_hook_precedence_and_clamping','request_final_body_output_config','request_thinking_disabled_effort_cap'},
        'query-effort-integration':{'first_party_effort_provider_fallback','catalog_capability_absence_is_not_false','ordinary_effort_max_xhigh_historical_gates'},
        'context-pass':{'context_limits','context_beta_selection','long_context_beta'},
    }
    for directory,ids in extras.items():
        rows=json.loads((REPO/'artifacts'/directory/'spans.json').read_text());selected=[row for row in rows if row['id'] in ids]
        if {row['id'] for row in selected}!=ids:raise RuntimeError('Capability/default/context consumer source coverage missing')
        spans.extend(selected)
    with Path('/Users/josh-desktop/.local/bin/claude').open('rb') as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned target mismatch')
        for name in {row['module'] for row in spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Source module mismatch')
        for row in spans:
            target.seek(row['offset']);raw=target.read(row['length'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256'] or raw.decode()!=row['text']:raise RuntimeError('Installed alias source span mismatch')
    return {'target_sha256':TARGET_SHA256,'proof_sha256':digest(proof),'required_ids':sorted(REQUIRED_PROOFS),'spans':spans,'all_equal':True,'recovered_code_executed':False,
            'review':'Plain text response, empty tool set, sonnet/haiku/sonnet[1m], no family alias environment overrides, dummy config/account state only. Observations are limited to this isolated provider configuration.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('executable',choices=['original','tau']);parser.add_argument('case',choices=CASES);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/aliases');args=parser.parse_args();artifacts=args.artifacts.resolve();stem=args.executable+'-'+args.case
    if (artifacts/(stem+'.json')).exists():raise RuntimeError('Refusing capture overwrite')
    source=verify_source();state=AliasMock(args.case)
    with verified_isolation(artifacts,state.handler()) as isolation:
        if any(key in isolation.env for key in ['ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_MODEL']):raise RuntimeError('Unexpected model environment override')
        runtime=None;probe=None;skipped=[]
        if args.executable=='original':command=[str(isolation.copy_target(Path('/Users/josh-desktop/.local/bin/claude')))]
        else:
            node,entry,runtime=copy_runtime(isolation.root);probe=isolation.sandbox([str(node),'-e','process.stdout.write("owned-alias-node-ready")'])
            if probe['exit_code']!=0 or probe['timed_out'] or probe['stdout']!='owned-alias-node-ready':raise RuntimeError('Copied Node bootstrap failed')
            command=[str(node),'--preserve-symlinks','--preserve-symlinks-main',str(entry)]
        arguments=['--print','OWNED_ALIAS_'+args.case.upper(),'--model',CASES[args.case],'--output-format','json','--tools','']
        if args.executable=='original':arguments.append('--no-session-persistence')
        else:skipped.append('--no-session-persistence')
        isolation.report['original_executed']=args.executable=='original';result,cleanup=run_stage(isolation,command,arguments)
        record={'case':args.case,'alias':CASES[args.case],'executable':args.executable,'target_sha256':TARGET_SHA256 if args.executable=='original' else None,
                'isolation':isolation.report,'runtime':runtime,'runtime_probe':probe,'source_preflight':source,'skipped_original_flags':skipped,
                'response_identity':'unique msg_owned_alias_CASE_GENERATION for the single text-only generation','hooks_configured':False,
                'stages':[{'arguments':arguments,'result':result,'cleanup':cleanup}],'requests':state.requests}
        (artifacts/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for stream in ['stdout','stderr']:(artifacts/(stem+'.'+stream+'.txt')).write_text(result[stream])
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case':args.case,'alias':CASES[args.case],'executable':args.executable,'exit':result['exit_code'],'remaining_group_members':cleanup['remaining_members'],
                          'requests':[{'path':r['path'],'model':r['body'].get('model'),'max_tokens':r['body'].get('max_tokens'),'thinking':r['body'].get('thinking'),'output_config':r['body'].get('output_config'),'tool_count':len(r['body'].get('tools',[])),'safe_headers':r['safe_headers']} for r in state.requests]}))


if __name__=='__main__':main()
