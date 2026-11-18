/**
 * Regenerates the plugin-authoring skill text and files and the built-in agent prompts
 * from a Claude Code 2.1.326 binary. Reads module sources and embedded assets only;
 * never imports or executes them. Template literals are decoded and their `${...}`
 * holes resolved by a small evaluator over the minified source.
 *
 *   bun scripts/builtin-skills/plugin-agents.ts ~/.local/share/claude/versions/2.1.326
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectBun } from "../inspect-bun.ts";

type Value = string | boolean;
type Env = Readonly<Record<string, Value>>;

const binaryPath = process.argv[2];
if (!binaryPath)
  throw new Error("usage: plugin-agents.ts <claude-code-2.1.326 binary>");
const binary = readFileSync(binaryPath);
const modules = new Map(
  inspectBun(binary).modules.map((module) => [
    module.name.replace("/$bunfs/root/", ""),
    module,
  ]),
);

function asset(name: string): string {
  const module = modules.get(name);
  if (!module) throw new Error(`missing module ${name}`);
  const data = binary.subarray(
    module.source.offset,
    module.source.offset + module.source.length,
  );
  return name.endsWith(".zst")
    ? Buffer.from(Bun.zstdDecompressSync(data)).toString("utf8")
    : data.toString("utf8");
}

function uniqueIndex(source: string, anchor: string): number {
  const at = source.indexOf(anchor);
  if (at < 0 || source.indexOf(anchor, at + 1) >= 0)
    throw new Error(`anchor not unique: ${anchor}`);
  return at + anchor.length;
}

/** A string-valued `var name="..."` in a module, read without running it. */
function stringVar(module: string, name: string): string {
  const source = asset(module);
  const match = new RegExp(`[;,{ ]${name.replace("$", "\\$")}="`).exec(source);
  if (!match) throw new Error(`no string ${name} in ${module}`);
  const parser = new Parser(source, match.index + match[0].length - 1, {});
  const value = parser.primary();
  if (typeof value !== "string") throw new Error(`${name} is not a string`);
  return value;
}

/** Evaluates the subset of minified JS the prompt builders use. */
class Parser {
  constructor(
    readonly source: string,
    public at: number,
    readonly env: Env,
  ) {}

  private peek(text: string): boolean {
    return this.source.startsWith(text, this.at);
  }

  expect(text: string): void {
    if (!this.peek(text))
      throw new Error(
        `expected ${text} at ${this.source.slice(this.at, this.at + 40)}`,
      );
    this.at += text.length;
  }

  expression(): Value {
    const test = this.or();
    if (!this.peek("?")) return test;
    this.at++;
    const yes = this.expression();
    this.expect(":");
    const no = this.expression();
    return test ? yes : no;
  }

  private or(): Value {
    let value = this.and();
    while (this.peek("||")) {
      this.at += 2;
      const right = this.and();
      value = value || right;
    }
    return value;
  }

  private and(): Value {
    let value = this.unary();
    while (this.peek("&&")) {
      this.at += 2;
      const right = this.unary();
      value = value && right;
    }
    return value;
  }

  private unary(): Value {
    if (this.peek("!")) {
      this.at++;
      return !this.unary();
    }
    return this.primary();
  }

  primary(): Value {
    const char = this.source[this.at];
    if (char === "`") return this.template();
    if (char === '"' || char === "'") return this.quoted(char);
    if (char === "(") {
      this.at++;
      const value = this.expression();
      this.expect(")");
      return value;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.at))?.[0];
    if (!name)
      throw new Error(`unexpected ${this.source.slice(this.at, this.at + 40)}`);
    this.at += name.length;
    const key = this.peek("()") ? `${name}()` : name;
    if (key.endsWith("()")) this.at += 2;
    const value = this.env[key];
    if (value === undefined) throw new Error(`unresolved ${key}`);
    return value;
  }

  private escape(): string {
    const char = this.source[this.at++];
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      case "x": {
        const hex = this.source.slice(this.at, this.at + 2);
        this.at += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case "u": {
        if (this.peek("{")) {
          const end = this.source.indexOf("}", this.at);
          const code = parseInt(this.source.slice(this.at + 1, end), 16);
          this.at = end + 1;
          return String.fromCodePoint(code);
        }
        const hex = this.source.slice(this.at, this.at + 4);
        this.at += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case "\n":
        return "";
      default:
        if (char === undefined) throw new Error("unterminated escape");
        return char;
    }
  }

  private quoted(quote: string): string {
    this.at++;
    let text = "";
    for (;;) {
      const char = this.source[this.at++];
      if (char === undefined) throw new Error("unterminated string");
      if (char === quote) return text;
      text += char === "\\" ? this.escape() : char;
    }
  }

  private template(): string {
    this.at++;
    let text = "";
    for (;;) {
      const char = this.source[this.at++];
      if (char === undefined) throw new Error("unterminated template");
      if (char === "`") return text;
      if (char === "\\") text += this.escape();
      else if (char === "$" && this.peek("{")) {
        this.at++;
        text += String(this.expression());
        this.expect("}");
      } else text += char;
    }
  }
}

