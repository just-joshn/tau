#!/usr/bin/env python3
"""Pinned memory controls and authored mock; no target execution on import."""
import hashlib
import json
from pathlib import Path

from isolation import REPO,TARGET_SHA256
from prepare_plugins import PINNED_TARGET
from prepare_child_workflows import direct_user_texts
from run_agents import AgentMock
from run_native_import import bounded_file
from run_plugins import results

MODEL='claude-sonnet-4-6'
NAME='owned-memory-reader'
CASES=['user','project','project-plan']
ENV={'CLAUDE_CODE_FORK_SUBAGENT':'0','CLAUDE_CODE_DISABLE_AUTO_MEMORY':'false'}
OLD='OWNED_MEMORY_INDEX_OLD'
UPDATED='OWNED_MEMORY_INDEX_UPDATED'
TOPIC='OWNED_MEMORY_TOPIC_BODY\n'
PROJECT='OWNED_PROJECT_MEMORY_INDEX\n'
PLAN='OWNED_PLAN_MEMORY_INDEX\n'
PARENT_FINAL='OWNED_MEMORY_PARENT_FINAL'


def marker(case,scope):return'OWNED_MEMORY_DELEGATION_'+case.upper().replace('-','_')+'_'+scope.upper()


def locations(root,case):
    directory=root/'.claude/agent-memory'/NAME if case=='user'else root/'work/.claude/agent-memory'/NAME
    return{'directory':directory,'index':directory/'MEMORY.md','topic':directory/'topic.md','refused':directory/'refuse.txt','definition':root/'.claude/agents'/(NAME+'.md')}


def recipe(root,case):
    paths=locations(root,case);scope='user'if case=='user'else'project'
    definition='---\nname: '+NAME+'\ndescription: Owned memory workflow fixture\ntools: Read\nmemory: '+scope+'\nmodel: inherit\nmaxTurns: 6\n---\nOWNED_MEMORY_AGENT_BODY\nPerform only the owned delegation, then return its owned final marker.\n'
    arguments=['--print','OWNED_MEMORY_PARENT_'+case.upper(),'--model',MODEL,'--tools','Agent,Read,Write,Edit','--output-format','json','--max-turns','4']
    if case=='project-plan':arguments+=['--permission-mode','plan']
    return{'definition':definition,'arguments':arguments,'paths':{key:str(value)for key,value in paths.items()},'expected_messages':10 if case=='user'else 4,'expected_scopes':{'parent':4,'first':5,'second':1}if case=='user'else{'parent':2,'first':2,'second':0},'hooks':0,'memory_scope':scope,'permission_outcome':'provisional; record native allowed/held/agent-held'if case=='project-plan'else'normal memory Markdown allowance; txt held'}


def file_state(root,path):
    if not path.exists()and not path.is_symlink():return{'exists':False}
    try:
        raw,receipt=bounded_file(root,path);return{'exists':True,**receipt,'text':raw.decode('utf-8','replace')}
    except(OSError,ValueError)as error:return{'exists':True,'guard_error':str(error)}


def memory_state(root,case):
    paths=locations(root,case)
    return{key:file_state(root,paths[key])for key in ['index','topic','refused','definition']}


def system_text(body):
    value=body.get('system',[])
    return value if isinstance(value,str)else'\n'.join(block.get('text','')for block in value if isinstance(block,dict)and block.get('type')=='text')


