import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  inspectNativePermissionPath,
  inspectNativeMetadataPath,
  inspectNativeScreenPath,
  NativeMetadataPathError,
  nativeLocalPermissionPathFilesystem,
  nativeNetworkHost,
  nativeNetworkVolume,
  nativePermissionPathContained,
  normalizeNativePermissionPath,
  type NativePermissionPathContext,
  type NativePermissionPathFilesystem,
} from "../src/native-path-inspection.js";

function owned(
  run: (root: string, context: NativePermissionPathContext) => void,
) {
  const root = realpathSync(
    mkdtempSync(posix.join(tmpdir(), "tau-native-inspection-")),
  );
  const context: NativePermissionPathContext = {
    cwd: root,
    home: posix.join(root, "home"),
    initialCwd: root,
    filesystem: nativeLocalPermissionPathFilesystem,
    macos: true,
  };
  try {
    run(root, context);
  } finally {
    rmSync(root, { recursive: true });
  }
}
function errno(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function metadata(
  overrides: Partial<NativePermissionPathFilesystem> = {},
): NativePermissionPathFilesystem {
  return {
    lstat: () => ({ isSymbolicLink: () => false }),
    openDirectoryNoFollow: () => errno("EACCES"),
    readlink: () => errno("EINVAL"),
    realpath: (path) => path,
    ...overrides,
  };
}
const synthetic: NativePermissionPathContext = {
  cwd: "/owned/work",
  home: "/owned/home",
  initialCwd: "/owned/work",
  macos: true,
  filesystem: metadata(),
};

test("mb trims while pa preserves the input spelling and Bash-style spaces", () => {
  owned((root, context) => {
    writeFileSync(posix.join(root, " selected "), "authored");
    const lexical = inspectNativePermissionPath(" selected ", context);
    assert.equal(lexical.requested, " selected ");
    assert.equal(lexical.unresolved, false);
    if (!lexical.unresolved)
      assert.equal(lexical.landing, posix.join(root, " selected "));
    assert.equal(
      normalizeNativePermissionPath(" selected ", context, true),
      posix.join(root, "selected"),
    );
    assert.equal(normalizeNativePermissionPath("~", context), context.home);
    assert.equal(
      normalizeNativePermissionPath(" ~/child ", context),
      posix.join(context.home, "child"),
    );
    assert.throws(
      () => normalizeNativePermissionPath("./directory /.", context, true),
      /UnstablePath/,
    );
  });
});

test("real leaf and parent symlinks preserve lexical and physical spellings", () => {
  owned((root, context) => {
    mkdirSync(posix.join(root, "target"));
    writeFileSync(posix.join(root, "target/file"), "authored");
    symlinkSync("target/file", posix.join(root, "leaf"));
    symlinkSync("target", posix.join(root, "parent"));
    const leaf = inspectNativePermissionPath(posix.join(root, "leaf"), context);
    assert.equal(leaf.leafIsSymlink, true);
    assert.ok(leaf.spellings.includes(posix.join(root, "target/file")));
    const parent = inspectNativePermissionPath(
      posix.join(root, "parent/file"),
      context,
    );
    assert.equal(parent.leafIsSymlink, false);
    assert.ok(parent.spellings.some((value) => value.endsWith("/target/file")));
  });
});

test("missing leaf resolves via actual existing parent; a link target retaining dots refuses", () => {
  owned((root, context) => {
    const absent = inspectNativePermissionPath(
      posix.join(root, "new/file"),
      context,
    );
    assert.equal(absent.unresolved, false);
    symlinkSync("missing/../file", posix.join(root, "link"));
    const linked = inspectNativePermissionPath(
      posix.join(root, "link"),
      context,
    );
    assert.equal(linked.unresolved, true);
    if (linked.unresolved) {
      assert.equal(linked.reason, "past-a-link");
      assert.equal("landing" in linked, false);
    }
  });
});

test("actual repeated link and 64-hop chain refuse without invented landings", () => {
  owned((root, context) => {
    symlinkSync("cycle", posix.join(root, "cycle"));
    assert.equal(
      inspectNativePermissionPath(posix.join(root, "cycle"), context)
        .unresolved,
      true,
    );
    for (let index = 0; index < 65; index++)
      symlinkSync(`hop${index + 1}`, posix.join(root, `hop${index}`));
    const result = inspectNativePermissionPath(
      posix.join(root, "hop0"),
      context,
    );
    assert.equal(result.unresolved, true);
    assert.equal("landing" in result, false);
  });
});

test("network landings never probe metadata; missing lexical dot prefixes remain network", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: () => {
        throw new Error("must not probe");
      },
    }),
  };
  for (const path of [
    "//server/share",
    "/net/host/file",
    "/Network/Servers/host/file",
    "/Network/../owned",
  ])
    assert.deepEqual(inspectNativePermissionPath(path, context), {
      unresolved: false,
      requested: path,
      spellings: [path],
      landing: path,
      leafIsSymlink: false,
      endsUnexamined: true,
    });
  assert.equal(nativeNetworkHost("/net/host/../local"), "/net/host");
  assert.equal(nativeNetworkVolume("/Network/../owned"), true);
  assert.equal(nativeNetworkHost("/n\u200det/host/path"), "/n\u200det/host");
});

