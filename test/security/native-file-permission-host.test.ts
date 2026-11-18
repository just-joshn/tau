import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  createNativeFilePermissionHost,
  createNativeIgnoreBackend,
  inspectNativePosixPermissionPath,
  nativeFileRuleSourceRoot,
  NativeFilePermissionUnsupported,
  createNativeVerifiedPosixAliasResolver,
  type NativeFilePermissionHostOptions,
  type NativeFilePermissionRoots,
} from "../../src/native-file-permission-host.js";
import {
  parseNativePermissionRule,
  type NativeFileRule,
} from "../../src/native-permission-rules.js";

function fixture(run: (root: string) => void) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "tau-native-file-permission-")),
  );
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function rule(text: string, source = "session"): NativeFileRule {
  return { rule: parseNativePermissionRule(text), source };
}
function roots(root: string): NativeFilePermissionRoots {
  return {
    launchRoot: join(root, "launch"),
    settingsContextCwd: join(root, "context"),
    userConfigDir: join(root, "user-config"),
    flagSettings: { kind: "file", path: join(root, "flags", "settings.json") },
  };
}
function options(root: string): NativeFilePermissionHostOptions {
  return {
    cwd: () => root,
    home: join(root, "home"),
    roots: () => roots(root),
    relativeRoots: { kind: "live-cwd" },
    physicalTwinsEnabled: true,
    fixedRootsBeforeRelative: true,
    trustedAlias: (path) => path,
  };
}
function file(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "owned fixture\n");
}

test("actual Ignore 7 handles globstar, question/class syntax, parent exclusion and pattern identity", () => {
  const backend = createNativeIgnoreBackend();
  assert.deepEqual(
    backend.test(["/src/**/file?.[tj]s"], "src/nested/file1.ts"),
    { ignored: true, pattern: "/src/**/file?.[tj]s" },
  );
  assert.equal(
    backend.test(["/src/**/file?.[tj]s"], "src/file1.js").ignored,
    true,
  );
  assert.equal(
    backend.test(["private/", "!private/visible.txt"], "private/visible.txt")
      .ignored,
    true,
  );
  assert.equal(
    backend.test(
      ["private/", "!private/", "private/*", "!private/visible.txt"],
      "private/visible.txt",
    ).ignored,
    false,
  );
  assert.equal(backend.test(["FILE.TXT"], "file.txt").ignored, true);
});
test("source root lookup follows AEi and never uses a .claude, managed or local consent-store directory", () => {
  const context = roots("/owned");
  for (const source of ["projectSettings", "localSettings", "policySettings"])
    assert.equal(nativeFileRuleSourceRoot(source, context), "/owned/context");
  for (const source of [
    "cliArg",
    "command",
    "session",
    "mcpMount",
    "toolsNarrowing",
    "mcpServerPolicy",
    "hostCredential",
  ])
    assert.equal(nativeFileRuleSourceRoot(source, context), "/owned/launch");
  assert.equal(
    nativeFileRuleSourceRoot("userSettings", context),
    "/owned/user-config",
  );
  assert.equal(
    nativeFileRuleSourceRoot("flagSettings", context),
    "/owned/flags",
  );
  assert.equal(
    nativeFileRuleSourceRoot("flagSettings", {
      ...context,
      flagSettings: { kind: "inline" },
    }),
    "/owned/context",
  );
  assert.throws(
    () => nativeFileRuleSourceRoot("unrecognized", context),
    NativeFilePermissionUnsupported,
  );
  assert.throws(
    () =>
      nativeFileRuleSourceRoot("userSettings", {
        launchRoot: "/owned",
        settingsContextCwd: "/owned",
        flagSettings: { kind: "absent" },
      }),
    NativeFilePermissionUnsupported,
  );
});
test("ordinary existing and missing paths preserve canonical spelling without reading file contents", () =>
  fixture((root) => {
    const path = join(root, "folder", "file.txt");
    file(path);
    const host = createNativeFilePermissionHost(options(root));
    const existing = host.inspectPath("folder/file.txt");
    assert.equal(existing.status, "resolved");
    if (existing.status === "resolved") {
      assert.equal(existing.exists, true);
      assert.deepEqual(existing.spellings, [path]);
    }
    const missing = host.inspectPath("folder/new/deep.txt");
    assert.equal(missing.status, "resolved");
    if (missing.status === "resolved") {
      assert.equal(missing.exists, false);
      assert.deepEqual(missing.spellings, [join(root, "folder/new/deep.txt")]);
    }
  }));
