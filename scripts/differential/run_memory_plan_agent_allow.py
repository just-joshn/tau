#!/usr/bin/env python3
"""Independent C2 memory control; app execution requires separate root GO."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sys

from isolation import REPO,TARGET_SHA256
from prepare_plugins import PINNED_TARGET
import prepare_memory_workflows as memory
import run_memory_workflows as base

RULE='Agent'
BASE_HASHES={'run_memory_workflows.py':'6978c70141edbc237d4b1f84fc5d636c527142d881f2b8c4ed6318bbfc0a9242','prepare_memory_workflows.py':'1cedd177c55af6deabb84fb31677df8defde3cc47de875775bb257ace89d2df1'}
base_assertions=base.assertions


def verify_control_source():
    for name,expected in BASE_HASHES.items():
        if hashlib.sha256((REPO/'scripts/differential'/name).read_bytes()).hexdigest()!=expected:raise RuntimeError('Reviewed base memory harness changed')
    result=memory.verify();groups={};rows=[];modules={row['name']:row for row in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']}
    for name in ['agent-policy-research','memory-plan-agent-allow-research']:
        path=REPO/'artifacts'/name/'spans.json';spans=json.loads(path.read_text());groups[name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'spans':spans};rows+=spans
    required={'agent_rule_generic_whole_tool_match','agent_rule_task_alias','agent_tool_permission_mode_predicate','memory_c2_allow_lookup_whole_tool','memory_c2_allow_rule_gate','memory_c2_checked_allow_before_ask','memory_c2_allow_returns_before_outer_review','memory_c2_agent_passthrough_and_readonly','memory_c2_early_plan_readonly_floor'}
    if not required<={row['id']for row in rows}:raise RuntimeError('C2 Agent-only allow precedence proof incomplete')
    with PINNED_TARGET.open('rb')as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Retained target changed')
        for name in {row['module']for row in rows}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('C2 source module changed')
        for row in rows:
            target.seek(row['offset']);raw=target.read(row['length'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256']or raw.decode()!=row['text']:raise RuntimeError('C2 installed bytes differ')
    result['groups'].update(groups);result['spans']+=len(rows);result['control_rule']={'literal':RULE,'scope':'Exact whole named tool only; Agent(type) content is not a whole-tool allow','file_tool_grants':[]};result['base_harness_hashes']=BASE_HASHES;return result


def controlled_recipe(root,case):
    if case!='project-plan':raise RuntimeError('C2 admits only the project-plan control')
    if RULE!='Agent':raise RuntimeError('C2 permits only the literal Agent tool allow rule')
    result=memory.recipe(root,case);result['arguments']=[*result['arguments'],'--allowedTools',RULE]
    if result['arguments'].count('--allowedTools')!=1 or result['arguments'][-1]!=RULE or 'permissionMode:'in result['definition']:raise RuntimeError('C2 control widened beyond Agent or changed inherited mode')
    result['control_variant']='C2 project memory, inherited Plan, bare Agent-only allow';result['agent_only_allow']=RULE;result['read_write_edit_preapprovals']=[];return result


def control_assertions(record):
    checks=base_assertions(record);arguments=record['recipe']['arguments'];position=arguments.index('--allowedTools')if'--allowedTools'in arguments else-1
    exact=RULE=='Agent'and position>=0 and arguments[position+1:]==[RULE]and arguments.count('--allowedTools')==1
    # The base rejects every --allowedTools occurrence. C2 narrowly permits the
    # one approved Agent tool rule, which does not approve Read/Write/Edit.
    checks['no_memory_preapprovals']=exact
    checks['agent_only_allow_control']=exact and record['recipe']['read_write_edit_preapprovals']==[]
    checks['inherited_plan_control']='--permission-mode'in arguments and arguments[arguments.index('--permission-mode')+1]=='plan'and'permissionMode:'not in record['recipe']['definition']
    return checks


@contextmanager
def control_budget(directory,mode,case):
    if case!='project-plan':raise RuntimeError('C2 case changed')
    lock=directory/('.'+mode+'-c2.lock')
    with lock.open('x')as stream:stream.write(str(os.getpid()))
    try:
        if any(directory.glob(mode+'-project-plan.*')):raise RuntimeError('C2 allows one CLI/protocol invocation per mode; no overwrite/rerun')
        yield 6
    finally:lock.unlink()


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['original','tau','readiness','bun-readiness']);parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/memory-plan-agent-allow');args=parser.parse_args()
    # Process-local helper composition only; no base/shared/source file edits.
    base.verify=verify_control_source;base.recipe=controlled_recipe;base.assertions=control_assertions;base.phase_guard=control_budget
    sys.argv=[sys.argv[0],args.mode,'project-plan','--artifacts',str(args.artifacts)];base.main()


if __name__=='__main__':main()
