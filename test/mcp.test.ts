import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadMcpConfigs, McpManager, McpProtocolError, parseMcpConfigs, qualifyMcpToolName, sanitizeMcpName, projectMcpResult, parseMcpCallResult, type McpStdioConfig } from "../src/mcp.js";

// Independently written local server; the recovered application is never executed.
const fixture = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.argv[2], log = process.argv[3];
const record = (message) => appendFileSync(log, JSON.stringify({pid:process.pid,...message})+'\n');
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
const reply = (id,result) => send({id,result:mode==='modern'?{resultType:'complete',...result}:result});
const tools = ['read.text','tool-error','rpc-error','hang','progress','die','image','structured','audio','refresh'];
let changed = false;
record({event:'start',cwd:process.cwd(),explicit:process.env.FIXTURE_EXPLICIT});
process.on('SIGTERM',()=>{ record({event:'term'});process.exit(0); });
process.stdin.on('end',()=>{record({event:'end'});process.exit(0)});
createInterface({input:process.stdin}).on('line',(line)=>{
 let m;try {m=JSON.parse(line)} catch {return}
 record({event:'message',message:m});
 if (!m.method) return;
 if(m.method==='server/discover') {
  if(mode==='closed-probe') process.exit(12);
  else if(mode==='modern') reply(m.id,{supportedVersions:['2026-07-28'],capabilities:{tools:{listChanged:true}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'fixture',version:'1'}}});
  else if(mode==='malformed-probe') process.stdout.write('not json\n');
  else send({id:m.id,error:{code:-32601,message:'not supported'}});
 } else if(m.method==='initialize') reply(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}});
 else if(m.method==='notifications/initialized') send({id:'root-request',method:'roots/list'});
 else if(m.method==='subscriptions/listen') send({method:'notifications/subscriptions/acknowledged',params:{_meta:{'io.modelcontextprotocol/subscriptionId':m.id},notifications:{toolsListChanged:true}}});
 else if(m.method==='tools/list') {
  if(mode==='bad-cursor') return reply(m.id,{tools:[],nextCursor:'loop'});
  const names=m.params?.cursor ? tools.slice(2) : tools.slice(0,2);
  if(changed && m.params?.cursor) names.push('new-tool');
  const names2=mode==='collision' ? ['read.text','read text'] : names;
  const definitions=names2.map(name=>({name,description:'Fixture '+name,inputSchema:{type:'object',properties:{value:{type:'string'}}},annotations:{readOnlyHint:name==='read.text',title:'A title'},_meta:{'anthropic/requiresUserInteraction':name==='tool-error'}}));
  reply(m.id,{tools:definitions,...(!m.params?.cursor && mode!=='collision'?{nextCursor:'second'}:{})});
 } else if(m.method==='tools/call') {
  const name=m.params.name;
  if(name==='hang') return;
  if(name==='die') return process.exit(9);
  if(name==='rpc-error') return send({id:m.id,error:{code:-32602,message:'bad fixture input',data:{detail:'specific'}}});
  if(name==='tool-error') return reply(m.id,{content:[{type:'text',text:'fixture error'}],isError:true,structuredContent:{misleading:'success'},_meta:{local:'secret'}});
  if(name==='image') return reply(m.id,{content:[{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII='}]});
  if(name==='structured') return reply(m.id,{content:[{type:'text',text:'ignored plain text'},{type:'resource_link',name:'manual',uri:'file:///manual',description:'reference'}],structuredContent:{answer:42},_meta:{local:'metadata'}});
  if(name==='audio') return reply(m.id,{content:[{type:'audio',mimeType:'audio/wav',data:Buffer.from('RIFFtest').toString('base64')}]});
  if(name==='refresh') {changed=true;send({method:'notifications/tools/list_changed'});}
  if(name==='progress') {let count=0;const timer=setInterval(()=>{send({method:'notifications/progress',params:{progressToken:m.params._meta.progressToken,progress:count++}});if(count===3){clearInterval(timer);reply(m.id,{content:[{type:'text',text:'progress complete'}]})}},90);return;}
  if(name!=='read.text') return reply(m.id,{content:[{type:'text',text:'héllo world'}]});
  // Fragment inside a multibyte character, proving decoding happens after framing.
  const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{...(mode==='modern'?{resultType:'complete'}:{}),content:[{type:'text',text:'héllo '+String(m.params.arguments.value??'world'),_meta:{private:'text'}}],_meta:{private:'result'}}})+'\n');
  const split=data.indexOf(Buffer.from('é'))+1;
  process.stdout.write(data.subarray(0,split));setTimeout(()=>process.stdout.write(data.subarray(split)),5);
 }
});
`;

async function harness(mode = "legacy") {
  const directory = await mkdtemp(join(tmpdir(), "tau-mcp-test-"));
  const script = join(directory, "server.mjs"), log = join(directory, "events.jsonl");
  await writeFile(script, fixture);
  const config: McpStdioConfig = { command: process.execPath, args: [script, mode, log], env: { FIXTURE_EXPLICIT: "yes" } };
  const warnings: string[] = [];
  let manager: McpManager | undefined;
  return {
    directory, script, log, config, warnings,
    async connect(extra: Partial<Parameters<typeof McpManager.connect>[1]> = {}, configs?: Record<string, McpStdioConfig>) {
      manager = await McpManager.connect(configs ?? { "fixture server": config }, { cwd: directory, env: { PATH: process.env.PATH }, onWarning: (message) => warnings.push(message), ...extra });
      return manager;
    },
    async events(): Promise<Array<{ pid: number; event: string; explicit?: string; message?: { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown } }>> {
      return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; event: string });
    },
    async cleanup() { await manager?.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
const name = (tool: string) => qualifyMcpToolName("fixture server", tool);
const signal = () => new AbortController().signal;

test("MCP explicit config files/inline JSON merge, interpolate and validate without shell expansion", async () => {
  const h = await harness();
  try {
    await writeFile(join(h.directory, "mcp.json"), JSON.stringify({ mcpServers: { first: { command: "${BIN}", args: ["${EMPTY:-fallback}", "${MISSING:-fallback}", "$UNEXPANDED", "$(never-executed)"] }, replaced: { command: "old" } } }));
    const configs = await loadMcpConfigs(["mcp.json", '{"mcpServers":{"replaced":{"command":"new"}}}'], h.directory, { BIN: process.execPath, EMPTY: "" });
    assert.equal(configs.first?.command, process.execPath);
    assert.deepEqual(configs.first?.args, ["", "fallback", "$UNEXPANDED", "$(never-executed)"]);
    assert.equal(configs.replaced?.command, "new");
    assert.throws(() => parseMcpConfigs({ mcpServers: { bad: { command: "${MISSING}" } } }, {}), /Missing environment variables: MISSING/);
    assert.throws(() => parseMcpConfigs({ mcpServers: { bad: { type: "http", url: "https://invalid" } } }), /Unsupported MCP transport/);
    assert.throws(() => parseMcpConfigs({ mcpServers: { bad: { command: "node", env: { BAD: 1 } } } }), /env must contain strings/);
    assert.equal(sanitizeMcpName("a.. b"), "a___b");
    assert.equal(sanitizeMcpName("claude.ai A.. B"), "claude_ai_A_B");
  } finally { await h.cleanup(); }
});

test("MCP legacy workflow probes and initializes one process, paginates and calls original tool names", async () => {
  const h = await harness();
  try {
    const manager = await h.connect();
    assert.equal(manager.definitions.length, 10);
    assert.equal(manager.lookup(name("read.text"))?.isReadOnly, true);
    assert.equal(manager.lookup(name("read.text"))?.destructiveHint, false);
    assert.equal(manager.lookup(name("tool-error"))?.requiresUserInteraction, true);
    const result = await manager.callTool(name("read.text"), { value: "fixture" }, signal());
    assert.equal(result.projection.text, "héllo fixture");
    assert.deepEqual(result.projection.blocks, [{ type: "text", text: "héllo fixture" }]);
    assert.deepEqual(result.raw._meta, { private: "result" });
    assert.deepEqual(result.raw.content[0]?._meta, { private: "text" });
    await manager.close();
    const events = await h.events();
    const starts = events.filter((event) => event.event === "start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.explicit, "yes");
    const messages = events.filter((event) => event.message).map((event) => ({ pid: event.pid, ...event.message }));
    assert.equal(messages.filter((m) => m.method === "initialize").length, 1);
    assert.equal(messages.find((m) => m.method === "server/discover")?.pid, starts[0]?.pid);
    assert.equal(messages.find((m) => m.method === "initialize")?.pid, starts[0]?.pid);
    assert.equal(messages.find((m) => m.method === "tools/call")?.pid, starts[0]?.pid);
    assert.equal(messages.find((m) => m.method === "tools/call")?.params?.name, "read.text");
    assert.ok(messages.some((m) => m.id === "root-request" && m.result));
    assert.deepEqual(h.warnings, []);
  } finally { await h.cleanup(); }
});

test("MCP modern workflow sends request envelopes and opens/cleans list-change subscription without initialize", async () => {
  const h = await harness("modern");
  try {
    const manager = await h.connect();
    const result = await manager.callTool(name("read.text"), {}, signal());
    assert.equal(result.projection.text, "héllo world");
    await manager.close();
    const events = await h.events();
    assert.equal(events.filter(event => event.event === "start").length, 1);
    assert.equal(events.find(event => event.message?.method === "server/discover")?.pid,
      events.find(event => event.message?.method === "tools/call")?.pid);
    const messages = events.flatMap((event) => event.message ? [event.message] : []);
    assert.equal(messages.some((message) => message.method === "initialize"), false);
    const discover = messages.find((message) => message.method === "server/discover");
    assert.equal((discover?.params?._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    const call = messages.find((message) => message.method === "tools/call");
    assert.equal((call?.params?._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    assert.ok(messages.some((message) => message.method === "subscriptions/listen"));
    assert.ok(messages.some((message) => message.method === "notifications/cancelled" && message.params?.requestId === "listen:0"));
    assert.deepEqual(h.warnings, []);
  } finally { await h.cleanup(); }
});

test("MCP tools/list_changed refreshes complete paginated definitions", async () => {
  const h = await harness("modern");
  try {
    const manager = await h.connect();
    assert.equal(manager.lookup(name("new-tool")), undefined);
    await manager.callTool(name("refresh"), {}, signal());
    await manager.refreshTools();
    assert.ok(manager.lookup(name("new-tool")));
    assert.equal((await manager.callTool(name("new-tool"), {}, signal())).projection.text, "héllo world");
  } finally { await h.cleanup(); }
});

test("MCP distinguishes tool errors and JSON-RPC errors and never replays failed calls", async () => {
  const h = await harness();
  try {
    const manager = await h.connect({ negotiation: "legacy" });
    const result = await manager.callTool(name("tool-error"), {}, signal());
    assert.deepEqual(result.projection, { text: "fixture error", blocks: [{ type: "text", text: "fixture error" }], isError: true });
    assert.deepEqual(result.raw.structuredContent, { misleading: "success" });
    await assert.rejects(manager.callTool(name("rpc-error"), {}, signal()), (error) => error instanceof McpProtocolError && error.code === -32602 && (error.data as { detail: string }).detail === "specific");
    await assert.rejects(manager.callTool(name("die"), {}, signal()), /closed the connection/);
    await assert.rejects(manager.callTool(name("read.text"), {}, signal()), /disconnected/);
    const calls = (await h.events()).filter((event) => event.message?.method === "tools/call");
    assert.equal(calls.filter((event) => event.message?.params?.name === "die").length, 1);
    assert.equal(calls.filter((event) => event.message?.params?.name === "rpc-error").length, 1);
  } finally { await h.cleanup(); }
});

test("MCP cancellation notifies server once and aborts without replay; a pre-aborted call does not send", async () => {
  const h = await harness();
  try {
    const manager = await h.connect({ negotiation: "legacy" });
    const controller = new AbortController();
    const pending = manager.callTool(name("hang"), {}, controller.signal);
    await delay(30); controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(manager.callTool(name("hang"), {}, controller.signal), { name: "AbortError" });
    await delay(15);
    const messages = (await h.events()).flatMap((event) => event.message ? [event.message] : []);
    assert.equal(messages.filter((message) => message.method === "tools/call").length, 1);
    assert.equal(messages.filter((message) => message.method === "notifications/cancelled").length, 1);
  } finally { await h.cleanup(); }
});

test("MCP progress extends idle deadline while the hard per-server timeout still aborts silent calls", async () => {
  const h = await harness();
  try {
    const manager = await h.connect({ negotiation: "legacy", env: { PATH: process.env.PATH, MCP_TOOL_TIMEOUT: "1000", CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "150" } }, { "fixture server": h.config, hardcap: { ...h.config, timeout: 1000 } });
    // Progress runs longer than the idle allowance; each notification resets it.
    assert.equal((await manager.callTool(name("progress"), {}, signal())).projection.text, "progress complete");
    // A per-server timeout also sets the minimum idle allowance in the source.
    await assert.rejects(manager.callTool(qualifyMcpToolName("hardcap", "hang"), {}, signal()), /timed out after 1000ms/);
    await delay(10);
    assert.equal((await h.events()).filter((event) => event.message?.method === "notifications/cancelled").length, 1);
  } finally { await h.cleanup(); }
});

test("MCP source projection keeps images, structured data, resources, and saved audio usable", async () => {
  const h = await harness();
  try {
    const manager = await h.connect({ negotiation: "legacy" });
    const image = await manager.callTool(name("image"), {}, signal());
    assert.equal(image.projection.blocks[0]?.type, "image");
    const structured = await manager.callTool(name("structured"), {}, signal());
    assert.deepEqual(structured.projection.blocks, [{ type: "text", text: "[Resource link: manual] file:///manual (reference)" }, { type: "text", text: '{"answer":42}' }]);
    assert.deepEqual(structured.raw._meta, { local: "metadata" });
    const audio = await manager.callTool(name("audio"), {}, signal());
    assert.match(audio.projection.text, /\[Audio from fixture server\] Binary content \(audio\/wav, 8 bytes\) saved to/);
    const directory = join(h.directory, ".tau", "mcp-results");
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.equal((await readFile(join(directory, files[0]!))).toString(), "RIFFtest");
  } finally { await h.cleanup(); }
});

test("MCP source resource/PDF conversion and primitive structured fallback retain raw metadata", async () => {
  const pdf = Buffer.from("%PDF-fixture").toString("base64");
  const raw = parseMcpCallResult({ content: [
    { type: "resource", resource: { uri: "fixture:///text", text: "resource text" } },
    { type: "resource", resource: { uri: "fixture:///pdf", mimeType: "application/pdf", blob: pdf } },
    { type: "resource", resource: { uri: "fixture:///pdf2", mimeType: "application/pdf", blob: pdf } },
  ] });
  const projection = await projectMcpResult(raw, { serverName: "fixture", inlinePdfBytes: 1024 });
  assert.deepEqual(projection.blocks, [{ type: "text", text: "[Resource from fixture at fixture:///text] resource text" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } }, { type: "text", text: "[Another PDF in this result was left out: only the first is shown.]" }]);
  const primitive = parseMcpCallResult({ structuredContent: [1, 2], _meta: { trace: "local" } });
  assert.deepEqual(primitive.content, [{ type: "text", text: "[1,2]" }]);
  assert.equal((await projectMcpResult(primitive, { serverName: "fixture" })).text, "[1,2]");
  assert.equal((await projectMcpResult(parseMcpCallResult({ toolResult: 42 }), { serverName: "fixture" })).text, "42");
  assert.equal((await projectMcpResult(parseMcpCallResult({ isError: true, error: "legacy failure" }), { serverName: "fixture" })).text, "legacy failure");
  assert.throws(() => parseMcpCallResult({ content: [{ type: "text", text: 12 }] }), /Invalid or unsupported MCP/);
});

test("MCP ambiguous sanitized names are unavailable and pagination cursor loops terminate", async () => {
  const collision = await harness("collision");
  try {
    const manager = await collision.connect({ negotiation: "legacy" });
    assert.equal(manager.definitions.length, 0);
    assert.match(collision.warnings.join("\n"), /name collision/);
  } finally { await collision.cleanup(); }
  const cursor = await harness("bad-cursor");
  try {
    const manager = await cursor.connect({ negotiation: "legacy" });
    assert.deepEqual(manager.definitions, []);
    assert.deepEqual(cursor.warnings, []);
    assert.equal((await cursor.events()).filter((event) => event.message?.method === "tools/list").length, 2);
  } finally { await cursor.cleanup(); }
});

test("MCP malformed discovery reply falls back on its existing legacy process", async () => {
  const h = await harness("malformed-probe");
  try {
    const manager = await h.connect();
    assert.equal(manager.definitions.length, 10);
    assert.equal((await h.events()).filter((event) => event.event === "start").length, 1);
    assert.deepEqual(h.warnings, []);
  } finally { await h.cleanup(); }
});

test("MCP closed in-place discovery fails without launching a replacement server", async () => {
  const h = await harness("closed-probe");
  try {
    const manager = await h.connect();
    assert.deepEqual(manager.definitions, []);
    assert.match(h.warnings.join("\n"), /closed the connection/);
    const events = await h.events();
    assert.equal(events.filter(event => event.event === "start").length, 1);
    assert.equal(events.some(event => event.message?.method === "initialize"), false);
  } finally { await h.cleanup(); }
});

test("MCP startup abort disposes the child and rejects promptly", async () => {
  const h = await harness();
  try {
    const script = join(h.directory, "silent.mjs");
    await writeFile(script, "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));");
    const controller = new AbortController();
    const pending = h.connect({ signal: controller.signal }, { silent: { command: process.execPath, args: [script] } });
    await delay(40); controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { await h.cleanup(); }
});
