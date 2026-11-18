#!/usr/bin/env python3
"""Bounded owned definition-hook controls. CLI modes require separate root review/GO."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time

from isolation import REPO, Isolation, clone_file
from bun_runtime import bun_environment, copy_bun_executable
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_agent_definition_hooks import MODEL, ENV, PINNED_TARGET, recipes, verify, delegation_marker
from agent_definition_hooks_fixture import AgentDefinitionHookMock, MARKERS
from prepare_child_workflows import direct_user_texts
from run_child_workflows import prepare_bun_adapter
from run_hooks import alive
from run_plugins import results
from run_skills import run_stage, owned_group_members

CASES = ['dedup-once-foreground', 'nested-start-background-stop']
PHASE_CAP = 18
PROGRAM = r'''const fs=require('node:fs'),cp=require('node:child_process');const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));let generations={};
const probe=cp.spawnSync(cfg.node,[cfg.fixture,'hook',cfg.probeLog,'synthetic-probe'],{input:JSON.stringify({session_id:'owned-readiness-owner',transcript_path:cfg.probeLog+'.transcript',cwd:process.cwd(),agent_id:'owned-readiness-child',agent_type:'owned-agent',hook_event_name:'PreToolUse',tool_name:'Read',tool_use_id:'owned-probe',tool_input:{file_path:cfg.input}})+'\n',encoding:'utf8',timeout:3000,maxBuffer:65536});if(probe.status!==0||probe.stdout!=='{}')throw Error('Owned Node hook stdin probe failed');
async function ask(scope){const generation=generations[scope]=(generations[scope]||0)+1;let direct=scope==='parent'?'OWNED_PROTOCOL_PARENT':cfg.markers[scope];if(scope==='parent'&&generation===4)direct+='\n<task-notification>OWNED_DEF_HOOK_BACKGROUND_FINAL</task-notification>';const incidental=Object.values(cfg.markers).join('\n');const body={model:'claude-sonnet-4-6',stream:true,system:Object.values(cfg.systemMarkers).join('\n')+'\n'+incidental,messages:[{role:'user',content:[{type:'text',text:direct}]},{role:'assistant',content:[{type:'tool_use',id:'incidental-only',name:'Agent',input:{prompt:incidental}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'incidental-only',content:incidental}]}]};const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(6000)});const wire=await response.text();if(!response.ok||!wire.includes('msg_owned_def_hooks_'+cfg.case+'_'+scope+'_'+generation))throw Error('Owned mock protocol/identity failed');}
(async()=>{if(cfg.case==='dedup-once-foreground'){for(const scope of ['parent','reader','reader','reader','parent','parent'])await ask(scope);}else{for(const scope of ['parent','outer','inner','outer','parent'])await ask(scope);const background=ask('background');await ask('parent');await background;await ask('parent');}process.stdout.write('owned-agent-definition-hooks-protocol-ready');})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
'''


def models(record):
    return [row for row in record['requests'] if row['path'].split('?')[0] == '/v1/messages']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


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


def instantiate(value, root, node):
    if isinstance(value, str):
        return value.replace('__OWNED_ROOT__', str(root)).replace('__COPIED_PUBLIC_NODE__', str(node))
    if isinstance(value, list):
        return [instantiate(item, root, node) for item in value]
    if isinstance(value, dict):
        return {key: instantiate(item, root, node) for key, item in value.items()}
    return value


def file_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def directory_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode)


class OwnedCaptureMissing(FileNotFoundError):
    """The admitted parent has no leaf; never used for a post-open race."""


def bounded_owned_file(root, path, max_bytes=1048576):
    """Read through no-follow directory descriptors; return no raced contents."""
    if not 0 <= max_bytes <= 1048576:
        raise ValueError('Owned capture bound must be between zero and 1MiB')
    if not root.is_absolute() or root.resolve(strict=True) != root:
        raise ValueError('Owned root must be an absolute canonical directory')
    if not path.is_absolute() or '..' in path.parts or not path.is_relative_to(root):
        raise ValueError('File leaves owned lexical root')
    parts = path.relative_to(root).parts
    if not parts or len(parts) > 64:
        raise ValueError('Owned capture path depth is invalid')
    descriptors = []
    directories = []
    leaf_descriptor = None
    try:
        root_before = root.lstat()
        if not stat.S_ISDIR(root_before.st_mode):
            raise ValueError('Owned root must be a non-symlink directory')
        root_descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(root_descriptor)
        if directory_identity(root_before) != directory_identity(os.fstat(root_descriptor)):
            raise ValueError('Owned root changed before open')
        parent = root_descriptor
        for name in parts[:-1]:
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                raise ValueError('Owned path contains a symlink or non-directory')
            descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(descriptor)
            if directory_identity(before) != directory_identity(os.fstat(descriptor)):
                raise ValueError('Owned directory changed before open')
            directories.append((parent, name, descriptor, directory_identity(before)))
            parent = descriptor
        name = parts[-1]
        try:
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError as error:
            raise OwnedCaptureMissing('Owned capture leaf is absent') from error
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > max_bytes:
            raise ValueError('Expected at most 1MiB bounded single-linked regular file')
        # NONBLOCK prevents a raced replacement FIFO from blocking before fstat.
        leaf_descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        opened = os.fstat(leaf_descriptor)

        def recheck():
            if directory_identity(os.fstat(root_descriptor)) != directory_identity(root_before) or directory_identity(root.lstat()) != directory_identity(root_before) or root.resolve(strict=True) != root:
                raise ValueError('Owned root identity changed')
            for ancestor, component, descriptor, expected in directories:
                if directory_identity(os.fstat(descriptor)) != expected or directory_identity(os.stat(component, dir_fd=ancestor, follow_symlinks=False)) != expected:
                    raise ValueError('Owned directory identity changed')
            if file_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != file_identity(before) or path.resolve(strict=True) != path:
                raise ValueError('Owned leaf identity or canonical path changed')

        if file_identity(opened) != file_identity(before):
            raise ValueError('Owned file changed before read')
        recheck()
        chunks = []; count = 0
        while count <= max_bytes:
            chunk = os.read(leaf_descriptor, min(65536, max_bytes + 1 - count))
            if not chunk:
                break
            chunks.append(chunk); count += len(chunk)
        after = os.fstat(leaf_descriptor)
        if count > max_bytes or count != before.st_size or file_identity(after) != file_identity(before):
            raise ValueError('Owned file changed during bounded read')
        recheck()
        raw = b''.join(chunks)
        return raw, {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': count,
                     'device': before.st_dev, 'inode': before.st_ino, 'mtime_ns': before.st_mtime_ns,
                     'ctime_ns': before.st_ctime_ns, 'regular_single_link': True, 'canonical_owned': True,
                     'ownership_rechecked': True, 'bounded_read_limit': max_bytes,
                     'guard_profile': 'No-follow directory walk; full file pre/open/post dev/ino/mode/nlink/size/mtime/ctime; canonical ownership before and after read'}
    except OwnedCaptureMissing:
        raise
    except FileNotFoundError as error:
        raise ValueError('Owned capture path disappeared or changed during admission/read') from error
    finally:
        if leaf_descriptor is not None:
            os.close(leaf_descriptor)
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def owned_snapshot(root, path, max_bytes=1048576):
    value = {'path': str(path), 'exists': False}
    try:
        raw, receipt = bounded_owned_file(root, path, max_bytes)
        value.update(receipt, exists=True, is_symlink=False, raw_text=raw.decode('utf8', errors='replace'))
    except OwnedCaptureMissing:
        pass
    except (OSError, ValueError) as error:
        value['guard_error'] = type(error).__name__ + ': ' + str(error)
    return value


def hook_log(root, path):
    value = owned_snapshot(root, path)
    rows = []
    if value.get('exists') and not value.get('guard_error'):
        if value.get('bytes', 0) > 1048576:
            value['guard_error'] = 'Hook fixture log exceeds 1MiB'
        elif 'raw_text' not in value:
            value['guard_error'] = 'Hook fixture log text unavailable'
        else:
            try:
                rows = [json.loads(line) for line in value['raw_text'].splitlines()]
            except ValueError:
                value['guard_error'] = 'Invalid hook fixture JSONL'
    return {'file': value, 'rows': rows}


def owned_records(root, directory, suffixes):
    """Bounded records; count/aggregate admission precedes each content read."""
    files = {}; guards = []; total = 0; entries = 0; visited = 0
    if not directory.exists() and not directory.is_symlink():
        return {'files': files, 'guards': guards, 'bytes': total}
    if directory.is_symlink() or directory.resolve() != directory or not directory.resolve().is_relative_to(root):
        return {'files': files, 'guards': ['Foreign/symlink native record root'], 'bytes': total}
    for base, dirs, names in os.walk(directory, followlinks=False):
        entries += len(dirs) + len(names); visited += 1
        if entries > 128 or visited > 32:
            guards.append('Native record enumeration bound'); break
        for name in list(dirs):
            if (Path(base) / name).is_symlink():
                guards.append('Native record symlink directory'); dirs.remove(name)
        for name in sorted(names):
            if not name.endswith(suffixes):
                continue
            path = Path(base) / name
            if len(files) >= 16:
                guards.append('Native record file count bound'); break
            value = owned_snapshot(root, path, min(1048576, 2097152 - total))
            files[str(path.relative_to(root))] = value
            total += value.get('bytes', 0)
            if value.get('guard_error'):
                guards.append(value['guard_error'])
        if guards:
            break
    return {'files': files, 'guards': guards, 'bytes': total}


def native_records(root):
    return owned_records(root, root / 'config/projects', ('.json', '.jsonl'))


def archive_snapshot(root):
    value = owned_records(root, root / 'tau-state/sessions', ('.json',))
    for item in value['files'].values():
        if item.get('guard_error') or not item.get('exists'):
            continue
        try:
            item['json'] = json.loads(item['raw_text'])
        except ValueError:
            value['guards'].append('Invalid owned archive JSON')
    return value


def lifecycle_counts(log):
    return {kind: sum(row.get('event') == 'input' and row.get('kind') == kind for row in log['rows'])
            for kind in ['common-read', 'foreground-stop', 'global-start', 'common-stop', 'definition-start-MUST-NOT-RUN']}


def json_outputs(text):
    decoder = json.JSONDecoder()
    values = []
    remaining = text.lstrip()
    while remaining:
        try:
            value, end = decoder.raw_decode(remaining)
        except ValueError:
            return values, False
        values.append(value)
        remaining = remaining[end:].lstrip()
    return values, bool(values)


def checks(record):
    plan = record['recipe']; rows = models(record); ready = record['mode'] in ['readiness', 'bun-readiness']
    result = record['result']; log = record['hook_log']; counts = lifecycle_counts(log)
    generations = {key: value for key, value in record['scope_generations'].items() if value}
    expected = plan['scopes']
    parent = [row for row in rows if row['scope'] == 'parent']
    out = {'exit_success': result['exit_code'] == 0 and not result['timed_out'] and not result['output_limited'],
           'no_mock_halt': record['mock_halt'] is None, 'expected_requests': len(rows) == plan['expected_messages'],
           'expected_scopes': generations == expected, 'all_known_models': all(row['body'].get('model') == MODEL for row in rows),
           'direct_user_classifier': all(not row['direct_user_markers'] for row in parent),
           'input_unchanged': record['input_before'].get('sha256') == record['input_after'].get('sha256'),
           'definitions_unchanged': record['definitions_before'] == record['definitions_after'],
           'fresh_twenty_canaries': record['isolation']['passed'] and len(record['isolation']['checks']) == 20,
           'no_group_survivors': not record['cleanup']['remaining_members'],
           'natural_group_exit': not result['remaining_process_group_killed'],
           'all_file_guards': not any(item.get('guard_error') for item in [record['input_before'],record['input_after'],log['file'],record['probe_log']['file']]),
           'no_hook_survivors': not record['hook_survivors'], 'no_budget_kill': not record['budget_kills'],
           'archive_guards': not record['archives']['guards'] and not record['native_records']['guards']}
    if ready:
        out.update(protocol_marker=result['stdout'] == 'owned-agent-definition-hooks-protocol-ready',
                   synthetic_hook_probe=record['probe_log']['file'].get('exists') and len(record['probe_log']['rows']) == 2,
                   no_real_hooks=not log['rows'], no_cli_entrypoint=not record['original_executed'] and not record['port_entrypoint_executed'])
    else:
        outputs, parsed = json_outputs(result['stdout']); record['json_outputs'] = outputs
        out['json_output_parsed'] = parsed
        expected_final = 'OWNED_DEF_HOOK_FOREGROUND_PARENT_FINAL' if record['case'] == CASES[0] else 'OWNED_DEF_HOOK_PARENT_NOTIFIED'
        out['final_marker'] = bool(outputs) and outputs[-1].get('result') == expected_final
        session = outputs[-1].get('session_id') if outputs else None
        inputs = [row for row in log['rows'] if row.get('event') == 'input']
        out['hook_sessions_match'] = bool(inputs) and all(row['input'].get('session_id') == session for row in inputs)
        out['all_hook_exits_zero'] = len(record['hook_pids']) == len([row for row in log['rows'] if row.get('event') == 'exit' and row.get('code') == 0])
        out['no_fixture_error'] = all(row.get('event') != 'fixture-error' for row in log['rows'])
        stops = [row['input'] for row in inputs if row['input'].get('hook_event_name') == 'SubagentStop']
        out['stop_transcript_ownership'] = bool(stops) and all(item.get('agent_transcript_path') and item.get('agent_transcript_path') != item.get('transcript_path') for item in stops)
        tool_results = {}
        for row in rows:
            tool_results.update(results(row['body']))
        out['tool_successes'] = bool(tool_results) and all(not item.get('is_error',False) for item in tool_results.values())
        if record['case'] == CASES[0]:
            common = [row['input'] for row in inputs if row.get('kind') == 'common-read']
            out.update(expected_hook_counts=counts == {'common-read':3,'foreground-stop':1,'global-start':0,'common-stop':0,'definition-start-MUST-NOT-RUN':0},
                       common_read_actor_split=sum(bool(item.get('agent_id')) for item in common) == 2,
                       foreground_stop_once=len(stops) == 1)
        else:
            out.update(expected_hook_counts=counts == {'common-read':0,'foreground-stop':0,'global-start':3,'common-stop':3,'definition-start-MUST-NOT-RUN':0},
                       three_child_stops=len(stops) == 3 and len({item.get('agent_id') for item in stops}) == 3)
    if record['case'] == CASES[1]:
        events = record['gate_events']
        out['gate_passed'] = not record['gate_failed'] and events == ['parent-generation3-response-flushed','background-response-after-parent-flush']
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['original','tau','readiness','bun-readiness'])
    parser.add_argument('case', choices=CASES)
    parser.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/agent-definition-hooks')
    parser.add_argument('--execute-reviewed-cli', action='store_true', help='Only pass after the root has separately reviewed and authorized this exact CLI phase')
    args = parser.parse_args()
    if args.mode in ['original','tau'] and not args.execute_reviewed_cli:
        parser.error('Original/Tau entrypoint execution requires separate root review/GO; readiness remains available')
    directory = args.artifacts.resolve(); directory.mkdir(parents=True, exist_ok=True); stem = args.mode + '-' + args.case
    if any(directory.glob(stem + '.*')):
        raise RuntimeError('Refusing capture/bootstrap/failure overwrite')
    source = verify(); ready = args.mode in ['readiness','bun-readiness']; state = AgentDefinitionHookMock(args.case, '__NOT_MATERIALIZED__'); record = None
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
        definition_records_after = {relative:owned_snapshot(isolation.root,isolation.root/relative) for relative in plan['definitions']}
        if any(value.get('guard_error') for value in definition_records_after.values()): raise RuntimeError('Owned definition post-snapshot guard failed')
        record = {'case':args.case,'mode':args.mode,'recipe':plan,'source_preflight':source,'isolation':isolation.report,'environment_overrides':ENV,
            'node_runtime':node_runtime,'fixture_probe':fixture_probe,'fixture_sha256':sha(fixture),'fixture_mock_sha256':sha(REPO/'scripts/differential/agent_definition_hooks_fixture.py'),
            'runner_sha256':sha(Path(__file__)),
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
        (directory/(stem+'.failure.json')).write_text(json.dumps({'error':{'type':type(error).__name__,'message':str(error)},'isolation':isolation.report,'requests':state.requests,'mock_halt':state.halt,'mock_failures':state.failures,'snapshot_drift':getattr(error,'evidence',None),'partial_record':record},indent=2)+'\n'); raise
      finally:
        state.release_background.set()
        isolation.close()
    if not all(record['checks'].values()): raise SystemExit(3)


if __name__ == '__main__':
    main()