test("leaf and ancestor symbolic links retain both lexical and physical spellings", () =>
  fixture((root) => {
    file(join(root, "physical", "file.txt"));
    symlinkSync("physical", join(root, "alias"));
    symlinkSync("physical/file.txt", join(root, "leaf"));
    const host = createNativeFilePermissionHost(options(root));
    const ancestor = host.inspectPath("alias/file.txt");
    assert.equal(ancestor.status, "resolved");
    assert.deepEqual(ancestor.spellings, [
      join(root, "alias/file.txt"),
      join(root, "physical/file.txt"),
    ]);
    assert.equal(ancestor.leafIsSymlink, false);
    const leaf = host.inspectPath("leaf");
    assert.deepEqual(leaf.spellings, [
      join(root, "leaf"),
      join(root, "physical/file.txt"),
    ]);
    assert.equal(leaf.leafIsSymlink, true);
    const missing = host.inspectPath("alias/missing.txt");
    assert.equal(missing.status, "resolved");
    assert.deepEqual(missing.spellings, [
      join(root, "alias/missing.txt"),
      join(root, "physical/missing.txt"),
    ]);
  }));
test("rule allows require all link spellings; restrictive matches apply to any spelling", () =>
  fixture((root) => {
    file(join(root, "physical/file.txt"));
    symlinkSync("physical", join(root, "alias"));
    const host = createNativeFilePermissionHost(options(root));
    const narrow = [rule("Read(alias/**)")];
    assert.equal(
      host.match({
        path: "alias/file.txt",
        toolName: "Read",
        behavior: "allow",
        rules: narrow,
      }).status,
      "no-match",
    );
    assert.equal(
      host.match({
        path: "alias/file.txt",
        toolName: "Read",
        behavior: "deny",
        rules: [rule("Read(physical/**)")],
      }).status,
      "matched",
    );
    assert.equal(
      host.match({
        path: "alias/file.txt",
        toolName: "Read",
        behavior: "allow",
        rules: [...narrow, rule("Read(physical/**)")],
      }).status,
      "matched",
    );
  }));
test("source-rooted Write/Edit rules match context directories; slash root differs from double slash", () =>
  fixture((root) => {
    const context = roots(root);
    file(join(context.settingsContextCwd, "output.txt"));
    const host = createNativeFilePermissionHost(options(root));
    for (const source of [
      "projectSettings",
      "localSettings",
      "policySettings",
    ]) {
      assert.equal(
        host.match({
          path: join(context.settingsContextCwd, "output.txt"),
          toolName: "Write",
          behavior: "allow",
          rules: [rule("Edit(/output.txt)", source)],
        }).status,
        "matched",
      );
    }
    assert.equal(
      host.match({
        path: join(context.settingsContextCwd, "output.txt"),
        toolName: "Edit",
        behavior: "allow",
        rules: [
          rule(`Edit(/${join(context.settingsContextCwd, "output.txt")})`),
        ],
      }).status,
      "matched",
    );
    assert.equal(
      host.match({
        path: join(context.settingsContextCwd, "output.txt"),
        toolName: "Write",
        behavior: "allow",
        rules: [rule("Write(/output.txt)", "projectSettings")],
      }).status,
      "no-match",
    );
  }));
test("actual Gitignore negation ordering is isolated per deny source and combined for allow", () =>
  fixture((root) => {
    file(join(root, "private.txt"));
    const host = createNativeFilePermissionHost(options(root));
    const rules = [
      rule("Read(private.txt)", "userSettings"),
      rule("Read(!private.txt)", "session"),
    ];
    assert.equal(
      host.match({
        path: "private.txt",
        toolName: "Read",
        behavior: "deny",
        rules,
      }).status,
      "matched",
    );
    assert.equal(
      host.match({
        path: "private.txt",
        toolName: "Read",
        behavior: "allow",
        rules,
      }).status,
      "no-match",
    );
  }));
test("anchored physical pattern twins cover direct access to a link target", () =>
  fixture((root) => {
    file(join(root, "physical/secret.txt"));
    symlinkSync("physical", join(root, "alias"));
    const input = {
      path: join(root, "physical/secret.txt"),
      toolName: "Read",
      behavior: "deny",
      rules: [rule(`Read(//${root.slice(1)}/alias/**)`)],
    } satisfies Parameters<
      ReturnType<typeof createNativeFilePermissionHost>["match"]
    >[0];
    assert.equal(
      createNativeFilePermissionHost(options(root)).match(input).status,
      "matched",
    );
    assert.equal(
      createNativeFilePermissionHost({
        ...options(root),
        physicalTwinsEnabled: false,
      }).match(input).status,
      "no-match",
    );
  }));
test("relative/basename rules do not invent anchored physical twins", () =>
  fixture((root) => {
    file(join(root, "physical/secret.txt"));
    symlinkSync("physical", join(root, "alias"));
    const host = createNativeFilePermissionHost(options(root));
    assert.equal(
      host.match({
        path: "physical/secret.txt",
        toolName: "Read",
        behavior: "deny",
        rules: [rule("Read(alias/**)")],
      }).status,
      "no-match",
    );
  }));
