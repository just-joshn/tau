import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { ToolDefinition } from "./types.js";
import {
  parseMcpCallResult,
  projectMcpResult,
  type McpCallResult,
  type McpProjection,
} from "./mcp-content.js";
import { qualifyMcpToolName, type McpStdioConfig } from "./mcp-config.js";
export {
  loadMcpConfigs,
  parseMcpConfigs,
  expandMcpConfigValue,
  qualifyMcpToolName,
  sanitizeMcpName,
  type McpStdioConfig,
} from "./mcp-config.js";
export {
  parseMcpCallResult,
  projectMcpResult,
  type McpCallResult,
  type McpProjection,
  type McpApiBlock,
  type McpContentBlock,
} from "./mcp-content.js";

const LEGACY_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];
const MODERN_VERSION = "2026-07-28";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_TIMER = 2_147_483_647;
const ENVELOPE_VERSION = "io.modelcontextprotocol/protocolVersion";
const ENVELOPE_INFO = "io.modelcontextprotocol/clientInfo";
const ENVELOPE_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(
  value: string | number | undefined,
  fallback: number,
): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(number, MAX_TIMER)
    : fallback;
}
function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}
class ConnectionClosedError extends Error {}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface McpToolMetadata {
  serverName: string;
  toolName: string;
  annotations?: McpToolAnnotations;
  isReadOnly: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  requiresUserInteraction: boolean;
  alwaysLoad: boolean;
  _meta?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
interface ListedTool {
  name: string;
  description?: string;
  inputSchema: ToolDefinition["input_schema"];
  annotations?: McpToolAnnotations;
  _meta?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: Record<string, unknown>;
}
function assertListedTool(item: unknown): asserts item is ListedTool {
  if (
    !object(item) ||
    typeof item.name !== "string" ||
    !object(item.inputSchema) ||
    item.inputSchema.type !== "object"
  )
    throw new Error("Invalid MCP tool definition");
  if (item.description !== undefined && typeof item.description !== "string")
    throw new Error("Invalid MCP tool description");
  if (
    item.inputSchema.properties !== undefined &&
    !object(item.inputSchema.properties)
  )
    throw new Error("Invalid MCP input schema properties");
  if (
    item.inputSchema.required !== undefined &&
    (!Array.isArray(item.inputSchema.required) ||
      !item.inputSchema.required.every((key) => typeof key === "string"))
  )
    throw new Error("Invalid MCP input schema required list");
  if (item.annotations !== undefined) {
    if (!object(item.annotations))
      throw new Error("Invalid MCP tool annotations");
    for (const key of [
      "readOnlyHint",
      "destructiveHint",
      "openWorldHint",
      "idempotentHint",
    ])
      if (
        item.annotations[key] !== undefined &&
        typeof item.annotations[key] !== "boolean"
      )
        throw new Error(`Invalid MCP tool annotation: ${key}`);
    if (
      item.annotations.title !== undefined &&
      typeof item.annotations.title !== "string"
    )
      throw new Error("Invalid MCP tool title");
  }
  if (item._meta !== undefined && !object(item._meta))
    throw new Error("Invalid MCP tool metadata");
  if (item.outputSchema !== undefined && !object(item.outputSchema))
    throw new Error("Invalid MCP tool output schema");
}
export interface McpConnectOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onWarning?: (message: string) => void;
  outputDirectory?: string;
  inlinePdfBytes?: number;
  negotiation?: "auto" | "legacy";
  clientInfo?: { name: string; version: string };
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
  progress?(): void;
}

