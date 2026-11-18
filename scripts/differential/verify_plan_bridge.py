#!/usr/bin/env python3
"""Installed byte proof only; never executes original or recovered code."""
import hashlib
import json
from pathlib import Path
from isolation import REPO,TARGET_SHA256

OUT=REPO/'artifacts/plan-permission-bridge-research'


def verify():
    manifest=json.loads((REPO/'artifacts/bundle-manifest.json').read_text());modules={row['name']:row for row in manifest['modules']}
    specs=[
        ('headless_identity','chunk-3zn9cw12.js','function ge(){','function UFe('),
        ('prompt_name_identity','chunk-3zn9cw12.js','function Kk(){','function Fxi('),
        ('channels_identity','chunk-3zn9cw12.js','function pk(){','function Jgt('),
        ('full_prompt_availability','chunk-fm2mt1pb.js','function tKr(','var r=dr('),
        ('cli_prompt_tool_option','chunk-g7cw7kap.js','.addOption(new Rs("--permission-prompt-tool',').addOption(new Rs("--permission-prompts'),
        ('cli_prompt_tool_forward','chunk-g7cw7kap.js','permissionPromptToolName:r.permissionPromptTool,','permissionModeSuppliedOnInvocation:'),
        ('permission_wire_schemas','chunk-q6dkrxcc.js','var Eo=m(','function oe('),
        ('permission_answer_application','chunk-q6dkrxcc.js','function MSt(','function Be('),
        ('launcher_answer_policy','chunk-4h798pp0.js','var __e=Object.freeze({kind:"launcher"})',',Gjt='),
        ('prompt_mcp_request_parse','chunk-xt4nsgp1.js','function nR(','function ZY('),
        ('prompt_tool_resolve_dispatch','chunk-xt4nsgp1.js','function r2(',None),
        ('prompt_server_floor','chunk-xt4nsgp1.js','function Pk(','import{randomUUID'),
        ('unsupported_display_guard','chunk-jfnh5wnd.js','function pfe(','function Vzr('),
        ('headless_prompt_selection','chunk-xt4nsgp1.js','Wt=tKr({permissionPromptTool:E.permissionPromptToolName,sdkUrl:E.sdkUrl})',',Pt=UDe('),
        ('headless_prompt_binding_and_hiding','chunk-xt4nsgp1.js','let ac={swept:!1},$f=r2(Wt,','let Bn=USs('),
        ('plans_directory_setting_schema','chunk-m33vdkhs.js','plansDirectory:()=>',',tui:'),
    ]
    spans=[]
    for label,name,start,end in specs:
        data=(REPO/'artifacts/claude-bundle'/name).read_bytes();i=data.index(start.encode());j=data.index(end.encode(),i+len(start.encode())) if end else data.index(b'function ',i+len(start.encode()));raw=data[i:j]
        if not 0<len(raw)<8192:raise RuntimeError('Unbounded source span')
        spans.append({'id':label,'module':name,'offset':modules[name]['offset']+i,'length':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'text':raw.decode()})
    plan_spans=json.loads((REPO/'artifacts/plans-research/spans.json').read_text());all_spans=spans+plan_spans
    with Path('/Users/josh-desktop/.local/bin/claude').open('rb') as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned target mismatch')
        for name in {r['module'] for r in all_spans}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Full source module differs')
        for row in all_spans:
            target.seek(row['offset']);raw=target.read(row['length'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256'] or raw.decode()!=row['text']:raise RuntimeError('Installed source differs')
    return {'target_sha256':TARGET_SHA256,'all_equal':True,'bridge_spans':spans,'plan_spans':plan_spans,'original_executed':False,'recovered_code_executed':False,
            'scope':'Native file-backed Plan plus MCP permission-prompt-tool under print; no channels, Doc/remote/team mode, permission updates, or PTY.'}


def main():
    proof=verify();OUT.mkdir(parents=True,exist_ok=True);(OUT/'verification.json').write_text(json.dumps(proof,indent=2)+'\n')
    print(json.dumps({'all_equal':proof['all_equal'],'bridge_spans':len(proof['bridge_spans']),'plan_spans':len(proof['plan_spans']),'max_bytes':max(row['length'] for row in proof['bridge_spans']+proof['plan_spans']),'original_executed':False,'recovered_code_executed':False}))


if __name__=='__main__':main()
