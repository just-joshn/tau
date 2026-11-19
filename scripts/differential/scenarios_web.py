"""Loopback WebFetch/WebSearch scenario: Messages API, fixture pages and TLS on one port.

The mock speaks plain HTTP and, when a connection opens with a TLS ClientHello, HTTPS
with the test-only certificate in test/fixtures/web-tls (SAN IP:127.0.0.1). Both CLIs
upgrade http:// to https://, so the child trusts that certificate through
NODE_EXTRA_CA_CERTS. No grant beyond the existing single loopback port is needed.
"""
import http.server
import json
import socket
import ssl
import threading
from pathlib import Path

from mock_api import MODEL, events

TLS_DIR = Path(__file__).resolve().parents[2] / "test/fixtures/web-tls"
VARIANTS = ["web", "web-preflight"]
PAGE = b"""<!doctype html><html><head><title>ignored</title><style>p{}</style></head>
<body><h1>Fixture Title</h1><p>TAU_WEB_PAGE_MARKER says <b>hello</b> &amp; links <a href="https://example.com/x">onward</a>.</p>
<script>window.secret = 1</script></body></html>"""
APPLIED = "TAU_WEB_FETCH_APPLIED"
SEARCH_SUMMARY = "TAU_WEB_SEARCH_SUMMARY"


def _blocks(message):
    content = message.get("content")
    return content if isinstance(content, list) else [{"type": "text", "text": content or ""}]


def _text(message):
    return "".join(block.get("text", "") for block in _blocks(message) if isinstance(block, dict))