test("symlink to a network landing is recorded without probing target", () => {
  const calls: string[] = [];
  const filesystem = metadata({
    lstat(path) {
      calls.push(path);
      return { isSymbolicLink: () => path === "/owned/link" };
    },
    readlink: () => "/net/host/file",
  });
  const result = inspectNativePermissionPath("/owned/link", {
    ...synthetic,
    filesystem,
  });
  assert.equal(result.unresolved, false);
  if (!result.unresolved) assert.equal(result.landing, "/net/host/file");
  assert.equal(result.endsUnexamined, true);
  assert.ok(result.spellings.includes("/net/host/file"));
  assert.ok(calls.every((path) => !path.startsWith("/net")));
});

test("permission EACCES fallback is confined to paths with no readlink attempt", () => {
  const filesystem = metadata({ lstat: () => errno("EACCES") });
  const result = inspectNativePermissionPath("/outside/file", {
    ...synthetic,
    filesystem,
  });
  assert.equal(result.unresolved, false);
  const afterLink = inspectNativePermissionPath("/owned/link", {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) =>
        path === "/owned/link"
          ? { isSymbolicLink: () => true }
          : { isSymbolicLink: () => false },
      readlink: () => errno("EACCES"),
    }),
  });
  assert.equal(afterLink.unresolved, true);
});

test("no-follow directory-open success handles a metadata permission failure", () => {
  let opened = 0;
  const filesystem = metadata({
    lstat: (path) =>
      path === "/owned" ? errno("EACCES") : { isSymbolicLink: () => false },
    openDirectoryNoFollow() {
      opened++;
    },
  });
  const result = inspectNativePermissionPath("/owned/file", {
    ...synthetic,
    filesystem,
  });
  assert.equal(result.unresolved, false);
  assert.equal(opened, 1);
});

test("opaque replacement-character link text refuses after retaining source spellings", () => {
  const filesystem = metadata({
    lstat: (path) => ({ isSymbolicLink: () => path === "/owned/link" }),
    readlink: () => "target\uFFFD",
  });
  const result = inspectNativePermissionPath("/owned/link", {
    ...synthetic,
    filesystem,
  });
  assert.equal(result.unresolved, true);
  assert.ok(result.spellings.includes("/owned/target\uFFFD"));
});

