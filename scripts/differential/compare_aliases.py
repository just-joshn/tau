#!/usr/bin/env python3
"""Text-only alias controls; separate selected wire fields from raw framing."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import TARGET_SHA256
from run_aliases import CASES,REQUIRED_PROOFS


def sha(raw):return hashlib.sha256(raw).hexdigest()


def summarize(path):
    record=json.loads(path.read_text());root=record['isolation']['root'];requests=[]
    for row in record['requests']:
        if row['path'].split('?')[0]!='/v1/messages':continue
        body=row['body'];betas=row['safe_headers'].get('anthropic-beta','').split(',')
        requests.append({'path':row['path'],'model':body.get('model'),'max_tokens':body.get('max_tokens'),'thinking':body.get('thinking'),
                         'thinking_type':(body.get('thinking') or {}).get('type'),'output_config':body.get('output_config'),
                         'tool_count':len(body.get('tools',[])),'tools_field_present':'tools'in body,
                         'beta_list':betas,'beta_set':sorted(set(betas)),'effort_beta':'effort-2025-11-24'in betas,
                         'long_context_betas':[beta for beta in betas if beta.startswith('context-1m-')],
                         'safe_headers':row['safe_headers'],'request_controls':{key:value for key,value in body.items() if key not in ['system','messages','tools']},
                         'request_keys':sorted(body)})
    stage=record['stages'][0];outcome=stage['result'];stdout=json.loads(outcome['stdout']);source=record['source_preflight']
    profile=record['isolation']['profile'].replace(root,'<ROOT>').replace(record['isolation']['tag'],'<TAG>').replace('localhost:'+str(record['isolation']['network_port']),'localhost:<PORT>')
    return {'artifact':str(path),'sha256':sha(path.read_bytes()),'alias':record['alias'],'request_count':len(requests),'all_http_requests':len(record['requests']),'requests':requests,
            'cli':{'exit':outcome['exit_code'],'timeout':outcome['timed_out'],'limited':outcome['output_limited'],'result':stdout.get('result'),'stdout_keys':sorted(stdout),'stderr':outcome['stderr'],'cleanup':stage['cleanup']},
            'isolation':{'passed':record['isolation']['passed'],'checks':record['isolation']['checks'],'root_removed':not Path(root).exists(),
                         'headroom':record['isolation']['disk_headroom_at_context_start'],'profile_sha256':sha(profile.encode()),'target_copy':record['isolation'].get('target_copy')},
            'source_verified':source['all_equal'] and not source['recovered_code_executed'] and REQUIRED_PROOFS<={r['id'] for r in source['spans']} and len(source['spans'])>=32,
            'runtime':record['runtime'],'hooks_configured':record['hooks_configured']}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=Path('artifacts/differential-pass/aliases'));parser.add_argument('--tau',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();cases={};views=[]
    selected=['model','max_tokens','thinking_type','output_config','tool_count','effort_beta','long_context_betas']
    raw=['thinking','beta_list','beta_set','safe_headers','request_controls','request_keys','tools_field_present','path']
    for case in CASES:
        original=summarize((args.original/('original-'+case+'.json')).resolve());views.append(original);entry={'original':original}
        if args.tau and (args.tau/('tau-'+case+'.json')).exists():
            tau=summarize((args.tau/('tau-'+case+'.json')).resolve());views.append(tau);checks={key:[r[key] for r in original['requests']]==[r[key] for r in tau['requests']] for key in selected+raw}
            checks['final_answer']=original['cli']['result']==tau['cli']['result'];checks['request_count']=original['request_count']==tau['request_count'];checks['stdout_framing']=original['cli']['stdout_keys']==tau['cli']['stdout_keys'];entry.update(tau=tau,checks=checks,differences=[key for key,value in checks.items() if not value])
        cases[case]=entry
    complete=all('tau'in e for e in cases.values());runtimes={sha(json.dumps(e['tau']['runtime'],sort_keys=True).encode()) for e in cases.values() if 'tau'in e}
    audits={'all_canaries_passed':all(v['isolation']['passed'] for v in views),'all_roots_removed':all(v['isolation']['root_removed'] for v in views),
            'headroom_at_least_1GiB':all(v['isolation']['headroom']>=1024**3 for v in views),'one_unchanged_profile':len({v['isolation']['profile_sha256'] for v in views})==1,
            'original_cow_copies_verified':all(e['original']['isolation']['target_copy']['distinct_inode'] and e['original']['isolation']['target_copy']['sha256']==TARGET_SHA256 for e in cases.values()),
            'all_source_preflight_verified':all(v['source_verified'] for v in views),'one_tau_runtime':not args.tau or len(runtimes)==1,
            'one_text_request_each':all(v['request_count']==1 for v in views),'empty_tools_no_hooks':all(not v['hooks_configured'] and all(r['tool_count']==0 for r in v['requests']) for v in views),
            'cli_bounded_clean':all(v['cli']['exit']==0 and not v['cli']['timeout'] and not v['cli']['limited'] and not v['cli']['cleanup']['remaining_members'] for v in views)}
    report={'scope':'Three text-only aliases in the current pinned binary/dummy first-party isolation only; no environment family override or personal account configuration. No general provider/account alias guarantee.',
            'complete_pair_set':complete,'selected_fields':selected+['final_answer','request_count'],'all_selected_equal':complete and all(e['checks'][key] for e in cases.values() for key in selected+['final_answer','request_count']),
            'audits':audits,'cli_invocations':len(views),'messages_requests':sum(v['request_count'] for v in views),'all_http_requests':sum(v['all_http_requests'] for v in views),
            'tau_runtime_sha256_set':sorted(runtimes),'cases':cases}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({key:value for key,value in report.items() if key not in ['cases','selected_fields']},indent=2))
    for case,e in cases.items():print(case,e.get('differences','Tau not recorded'))


if __name__=='__main__':main()