/** `let a=...,b=...;return <expr>` after `anchor`, or a bare expression. */
function evaluate(module: string, anchor: string, env: Env): string {
  const source = asset(module);
  const scope: Record<string, Value> = { ...env };
  const local = new Parser(source, uniqueIndex(source, anchor), scope);
  if (source.startsWith("let ", local.at)) {
    local.at += 4;
    for (;;) {
      const name = /^[A-Za-z_$][\w$]*/.exec(source.slice(local.at))?.[0];
      if (!name) throw new Error("bad declaration");
      local.at += name.length;
      local.expect("=");
      scope[name] = local.expression();
      if (source[local.at] === ",") local.at++;
      else break;
    }
    local.expect(";return");
  }
  const value = local.expression();
  if (typeof value !== "string") throw new Error(`${anchor} is not a string`);
  return value;
}

const AGENTS = "chunk-4h798pp0.js";
const tools: Env = {
  ft: stringVar("chunk-sqaj3a6n.js", "ft"),
  Ce: stringVar("chunk-2meycm1g.js", "Ce"),
  pt: stringVar("chunk-4yvqjdc7.js", "pt"),
  wo: stringVar("chunk-d73xe1mr.js", "wo"),
  Lr: stringVar("chunk-d73xe1mr.js", "Lr"),
  We: stringVar("chunk-bavekdyg.js", "We"),
};

// Jd(): the shell tool is Bash (every non-Windows host). RI(): Bash carries find/grep.
const readOnlyAgent = (anchor: string, embeddedSearch: boolean) =>
  evaluate(AGENTS, anchor, {
    ...tools,
    "Jd()": true,
    "RI()": embeddedSearch,
  });

const agentPrompts = {
  GENERAL_PURPOSE_PROMPT: evaluate(AGENTS, "function Qds(){return", {}),
  // Jds() is the Windows Git Bash path note; empty on every other platform.
  STATUSLINE_SETUP_PROMPT: evaluate(AGENTS, "var Zds=()=>", { "Jds()": "" }),
  CLAUDE_AGENT_PROMPT: evaluate("chunk-cqwkdc0e.js", "var e=", tools),
  EXPLORE_PROMPT: readOnlyAgent("function SQo(){", false),
  EXPLORE_PROMPT_SHELL_SEARCH: readOnlyAgent("function SQo(){", true),
  PLAN_PROMPT: readOnlyAgent("function RQo(){", false),
  PLAN_PROMPT_SHELL_SEARCH: readOnlyAgent("function RQo(){", true),
};

const PLUGIN = "chunk-p6p1sx09.js";
const surfaceEnv: Env = {
  L$n: stringVar("chunk-9vv3cg4s.js", "L$n"),
};
const surface = (name: string) => evaluate(PLUGIN, `var ${name}=`, surfaceEnv);
const missingNote = evaluate(PLUGIN, "var on=(e)=>", { e: "\u0000" }).split(
  "\u0000",
);
if (missingNote.length !== 2) throw new Error("note has one hole");

const pluginSource = asset(PLUGIN);
const version = /VERSION:"([^"]+)"/.exec(pluginSource)?.[1];
if (!version) throw new Error("no VERSION");
const coreDeclarations = asset("claude-code.d.ts-5ffe4987.txt.zst");
const declarationsChunk = asset("chunk-cs4xe5xd.js");
if (
  !declarationsChunk.includes(
    "return`// Written by Claude Code ${D}.\n${Aks}\n`",
  )
)
  throw new Error("coreDeclarationsOf changed");