test("kernel paths refuse and dev-fd children are absent without probing descriptors", () => {
  const calls: string[] = [];
  const filesystem = metadata({
    lstat(path) {
      calls.push(path);
      return { isSymbolicLink: () => false };
    },
  });
  assert.equal(
    inspectNativePermissionPath("/.vol/123/file", { ...synthetic, filesystem })
      .unresolved,
    true,
  );
  const result = inspectNativePermissionPath("/dev/fd/3", {
    ...synthetic,
    filesystem,
  });
  assert.equal(result.unresolved, false);
  assert.ok(!calls.includes("/dev/fd/3"));
});

test("foreign relative roots and null bytes are rejected rather than reading process defaults", () => {
  assert.throws(
    () => inspectNativePermissionPath("x", { ...synthetic, cwd: "relative" }),
    /explicit absolute/,
  );
  assert.throws(
    () => normalizeNativePermissionPath("x\0y", synthetic),
    /null byte/,
  );
  assert.throws(
    () => normalizeNativePermissionPath("x", { ...synthetic, cwd: "relative" }),
    /explicit absolute/,
  );
});

test("final canonical spellings do not impersonate opaque readlink text", () => {
  const result = inspectNativePermissionPath("/owned/file", {
    ...synthetic,
    filesystem: metadata({ realpath: () => "/canonical/\uFFFD" }),
  });
  assert.equal(result.unresolved, false);
  assert.ok(result.spellings.includes("/canonical/\uFFFD"));
});

test("unreadable launch ancestry can advance before an existing component is examined", () => {
  const calls: string[] = [];
  const result = inspectNativePermissionPath("/owned/work/file", {
    ...synthetic,
    filesystem: metadata({
      lstat(path) {
        calls.push(path);
        if (path === "/owned") return errno("EACCES");
        return { isSymbolicLink: () => false };
      },
    }),
  });
  assert.equal(result.unresolved, false);
  assert.ok(calls.includes("/owned/work/file"));
});

test("no-follow directory ELOOP retains past-a-link provenance without inventing a readlink", () => {
  let readlinks = 0;
  const result = inspectNativePermissionPath("/outside/file", {
    ...synthetic,
    filesystem: metadata({
      lstat: () => errno("EIO"),
      openDirectoryNoFollow: () => errno("ELOOP"),
      readlink() {
        readlinks++;
        return "unused";
      },
    }),
  });
  assert.equal(result.unresolved, true);
  if (result.unresolved) assert.equal(result.reason, "past-a-link");
  assert.equal(readlinks, 0);
});

test("permission path inspection omits screen-only climbing flags", () => {
  const result = inspectNativePermissionPath("/owned/link", {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) => ({ isSymbolicLink: () => path === "/owned/link" }),
      readlink: () => "../outside/file",
    }),
  });
  assert.equal(result.unresolved, false);
  assert.equal("linkTextClimbs" in result, false);
  assert.equal(result.leafIsSymlink, true);
});

test("Qd comparison preserves case options, raw UNC parity and the exact private aliases", () => {
  assert.equal(
    nativePermissionPathContained("/OWNED/FILE", "/owned", synthetic),
    true,
  );
  assert.equal(
    nativePermissionPathContained("/OWNED/FILE", "/owned", synthetic, {
      caseFold: false,
    }),
    false,
  );
  assert.equal(
    nativePermissionPathContained("/OWNED/FILE", "/owned", synthetic, {}),
    false,
  );
  assert.equal(
    nativePermissionPathContained("/private/tmp/child", "/tmp", synthetic, {
      caseFold: false,
    }),
    true,
  );
  assert.equal(
    nativePermissionPathContained("/private/tmp/child", "/tmp", synthetic, {
      caseFold: false,
      skipPrivateAlias: true,
    }),
    false,
  );
  assert.equal(
    nativePermissionPathContained("/private/var", "/var", synthetic),
    false,
  );
  assert.equal(
    nativePermissionPathContained("/private/var/child", "/var", synthetic),
    true,
  );
  assert.equal(
    nativePermissionPathContained("//host/share", "/host", synthetic, {
      uncShapeParity: true,
      caseFold: true,
    }),
    false,
  );
  assert.equal(
    nativePermissionPathContained("/owned/a/../outside", "/owned/a", synthetic),
    false,
  );
  assert.equal(
    nativePermissionPathContained("/owned/../outside", "/owned", synthetic),
    false,
  );
  assert.equal(
    nativePermissionPathContained(
      "/owned/ſelected",
      "/owned/selected",
      synthetic,
    ),
    true,
  );
  assert.equal(
    nativePermissionPathContained(" /owned/file ", "/owned", synthetic),
    true,
  );
});