test("extra-root search requires explicit host Ewn selection and never widens relative allow", () =>
  fixture((root) => {
    file(join(root, "additional", "secrets", "private.txt"));
    const base = options(root);
    const extraRoot = join(root, "additional");
    const host = createNativeFilePermissionHost({
      ...base,
      relativeRoots: { kind: "host", resolve: () => [root, extraRoot] },
    });
    const input = {
      path: join(extraRoot, "secrets/private.txt"),
      toolName: "Read",
      behavior: "deny",
      rules: [rule("Read(/private.txt)", "session")],
    } satisfies Parameters<typeof host.match>[0];
    // An explicit launch-root pattern does not use relative candidate roots.
    assert.equal(host.match(input).status, "no-match");
    const relative = { ...input, rules: [rule("Read(secrets/private.txt)")] };
    assert.equal(host.match(relative).status, "matched");
    assert.equal(
      createNativeFilePermissionHost(base).match(relative).status,
      "no-match",
    );
    assert.equal(
      host.match({ ...relative, behavior: "allow" }).status,
      "no-match",
    );
    // Basename patterns can match descendants; anchor via './additional' is not invented.
    assert.equal(
      host.match({
        ...relative,
        behavior: "allow",
        rules: [rule("Read(/private.txt)", "session")],
      }).status,
      "no-match",
    );
  }));
test("unresolved paths cannot obtain an allow but known lexical deny can still win", () =>
  fixture((root) => {
    symlinkSync("loop", join(root, "loop"));
    const host = createNativeFilePermissionHost(options(root));
    assert.equal(host.inspectPath("loop").status, "unresolved");
    const input = {
      path: "loop",
      toolName: "Read",
      behavior: "allow",
      rules: [rule("Read(loop)")],
    } satisfies Parameters<typeof host.match>[0];
    assert.equal(host.match(input).status, "unsupported");
    assert.equal(host.match({ ...input, behavior: "deny" }).status, "matched");
    assert.equal(
      host.match({ ...input, behavior: "ask", rules: [] }).status,
      "unsupported",
    );
  }));
test("native 64-link cap is enforced before the final target is trusted", () =>
  fixture((root) => {
    file(join(root, "target"));
    for (let i = 63; i >= 0; i--)
      symlinkSync(
        i === 63 ? "target" : `link-${i + 1}`,
        join(root, `link-${i}`),
      );
    const path = createNativeFilePermissionHost(options(root)).inspectPath(
      "link-0",
    );
    assert.equal(path.status, "unresolved");
    assert.equal(path.links, 64);
  }));
test("network-shaped and opaque paths are withheld before filesystem inspection", () => {
  let calls = 0;
  const fs = {
    lstat: () => {
      calls++;
      throw new Error("must not inspect");
    },
    readlink: () => "",
    realpath: (path: string) => path,
  };
  for (const path of [
    "/net/owned",
    "/Network/owned",
    "/.vol/owned",
    "/dev/fd/3",
    "//server/share",
    "/owned/\uFFFD",
  ]) {
    const result = inspectNativePosixPermissionPath({
      path,
      cwd: "/owned",
      home: "/owned/home",
      filesystem: fs,
    });
    assert.equal(result.status, "unresolved");
  }
  assert.equal(calls, 0);
});
test("unreadable ancestry is explicit and never treated as a resolved grant", () =>
  fixture((root) => {
    const error = Object.assign(new Error("owned unreadable"), {
      code: "EACCES",
    });
    const host = createNativeFilePermissionHost({
      ...options(root),
      filesystem: {
        lstat: () => {
          throw error;
        },
        readlink: (path) => readlinkSync(path),
        realpath: (path) => realpathSync(path),
      },
    });
    const inspected = host.inspectPath("secret");
    assert.equal(inspected.status, "unresolved");
    assert.equal(
      host.match({
        path: "secret",
        toolName: "Read",
        behavior: "allow",
        rules: [rule("Read(secret)")],
      }).status,
      "unsupported",
    );
  }));
test("host mount admission applies to symlink targets before target I/O", () =>
  fixture((root) => {
    file(join(root, "blocked/file.txt"));
    symlinkSync("blocked", join(root, "alias"));
    const host = createNativeFilePermissionHost({
      ...options(root),
      admitPath: (path) => !path.startsWith(join(root, "blocked")),
    });
    assert.equal(host.inspectPath("alias/file.txt").status, "unresolved");
    assert.equal(
      host.match({
        path: "alias/file.txt",
        toolName: "Read",
        behavior: "allow",
        rules: [rule("Read(**)")],
      }).status,
      "unsupported",
    );
  }));
