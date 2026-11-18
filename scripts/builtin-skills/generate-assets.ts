/**
 * Regenerates the asset modules of the asset-backed built-in skills (dataviz,
 * verify, run, run-skill-generator, claude-api, workflow-authoring) from a
 * Claude Code 2.1.326 binary:
 *
 *   bun scripts/builtin-skills/generate-assets.ts ~/.local/share/claude/versions/2.1.326
 *
 * The bundle is only read, never executed: asset chunks are parsed for their
 * `Je("/$bunfs/root/x")` and `bt("/$bunfs/root/x.zst")` bindings and export
 * tables, and the workflow-authoring body is cut out of its template literal.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectBun } from "../inspect-bun.ts";

type Value = string | Readonly<Record<string, string>>;

const ROOT = "/$bunfs/root/";
const OUT = join(import.meta.dir, "../../src/builtin-skills");

function loadBundle(path: string): Map<string, string> {
  const buffer = readFileSync(path);
  const modules = new Map<string, string>();
  for (const module of inspectBun(buffer).modules) {
    let data: Uint8Array = buffer.subarray(
      module.source.offset,
      module.source.offset + module.source.length,
    );
    let name = module.name;
    if (name.endsWith(".zst")) {
      data = Bun.zstdDecompressSync(data);
      name = name.slice(0, -4);
    }
    modules.set(name, Buffer.from(data).toString("utf8"));
  }
  return modules;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/** Parses a JS string literal ("..." or a template without interpolation). */
function cook(raw: string): string {
  return raw.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_, escape: string) => {
      if (escape.startsWith("u{"))
        return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
      if (/^[ux][0-9a-fA-F]/.test(escape))
        return String.fromCharCode(parseInt(escape.slice(1), 16));
      const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        "0": "\0",
        "\n": "",
      };
      return simple[escape] ?? escape;
    },
  );
}

/** The export table of an asset chunk, its bindings resolved to text. */
function chunkExports(
  bundle: Map<string, string>,
  chunk: string,
): Map<string, Value> {
  const source = need(bundle.get(ROOT + chunk), chunk);
  const bindings = new Map<string, Value>();
  const paths = new Map<string, string>();
  const asset = (path: string) => need(bundle.get(path), path);
  const resolve = (expression: string): Value => {
    const call = /^\w+\((\w+)\)$/.exec(expression);
    const name = call?.[1] ?? expression;
    return need(bindings.get(name), `${chunk}: binding ${expression}`);
  };
  const declarator =
    /(?:var |,)(\w+)=(?:Je\("([^"]+)"\)|"(\/\$bunfs\/root\/[^"]+)"|bt\((\w+),import\.meta\.dirname\)|import\.meta\.require\("([^"]+)"\)|\{([^{}]*)\}|(\w+)(?=[,;]))/g;
  for (const match of source.matchAll(declarator)) {
    const [, name, text, path, decoded, required, object, alias] = match;
    if (name === undefined) continue;
    if (text !== undefined) bindings.set(name, asset(text));
    else if (path !== undefined) paths.set(name, path.replace(/\.zst$/, ""));
    else if (decoded !== undefined)
      bindings.set(name, asset(need(paths.get(decoded), decoded)));
    else if (required !== undefined) {
      const exported = chunkExports(bundle, required.slice(ROOT.length));
      bindings.set(name, need(exported.get("default"), `${required} default`));
    } else if (object !== undefined) {
      const record: Record<string, string> = {};
      const entry =
        /\.\.\.(\w+)|("(?:[^"\\]|\\.)*"|\w+):("(?:[^"\\]|\\.)*"|\w+(?:\(\w+\))?)/g;
      for (const [, spread, key, value] of object.matchAll(entry)) {
        if (spread !== undefined) {
          const inner = resolve(spread);
          if (typeof inner === "string") throw new Error(`spread ${spread}`);
          Object.assign(record, inner);
          continue;
        }
        if (key === undefined || value === undefined) continue;
        const cooked = key.startsWith('"') ? cook(key.slice(1, -1)) : key;
        const resolved = value.startsWith('"')
          ? cook(value.slice(1, -1))
          : resolve(value);
        if (typeof resolved !== "string") throw new Error(`nested ${key}`);
        record[cooked] = resolved;
      }
      bindings.set(name, record);
    } else if (alias !== undefined && bindings.has(alias))
      bindings.set(name, resolve(alias));
  }
  const exported = new Map<string, Value>();
  const table = need(/export\{([^}]*)\}/.exec(source)?.[1], `${chunk} export`);
  for (const item of table.split(",")) {
    const [local = "", as = local] = item.split(" as ");
    exported.set(as, resolve(local));
  }
  return exported;
}

