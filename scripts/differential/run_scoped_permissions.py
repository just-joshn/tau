#!/usr/bin/env python3
"""Scoped permission controls. Original/Tau app modes require separate Root GO."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import stat
import subprocess
import signal

from bun_runtime import bun_environment, copy_bun_executable
from isolation import REPO, Isolation
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_scoped_permissions import CASES, MODEL, FINAL, SELECTED, BLOCKED, ScopedPermissionMock, digest, locations, recipe, snapshot, verify_source
from prepare_plugins import PINNED_TARGET
from run_child_workflows import prepare_bun_adapter
from run_agent_definition_hooks import archive_snapshot, native_records, directory_identity, bounded_owned_file
from run_skills import run_stage, owned_group_members

PHASE_CAP = 13
PROGRAM = r'''const fs=require("node:fs");
const plan=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
let messages=[{role:"user",content:"OWNED_SCOPED_PROTOCOL_ONLY"}];
(async()=>{for(let generation=1;generation<=plan.expected_messages;generation++){
const body={model:"claude-sonnet-4-6",stream:false,system:"OWNED_PROTOCOL_ONLY",tools:plan.tool_names.map(name=>({name,input_schema:{type:"object",properties:{}}})),messages};
const response=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
if(!response.ok)throw Error("Owned scoped protocol rejected");
const answer=await response.json();messages.push({role:"assistant",content:answer.content});
const tool=answer.content.find(block=>block.type==="tool_use");if(!tool){if(generation!==plan.expected_messages||answer.content[0].text!=="OWNED_SCOPED_PERMISSION_FINAL")throw Error("Unexpected owned protocol end");break;}
let is_error=false,text="";
if(plan.case==="files"){
if(generation===1){if(tool.input.file_path!==plan.paths["selected.md"])throw Error("Unexpected owned write path");fs.writeFileSync(tool.input.file_path,tool.input.content);text="OWNED_SCOPED_WRITE_READY";}
else if(generation===5){text=fs.readFileSync(plan.paths["selected.md"],"utf8");}
else{is_error=true;text="OWNED_SCOPED_HELD";}}
else if(generation===1)text="OWNED_SCOPED_OK";
else if(generation===4)text="OWNED_SCOPED_DENYPLUS";
else{is_error=true;text="OWNED_SCOPED_HELD";}
messages.push({role:"user",content:[{type:"tool_result",tool_use_id:tool.id,is_error,content:text}]});
}process.stdout.write("owned-scoped-permission-protocol-ready");})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
'''


def models(record):
    return [row for row in record['requests'] if row['path'].split('?')[0] == '/v1/messages']


def state_audit(root):
    entries = []
    guards = []
    def visit(parent, name, relative, depth):
        if len(entries) >= 512 or depth > 10:
            guards.append('Owned state metadata audit bound exceeded')
            return
        value = os.stat(name, dir_fd=parent, follow_symlinks=False)
        item = {'path': relative, 'bytes': value.st_size,
                'device': value.st_dev, 'inode': value.st_ino, 'mtime_ns': value.st_mtime_ns}
        if stat.S_ISLNK(value.st_mode):
            item['kind'] = 'symlink'
            item['link_text'] = os.readlink(name, dir_fd=parent)
            # Do not follow a foreign target during an audit. No content is read.
            destination = Path(os.path.normpath(str((root/relative).parent/item['link_text'])))
            item['lexical_target_owned'] = destination.is_relative_to(root)
            if not item['lexical_target_owned']:
                guards.append('Foreign owned-state symlink: '+item['path'])
        elif stat.S_ISDIR(value.st_mode):
            item['kind'] = 'directory'
        elif stat.S_ISREG(value.st_mode):
            item['kind'] = 'regular'
            item['links'] = value.st_nlink
            if value.st_nlink != 1 or value.st_size > 8*1024*1024:
                guards.append('Non-single-link or oversized owned state leaf: '+item['path'])
        else:
            item['kind'] = 'other'
            guards.append('Unexpected owned state object: '+item['path'])
        entries.append(item)
        if item['kind'] == 'directory':
            descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                expected = directory_identity(value)
                if directory_identity(os.fstat(descriptor)) != expected:
                    raise ValueError('Owned metadata directory changed before open')
                with os.scandir(descriptor) as stream:
                    names = []
                    for child in stream:
                        if len(names) + len(entries) >= 512:
                            guards.append('Owned state metadata audit bound exceeded')
                            break
                        names.append(child.name)
                for child in sorted(names):
                    visit(descriptor, child, relative+'/'+child, depth+1)
                if (directory_identity(os.fstat(descriptor)) != expected or
                    directory_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != expected):
                    raise ValueError('Owned metadata directory changed during audit')
            finally:
                os.close(descriptor)
    try:
        if not root.is_absolute() or root.resolve(strict=True) != root:
            raise ValueError('Owned metadata root must be canonical')
        before = root.lstat()
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if directory_identity(before) != directory_identity(os.fstat(descriptor)):
                raise ValueError('Owned metadata root changed before open')
            for name in ['work', 'home', 'config', 'tmp', 'cache', 'data', 'xdg-config', 'tau-state']:
                visit(descriptor, name, name, 0)
            if (directory_identity(root.lstat()) != directory_identity(before) or
                directory_identity(os.fstat(descriptor)) != directory_identity(before) or root.resolve(strict=True) != root):
                raise ValueError('Owned metadata root changed during audit')
        finally:
            os.close(descriptor)
    except (OSError, ValueError) as error:
        guards.append(type(error).__name__+': '+str(error))
    return {'entries': entries, 'guards': guards, 'content_read': False,
            'directory_walk': 'No-follow descriptors; parent/open/post directory identity checks',
            'excluded_runtime_source_copy': 'Public binary/source/dependencies have separate full SHA manifests'}


@contextmanager
def phase_guard(directory, mode, case):
    lock = directory/('.'+mode+'-phase.lock')
    with lock.open('x') as stream:
        stream.write(str(os.getpid()))
    try:
        previous = []
        for other in CASES:
            stem = mode+'-'+other
            if (directory/(stem+'.failure.json')).exists():
                raise RuntimeError('Prior scoped permission failure requires review; no next case')
            path = directory/(stem+'.json')
            if path.exists():
                record = json.loads(path.read_text())
                if not all(record['checks'].values()):
                    raise RuntimeError('Prior scoped permission oracle failed; stop phase')
                previous.append(record)
        used = sum(len(models(record)) for record in previous)
        expected = 6 if case == 'files' else 5
        if len(previous) >= 2 or used+expected > PHASE_CAP:
            raise RuntimeError('Scoped permission phase request/CLI cap exhausted')
        yield min(expected+1, PHASE_CAP-used)
    finally:
        lock.unlink()


def assertions(record, readiness):
    rows = models(record)
    final = record['files_after']
    before = record['files_before']
    outcome = record['result']
    checks = {
        'cli_success': outcome['exit_code'] == 0 and not outcome['timed_out'] and not outcome['output_limited'],
        'expected_messages': len(rows) == record['recipe']['expected_messages'],
        'no_mock_halt': record['mock_halt'] is None,
        'effect_oracles': all(all(row['observation']['checks'].values()) for row in rows),
        'group_clean': not record['cleanup']['remaining_members'],
        'no_forced_group_kill': not outcome['remaining_process_group_killed'],
        'no_oracle_budget_kill': not record['budget_kills'],
        'leaf_guards_pass': all('guard_error' not in value for value in final.values()),
        'state_audit_pass': not record['state_after']['guards'],
        'archive_guards_pass': not record['archives']['guards'] and not record['native_records']['guards'],
        'settings_immutable': before['settings'] == final['settings'],
        'pinned_source_unchanged': record['target_sha256_before'] == record['target_sha256_after'],
        'parent_final': FINAL in outcome['stdout'] if not readiness else outcome['stdout'] == 'owned-scoped-permission-protocol-ready',
        'no_hooks_or_peers': record['recipe']['hooks'] == record['recipe']['peers'] == 0,
    }
    if record['case'] == 'files':
        checks.update(selected_exact_bytes=final['selected.md'].get('text') == SELECTED,
                      blocked_seed_immutable=before['blocked.md'] == final['blocked.md'],
                      bare_edit_does_not_write=not final['bare-only.md']['exists'],
                      write_content_rule_does_not_write=not final['ignored.md']['exists'])
    else:
        checks['no_file_effects'] = all(not final[name]['exists'] for name in locations(Path(record['isolation']['root'])))
    if readiness:
        checks['no_app_entrypoint'] = not record['original_executed'] and not record['port_entrypoint_executed']
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['original', 'tau', 'readiness', 'bun-readiness'])
    parser.add_argument('case', choices=CASES)
    parser.add_argument('--artifacts', type=Path, default=REPO/'artifacts/differential-pass/scoped-permissions')
    parser.add_argument('--execute-reviewed-cli', action='store_true',
                        help='Only after Root separately authorizes this exact concrete CLI phase')
    args = parser.parse_args()
    if args.mode in ['original', 'tau'] and not args.execute_reviewed_cli:
        parser.error('Original/Tau execution requires separate Root review/GO; readiness is available')
    directory = args.artifacts.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stem = args.mode+'-'+args.case
    if any(directory.glob(stem+'.*')):
        raise RuntimeError('Refusing scoped capture/bootstrap/failure overwrite or rerun')
    proof = verify_source()
    target_before = digest(PINNED_TARGET)
    ready = args.mode in ['readiness', 'bun-readiness']
    state = ScopedPermissionMock(args.case, readiness=ready)
    record = None
    with phase_guard(directory, args.mode, args.case) as remaining:
        state.message_cap = remaining
        isolation = Isolation(directory, state.handler())
        try:
            if args.mode in ['tau', 'bun-readiness']:
                isolation.env.update(bun_environment(isolation.root))
            isolation.verify()
            state.root = isolation.root
            budget_kills = []
            def halt_group():
                try:
                    raw, receipt = bounded_owned_file(isolation.root, isolation.root/'owned-cli.pid', 32)
                    group = int(raw.decode().strip())
                    if group <= 1 or group == os.getpgrp() or os.getpgid(group) != group:
                        raise RuntimeError('Owned process group mismatch')
                    leader = subprocess.run(['/bin/ps', '-p', str(group), '-o', 'command='],
                                            capture_output=True, text=True, timeout=3)
                    if str(isolation.root) not in leader.stdout:
                        raise RuntimeError('Process group leader no longer belongs to owned root')
                    budget_kills.append({'group': group, 'members': owned_group_members(group),
                                         'reason': state.halt, 'pid_receipt': receipt})
                    os.killpg(group, signal.SIGKILL)
                except Exception as error:
                    budget_kills.append({'refused_or_gone': type(error).__name__, 'reason': state.halt})
            state.on_halt = halt_group
            plan = recipe(isolation.root, args.case)
            (isolation.root/'config/settings.json').write_text(json.dumps(plan['settings'])+'\n')
            if args.case == 'files':
                locations(isolation.root)['blocked.md'].write_text(BLOCKED)
            before = snapshot(isolation.root)
            state_before = state_audit(isolation.root)
            if state_before['guards'] or any('guard_error' in value for value in before.values()):
                raise RuntimeError('Initial scoped state guards failed')
            runtime = probes = fixture_runtime = fixture_probe = None
            if args.mode == 'tau':
                bun, entry, runtime, probes = prepare_bun_adapter(isolation, directory, stem)
                command = [str(bun), '--no-install', str(entry)]
            elif args.mode == 'bun-readiness':
                bun, runtime = copy_bun_executable(isolation.root)
                probes = {'version': isolation.sandbox([str(bun), '--version']),
                          'help': isolation.sandbox([str(bun), '--help'])}
                if (any(value['exit_code'] != 0 or value['timed_out'] or value['output_limited'] or
                        value['remaining_process_group_killed'] for value in probes.values()) or
                    probes['version']['stdout'].strip() != '1.4.4' or '--no-install' not in probes['help']['stdout']):
                    raise RuntimeError('Copied public Bun/no-install readiness failed')
                command = [str(bun), '--no-install']
            else:
                node, fixture_runtime = copy_node_fixture_runtime(isolation.root)
                fixture_probe = isolation.sandbox([str(node), '-e', 'process.stdout.write("owned-scoped-node-ready")'])
                if fixture_probe['exit_code'] != 0 or fixture_probe['timed_out'] or fixture_probe['output_limited'] or fixture_probe['stdout'] != 'owned-scoped-node-ready':
                    raise RuntimeError('Copied Node fixture readiness failed')
                command = [str(node)]
            arguments = list(plan['arguments'])
            if args.mode == 'original':
                command = [str(isolation.copy_target(PINNED_TARGET))]
                arguments.append('--no-session-persistence')
            if ready:
                authored = isolation.root/'owned-scoped-protocol.cjs'
                authored.write_text(PROGRAM)
                authored_plan = isolation.root/'owned-scoped-recipe.json'
                authored_plan.write_text(json.dumps(plan)+'\n')
                command = [str(bun), '--no-install', str(authored), str(authored_plan)] if args.mode == 'bun-readiness' else [str(node), str(authored), str(authored_plan)]
                arguments = []
            isolation.report['original_executed'] = args.mode == 'original'
            isolation.report['port_entrypoint_executed'] = args.mode == 'tau'
            outcome, cleanup = run_stage(isolation, command, arguments)
            record = {'mode': args.mode, 'case': args.case, 'source_preflight': proof,
                      'target_sha256_before': target_before, 'target_sha256_after': digest(PINNED_TARGET),
                      'isolation': isolation.report, 'recipe': plan, 'arguments': arguments, 'command': command,
                      'files_before': before, 'files_after': snapshot(isolation.root),
                      'state_before': state_before, 'state_after': state_audit(isolation.root),
                      'port_runtime': runtime, 'port_runtime_probes': probes,
                      'fixture_runtime': fixture_runtime, 'fixture_runtime_probe': fixture_probe,
                      'requests': state.requests, 'mock_responses': state.responses, 'mock_halt': state.halt,
                      'budget_kills': budget_kills,
                      'result': outcome, 'cleanup': cleanup, 'archives': archive_snapshot(isolation.root),
                      'native_records': native_records(isolation.root),
                      'runner_sha256': digest(Path(__file__)),
                      'harness_hashes': {name: digest(REPO/'scripts/differential'/name) for name in [
                          'prepare_scoped_permissions.py', 'run_scoped_permissions.py', 'compare_scoped_permissions.py',
                          'test_scoped_permissions_guards.py', 'isolation.py', 'run_agent_definition_hooks.py',
                          'run_child_workflows.py', 'bun_runtime.py', 'node_fixture_runtime.py', 'run_skills.py']},
                      'original_executed': args.mode == 'original', 'port_entrypoint_executed': args.mode == 'tau',
                      'response_identity': 'Unique msg_owned_agent_CASE_parent_GENERATION; no child scopes'}
            record['checks'] = assertions(record, ready)
            for stream in ['stdout', 'stderr']:
                (directory/(stem+'.'+stream+'.txt')).write_text(outcome[stream])
            kernel = subprocess.run(['/usr/bin/log', 'show', '--last', '2m', '--style', 'compact',
                                     '--predicate', 'eventMessage CONTAINS "'+isolation.tag+'"'],
                                    capture_output=True, text=True, timeout=10)
            (directory/(stem+'.denials.txt')).write_text(kernel.stdout)
        except Exception as error:
            (directory/(stem+'.failure.json')).write_text(json.dumps({
                'error': {'type': type(error).__name__, 'message': str(error)}, 'isolation': isolation.report,
                'requests': state.requests, 'partial_record': record,
                'snapshot_drift': getattr(error, 'evidence', None)}, indent=2)+'\n')
            raise
        finally:
            isolation.close()
        record['disposable_root_removed'] = not isolation.root.exists()
        record['checks']['disposable_root_removed'] = record['disposable_root_removed']
        (directory/(stem+'.json')).write_text(json.dumps(record, indent=2)+'\n')
        print(json.dumps({'mode': args.mode, 'case': args.case, 'messages': len(models(record)),
                          'checks': record['checks'], 'original_executed': record['original_executed'],
                          'port_entrypoint_executed': record['port_entrypoint_executed']}))
    if not all(record['checks'].values()):
        raise SystemExit(3)


if __name__ == '__main__':
    main()
