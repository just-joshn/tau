#!/usr/bin/env python3
"""Targeted gated-background comparison against immutable saved original A."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re

from isolation import REPO, TARGET_SHA256
from compare_background_agents import summarize
from run_background_agents import checks, model_rows, inside

ORIGINAL_SHA = '16519ca1e3a7f567f229c7bee02d584b4c5ffb1a68125e0b91d44950b600ab50'


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def notice(record):
    parents = [r for r in model_rows(record) if r['scope'] == 'parent']; texts = []
    for row in parents[2]['body'].get('messages', []):
        if row.get('role') != 'user': continue
        for block in row.get('content', []):
            if isinstance(block,dict) and '<task-notification>' in block.get('text',''): texts.append(block['text'])
    text = texts[0] if len(texts) == 1 else ''
    def tag(name):
        match = re.search('<'+name+'>(.*?)</'+name+'>',text,re.S)
        return html.unescape(match.group(1)) if match else None
    def number(name):
        value = tag(name)
        return int(value) if value is not None and re.fullmatch(r'\d+',value) else None
    usage = tag('usage') or ''; output = tag('output-file'); root = Path(record['isolation']['root']); duration = number('duration_ms')
    selected = {'one_completion_notice':len(texts) == 1,'task_id_present':bool(tag('task-id')),'tool_use_id':tag('tool-use-id'),
                'status':tag('status'),'task_type_present':tag('task-type') is not None,'output_lexically_owned':output is not None and inside(root,Path(output)),
                'owned_result_visible':'OWNED_BACKGROUND_CHILD_FINAL' in (tag('result') or ''),'usage_field_order':re.findall(r'<([a-z_]+)>',usage),
                'subagent_tokens':number('subagent_tokens'),'tool_uses':number('tool_uses'),'duration_nonnegative':duration is not None and duration >= 0}
    return {'selected':selected,'duration_ms':duration,'summary':tag('summary'),'all_tag_names':re.findall(r'<([a-z_-]+)>',text),
            'notification_sha256':hashlib.sha256(text.encode()).hexdigest(),'notification_chars':len(text),'raw_text':text}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--original',type=Path,default=REPO/'artifacts/differential-pass/background-agents/original-gated-background.json');parser.add_argument('--tau',type=Path,default=REPO/'artifacts/differential-pass/background-agents-tau-progress/tau-gated-background.json');args=parser.parse_args()
    original=json.loads(args.original.read_text());tau=json.loads(args.tau.read_text());a=summarize(original);b=summarize(tau);x=notice(original);y=notice(tau)
    core={k:a['selected'][k] == b['selected'][k]for k in a['selected']};xml={k:x['selected'][k] == y['selected'][k]for k in x['selected']}
    records=[original,tau]
    audits={'immutable_original_capture':sha(args.original) == ORIGINAL_SHA,'two_fresh_verified_contexts':len({r['isolation']['root']for r in records}) == 2 and all(r['isolation']['passed'] and len(r['isolation']['checks']) == 20 for r in records),
            'removed_contexts':all(not Path(r['isolation']['root']).exists()for r in records),'headroom_guard':all(r['isolation']['disk_headroom_at_context_start'] >= 1073741824 for r in records),
            'pinned_original_clone':original['isolation']['target_copy']['sha256'] == TARGET_SHA256 and original['isolation']['target_copy']['distinct_inode'],
            'all_static_proofs_pass':all(r['source_preflight']['all_equal']for r in records),'exact_targeted_tau_request_cap':len(model_rows(tau)) == 6,
            'no_external_fixture_children':all(r['external_fixture_children_configured'] == 0 for r in records),'clean_process_groups':all(not r['stages'][0]['cleanup']['remaining_members'] and not r['stages'][0]['result']['remaining_process_group_killed']for r in records)}
    output={'original_raw_sha256':sha(args.original),'tau_raw_sha256':sha(args.tau),'original':a,'tau':b,'core_selected_equal':core,'original_notice':x,'tau_notice':y,'notice_selected_equal':xml,
            'audits':audits,'minimum_headroom':min(r['isolation']['disk_headroom_at_context_start']for r in records),
            'raw_difference_fields':[k for k in a if k not in ['selected','assertions','raw_assertions']and a[k] != b[k]],
            'scope':'Saved original A versus one new Tau1067 A6 only; no original or disabled-repeat execution. Internal native progress tuple is source-derived, not instrumented.'}
    path=args.tau.parent/'comparison.json';path.write_text(json.dumps(output,indent=2)+'\n')
    good=all(core.values())and all(xml.values())and all(audits.values())and all(checks(original).values())and all(checks(tau).values())
    print(json.dumps({'core_equal':all(core.values()),'core_fields':len(core),'notice_equal':all(xml.values()),'notice_fields':len(xml),'original_tokens':x['selected']['subagent_tokens'],'tau_tokens':y['selected']['subagent_tokens'],'audits':audits,'comparison_sha256':sha(path)}))
    if not good:raise SystemExit(3)


if __name__=='__main__':main()