function text(exports: Map<string, Value>, name: string): string {
  const value = need(exports.get(name), name);
  if (typeof value !== "string") throw new Error(`${name} is not text`);
  return value;
}

function record(
  exports: Map<string, Value>,
  name: string,
): Readonly<Record<string, string>> {
  const value = need(exports.get(name), name);
  if (typeof value === "string") throw new Error(`${name} is not a record`);
  return value;
}

/** `Ad(md).content.trimStart()`: drop a BOM and the frontmatter block. */
function skillBody(markdown: string): string {
  const document = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  const frontmatter =
    document.indexOf("---", 3) < 0
      ? null
      : /^---\s*\n([\s\S]*?)---\s*\n?/.exec(document);
  return (
    frontmatter ? document.slice(frontmatter[0].length) : markdown
  ).trimStart();
}

const HEADER = (source: string) =>
  `// generated by scripts/builtin-skills/generate-assets.ts from Claude Code 2.1.326 (${source}); do not edit\n`;

function emit(
  file: string,
  source: string,
  constants: Record<string, Value | readonly Part[]>,
): void {
  let body = HEADER(source);
  for (const [name, value] of Object.entries(constants)) {
    const type =
      typeof value === "string"
        ? ""
        : Array.isArray(value)
          ? ": readonly WorkflowAuthoringPart[]"
          : ": Readonly<Record<string, string>>";
    body += `\nexport const ${name}${type} = ${JSON.stringify(value, null, 1)};\n`;
  }
  if (body.includes("WorkflowAuthoringPart")) body += PART_TYPE;
  writeFileSync(join(OUT, file), body);
}

const PART_TYPE = `
/** Text, or text that depends on the subagent model and effort environment. */
export type WorkflowAuthoringPart =
  | string
  | { readonly unlessModelOverridden: string }
  | {
      readonly subagentEffort: {
        readonly configured: string;
        readonly unset: string;
      };
    };
`;

/** One piece of the workflow-authoring body: text, or a branch on session state. */
type Part =
  | string
  | { readonly unlessModelOverridden: string }
  | {
      readonly subagentEffort: {
        readonly configured: string;
        readonly unset: string;
      };
    };

/** Splits the template literal returned by `EEs()` into text and branch parts. */
function workflowAuthoringParts(bundle: Map<string, string>): Part[] {
  const source = need(bundle.get(`${ROOT}chunk-2emsfnec.js`), "EEs chunk");
  const start = source.indexOf("function EEs(){");
  const open = source.indexOf("return`", start) + "return".length;
  const constants: Record<string, string> = {
    l: "",
    n: "",
    i: "",
    o: "'worktree'",
    IJt: constantOf(bundle, "chunk-m33vdkhs.js", "IJt"),
    Zy: constantOf(bundle, "chunk-ghkhfhh2.js", "Zy"),
  };
  const parts: Part[] = [];
  let literal = "";
  let at = open + 1;
  for (;;) {
    const char = source[at];
    if (char === "\\") {
      literal += source.slice(at, at + 2);
      at += 2;
    } else if (char === "`") break;
    else if (char === "$" && source[at + 1] === "{") {
      parts.push(cook(literal));
      literal = "";
      const close = matchBrace(source, at + 1);
      parts.push(branch(source.slice(at + 2, close), constants));
      at = close + 1;
    } else {
      literal += char;
      at++;
    }
  }
  parts.push(cook(literal));
  const merged: Part[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (typeof part === "string" && typeof last === "string")
      merged[merged.length - 1] = last + part;
    else merged.push(part);
  }
  return merged;
}

