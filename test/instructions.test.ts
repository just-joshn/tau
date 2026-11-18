import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createInstructionCatalog,
  INSTRUCTION_MAX_BYTES,
  parseInstructionText,
  type InstructionOptions,
} from "../src/instructions.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-instructions-")),
  );
  const cwd = join(root, "repo"),
    user = join(root, "user"),
    managed = join(root, "managed");
  await mkdir(cwd, { recursive: true });
  const write = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const options: InstructionOptions = {
    cwd,
    userConfigDir: user,
    managedRoot: managed,
    ancestorBoundary: cwd,
    sources: { user: true, project: true, local: true },
  };
  return {
    root,
    cwd,
    user,
    managed,
    write,
    options,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("eager workflow loads managed/user and outer-to-inner project, both CLAUDE locations and local files", async () => {
  const f = await fixture();
  try {
    const work = join(f.cwd, "work");
    await mkdir(work);
    await f.write(join(f.managed, "CLAUDE.md"), "managed");
    await f.write(join(f.managed, ".claude/rules/base.md"), "managed rule");
    await f.write(join(f.user, "CLAUDE.md"), "user");
    await f.write(join(f.user, "rules/base.md"), "user rule");
    await f.write(join(f.cwd, "CLAUDE.md"), "outer");
    await f.write(join(f.cwd, ".claude/CLAUDE.md"), "outer dotclaude");
    await f.write(join(f.cwd, ".claude/rules/base.md"), "outer rule");
    await f.write(join(f.cwd, "CLAUDE.local.md"), "outer local");
    await f.write(join(work, "CLAUDE.md"), "inner");
    await f.write(
      join(work, "AGENTS.md"),
      "not an active filename in this pinned build",
    );
    await f.write(join(work, "deeper/CLAUDE.md"), "not eager");
    const catalog = createInstructionCatalog({
      ...f.options,
      cwd: work,
      managedInline: [{ path: "<fixture-policy>", content: "managed inline" }],
    });
    const result = await catalog.loadInitial();
    assert.deepEqual(
      result.files.map((file) => file.content),
      [
        "managed",
        "managed inline",
        "managed rule",
        "user",
        "user rule",
        "outer",
        "outer dotclaude",
        "outer rule",
        "outer local",
        "inner",
      ],
    );
    assert.equal(result.withheld.length, 0);
    assert.deepEqual((await catalog.loadInitial()).files, []);
  } finally {
    await f.close();
  }
});

test("nested workflow activates path rules and nested instruction ancestors once, without eager subtree scanning", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.cwd, "CLAUDE.md"), "root");
    await f.write(
      join(f.cwd, ".claude/rules/types.md"),
      '---\npaths: "src/**/*.{ts,tsx}, docs/**"\n---\nroot conditional',
    );
    await f.write(
      join(f.managed, ".claude/rules/managed.md"),
      '---\npaths: "src/**"\n---\nmanaged conditional',
    );
    await f.write(
      join(f.user, "rules/user.md"),
      '---\npaths: ["src/**"]\n---\nuser conditional',
    );
    await f.write(join(f.cwd, "src/CLAUDE.md"), "nested");
    await f.write(join(f.cwd, "src/.claude/CLAUDE.md"), "nested dotclaude");
    await f.write(join(f.cwd, "src/CLAUDE.local.md"), "nested local");
    await f.write(
      join(f.cwd, "src/.claude/rules/base.md"),
      "nested unconditional",
    );
    await f.write(
      join(f.cwd, "src/.claude/rules/conditional.md"),
      '---\npaths: "*.ts"\n---\nnested conditional',
    );
    await f.write(join(f.cwd, "src/main.ts"), "export {};");
    const catalog = createInstructionCatalog(f.options);
    assert.deepEqual(
      (await catalog.loadInitial()).files.map((file) => file.content),
      ["root"],
    );
    const update = await catalog.loadForPath(join(f.cwd, "src/main.ts"));
    assert.deepEqual(
      update.files.map((file) => file.content.trim()),
      [
        "managed conditional",
        "user conditional",
        "nested",
        "nested dotclaude",
        "nested unconditional",
        "nested conditional",
        "nested local",
        "root conditional",
      ],
    );
    assert.deepEqual((await catalog.loadForPath("src/main.ts")).files, []);
    assert.equal(catalog.files.length, 9);
  } finally {
    await f.close();
  }
});

