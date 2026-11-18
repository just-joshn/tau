#!/usr/bin/env python3
"""Owned persisted MAIN Read control. Original mode requires a separate root GO."""
import argparse
import base64
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import threading
import uuid

from isolation import Isolation, REPO
from mock_api import events
from node_fixture_runtime import copy_node_fixture_runtime
from prepare_plugins import PINNED_TARGET
from run_native_main import transcript_snapshot, verify_source, text_content
from run_skills import run_stage

MODEL = 'claude-sonnet-4-6'
PROMPT = 'OWNED_NATIVE_MAIN_READ_PROMPT'
PRELUDE = 'OWNED_NATIVE_MAIN_READ_PRELUDE'
FINAL = 'OWNED_NATIVE_MAIN_READ_FINAL'
FILE_NAME = 'owned-read.txt'
FILE_BYTES = b'OWNED_NATIVE_MAIN_READ_BYTES\n'
TOOL_ID = 'owned_native_main_read_1'
PROGRAM = r'''const fs = require("node:fs");
const messages=[{role:"user",content:[{type:"text",text:"OWNED_NATIVE_MAIN_READ_PROMPT"}]}];
const tools=[{name:"Read",description:"Owned protocol readiness only",input_schema:{type:"object",properties:{file_path:{type:"string"}},required:["file_path"]}}];
async function request(){const response=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-6",stream:false,tools,messages}),signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error("Owned Read readiness rejected");return response.json();}
(async()=>{const first=await request();const call=first.content.find(block=>block.type==="tool_use");if(call?.name!=="Read"||call.input.file_path!=="owned-read.txt")throw Error("Unexpected owned readiness call");messages.push({role:"assistant",content:first.content});messages.push({role:"user",content:[{type:"tool_result",tool_use_id:call.id,content:fs.readFileSync(call.input.file_path,"utf8")}]});const second=await request();if(second.content[0]?.text!=="OWNED_NATIVE_MAIN_READ_FINAL")throw Error("Wrong final readiness marker");process.stdout.write("owned-native-main-read-protocol-ready");})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
'''


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def content_blocks(body, role=None, kind=None):
    blocks = []
    for message in body.get('messages', []):
        if not isinstance(message, dict) or role is not None and message.get('role') != role:
            continue
        content = message.get('content', [])
        if isinstance(content, list):
            blocks.extend(block for block in content if isinstance(block, dict) and (kind is None or block.get('type') == kind))
    return blocks


