import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoMemoryIndexOption,
  autoMemoryPrompt,
  autoMemoryReadAllowed,
  autoMemoryWriteAllowed,
  resolveAutoMemoryStore,
  sanitizeAutoMemoryIndex,
  truncateAutoMemoryIndex,
  type AutoMemoryFacts,
} from "../../src/auto-memory.js";
import { createInstructionCatalog } from "../../src/instructions.js";

const facts = (overrides: Partial<AutoMemoryFacts> = {}): AutoMemoryFacts => ({
  enabled: true,
  env: {},
  configDirectory: "/home/u/.claude",
  home: "/home/u",
  cwd: "/work/app",
  canonicalGitRoot: null,
  settings: {},
  projectSettingsAdmitted: true,
  ...overrides,
});
const folder = (overrides: Partial<AutoMemoryFacts> = {}) =>
  resolveAutoMemoryStore(facts(overrides)).directory;

test("the folder is keyed by the canonical git root, else the cwd, under the config home", () => {
  assert.equal(folder(), "/home/u/.claude/projects/-work-app/memory/");
  assert.equal(
    folder({ cwd: "/work/app/sub", canonicalGitRoot: "/work/app" }),
    "/home/u/.claude/projects/-work-app/memory/",
  );
  const linked = resolveAutoMemoryStore(
    facts({ cwd: "/work/tree", canonicalGitRoot: "/work/app" }),
  );
  assert.equal(
    linked.ownProjectDirectory,
    "/home/u/.claude/projects/-work-tree/memory/",
  );
  assert.equal(
    folder({ env: { CLAUDE_CODE_REMOTE_MEMORY_DIR: "/remote" } }),
    "/remote/projects/-work-app/memory/",
  );
  assert.equal(
    folder({
      env: {
        CLAUDE_CONFIG_DIR: "/home/u/.claude",
        CLAUDE_CODE_PROJECT_DIR_NAME: "named",
      },
    }),
    "/home/u/.claude/projects/named/memory/",
  );
  assert.equal(
    folder({ env: { CLAUDE_CODE_PROJECT_DIR_NAME: "named" } }),
    "/home/u/.claude/projects/-work-app/memory/",
  );
});

test("a cowork override beats settings, and settings follow source order and trust", () => {
  const settings = {
    userSettings: "~/notes",
    projectSettings: "/project-pick",
    policySettings: undefined,
  };
  assert.equal(folder({ settings }), "/project-pick/");
  assert.equal(
    folder({ settings, projectSettingsAdmitted: false }),
    "/home/u/notes/",
  );
  assert.equal(
    folder({
      settings,
      env: { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "/override//" },
    }),
    "/override/",
  );
  for (const invalid of ["relative", "~/..", "~/", "/a"])
    assert.equal(
      folder({ settings: { userSettings: invalid } }),
      "/home/u/.claude/projects/-work-app/memory/",
      invalid,
    );
  const store = resolveAutoMemoryStore(facts({ settings }));
  assert.equal(store.ownProjectDirectory, null);
});

test("writes need Markdown inside the folder and no cowork override; reads need no remote surface", () => {
  const store = resolveAutoMemoryStore(facts());
  const inside = `${store.directory}user_role.md`;
  assert.equal(autoMemoryWriteAllowed(store, inside), true);
  assert.equal(autoMemoryWriteAllowed(store, `${store.directory}a.txt`), false);
  assert.equal(
    autoMemoryWriteAllowed(store, `${store.directory}.git/hooks/x.md`),
    false,
  );
  assert.equal(
    autoMemoryWriteAllowed(store, `${store.directory}../escape.md`),
    false,
  );
  assert.equal(autoMemoryReadAllowed(store, `${store.directory}a.txt`), true);
  // Source Tme ignores the enable gate; only the own-project folder needs it.
  assert.equal(
    autoMemoryWriteAllowed({ ...store, enabled: false }, inside),
    true,
  );
  const overridden = resolveAutoMemoryStore(
    facts({ env: { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "/override" } }),
  );
  assert.equal(autoMemoryWriteAllowed(overridden, "/override/a.md"), false);
  assert.equal(autoMemoryReadAllowed(overridden, "/override/a.md"), true);
  const remote = resolveAutoMemoryStore(
    facts({ env: { CLAUDE_CODE_REMOTE: "1" } }),
  );
  assert.equal(autoMemoryReadAllowed(remote, inside), false);
});