test("Markdown parser excludes code/comments, imports escaped-space paths and removes frontmatter/comments", async () => {
  const f = await fixture();
  try {
    const text =
      '---\npaths: ["**"]\n---\nUse @one.md#part and @space\\ name.md\n`@inline.md`\n```text\n@fenced.md\n```\n<!-- @comment.md -->\n- @list.md\n';
    const parsed = parseInstructionText(text, join(f.cwd, "CLAUDE.md"));
    assert.deepEqual(parsed.imports, [
      join(f.cwd, "one.md"),
      join(f.cwd, "space name.md"),
      join(f.cwd, "list.md"),
    ]);
    assert.equal(parsed.globs, undefined);
    assert.equal(parsed.content.includes("paths:"), false);
    assert.equal(parsed.content.includes("@comment.md"), false);
    assert.equal(parsed.content.includes("@fenced.md"), true);
    await f.write(join(f.cwd, "CLAUDE.md"), text);
    for (const name of ["one.md", "space name.md", "list.md"])
      await f.write(join(f.cwd, name), name);
    const result = await createInstructionCatalog(f.options).loadInitial();
    assert.deepEqual(
      result.files.slice(1).map((file) => file.content),
      ["one.md", "space name.md", "list.md"],
    );
    assert.equal(result.files[0]?.contentDiffersFromDisk, true);
    assert.equal(result.files[0]?.rawContent, text);
  } finally {
    await f.close();
  }
});

test("import trees dedupe cycles and stop at depth five while preserving parent-before-child order", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.cwd, "CLAUDE.md"), "root @1.md @same.md @same.md");
    for (let index = 1; index <= 5; index++)
      await f.write(
        join(f.cwd, `${index}.md`),
        `level ${index} @${index + 1}.md`,
      );
    await f.write(join(f.cwd, "same.md"), "same @CLAUDE.md");
    const result = await createInstructionCatalog(f.options).loadInitial();
    assert.deepEqual(
      result.files.map((file) => file.path),
      ["CLAUDE.md", "1.md", "2.md", "3.md", "4.md", "same.md"].map((name) =>
        join(f.cwd, name),
      ),
    );
    assert.equal(result.files[1]?.parent, join(f.cwd, "CLAUDE.md"));
    assert.equal(
      result.withheld.find((issue) => issue.reason === "import-depth")?.path,
      join(f.cwd, "5.md"),
    );
  } finally {
    await f.close();
  }
});

test("external imports need explicit consent while user external imports and tilde home stay separately configured", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside.md");
    await f.write(outside, "outside");
    await f.write(join(f.cwd, "CLAUDE.md"), "project @../outside.md");
    await f.write(join(f.user, "CLAUDE.md"), "user @../outside.md");
    const projectOnly = {
      ...f.options,
      sources: { user: false, project: true, local: false },
    };
    const denied = await createInstructionCatalog(projectOnly).loadInitial();
    assert.deepEqual(
      denied.files.map((file) => file.content),
      ["project @../outside.md"],
    );
    assert.equal(denied.withheld[0]?.reason, "external-import");
    const requests: string[] = [];
    const approved = await createInstructionCatalog({
      ...projectOnly,
      approveExternalImport: ({ path }) => {
        requests.push(path);
        return true;
      },
    }).loadInitial();
    assert.equal(approved.files[1]?.content, "outside");
    assert.equal(requests[0], outside);
    const user = await createInstructionCatalog({
      ...f.options,
      sources: { user: true, project: false, local: false },
    }).loadInitial();
    assert.equal(user.files[1]?.content, "outside");
    const localAgent = await createInstructionCatalog({
      ...f.options,
      sources: { user: true, project: false, local: false },
      localAgent: true,
    }).loadInitial();
    assert.equal(localAgent.files.length, 1);
    await f.write(join(f.user, "CLAUDE.md"), "user @~/outside.md");
    const tilde = await createInstructionCatalog({
      ...f.options,
      sources: { user: true, project: false, local: false },
      importHome: f.root,
    }).loadInitial();
    assert.equal(tilde.files[1]?.path, outside);
  } finally {
    await f.close();
  }
});

test("absolute excludes protect Managed instructions and stop excluded parent imports", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.managed, "CLAUDE.md"), "managed");
    await f.write(join(f.cwd, "CLAUDE.md"), "project @child.md");
    await f.write(join(f.cwd, "child.md"), "child");
    const result = await createInstructionCatalog({
      ...f.options,
      excludePatterns: ["**/CLAUDE.md"],
    }).loadInitial();
    assert.deepEqual(
      result.files.map((file) => file.content),
      ["managed"],
    );
    assert.equal(
      result.withheld.some(
        (issue) => issue.kind === "Project" && issue.reason === "excluded",
      ),
      true,
    );
  } finally {
    await f.close();
  }
});

test("4MiB admission, regular files and explicit read policy retain withheld reasons", async () => {
  const f = await fixture();
  try {
    await f.write(
      join(f.cwd, "CLAUDE.md"),
      "x".repeat(INSTRUCTION_MAX_BYTES + 1),
    );
    await mkdir(join(f.cwd, ".claude/CLAUDE.md"), { recursive: true });
    await f.write(join(f.cwd, "CLAUDE.local.md"), "secret fixture");
    const result = await createInstructionCatalog({
      ...f.options,
      readPolicy: (path) =>
        path.endsWith("CLAUDE.local.md") ? "fixture withheld" : true,
    }).loadInitial();
    assert.deepEqual(result.files, []);
    assert.deepEqual(
      new Set(result.withheld.map((issue) => issue.reason)),
      new Set(["oversize", "special-file", "policy"]),
    );
    assert.equal(
      result.withheld.find((issue) => issue.reason === "policy")?.message,
      "fixture withheld",
    );
  } finally {
    await f.close();
  }
});