test("directory matching and unusable patterns use actual backend semantics", () =>
  fixture((root) => {
    mkdirSync(join(root, "private"));
    file(join(root, "comment.txt"));
    const host = createNativeFilePermissionHost(options(root));
    assert.equal(
      host.match({
        path: "private",
        toolName: "Read",
        behavior: "deny",
        rules: [rule("Read(private/)")],
      }).status,
      "matched",
    );
    const prepared = host.prepare(rule("Read(#comment)"), "allow");
    assert.equal(prepared.status, "dropped");
    const restrictive = host.prepare(rule("Read(#comment)"), "deny");
    assert.equal(restrictive.status, "prepared");
    if (restrictive.status === "prepared")
      assert.equal(restrictive.value.pattern, "\\#comment");
  }));
test("configuration-root omissions and malformed host roots report unsupported", () =>
  fixture((root) => {
    file(join(root, "file.txt"));
    const host = createNativeFilePermissionHost({
      ...options(root),
      roots: () => ({
        launchRoot: root,
        settingsContextCwd: root,
        flagSettings: { kind: "absent" },
      }),
    });
    assert.equal(
      host.match({
        path: "file.txt",
        toolName: "Read",
        behavior: "allow",
        rules: [rule("Read(/file.txt)", "userSettings")],
      }).status,
      "unsupported",
    );
  }));
test("explicit trusted alias fallback is confined to host-verified equivalences", () =>
  fixture((root) => {
    file(join(root, "physical/file.txt"));
    const host = createNativeFilePermissionHost({
      ...options(root),
      trustedAlias: (path) => path.replace("/physical/", "/approved/"),
    });
    assert.equal(
      host.match({
        path: "physical/file.txt",
        toolName: "Read",
        behavior: "allow",
        rules: [rule("Read(approved/**)")],
      }).status,
      "matched",
    );
  }));

test("native trusted aliases require exact successful realpath verification and preserve component boundaries", () => {
  const alias = createNativeVerifiedPosixAliasResolver({
    realpath: (path) => {
      if (path === "/tmp") return "/private/tmp";
      if (path === "/bin") return "/usr/bin";
      if (path === "/etc") throw new Error("owned unavailable alias");
      return path;
    },
  });
  assert.equal(alias("/private/tmp/owned.txt"), "/tmp/owned.txt");
  assert.equal(
    alias("/private/tmp-other/owned.txt"),
    "/private/tmp-other/owned.txt",
  );
  assert.equal(alias("/usr/bin/owned"), "/bin/owned");
  assert.equal(alias("/private/etc/owned"), "/private/etc/owned");
});
test("multi-leaf-link chain records each composed spelling and missing dot-targets remain unresolved", () =>
  fixture((root) => {
    file(join(root, "target"));
    symlinkSync("target", join(root, "second"));
    symlinkSync("second", join(root, "first"));
    const host = createNativeFilePermissionHost(options(root));
    assert.deepEqual(host.inspectPath("first").spellings, [
      join(root, "first"),
      join(root, "second"),
      join(root, "target"),
    ]);
    symlinkSync("absent/../target", join(root, "broken-dot"));
    assert.equal(host.inspectPath("broken-dot").status, "unresolved");
  }));

test("POSIX backslash filenames remain literal during actual Gitignore matching", () =>
  fixture((root) => {
    file(join(root, "a\\b.txt"));
    const host = createNativeFilePermissionHost(options(root));
    const escaped = "Read(a\\\\\\\\b.txt)";
    assert.equal(
      host.match({
        path: "a\\b.txt",
        toolName: "Read",
        behavior: "deny",
        rules: [rule(escaped)],
      }).status,
      "matched",
    );
    assert.equal(
      host.match({
        path: "a/b.txt",
        toolName: "Read",
        behavior: "deny",
        rules: [rule(escaped)],
      }).status,
      "no-match",
    );
  }));

test("compiled physical twins stay stable until host invalidation, then retain historical targets", () =>
  fixture((root) => {
    file(join(root, "old/secret.txt"));
    file(join(root, "new/secret.txt"));
    const alias = join(root, "alias");
    symlinkSync("old", alias);
    const host = createNativeFilePermissionHost(options(root));
    const rules = [rule(`Read(//${root.slice(1)}/alias/**)`)];
    const input = {
      path: join(root, "old/secret.txt"),
      toolName: "Read",
      behavior: "deny",
      rules,
    } satisfies Parameters<typeof host.match>[0];
    assert.equal(host.match(input).status, "matched");
    rmSync(alias);
    symlinkSync("new", alias);
    assert.equal(
      host.match({ ...input, path: join(root, "new/secret.txt") }).status,
      "no-match",
    );
    host.forgetCompilation(rules);
    assert.equal(
      host.match({ ...input, path: join(root, "new/secret.txt") }).status,
      "matched",
    );
    assert.equal(host.match(input).status, "matched");
  }));