/** Newline-delimited stdio JSON-RPC. No shell and no execution of recovered code. */
class StdioConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number | string, Pending>();
  private nextId = 0;
  private ended = false;
  private closing: Promise<void> | undefined;
  private subscription: string | undefined;
  private subscriptionOpening: Pending | undefined;
  private readonly exited: Promise<void>;
  protocolVersion: string | undefined;
  onListChanged: (() => void) | undefined;

  constructor(
    readonly serverName: string,
    config: McpStdioConfig,
    private readonly options: McpConnectOptions,
    private probe = false,
  ) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: process.platform === "win32",
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    // The app pipes stderr for its logs. Drain it even when no logger is configured.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => {
        this.fail(
          new ConnectionClosedError(
            `MCP server ${serverName} closed the connection`,
          ),
        );
        resolve();
      }),
    );
  }

  private warn(message: string): void {
    this.options.onWarning?.(`MCP server ${this.serverName}: ${message}`);
  }
  finishProbe(): void {
    this.probe = false;
  }
  private rejectProbe(error: Error): void {
    // The app's bounded stdio subclass negotiates in place. Bad probe evidence
    // rejects the probe exchange without disposing its usable transport.
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    if (this.subscriptionOpening) {
      this.subscriptionOpening.cleanup();
      this.subscriptionOpening.reject(error);
      this.subscriptionOpening = undefined;
    }
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) break;
      if (newline > MAX_FRAME_BYTES) {
        this.overflow();
        return;
      }
      const line = this.buffer
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        if (this.probe)
          this.rejectProbe(
            new McpProtocolError(-32700, "Malformed discovery reply"),
          );
        else this.warn("ignoring malformed JSON-RPC line");
        continue;
      }
      if (!object(message) || message.jsonrpc !== "2.0") {
        if (this.probe)
          this.rejectProbe(
            new McpProtocolError(-32600, "Malformed discovery reply"),
          );
        else this.warn("ignoring invalid JSON-RPC message");
        continue;
      }
      this.dispatch(message);
    }
    if (this.buffer.length > MAX_FRAME_BYTES) this.overflow();
  }
  private overflow(): void {
    this.fail(
      new Error(
        `MCP server ${this.serverName} exceeded the 16 MiB stdio frame limit`,
      ),
    );
    this.child.kill("SIGTERM");
    void this.close(true);
  }
  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      const params = object(message.params) ? message.params : {};
      if (message.id !== undefined) {
        // Modern input requests use result envelopes; do not pretend sampling or
        // elicitation support. Legacy servers can request the workspace roots.
        if (this.protocolVersion === MODERN_VERSION) return;
        let response: Record<string, unknown>;
        if (message.method === "ping") response = { result: {} };
        else if (message.method === "roots/list")
          response = {
            result: { roots: [{ uri: pathToFileURL(this.options.cwd).href }] },
          };
        else
          response = {
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`,
            },
          };
        void this.send({ jsonrpc: "2.0", id: message.id, ...response }).catch(
          () => {},
        );
        return;
      }
      if (message.method === "notifications/tools/list_changed")
        this.onListChanged?.();
      else if (message.method === "notifications/progress") {
        const token = params.progressToken;
        if (typeof token === "string" || typeof token === "number")
          this.pending.get(token)?.progress?.();
      } else if (
        message.method === "notifications/subscriptions/acknowledged"
      ) {
        const meta = object(params._meta) ? params._meta : {};
        if (
          meta[SUBSCRIPTION_ID] === this.subscription &&
          this.subscriptionOpening
        ) {
          this.subscriptionOpening.cleanup();
          this.subscriptionOpening.resolve(params.notifications);
          this.subscriptionOpening = undefined;
        }
      } else if (message.method === "notifications/cancelled") {
        const id = params.requestId;
        if (typeof id === "number" || typeof id === "string") {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.cleanup();
            pending.reject(
              new McpProtocolError(
                -32800,
                typeof params.reason === "string"
                  ? params.reason
                  : "Server cancelled request",
              ),
            );
          }
        }
      }
      return;
    }
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") return;
    if (id === this.subscription) {
      if (this.subscriptionOpening) {
        this.subscriptionOpening.cleanup();
        this.subscriptionOpening.reject(
          new Error("MCP subscription closed before acknowledgment"),
        );
        this.subscriptionOpening = undefined;
      }
      this.subscription = undefined;
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      if (this.probe)
        this.rejectProbe(
          new McpProtocolError(-32600, "Discovery reply id mismatch"),
        );
      return;
    }
    this.pending.delete(id);
    pending.cleanup();
    if (
      object(message.error) &&
      typeof message.error.code === "number" &&
      typeof message.error.message === "string"
    )
      pending.reject(
        new McpProtocolError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    else if (
      Object.hasOwn(message, "result") &&
      !Object.hasOwn(message, "error")
    )
      pending.resolve(message.result);
    else
      pending.reject(new McpProtocolError(-32600, "Invalid JSON-RPC response"));
  }

  private envelope(): Record<string, unknown> {
    return {
      [ENVELOPE_VERSION]: this.protocolVersion ?? MODERN_VERSION,
      [ENVELOPE_INFO]: this.options.clientInfo ?? {
        name: "tau",
        version: "0.1.0",
      },
      [ENVELOPE_CAPABILITIES]: { roots: { listChanged: true } },
    };
  }
  private params(
    params: Record<string, unknown> | undefined,
    forceEnvelope = false,
  ): Record<string, unknown> | undefined {
    if (this.protocolVersion !== MODERN_VERSION && !forceEnvelope)
      return params;
    return {
      ...params,
      _meta: {
        ...this.envelope(),
        ...(object(params?._meta) ? params._meta : {}),
      },
    };
  }
  private async send(message: Record<string, unknown>): Promise<void> {
    if (this.ended || this.child.stdin.destroyed)
      throw new ConnectionClosedError(
        `MCP server ${this.serverName} is disconnected`,
      );
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) - 1 > MAX_FRAME_BYTES)
      throw new Error("MCP request exceeds the 16 MiB stdio frame limit");
    await new Promise<void>((resolve, reject) =>
      this.child.stdin.write(line, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  async notify(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const value = this.params(params);
    await this.send({
      jsonrpc: "2.0",
      method,
      ...(value !== undefined ? { params: value } : {}),
    });
  }

  request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    idleTimeoutMs = 0,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        clearTimeout(deadline);
        clearTimeout(idle);
        signal?.removeEventListener("abort", cancel);
      };
      const fail = (error: Error): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(error);
        void this.notify("notifications/cancelled", {
          requestId: id,
          reason: error.message,
        }).catch(() => {});
      };
      const cancel = (): void => fail(abortError(signal));
      const progress = (): void => {
        if (idleTimeoutMs > 0) {
          clearTimeout(idle);
          idle = setTimeout(
            () =>
              fail(
                new McpProtocolError(
                  -32001,
                  `MCP tool idle timeout after ${idleTimeoutMs}ms`,
                ),
              ),
            idleTimeoutMs,
          );
        }
      };
      this.pending.set(id, {
        resolve: (value) => {
          if (this.protocolVersion !== MODERN_VERSION) {
            resolve(value);
            return;
          }
          if (!object(value)) {
            reject(
              new McpProtocolError(
                -32600,
                `Invalid modern MCP ${method} result: not an object`,
              ),
            );
            return;
          }
          if (value.resultType === "complete") {
            const result = { ...value };
            delete result.resultType;
            resolve(result);
            return;
          }
          if (value.resultType === undefined) {
            reject(
              new McpProtocolError(
                -32600,
                `Invalid modern MCP ${method} result: missing required resultType`,
              ),
            );
            return;
          }
          reject(
            new McpProtocolError(
              -32600,
              `MCP resultType ${typeof value.resultType === "string" ? value.resultType : JSON.stringify(value.resultType)} is not supported by this port; the call will not be replayed`,
            ),
          );
        },
        reject,
        cleanup,
        progress,
      });
      deadline = setTimeout(
        () =>
          fail(
            new McpProtocolError(
              -32001,
              `MCP ${method} timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      progress();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      const value = this.params(
        method === "tools/call"
          ? {
              ...params,
              _meta: {
                ...(object(params?._meta) ? params._meta : {}),
                progressToken: id,
              },
            }
          : params,
        method === "server/discover",
      );
      void this.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(value !== undefined ? { params: value } : {}),
      }).catch((error: unknown) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async listen(timeout: number, signal?: AbortSignal): Promise<void> {
    const id = "listen:0";
    this.subscription = id;
    await new Promise<void>((resolve, reject) => {
      const cancel = (): void => {
        cleanup();
        this.subscriptionOpening = undefined;
        reject(abortError(signal));
        void this.notify("notifications/cancelled", { requestId: id }).catch(
          () => {},
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        this.subscriptionOpening = undefined;
        reject(new Error("MCP subscription acknowledgment timed out"));
        void this.notify("notifications/cancelled", { requestId: id }).catch(
          () => {},
        );
      }, timeout);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      this.subscriptionOpening = { resolve: () => resolve(), reject, cleanup };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      void this.send({
        jsonrpc: "2.0",
        id,
        method: "subscriptions/listen",
        params: this.params({ notifications: { toolsListChanged: true } }),
      }).catch((error: unknown) => {
        cleanup();
        this.subscriptionOpening = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  close(dispose = false): Promise<void> {
    return (this.closing ??= this.finishClose(dispose));
  }
  private async finishClose(dispose: boolean): Promise<void> {
    if (this.subscription && !this.ended)
      void this.notify("notifications/cancelled", {
        requestId: this.subscription,
      }).catch(() => {});
    this.fail(
      new ConnectionClosedError(
        `MCP server ${this.serverName} connection closed`,
      ),
    );
    this.child.stdin.end();
    const wait = async (milliseconds: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.exited.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), milliseconds);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    if (!dispose && (await wait(2000))) return;
    this.child.kill("SIGTERM");
    if (await wait(dispose ? 1000 : 2000)) return;
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

interface Server {
  name: string;
  config: McpStdioConfig;
  connection: StdioConnection;
  tools: ListedTool[];
  refresh?: Promise<void>;
  dirty: boolean;
}
interface ToolEntry {
  server: Server;
  tool: ListedTool;
  definition: ToolDefinition;
  metadata: McpToolMetadata;
}

export class McpManager {
  private readonly servers: Server[] = [];
  private tools = new Map<string, ToolEntry>();
  private closing = false;
  private constructor(private readonly options: McpConnectOptions) {}

  static async connect(
    configs: Record<string, McpStdioConfig>,
    options: McpConnectOptions,
  ): Promise<McpManager> {
    const manager = new McpManager(options);
    try {
      // Source connection batches are bounded; sequential startup also avoids child
      // launch storms and preserves deterministic config order in this port.
      for (const [name, config] of Object.entries(configs)) {
        if (options.signal?.aborted) throw abortError(options.signal);
        try {
          await manager.connectServer(name, config);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          options.onWarning?.(
            `MCP server ${name} failed to connect: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return manager;
    } catch (error) {
      await manager.close();
      throw error;
    }
  }
  /** Names of the servers that connected; configured servers absent here failed. */
  get connectedServers(): string[] {
    return this.servers.map((server) => server.name);
  }

  get definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((entry) => entry.definition);
  }
  lookup(name: string): McpToolMetadata | undefined {
    return this.tools.get(name)?.metadata;
  }

  private async connectServer(
    name: string,
    config: McpStdioConfig,
  ): Promise<void> {
    const env = this.options.env ?? process.env;
    const timeout = positive(env.MCP_TIMEOUT, 30_000);
    const negotiation =
      this.options.negotiation ??
      (env.MCP_PROTOCOL_NEGOTIATION === "legacy" ? "legacy" : "auto");
    let discoveredCapabilities: Record<string, unknown> | undefined;
    // The shipped app wraps the SDK transport in a bounded subclass. The SDK's
    // immediate-prototype _dispose gate excludes that subclass from sibling
    // probing, so negotiation and legacy initialization share one process.
    const connection = new StdioConnection(
      name,
      config,
      this.options,
      negotiation === "auto",
    );
    try {
      await connection.ready;
      if (negotiation === "auto") {
        try {
          const result = await connection.request(
            "server/discover",
            undefined,
            Math.min(3000, Math.floor(timeout / 3)),
            this.options.signal,
          );
          if (
            object(result) &&
            Array.isArray(result.supportedVersions) &&
            result.supportedVersions.every(
              (version) => typeof version === "string",
            ) &&
            result.supportedVersions.includes(MODERN_VERSION) &&
            object(result.capabilities)
          )
            discoveredCapabilities = result.capabilities;
        } catch (error) {
          if (this.options.signal?.aborted) throw error;
          // RPC errors, malformed replies and timeout allow the legacy handshake.
          // A closed in-place transport cannot be silently replaced and replayed.
          if (!(error instanceof McpProtocolError)) throw error;
        } finally {
          connection.finishProbe();
        }
      }
      let capabilities: Record<string, unknown>;
      if (discoveredCapabilities) {
        connection.protocolVersion = MODERN_VERSION;
        capabilities = discoveredCapabilities;
      } else {
        const result = await connection.request(
          "initialize",
          {
            protocolVersion: LEGACY_VERSIONS[0],
            capabilities: { roots: { listChanged: true } },
            clientInfo: this.options.clientInfo ?? {
              name: "tau",
              version: "0.1.0",
            },
          },
          timeout,
          this.options.signal,
        );
        if (
          !object(result) ||
          typeof result.protocolVersion !== "string" ||
          !LEGACY_VERSIONS.includes(result.protocolVersion) ||
          !object(result.capabilities) ||
          !object(result.serverInfo) ||
          typeof result.serverInfo.name !== "string" ||
          typeof result.serverInfo.version !== "string"
        )
          throw new Error(
            "MCP server returned an invalid or unsupported initialize result",
          );
        connection.protocolVersion = result.protocolVersion;
        capabilities = result.capabilities;
        await connection.notify("notifications/initialized");
      }
      const server: Server = {
        name,
        config,
        connection,
        tools: [],
        dirty: false,
      };
      connection.onListChanged = () => {
        server.dirty = true;
        void this.refresh(server).catch((error: unknown) => {
          if (!this.closing)
            this.options.onWarning?.(
              `MCP server ${name} tool refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
      };
      if (
        connection.protocolVersion === MODERN_VERSION &&
        object(capabilities.tools) &&
        capabilities.tools.listChanged === true
      )
        await connection
          .listen(timeout, this.options.signal)
          .catch((error: unknown) => {
            if (this.options.signal?.aborted) throw error;
            this.options.onWarning?.(
              `MCP server ${name} list-change subscription failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      if (capabilities.tools)
        server.tools = await this.listTools(server, this.options.signal);
      this.servers.push(server);
      this.rebuild();
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  private async listTools(
    server: Server,
    signal?: AbortSignal,
  ): Promise<ListedTool[]> {
    const tools: ListedTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    const timeout = positive(
      (this.options.env ?? process.env).MCP_TIMEOUT,
      30_000,
    );
    for (let page = 0; page < 64; page++) {
      const result = await server.connection.request(
        "tools/list",
        cursor === undefined ? undefined : { cursor },
        timeout,
        signal,
      );
      if (!object(result) || !Array.isArray(result.tools))
        throw new Error("Invalid MCP tools/list result");
      for (const item of result.tools) {
        assertListedTool(item);
        tools.push(item);
      }
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== "string")
        throw new Error("Invalid MCP pagination cursor");
      // The SDK treats a repeated cursor as the end of the aggregate, keeping
      // the pages already received rather than looping or replaying the list.
      if (cursors.has(result.nextCursor)) return tools;
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("MCP tools/list exceeded the 64-page limit");
  }
  private refresh(server: Server): Promise<void> {
    if (this.closing) return Promise.resolve();
    return (server.refresh ??= (async () => {
      do {
        server.dirty = false;
        const tools = await this.listTools(server);
        if (this.closing) return;
        server.tools = tools;
        this.rebuild();
      } while (server.dirty);
    })().finally(() => {
      delete server.refresh;
    }));
  }
  /** Await pending list-change refreshes before constructing the next model request. */
  async refreshTools(): Promise<void> {
    await Promise.all(
      this.servers.flatMap((server) =>
        server.refresh ? [server.refresh] : [],
      ),
    );
  }

  private rebuild(): void {
    const tools = new Map<string, ToolEntry>();
    const collided = new Set<string>();
    for (const server of this.servers)
      for (const tool of server.tools) {
        const name = qualifyMcpToolName(server.name, tool.name);
        if (tools.has(name) || collided.has(name)) {
          tools.delete(name);
          collided.add(name);
          this.options.onWarning?.(
            `MCP tool name collision: ${name}; the ambiguous tools are unavailable`,
          );
          continue;
        }
        if (name.length > 128) {
          this.options.onWarning?.(
            `MCP tool name exceeds the API's 128-character limit: ${name}`,
          );
          continue;
        }
        const metadata: McpToolMetadata = {
          serverName: server.name,
          toolName: tool.name,
          isReadOnly: tool.annotations?.readOnlyHint === true,
          destructiveHint: tool.annotations?.destructiveHint === true,
          openWorldHint: tool.annotations?.openWorldHint === true,
          requiresUserInteraction:
            tool._meta?.["anthropic/requiresUserInteraction"] === true,
          alwaysLoad:
            tool._meta?.["anthropic/alwaysLoad"] === true ||
            (server.config.alwaysLoad === true &&
              tool._meta?.["anthropic/alwaysLoad"] !== false),
          ...(tool.annotations !== undefined
            ? { annotations: tool.annotations }
            : {}),
          ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
          ...(tool.outputSchema !== undefined
            ? { outputSchema: tool.outputSchema }
            : {}),
        };
        tools.set(name, {
          server,
          tool,
          metadata,
          definition: {
            name,
            description: tool.description ?? "",
            input_schema: tool.inputSchema,
          },
        });
      }
    this.tools = tools;
  }

  async callTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ raw: McpCallResult; projection: McpProjection }> {
    if (signal.aborted) throw abortError(signal);
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Unknown MCP tool: ${name}`);
    if (!object(input)) throw new Error("MCP tool arguments must be an object");
    const env = this.options.env ?? process.env;
    const configTimeout = entry.server.config.timeout;
    const timeout =
      configTimeout !== undefined && configTimeout >= 1000
        ? Math.min(configTimeout, MAX_TIMER)
        : Math.max(1000, positive(env.MCP_TOOL_TIMEOUT, 100_000_000));
    const configuredIdle = env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT;
    const idle =
      configuredIdle !== undefined &&
      Number.isFinite(Number(configuredIdle)) &&
      Number(configuredIdle) <= 0
        ? 0
        : Math.min(
            timeout,
            Math.max(
              configTimeout !== undefined && configTimeout >= 1000
                ? configTimeout
                : 0,
              positive(configuredIdle, 1_800_000),
            ),
          );
    const result = await entry.server.connection.request(
      "tools/call",
      { name: entry.tool.name, arguments: input },
      timeout,
      signal,
      idle,
    );
    if (
      object(result) &&
      typeof result.resultType === "string" &&
      ["task", "input_required", "upload_required"].includes(result.resultType)
    )
      throw new Error(
        `MCP ${result.resultType} results are not supported by this port; the call will not be replayed`,
      );
    const raw = parseMcpCallResult(result);
    const projection = await projectMcpResult(raw, {
      serverName: entry.server.name,
      outputDirectory:
        this.options.outputDirectory ??
        join(this.options.cwd, ".tau", "mcp-results"),
      ...(this.options.inlinePdfBytes !== undefined
        ? { inlinePdfBytes: this.options.inlinePdfBytes }
        : {}),
    });
    return { raw, projection };
  }
  async close(): Promise<void> {
    this.closing = true;
    this.tools.clear();
    await Promise.all(this.servers.map((server) => server.connection.close()));
    await Promise.all(
      this.servers.flatMap((server) =>
        server.refresh ? [server.refresh.catch(() => {})] : [],
      ),
    );
  }
}
