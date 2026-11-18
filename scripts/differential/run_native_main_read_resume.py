#!/usr/bin/env python3
"""NEW original-only MAIN Read resume. Application mode requires a separate Root GO."""
import argparse
import base64
from contextlib import contextmanager
import http.server
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import threading

from bun_runtime import bun_environment, copy_bun_executable
from isolation import Isolation, REPO, clone_file
from mock_api import events
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_native_main_read_resume import (MODEL, PROMPT, FINAL, RAW, RAW_SHA, SESSION_ID, LEAF,
    SCRIPT_NAMES, load_inputs, observe, recipe, verify_source, file_sha)
from prepare_plugins import PINNED_TARGET
from run_agent_definition_hooks import (bounded_owned_file, directory_identity, archive_snapshot, native_records)
from run_scoped_permissions import state_audit
from run_skills import run_stage, owned_group_members

PROGRAM = r'''const fs=require("node:fs");
const baseline=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
(async()=>{const response=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{
method:"POST",headers:{"content-type":"application/json"},signal:AbortSignal.timeout(5000),
body:JSON.stringify({model:"claude-sonnet-4-6",stream:true,tools:[],system:"OWNED_PROTOCOL_ONLY",messages:baseline})});
if(!response.ok||!(await response.text()).includes("OWNED_NATIVE_MAIN_READ_RESUME_FINAL"))throw Error("Owned Read-resume protocol rejected");
process.stdout.write("owned-native-main-read-resume-ready");})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
'''


def exclusive_text(path, text):
    with path.open('x', encoding='utf-8', newline='') as stream:
        stream.write(text)
    return {'path': str(path), 'bytes': len(text.encode('utf-8')),
            'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}


def retain_process_outcome(directory, stem, outcome, cleanup, artifacts):
    """Preserve bounded supervisor returns before parsing or any post-run file guard."""
    # The standalone outcome also retains both streams if a later individual
    # artifact write fails. Exclusive files never replace an existing receipt.
    artifacts['process_outcome'] = exclusive_text(directory/(stem+'.process-outcome.json'),
        json.dumps({'result': outcome, 'cleanup': cleanup}, indent=2)+'\n')
    for name in ['stdout', 'stderr']:
        artifacts[name] = exclusive_text(directory/(stem+'.'+name+'.txt'), outcome[name])
    artifacts['stream_policy'] = 'Exact bounded text returned by run_stage; replacement UTF-8 decoding, if any, already occurred in the shared supervisor'


def parse_original_output(stdout):
    try:
        value = json.loads(stdout)
        if not isinstance(value, dict):
            raise ValueError('Original stdout is JSON but is not an object')
        return value, None
    except (ValueError, TypeError) as error:
        return None, {'type': type(error).__name__, 'message': str(error),
                      **({key: getattr(error, key) for key in ['lineno', 'colno', 'pos']}
                         if isinstance(error, json.JSONDecodeError) else {})}


class WriterGuardFailure(ValueError):
    def __init__(self, message, observation):
        super().__init__(message)
        self.observation = observation


@contextmanager
def owned_directory(root, directory):
    if (not root.is_absolute() or root.resolve(strict=True) != root or not directory.is_absolute() or
        '..' in directory.parts or not directory.is_relative_to(root)):
        raise ValueError('Writer directory leaves canonical owned root')
    parts = directory.relative_to(root).parts
    if not parts or len(parts) > 64:
        raise ValueError('Writer directory depth is invalid')
    descriptors = []
    chain = []
    before = root.lstat()
    try:
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(descriptor)
        if directory_identity(before) != directory_identity(os.fstat(descriptor)):
            raise ValueError('Owned root changed before writer-directory open')
        parent = descriptor
        for name in parts:
            entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(entry.st_mode):
                raise ValueError('Writer path contains a symlink or non-directory')
            opened = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(opened)
            expected = directory_identity(entry)
            if expected != directory_identity(os.fstat(opened)):
                raise ValueError('Writer directory changed before open')
            chain.append((parent, name, opened, expected))
            parent = opened
        def recheck():
            if (directory_identity(root.lstat()) != directory_identity(before) or
                directory_identity(os.fstat(descriptor)) != directory_identity(before) or root.resolve(strict=True) != root):
                raise ValueError('Writer root identity changed')
            for ancestor, name, opened, expected in chain:
                if (directory_identity(os.fstat(opened)) != expected or
                    directory_identity(os.stat(name, dir_fd=ancestor, follow_symlinks=False)) != expected):
                    raise ValueError('Writer ancestor identity changed')
            if directory.resolve(strict=True) != directory:
                raise ValueError('Writer path canonical ownership changed')
        recheck()
        yield parent
        recheck()
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def writer_snapshot(root, directory):
    entries = {}
    total = 0
    with owned_directory(root, directory) as descriptor:
        with os.scandir(descriptor) as stream:
            for child in stream:
                if len(entries) >= 16:
                    raise ValueError('Writer directory exceeds16entries')
                before = os.stat(child.name, dir_fd=descriptor, follow_symlinks=False)
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 1048576 or
                    total+before.st_size > 2097152):
                    raise WriterGuardFailure('Writer directory contains a link/special/oversized leaf',
                        {'directory': str(directory), 'leaf': child.name, 'device': before.st_dev,
                         'inode': before.st_ino, 'mode': before.st_mode, 'links': before.st_nlink,
                         'bytes': before.st_size, 'content_read': False})
                total += before.st_size
                entries[child.name] = {'device': before.st_dev, 'inode': before.st_ino, 'mode': before.st_mode,
                    'links': before.st_nlink, 'bytes': before.st_size, 'mtime_ns': before.st_mtime_ns, 'ctime_ns': before.st_ctime_ns}
    return {'entries': entries, 'bytes': total, 'content_read': False,
            'guard': 'No-follow directory descriptors and pre/open/post ancestor/canonical identity checks'}


