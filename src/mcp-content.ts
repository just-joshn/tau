import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeMcpName } from "./mcp-config.js";

export type McpContentBlock =
  | { type: "text"; text: string; _meta?: Record<string, unknown>; annotations?: Record<string, unknown> }
  | { type: "image" | "audio"; data: string; mimeType: string; _meta?: Record<string, unknown> }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }; _meta?: Record<string, unknown> }
  | { type: "resource_link"; uri: string; name: string; description?: string; mimeType?: string; _meta?: Record<string, unknown> };

export interface McpCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  /** Compatibility result accepted by the recovered SDK. */
  toolResult?: unknown;
  error?: unknown;
}

export type McpApiBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export interface McpProjection { text: string; blocks: McpApiBlock[]; isError?: boolean }
export interface McpProjectionOptions {
  serverName: string;
  outputDirectory?: string;
  /** The original host supplies this budget; without one PDFs are saved as files. */
  inlinePdfBytes?: number;
  /** Source content-first override is gated and defaults off. */
  preferContent?: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the fields the projector reads; other received fields and metadata pass through untouched. */
function assertMcpContentBlock(block: unknown): asserts block is McpContentBlock {
  if (!object(block)) throw new Error("Invalid MCP content block");
  if (block.type === "text" && typeof block.text === "string") return;
  if ((block.type === "image" || block.type === "audio") && typeof block.data === "string" && typeof block.mimeType === "string") {
    try { atob(block.data); } catch { throw new Error("Invalid base64 in MCP content block"); }
    return;
  }
  if (block.type === "resource_link" && typeof block.uri === "string" && typeof block.name === "string") return;
  if (block.type === "resource" && object(block.resource) && typeof block.resource.uri === "string" && (typeof block.resource.text === "string" || typeof block.resource.blob === "string")) {
    if (typeof block.resource.blob === "string") try { atob(block.resource.blob); } catch { throw new Error("Invalid base64 in MCP resource"); }
    return;
  }
  throw new Error(`Invalid or unsupported MCP content block: ${String(block.type)}`);
}

/** Preserve the result as received; primitive structured results get the SDK's text fallback. */
export function parseMcpCallResult(value: unknown): McpCallResult {
  if (!object(value)) throw new Error("MCP tool returned an invalid result object");
  const candidate = value.content ?? [];
  if (!Array.isArray(candidate)) throw new Error("MCP tool result content must be an array");
  if (value.isError !== undefined && typeof value.isError !== "boolean") throw new Error("MCP tool result isError must be a boolean");
  if (value._meta !== undefined && !object(value._meta)) throw new Error("MCP tool result _meta must be an object");
  const content: McpContentBlock[] = [];
  for (const block of candidate) { assertMcpContentBlock(block); content.push(block); }
  // Match the SDK normalization without losing any received block or metadata.
  const structured = value.structuredContent;
  if (structured !== undefined && (!object(structured)) && !content.some((block) => block.type === "text")) content.push({ type: "text", text: JSON.stringify(structured) });
  return { ...value, content };
}

function mime(value: string | undefined): string {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "image/jpg" ? "image/jpeg" : type;
}

export async function projectMcpResult(raw: McpCallResult, options: McpProjectionOptions): Promise<McpProjection> {
  let documents = 0;
  const saveBinary = async (data: string, mediaType: string | undefined, prefix: string): Promise<McpApiBlock[]> => {
    const bytes = Buffer.from(data, "base64");
    const type = mime(mediaType);
    if (type === "application/pdf" && bytes.subarray(0, 5).toString() === "%PDF-" && bytes.length <= (options.inlinePdfBytes ?? 0)) {
      if (documents++ > 0) return [{ type: "text", text: "[Another PDF in this result was left out: only the first is shown.]" }];
      return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }];
    }
    if (!options.outputDirectory) return [{ type: "text", text: `${prefix}Binary content (${mediaType || "unknown type"}, ${bytes.length} bytes) could not be saved to disk: no result directory configured` }];
    const extensions: Record<string, string> = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "audio/wav": ".wav", "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "text/plain": ".txt" };
    const file = join(options.outputDirectory, `mcp-${sanitizeMcpName(options.serverName)}-blob-${randomUUID()}${extensions[type] ?? ".bin"}`);
    try {
      await mkdir(options.outputDirectory, { recursive: true });
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      return [{ type: "text", text: `${prefix}Binary content (${mediaType || "unknown type"}, ${bytes.length} bytes) saved to ${file}` }];
    } catch (error) { return [{ type: "text", text: `${prefix}Binary content (${mediaType || "unknown type"}, ${bytes.length} bytes) could not be saved to disk: ${error instanceof Error ? error.message : String(error)}` }]; }
  };
  const image = async (data: string, mediaType: string | undefined, prefix: string): Promise<McpApiBlock[]> => {
    const type = mime(mediaType);
    if (type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp") return [{ type: "image", source: { type: "base64", media_type: type, data } }];
    return saveBinary(data, mediaType, prefix);
  };
  const convert = async (block: McpContentBlock): Promise<McpApiBlock[]> => {
    switch (block.type) {
      case "text": return [{ type: "text", text: block.text }];
      case "image": return image(block.data, block.mimeType, `[Image from ${options.serverName}] `);
      case "audio": return saveBinary(block.data, block.mimeType, `[Audio from ${options.serverName}] `);
      case "resource_link": return [{ type: "text", text: `[Resource link: ${block.name}] ${block.uri}${block.description ? ` (${block.description})` : ""}` }];
      case "resource": {
        const resource = block.resource;
        const prefix = `[Resource from ${options.serverName} at ${resource.uri}] `;
        if (resource.text !== undefined) return [{ type: "text", text: `${prefix}${resource.text}` }];
        if (resource.blob !== undefined && mime(resource.mimeType).startsWith("image/")) {
          const blocks = await image(resource.blob, resource.mimeType, prefix);
          return blocks.some((item) => item.type === "image") ? [{ type: "text", text: prefix }, ...blocks] : blocks;
        }
        return resource.blob !== undefined ? saveBinary(resource.blob, resource.mimeType, prefix) : [];
      }
    }
  };
  let blocks: McpApiBlock[] = [];
  // Tool errors are exceptions in the original adapter: its error text is gathered from
  // content rather than hidden by a successful-looking structuredContent payload.
  if (raw.isError) {
    for (const block of raw.content) {
      if (block.type === "text" || block.type === "resource_link") blocks.push(...await convert(block));
    }
    if (!blocks.length) blocks.push({ type: "text", text: !raw.content.length && raw.error !== undefined ? String(raw.error) : "Unknown error" });
  } else if (Object.hasOwn(raw, "toolResult")) {
    blocks = [{ type: "text", text: String(raw.toolResult) }];
  } else if (raw.structuredContent !== undefined && !options.preferContent) {
    for (const block of raw.content) if (block.type !== "text") blocks.push(...await convert(block));
    blocks.push({ type: "text", text: JSON.stringify(raw.structuredContent) });
  } else {
    for (const block of raw.content) blocks.push(...await convert(block));
    if (raw.structuredContent !== undefined && !blocks.some((block) => block.type !== "text" || block.text.trim())) blocks.push({ type: "text", text: JSON.stringify(raw.structuredContent) });
  }
  return { text: blocks.map((block) => block.type === "text" ? block.text : block.type === "image" ? `[Image: ${block.source.media_type}]` : "[PDF document]").join("\n"), blocks, ...(raw.isError !== undefined ? { isError: raw.isError } : {}) };
}
