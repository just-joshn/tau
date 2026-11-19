#!/usr/bin/env python3
"""Two causal Agent ask controls, accounting for the earlier agent pair budget."""
import argparse
import hashlib
import json
from pathlib import Path

from compare_agents import summarize,case_assertions
from run_agents import POLICY_CASES
from isolation import TARGET_SHA256


def sha(raw):return hashlib.sha256(raw).hexdigest()


def assertions(case,view):
    checks=case_assertions('reader' if case=='named-ask' else 'unknown',view)
    checks['exact_owned_rule']=view['user_settings']=={'permissions':{'ask':[POLICY_CASES[case]]}}
    checks['same_existing_agent_type']=view['tool_calls']['parent']['owned-agent-parent-tool']['input']['subagent_type']=='owned-reader'
    checks['policy_source_proof']=bool(view['policy_source_verified'])
    return checks


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=Path('artifacts/differential-pass/agent-asks'));parser.add_argument('--tau',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();cases={};views=[]
    selected=['request_count','scopes','models','tool_calls','tool_errors','child_tool_sets','parent_tool_sets','child_system_marker_present','parent_result_contains_child_final','child_read_contains_owned_file','owned_file','user_settings']
    for case in POLICY_CASES:
        original=summarize((args.original/('original-'+case+'.json')).resolve());views.append(original);entry={'original':original,'original_assertions':assertions(case,original)}
        if args.tau and (args.tau/('tau-'+case+'.json')).exists():
            tau=summarize((args.tau/('tau-'+case+'.json')).resolve());views.append(tau);checks={key:original[key]==tau[key] for key in selected+['tool_results','child_transcript_manifest','owned_tau_child_archives']}
            checks['final_answer']=original['cli']['result']==tau['cli']['result']
            for key in ['subagent_tokens','tool_uses']:checks['reported_'+key]=original['parent_result_report_stats'][key]==tau['parent_result_report_stats'][key]
            for key in ['usage','modelUsage','subagent_stats','parent_token_projection','global_model_token_projection','stdout_keys','group_killed']:checks['cli_'+key]=original['cli'][key]==tau['cli'][key]
            for key in ['tool_names','tool_schemas','request_controls','safe_headers','message_layout']:checks['request_'+key]=[r[key] for r in original['requests']]==[r[key] for r in tau['requests']]
            entry.update(tau=tau,tau_assertions=assertions(case,tau),checks=checks,differences=[key for key,value in checks.items() if not value])
        cases[case]=entry
    complete=all('tau'in e for e in cases.values());runtimes={sha(json.dumps(e['tau']['runtime'],sort_keys=True).encode()) for e in cases.values() if 'tau'in e}
    prior_path=Path('artifacts/differential-pass/agents-tau-before/comparison.json');prior=json.loads(prior_path.read_text())
    audits={'all_canaries_passed':all(v['isolation']['passed'] for v in views),'all_roots_removed':all(v['isolation']['root_removed'] for v in views),'headroom_at_least_1GiB':all(v['isolation']['headroom']>=1024**3 for v in views),
            'one_unchanged_profile':len({v['isolation']['profile_sha256'] for v in views})==1,'original_cow_copies_verified':all(e['original']['isolation']['target_copy']['distinct_inode'] and e['original']['isolation']['target_copy']['sha256']==TARGET_SHA256 for e in cases.values()),
            'all_source_and_policy_verified':all(v['source_verified'] and v['policy_source_verified'] for v in views),'one_tau_runtime':not args.tau or len(runtimes)==1,
            'bounded_cli':all(v['cli']['exit']==0 and not v['cli']['timeout'] and not v['cli']['limited'] for v in views),'no_survivors':all(not v['cli']['cleanup']['remaining_members'] for v in views)}
    new_messages=sum(v['request_count'] for v in views)
    report={'scope':'Two fresh ordinary foreground custom-agent ask rules only. Exact named ask and generic primitive-field ask are distinct; no background/resume/observer ask-policy claim.',
            'complete_pair_set':complete,'selected_fields':selected+['final_answer'],'all_selected_equal':complete and all(e['checks'][key] for e in cases.values() for key in selected+['final_answer']),
            'all_original_assertions':all(all(e['original_assertions'].values()) for e in cases.values()),'all_tau_assertions':complete and all(all(e['tau_assertions'].values()) for e in cases.values()),
            'prior_pair_comparison_sha256':sha(prior_path.read_bytes()),'prior_pair_messages':prior['messages_requests'],'new_cli_invocations':len(views),'new_messages_requests':new_messages,
            'aggregate_agent_messages':prior['messages_requests']+new_messages,'aggregate_within_24':prior['messages_requests']+new_messages<=24,
            'audits':audits,'tau_runtime_sha256_set':sorted(runtimes),'cases':cases}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({key:value for key,value in report.items() if key not in ['cases','selected_fields']},indent=2))
    for case,e in cases.items():print(case,e.get('differences','Tau not recorded'))


if __name__=='__main__':main()
