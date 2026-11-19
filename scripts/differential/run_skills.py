#!/usr/bin/env python3
"""Owned local Skill workflows; unique response IDs and fresh live isolation."""
import argparse
import http.server
import json
import os
from pathlib import Path
import shlex
import subprocess
import threading
import time

from isolation import REPO, TARGET_SHA256, verified_isolation
from mock_api import MODEL, events
from run_tau import copy_runtime

CASES = ["pure", "grant-write", "deny-skill", "deny-write", "slash", "model", "ignore-trust", "resume"]
OVERRIDE_MODEL = "claude-haiku-4-5-20251001"


def actions(case, stage):
    if case == "slash": return [("Write", {"file_path": "slash.txt", "content": "OWNED_SLASH_WRITE\n"})]
    if case == "resume" and stage == 2: return [("Write", {"file_path": "resume-new.txt", "content": "OWNED_RESUME_WRITE\n"})]
    name = "pure" if case == "pure" else "model" if case == "model" else "grant-model" if case == "resume" else "grant"
    result = [("Skill", {"skill": name, "args": "alpha beta"})]
    if case in ["grant-write", "deny-write", "ignore-trust", "resume"]:
        result.append(("Write", {"file_path": "first.txt" if case == "resume" else "new.txt", "content": "OWNED_SKILL_WRITE\n"}))
    return result


class SkillMock:
    def __init__(self, case):
        self.case = case; self.stage = 1; self.generation = 0; self.serial = 0; self.requests = []; self.lock = threading.Lock()
    def next_stage(self):
        with self.lock: self.stage = 2; self.generation = 0
    def handler(self):
        state = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_POST(self):
                length = int(self.headers.get('content-length', '0'))
                if length < 0 or length > 32 * 1024 * 1024:
                    self.send_response(413); self.end_headers(); return
                try: body = json.loads(self.rfile.read(length))
                except ValueError:
                    self.send_response(400); self.end_headers(); return
                with state.lock:
                    retained = dict(body); retained.pop('metadata', None)
                    count = self.path.split('?')[0] == '/v1/messages/count_tokens'
                    state.requests.append({'path': self.path, 'stage': state.stage, 'body': retained})
                    if not count: state.generation += 1; state.serial += 1
                    generation, serial, stage = state.generation, state.serial, state.stage
                if count:
                    self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(b'{"input_tokens":32}'); return
                if self.path.split('?')[0] != '/v1/messages' or serial > 10:
                    self.send_response(400); self.end_headers(); return
                plan = actions(state.case, stage)
                if generation <= len(plan):
                    name, value = plan[generation - 1]
                    content = [{'type': 'tool_use', 'id': f'owned-skill-tool-{stage}-{generation}', 'name': name, 'input': value}]; stop = 'tool_use'
                else:
                    content = [{'type': 'text', 'text': f'OWNED_SKILL_FINAL_{stage}'}]; stop = 'end_turn'
                message_id = f'msg_owned_skill_{state.case}_{serial}'
                if body.get('stream'):
                    wire = events(content, stop, body.get('model', MODEL)); wire[0]['message']['id'] = message_id
                    self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
                    self.wfile.write(''.join('event: ' + item['type'] + '\ndata: ' + json.dumps(item) + '\n\n' for item in wire).encode())
                else:
                    self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers()
                    self.wfile.write(json.dumps({'id': message_id, 'type': 'message', 'role': 'assistant', 'model': body.get('model', MODEL), 'content': content,
                                                'stop_reason': stop, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 3}}).encode())
        return Handler


def install(root):
    files = {}
    for name, extra in [('pure', ''), ('grant', 'allowed-tools: Write\n'), ('model', f'model: {OVERRIDE_MODEL}\n'), ('grant-model', f'allowed-tools: Write\nmodel: {OVERRIDE_MODEL}\n')]:
        content = f'---\ndescription: Owned {name} differential fixture\n{extra}---\nOWNED_SKILL_BODY_{name.upper().replace("-", "_")}\nOWNED_SKILL_ARGS $ARGUMENTS\n'
        path = root / 'work/.claude/skills' / name / 'SKILL.md'; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content)
        files[str(path.relative_to(root))] = content
    return files


def owned_group_members(group):
    observed = subprocess.run(['/bin/ps', '-axo', 'pid=,pgid=,stat='], capture_output=True, text=True, timeout=5)
    rows = []
    for line in observed.stdout.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[1].isdigit() and int(parts[1]) == group:
            rows.append({'pid': int(parts[0]), 'pgid': int(parts[1]), 'state': parts[2]})
    return rows


