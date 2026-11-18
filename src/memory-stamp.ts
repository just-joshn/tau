/** Provenance stamp the original applies when Write creates an auto-memory .md file. */

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
    parsed = Bun.YAML.parse(match[1] ?? "");
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
  // Source YDe: Bun.YAML.stringify plus a trailing newline before the closer.
  const yaml = Bun.YAML.stringify(stamped, null, 2);
  return `---\n${yaml.endsWith("\n") ? yaml : `${yaml}\n`}---\n\n${body}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
