import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const TIERS = new Set([
  "unit",
  "contract",
  "security",
  "integration",
  "property",
  "faults",
  "helpers",
]);
const root = resolve(import.meta.dir, "..");
const testRoot = join(root, "test");

const [tier, ...files] = process.argv.slice(2);
if (tier === undefined || !TIERS.has(tier) || files.length === 0) {
  console.error(
    `usage: bun scripts/move-test.ts <${[...TIERS].join("|")}> <test-file>...`,
  );
  process.exit(2);
}

const stem = (path: string) =>
  path.slice(0, path.length - extname(path).length);
const posix = (path: string) => path.split("\\").join("/");

const relocations = files.flatMap((file) => {
  const from = resolve(root, file);
  const to = join(testRoot, tier, basename(from));
  if (from === to || (!existsSync(from) && existsSync(to))) return [];
  if (!existsSync(from)) throw new Error(`No such test file: ${file}`);
  return [{ from, to }];
});
// Keyed by extensionless absolute path, because `./x.js` names `x.ts`.
const moves = new Map(
  relocations.map(({ from, to }) => [stem(from), stem(to)]),
);
const moved = (path: string) => {
  const target = moves.get(stem(path));
  return target === undefined ? path : target + extname(path);
};

function exists(path: string): boolean {
  return (
    existsSync(path) || (path.endsWith(".js") && existsSync(`${stem(path)}.ts`))
  );
}

function rewriteSpecifier(specifier: string, from: string, to: string): string {
  let target = resolve(dirname(from), specifier);
  if (!exists(target)) {
    const helper = join(testRoot, "helpers", basename(target));
    if (from === to || !exists(helper)) return specifier;
    target = helper;
  }
  const next = posix(relative(dirname(to), moved(target)));
  return next.startsWith(".") ? next : `./${next}`;
}

const SPECIFIERS = [
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"'\n]*)\2/g,
  /(\bnew URL\(\s*)(["'])(\.\.?\/[^"'\n]*)\2(?=\s*,\s*import\.meta\.url)/g,
];

function rewriteModule(source: string, from: string, to: string): string {
  return SPECIFIERS.reduce(
    (text, pattern) =>
      text.replace(
        pattern,
        (_match, lead: string, quote: string, specifier: string) =>
          `${lead}${quote}${rewriteSpecifier(specifier, from, to)}${quote}`,
      ),
    source,
  );
}

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

const modules = [testRoot, join(root, "scripts")].flatMap((dir) =>
  walk(dir, (path) => path.endsWith(".ts")),
);
const edits = modules.flatMap((from) => {
  const to = moved(from);
  const source = readFileSync(from, "utf8");
  const next = rewriteModule(source, from, to);
  return from === to && next === source ? [] : [{ from, to, next }];
});

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const references = relocations.map(({ from, to }) => ({
  pattern: new RegExp(
    `(?<![\\w.-]|[\\w-]/)${escape(posix(relative(root, from)))}(?![\\w.-])`,
    "g",
  ),
  next: posix(relative(root, to)),
}));
const documents = [
  join(root, "bunfig.toml"),
  ...readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(root, name)),
  ...walk(
    join(root, "docs"),
    (path) =>
      path.endsWith(".md") && !path.startsWith(join(root, "docs", "archive")),
  ),
].flatMap((path) => {
  const source = readFileSync(path, "utf8");
  const next = references.reduce(
    (text, { pattern, next }) => text.replace(pattern, next),
    source,
  );
  return next === source ? [] : [{ from: path, to: path, next }];
});

for (const { from, to, next } of [...edits, ...documents]) {
  if (from !== to) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  writeFileSync(to, next);
  console.log(
    from === to
      ? `rewrote ${relative(root, to)}`
      : `moved ${relative(root, from)} -> ${relative(root, to)}`,
  );
}
const touched = [...edits, ...documents].map(({ to }) => to);
if (touched.length > 0)
  Bun.spawnSync([process.execPath, "fmt", ...touched], { stdout: "ignore" });
