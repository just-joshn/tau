import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * The normalized projection of scripts/differential/compare_sdk_io.py, over
 * the same field list, so a tau capture compares with the committed
 * projections of the original's oracle captures.
 */
const FIELDS = z
  .object({ fields: z.record(z.string(), z.array(z.string())) })
  .parse(
    JSON.parse(
      readFileSync(
        resolve(
          import.meta.dir,
          "../../scripts/differential/sdk_io_fields.json",
        ),
        "utf8",
      ),
    ),
  ).fields;
const ABSENT = "<absent>";

const message = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  cwd: z.string().optional(),
});
type Message = z.infer<typeof message>;

export function sdkMessages(stdout: string): Message[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line): unknown[] => {
      const value: unknown = JSON.parse(line);
      return Array.isArray(value) ? value : [value];
    })
    .map((value) => message.parse(value));
}

const kind = (row: Message) =>
  row.type === "system" ? `system/${row.subtype}` : row.type;

function normalize(rows: Message[]): unknown[] {
  const sessions = new Map<string, string>();
  const cwds: string[] = [];
  for (const row of rows) {
    if (row.session_id && !sessions.has(row.session_id))
      sessions.set(row.session_id, `<session-${sessions.size}>`);
    if (kind(row) === "system/init" && row.cwd) cwds.push(row.cwd);
  }
  const unprefixed = cwds
    .filter((cwd) => cwd.startsWith("/private/"))
    .map((cwd) => cwd.slice("/private".length));
  const ordered = [...new Set([...cwds, ...unprefixed])].toSorted(
    (a, b) => b.length - a.length,
  );
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const session = sessions.get(value);
      if (session) return session;
      return ordered.reduce(
        (text, cwd) => text.replaceAll(cwd, "<cwd>"),
        value,
      );
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item)]),
      );
    return value;
  };
  return rows.map(walk);
}

function select(value: unknown, path: string): unknown {
  const dot = path.indexOf(".");
  const head = dot === -1 ? path : path.slice(0, dot);
  const rest = dot === -1 ? "" : path.slice(dot + 1);
  const field = (name: string): unknown =>
    typeof value === "object" && value !== null && Object.hasOwn(value, name)
      ? Reflect.get(value, name)
      : ABSENT;
  if (head.endsWith("[]")) {
    const items = field(head.slice(0, -2));
    if (!Array.isArray(items)) return ABSENT;
    return items.map((item: unknown) => (rest ? select(item, rest) : item));
  }
  const item = field(head);
  return rest && item !== ABSENT ? select(item, rest) : item;
}

export function projectSdk(stdout: string): Record<string, unknown>[] {
  const rows = sdkMessages(stdout);
  return normalize(rows).map((row, index) => {
    const name = kind(rows[index] ?? { type: "" });
    return {
      kind: name,
      ...Object.fromEntries(
        (FIELDS[name] ?? []).map((path) => [path, select(row, path)]),
      ),
    };
  });
}

export function originalProjection(name: string): unknown {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dir, `../fixtures/sdk-io/original-${name}.json`),
      "utf8",
    ),
  );
}
