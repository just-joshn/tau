"""Loopback-only deterministic Messages API fixture for original/port comparisons."""
import http.server
import json
import threading
import scenarios_sdk_io

MODEL = "claude-sonnet-4-5-20250929"
SCENARIOS = ["text", "files", "failures"]
RECOVERY_SCENARIO = "http-404-then-json-text"

def events(content, stop_reason="end_turn", model=MODEL):
    output = [{"type": "message_start", "message": {"id": "msg_disposable_mock", "type": "message", "role": "assistant", "model": model,
               "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0,
               "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}]
    for index, block in enumerate(content):
        initial = dict(block)
        if block["type"] == "text":
            initial["text"] = ""
            delta = {"type": "text_delta", "text": block["text"]}
        else:
            initial["input"] = {}
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        output.extend([{"type": "content_block_start", "index": index, "content_block": initial},
                       {"type": "content_block_delta", "index": index, "delta": delta}, {"type": "content_block_stop", "index": index}])
    output.extend([{"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": 3}}, {"type": "message_stop"}])
    return output

class MockState:
    def __init__(self, scenario="text", sse_framing="named"):
        if scenario not in [*SCENARIOS, "mcp", "settings", "eager-instructions", RECOVERY_SCENARIO, *scenarios_sdk_io.SCENARIOS] or sse_framing not in ["named", "data-only"]:
            raise ValueError("Unknown mock scenario or SSE framing")
        self.scenario = scenario
        self.sse_framing = sse_framing
        self.requests = []
        self.lock = threading.Lock()
        self.generations = 0

    def handler(self):
        state = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                if length < 0 or length > 32 * 1024 * 1024:
                    self.send_response(413); self.end_headers(); return
                raw = self.rfile.read(length)
                try: body = json.loads(raw)
                except ValueError:
                    self.send_response(400); self.end_headers(); return
                with state.lock:
                    # Device/account metadata is irrelevant to semantic comparison and is not retained.
                    retained = dict(body); retained.pop("metadata", None)
                    state.requests.append({"path": self.path, "body": retained})
                    if self.path.split("?")[0] == "/v1/messages/count_tokens":
                        count = True; generation = 0
                    else:
                        count = False; state.generations += 1; generation = state.generations
                if count:
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b'{"input_tokens":32}'); return
                if self.path.split("?")[0] != "/v1/messages" or generation > 12:
                    self.send_response(400); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b'{"error":{"type":"invalid_request_error","message":"Unexpected mock request"}}'); return
                if state.scenario == RECOVERY_SCENARIO:
                    if generation == 1 and body.get("stream"):
                        status, payload = 404, b'{"error":{"type":"not_found_error","message":"OWNED_TRANSPORT_RECOVERY_404"}}'
                    elif generation == 2 and not body.get("stream"):
                        status, payload = 200, json.dumps({"id": "msg_owned_transport_recovery_1", "type": "message", "role": "assistant", "model": body.get("model", MODEL), "content": [{"type": "text", "text": "OWNED_TRANSPORT_RECOVERY_FINAL"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 3}}).encode()
                    else:
                        status, payload = 400, b'{"error":{"type":"invalid_request_error","message":"Unexpected mock request"}}'
                    with state.lock:
                        state.requests[-1]["status"] = status
                    self.send_response(status); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(payload)
                    if generation == 1:
                        self.close_connection = True
                    return
                if state.scenario == "text":
                    content = [{"type": "text", "text": "mock done"}]; stop = "end_turn"
                elif state.scenario == "mcp":
                    if generation == 1:
                        content = [{"type": "tool_use", "id": "fixture-mcp-1", "name": "mcp__fixture__lookup", "input": {"query": "example"}}]; stop = "tool_use"
                    else:
                        content = [{"type": "text", "text": "MCP workflow done"}]; stop = "end_turn"
                elif state.scenario == "settings":
                    steps = [("Read", {"file_path": "nested/a.txt"}),
                             ("Edit", {"file_path": "nested/a.txt", "old_string": "alpha", "new_string": "beta"}),
                             ("Write", {"file_path": "nested/new.txt", "content": "settings final\n"})]
                    step = (generation - 1) % 4
                    if step < 3:
                        name, value = steps[step]
                        content = [{"type": "tool_use", "id": "fixture-settings-" + str(generation), "name": name, "input": value}]; stop = "tool_use"
                    else:
                        content = [{"type": "text", "text": "settings workflow done"}]; stop = "end_turn"
                elif state.scenario == "eager-instructions":
                    steps = [("Edit", {"file_path": "CLAUDE.md", "old_string": "TAU_CFG_PROOF_PROJECT_ROOT_V1", "new_string": "TAU_CFG_PROOF_EAGER_EDIT_V1"}),
                             ("Write", {"file_path": ".claude/CLAUDE.md", "content": "TAU_CFG_PROOF_EAGER_WRITE_V1\n"}),
                             ("Read", {"file_path": "nested/a.txt"}),
                             ("Edit", {"file_path": "nested/CLAUDE.md", "old_string": "TAU_CFG_PROOF_NESTED_ROOT_V1", "new_string": "TAU_CFG_PROOF_NESTED_EDIT_V1"}),
                             ("Write", {"file_path": "nested/.claude/CLAUDE.md", "content": "TAU_CFG_PROOF_NESTED_WRITE_V1\n"})]
                    if generation <= len(steps):
                        name, value = steps[generation-1]
                        content = [{"type": "tool_use", "id": "fixture-eager-" + str(generation), "name": name, "input": value}]; stop = "tool_use"
                    else:
                        content = [{"type": "text", "text": "eager workflow done"}]; stop = "end_turn"
                elif state.scenario in ["files", "failures"]:
                    steps = ([("Read", {"file_path": "a.txt"}), ("Edit", {"file_path": "a.txt", "old_string": "alpha", "new_string": "beta"}),
                              ("Write", {"file_path": "a.txt", "content": "final\n"})] if state.scenario == "files" else
                             [("Edit", {"file_path": "a.txt", "old_string": "alpha", "new_string": "beta"}),
                              ("Read", {"file_path": "missing.txt"}), ("Read", {"file_path": "a.txt"}),
                              ("Edit", {"file_path": "a.txt", "old_string": "absent", "new_string": "beta"}),
                              ("Write", {"file_path": "a.txt", "content": "final\n"})])
                    if generation <= len(steps):
                        name, value = steps[generation-1]; content = [{"type": "tool_use", "id": "fixture-"+str(generation), "name": name, "input": value}]; stop = "tool_use"
                    else: content = [{"type": "text", "text": "file workflow done"}]; stop = "end_turn"
                else: content, stop = scenarios_sdk_io.respond(state.scenario, generation)
                if body.get("stream"):
                    self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                    self.wfile.write("".join(("event: "+event["type"]+"\n" if state.sse_framing == "named" else "")+
                                            "data: "+json.dumps(event)+"\n\n" for event in events(content, stop, body.get("model", MODEL))).encode())
                else:
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(json.dumps({"id": "msg_disposable_mock", "type": "message", "role": "assistant", "model": body.get("model", MODEL), "content": content,
                                                "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 3}}).encode())
        return Handler
