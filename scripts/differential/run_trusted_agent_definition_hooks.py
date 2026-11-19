#!/usr/bin/env python3
"""New trusted-project A2/B2 controls; application modes require a separate root GO."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import subprocess
import time

from isolation import REPO, Isolation, clone_file
from bun_runtime import bun_environment, copy_bun_executable
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_trusted_agent_definition_hooks import MODEL, ENV, PINNED_TARGET, CASES, SCENARIOS, recipes, verify, delegation_marker
from trusted_agent_definition_hooks_fixture import TrustedAgentDefinitionHookMock, MARKERS
from run_child_workflows import prepare_bun_adapter
from run_hooks import alive
from run_skills import run_stage, owned_group_members
import run_agent_definition_hooks as base
from run_agent_definition_hooks import models, sha, instantiate, owned_snapshot, hook_log, lifecycle_counts, native_records, archive_snapshot, json_outputs

PHASE_CAP = 18
PROGRAM = base.PROGRAM.replace("cfg.case==='dedup-once-foreground'", "cfg.case==='trusted-project-dedup-once-foreground'")


def trust_conditions(snapshot, fixture):
    parsed = None
    error = None
    try:
        parsed = json.loads(snapshot.get('raw_text', ''))
    except (TypeError, ValueError) as problem:
        error = type(problem).__name__
    projects = parsed.get('projects') if isinstance(parsed, dict) else None
    project = projects.get(fixture['project_key']) if isinstance(projects, dict) else None
    checks = {'owned_guard_passed': not snapshot.get('guard_error') and snapshot.get('canonical_owned') is True and snapshot.get('regular_single_link') is True,
              'exact_path': snapshot.get('path') == fixture['path'], 'strict_trust_record': isinstance(project, dict) and project.get('hasTrustDialogAccepted') is True}
    return {'accepted': all(checks.values()), 'checks': checks, 'parse_error': error}


def checks(record):
    compatible = {**record, 'case': SCENARIOS[record['case']]}
    result = base.checks(compatible)
    if 'json_outputs' in compatible:
        record['json_outputs'] = compatible['json_outputs']
    before = trust_conditions(record['trust_before'], record['recipe']['trust_fixture'])
    after = trust_conditions(record['trust_after'], record['recipe']['trust_fixture'])
    record['trust_adjudication'] = {'before': before, 'after': after,
        'raw_change_policy': 'Preserve both full guarded snapshots. Across-run bootstrap hash/inode changes are observations, not automatically failures.'}
    result.update(trust_before_accepted=before['accepted'], trust_after_accepted=after['accepted'])
    return result


@contextmanager
def phase_guard(directory, mode, case):
    lock = directory / ('.' + mode + '-phase.lock')
    with lock.open('x') as stream:
        stream.write(str(os.getpid()))
    try:
        previous = []
        for other in CASES:
            stem = mode + '-' + other
            if (directory / (stem + '.failure.json')).exists():
                raise RuntimeError('Prior failed definition-hook phase requires review; no retry')
            path = directory / (stem + '.json')
            if path.exists():
                value = json.loads(path.read_text())
                if not all(value['checks'].values()):
                    raise RuntimeError('Prior definition-hook control failed; phase stopped')
                previous.append(value)
        used = sum(len(models(record)) for record in previous)
        expected = recipes()[case]['expected_messages']
        if len(previous) >= 2 or used + expected > PHASE_CAP:
            raise RuntimeError('Definition-hook phase budget exhausted')
        yield PHASE_CAP - used
    finally:
        lock.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['original','tau','readiness','bun-readiness'])
    parser.add_argument('case', choices=CASES)
    parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/trusted-agent-definition-hooks')
    parser.add_argument('--execute-reviewed-cli', action='store_true', help='Only pass after the root has separately reviewed and authorized this exact CLI phase')
    args = parser.parse_args()
    if args.mode in ['original','tau'] and not args.execute_reviewed_cli:
        parser.error('Original/Tau entrypoint execution requires separate root review/GO; readiness remains available')
    directory = args.artifacts.resolve(); directory.mkdir(parents=True, exist_ok=True); stem = args.mode + '-' + args.case
    if any(directory.glob(stem + '.*')):
        raise RuntimeError('Refusing capture/bootstrap/failure overwrite')
    source = verify(); ready = args.mode in ['readiness','bun-readiness']; state = TrustedAgentDefinitionHookMock(args.case, '__NOT_MATERIALIZED__'); record = None; trust_before = None; trust_after = None
    with phase_guard(directory,args.mode,args.case) as remaining:
      isolation = Isolation(directory/(stem+'.isolation'),state.handler())
      try:
        isolation.env.update(ENV)
        if args.mode in ['tau','bun-readiness']: isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        node, node_runtime = copy_node_fixture_runtime(isolation.root)
        fixture = isolation.root/'agent-definition-hooks-fixture.cjs'; clone_file(REPO/'scripts/differential/agent_definition_hooks_fixture.cjs',fixture)
        fixture_probe = isolation.sandbox([str(node),str(fixture),'ready'])
        if fixture_probe['exit_code'] != 0 or fixture_probe['stdout'] != 'owned-agent-definition-hooks-ready' or fixture_probe['timed_out'] or fixture_probe['output_limited']:
            raise RuntimeError('Copied Node fixture bootstrap failed under unchanged profile')
        plan = instantiate(recipes()[args.case],isolation.root,node); state.file_path = plan['input_file']['path']; state.message_cap = min(plan['hard_message_cap'],remaining)
        for relative, text in plan['definitions'].items():
            path = isolation.root/relative; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(text)
        input_path = Path(state.file_path); input_path.write_text(plan['input_file']['text'])
        (isolation.root/'config/settings.json').write_text(json.dumps(plan['settings'])+'\n')
        trust_path = Path(plan['trust_fixture']['path']); trust_path.write_text(plan['trust_fixture']['text'])
        trust_before = owned_snapshot(isolation.root,trust_path)
        if not trust_conditions(trust_before,plan['trust_fixture'])['accepted']:
            raise RuntimeError('Exact owned project trust fixture was not admitted before launch')
        log_path = Path(plan['hook_log']); probe_log = isolation.root/'synthetic-hook-probe.jsonl'
        state.lifecycle_snapshot = lambda: lifecycle_counts(hook_log(isolation.root,log_path))
        budget_kills = []
        def halt_group():
            pid_path = isolation.root/'owned-cli.pid'
            try:
                if pid_path.is_symlink() or pid_path.stat().st_size > 32: raise RuntimeError('Owned PID receipt invalid')
                group = int(pid_path.read_text().strip())
                if group <= 1 or group == os.getpgrp() or os.getpgid(group) != group: raise RuntimeError('Owned process group mismatch')
                leader = subprocess.run(['/bin/ps','-p',str(group),'-o','command='],capture_output=True,text=True,timeout=3)
                if str(isolation.root) not in leader.stdout: raise RuntimeError('Process group leader no longer belongs to owned root')
                budget_kills.append({'group':group,'members':owned_group_members(group),'reason':state.halt})
                os.killpg(group,signal.SIGKILL)
            except Exception as error:
                budget_kills.append({'refused_or_gone':type(error).__name__,'reason':state.halt})
        state.on_halt = halt_group
        before = owned_snapshot(isolation.root,input_path); definition_records_before = {relative:owned_snapshot(isolation.root,isolation.root/relative) for relative in plan['definitions']}
        if any(value.get('guard_error') for value in definition_records_before.values()): raise RuntimeError('Owned definition pre-snapshot guard failed')
        definitions_before = {relative:value['sha256'] for relative,value in definition_records_before.items()}
        runtime = None; runtime_probes = None; bun = None
        if args.mode == 'tau':
            bun, entry, runtime, runtime_probes = prepare_bun_adapter(isolation,directory,stem); command = [str(bun),'--no-install',str(entry)]
        elif args.mode == 'bun-readiness':
            bun, runtime = copy_bun_executable(isolation.root)
            runtime_probes = {'version':isolation.sandbox([str(bun),'--version']), 'help':isolation.sandbox([str(bun),'--help'])}
            if runtime_probes['version']['exit_code'] != 0 or runtime_probes['version']['stdout'].strip() != '1.4.4' or runtime_probes['help']['exit_code'] != 0 or '--no-install' not in runtime_probes['help']['stdout']:
                raise RuntimeError('Copied public Bun/no-install bootstrap failed')
        arguments = ['--print','OWNED_DEF_HOOK_PARENT_REQUEST_'+args.case.upper(),'--model',MODEL,'--permission-mode','default','--output-format','json','--tools','Agent,Read']
        if args.mode == 'original': command = [str(isolation.copy_target(PINNED_TARGET))]; arguments.append('--no-session-persistence')
        if ready:
            authored = isolation.root/'owned-definition-hook-protocol.cjs'; authored.write_text(PROGRAM)
            config = isolation.root/'owned-protocol.json'; config.write_text(json.dumps({'case':args.case,'node':str(node),'fixture':str(fixture),'probeLog':str(probe_log),'input':str(input_path),
                'markers':{scope:delegation_marker(args.case,scope) for scope in MARKERS},'systemMarkers':MARKERS})+'\n')
            command = [str(bun),'--no-install',str(authored),str(config)] if bun else [str(node),str(authored),str(config)]; arguments = []
        isolation.report['original_executed'] = args.mode == 'original'; isolation.report['port_entrypoint_executed'] = args.mode == 'tau'
        result, cleanup = run_stage(isolation,command,arguments)
        log = hook_log(isolation.root,log_path); pids = sorted({row['pid'] for row in log['rows'] if row.get('event') == 'input' and isinstance(row.get('pid'),int)})
        deadline = time.monotonic()+2
        while any(alive(pid) for pid in pids) and time.monotonic()<deadline: time.sleep(.05)
        trust_after = owned_snapshot(isolation.root,trust_path)
        definition_records_after = {relative:owned_snapshot(isolation.root,isolation.root/relative) for relative in plan['definitions']}
        if any(value.get('guard_error') for value in definition_records_after.values()): raise RuntimeError('Owned definition post-snapshot guard failed')
        record = {'case':args.case,'mode':args.mode,'recipe':plan,'source_preflight':source,'isolation':isolation.report,'environment_overrides':ENV,
            'node_runtime':node_runtime,'fixture_probe':fixture_probe,'fixture_sha256':sha(fixture),'fixture_mock_sha256':sha(REPO/'scripts/differential/trusted_agent_definition_hooks_fixture.py'),
            'runner_sha256':sha(Path(__file__)),
            'trust_before':trust_before,'trust_after':trust_after,'trust_raw_changed':trust_before.get('sha256')!=trust_after.get('sha256'),'trust_inode_changed':trust_before.get('inode')!=trust_after.get('inode'),
            'harness_hashes':{name:sha(REPO/'scripts/differential'/name) for name in ['run_trusted_agent_definition_hooks.py','prepare_trusted_agent_definition_hooks.py','trusted_agent_definition_hooks_fixture.py','run_agent_definition_hooks.py','agent_definition_hooks_fixture.cjs']},
            'runtime':runtime,'runtime_probes':runtime_probes,'command':command,'arguments':arguments,'requests':state.requests,'responses':state.responses,
            'scope_generations':state.generations,'mock_halt':state.halt,'mock_failures':state.failures,'gate_failed':state.gate_failed,'gate_events':list(state.gate_events),'budget_kills':budget_kills,
            'input_before':before,'input_after':owned_snapshot(isolation.root,input_path),'definitions_before':definitions_before,'definitions_after':{relative:value['sha256'] for relative,value in definition_records_after.items()},
            'definition_records_before':definition_records_before,'definition_records_after':definition_records_after,
            'hook_log':log,'probe_log':hook_log(isolation.root,probe_log),'hook_pids':pids,'hook_survivors':[pid for pid in pids if alive(pid)],'result':result,'cleanup':cleanup,
            'archives':archive_snapshot(isolation.root),'native_records':native_records(isolation.root),'classifier':'Unique DIRECT USER delegation markers only; system/catalog/assistant tool inputs/user tool_result strings are incidental',
            'original_executed':args.mode == 'original','port_entrypoint_executed':args.mode == 'tau'}
        record['checks'] = checks(record)
        (directory/(stem+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        for name in ['stdout','stderr']: (directory/(stem+'.'+name+'.txt')).write_text(result[name])
        denials = subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10)
        (directory/(stem+'.denials.txt')).write_text(denials.stdout)
        print(json.dumps({'mode':args.mode,'case':args.case,'messages':len(models(record)),'scopes':state.generations,'checks':record['checks'],'original_executed':record['original_executed'],'port_entrypoint_executed':record['port_entrypoint_executed']}))
      except Exception as error:
        (directory/(stem+'.failure.json')).write_text(json.dumps({'error':{'type':type(error).__name__,'message':str(error)},'isolation':isolation.report,'requests':state.requests,'mock_halt':state.halt,'mock_failures':state.failures,'snapshot_drift':getattr(error,'evidence',None),'partial_record':record,'trust_before':trust_before,'trust_after':trust_after},indent=2)+'\n'); raise
      finally:
        state.release_background.set()
        isolation.close()
    if not all(record['checks'].values()): raise SystemExit(3)


if __name__ == '__main__':
    main()
