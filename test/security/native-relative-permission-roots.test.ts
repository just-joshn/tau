import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  createNativeRelativePermissionRoots,
  createOrdinaryNativeRelativePermissionRoots,
  nativeLexicalPermissionWorktrees,
  type NativeRelativePermissionRootFacts,
  type NativeRelativePermissionRootsResult,
  type NativeRelativeRootSpellings,
} from "../../src/native-relative-permission-roots.js";

function resolved(value: NativeRelativePermissionRootsResult) {
  assert.equal(
    value.status,
    "resolved",
    value.status === "unsupported" ? value.reason : "",
  );
  if (value.status !== "resolved") throw Error("Unresolved fixture roots");
  return value;
}
function fixture() {
  const facts: NativeRelativePermissionRootFacts = {
    platform: "posix",
    cwd: "/launch",
    originalCwd: "/launch",
    launchContextRoot: "/launch",
    projectRoot: "/launch",
    additionalWorkingDirectories: [],
    initialReadRoot: undefined,
    blockFileToolReadsOutsideWorkingDirectories: false,
    relativeRuleRootsSwitch: undefined,
    evalConfined: false,
    diskless: false,
  };
  const held = new Set<string>(),
    cached = new Map<string, readonly string[]>(),
    calls: string[] = [];
  let readSpellings = (path: string): NativeRelativeRootSpellings => ({
    status: "known",
    spellings: [path],
  });
  const host = createNativeRelativePermissionRoots({
    facts: () => facts,
    workingDirPathsHeldAsNamed: () => held,
    resolvedWorkingDirPaths: () => cached,
    readSpellings(path) {
      calls.push(path);
      return readSpellings(path);
    },
  });
  return {
    facts,
    held,
    cached,
    calls,
    host,
    read: (next: typeof readSpellings) => {
      readSpellings = next;
    },
  };
}

test("the enabled default considers original/project/additional roots while allow and an explicit disabled switch use live cwd", () => {
  const f = fixture();
  f.facts.cwd = "/live";
  f.facts.projectRoot = "/project";
  f.facts.additionalWorkingDirectories = ["/extra", "/extra", "/launch"];
  assert.deepEqual(resolved(f.host.evaluate("/file", "deny")).roots, [
    "/live",
    "/launch",
    "/extra",
    "/project",
  ]);
  assert.deepEqual(resolved(f.host.evaluate("/file", "allow")).roots, [
    "/live",
  ]);
  f.facts.relativeRuleRootsSwitch = false;
  assert.deepEqual(resolved(f.host.evaluate("/file", "ask")).roots, ["/live"]);
});

test("the read fence contributes only a deny group and never discovers translation/worktree bases", () => {
  const f = fixture();
  f.facts.initialReadRoot = "/fence/.claude/worktrees/private";
  f.facts.blockFileToolReadsOutsideWorkingDirectories = true;
  const deny = resolved(
    f.host.evaluate("/fence/.claude/worktrees/private/file", "deny"),
  );
  assert.deepEqual(deny.roots, ["/launch", "/fence/.claude/worktrees/private"]);
  assert.deepEqual(deny.worktrees, []);
  assert.deepEqual(resolved(f.host.evaluate("/file", "ask")).roots, [
    "/launch",
  ]);
});

test("equivalent root translation is one pass rather than transitive closure", () => {
  const f = fixture();
  f.facts.cwd = "/a/.claude/worktrees/work";
  f.facts.launchContextRoot = "/a";
  f.facts.projectRoot = "/second";
  f.read((path) => ({
    status: "known",
    spellings: path === "/a" ? ["/a", "/b"] : ["/b", "/c"],
  }));
  const value = resolved(f.host.evaluate("/outside/file", "deny"));
  assert.deepEqual(value.worktrees, [
    "/a/.claude/worktrees/work",
    "/b/.claude/worktrees/work",
  ]);
  assert.equal(value.worktrees.includes("/c/.claude/worktrees/work"), false);
});

test("the deepest matching lexical worktree replaces complete ancestor groups and keeps live cwd first", () => {
  const f = fixture();
  const work = "/repo/.claude/worktrees/outer/.claude/worktrees/inner";
  f.facts.cwd = `${work}/src`;
  f.facts.launchContextRoot = "/repo";
  f.facts.projectRoot = "/repo";
  const value = resolved(f.host.evaluate(`${work}/file`, "ask"));
  assert.equal(value.selectedWorktree, work);
  assert.deepEqual(value.roots, [`${work}/src`, work]);
  assert.deepEqual(
    resolved(f.host.evaluate("/repo/.claude/worktrees/sibling/file", "ask"))
      .roots,
    [`${work}/src`, "/repo"],
  );
});

