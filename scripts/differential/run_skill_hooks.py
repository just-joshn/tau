#!/usr/bin/env python3
"""Finite owned Skill-declared hook cases under unchanged verified isolation."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

from isolation import REPO, TARGET_SHA256, clone_file, verified_isolation
from mock_api import MODEL
from run_tau import copy_runtime, digest
import run_skills
from run_hooks import alive

CASES = ['post-once', 'pre-once']


def actions(case, stage):
    result = [('Skill', {'skill': 'owned-once', 'args': 'owned argument'})]
    for index in range(1, 3 if case == 'post-once' else 4):
        result.append(('Write', {'file_path': f'write-{index}.txt', 'content': f'OWNED_SESSION_HOOK_WRITE_{index}\n'}))
    return result


def verify_source():
    """Byte verification only; no recovered JS is imported or executed."""
    manifest = json.loads((REPO / 'artifacts/bundle-manifest.json').read_text())
    name = 'chunk-m33vdkhs.js'; module = next(m for m in manifest['modules'] if m['name'] == name)
    data = (REPO / 'artifacts/claude-bundle' / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != module['sha256']: raise RuntimeError('Source module hash mismatch')
    specs = [('command_schema', b'function wg(){', b',n=u({type:T("prompt")'),
             ('matcher_and_event_schema', b'xn=m(()=>u({matcher:', b'function s9a('),
             ('entry_guard', b'function kg(', b'function Xo('),
             ('nested_guard', b'function NNe(', b'function Sre('),
             ('full_frontmatter_guard', b'function Tn(', b'function awi(')]
    spans = []
    with Path('/Users/josh-desktop/.local/bin/claude').open('rb') as target:
        if hashlib.file_digest(target, 'sha256').hexdigest() != TARGET_SHA256: raise RuntimeError('Pinned executable mismatch')
        for label, start, end in specs:
            i = data.index(start); j = data.index(end, i + len(start)); span = data[i:j]
            target.seek(module['offset'] + i)
            if target.read(len(span)) != span: raise RuntimeError('Installed source span differs')
            spans.append({'id': label, 'module': name, 'offset': module['offset'] + i, 'length': len(span), 'sha256': hashlib.sha256(span).hexdigest(), 'equal': True, 'text': span.decode()})
    return {'target_sha256': TARGET_SHA256, 'original_executed': False, 'recovered_code_executed': False, 'spans': spans,
            'fixture_review': 'hooks is an event-to-matcher-array mapping; literal Write matcher; command string, args string array, positive timeout, boolean once; Pre only under hooks; no guard metadata or unsupported fields'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', choices=['original','tau']); parser.add_argument('case', choices=CASES)
    parser.add_argument('--artifacts', type=Path, default=REPO / 'artifacts/differential-pass/skill-hooks')
    args = parser.parse_args(); artifacts = args.artifacts.resolve()
    if (artifacts / (args.executable + '-' + args.case + '.json')).exists(): raise RuntimeError('Refusing to overwrite capture')
    source = verify_source(); run_skills.actions = actions; state = run_skills.SkillMock(args.case)
    with verified_isolation(artifacts, state.handler()) as isolation:
        node, entry, runtime = copy_runtime(isolation.root)
        fixture = isolation.root / 'skill-hook-fixture.cjs'; clone_file(REPO / 'scripts/differential/skill_hook_fixture.cjs', fixture)
        probe = isolation.sandbox([str(node),str(fixture),'ready',str(isolation.root/'ready.jsonl'),args.case])
        if probe['exit_code'] != 0 or probe['timed_out'] or probe['stdout'] != 'owned-skill-hook-ready': raise RuntimeError('Fixture bootstrap failed unchanged sandbox')
        lifecycle = isolation.root / 'skill-hook-lifecycle.jsonl'
        event = 'PostToolUse' if args.case == 'post-once' else 'PreToolUse'
        hook = {'type':'command','command':str(node),'args':[str(fixture),'hook',str(lifecycle),args.case],'timeout':3,'once':True}
        frontmatter = {'description':'Owned session hook fixture','allowed-tools':'Write','hooks':{event:[{'matcher':'Write','hooks':[hook]}]}}
        skill = isolation.root / 'work/.claude/skills/owned-once/SKILL.md'; skill.parent.mkdir(parents=True)
        skill_text = '---\n' + json.dumps(frontmatter,indent=2) + '\n---\nOWNED_SESSION_HOOK_BODY\nOWNED_SESSION_HOOK_ARGS $ARGUMENTS\n'
        skill.write_text(skill_text)
        arguments = ['--print','OWNED_SESSION_HOOK_'+args.case.upper(),'--model',MODEL,'--output-format','json','--tools','Skill,Write','--allowedTools','Skill']
        skipped = []
        if args.executable == 'original':
            command = [str(isolation.copy_target(Path('/Users/josh-desktop/.local/bin/claude')))]; arguments.append('--no-session-persistence')
        else:
            command = [str(node),'--preserve-symlinks','--preserve-symlinks-main',str(entry)]; skipped.append('--no-session-persistence')
        isolation.report['original_executed'] = args.executable == 'original'
        result, cleanup = run_skills.run_stage(isolation,command,arguments)
        logs = [json.loads(line) for line in lifecycle.read_text().splitlines()] if lifecycle.exists() else []
        pids = sorted({row['pid'] for row in logs if row.get('event') == 'start'})
        deadline = time.monotonic() + 2
        while any(alive(pid) for pid in pids) and time.monotonic() < deadline: time.sleep(.05)
        survivors = [pid for pid in pids if alive(pid)]
        record = {'case':args.case,'executable':args.executable,'target_sha256':TARGET_SHA256 if args.executable == 'original' else None,
                  'isolation':isolation.report,'runtime':runtime,'runtime_probe':probe,'source_schema_guard_validation':source,
                  'fixture_sha256':digest(fixture),'fixture_skill':skill_text,'response_identity':'unique msg_owned_skill_CASE_SERIAL per generation',
                  'stages':[{'arguments':arguments,'result':result,'cleanup':cleanup,'request_start':0,'request_end':len(state.requests)}],
                  'requests':state.requests,'hook_lifecycle':logs,'hook_pids':pids,'surviving_hook_pids':survivors,
                  'final_files':{f'write-{i}.txt':(isolation.root/f'work/write-{i}.txt').read_text() for i in range(1,4) if (isolation.root/f'work/write-{i}.txt').exists()},
                  'skipped_original_flags':skipped}
        stem = args.executable+'-'+args.case
        (artifacts/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for stream in ['stdout','stderr']: (artifacts/(stem+'.'+stream+'.txt')).write_text(result[stream])
        kernel = subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10)
        (artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case':args.case,'executable':args.executable,'exit':result['exit_code'],'requests':len(state.requests),
                          'hook_inputs':[(row['invocation'],row['input'].get('hook_event_name'),row['input'].get('tool_use_id')) for row in logs if row.get('event')=='input'],
                          'surviving_hook_pids':survivors,'remaining_group_members':cleanup['remaining_members'],'final_files':record['final_files']}))


if __name__ == '__main__': main()
