#!/usr/bin/env python3
"""Pinned source checks and inert recipes for two child-capability workflows."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO,TARGET_SHA256
from prepare_plugins import PINNED_TARGET
from run_agents import AgentMock

CASES=['builtin-default','child-capabilities']
MODEL='claude-sonnet-4-6'
OVERLAY_MODEL='claude-haiku-4-5-20251001'
DELEGATION='OWNED_CHILD_CAP_DELEGATION_ONLY'
START_MARKER='OWNED_CHILD_CAP_START_CONTEXT'
ENV={'CLAUDE_CODE_FORK_SUBAGENT':'0','CLAUDE_CODE_ENABLE_TASKS':'1','CLAUDE_CODE_ENABLE_TODO_TOOLS':'1'}
SETS={
    'child-capabilities-research/spans.json':(55,{'child_capabilities_Vp','child_capabilities_preload_cap_and_start_order','child_capabilities_preload_resolution_and_gates','child_capabilities_preload_render_and_messages','child_capabilities_XC','child_capabilities_scheduler_query_entry_model_snapshot','child_capabilities_scheduler_request_model_and_live_effort_options'}),
    'builtin-agents-research/spans.json':(97,{'builtin_agent_default_guard','builtin_agent_default_type_selection','builtin_agent_collection'}),
    'tasks-research/spans.json':(25,{'task_environment_enable','task_model_enable_gate','task_list_identity_and_storage_path'}),
    'skills-research/spans.json':(30,{'skill_definition_and_progressive_prompt','model_skill_catalog_predicate','conditional_skill_activation'}),
    'skills-integration/admission-spans.json':(14,{'grant_source_refusal_policy','local_command_effect_fields_and_grant_getter'}),
    'skills-integration/spans.json':(19,{'skill_automatic_grant_source_gate','layer_permission_application','tool_scheduler_applies_layers'}),
    'subagents-research/spans.json':(34,{'agent_fork_disable_gate','agent_call_background_schema','agent_child_runquery_parameters'}),
    'agents-research/spans.json':(68,set()),
}


def verify():
    modules={r['name']:r for r in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']};groups={};spans=[]
    for relative,(minimum,required)in SETS.items():
        path=REPO/'artifacts'/relative;rows=json.loads(path.read_text())
        if len(rows)<minimum or not required<={r['id']for r in rows}:raise RuntimeError('Child source handshake incomplete: '+relative)
        groups[relative]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'spans':rows};spans.extend(rows)
    name='chunk-m33vdkhs.js';data=(REPO/'artifacts/claude-bundle'/name).read_bytes();schemas=[]
    for label,start,end in [('command_schema','function wg(){',',n=u({type:T("prompt")'),('matcher_event_schema','xn=m(()=>u({matcher:','function s9a('),('entry_guard','function kg(','function Xo('),('nested_guard','function NNe(','function Sre('),('frontmatter_guard','function Tn(','function awi(')]:
        a=data.index(start.encode());b=data.index(end.encode(),a+len(start.encode()));raw=data[a:b];schemas.append({'id':label,'module':name,'offset':modules[name]['offset']+a,'length':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'text':raw.decode()})
    groups['direct-command-schemas']={'spans':schemas};spans.extend(schemas)
    with PINNED_TARGET.open('rb')as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned retained326 target differs')
        for name in {r['module']for r in spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Child source module differs')
        for row in spans:
            target.seek(row['offset']);raw=target.read(row['length'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256']or raw.decode()!=row['text']:raise RuntimeError('Installed child source bytes differ')
    return {'target_sha256':TARGET_SHA256,'target_source_path':str(PINNED_TARGET),'all_equal':True,'spans':len(spans),'groups':groups,'original_executed':False,'recovered_code_executed':False}


def recipe(root,node,case):
    if case not in CASES:raise ValueError(case)
    files={};settings={};fixture=root/'child-capability-fixture.cjs';log=root/'child-start-lifecycle.jsonl'
    if case=='child-capabilities':
        files[str(root/'work/.claude/agents/owned-capable.md')]='---\nname: owned-capable\ndescription: Owned foreground capability control\ntools: Read,Write,Skill,TaskCreate,TaskGet,TaskUpdate,TaskList\nmodel: inherit\nmaxTurns: 10\nskills: [owned-passive-a, owned-passive-b, owned-passive-a, owned-conditional]\n---\nOWNED_CHILD_CAP_AGENT_SYSTEM\nFollow only the owned delegation and finish with its owned marker.\n'
        docs={
            'owned-passive-a':'---\ndescription: Owned passive metadata control\nallowed-tools: Write\nmodel: '+OVERLAY_MODEL+'\neffort: low\ncontext: fork\n---\nOWNED_CHILD_PASSIVE_A\n',
            'owned-passive-b':'---\ndescription: Owned passive ordering control\n---\nOWNED_CHILD_PASSIVE_B\n',
            'owned-conditional':'---\ndescription: Owned inactive conditional control\npaths: [unmatched-owned-zone/**]\n---\nOWNED_CHILD_CONDITIONAL_BODY\n',
            'owned-child-action':'---\ndescription: Owned invoked child action\nallowed-tools: Write\nmodel: '+OVERLAY_MODEL+'\neffort: low\n---\nOWNED_CHILD_ACTIVE_SKILL_BODY\nOWNED_CHILD_ACTIVE_ARGS $ARGUMENTS\n'}
        for name,text in docs.items():files[str(root/'work/.claude/skills'/name/'SKILL.md')]=text
        hook={'type':'command','command':str(node),'args':[str(fixture),'hook',str(log)],'timeout':3}
        settings={'hooks':{'SubagentStart':[{'matcher':'^owned-capable$','hooks':[hook]}]}}
    tools='Agent,Read'if case=='builtin-default'else'Agent,Read,Write,Skill,TaskCreate,TaskGet,TaskUpdate,TaskList'
    arguments=['--print','OWNED_PARENT_'+case.upper(),'--model',MODEL,'--tools',tools,'--output-format','json','--max-turns','3']
    if case=='child-capabilities':arguments+=['--allowedTools','Skill(owned-child-action)']
    return {'files':files,'settings':settings,'environment':ENV,'arguments':arguments,'fixture':str(fixture),'lifecycle_log':str(log),
            'expected_messages':4 if case=='builtin-default' else 11,'expected_scopes':{'parent':2,'child':2}if case=='builtin-default'else{'parent':3,'child':8},
            'expected_hook_children':0 if case=='builtin-default' else 1,'task_list_env':'absent; record inherited resolved default namespace','task_owner':'ordinary Create owner absent'}


class ChildWorkflowMock(AgentMock):
    def __init__(self,case):
        super().__init__(case);self.message_cap=4 if case=='builtin-default' else 11
    def scope(self,body):
        texts=[b.get('text','')for row in body.get('messages',[])if row.get('role')=='user'for b in row.get('content',[])if isinstance(b,dict)and b.get('type')=='text']
        return'child'if any(DELEGATION in text for text in texts)else'parent'
    def response(self,scope,generation):
        action=None
        if scope=='parent'and generation==1:
            args={'description':'Owned foreground workflow','prompt':DELEGATION+'\n'+('Read exactly once from '+str(self.file_path)+' and return OWNED_CHILD_DEFAULT_FINAL.'if self.case=='builtin-default'else'Perform only the owned capability steps and return OWNED_CHILD_CAP_FINAL.'),'run_in_background':False}
            if self.case=='child-capabilities':args['subagent_type']='owned-capable'
            action=('Agent',args)
        elif scope=='parent'and generation==2 and self.case=='child-capabilities':action=('TaskGet',{'taskId':'1'})
        elif scope=='child':
            if self.case=='builtin-default'and generation==1:action=('Read',{'file_path':str(self.file_path)})
            elif self.case=='child-capabilities':
                actions=[('Write',{'file_path':str(self.file_path.parent/'owned-preload-held.txt'),'content':'OWNED_PRELOAD_MUST_NOT_WRITE\n'}),
                         ('Skill',{'skill':'owned-child-action','args':'owned child argument'}),
                         ('Write',{'file_path':str(self.file_path.parent/'owned-child-written.txt'),'content':'OWNED_CHILD_WRITTEN\n'}),
                         ('TaskCreate',{'subject':'OWNED_CHILD_TASK','description':'OWNED_CHILD_TASK_DESCRIPTION'}),
                         ('TaskGet',{'taskId':'1'}),('TaskUpdate',{'taskId':'1','status':'completed','metadata':{'owned_child_marker':'OWNED_CHILD_TASK_METADATA'}}),('TaskList',{})]
                if generation<=len(actions):action=actions[generation-1]
        if action:return[{'type':'tool_use','id':'owned-childflow-'+scope+'-'+str(generation),'name':action[0],'input':action[1]}],'tool_use'
        final='OWNED_CHILD_DEFAULT_FINAL'if self.case=='builtin-default'else'OWNED_CHILD_CAP_FINAL'
        return[{'type':'text','text':final if scope=='child'else'OWNED_PARENT_WORKFLOW_FINAL'}],'end_turn'


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=REPO/'artifacts/differential-pass/child-workflows-preparation');args=parser.parse_args();proof=verify();args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'source-preflight.json').write_text(json.dumps(proof,indent=2)+'\n');plans={case:recipe(Path('/private/tmp/OWNED_ROOT'),Path('/private/tmp/OWNED_ROOT/runtime/node'),case)for case in CASES}
    (args.output/'recipes.json').write_text(json.dumps(plans,indent=2)+'\n');print(json.dumps({'all_equal':True,'spans':proof['spans'],'expected_original_messages':15,'original_executed':False,'tau_executed':False,'fixture_executed':False}))


if __name__=='__main__':main()
