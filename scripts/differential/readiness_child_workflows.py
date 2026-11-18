#!/usr/bin/env python3
"""Run authored copied-Node rehearsals only; never start original or Tau."""
import argparse
import json
from pathlib import Path
import shlex

from isolation import REPO,clone_file
from prepare_child_workflows import CASES,ENV,ChildWorkflowMock,recipe,verify,START_MARKER
from run_skill_effort import verified_effort_isolation
from run_skills import run_stage
from run_tau import copy_runtime,digest


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('case',choices=CASES);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/child-workflows-readiness');args=parser.parse_args();directory=args.artifacts.resolve();stem='readiness-'+args.case
    if(directory/(stem+'.json')).exists():raise RuntimeError('Refusing readiness capture overwrite')
    source=verify();state=ChildWorkflowMock(args.case)
    with verified_effort_isolation(directory,state.handler(),ENV)as isolation:
        node,entry,runtime=copy_runtime(isolation.root);plan=recipe(isolation.root,node,args.case);state.file_path=isolation.root/'work/owned-child-input.txt';state.file_path.write_text('OWNED_CHILD_READ_FILE\n')
        for name,text in plan['files'].items():path=Path(name);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)
        if plan['settings']:(isolation.root/'config/settings.json').write_text(json.dumps(plan['settings'])+'\n')
        fixture=Path(plan['fixture']);clone_file(REPO/'scripts/differential/child_capability_fixture.cjs',fixture)
        hook_probe=None
        if args.case=='child-capabilities':
            input_path=isolation.root/'hook-readiness-input.json';input_path.write_text(json.dumps({'hook_event_name':'SubagentStart','agent_id':'owned-probe-agent','agent_type':'owned-capable'})+'\n')
            shell='exec '+shlex.join([str(node),str(fixture),'hook',str(isolation.root/'hook-readiness.jsonl')])+' < '+shlex.quote(str(input_path))
            hook_probe=isolation.sandbox(['/bin/sh','-c',shell])
            if hook_probe['exit_code']!=0 or hook_probe['timed_out']or START_MARKER not in hook_probe['stdout']:raise RuntimeError('Copied owned hook readiness failed')
        command=[str(node),str(fixture),'ready','http://127.0.0.1:'+str(isolation.port),args.case];outcome,cleanup=run_stage(isolation,command,[])
        rows=[r for r in state.requests if r['path'].split('?')[0]=='/v1/messages'];checks={'owned_node_success':outcome['exit_code']==0 and outcome['stdout']=='owned-child-workflow-ready','mock_only_expected_requests':len(rows)==plan['expected_messages'],'scope_counts':state.generations==plan['expected_scopes'],'group_clean':not cleanup['remaining_members'],'task_list_env_absent':'CLAUDE_CODE_TASK_LIST_ID'not in isolation.env,'no_cli_started':isolation.report.get('original_executed',False)is False}
        record={'case':args.case,'source_preflight':source,'isolation':isolation.report,'runtime':runtime,'recipe':plan,'fixture_sha256':digest(fixture),'hook_probe':hook_probe,'requests':state.requests,'scope_generations':state.generations,'result':outcome,'cleanup':cleanup,'checks':checks,'original_executed':False,'tau_executed':False,'scope_classifier':'Direct child user text contains owned delegation marker; no vendor system prompt/description marker is used.'}
        (directory/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({'case':args.case,'checks':checks,'mock_only_requests':len(rows),'source_spans':source['spans'],'original_executed':False,'tau_executed':False}))
    if not all(checks.values()):raise SystemExit(3)


if __name__=='__main__':main()