test("screen's cycle spelling fallback is distinct from permission identity admission", () => {
  owned((root, context) => {
    const path = posix.join(root, "cycle");
    symlinkSync("cycle", path);
    assert.equal(inspectNativePermissionPath(path, context).unresolved, true);
    const screened = inspectNativeScreenPath(path, context);
    assert.equal(screened.unresolved, false);
    if (!screened.unresolved) assert.equal(screened.landing, path);
    assert.equal(screened.leafIsSymlink, false);
  });
});

test("screen does not inherit permission EACCES spelling fallback", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({ lstat: () => errno("EACCES") }),
  };
  assert.equal(
    inspectNativePermissionPath("/outside/file", context).unresolved,
    false,
  );
  const screened = inspectNativeScreenPath("/outside/file", context);
  assert.equal(screened.unresolved, true);
  assert.equal("landing" in screened, false);
});

test("screen's missing-component dot test is stricter than permission's link-only test", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) =>
        path === "/owned/missing"
          ? errno("ENOENT")
          : { isSymbolicLink: () => false },
    }),
  };
  const path = "/owned/missing/.../file";
  assert.equal(inspectNativePermissionPath(path, context).unresolved, false);
  assert.equal(inspectNativeScreenPath(path, context).unresolved, true);
});

test("screen inspects collapsed climbing spellings separately from the physical permission landing", () => {
  owned((root, context) => {
    mkdirSync(posix.join(root, "work"));
    mkdirSync(posix.join(root, "physical"));
    mkdirSync(posix.join(root, "physical/child"));
    writeFileSync(posix.join(root, "physical/selected.md"), "owned");
    symlinkSync("../physical/child", posix.join(root, "work/inside"));
    const path = posix.join(root, "work/leaf");
    symlinkSync("inside/../selected.md", path);
    const collapsed = posix.join(root, "work/selected.md");
    const guarded = {
      ...context,
      filesystem: {
        ...context.filesystem,
        lstat(path: string) {
          if (path === collapsed) return errno("EACCES");
          return context.filesystem.lstat(path);
        },
      },
    };
    assert.equal(inspectNativePermissionPath(path, guarded).unresolved, false);
    assert.equal(inspectNativeScreenPath(path, guarded).unresolved, true);
  });
});

test("screen preserves the exact eight-distinct-climbing-probe bound", () => {
  for (const count of [8, 9])
    owned((root, context) => {
      mkdirSync(posix.join(root, "branch"));
      writeFileSync(posix.join(root, "target"), "owned");
      for (let index = 0; index < count; index++)
        symlinkSync(
          `branch/../${index === count - 1 ? "target" : "hop" + (index + 1)}`,
          posix.join(root, "hop" + index),
        );
      const path = posix.join(root, "hop0");
      assert.equal(
        inspectNativePermissionPath(path, context).unresolved,
        false,
      );
      const screened = inspectNativeScreenPath(path, context);
      assert.equal(screened.unresolved, count === 9);
      if (!screened.unresolved) assert.equal(screened.linkTextClimbs, true);
    });
});

test("screen excludes leading relative climbs from its extra-probe marker", () => {
  owned((root, context) => {
    mkdirSync(posix.join(root, "subdir"));
    writeFileSync(posix.join(root, "target"), "owned");
    const path = posix.join(root, "subdir/link");
    symlinkSync("../target", path);
    const screened = inspectNativeScreenPath(path, context);
    assert.equal(screened.unresolved, false);
    assert.equal("linkTextClimbs" in screened, false);
  });
});

