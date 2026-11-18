import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createNativeFilePermissionHost,
  inspectNativePosixPermissionPath,
  nativeFileRuleSourceRoot,
  NativeFilePermissionUnsupported,
  type NativeFilePermissionHostOptions,
  type NativePosixPermissionFilesystem,
} from "../../src/native-file-permission-host.js";
import {
  parseNativePermissionRule,
  type NativeFileRule,
} from "../../src/native-permission-rules.js";

function fixture(run: (root: string) => void) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "tau-native-file-permission-edges-")),
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
function options(root: string): NativeFilePermissionHostOptions {
  return {
    cwd: () => root,
    home: join(root, "home"),
    roots: () => ({
      launchRoot: join(root, "launch"),
      settingsContextCwd: join(root, "context"),
      flagSettings: { kind: "absent" },
    }),
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

const coded = Object.assign(new Error("owned failure"), { code: "EACCES" });
const uncoded = new Error("owned failure without a code");
const enoent = () =>
  Object.assign(new Error("owned missing"), { code: "ENOENT" });

/** In-memory POSIX tree under /owned: dir/, dir/file, link -> dir. */
function ownedFilesystem(
  overrides: Partial<NativePosixPermissionFilesystem> = {},
): NativePosixPermissionFilesystem {
  const directories = new Set(["/owned", "/owned/dir"]);
  const files = new Set(["/owned/dir/file"]);
  const links = new Map([["/owned/link", "dir"]]);
  return {
    lstat(path) {
      if (links.has(path))
        return { isSymbolicLink: () => true, isDirectory: () => false };
      if (directories.has(path) || files.has(path))
        return {
          isSymbolicLink: () => false,
          isDirectory: () => directories.has(path),
        };
      throw enoent();
    },
    readlink(path) {
      const target = links.get(path);
      if (target === undefined) throw enoent();
      return target;
    },
    realpath: (path) => path,
    ...overrides,
  };
}
function inspectOwned(
  path: string,
  overrides: Partial<NativePosixPermissionFilesystem> = {},
) {
  return inspectNativePosixPermissionPath({
    path,
    cwd: "/owned",
    home: "/owned/home",
    filesystem: ownedFilesystem(overrides),
  });
}

test("INV-06 a relative configuration root is refused instead of resolved against an unknown cwd", () => {
  assert.throws(
    () =>
      nativeFileRuleSourceRoot("session", {
        launchRoot: "launch",
        settingsContextCwd: "/owned",
        flagSettings: { kind: "absent" },
      }),
    NativeFilePermissionUnsupported,
  );
});

test("INV-06 ~ and ~/ targets are inspected under the configured home", () =>
  fixture((root) => {
    file(join(root, "home", "notes.txt"));
    const host = createNativeFilePermissionHost(options(root));
    const home = host.inspectPath("~");
    assert.equal(home.status, "resolved");
    if (home.status === "resolved") {
      assert.equal(home.landing, join(root, "home"));
      assert.equal(home.isDirectory, true);
    }
    const notes = host.inspectPath("~/notes.txt");
    assert.equal(notes.status, "resolved");
    if (notes.status === "resolved") {
      assert.equal(notes.landing, join(root, "home", "notes.txt"));
      assert.equal(notes.exists, true);
    }
  }));

test("INV-06 a target whose spelling changes when normalized again cannot be allowed", () =>
  fixture((root) => {
    const host = createNativeFilePermissionHost(options(root));
    // "name /" resolves to ".../name " and re-trimming would drop the space.
    assert.equal(host.inspectPath("name /").status, "unresolved");
    assert.equal(
      host.match({
        path: "name /",
        toolName: "Read",
        behavior: "allow",
        rules: [rule("Read(**)")],
      }).status,
      "unsupported",
    );
  }));

test("INV-06 host admission is consulted for each intermediate directory", () => {
  const result = inspectNativePosixPermissionPath({
    path: "/owned/dir/file",
    cwd: "/owned",
    home: "/owned/home",
    filesystem: ownedFilesystem(),
    admitPath: (path) =>
      path === "/owned/dir" ? "owned mount is withheld" : true,
  });
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") {
    assert.equal(result.reason, "owned mount is withheld");
    assert.equal(result.stoppedAt, "/owned/dir");
  }
});

test("INV-06 metadata failures with or without an errno code leave the path unresolved", () => {
  for (const error of [coded, uncoded]) {
    const fail = () => {
      throw error;
    };
    const cases = [
      {
        path: "/owned/dir/file",
        filesystem: { lstat: fail },
        stoppedAt: "/owned",
      },
      {
        path: "/owned/dir/new.txt",
        filesystem: {
          realpath: (path: string) => {
            if (path === "/owned/dir") throw error;
            return path;
          },
        },
        stoppedAt: "/owned/dir",
      },
      {
        path: "/owned/link/file",
        filesystem: { readlink: fail },
        stoppedAt: "/owned/link",
      },
      {
        path: "/owned/dir/file",
        filesystem: { realpath: fail },
        stoppedAt: "/owned/dir/file",
      },
    ];
    for (const { path, filesystem, stoppedAt } of cases) {
      const result = inspectOwned(path, filesystem);
      assert.equal(result.status, "unresolved", path);
      if (result.status === "unresolved")
        assert.equal(result.stoppedAt, stoppedAt, path);
    }
  }
});

test("INV-06 an opaque symbolic link target is never followed", () => {
  const result = inspectOwned("/owned/link/file", {
    readlink: () => "di�r",
  });
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved")
    assert.equal(result.stoppedAt, "/owned/link");
});

test("INV-06 a missing top-level path resolves to its own spelling only", () => {
  const result = inspectOwned("/absent");
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.equal(result.exists, false);
    assert.deepEqual(result.spellings, ["/absent"]);
  }
});