def run_stage(isolation, command, arguments):
    pid_path = isolation.root / 'owned-cli.pid'
    # Exec preserves sandbox-exec's PID/process group while recording only its
    # own numeric PID inside the already permitted disposable tree.
    shell = 'printf "%s\\n" "$$" > ' + shlex.quote(str(pid_path)) + '; exec ' + shlex.join([*command, *arguments])
    result = isolation.sandbox(['/bin/sh', '-c', shell])
    group = int(pid_path.read_text().strip()) if pid_path.exists() else None
    members = owned_group_members(group) if group is not None else []
    deadline = time.monotonic() + 2
    while members and time.monotonic() < deadline:
        time.sleep(.05); members = owned_group_members(group)
    return result, {'process_group': group, 'remaining_members': members, 'wrapper': 'owned shell builtin PID record then exec; unchanged profile'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', choices=['original', 'tau']); parser.add_argument('case', choices=CASES)
    parser.add_argument('--artifacts', type=Path, default=REPO / 'artifacts/differential-pass/skills')
    args = parser.parse_args(); artifacts = args.artifacts.resolve(); state = SkillMock(args.case)
    with verified_isolation(artifacts, state.handler()) as isolation:
        fixtures = install(isolation.root)
        runtime = None; probe = None
        if args.executable == 'original': command = [str(isolation.copy_target(Path('/Users/josh-desktop/.local/bin/claude')))]
        else:
            node, entry, runtime = copy_runtime(isolation.root)
            probe = isolation.sandbox([str(node), '-e', 'process.stdout.write("owned-skills-node-ready")'])
            if probe['exit_code'] != 0 or probe['stdout'] != 'owned-skills-node-ready' or probe['timed_out']: raise RuntimeError('Copied Node bootstrap failed')
            command = [str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(entry)]
        prompt = '/grant hello user' if args.case == 'slash' else 'OWNED_DIFFERENTIAL_SKILL_' + args.case.upper()
        arguments = ['--print', prompt, '--model', MODEL, '--output-format', 'json', '--tools', 'Skill,Write,Read']
        if args.case not in ['pure', 'model', 'slash']: arguments += ['--allowedTools', 'Skill']
        if args.case == 'deny-skill': arguments += ['--disallowedTools', 'Skill']
        if args.case == 'deny-write': arguments += ['--disallowedTools', 'Write']
        if args.case == 'ignore-trust': arguments.append('--ignore-persisted-trust')
        skipped = []
        if args.case != 'resume':
            if args.executable == 'original': arguments.append('--no-session-persistence')
            else: skipped.append('--no-session-persistence')
        isolation.report['original_executed'] = args.executable == 'original'
        result, cleanup = run_stage(isolation, command, arguments)
        stages = [{'arguments': arguments, 'result': result, 'cleanup': cleanup, 'request_start': 0, 'request_end': len(state.requests)}]
        if args.case == 'resume' and result['exit_code'] == 0:
            session_id = json.loads(result['stdout'])['session_id']; state.next_stage(); start = len(state.requests)
            resumed_arguments = ['--resume', session_id, '--print', 'OWNED_DIFFERENTIAL_SKILL_RESUME_ORDINARY', '--output-format', 'json', '--tools', 'Skill,Write,Read']
            resumed, cleanup = run_stage(isolation, command, resumed_arguments)
            stages.append({'arguments': resumed_arguments, 'result': resumed, 'cleanup': cleanup, 'request_start': start, 'request_end': len(state.requests)})
        record = {'case': args.case, 'executable': args.executable, 'target_sha256': TARGET_SHA256 if args.executable == 'original' else None,
                  'isolation': isolation.report, 'runtime': runtime, 'runtime_probe': probe, 'fixture_files': fixtures,
                  'response_identity': 'unique msg_owned_skill_CASE_SERIAL for every Messages generation, streamed or JSON',
                  'stages': stages, 'requests': state.requests, 'skipped_original_flags': skipped,
                  'final_files': {name: (isolation.root / 'work' / name).read_text() for name in ['new.txt', 'slash.txt', 'first.txt', 'resume-new.txt'] if (isolation.root / 'work' / name).exists()}}
        stem = args.executable + '-' + args.case
        (artifacts / (stem + '.json')).write_text(json.dumps(record, indent=2) + '\n')
        for index, stage in enumerate(stages):
            for stream in ['stdout', 'stderr']: (artifacts / (stem + '-' + str(index + 1) + '.' + stream + '.txt')).write_text(stage['result'][stream])
        kernel = subprocess.run(['/usr/bin/log', 'show', '--last', '2m', '--style', 'compact', '--predicate', 'eventMessage CONTAINS "' + isolation.tag + '"'], capture_output=True, text=True, timeout=10)
        (artifacts / (stem + '.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case': args.case, 'executable': args.executable, 'exits': [stage['result']['exit_code'] for stage in stages], 'requests': len(state.requests),
                          'models': [request['body'].get('model') for request in state.requests if request['path'].split('?')[0] == '/v1/messages'],
                          'remaining_group_members': [stage['cleanup']['remaining_members'] for stage in stages], 'final_files': record['final_files']}))


if __name__ == '__main__': main()