test("screen never treats a readlink failure as the cycle spelling fallback", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) => ({ isSymbolicLink: () => path === "/owned/link" }),
      readlink: () => errno("ENOENT"),
    }),
  };
  assert.equal(
    inspectNativeScreenPath("/owned/link", context).unresolved,
    true,
  );
});

test("metadata retains resolved written spelling, NFC result, and never enriches through realpath", () => {
  owned((root, context) => {
    const raw = "selected-e\u0301 ";
    writeFileSync(posix.join(root, raw), "owned");
    const result = inspectNativeMetadataPath(
      raw,
      {
        ...context,
        filesystem: {
          ...context.filesystem,
          realpath: () =>
            assert.fail("dI does not perform final realpath enrichment"),
        },
      },
      { homeIsAutomount: false },
    );
    assert.deepEqual(result, {
      resolvedPath: posix.join(root, raw),
      isSymlink: false,
      isCanonical: false,
      linksResolvedPath: posix.join(root, raw).normalize("NFC"),
      absentAt: undefined,
    });
    const tilde = inspectNativeMetadataPath("~/file", context, {
      homeIsAutomount: false,
    });
    assert.equal(tilde.resolvedPath, posix.join(root, "~/file"));
    assert.notEqual(tilde.resolvedPath, posix.join(context.home, "file"));
  });
});

test("metadata missing tails retain actual ENOENT versus ENOTDIR observations", () => {
  owned((root, context) => {
    writeFileSync(posix.join(root, "regular"), "owned");
    const missing = inspectNativeMetadataPath("absent/file", context, {
      homeIsAutomount: false,
    });
    assert.deepEqual(missing.absentAt, {
      at: root,
      remaining: ["absent", "file"],
      fromLinkTarget: false,
    });
    const notDirectory = inspectNativeMetadataPath("regular/file", context, {
      homeIsAutomount: false,
    });
    assert.deepEqual(notDirectory.absentAt, {
      at: posix.join(root, "regular"),
      remaining: ["file"],
      fromLinkTarget: false,
      notAFolder: true,
    });
    assert.equal(notDirectory.linksResolvedPath, undefined);
  });
});

test("metadata fromLinkTarget follows the mutable pre-expansion tail count", () => {
  owned((root, context) => {
    mkdirSync(posix.join(root, "target"));
    symlinkSync("missing", posix.join(root, "missing-link"));
    symlinkSync("target", posix.join(root, "directory-link"));
    const targetMissing = inspectNativeMetadataPath("missing-link", context, {
      homeIsAutomount: false,
    });
    assert.deepEqual(targetMissing.absentAt, {
      at: root,
      remaining: ["missing"],
      fromLinkTarget: true,
    });
    const tailMissing = inspectNativeMetadataPath(
      "directory-link/missing",
      context,
      { homeIsAutomount: false },
    );
    assert.deepEqual(tailMissing.absentAt, {
      at: posix.join(root, "target"),
      remaining: ["missing"],
      fromLinkTarget: false,
    });
  });
});

test("metadata preserves native link-cycle undefined outcome and rejects hop exhaustion", () => {
  owned((root, context) => {
    symlinkSync("cycle", posix.join(root, "cycle"));
    const cycle = inspectNativeMetadataPath("cycle", context, {
      homeIsAutomount: false,
    });
    assert.equal(cycle.linksResolvedPath, undefined);
    assert.equal(cycle.absentAt, undefined);
    for (let index = 0; index < 65; index++)
      symlinkSync("hop" + (index + 1), posix.join(root, "hop" + index));
    assert.throws(
      () =>
        inspectNativeMetadataPath("hop0", context, { homeIsAutomount: false }),
      (error) =>
        error instanceof NativeMetadataPathError &&
        error.reason === "unexamined",
    );
  });
});