def search_events(model):
    """A server-tool response: server_tool_use, its web_search_tool_result, then a summary."""
    output = [{"type": "message_start", "message": {"id": "msg_web_search", "type": "message", "role": "assistant", "model": model,
               "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}}]
    blocks = [{"type": "server_tool_use", "id": "srvtoolu_web_1", "name": "web_search", "input": {}},
              {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_web_1", "content": [
                  {"type": "web_search_result", "title": "Tau result", "url": "https://example.com/tau", "encrypted_content": "x", "page_age": None}]},
              {"type": "text", "text": ""}]
    for index, block in enumerate(blocks):
        output.append({"type": "content_block_start", "index": index, "content_block": block})
        if block["type"] == "server_tool_use":
            output.append({"type": "content_block_delta", "index": index,
                           "delta": {"type": "input_json_delta", "partial_json": json.dumps({"query": "tau web search"})}})
        if block["type"] == "text":
            output.append({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": SEARCH_SUMMARY}})
        output.append({"type": "content_block_stop", "index": index})
    output.extend([{"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": 3, "server_tool_use": {"web_search_requests": 1}}}, {"type": "message_stop"}])
    return output


class WebMock:
    def __init__(self, variant):
        if variant not in VARIANTS:
            raise ValueError("Unknown web variant")
        self.variant = variant
        self.requests = []
        self.page_hits = []
        self.lock = threading.Lock()
        self.tls = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        self.tls.load_cert_chain(TLS_DIR / "cert.pem", TLS_DIR / "key.pem")

    def prepare(self, isolation):
        """Trust the fixture certificate and, for `web`, skip the domain preflight."""
        cert = isolation.root / "tls-fixture-cert.pem"
        cert.write_bytes((TLS_DIR / "cert.pem").read_bytes())
        isolation.env["NODE_EXTRA_CA_CERTS"] = str(cert)
        if self.variant == "web":
            (isolation.root / "config/settings.json").write_text(json.dumps({"skipWebFetchPreflight": True}) + "\n")

    def steps(self, port):
        page = f"http://127.0.0.1:{port}/fixture/page.html"
        return [("WebFetch", {"url": page, "prompt": "What does the fixture say?"}),
                ("WebFetch", {"url": f"http://127.0.0.1:{port}/fixture/redirect", "prompt": "Follow it"}),
                ("WebSearch", {"query": "tau web search"})]

    def respond(self, body, port):
        model = body.get("model", MODEL)
        tools = body.get("tools") or []
        if any(str(tool.get("type", "")).startswith("web_search") for tool in tools):
            return search_events(model), "search"
        messages = body.get("messages") or []
        if messages and "Web page content:" in _text(messages[-1]):
            return events([{"type": "text", "text": APPLIED}], "end_turn", model), "fetch-apply"
        blocks = [block for message in messages for block in _blocks(message) if isinstance(block, dict)]
        names = {block.get("id"): block.get("name") for block in blocks if block.get("type") == "tool_use"}
        results = [names.get(block.get("tool_use_id")) for block in blocks if block.get("type") == "tool_result"]
        # A deferred catalog (WebFetch absent, ToolSearch present) loads both tools once before the plan starts.
        tool_names = [tool.get("name") for tool in tools]
        if "WebFetch" not in tool_names and "ToolSearch" in tool_names and "ToolSearch" not in results:
            return events([{"type": "tool_use", "id": "web-step-search", "name": "ToolSearch",
                            "input": {"query": "select:WebFetch,WebSearch", "max_results": 5}}], "tool_use", model), "main"
        done = sum(1 for name in results if name != "ToolSearch")
        plan = self.steps(port)
        if done < len(plan):
            name, value = plan[done]
            return events([{"type": "tool_use", "id": f"web-step-{done + 1}", "name": name, "input": value}], "tool_use", model), "main"
        return events([{"type": "text", "text": "web workflow done"}], "end_turn", model), "main"

    def handler(self):
        state = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass

            def setup(self):
                try:
                    first = self.request.recv(1, socket.MSG_PEEK)
                except OSError:
                    first = b""
                if first == b"\x16":
                    self.request = state.tls.wrap_socket(self.request, server_side=True)
                super().setup()

            def do_GET(self):
                port = self.server.server_port
                with state.lock:
                    state.page_hits.append({"path": self.path, "tls": isinstance(self.request, ssl.SSLSocket),
                                            "user_agent": self.headers.get("user-agent"), "accept": self.headers.get("accept")})
                if self.path == "/fixture/page.html":
                    self.send_response(200); self.send_header("content-type", "text/html; charset=utf-8")
                    self.send_header("content-length", str(len(PAGE))); self.end_headers(); self.wfile.write(PAGE); return
                if self.path == "/fixture/redirect":
                    self.send_response(302); self.send_header("location", f"https://localhost:{port}/fixture/page.html")
                    self.send_header("content-length", "0"); self.end_headers(); return
                self.send_response(404); self.send_header("content-length", "0"); self.end_headers()

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                if length < 0 or length > 32 * 1024 * 1024:
                    self.send_response(413); self.end_headers(); return
                try:
                    body = json.loads(self.rfile.read(length))
                except ValueError:
                    self.send_response(400); self.end_headers(); return
                retained = dict(body); retained.pop("metadata", None)
                with state.lock:
                    state.requests.append({"path": self.path, "body": retained})
                    generations = sum(1 for r in state.requests if r["path"].split("?")[0] == "/v1/messages")
                path = self.path.split("?")[0]
                if path == "/v1/messages/count_tokens":
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}'); return
                if path != "/v1/messages" or generations > 16:
                    self.send_response(400); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"error":{"type":"invalid_request_error","message":"Unexpected mock request"}}'); return
                stream, kind = state.respond(body, self.server.server_port)
                with state.lock:
                    state.requests[-1]["kind"] = kind
                if body.get("stream"):
                    self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                    self.wfile.write("".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in stream).encode())
                    return
                content = [e["content_block"] for e in stream if e["type"] == "content_block_start"]
                for e in stream:
                    if e["type"] == "content_block_delta" and e["delta"]["type"] == "text_delta":
                        content[e["index"]]["text"] += e["delta"]["text"]
                    if e["type"] == "content_block_delta" and e["delta"]["type"] == "input_json_delta":
                        content[e["index"]]["input"] = json.loads(e["delta"]["partial_json"])
                stop = next(e["delta"]["stop_reason"] for e in stream if e["type"] == "message_delta")
                self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps({"id": "msg_web", "type": "message", "role": "assistant", "model": body.get("model", MODEL),
                                             "content": content, "stop_reason": stop, "stop_sequence": None,
                                             "usage": {"input_tokens": 10, "output_tokens": 3}}).encode())
        return Handler
