/**
 * Checks tau's CronCreate, CronDelete, CronList, and SendMessage texts
 * against the recovered 2.1.326 bundle, as text only (the bundle is never run):
 *
 * 1. each needle in docs/cron-sendmessage-needles.json occurs exactly once,
 *    in one chunk;
 * 2. every schema description tau sends appears in the tool's schema chunk,
 *    in one of the encodings the minifier writes, or is rebuilt from a bundle
 *    template with the stated values.
 *
 * Tool description lines that are interpolations are logged as derived.
 *
 * Usage: bun scripts/differential/check_cron_sendmessage_bundle.ts [bundle-dir]
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createCronTools } from "../../src/cron-tools.js";
import { sendMessageTool } from "../../src/send-message.js";
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

const needleText: unknown = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dir, "../../docs/cron-sendmessage-needles.json"),
    "utf8",
  ),
);
const needles = z.record(z.string(), z.string()).parse(needleText);
const occurrences = (text: string, needle: string) =>
  text.split(needle).length - 1;
for (const [label, needle] of Object.entries(needles)) {
  const hits = [...chunks].flatMap(([name, text]) => {
    const count = occurrences(text, needle);
    return count ? [`${name}\u00d7${count}`] : [];
  });
  if (hits.length !== 1 || !hits[0]?.endsWith("\u00d71"))
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

const TEMPLATES: { source: string; values: Record<string, string> }[] = [
  {
    source:
      'true (default) = fire on every cron match until deleted or auto-expired after ${kje} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
    values: { kje: "7" },
  },
  {
    source:
      'Recipient: a name from ${Of} (append its " [ref]" only when a listing or an error shows one), a teammate name, "main", or a background agent\'s agentId',
    values: { Of: "ListAgents" },
  },
  {
    source:
      "A 5-10 word label for your own transcript row (not transmitted \\u2014 the recipient previews the first line of \\`message\\`). Truncated to ${WXt} characters rather than rejected.",
    values: { WXt: "200" },
  },
];
const JOINS: readonly (readonly string[])[] = [
  [
    "Plain text message content. The recipient's human sees only the FIRST LINE as a one-line preview until they expand it, so make the first line a ",
    "clear, self-contained sentence saying what this is about \u2014 not a greeting, ",
    "preamble, or bare @-mention.",
  ],
];
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\$\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
const decode = (value: string) =>
  value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\`/g, "`");

let checked = 0,
  derived = 0;
function check(
  schemaChunks: readonly string[],
  descriptionChunks: readonly string[],
  definition: ToolDefinition,
) {
  const schema = schemaChunks.flatMap((name) => {
    const text = chunks.get(name);
    return text === undefined ? [] : [text];
  });
  if (schema.length !== schemaChunks.length)
    return problems.push(`missing chunk ${schemaChunks.join(", ")}`);
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
    if (schema.some((chunk) => found(chunk, text))) continue;
    const rebuilt = TEMPLATES.find(
      ({ source, values }) =>
        decode(fill(source, values)) === text &&
        schema.some((chunk) => chunk.includes(source)),
    );
    const joined = JOINS.find(
      (parts) =>
        parts.join("") === text &&
        parts.every((part) => schema.some((chunk) => found(chunk, part))),
    );
    if (rebuilt || joined) derived++;
    else
      problems.push(
        `${definition.name} schema text not in ${schemaChunks.join(", ")}: ${text}`,
      );
  }
  const prose = descriptionChunks.flatMap((name) => {
    const text = chunks.get(name);
    return text === undefined ? [] : [text];
  });
  for (const line of definition.description.split("\n")) {
    if (!line.trim()) continue;
    checked++;
    if (!prose.some((chunk) => found(chunk, line)))
      (derived++,
        console.log(`  derived ${definition.name}: ${line.slice(0, 100)}`));
  }
}

const cron = createCronTools({
  projectDir: () => "/",
  sessionId: () => "s",
  procStart: "2026-11-18T00:00:00.000Z",
});
const send = sendMessageTool({
  caller: () => ({ kind: "main" }),
  agents: () => [],
  deliverToMain() {},
  deliverToAgent: () => false,
});
check(
  ["chunk-b7zts8xt.js", "chunk-223am0ab.js"],
  ["chunk-b7zts8xt.js", "chunk-223am0ab.js"],
  cron.create.definition(),
);
check(
  ["chunk-c93dfh89.js"],
  ["chunk-c93dfh89.js", "chunk-223am0ab.js"],
  cron.remove.definition(),
);
check(
  ["chunk-8a6symse.js"],
  ["chunk-8a6symse.js", "chunk-223am0ab.js"],
  cron.list.definition(),
);
check(["chunk-z74wfcch.js"], ["chunk-z74wfcch.js"], send.definition());

console.log(
  `${Object.keys(needles).length} needles, ${checked} texts checked, ${derived} rebuilt or derived, ${problems.length} problems`,
);
for (const problem of problems) console.log(`  ${problem}`);
process.exit(problems.length ? 1 : 0);
