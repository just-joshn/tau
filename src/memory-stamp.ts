/** Provenance stamp the original applies when Write creates an auto-memory .md file. */

import { parse as parseYaml } from "yaml";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n(?:\n|([\s\S]*))?$/;

/** Source Tm: memory `name` is a kebab slug. */
export function memoryNameSlug(name: string): string {
  if (/^[a-z0-9_-]+$/.test(name)) return name;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface MemoryStampInput {
  content: string;
  sessionId: string;
  /** ISO timestamp; defaults to now. */
  modified?: string;
}

/**
 * Source `stampNewMemoryContent` / `iVo` for a *new* file: when the body has
 * YAML frontmatter and no `originSessionId` yet, rewrite it with `node_type`,
 * `originSessionId`, and `modified`. Content without frontmatter is unchanged
 * (MEMORY.md index lines stay exact).
 */
export function stampNewMemoryContent(input: MemoryStampInput): string {
  const text = input.content
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const match = FRONTMATTER.exec(text);
  if (!match) return input.content;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return input.content;
  }
  if (!isPlainObject(parsed)) return input.content;
  const frontmatter: Record<string, unknown> = parsed;
  const metadata: Record<string, unknown> = isPlainObject(frontmatter.metadata)
    ? { ...frontmatter.metadata }
    : {};
  if (
    typeof metadata.originSessionId === "string" &&
    metadata.originSessionId.length > 0
  )
    return input.content;
  const name =
    typeof frontmatter.name === "string"
      ? memoryNameSlug(frontmatter.name)
      : "";
  const description =
    frontmatter.description === undefined || frontmatter.description === null
      ? undefined
      : frontmatter.description;
  const stamped = {
    name,
    ...(description === undefined ? {} : { description }),
    metadata: {
      node_type: "memory",
      ...Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key !== "node_type"),
      ),
      originSessionId: input.sessionId,
      modified: input.modified ?? new Date().toISOString(),
    },
  };
  const body = (match[2] ?? "").replace(/^\n+/, "");
  // Match Bun.YAML.stringify(stamped, null, 2): quote strings that need it.
  const yaml = formatStampYaml(stamped);
  return `---\n${yaml}---\n\n${body}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Quote when Bun.YAML would (apostrophes, leading markers, non-printables, …). */
function yamlScalar(value: unknown): string {
  if (typeof value !== "string") return String(value);
  if (
    value.length === 0 ||
    /[\n\r]|^[ \t]|[ \t]$|['"#{}[\],&*!|>%@`]|[^\x20-\x7e]/.test(value) ||
    /^(?:true|false|null|~|y|n|yes|no|on|off)$/i.test(value)
  )
    return JSON.stringify(value);
  return value;
}

function formatStampYaml(stamped: {
  name: string;
  description?: unknown;
  metadata: Record<string, unknown>;
}): string {
  const lines = [`name: ${yamlScalar(stamped.name)}`];
  if (stamped.description !== undefined)
    lines.push(`description: ${yamlScalar(stamped.description)}`);
  lines.push("metadata:");
  for (const [key, value] of Object.entries(stamped.metadata))
    lines.push(`  ${key}: ${yamlScalar(value)}`);
  return `${lines.join("\n")}\n`;
}
