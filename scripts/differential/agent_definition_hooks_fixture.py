"""Owned mock protocol for a future root-authorized definition-hook run.

Importing constructs no listener or subprocess. This preparation lane does not run
this protocol against either CLI; the owning runner must enforce its existing
verified disposable isolation and separate execution GO.
"""
import http.server
import json
import threading

from mock_api import events
from prepare_agent_definition_hooks import MODEL, agent, delegation_marker
from prepare_child_workflows import direct_user_texts

MARKERS = {
    'reader': 'OWNED_DEF_HOOK_SYSTEM_READER',
    'outer': 'OWNED_DEF_HOOK_SYSTEM_OUTER',
    'inner': 'OWNED_DEF_HOOK_SYSTEM_INNER',
    'background': 'OWNED_DEF_HOOK_SYSTEM_BACKGROUND',
}


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)


def tool(identity, name, arguments):
    return [{'type': 'tool_use', 'id': identity, 'name': name, 'input': arguments}], 'tool_use'


def text(value):
    return [{'type': 'text', 'text': value}], 'end_turn'


class AgentDefinitionHookMock:
    def __init__(self, case, file_path):
        if case not in {'dedup-once-foreground', 'nested-start-background-stop'}:
            raise ValueError('Unsupported owned definition-hook case')
        self.case = case
        self.file_path = str(file_path)
        self.requests = []
        self.generations = {scope: 0 for scope in ['parent', *MARKERS]}
        self.serial = 0
        self.message_cap = 8 if case == 'dedup-once-foreground' else 10
        self.lock = threading.Lock()
        self.release_background = threading.Event()
        self.thread_state = threading.local()
        self.gate_failed = False
        self.gate_events = []
        self.halt = None
        self.failures = []
        self.responses = []
        self.on_halt = lambda: None
        self.lifecycle_snapshot = lambda: {}
        self.request_oracles = True

    def fail(self, error, path):
        with self.lock:
            failure = {'type': type(error).__name__, 'message': str(error), 'path': path}
            self.failures.append(failure)
            first = self.halt is None
            if first:
                self.halt = failure
        if first:
            self.on_halt()

    def scope(self, body):
        found = [scope for scope in MARKERS if any(delegation_marker(self.case, scope) in value for value in direct_user_texts(body))]
        if len(found) > 1:
            raise RuntimeError('Ambiguous owned DIRECT USER delegation markers')
        return found[0] if found else 'parent'

    def response(self, scope, generation, body):
        if self.case == 'dedup-once-foreground':
            if scope == 'parent' and generation == 1:
                return tool('owned-def-hooks-delegate', 'Agent', agent('owned-hook-reader'))
            if scope == 'reader' and generation in {1, 2}:
                return tool('owned-def-hooks-read-' + str(generation), 'Read', {'file_path': self.file_path})
            if scope == 'reader' and generation == 3:
                return text('OWNED_DEF_HOOK_READER_FINAL')
            if scope == 'parent' and generation == 2:
                return tool('owned-def-hooks-parent-read', 'Read', {'file_path': self.file_path})
            if scope == 'parent' and generation == 3:
                return text('OWNED_DEF_HOOK_FOREGROUND_PARENT_FINAL')
        else:
            if scope == 'parent' and generation == 1:
                return tool('owned-def-hooks-outer', 'Agent', agent('owned-hook-outer', case=self.case))
            if scope == 'outer' and generation == 1:
                return tool('owned-def-hooks-inner', 'Agent', agent('owned-hook-inner', case=self.case))
            if scope == 'inner' and generation == 1:
                return text('OWNED_DEF_HOOK_INNER_FINAL')
            if scope == 'outer' and generation == 2:
                return text('OWNED_DEF_HOOK_OUTER_FINAL')
            if scope == 'parent' and generation == 2:
                return tool('owned-def-hooks-background', 'Agent', agent('owned-hook-background', True, case=self.case))
            if scope == 'background' and generation == 1:
                if not self.release_background.wait(5):
                    self.gate_failed = True
                    self.gate_events.append('background-gate-timeout')
                    return text('OWNED_DEF_HOOK_GATE_TIMEOUT')
                self.gate_events.append('background-response-after-parent-flush')
                return text('OWNED_DEF_HOOK_BACKGROUND_FINAL')
            if scope == 'parent' and generation == 3:
                self.thread_state.release_after_flush = True
                return text('OWNED_DEF_HOOK_PARENT_EARLY')
            if scope == 'parent' and generation == 4:
                history = list(strings(body.get('messages')))
                if not any('<task-notification>' in value for value in history) or not any('OWNED_DEF_HOOK_BACKGROUND_FINAL' in value for value in history):
                    raise RuntimeError('Expected owned task-notification continuation')
                return text('OWNED_DEF_HOOK_PARENT_NOTIFIED')
        raise RuntimeError('Unexpected owned mock scope/generation: ' + scope + '/' + str(generation))

    def handler(self):
        state = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                state.thread_state.release_after_flush = False
                path = self.path.split('?')[0]
                try:
                    length = int(self.headers.get('content-length', '0'))
                    if length < 0 or length > 32 * 1024 * 1024:
                        raise ValueError('Owned request exceeds 32MiB body bound')
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise ValueError('Owned API body must be an object')
                    if path not in {'/v1/messages', '/v1/messages/count_tokens'}:
                        raise RuntimeError('Unexpected owned API path')
                    scope = state.scope(body)
                except (ValueError, RuntimeError, TypeError, AttributeError) as error:
                    state.fail(error, self.path)
                    self.send_response(400)
                    self.end_headers()
                    return
                count = path == '/v1/messages/count_tokens'
                with state.lock:
                    retained = dict(body)
                    retained.pop('metadata', None)
                    state.requests.append({'path': self.path, 'scope': scope, 'body': retained,
                        'direct_user_markers': [key for key in MARKERS if any(delegation_marker(state.case, key) in value for value in direct_user_texts(body))], 'lifecycle_snapshot': state.lifecycle_snapshot(),
                        'safe_headers': {name: self.headers.get(name) for name in ['anthropic-beta', 'anthropic-version', 'content-type', 'x-app'] if self.headers.get(name) is not None}})
                    if not count:
                        state.serial += 1
                        state.generations[scope] += 1
                    serial = state.serial
                    generation = state.generations[scope]
                if count:
                    self.send_response(200)
                    self.send_header('content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}')
                    return
                try:
                    if serial >= state.message_cap - 1:
                        raise RuntimeError('Owned request cap reached; reserve one in-flight request of headroom')
                    if state.halt:
                        raise RuntimeError('Owned mock already halted')
                    content, stop = state.response(scope, generation, body)
                except Exception as error:
                    state.fail(error, self.path)
                    self.send_response(409)
                    self.end_headers()
                    return
                state.responses.append({'scope':scope,'generation':generation,'content':content,'stop_reason':stop})
                identity = 'msg_owned_def_hooks_' + state.case + '_' + scope + '_' + str(generation)
                if body.get('stream'):
                    wire = events(content, stop, body.get('model', MODEL))
                    wire[0]['message']['id'] = identity
                    self.send_response(200)
                    self.send_header('content-type', 'text/event-stream')
                    self.end_headers()
                    self.wfile.write(''.join('event: ' + item['type'] + '\ndata: ' + json.dumps(item) + '\n\n' for item in wire).encode())
                else:
                    self.send_response(200)
                    self.send_header('content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'id': identity, 'type': 'message', 'role': 'assistant', 'model': body.get('model', MODEL), 'content': content,
                        'stop_reason': stop, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 3}}).encode())
                self.wfile.flush()
                if state.thread_state.release_after_flush:
                    state.gate_events.append('parent-generation3-response-flushed')
                    state.release_background.set()

        return Handler