test("metadata unreadable ancestry and undecodable links refuse without pa fallback or screen probes", () => {
  const denied = {
    ...synthetic,
    filesystem: metadata({ lstat: () => errno("EACCES") }),
  };
  assert.throws(
    () =>
      inspectNativeMetadataPath("/outside/file", denied, {
        homeIsAutomount: false,
      }),
    (error) =>
      error instanceof NativeMetadataPathError && error.reason === "unexamined",
  );
  let links = 0;
  const undecoded = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) => ({ isSymbolicLink: () => path === "/owned/link" }),
      readlink: () => {
        links++;
        return "branch/../\uFFFD";
      },
    }),
  };
  assert.throws(
    () =>
      inspectNativeMetadataPath("/owned/link", undecoded, {
        homeIsAutomount: false,
      }),
    (error) =>
      error instanceof NativeMetadataPathError &&
      error.message.includes("not valid UTF-8"),
  );
  assert.equal(links, 1);
});

test("metadata own-host default unreadable flags differ from explicit failClosed", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({ lstat: () => errno("EACCES") }),
  };
  const raw = inspectNativeMetadataPath("/net/server/file", context, {
    homeIsAutomount: false,
  });
  assert.equal(raw.resolvedPath, "/net/server/file");
  assert.equal(raw.linksResolvedPath, undefined);
  assert.equal(raw.absentAt, undefined);
  assert.throws(
    () =>
      inspectNativeMetadataPath("/net/server/file", context, {
        homeIsAutomount: false,
        failClosed: true,
      }),
    (error) =>
      error instanceof NativeMetadataPathError && error.reason === "unexamined",
  );
});

test("metadata direct Network root is an own-host raw branch without metadata probes", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: () => assert.fail("Own-host raw Network root must not be probed"),
    }),
  };
  const result = inspectNativeMetadataPath("/Network", context, {
    homeIsAutomount: false,
  });
  assert.equal(result.resolvedPath, "/Network");
  assert.equal(result.linksResolvedPath, undefined);
});

test("metadata preserves same-provider raw access but refuses foreign network link landings", () => {
  const inspected: string[] = [];
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) => {
        inspected.push(path);
        return { isSymbolicLink: () => path === "/net/server/link" };
      },
      readlink: () => "/net/other/secret",
    }),
  };
  assert.throws(
    () =>
      inspectNativeMetadataPath("/net/server/link", context, {
        homeIsAutomount: false,
      }),
    (error) =>
      error instanceof NativeMetadataPathError && error.reason === "network",
  );
  assert.ok(inspected.includes("/net/server/link"));
  assert.ok(!inspected.some((path) => path.startsWith("/net/other")));
});

test("metadata does not canonicalize a raw own-host missing tail or probe a cross-host relative target", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) =>
        path === "/net/server/missing"
          ? errno("ENOENT")
          : { isSymbolicLink: () => false },
      realpath: () => assert.fail("No final realpath"),
    }),
  };
  const missing = inspectNativeMetadataPath(
    "/net/server/missing/file",
    context,
    { homeIsAutomount: false },
  );
  assert.deepEqual(missing.absentAt, {
    at: "/net/server",
    remaining: ["missing", "file"],
    fromLinkTarget: false,
  });
  const probes: string[] = [];
  const linked = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) => {
        probes.push(path);
        return { isSymbolicLink: () => path === "/owned/link" };
      },
      readlink: () => "../net/foreign/file",
    }),
  };
  assert.throws(
    () =>
      inspectNativeMetadataPath("/owned/link", linked, {
        homeIsAutomount: false,
      }),
    (error) =>
      error instanceof NativeMetadataPathError && error.reason === "network",
  );
  assert.ok(!probes.some((path) => path.startsWith("/net/foreign")));
});