def writer_files(root, directory):
    files = {}; total = 0
    with owned_directory(root, directory) as descriptor:
        with os.scandir(descriptor) as stream:
            names = []
            planned = 0
            for child in stream:
                if len(names) >= 16:
                    raise ValueError('Writer capture exceeds16files')
                entry = os.stat(child.name, dir_fd=descriptor, follow_symlinks=False)
                if (not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1 or entry.st_size > 1048576 or
                    planned+entry.st_size > 2097152):
                    raise ValueError('Writer capture contains a link/special/oversized leaf')
                planned += entry.st_size
                names.append(child.name)
        for name in sorted(names):
            raw, receipt = bounded_owned_file(root, directory/name, min(1048576, 2097152-total))
            total += len(raw)
            files[name] = {**receipt, 'raw_base64': base64.b64encode(raw).decode()}
    return {'files': files, 'bytes': total, 'scope': 'Exact guarded bytes from adopted owned writer directory,16files/2MiB total/1MiB each'}


class ResumeMock:
    def __init__(self, facts):
        self.facts = facts
        self.requests = []
        self.generation = 0
        self.lock = threading.Lock()
        self.halt = None
        self.on_halt = None

    def fail(self, reason):
        if self.halt is None:
            self.halt = reason
            if self.on_halt:
                self.on_halt()

    def handler(self):
        state = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                try:
                    length = int(self.headers.get('content-length', '0'))
                    if not 0 <= length <= 2097152:
                        raise ValueError('Owned request body exceeds2MiB')
                    body = json.loads(self.rfile.read(length))
                except (ValueError, TypeError):
                    state.fail('OWNED_READ_RESUME_REQUEST_GUARD_FAILURE')
                    self.send_error(400)
                    return
                path = self.path.split('?')[0]
                seen = observe(body, state.facts) if path == '/v1/messages' else None
                with state.lock:
                    retained = dict(body); retained.pop('metadata', None)
                    state.requests.append({'path': self.path, 'body': retained, 'observation': seen,
                        'safe_headers': {name: self.headers.get(name) for name in ['anthropic-beta', 'anthropic-version', 'content-type', 'x-app'] if self.headers.get(name) is not None}})
                    if path == '/v1/messages':
                        state.generation += 1
                    generation = state.generation
                if path not in ['/v1/messages', '/v1/messages/count_tokens'] or generation > 1 or seen and not all(seen['checks'].values()):
                    state.fail('OWNED_READ_RESUME_HISTORY_OR_BUDGET_FAILURE')
                if path == '/v1/messages/count_tokens':
                    self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}')
                    return
                if path != '/v1/messages' or generation > 2:
                    self.send_error(400)
                    return
                content = [{'type': 'text', 'text': state.halt or FINAL}]
                identity = 'msg_owned_native_main_read_original_resume_'+str(generation)
                self.send_response(200)
                if body.get('stream'):
                    wire = events(content, 'end_turn', MODEL); wire[0]['message']['id'] = identity
                    self.send_header('content-type', 'text/event-stream'); self.end_headers()
                    self.wfile.write(''.join('event: '+row['type']+'\ndata: '+json.dumps(row)+'\n\n' for row in wire).encode())
                else:
                    self.send_header('content-type', 'application/json'); self.end_headers()
                    self.wfile.write(json.dumps({'id': identity, 'type': 'message', 'role': 'assistant', 'model': MODEL,
                        'content': content, 'stop_reason': 'end_turn', 'stop_sequence': None,
                        'usage': {'input_tokens': 10, 'output_tokens': 3}}).encode())
        return Handler