function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let at = open; at < source.length; at++) {
    const char = source[at];
    if (char === '"') {
      at++;
      while (source[at] !== '"') at += source[at] === "\\" ? 2 : 1;
    } else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return at;
  }
  throw new Error("unbalanced template expression");
}

function branch(expression: string, constants: Record<string, string>): Part {
  const constant = constants[expression];
  if (constant !== undefined) return constant;
  const unless = /^e\?"":"((?:[^"\\]|\\.)*)"$/.exec(expression);
  if (unless?.[1] !== undefined)
    return { unlessModelOverridden: cook(unless[1]) };
  const effort = /^B5t\(\)===void 0\?"((?:[^"\\]|\\.)*)":"((?:[^"\\]|\\.)*)"$/.exec(
    expression,
  );
  if (effort?.[1] !== undefined && effort[2] !== undefined)
    return {
      subagentEffort: { unset: cook(effort[1]), configured: cook(effort[2]) },
    };
  throw new Error(`unmapped workflow-authoring interpolation: ${expression}`);
}

function constantOf(
  bundle: Map<string, string>,
  chunk: string,
  name: string,
): string {
  const source = need(bundle.get(ROOT + chunk), chunk);
  const match = new RegExp(`[,; ]${name}=("(?:[^"\\\\]|\\\\.)*"|\\d+)[,;]`).exec(
    source,
  );
  const raw = need(match?.[1], `${chunk} ${name}`);
  return raw.startsWith('"') ? cook(raw.slice(1, -1)) : raw;
}

const binary = process.argv[2];
if (!binary) {
  console.error("usage: bun scripts/builtin-skills/generate-assets.ts <claude binary>");
  process.exit(2);
}
const bundle = loadBundle(binary);

const dataviz = chunkExports(bundle, "chunk-yvvw9mhr.js");
emit("dataviz-assets.generated.ts", "chunk-yvvw9mhr.js", {
  DATAVIZ_SKILL_BODY: skillBody(text(dataviz, "SKILL_MD")),
  DATAVIZ_SKILL_FILES: record(dataviz, "SKILL_FILES"),
});

const verify = chunkExports(bundle, "chunk-t4atkcbr.js");
emit("verify-assets.generated.ts", "chunk-t4atkcbr.js", {
  VERIFY_SKILL_BODY: skillBody(text(verify, "SKILL_MD")),
  VERIFY_SKILL_FILES: record(verify, "SKILL_FILES"),
});

const run = chunkExports(bundle, "chunk-13jq9s5x.js");
emit("run-assets.generated.ts", "chunk-13jq9s5x.js", {
  RUN_SKILL_BODY: skillBody(text(run, "SKILL_MD")),
  RUN_EXAMPLE_FILES: record(run, "RUN_EXAMPLE_FILES"),
});

const generator = chunkExports(bundle, "chunk-60159h8s.js");
emit("run-skill-generator-assets.generated.ts", "chunk-60159h8s.js", {
  RUN_SKILL_GENERATOR_BODY: skillBody(text(generator, "SKILL_MD")),
  RUN_SKILL_GENERATOR_TEMPLATE: text(generator, "TEMPLATE_MD"),
});

const claudeApi = chunkExports(bundle, "chunk-z6dd9ddv.js");
emit("claude-api-assets.generated.ts", "chunk-z6dd9ddv.js", {
  CLAUDE_API_SKILL_PROMPT: text(claudeApi, "SKILL_PROMPT"),
  CLAUDE_API_MODEL_VARS: record(claudeApi, "SKILL_MODEL_VARS"),
  CLAUDE_API_SKILL_FILES: record(claudeApi, "SKILL_FILES"),
});

emit("workflow-authoring-body.generated.ts", "chunk-2emsfnec.js EEs", {
  WORKFLOW_AUTHORING_PARTS: workflowAuthoringParts(bundle),
});
