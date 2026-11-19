#!/usr/bin/env python3
"""Selected effort request projection; retains defaults and unnormalized wire gaps."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import TARGET_SHA256
from run_skill_effort import CASES, MODEL


def sha(value):return hashlib.sha256(value).hexdigest()


def summarize(path):
    record=json.loads(path.read_text());root=record['isolation']['root'];requests=[];results={};bodies=[]
    for ri,request in enumerate(record['requests']):
        if request['path'].split('?')[0]!='/v1/messages':continue
        body=request['body'];headers=request['safe_headers'];beta=headers.get('anthropic-beta','').split(',')
        requests.append({'model':body.get('model'),'output_config':body.get('output_config'),'thinking':body.get('thinking'),
                         'safe_headers':headers,'beta_list':beta,'effort_beta_present':'effort-2025-11-24' in beta,
                         'request_controls':{key:value for key,value in body.items() if key not in ['system','messages','tools']},
                         'request_keys':sorted(body),'tools':[{'name':t['name'],'schema':t.get('input_schema')} for t in body.get('tools',[])]})
        for mi,message in enumerate(body.get('messages',[])):
            content=message.get('content',[])
            if not isinstance(content,list):content=[{'type':'text','text':content}]
            for bi,block in enumerate(content):
                if block.get('type')=='tool_result':results[block['tool_use_id']]={'is_error':bool(block.get('is_error')),'raw':block}
                if 'OWNED_EFFORT_BODY_' in str(block):
                    bodies.append({'request':ri,'role':message['role'],'type':block.get('type'),'args_replaced':'OWNED_EFFORT_ARGS owned argument' in str(block),
                                   'preceding_result_ids':[b['tool_use_id'] for b in content[:bi] if b.get('type')=='tool_result'],
                                   'text':str(block.get('text','')).replace(root,'<ROOT>')})
    stage=record['stages'][0];result=stage['result'];stdout=json.loads(result['stdout'])
    profile=record['isolation']['profile'].replace(root,'<ROOT>').replace(record['isolation']['tag'],'<TAG>').replace('localhost:'+str(record['isolation']['network_port']),'localhost:<PORT>')
    return {'artifact':str(path),'sha256':sha(path.read_bytes()),'models':[r['model'] for r in requests],
            'efforts':[(r['output_config'] or {}).get('effort') for r in requests],'requests':requests,'request_count':len(requests),
            'tool_errors':[r['is_error'] for r in results.values()],'tool_results':results,'skill_bodies':bodies,
            'cli':{'exit':result['exit_code'],'timeout':result['timed_out'],'limited':result['output_limited'],'result':stdout.get('result'),
                   'stdout_keys':sorted(stdout),'stderr':result['stderr'],'cleanup':stage['cleanup']},
            'isolation':{'passed':record['isolation']['passed'],'checks':record['isolation']['checks'],'headroom':record['isolation']['disk_headroom_at_context_start'],
                         'context_removed':not Path(root).exists(),'normalized_profile_sha256':sha(profile.encode()),'target_copy':record['isolation'].get('target_copy')},
            'runtime':record['runtime'],'source_spans_verified':record['source_preflight']['all_equal'] and len(record['source_preflight']['spans'])==9 and not record['source_preflight']['recovered_code_executed'],
            'environment_overrides':record['environment_overrides'],'user_settings':record['user_settings'],'hooks_configured':record['hooks_configured']}


def compare(original,tau):
    checks={key:original[key]==tau[key] for key in ['models','efforts','request_count','tool_errors','skill_bodies']}
    checks['final_answer']=original['cli']['result']==tau['cli']['result']
    for key in ['output_config','thinking','effort_beta_present','safe_headers','request_controls','tools']:
        checks[key]=[r[key] for r in original['requests']]==[r[key] for r in tau['requests']]
    checks['raw_tool_results']=original['tool_results']==tau['tool_results']
    checks['stdout_framing']=original['cli']['stdout_keys']==tau['cli']['stdout_keys']
    return {'checks':checks,'differences':[key for key,value in checks.items() if not value]}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=Path('artifacts/differential-pass/skill-effort'));parser.add_argument('--tau',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    cases={};views=[]
    for case in CASES:
        original=summarize((args.original/('original-'+case+'.json')).resolve());views.append(original);entry={'original':original}
        if args.tau and (args.tau/('tau-'+case+'.json')).exists():
            tau=summarize((args.tau/('tau-'+case+'.json')).resolve());views.append(tau);entry.update(tau=tau,comparison=compare(original,tau))
        cases[case]=entry
    runtimes={sha(json.dumps(entry['tau']['runtime'],sort_keys=True).encode()) for entry in cases.values() if 'tau'in entry}
    audits={'all_live_canaries_passed':all(v['isolation']['passed'] for v in views),'all_contexts_removed':all(v['isolation']['context_removed'] for v in views),
            'headroom_at_least_1GiB':all(v['isolation']['headroom']>=1024**3 for v in views),'one_unchanged_profile':len({v['isolation']['normalized_profile_sha256'] for v in views})==1,
            'original_cow_hashes_verified':all(entry['original']['isolation']['target_copy']['distinct_inode'] and entry['original']['isolation']['target_copy']['sha256']==TARGET_SHA256 for entry in cases.values()),
            'one_tau_runtime':not args.tau or len(runtimes)==1,'source_preflight_verified':all(v['source_spans_verified'] for v in views),
            'all_cli_bounded_clean':all(v['cli']['exit']==0 and not v['cli']['timeout'] and not v['cli']['limited'] and not v['cli']['cleanup']['remaining_members'] for v in views),
            'fixed_known_model':all(all(model==MODEL for model in v['models']) for v in views),'no_hooks':all(not v['hooks_configured'] for v in views)}
    complete=all('tau'in e for e in cases.values());selected=['models','efforts','request_count','tool_errors','skill_bodies','final_answer','output_config','effort_beta_present']
    report={'scope':'Three owned Skill effort cases only; exact known model, unique response IDs, no hooks/grants. Raw requests preserve defaults/thinking/betas and framing.',
            'complete_pair_set':complete,'selected_fields':selected,'all_selected_equal':complete and all(e['comparison']['checks'][field] for e in cases.values() for field in selected),
            'audits':audits,'cli_invocations':len(views),'messages_requests':sum(v['request_count'] for v in views),'tau_runtime_sha256_set':sorted(runtimes),'cases':cases}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:value for key,value in report.items() if key not in ['cases','selected_fields']},indent=2))
    for case,e in cases.items():print(case,e.get('comparison',{}).get('differences','Tau not recorded'))


if __name__=='__main__':main()