test("worktree matching preserves native lexical empty-component behavior without Git enumeration", () => {
  assert.deepEqual(
    nativeLexicalPermissionWorktrees("/repo/.claude/worktrees/name/sub"),
    ["/repo/.claude/worktrees/name"],
  );
  assert.deepEqual(
    nativeLexicalPermissionWorktrees("/repo/.claude/worktrees/"),
    [],
  );
  // wg only checks that some character follows the marker; that character may be '/'.
  assert.deepEqual(
    nativeLexicalPermissionWorktrees("/repo/.claude/worktrees//child"),
    ["/repo/.claude/worktrees/"],
  );
  assert.deepEqual(
    nativeLexicalPermissionWorktrees("/repo/.Claude/worktrees/name"),
    [],
  );
});

test("cache order is held-as-named, resolved metadata, then folder cache with explicit invalidation", () => {
  const f = fixture();
  f.read(() => ({ status: "known", spellings: ["/launch", "/physical"] }));
  assert.deepEqual(resolved(f.host.evaluate("/x", "deny")).roots, [
    "/launch",
    "/physical",
  ]);
  f.read(() => ({ status: "known", spellings: ["/launch", "/new"] }));
  assert.deepEqual(resolved(f.host.evaluate("/x", "deny")).roots, [
    "/launch",
    "/physical",
  ]);
  assert.equal(f.calls.length, 1);
  f.cached.set("/launch", ["/launch", "/metadata"]);
  assert.deepEqual(resolved(f.host.evaluate("/x", "deny")).roots, [
    "/launch",
    "/metadata",
  ]);
  f.held.add("/launch");
  assert.deepEqual(resolved(f.host.evaluate("/x", "deny")).roots, ["/launch"]);
  f.held.clear();
  f.cached.clear();
  f.host.clearSpellingsCache();
  assert.deepEqual(resolved(f.host.evaluate("/x", "deny")).roots, [
    "/launch",
    "/new",
  ]);
});

test("confined original and diskless roots bypass filesystem spellings only at their source-defined gates", () => {
  const f = fixture();
  f.facts.evalConfined = true;
  f.facts.projectRoot = "/project";
  f.read(() => ({ status: "unsupported", reason: "No inspected spelling" }));
  assert.equal(f.host.evaluate("/x", "deny").status, "unsupported");
  assert.deepEqual(f.calls, ["/project"]);
  f.facts.diskless = true;
  assert.deepEqual(resolved(f.host.evaluate("/x", "deny")).roots, [
    "/launch",
    "/project",
  ]);
});

test("unknown or invalid known root spellings never become an empty restrictive result", () => {
  const f = fixture();
  f.read(() => ({ status: "unsupported", reason: "Unresolved root identity" }));
  assert.equal(f.host.evaluate("/x", "deny").status, "unsupported");
  assert.throws(() => f.host.resolve("/x", "deny"), /Unresolved root identity/);
  for (const values of [[], ["relative"], ["/bad\0root"]]) {
    f.cached.set("/launch", values);
    assert.equal(f.host.evaluate("/x", "ask").status, "unsupported");
  }
});

test("named root normalization retains trailing whitespace and canonical NFC", () => {
  const f = fixture();
  f.facts.cwd = "/live";
  f.facts.launchContextRoot = "/dir ";
  f.facts.projectRoot = "/cafe\u0301";
  assert.deepEqual(resolved(f.host.evaluate("/file", "deny")).roots, [
    "/live",
    "/dir ",
    "/caf\u00e9",
  ]);
});

test("the real ordinary factory anchors a nested Git launch at its canonical cwd and rejects transitions", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tau-relative-roots-")));
  try {
    const cwd = join(root, "repo", "nested");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, "repo", ".git"));
    let current = cwd,
      admitted: boolean | string = true;
    const host = createOrdinaryNativeRelativePermissionRoots({
      launchCwd: cwd,
      cwd: () => current,
      home: root,
      evalConfined: false,
      blockFileToolReadsOutsideWorkingDirectories: () => true,
      admitOrdinaryLaunch: () => admitted,
    });
    assert.deepEqual(resolved(host.evaluate(join(cwd, "file"), "deny")).roots, [
      cwd,
    ]);
    assert.deepEqual(resolved(host.evaluate(join(cwd, "file"), "ask")).roots, [
      cwd,
    ]);
    current = root;
    assert.equal(
      host.evaluate(join(cwd, "file"), "deny").status,
      "unsupported",
    );
    current = cwd;
    admitted = "Remote profile requires its native host";
    assert.throws(
      () => host.resolve(join(cwd, "file"), "ask"),
      /Remote profile/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ordinary factory reads real alias spellings without inventing a Git project root", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tau-relative-alias-")));
  try {
    const physical = join(root, "physical");
    mkdirSync(physical);
    const link = join(root, "alias");
    symlinkSync(physical, link);
    const host = createOrdinaryNativeRelativePermissionRoots({
      launchCwd: link,
      cwd: () => link,
      home: root,
      evalConfined: false,
      blockFileToolReadsOutsideWorkingDirectories: () => false,
      admitOrdinaryLaunch: () => true,
    });
    assert.deepEqual(
      resolved(host.evaluate(join(link, "file"), "deny")).roots,
      [link, physical],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
