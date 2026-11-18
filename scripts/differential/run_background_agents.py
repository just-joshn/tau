#!/usr/bin/env python3
"""Owned background controls. Readiness executes only authored copied Node code."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
import time

from isolation import REPO, TARGET_SHA256, clone_file
from mock_api import events
from prepare_background_agents import verify, recipes
from prepare_plugins import PINNED_TARGET
from run_agents import SYSTEM_MARKER, strings, transcript_manifest, tau_child_archives
from run_plugins import results
from run_skill_effort import verified_effort_isolation
from run_skills import run_stage
from run_tau import copy_runtime, digest

CASES = ['gated-background', 'disabled-foreground']
MODEL = 'claude-sonnet-4-6'


def inside(root, path):
    try: path.relative_to(root); return True
    except ValueError: return False


class BackgroundMock:
    def __init__(self, case):
        self.case = case; self.requests = []; self.timeline = []; self.lock = threading.Lock(); self.gate = threading.Event()
        self.generations = {'parent': 0, 'child': 0}; self.root = None; self.input_file = None; self.output_file = None; self.halt = None
    def mark(self, event, **fields):
        with self.lock: self.timeline.append({'event': event, 'time_ns': time.monotonic_ns(), **fields})
    def output_from_launch(self, body):
        result = results(body).get('owned-background-parent-1', {})
        candidates = set()
        for text in strings(result.get('content')):
            candidates.update(re.findall(re.escape(str(self.root))+r'/[^\s<>"\[\]{}]+\.output', text))
        if len(candidates) != 1: self.halt = 'OWNED_BACKGROUND_UNIQUE_OUTPUT_MISSING'; return
        path = Path(next(iter(candidates)))
        if not path.is_absolute() or '..' in path.parts or not inside(self.root, path): self.halt = 'OWNED_BACKGROUND_OUTPUT_OUTSIDE_ROOT'; return
        self.output_file = path
    def action(self, scope, generation, body):
        action = None
        if scope == 'parent' and generation == 1:
            prompt = 'OWNED_BACKGROUND_CHILD_REQUEST\n'+('Read exactly once from '+str(self.input_file)+' then return OWNED_BACKGROUND_CHILD_FINAL.' if self.case == 'gated-background' else 'Return OWNED_DISABLED_CHILD_FINAL.')
            action = ('Agent', {'description': 'Owned background control', 'prompt': prompt, 'subagent_type': 'owned-reader', 'run_in_background': True}, 'owned-background-parent-1')
        elif scope == 'child' and generation == 1 and self.case == 'gated-background':
            self.mark('child_gate_wait')
            if not self.gate.wait(5): self.halt = 'OWNED_BACKGROUND_GATE_TIMEOUT'; self.mark('child_gate_timeout')
            else: self.mark('child_gate_released')
            if not self.halt: action = ('Read', {'file_path': str(self.input_file)}, 'owned-background-child-1')
        elif scope == 'parent' and generation == 2 and self.case == 'gated-background':
            self.output_from_launch(body)
        elif scope == 'parent' and generation == 3 and self.case == 'gated-background':
            if self.output_file is None or not self.output_file.exists() or not inside(self.root, self.output_file.resolve()): self.halt = 'OWNED_BACKGROUND_OUTPUT_CANONICAL_GUARD'
            else: action = ('Read', {'file_path': str(self.output_file)}, 'owned-background-output-read')
        if action and not self.halt: return [{'type': 'tool_use', 'name': action[0], 'input': action[1], 'id': action[2]}], 'tool_use'
        if self.halt: text = self.halt
        elif scope == 'child': text = 'OWNED_BACKGROUND_CHILD_FINAL' if self.case == 'gated-background' else 'OWNED_DISABLED_CHILD_FINAL'
        elif self.case == 'gated-background': text = 'OWNED_PARENT_EARLY' if generation == 2 else 'OWNED_PARENT_AFTER_NOTIFICATION'
        else: text = 'OWNED_DISABLED_PARENT_FINAL'
        return [{'type': 'text', 'text': text}], 'end_turn'
    def handler(self):
        state = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_POST(self):
                length = int(self.headers.get('content-length', '0'))
                if not 0 <= length <= 32*1024*1024: self.send_error(413); return
                try: body = json.loads(self.rfile.read(length))
                except ValueError: self.send_error(400); return
                count = self.path.split('?')[0] == '/v1/messages/count_tokens'; scope = 'child' if any(SYSTEM_MARKER in s for s in strings(body.get('system'))) else 'parent'
                with state.lock:
                    retained = dict(body); retained.pop('metadata', None)
                    if not count: state.generations[scope] += 1
                    generation = state.generations[scope]
                    state.requests.append({'path': self.path, 'scope': scope, 'generation': generation, 'body': retained, 'arrival_ns': time.monotonic_ns(),
                                           'safe_headers': {k: self.headers.get(k) for k in ['anthropic-beta', 'anthropic-version', 'content-type', 'x-app'] if self.headers.get(k) is not None}})
                if count: self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(b'{"input_tokens":32}'); return
                state.mark('request_arrived', scope=scope, generation=generation)
                if self.path.split('?')[0] != '/v1/messages': self.send_error(400); return
                if generation > (4 if scope == 'parent' and state.case == 'gated-background' else 2 if state.case == 'gated-background' else 2 if scope == 'parent' else 1): state.halt = 'OWNED_BACKGROUND_UNEXPECTED_GENERATION'
                content, stop = state.action(scope, generation, body); identity = 'msg_owned_background_'+state.case+'_'+scope+'_'+str(generation)
                state.mark('response_send_started', scope=scope, generation=generation, stop_reason=stop)
                if body.get('stream'):
                    wire = events(content, stop, body.get('model', MODEL)); wire[0]['message']['id'] = identity
                    self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers(); self.wfile.write(''.join('event: '+r['type']+'\ndata: '+json.dumps(r)+'\n\n' for r in wire).encode())
                else:
                    self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps({'id': identity, 'type': 'message', 'role': 'assistant', 'model': body.get('model', MODEL), 'content': content, 'stop_reason': stop, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 3}}).encode())
                self.wfile.flush(); state.mark('response_flushed', scope=scope, generation=generation, stop_reason=stop)
                if scope == 'parent' and generation == 2 and state.case == 'gated-background': state.mark('parent_gate_open'); state.gate.set()
        return Handler


def model_rows(record): return [r for r in record['requests'] if r['path'].split('?')[0] == '/v1/messages']


def checks(record):
    rows = model_rows(record); parent = [r for r in rows if r['scope'] == 'parent']; child = [r for r in rows if r['scope'] == 'child']; case = record['case']; stage = record['stages'][0]
    result = {'cli_success': stage['result']['exit_code'] == 0 and not stage['result']['timed_out'], 'no_halt': record['halt'] is None,
              'expected_requests': len(rows) == (6 if case == 'gated-background' else 3), 'parent_count': len(parent) == (4 if case == 'gated-background' else 2), 'child_count': len(child) == (2 if case == 'gated-background' else 1),
              'models': bool(rows) and all(r['body'].get('model') == MODEL for r in rows), 'child_read_scope': bool(child) and all([t['name'] for t in r['body'].get('tools', [])] == ['Read'] for r in child),
              'input_unchanged': record['input_after'] == 'OWNED_BACKGROUND_FILE\n', 'group_clean': not stage['cleanup']['remaining_members'], 'no_forced_group_kill': not stage['result']['remaining_process_group_killed']}
    if case == 'gated-background':
        def event(name, scope=None, generation=None): return next((r['time_ns'] for r in record['timeline'] if r['event'] == name and (scope is None or r.get('scope') == scope) and (generation is None or r.get('generation') == generation)), None)
        p2 = event('response_flushed', 'parent', 2); c1 = event('response_send_started', 'child', 1); c2 = event('response_send_started', 'child', 2); p3 = event('request_arrived', 'parent', 3)
        result.update({'gate_and_notification_partial_order': None not in [p2,c1,c2,p3] and p2 < c1 < c2 < p3,
                       'async_output_offered': record['output_path'] is not None and len(parent) > 1 and not results(parent[1]['body']).get('owned-background-parent-1', {}).get('is_error', False),
                       'child_read_result': len(child) > 1 and 'OWNED_BACKGROUND_FILE' in json.dumps(results(child[1]['body']).get('owned-background-child-1')),
                       'notification_and_child_report': len(parent) > 2 and all(x in json.dumps(parent[2]['body'].get('messages')) for x in ['<task-notification>', 'OWNED_BACKGROUND_CHILD_FINAL']),
                       'output_model_read': len(parent) > 3 and 'OWNED_BACKGROUND_CHILD_FINAL' in json.dumps(results(parent[3]['body']).get('owned-background-output-read')),
                       'output_owned_canonical': record['output_snapshot'].get('canonical_owned') is True and record['output_snapshot'].get('ownership_rechecked') is True and 'guard_error' not in record['output_snapshot'],
                       'final_marker': 'OWNED_PARENT_AFTER_NOTIFICATION' in stage['result']['stdout']})
    else:
        result.update({'foreground_order': [r['scope'] for r in rows] == ['parent','child','parent'], 'foreground_child_report': len(parent) > 1 and 'OWNED_DISABLED_CHILD_FINAL' in json.dumps(results(parent[1]['body']).get('owned-background-parent-1')),
                       'no_async_output': record['output_path'] is None, 'no_notification': '<task-notification>' not in json.dumps([r['body'].get('messages') for r in parent]), 'final_marker': 'OWNED_DISABLED_PARENT_FINAL' in stage['result']['stdout']})
    return result


def snapshot(root, path):
    if path is None: return {}
    value = {'path': str(path), 'exists': path.exists(), 'is_symlink': path.is_symlink(), 'lexical_owned': inside(root, path)}
    if not value['lexical_owned']: value['guard_error'] = 'lexical path outside owned root'; return value
    try:
        leaf = path.lstat(); value['leaf_metadata'] = {'mode': leaf.st_mode, 'device': leaf.st_dev, 'inode': leaf.st_ino, 'bytes': leaf.st_size}
        if stat.S_ISLNK(leaf.st_mode): value['symlink_target'] = os.readlink(path)
    except OSError as error: value['guard_error'] = type(error).__name__; return value
    canonical = path.resolve(); value.update({'canonical': str(canonical), 'canonical_owned': inside(root, canonical)})
    if not value['canonical_owned']: value['guard_error'] = 'canonical path outside owned root'; return value
    descriptor = None; hard_limit = 8*1024*1024
    try:
        before = canonical.stat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > hard_limit: value['guard_error'] = 'output is not regular or exceeds 8MiB hard guard'; return value
        if path.resolve() != canonical or not inside(root, canonical.parent.resolve()): value['guard_error'] = 'canonical ownership changed before open'; return value
        descriptor = os.open(canonical, os.O_RDONLY | os.O_NOFOLLOW); opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size > hard_limit: value['guard_error'] = 'opened output violates regular/size guard'; return value
        current = canonical.stat()
        if path.resolve() != canonical or not inside(root, canonical.parent.resolve()) or (opened.st_dev,opened.st_ino) != (current.st_dev,current.st_ino) or (opened.st_dev,opened.st_ino) != (before.st_dev,before.st_ino): value['guard_error'] = 'opened output identity/ownership changed'; return value
        chunks = []; count = 0; hasher = hashlib.sha256()
        while count <= hard_limit:
            chunk = os.read(descriptor, min(65536,hard_limit+1-count))
            if not chunk: break
            count += len(chunk); hasher.update(chunk)
            if count <= 1048576: chunks.append(chunk)
        if count > hard_limit: value['guard_error'] = 'output grew beyond 8MiB hard guard'; return value
        after = os.fstat(descriptor)
        if path.resolve() != canonical or not inside(root, canonical.parent.resolve()) or after.st_size != count or (opened.st_dev,opened.st_ino) != (after.st_dev,after.st_ino): value['guard_error'] = 'output changed during bounded snapshot'; return value
        value.update({'bytes': count, 'sha256': hasher.hexdigest(), 'bounded_read_limit': hard_limit, 'ownership_rechecked': True})
        if count <= 1048576: value['raw_text'] = b''.join(chunks).decode(errors='replace')
    except OSError as error: value['guard_error'] = type(error).__name__
    finally:
        if descriptor is not None: os.close(descriptor)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('executable', choices=['original','tau','readiness']); parser.add_argument('case', choices=CASES); parser.add_argument('--artifacts', type=Path, default=REPO/'artifacts/differential-pass/background-agents'); args = parser.parse_args()
    artifacts = args.artifacts.resolve(); stem = args.executable+'-'+args.case
    if (artifacts/(stem+'.json')).exists(): raise RuntimeError('Refusing capture overwrite')
    source = verify(); plan = recipes()[args.case]; state = BackgroundMock(args.case)
    with verified_effort_isolation(artifacts, state.handler(), plan['environment']) as isolation:
        state.root = isolation.root; state.input_file = isolation.root/plan['input_file']['relative']; state.input_file.write_text(plan['input_file']['text'])
        definition = isolation.root/plan['definition_path']; definition.parent.mkdir(parents=True); definition.write_text(plan['definition'])
        node, entry, runtime = copy_runtime(isolation.root); probe = isolation.sandbox([str(node), '-e', 'process.stdout.write("owned-background-node-ready")'])
        if probe['exit_code'] != 0 or probe['timed_out'] or probe['stdout'] != 'owned-background-node-ready': raise RuntimeError('Copied public Node readiness failed')
        arguments = ['--print', 'OWNED_BACKGROUND_'+args.case.upper(), '--model', MODEL, '--output-format', 'json', '--tools', 'Agent,Read', '--max-turns', '2']
        if args.executable == 'readiness':
            fixture = isolation.root/'background-readiness.cjs'; clone_file(REPO/'scripts/differential/background_readiness_fixture.cjs', fixture)
            output = isolation.root/'work/owned-readiness.output'; arguments = []; command = [str(node), str(fixture), 'http://127.0.0.1:'+str(isolation.port), args.case, str(output)]
        elif args.executable == 'original': command = [str(isolation.copy_target(PINNED_TARGET))]
        else: command = [str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(entry)]
        isolation.report['original_executed'] = args.executable == 'original'; outcome, cleanup = run_stage(isolation, command, arguments)
        record = {'case': args.case, 'executable': args.executable, 'source_preflight': source, 'target_sha256': TARGET_SHA256 if args.executable == 'original' else None,
                  'isolation': isolation.report, 'runtime': runtime, 'runtime_probe': probe, 'recipe': plan, 'requests': state.requests, 'timeline': state.timeline, 'halt': state.halt, 'output_path': str(state.output_file) if state.output_file else None,
                  'output_snapshot': snapshot(isolation.root, state.output_file), 'input_after': state.input_file.read_text(), 'stages': [{'arguments': arguments, 'result': outcome, 'cleanup': cleanup}],
                  'native_child_metadata_manifest': transcript_manifest(isolation.root), 'owned_tau_child_archives': tau_child_archives(isolation.root),
                  'response_identity': 'Unique msg_owned_background_CASE_SCOPE_GENERATION; scheduler-independent partial-order assertions', 'external_fixture_children_configured': 0}
        if args.executable == 'readiness': record['assertions'] = {'owned_node_protocol_success': outcome['exit_code'] == 0 and outcome['stdout'] == 'owned-background-protocol-ready', 'no_halt': state.halt is None, 'expected_mock_only_requests': len(model_rows(record)) == plan['expected_messages'], 'group_clean': not cleanup['remaining_members']}
        else: record['assertions'] = checks(record)
        (artifacts/(stem+'.json')).write_text(json.dumps(record, indent=2)+'\n')
        for stream in ['stdout','stderr']: (artifacts/(stem+'.'+stream+'.txt')).write_text(outcome[stream])
        kernel = subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10); (artifacts/(stem+'.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'case': args.case, 'executable': args.executable, 'model_requests': len(model_rows(record)), 'generations': state.generations, 'halt': state.halt, 'assertions': record['assertions'], 'target_executed': args.executable != 'readiness'}))
    if not all(record['assertions'].values()): raise SystemExit(3)


if __name__ == '__main__': main()