class MemoryMock(AgentMock):
    def __init__(self,case,readiness=False):
        super().__init__(case);self.generations={'parent':0,'first':0,'second':0};self.root=None;self.halt=None;self.readiness=readiness;self.responses=[];self.message_cap=20
    def scope(self,body):
        found=[scope for scope in ['first','second']if any(marker(self.case,scope)in text for text in direct_user_texts(body))]
        if len(found)>1:self.halt='OWNED_MEMORY_AMBIGUOUS_SCOPE'
        return found[0]if len(found)==1 else'parent'
    def response(self,scope,generation):
        expected=recipe(self.root,self.case)['expected_scopes']
        if generation>expected[scope]:self.halt='OWNED_MEMORY_UNEXPECTED_GENERATION'
        rows=[row for row in self.requests if row['scope']==scope and row['path'].split('?')[0]=='/v1/messages'];current=rows[generation-1];snapshot=memory_state(self.root,self.case);current['memory_state']=snapshot
        paths=locations(self.root,self.case);body=current['body'];text=system_text(body);seen=results(body);checks={}
        if scope in ['first','second']and self.case!='project-plan':checks['memory_child_tools']=set(tool['name']for tool in body.get('tools',[]))=={'Read','Write','Edit'}
        if self.case=='user':
            if scope=='first'and generation==1:checks.update(index_loaded=OLD in text,topic_not_preloaded=TOPIC.strip()not in text)
            if scope=='first'and generation in [2,3,4,5]:
                previous=seen.get('owned-memory-first-'+str(generation-1),{});checks['previous_result_present']=bool(previous)
                if generation<5:checks['previous_tool_succeeded']=not previous.get('is_error',False)
                else:checks['txt_refused']=previous.get('is_error')is True and not snapshot['refused']['exists']
            if scope=='first'and generation==2:checks['read_returned_index']=OLD in json.dumps(seen.get('owned-memory-first-1'))
            if scope=='first'and generation>=3:checks['index_edit_persisted']=snapshot['index'].get('text')==UPDATED+'\n'
            if scope=='first'and generation>=4:checks['topic_write_persisted']=snapshot['topic'].get('text')==TOPIC
            if scope=='second':checks.update(updated_index_loaded=UPDATED in text,old_index_absent=OLD not in text,topic_not_preloaded=TOPIC.strip()not in text)
            if scope=='parent'and generation==4:checks['parent_read_topic']=TOPIC.strip()in json.dumps(seen.get('owned-memory-parent-3'))
        elif self.case=='project':
            if scope=='first'and generation==1:checks.update(memory_location_in_prompt=str(paths['directory'])in text,new_index_not_preloaded=PROJECT.strip()not in text)
            if scope=='first'and generation==2:checks.update(project_write_succeeded=not seen.get('owned-memory-first-1',{}).get('is_error',False),project_index_written=snapshot['index'].get('text')==PROJECT)
        current['observation']={'checks':checks,'memory_directory_in_system':str(paths['directory'])in text,'system_markers':{value:value in text for value in [OLD,UPDATED,TOPIC.strip(),PROJECT.strip(),PLAN.strip()]},'tool_names':[tool['name']for tool in body.get('tools',[])]}
        if not self.readiness and(not all(checks.values())or any('guard_error'in item for item in snapshot.values())):self.halt='OWNED_MEMORY_EFFECT_ORACLE_FAILURE'
        action=None;answer=PARENT_FINAL if scope=='parent'else'OWNED_MEMORY_'+scope.upper()+'_CHILD_FINAL'
        if not self.halt:
            if scope=='parent'and generation==1 or self.case=='user'and scope=='parent'and generation==2:
                child='first'if generation==1 else'second';action=('Agent',{'subagent_type':NAME,'description':'Owned '+child+' memory workflow','prompt':marker(self.case,child)+'\nPerform only the owned memory steps and finish.','run_in_background':False})
            elif scope=='parent'and self.case=='user'and generation==3:action=('Read',{'file_path':str(paths['topic'])})
            elif scope=='first'and self.case=='user':
                steps=[('Read',{'file_path':str(paths['index'])}),('Edit',{'file_path':str(paths['index']),'old_string':OLD,'new_string':UPDATED}),('Write',{'file_path':str(paths['topic']),'content':TOPIC}),('Write',{'file_path':str(paths['refused']),'content':'OWNED_MEMORY_MUST_NOT_WRITE\n'})]
                if generation<=len(steps):action=steps[generation-1]
            elif scope=='first'and generation==1:action=('Write',{'file_path':str(paths['index']),'content':PLAN if self.case=='project-plan'else PROJECT})
        else:answer=self.halt
        content=[{'type':'tool_use','id':'owned-memory-'+scope+'-'+str(generation),'name':action[0],'input':action[1]}]if action else[{'type':'text','text':answer}];stop='tool_use'if action else'end_turn'
        self.responses.append({'scope':scope,'generation':generation,'content':content,'stop_reason':stop});return content,stop


def verify():
    names=['agent-memory-research','agent-memory-session-research','agent-definition-hooks-research','subagents-research','agents-research'];spans=[];groups={};modules={row['name']:row for row in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']}
    for name in names:
        path=REPO/'artifacts'/name/'spans.json';rows=json.loads(path.read_text());groups[name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'spans':rows};spans.extend(rows)
    required={'agent_memory_definition_tool_extension','agent_memory_child_prime_consumer','agent_definition_hooks_UD_memory_beforeStart','agent_definition_hooks_ca','agent_definition_hooks_subagent_start_child_consumer'}
    if not required<={row['id']for row in spans}or len(groups[names[0]]['spans'])<52 or len(groups[names[1]]['spans'])<49:raise RuntimeError('Memory source handshake incomplete')
    env=[row for row in json.loads((REPO/'artifacts/native-main-capture-research/spans.json').read_text())if row['id']=='native_main_config_root_env']
    if len(env)!=1:raise RuntimeError('Owned configuration-root proof missing')
    spans+=env;groups['configuration-root']={'spans':env}
    with PINNED_TARGET.open('rb')as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Retained target differs')
        for name in {row['module']for row in spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Memory source module differs')
        for row in spans:
            target.seek(row['offset']);raw=target.read(row['length'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256']or raw.decode()!=row['text']:raise RuntimeError('Memory installed source span differs')
    return{'target_sha256':TARGET_SHA256,'spans':len(spans),'groups':groups,'all_equal':True,'original_executed':False,'recovered_code_executed':False,'plan_memory_upstream_question':'Local iA allowance precedes generic plan hold; all upstream wrappers not proven. Case C outcome remains provisional.'}