test("the prompt section follows the gate and the cowork guideline variables", () => {
  const store = resolveAutoMemoryStore(facts());
  assert.equal(autoMemoryPrompt({ ...store, enabled: false }, {}), null);
  assert.equal(autoMemoryPrompt(undefined, {}), null);
  const full = autoMemoryPrompt(store, {}) ?? "";
  assert.ok(
    full.startsWith(
      `# auto memory\n\nYou have a persistent, file-based memory system at \`${store.directory}\`. This directory already exists`,
    ),
  );
  assert.ok(full.endsWith("useful in future conversations.\n\n"));
  assert.ok(
    (
      autoMemoryPrompt(store, {
        CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES: "EXTRA",
      }) ?? ""
    ).endsWith("useful in future conversations.\n\nEXTRA\n"),
  );
  assert.equal(
    autoMemoryPrompt(store, { CLAUDE_COWORK_MEMORY_GUIDELINES: "OWN" }),
    "# auto memory\nOWN",
  );
});

test("the index keeps 200 lines or 25,000 units and says what it cut", () => {
  assert.equal(truncateAutoMemoryIndex("  a\nb  \n"), "a\nb");
  const lines = Array.from({ length: 205 }, (_, i) => `- line ${i + 1}`);
  assert.equal(
    truncateAutoMemoryIndex(lines.join("\n")),
    `${lines.slice(0, 200).join("\n")}\n\n> WARNING: MEMORY.md is 205 lines (limit: 200). Only part of it was loaded: 5 of 205 lines were cut off, starting at line 201 ("- line 201"). Keep index entries to one line under ~200 chars; move detail into topic files.`,
  );
  const long = `${"x".repeat(24_990)}\n${"y".repeat(100)}`;
  assert.equal(
    truncateAutoMemoryIndex(long),
    `${"x".repeat(24_990)}\n\n> WARNING: MEMORY.md is 24.5KB (limit: 24.4KB) \u2014 index entries are too long. Only part of it was loaded: 1 of 2 lines were cut off, starting at line 2 ("${"y".repeat(79)}\u2026"). Keep index entries to one line under ~200 chars; move detail into topic files.`,
  );
  assert.match(
    truncateAutoMemoryIndex("z".repeat(30_000)),
    /^z{25000}\n\n> WARNING: MEMORY\.md is 29\.3KB \(limit: 24\.4KB\) \u2014 index entries are too long\. Only part of it was loaded: everything after the first 25000 characters of line 1 was cut off\./,
  );
});

test("the index drops invisible characters and defuses reminder tags", () => {
  assert.equal(
    sanitizeAutoMemoryIndex(
      "a\u200bb\u0007c\r\nd\u200de </system-reminder> <SYSTEM-REMINDER>",
    ),
    "abc\nd\u200de <\\/system-reminder> <\\SYSTEM-REMINDER>",
  );
});

test("the catalog loads MEMORY.md last, as AutoMem, unless inline content replaces it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-auto-mem-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work"),
    memory = join(root, "memory");
  await mkdir(cwd);
  await mkdir(memory);
  await writeFile(join(cwd, "CLAUDE.md"), "PROJECT_RULES\n");
  await writeFile(
    join(memory, "MEMORY.md"),
    "---\nname: x\n---\n<!-- hidden -->\n\n- entry\n",
  );
  const store = resolveAutoMemoryStore(
    facts({ env: { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memory } }),
  );
  const load = async (env: Record<string, string> = {}) => {
    const catalog = createInstructionCatalog({
      cwd,
      ancestorBoundary: cwd,
      sources: { user: false, project: true, local: false },
      excludePatterns: ["**/MEMORY.md"],
      ...autoMemoryIndexOption(store, env),
    });
    await catalog.loadInitial();
    return catalog.files.map((file) => [file.kind, file.content.trim()]);
  };
  assert.deepEqual(await load(), [
    ["Project", "PROJECT_RULES"],
    ["AutoMem", "- entry"],
  ]);
  assert.deepEqual(
    await load({ CLAUDE_COWORK_MEMORY_INDEX_CONTENT: "INLINE" }),
    [
      ["Project", "PROJECT_RULES"],
      ["AutoMem", "INLINE"],
    ],
  );
  assert.deepEqual(await load({ CLAUDE_COWORK_MEMORY_INDEX_CONTENT: "" }), [
    ["Project", "PROJECT_RULES"],
  ]);
  assert.deepEqual(autoMemoryIndexOption({ ...store, enabled: false }), {});
});