class ReadMock:
    def __init__(self):
        self.requests = []
        self.generation = 0
        self.lock = threading.Lock()
        self.halt = None

    def handler(self):
        state = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                length = int(self.headers.get('content-length', '0'))
                if length < 0 or length > 32 * 1024 * 1024:
                    self.send_error(413)
                    return
                try:
                    body = json.loads(self.rfile.read(length))
                except ValueError:
                    self.send_error(400)
                    return
                path = self.path.split('?')[0]
                with state.lock:
                    retained = dict(body)
                    retained.pop('metadata', None)
                    state.requests.append({'path': self.path, 'body': retained})
                    if path == '/v1/messages':
                        state.generation += 1
                    generation = state.generation
                    if path not in ['/v1/messages', '/v1/messages/count_tokens'] or generation > 2:
                        state.halt = 'OWNED_NATIVE_MAIN_READ_UNEXPECTED_REQUEST'
                if path == '/v1/messages/count_tokens':
                    self.send_response(200)
                    self.send_header('content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}')
                    return
                if path != '/v1/messages' or generation > 2:
                    self.send_error(400)
                    return
                if generation == 1:
                    content = [{'type': 'text', 'text': PRELUDE}, {'type': 'tool_use', 'id': TOOL_ID, 'name': 'Read', 'input': {'file_path': FILE_NAME}}]
                    stop = 'tool_use'
                else:
                    results = content_blocks(body, 'user', 'tool_result')
                    calls = content_blocks(body, 'assistant', 'tool_use')
                    if len([r for r in results if r.get('tool_use_id') == TOOL_ID and not r.get('is_error') and 'OWNED_NATIVE_MAIN_READ_BYTES' in json.dumps(r.get('content'))]) != 1 or len([c for c in calls if c.get('id') == TOOL_ID and c.get('name') == 'Read']) != 1:
                        state.halt = 'OWNED_NATIVE_MAIN_READ_MISSING_RESULT'
                    content = [{'type': 'text', 'text': state.halt or FINAL}]
                    stop = 'end_turn'
                identity = 'msg_owned_native_main_read_' + str(generation)
                self.send_response(200)
                if body.get('stream'):
                    wire = events(content, stop, MODEL)
                    wire[0]['message']['id'] = identity
                    self.send_header('content-type', 'text/event-stream')
                    self.end_headers()
                    self.wfile.write(''.join('event: ' + item['type'] + '\ndata: ' + json.dumps(item) + '\n\n' for item in wire).encode())
                else:
                    self.send_header('content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'id': identity, 'type': 'message', 'role': 'assistant', 'model': MODEL, 'content': content, 'stop_reason': stop, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 5}}).encode())

        return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['original', 'readiness'])
    parser.add_argument('--artifacts', type=Path, default=REPO / 'artifacts/differential-pass/native-main-read')
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stem = args.mode + '-main-read'
    if any(directory.glob(stem + '.*')):
        raise RuntimeError('Refusing Read main capture/receipt overwrite')
    source = verify_source()
    state = ReadMock()
    isolation = Isolation(directory, state.handler())
    try:
        isolation.verify()
        target_file = isolation.root / 'work' / FILE_NAME
        target_file.write_bytes(FILE_BYTES)
        node, runtime = copy_node_fixture_runtime(isolation.root)
        probe = isolation.sandbox([str(node), '-e', 'process.stdout.write("owned-native-main-read-node-ready")'])
        if probe['exit_code'] != 0 or probe['timed_out'] or probe['output_limited'] or probe['stdout'] != 'owned-native-main-read-node-ready':
            raise RuntimeError('Copied public Node readiness failed')
        arguments = ['--print', PROMPT, '--model', MODEL, '--tools', 'Read', '--output-format', 'json', '--max-turns', '2']
        if args.mode == 'original':
            command = [str(isolation.copy_target(PINNED_TARGET))]
        else:
            command = [str(node), '-e', PROGRAM]
            arguments = []
        isolation.report['original_executed'] = args.mode == 'original'
        result, cleanup = run_stage(isolation, command, arguments)
        snapshots = transcript_snapshot(isolation.root)
        requests = [item for item in state.requests if item['path'].split('?')[0] == '/v1/messages']
        checks = {
            'cli_success': result['exit_code'] == 0 and not result['timed_out'] and not result['output_limited'],
            'exact_two_messages': len(requests) == 2,
            'hard_two_request_cap': len(requests) <= 2,
            'no_mock_halt': state.halt is None,
            'read_only_toolset': bool(requests) and all([tool.get('name') for tool in item['body'].get('tools', [])] == ['Read'] for item in requests),
            'known_model': all(item['body'].get('model') == MODEL for item in requests),
            'group_clean': not cleanup['remaining_members'],
            'snapshot_guards_pass': not snapshots['guards'],
            'owned_read_bytes_unchanged': target_file.read_bytes() == FILE_BYTES,
        }
        output = None
        native_audit = None
        if args.mode == 'original':
            output = json.loads(result['stdout'])
            session_id = output.get('session_id')
            uuid.UUID(session_id)
            candidates = {key: item for key, item in snapshots['files'].items() if Path(key).name == session_id + '.jsonl' and len(Path(key).parts) == 4}
            rows = [line['value'] for item in candidates.values() for line in item['rows'] if isinstance(line['value'], dict)]
            native_calls = [block for row in rows if row.get('type') == 'assistant' for block in row.get('message', {}).get('content', []) if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('id') == TOOL_ID]
            native_results = [block for row in rows if row.get('type') == 'user' for block in row.get('message', {}).get('content', []) if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('tool_use_id') == TOOL_ID]
            native_audit = {
                'row_types': [row.get('type') for row in rows],
                'attachment_types': [row.get('attachment', {}).get('type') for row in rows if row.get('type') == 'attachment'],
                'slugs': sorted({row['slug'] for row in rows if isinstance(row.get('slug'), str)}),
                'history_row_types': sorted({row['type'] for row in rows if isinstance(row.get('type'), str) and ('history' in row['type'] or 'backup' in row['type'])}),
                'last_prompt_rows': [row for row in rows if row.get('type') == 'last-prompt'],
                'assistant_fragments': [{'uuid': row.get('uuid'), 'parentUuid': row.get('parentUuid'), 'message': row.get('message')} for row in rows if row.get('type') == 'assistant'],
                'read_results': native_results,
                'readback_api_results': content_blocks(requests[1]['body'], 'user', 'tool_result') if len(requests) == 2 else [],
                'future_resume_admitted': False,
                'future_resume_reason': 'Capture facts only; native restore side effects/ownership and a separate resume runner require source review and root GO',
            }
            checks.update({
                'final_marker': output.get('result') == FINAL,
                'main_session_file': len(candidates) == 1,
                'main_prompt_row': any(row.get('type') == 'user' and PROMPT in text_content(row) for row in rows),
                'main_assistant_final': any(row.get('type') == 'assistant' and FINAL in text_content(row) for row in rows),
                'main_read_call': len(native_calls) == 1,
                'main_read_result': len(native_results) == 1 and not native_results[0].get('is_error') and 'OWNED_NATIVE_MAIN_READ_BYTES' in json.dumps(native_results[0].get('content')),
                'main_rows_owned': bool(rows) and all(row.get('sessionId', session_id) == session_id and row.get('isSidechain', False) is False and 'agentId' not in row for row in rows),
                'valid_jsonl': all(not item['malformed_lines'] for item in candidates.values()),
                'persistence_optout_absent': '--no-session-persistence' not in arguments,
            })
        else:
            checks.update({'owned_protocol_ready': result['stdout'] == 'owned-native-main-read-protocol-ready', 'no_native_transcript_fabricated': not snapshots['files']})
        record = {'mode': args.mode, 'source_preflight': source, 'isolation': isolation.report, 'runtime': runtime, 'runtime_probe': probe, 'arguments': arguments, 'result': result, 'cleanup': cleanup, 'requests': state.requests, 'mock_halt': state.halt, 'output': output, 'transcripts': snapshots, 'native_audit': native_audit, 'checks': checks, 'original_executed': args.mode == 'original', 'port_executed': False, 'hooks_configured': False, 'native_transcript_claim': args.mode == 'original', 'fixture': {'file': FILE_NAME, 'sha256': sha(FILE_BYTES), 'bytes': len(FILE_BYTES)}}
        (directory / (stem + '.json')).write_text(json.dumps(record, indent=2) + '\n')
        for key, item in snapshots['files'].items():
            destination = directory / (stem + '.transcripts') / key
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as stream:
                stream.write(base64.b64decode(item['raw_base64']))
        for name in ['stdout', 'stderr']:
            (directory / (stem + '.' + name + '.txt')).write_text(result[name])
        kernel = subprocess.run(['/usr/bin/log', 'show', '--last', '2m', '--style', 'compact', '--predicate', 'eventMessage CONTAINS "' + isolation.tag + '"'], capture_output=True, text=True, timeout=10)
        (directory / (stem + '.denials.txt')).write_text(kernel.stdout)
        print(json.dumps({'mode': args.mode, 'checks': checks, 'messages': len(requests), 'transcript_files': len(snapshots['files']), 'transcript_bytes': snapshots['total_bytes'], 'original_executed': args.mode == 'original', 'port_executed': False}))
    except Exception as error:
        (directory / (stem + '.failure.json')).write_text(json.dumps({'error': {'type': type(error).__name__, 'message': str(error)}, 'isolation': isolation.report, 'requests': state.requests}, indent=2) + '\n')
        raise
    finally:
        isolation.close()
    if not all(checks.values()):
        raise SystemExit(3)


if __name__ == '__main__':
    main()