test("metadata device namespaces fail before filesystem operations", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: () => assert.fail("Device path must not be probed"),
    }),
  };
  for (const path of [
    "\\\\.\\pipe\\name",
    "\\??\\C:\\file",
    "//?/GLOBALROOT/Device/file",
  ])
    assert.throws(
      () =>
        inspectNativeMetadataPath(path, context, { homeIsAutomount: false }),
      (error) =>
        error instanceof NativeMetadataPathError &&
        error.reason === "unexamined" &&
        error.path === path,
    );
});

test("metadata actual readlink disappearance differs from unreadable link refusal", () => {
  const base = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) => ({ isSymbolicLink: () => path === "/owned/link" }),
      readlink: () => errno("ENOENT"),
    }),
  };
  const missing = inspectNativeMetadataPath("/owned/link", base, {
    homeIsAutomount: false,
  });
  assert.equal(missing.linksResolvedPath, undefined);
  assert.equal(missing.absentAt, undefined);
  assert.throws(
    () =>
      inspectNativeMetadataPath(
        "/owned/link",
        {
          ...base,
          filesystem: { ...base.filesystem, readlink: () => errno("EACCES") },
        },
        { homeIsAutomount: false },
      ),
    (error) =>
      error instanceof NativeMetadataPathError && error.reason === "unexamined",
  );
});

test("metadata same-provider network text preserves ASCII-only provider folding", () => {
  const seen: string[] = [];
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) => {
        seen.push(path);
        return { isSymbolicLink: () => path === "/net/Ä/link" };
      },
      readlink: () => "/net/ä/secret",
    }),
  };
  assert.throws(
    () =>
      inspectNativeMetadataPath("/net/Ä/link", context, {
        homeIsAutomount: false,
      }),
    (error) =>
      error instanceof NativeMetadataPathError && error.reason === "network",
  );
  assert.ok(!seen.includes("/net/ä/secret"));
});

test("metadata climbing link text uses the core walk without screen's extra probes", () => {
  const probes: string[] = [];
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: (path) => {
        probes.push(path);
        return { isSymbolicLink: () => path === "/owned/link" };
      },
      readlink: () => "branch/../target",
      realpath: () => assert.fail("No metadata realpath enrichment"),
    }),
  };
  const result = inspectNativeMetadataPath("/owned/link", context, {
    homeIsAutomount: false,
  });
  assert.equal(result.linksResolvedPath, "/owned/target");
  assert.deepEqual(probes, [
    "/owned",
    "/owned/link",
    "/owned/branch",
    "/owned",
    "/owned/target",
  ]);
});

test("metadata requires explicit host profile facts and never reads default automount state", () => {
  const context = {
    ...synthetic,
    filesystem: metadata({
      lstat: () => assert.fail("Host facts precede any metadata operation"),
    }),
  };
  assert.throws(
    () =>
      Reflect.apply(inspectNativeMetadataPath, undefined, [
        "/owned/file",
        context,
        {
          homeIsAutomount: undefined,
        },
      ]),
    TypeError,
  );
  assert.throws(
    () =>
      inspectNativeMetadataPath(
        "/owned/file",
        { ...context, macos: false },
        { homeIsAutomount: false },
      ),
    TypeError,
  );
});

test("metadata anchored Network provider keeps partial alias prefixes and refuses a changed server", () => {
  const probes: string[] = [];
  const filesystem = metadata({
    lstat: (path) => {
      probes.push(path);
      return { isSymbolicLink: () => path === "/Network/Servers/host/link" };
    },
    readlink: () => "/Network/Servers/other/secret",
  });
  assert.throws(
    () =>
      inspectNativeMetadataPath(
        "/Network/Servers/host/link",
        { ...synthetic, filesystem },
        { homeIsAutomount: false },
      ),
    (error) =>
      error instanceof NativeMetadataPathError && error.reason === "network",
  );
  assert.ok(probes.includes("/Network/Servers/host/link"));
  assert.ok(!probes.some((path) => path.startsWith("/Network/Servers/other")));
});