test("INV-06 a missing file under a relocated directory carries the physical spelling too", () => {
  const result = inspectOwned("/owned/dir/new.txt", {
    realpath: (path) => (path === "/owned/dir" ? "/volume/dir" : path),
  });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved")
    assert.deepEqual(result.spellings, [
      "/owned/dir/new.txt",
      "/volume/dir/new.txt",
    ]);
});

test("INV-06 a physical location on a network mount is withheld for missing and existing targets", () => {
  const realpath = (path: string) =>
    path.startsWith("/owned/dir") ? `/net${path}` : path;
  for (const path of ["/owned/dir/new.txt", "/owned/dir/file"]) {
    const result = inspectOwned(path, { realpath });
    assert.equal(result.status, "unresolved", path);
    if (result.status === "unresolved")
      assert.equal(result.stoppedAt, `/net${path}`, path);
  }
});

test("INV-01 a home-wide deny rule denies files under home", () =>
  fixture((root) => {
    file(join(root, "home", "notes.txt"));
    const host = createNativeFilePermissionHost(options(root));
    const input = {
      path: join(root, "home", "notes.txt"),
      toolName: "Read",
      behavior: "deny",
      rules: [rule("Read(~/**)")],
    } satisfies Parameters<typeof host.match>[0];
    assert.equal(host.match(input).status, "matched");
    assert.equal(
      host.match({ ...input, path: join(root, "elsewhere.txt") }).status,
      "no-match",
    );
  }));

test("INV-01 an anchored exact deny also covers direct access through the link target", () =>
  fixture((root) => {
    file(join(root, "physical", "secret.txt"));
    symlinkSync("physical", join(root, "alias"));
    const input = {
      path: join(root, "physical", "secret.txt"),
      toolName: "Read",
      behavior: "deny",
      rules: [rule(`Read(/${join(root, "alias", "secret.txt")})`)],
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

test("INV-01 a literalized trailing-backslash deny still covers the link target", () =>
  fixture((root) => {
    // A directory literally named `box\`, reached through the `alias` link.
    file(join(root, "physical", "box\\", "secret.txt"));
    symlinkSync("physical", join(root, "alias"));
    const host = createNativeFilePermissionHost(options(root));
    const anchored = `/${join(root, "alias", "box")}\\\\`;
    for (const [text, path] of [
      [`Read(${anchored})`, join(root, "physical", "box\\")],
      [`Read(${anchored}/**)`, join(root, "physical", "box\\", "secret.txt")],
    ] as const) {
      const input = {
        path,
        toolName: "Read",
        behavior: "deny",
        rules: [rule(text)],
      } satisfies Parameters<typeof host.match>[0];
      assert.equal(host.match(input).status, "matched", text);
      assert.equal(
        createNativeFilePermissionHost({
          ...options(root),
          physicalTwinsEnabled: false,
        }).match(input).status,
        "no-match",
        text,
      );
    }
  }));

test("INV-01 an anchored deny through a link cycle still denies its lexical spelling", () =>
  fixture((root) => {
    symlinkSync("loop", join(root, "loop"));
    file(join(root, "other.txt"));
    const host = createNativeFilePermissionHost(options(root));
    const rules = [rule(`Read(/${join(root, "loop")}/**)`)];
    assert.equal(
      host.match({
        path: join(root, "loop", "secret.txt"),
        toolName: "Read",
        behavior: "deny",
        rules,
      }).status,
      "matched",
    );
    assert.equal(
      host.match({
        path: join(root, "other.txt"),
        toolName: "Read",
        behavior: "deny",
        rules,
      }).status,
      "no-match",
    );
  }));

test("INV-01 a host callback that throws a non-Error value yields unsupported, not a grant", () =>
  fixture((root) => {
    const host = createNativeFilePermissionHost({
      ...options(root),
      cwd: () => {
        throw "owned cwd unavailable";
      },
    });
    const result = host.match({
      path: "file.txt",
      toolName: "Read",
      behavior: "allow",
      rules: [rule("Read(**)")],
    });
    assert.equal(result.status, "unsupported");
    if (result.status === "unsupported")
      assert.equal(result.reason, "owned cwd unavailable");
  }));