// Tzs(builtinToolSchemasOf(tools)) with no tools: tau has no tool list here.
const toolSection = (lines: string[], name: string) => [
  ...lines,
  "declare module 'claude-code' {",
  `  interface ${name} {`,
  "  }",
  "}",
];
const inputComment = [
  "// The inputs of the built-in tools this build has, from each tool's",
  "// input schema. Merges into ToolCallInput (BuiltinToolInputs) so",
  '// `e.tool === "Bash"` narrows to the tool\'s arguments.',
];
const resultComment = [
  "// The structured results of the same tools, from each tool's output",
  "// schema. Merges into ToolCallResult (BuiltinToolResults) so after",
  '// `e.tool === "Bash"` the `result` of `next(e)` is the tool\'s record.',
];
const toolSchemaSource = asset("chunk-wxs36rx3.js");
for (const line of [...inputComment, ...resultComment])
  if (
    !toolSchemaSource.includes(JSON.stringify(line).slice(1, -1)) &&
    !toolSchemaSource.includes(line.replaceAll("'", "\\'"))
  )
    throw new Error(`Tzs line changed: ${line}`);
const toolDeclarations = [
  ...toolSection(inputComment, "BuiltinToolInputs"),
  "",
  ...toolSection(resultComment, "BuiltinToolResults"),
  "",
].join("\n");

const skillMd = asset("SKILL-de696a17.md.zst");
const frontmatter = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(skillMd);
if (!frontmatter) throw new Error("SKILL.md has no frontmatter");

const files: Record<string, string> = {
  "types/claude-code.d.ts": `// Written by Claude Code ${version}.\n${coreDeclarations}\n${toolDeclarations}`,
  "examples/pane.tsx": asset("pane.tsx-mhv389ra.txt"),
  "examples/pane-state.d.ts": asset("pane-state.d.ts-11bz0njc.txt"),
  "examples/pane.test.tsx": asset("pane.test.tsx-r4m5tq17.txt"),
  "examples/band.tsx": asset("band.tsx-1v7nt0yx.txt"),
  "examples/band-state.d.ts": asset("band-state.d.ts-jt01vrsc.txt"),
  "examples/menu.tsx": asset("menu.tsx-yp1d8e7c.txt"),
  "examples/menu.test.tsx": asset("menu.test.tsx-5cr73ger.txt"),
  "examples/tool-call.ts": asset("tool-call.ts-tv29hdsd.txt"),
  "reference.md": asset("reference-887680e4.md.zst"),
  "look.md": asset("look-2075600c.md.zst"),
  "examples/look.ts": asset("look.ts-11v2wyw3.txt"),
  "make-colors.js": asset("make-colors.js-79adc940.txt.zst"),
  "make-colors.d.ts": asset("make-colors.d.ts-af29va7k.txt"),
};

const header = (script: string) =>
  `// generated by scripts/builtin-skills/${script}; do not edit\n`;
const constants = (values: Record<string, string>) =>
  Object.entries(values)
    .map(
      ([name, value]) => `export const ${name} = ${JSON.stringify(value)};\n`,
    )
    .join("");

const root = join(import.meta.dir, "../..");
const outputs = [
  "src/builtin-agent-prompts.ts",
  "src/builtin-skills/plugin-authoring-text.ts",
  "src/builtin-skills/plugin-authoring-files.ts",
].map((path) => join(root, path));
writeFileSync(
  join(root, "src/builtin-agent-prompts.ts"),
  header("plugin-agents.ts") + constants(agentPrompts),
);
writeFileSync(
  join(root, "src/builtin-skills/plugin-authoring-text.ts"),
  header("plugin-agents.ts") +
    constants({
      SKILL_DESCRIPTION: evaluate(PLUGIN, "var Qe=", {}),
      MENU_DESCRIPTION: evaluate(PLUGIN, "menuDescription:", {}),
      SKILL_BODY: skillMd.slice(frontmatter[0].length),
      CLOUD_SURFACE: surface("V"),
      EXISTING_REMOTES_ONLY: surface("He"),
      HOSTED_SURFACE: surface("Ue"),
      TERMINAL_SURFACE: surface("Ze"),
      FILES_MISSING_BEFORE: missingNote[0] ?? "",
      FILES_MISSING_AFTER: missingNote[1] ?? "",
    }),
);
writeFileSync(
  join(root, "src/builtin-skills/plugin-authoring-files.ts"),
  header("plugin-agents.ts") +
    `export const PLUGIN_AUTHORING_FILES: Readonly<Record<string, string>> = ${JSON.stringify(files, null, 2)};\n`,
);
const formatted = Bun.spawnSync(["bun", "fmt", ...outputs], { cwd: root });
if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