test("rules recurse safely, support negated ignore patterns and avoid linked directory cycles", async () => {
  const f = await fixture();
  try {
    await f.write(
      join(f.cwd, ".claude/rules/deep/conditional.md"),
      '---\npaths: ["**/*.ts", "!src/generated/*.ts"]\n---\nconditional',
    );
    await symlink(
      join(f.cwd, ".claude/rules"),
      join(f.cwd, ".claude/rules/deep/cycle"),
    );
    await mkdir(join(f.cwd, "src/generated"), { recursive: true });
    const catalog = createInstructionCatalog(f.options);
    assert.deepEqual((await catalog.loadInitial()).files, []);
    assert.deepEqual(
      (await catalog.loadForPath("src/generated/a.ts")).files,
      [],
    );
    assert.equal(
      (await catalog.loadForPath("src/a.ts")).files[0]?.content.trim(),
      "conditional",
    );
  } finally {
    await f.close();
  }
});

test("sources, managed-only mode, additional-directory opt-in and target read policy remain explicit", async () => {
  const f = await fixture();
  try {
    const extra = join(f.root, "extra");
    await f.write(join(f.cwd, "CLAUDE.md"), "project");
    await f.write(join(f.cwd, "CLAUDE.local.md"), "local");
    await f.write(join(f.managed, "CLAUDE.md"), "managed");
    await f.write(join(f.user, "CLAUDE.md"), "user");
    await f.write(join(extra, "CLAUDE.md"), "extra");
    const managed = createInstructionCatalog({
      ...f.options,
      managedInstructionsOnly: true,
    });
    assert.deepEqual(
      (await managed.loadInitial()).files.map((file) => file.content),
      ["managed"],
    );
    assert.deepEqual((await managed.loadForPath("src/a.ts")).files, []);
    const disabled = await createInstructionCatalog({
      ...f.options,
      sources: { user: false, project: false, local: true },
      additionalDirectories: [extra],
    }).loadInitial();
    assert.deepEqual(
      disabled.files.map((file) => file.content),
      ["managed", "local"],
    );
    const extraResult = await createInstructionCatalog({
      ...f.options,
      additionalDirectories: [extra],
      loadAdditionalDirectoryInstructions: true,
    }).loadInitial();
    assert.equal(extraResult.files.at(-1)?.content, "extra");
    await f.write(join(f.cwd, "nested/CLAUDE.md"), "nested");
    const blocked = createInstructionCatalog({
      ...f.options,
      readPolicy: (path) => !path.endsWith("a.ts"),
    });
    assert.deepEqual((await blocked.loadForPath("nested/a.ts")).files, []);
  } finally {
    await f.close();
  }
});

test("fresh catalog reproduces coding-to-resume discovery using only explicit fixture inputs", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.cwd, "CLAUDE.md"), "root");
    await f.write(join(f.cwd, "src/CLAUDE.md"), "nested");
    const coding = createInstructionCatalog(f.options);
    await coding.loadInitial();
    await coding.loadForPath("src/file.ts");
    const resumed = createInstructionCatalog(f.options);
    await resumed.loadInitial();
    await resumed.loadForPath("src/file.ts");
    assert.deepEqual(resumed.files, coding.files);
    await f.write(join(f.cwd, "CLAUDE.md"), "changed after checkpoint");
    const reloaded = createInstructionCatalog(f.options);
    assert.equal(
      (await reloaded.loadInitial()).files[0]?.content,
      "changed after checkpoint",
    );
  } finally {
    await f.close();
  }
});

test("canonical external imports are held before byte reads and symlink-relative imports use the landed file directory", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside");
    await f.write(join(outside, "parent.md"), "external @child.md");
    await f.write(join(outside, "child.md"), "landed child");
    await f.write(join(f.cwd, "CLAUDE.md"), "root @link.md");
    await symlink(join(outside, "parent.md"), join(f.cwd, "link.md"));
    const blocked = await createInstructionCatalog(f.options).loadInitial();
    assert.equal(blocked.files.length, 1);
    assert.equal(
      blocked.withheld.find((issue) => issue.path.endsWith("link.md"))?.reason,
      "external-import",
    );
    const allowed = await createInstructionCatalog({
      ...f.options,
      externalIncludesApproved: true,
    }).loadInitial();
    assert.deepEqual(
      allowed.files.map((file) => file.content),
      ["root @link.md", "external @child.md", "landed child"],
    );
    assert.equal(allowed.files[2]?.path, join(outside, "child.md"));
  } finally {
    await f.close();
  }
});