def assertions(record, ready):
    outcome = record['result']; rows = [row for row in record['requests'] if row['path'].split('?')[0] == '/v1/messages']
    checks = {'cli_success': outcome['exit_code'] == 0 and not outcome['timed_out'] and not outcome['output_limited'],
        'exactly_one_messages_request': len(rows) == 1, 'hard_two_message_bound': len(rows) <= 2,
        'all_eight_history_oracles': bool(rows) and all(all(row['observation']['checks'].values()) for row in rows),
        'no_mock_halt': record['mock_halt'] is None, 'group_clean': not record['cleanup']['remaining_members'],
        'no_forced_or_oracle_kill': not outcome['remaining_process_group_killed'] and not record['budget_kills'],
        'all_capture_source_artifacts_immutable': record['input_receipts_before'] == record['input_receipts_after'],
        'readonly_copy_immutable': record['copied_before'] == record['copied_after'] and record['copied_after']['sha256'] == RAW_SHA,
        'distinct_readonly_copy': record['distinct_copy'],
        'adopted_writer_directory_unchanged': record['writer_before'] == record['writer_after'],
        'adopted_writer_contains_only_exact_copy': set(record['writer_files_after']['files']) == {'native-main-read.jsonl'} and
            record['writer_files_after']['files']['native-main-read.jsonl']['sha256'] == RAW_SHA,
        'current_workspace_distinct': record['current_workspace'] != record['facts']['source_cwd'],
        'old_workspace_absent_before_after': not record['old_cwd_existed_before'] and not record['old_cwd_exists_after'],
        'restore_preconditions': all(record['facts']['restore_guards'].values()),
        'state_guards_pass': not record['state_before']['guards'] and not record['state_after']['guards'],
        'archive_guards_pass': not record['archives']['guards'] and not record['native_records']['guards'],
        'no_native_main_write': not record['native_records']['files'], 'no_port_archive': not record['archives']['files'],
        'zero_new_tools_hooks_or_peers': record['recipe']['tools'] == record['recipe']['hooks'] == record['recipe']['peers'] == 0}
    if ready:
        checks.update(authored_protocol_ready=outcome['stdout'] == 'owned-native-main-read-resume-ready',
                      no_app_entrypoint=not record['original_executed'] and not record['port_entrypoint_executed'])
    else:
        output = record['output']
        checks.update(native_id_retained=output.get('session_id') == SESSION_ID,
                      final_marker=output.get('result') == FINAL,
                      persistence_explicitly_disabled='--no-session-persistence' in record['arguments'])
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['original', 'readiness', 'bun-readiness'])
    parser.add_argument('--artifacts', type=Path, default=REPO/'artifacts/differential-pass/native-main-read-resume')
    parser.add_argument('--execute-reviewed-cli', action='store_true')
    args = parser.parse_args()
    if args.mode == 'original' and not args.execute_reviewed_cli:
        parser.error('Original execution requires a separate Root review/GO')
    directory = args.artifacts.resolve(); directory.mkdir(parents=True, exist_ok=True); stem = args.mode+'-main-read-resume'
    if any(directory.glob(stem+'.*')):
        raise RuntimeError('Refusing native Read resume capture/failure/bootstrap overwrite or rerun')
    ready = args.mode != 'original'
    record = source = facts = before = state = isolation = outcome = cleanup = None
    process_artifacts = {}; output_parse_error = None; launch_attempted = False
    failure_stage = 'source_preflight'
    try:
        source = verify_source(); raw, facts, before, _tau = load_inputs(); plan = recipe(); state = ResumeMock(facts)
        failure_stage = 'isolation_create'
        isolation = Isolation(directory/(stem+'.isolation'), state.handler())
        failure_stage = 'isolation_verify'
        if args.mode == 'bun-readiness':
            isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        copied = isolation.root/'imported/native-main-read.jsonl'; copied.parent.mkdir(mode=0o700)
        clone_file(RAW, copied); copied.chmod(0o400)
        copied_raw, copied_before = bounded_owned_file(isolation.root, copied)
        distinct = (before['raw']['device'], before['raw']['inode']) != (copied_before['device'], copied_before['inode'])
        if copied_raw != raw or not distinct or copied.stat().st_mode & 0o777 != 0o400:
            raise RuntimeError('Readonly cloned input differs, shares inode or has wrong mode')
        writer_before = writer_snapshot(isolation.root, copied.parent)
        old_cwd_before = Path(facts['source_cwd']).exists()
        if old_cwd_before:
            raise RuntimeError('Retired captured workspace unexpectedly exists; no application launch')
        runtime = probes = None
        if args.mode == 'bun-readiness':
            executable, runtime = copy_bun_executable(isolation.root)
            probes = {'version': isolation.sandbox([str(executable), '--version']),
                      'cwd': isolation.sandbox([str(executable), '-e', 'process.stdout.write(JSON.stringify({marker:"owned-read-resume-runtime-ready",cwd:process.cwd()}))'])}
            if probes['version']['exit_code'] != 0 or probes['version']['stdout'].strip() != '1.4.4':
                raise RuntimeError('Copied public Bun version changed')
            command = [str(executable), '--no-install']
        else:
            executable, runtime = copy_node_fixture_runtime(isolation.root)
            probes = {'cwd': isolation.sandbox([str(executable), '-e', 'process.stdout.write(JSON.stringify({marker:"owned-read-resume-runtime-ready",cwd:process.cwd()}))'])}
            command = [str(executable)]
        if (any(value['exit_code'] != 0 or value['timed_out'] or value['output_limited'] or value['remaining_process_group_killed'] for value in probes.values()) or
            json.loads(probes['cwd']['stdout']) != {'marker': 'owned-read-resume-runtime-ready', 'cwd': str(isolation.root/'work')}):
            raise RuntimeError('Copied public runtime/cwd bootstrap failed')
        arguments = [value.replace('__OWNED_READONLY_COPY__', str(copied)) for value in plan['arguments']]
        if ready:
            authored = isolation.root/'owned-native-main-read-resume.cjs'; authored.write_text(PROGRAM)
            baseline = isolation.root/'owned-native-main-read-messages.json'; baseline.write_text(json.dumps(facts['baseline'])+'\n')
            command += [str(authored), str(baseline)]; arguments = []
        else:
            command = [str(isolation.copy_target(PINNED_TARGET))]
        budget_kills = []
        def halt_group():
            try:
                pid_raw, pid_receipt = bounded_owned_file(isolation.root, isolation.root/'owned-cli.pid', 32)
                group = int(pid_raw.decode().strip())
                if group <= 1 or group == os.getpgrp() or os.getpgid(group) != group:
                    raise RuntimeError('Owned process group mismatch')
                leader = subprocess.run(['/bin/ps', '-p', str(group), '-o', 'command='], capture_output=True, text=True, timeout=3)
                if str(isolation.root) not in leader.stdout:
                    raise RuntimeError('Process leader no longer belongs to owned root')
                budget_kills.append({'group': group, 'members': owned_group_members(group), 'reason': state.halt, 'pid_receipt': pid_receipt})
                os.killpg(group, signal.SIGKILL)
            except Exception as error:
                budget_kills.append({'refused_or_gone': type(error).__name__, 'reason': state.halt})
        state.on_halt = halt_group
        state_before = state_audit(isolation.root)
        if state_before['guards']:
            raise RuntimeError('Initial state metadata guards failed')
        isolation.report['original_executed'] = not ready; isolation.report['port_entrypoint_executed'] = False
        failure_stage = 'supervised_launch'; launch_attempted = True
        outcome, cleanup = run_stage(isolation, command, arguments)
        failure_stage = 'retain_process_outcome'
        retain_process_outcome(directory, stem, outcome, cleanup, process_artifacts)
        record = {'mode': args.mode, 'source_preflight': source, 'recipe': plan,
            'input_receipts_before': before,
            'facts': {key: value for key, value in facts.items() if key not in ['baseline', 'expected_prefix', 'rendered', 'fragments', 'result']},
            'copied_before': copied_before, 'distinct_copy': distinct, 'writer_before': writer_before,
            'state_before': state_before, 'old_cwd_existed_before': old_cwd_before,
            'current_workspace': str(isolation.root/'work'), 'isolation': isolation.report,
            'runtime': runtime, 'runtime_probes': probes, 'arguments': arguments, 'command': command,
            'result': outcome, 'cleanup': cleanup, 'requests': state.requests, 'mock_halt': state.halt,
            'budget_kills': budget_kills, 'process_outcome_artifacts': process_artifacts,
            'output': None, 'output_parse_error': None,
            'original_executed': not ready, 'port_entrypoint_executed': False}
        if not ready:
            failure_stage = 'parse_original_output'
            record['output'], output_parse_error = parse_original_output(outcome['stdout'])
            record['output_parse_error'] = output_parse_error
            if output_parse_error is not None:
                raise ValueError('Original output JSON postcheck failed: '+output_parse_error['message'])
        failure_stage = 'post_source_recheck'
        _, _, after, _ = load_inputs(); record['input_receipts_after'] = after
        failure_stage = 'post_copied_input_recheck'
        _, copied_after = bounded_owned_file(isolation.root, copied); record['copied_after'] = copied_after
        failure_stage = 'post_writer_snapshot'
        record['writer_after'] = writer_snapshot(isolation.root, copied.parent)
        failure_stage = 'post_writer_capture'
        record['writer_files_after'] = writer_files(isolation.root, copied.parent)
        failure_stage = 'post_state_audit'
        record['state_after'] = state_audit(isolation.root)
        record['old_cwd_exists_after'] = Path(facts['source_cwd']).exists()
        failure_stage = 'post_archive_captures'
        record['archives'] = archive_snapshot(isolation.root); record['native_records'] = native_records(isolation.root)
        record['harness_hashes'] = {name: file_sha(REPO/'scripts/differential'/name) for name in SCRIPT_NAMES}
        failure_stage = 'post_assertions'
        record['checks'] = assertions(record, ready)
        failure_stage = 'kernel_denial_capture'
        kernel = subprocess.run(['/usr/bin/log', 'show', '--last', '2m', '--style', 'compact',
            '--predicate', 'eventMessage CONTAINS "'+isolation.tag+'"'], capture_output=True, text=True, timeout=10)
        (directory/(stem+'.denials.txt')).write_text(kernel.stdout)
    except Exception as error:
        exclusive_text(directory/(stem+'.failure.json'), json.dumps({
            'error': {'type': type(error).__name__, 'message': str(error)}, 'failure_stage': failure_stage,
            'isolation': isolation.report if isolation is not None else None,
            'requests': state.requests if state is not None else [], 'mock_halt': state.halt if state is not None else None,
            'result': outcome, 'cleanup': cleanup, 'process_outcome_artifacts': process_artifacts,
            'output_parse_error': output_parse_error, 'application_launch_attempted': launch_attempted,
            'partial_record': record, 'guard_observation': getattr(error, 'observation', None),
            'snapshot_drift': getattr(error, 'evidence', None)}, indent=2)+'\n')
        raise
    finally:
        if isolation is not None:
            isolation.close()
    record['disposable_root_removed'] = not isolation.root.exists()
    record['checks']['disposable_root_removed'] = record['disposable_root_removed']
    (directory/(stem+'.json')).write_text(json.dumps(record, indent=2)+'\n')
    print(json.dumps({'mode': args.mode, 'messages': state.generation, 'checks': record['checks'],
        'original_executed': record['original_executed'], 'port_entrypoint_executed': False}))
    if not all(record['checks'].values()):
        raise SystemExit(3)


if __name__ == '__main__':
    main()
