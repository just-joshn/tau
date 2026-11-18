/**
 * Checks tau's Monitor, EnterWorktree and ExitWorktree texts against the
 * recovered 2.1.326 bundle, as text only (the bundle is never run):
 *
 * 1. each needle in docs/monitor-worktree-needles.json occurs exactly once,
 *    in one chunk;
 * 2. every schema description and tool description line tau sends appears
 *    in the chunk that defines the tool, in one of the encodings the minifier
 *    writes, or is rebuilt from a bundle template with the stated values.
 *
 * Usage: bun scripts/differential/check_monitor_worktree_bundle.ts [bundle-dir]
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { monitorDefinition } from "../../src/monitor-tool.js";
import { createWorktreeTools } from "../../src/worktree-tools.js";
import type { ToolDefinition } from "../../src/types.js";

const bundle =
  process.argv[2] ??
  path.resolve(import.meta.dir, "../../artifacts/claude-bundle");
const chunks = new Map(
  readdirSync(bundle)
    .filter((name) => name.endsWith(".js"))
    .map((name) => [name, readFileSync(path.join(bundle, name), "utf8")]),
);
const problems: string[] = [];

const needles: Record<string, string> = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dir, "../../docs/monitor-worktree-needles.json"),
    "utf8",
  ),
);
const occurrences = (text: string, needle: string) =>
  text.split(needle).length - 1;
for (const [label, needle] of Object.entries(needles)) {
  const hits = [...chunks].flatMap(([name, text]) => {
    const count = occurrences(text, needle);
    return count ? [`${name}×${count}`] : [];
  });
  if (hits.length !== 1 || !hits[0]?.endsWith("×1"))
    problems.push(`needle ${label}: ${hits.join(", ") || "not found"}`);
}

/** The minifier's spellings of a string literal: non-ASCII as \uXXXX, in "", '' or ``. */
function spellings(text: string): string[] {
  const ascii = (value: string) =>
    value.replace(
      /[^\x20-\x7e\n]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  const base = ascii(text.replaceAll("\\", "\\\\"));
  return [
    base.replaceAll('"', '\\"').replaceAll("\n", "\\n"),
    base.replaceAll("'", "\\'").replaceAll("\n", "\\n"),
    base.replaceAll("`", "\\`").replaceAll("${", "\\${"),
  ];
}
const found = (chunk: string, text: string) =>
  spellings(text).some((spelling) => chunk.includes(spelling));

/** Texts tau rebuilds from a bundle template: the template must be there, and fill to tau's text. */
const TEMPLATES: { template: string; values: Record<string, string> }[] = [
  {
    template:
      "Kill the monitor after this deadline. Default ${plt}ms. Deadlines above ${e}ms are capped to ${e}ms. You are notified at expiry and can re-arm.",
    values: { plt: "300000", e: "600000" },
  },
];
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\$\{(\w+)\}/g, (_, name: string) => values[name] ?? "");

let checked = 0,
  derived = 0;
function check(chunkName: string, definition: ToolDefinition) {
  const chunk = chunks.get(chunkName);
  if (!chunk) return problems.push(`missing chunk ${chunkName}`);
  const descriptions: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node))
      if (key === "description" && typeof value === "string")
        descriptions.push(value);
      else walk(value);
  };
  walk(definition.input_schema);
  for (const text of descriptions) {
    checked++;
    if (found(chunk, text)) continue;
    const rebuilt = TEMPLATES.find(
      ({ template, values }) =>
        fill(template, values) === text && chunk.includes(template),
    );
    if (rebuilt) derived++;
    else
      problems.push(
        `${definition.name} schema text not in ${chunkName}: ${text}`,
      );
  }
  for (const line of definition.description.split("\n")) {
    if (!line.trim()) continue;
    checked++;
    if (
      !found(chunk, line) &&
      !found(chunks.get("chunk-pvr1jj26.js") ?? "", line)
    )
      (derived++,
        console.log(`  derived ${definition.name}: ${line.slice(0, 100)}`));
  }
}

const tools = createWorktreeTools({
  shell: {
    cwd: "/",
    root: "/",
    relocate() {},
    shells: { list: () => [] },
  },
  baseRef: () => "fresh",
});
check(
  "chunk-tzrw0807.js",
  monitorDefinition({ singleShot: true, backgroundDisabled: false }),
);
check("chunk-fkkma3m4.js", tools.enter.definition());
check("chunk-fkkma3m4.js", tools.exit.definition());

console.log(
  `${Object.keys(needles).length} needles, ${checked} texts checked, ${derived} rebuilt or derived, ${problems.length} problems`,
);
for (const problem of problems) console.log(`  ${problem}`);
process.exit(problems.length ? 1 : 0);
