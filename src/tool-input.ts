export const UNPARSED_TOOL_INPUT = "__unparsedToolInput";

/** Malformed arguments remain a tool result rather than restarting the whole model response. */
export function unparsedToolInput(
  value: unknown,
): { raw: string; len: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== UNPARSED_TOOL_INPUT) return;
  const data: unknown = entries[0][1];
  if (
    !data ||
    typeof data !== "object" ||
    !("raw" in data) ||
    !("len" in data) ||
    typeof data.raw !== "string" ||
    typeof data.len !== "number"
  )
    return;
  return { raw: data.raw, len: data.len };
}

function stripProtoKeys(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const seen = new Map<object, unknown>();
  const work: Array<() => void> = [];
  const isArray = (source: object): source is readonly unknown[] =>
    Array.isArray(source);
  const copy = (source: unknown): unknown => {
    if (!source || typeof source !== "object") return source;
    if (seen.has(source)) return seen.get(source);
    if (isArray(source)) {
      const target: unknown[] = [];
      seen.set(source, target);
      work.push(() => {
        for (const entry of source) target.push(copy(entry));
      });
      return target;
    }
    const target: Record<string, unknown> = {};
    seen.set(source, target);
    work.push(() => {
      const entries: [string, unknown][] = Object.entries(source);
      for (const [key, entry] of entries)
        if (key !== "__proto__") Reflect.set(target, key, copy(entry));
    });
    return target;
  };
  const result: unknown = copy(value);
  for (let item = work.pop(); item; item = work.pop()) item();
  return result;
}

export function normalizeToolInput(value: unknown): unknown {
  if (typeof value !== "string" && (!value || typeof value !== "object"))
    throw new Error("Tool use input must be a string or object");
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value === "") parsed = {};
    else {
      try {
        parsed =
          JSON.parse(value.startsWith("\uFEFF") ? value.slice(1) : value) ?? {};
      } catch {
        let raw = value.slice(0, 2048);
        const last = raw.charCodeAt(raw.length - 1);
        if (raw.length < value.length && last >= 0xd800 && last <= 0xdbff)
          raw = raw.slice(0, -1);
        parsed = { [UNPARSED_TOOL_INPUT]: { raw, len: value.length } };
      }
    }
  }
  return stripProtoKeys(parsed);
}

export function normalizeToolName(name: string): string {
  return [...name].slice(0, 200).join("");
}
