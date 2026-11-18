import { test } from "bun:test";
import assert from "node:assert/strict";
import type { NativeFilePermissionInspection } from "../../src/native-file-adjudication.js";
import {
  inspectNativeMetadataPath,
  inspectNativePermissionPath,
  inspectNativeScreenPath,
  NativeMetadataPathError,
  nativeAutomountRoot,
  nativeKernelPath,
  nativeLocalWslPath,
  nativeNetworkHost,
  nativeNetworkVolume,
  nativeUncPath,
  type NativePermissionPathContext,
  type NativePermissionPathFilesystem,
} from "../../src/native-path-inspection.js";

function errno(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/**
 * A synthetic tree where every path exists as a plain directory unless it is
 * a listed symlink or has a listed lstat failure (thrown exactly as given).
 */
function tree(
  links: Record<string, string>,
  failures: Record<string, unknown> = {},
  overrides: Partial<NativePermissionPathFilesystem> = {},
): NativePermissionPathFilesystem & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    lstat(path) {
      probed.push(path);
      if (Object.hasOwn(failures, path)) throw failures[path];
      return { isSymbolicLink: () => Object.hasOwn(links, path) };
    },
    openDirectoryNoFollow: () => errno("EACCES"),
    readlink(path) {
      const text = links[path];
      return text === undefined ? errno("EINVAL") : text;
    },
    realpath: (path) => path,
    ...overrides,
  };
}

function context(
  filesystem: NativePermissionPathFilesystem,
  overrides: Partial<NativePermissionPathContext> = {},
): NativePermissionPathContext {
  return {
    cwd: "/owned/work",
    home: "/owned/home",
    initialCwd: "/owned/work",
    macos: true,
    filesystem,
    ...overrides,
  };
}

function landingOf(result: NativeFilePermissionInspection): string {
  if (result.unresolved)
    assert.fail(`expected a landing, stopped at ${result.stoppedAt}`);
  return result.landing;
}

function refuses(run: () => unknown, reason: "unexamined" | "network"): void {
  assert.throws(
    run,
    (error) =>
      error instanceof NativeMetadataPathError && error.reason === reason,
  );
}

const plainHost = { homeIsAutomount: false };

test("lexical classifiers fold dot segments before naming network, kernel and WSL shapes", () => {
  // win32 normalization folds the climb into an NT object-namespace prefix.
  assert.equal(nativeUncPath("/x/../??/share"), true);
  assert.equal(nativeUncPath("/x??/share"), false);
  assert.equal(nativeLocalWslPath("//wsl$/Ubuntu/home"), true);
  assert.equal(nativeLocalWslPath("//wsl.localhost/./home"), false);
  assert.equal(nativeLocalWslPath("//wsl$/"), false);
  assert.equal(nativeLocalWslPath("/home/user"), false);
  assert.equal(nativeNetworkHost("/x/../net/host/a"), "/net/host");
  assert.equal(
    nativeNetworkHost("/a/../Network/Servers/h/x"),
    "/Network/Servers/h",
  );
  assert.equal(nativeNetworkHost("relative/net/host"), null);
  assert.equal(nativeNetworkVolume("/x/../Network/a"), true);
  assert.equal(nativeNetworkVolume("/x/../y"), false);
  assert.equal(nativeKernelPath("/x/../.vol/1"), true);
  assert.equal(nativeKernelPath("/x/../y"), false);
  assert.equal(nativeAutomountRoot("/x/../net"), true);
});

test("a link to a share spelling with dot segments lands at the share prefix before the dots", () => {
  for (const [text, share] of [
    ["//server/share/../x", "//server/share"],
    ["//server/./x", "//server"],
    ["/net/host/../x", "/net/host"],
  ]) {
    const result = inspectNativePermissionPath(
      "/owned/work/link",
      context(tree({ "/owned/work/link": text ?? "" })),
    );
    assert.equal(landingOf(result), share);
    assert.equal(result.endsUnexamined, true);
    assert.equal(result.leafIsSymlink, false);
  }
});

test("a non-macOS context still recognises an absolute network link target", () => {
  const filesystem = tree({ "/owned/work/link": "/net/host/a" });
  const result = inspectNativePermissionPath(
    "/owned/work/link",
    context(filesystem, { macos: false }),
  );
  assert.equal(landingOf(result), "/net/host/a");
  assert.equal(result.endsUnexamined, true);
  assert.ok(!filesystem.probed.some((path) => path.startsWith("/net")));
});

test("errno is read from code, then a string errno, and anything else is unexamined", () => {
  const missing = { errno: "ENOENT" };
  const numericCode = { code: -2, errno: "ENOENT" };
  for (const thrown of [missing, numericCode]) {
    const result = inspectNativePermissionPath(
      "/owned/work/new",
      context(tree({}, { "/owned/work/new": thrown })),
    );
    assert.equal(landingOf(result), "/owned/work/new");
  }
  for (const thrown of ["boom", null, { code: -2 }]) {
    const result = inspectNativePermissionPath(
      "/owned/work/odd",
      context(tree({}, { "/owned/work/odd": thrown })),
    );
    assert.equal(result.unresolved, true);
    if (result.unresolved) {
      assert.equal(result.reason, "unexamined");
      assert.equal(result.stoppedAt, "/owned/work/odd");
    }
  }
});

test("tilde requests expand against the explicit home", () => {
  const filesystem = tree({});
  const home = inspectNativePermissionPath("~", context(filesystem));
  assert.equal(home.requested, "/owned/home");
  assert.equal(landingOf(home), "/owned/home");
  const child = inspectNativePermissionPath("~/notes", context(filesystem));
  assert.equal(child.requested, "/owned/home/notes");
  assert.equal(landingOf(child), "/owned/home/notes");
});

test("a relative link that climbs to the filesystem root stops at the network component", () => {
  const filesystem = tree({
    "/owned/work/host": "../../net/host/share",
    "/owned/work/volume": "../../Network/x",
  });
  const host = inspectNativePermissionPath(
    "/owned/work/host",
    context(filesystem),
  );
  assert.equal(landingOf(host), "/net/host/share");
  assert.equal(host.endsUnexamined, true);
  const volume = inspectNativePermissionPath(
    "/owned/work/volume",
    context(filesystem),
  );
  assert.equal(landingOf(volume), "/Network/x");
  assert.ok(
    !filesystem.probed.some(
      (path) => path.startsWith("/net/") || path.startsWith("/Network"),
    ),
  );
  refuses(
    () =>
      inspectNativeMetadataPath(
        "/owned/work/host",
        context(filesystem),
        plainHost,
      ),
    "network",
  );
});

test("dot segments after a descriptor entry fold back without probing descriptors", () => {
  const filesystem = tree({
    "/owned/work/dot": "/dev/fd/0/./../x",
    "/owned/work/up": "/dev/fd/1/../y",
  });
  assert.equal(
    landingOf(
      inspectNativePermissionPath("/owned/work/dot", context(filesystem)),
    ),
    "/dev/fd/x",
  );
  assert.equal(
    landingOf(
      inspectNativePermissionPath("/owned/work/up", context(filesystem)),
    ),
    "/dev/fd/y",
  );
  assert.ok(!filesystem.probed.some((path) => /^\/dev\/fd\/[^/]+/.test(path)));
});

test("a link to the bare automount root ends at that root", () => {
  const filesystem = tree({ "/owned/work/link": "/net" });
  const result = inspectNativePermissionPath(
    "/owned/work/link",
    context(filesystem),
  );
  assert.equal(landingOf(result), "/net");
  assert.equal(result.endsUnexamined, true);
  refuses(
    () =>
      inspectNativeMetadataPath(
        "/owned/work/link",
        context(filesystem),
        plainHost,
      ),
    "network",
  );
  refuses(
    () =>
      inspectNativeMetadataPath(
        "/owned/work/volume",
        context(tree({ "/owned/work/volume": "/Network" })),
        plainHost,
      ),
    "network",
  );
});

test("unreadable launch ancestry advances only when initialCwd shares that ancestor", () => {
  const filesystem = tree({}, { "/owned": { code: "EACCES" } });
  for (const initialCwd of [null, "/elsewhere/start"]) {
    const screened = inspectNativeScreenPath(
      "/owned/work/f",
      context(filesystem, { initialCwd }),
    );
    assert.equal(screened.unresolved, true);
    if (screened.unresolved) assert.equal(screened.reason, "unexamined");
    refuses(
      () =>
        inspectNativeMetadataPath(
          "/owned/work/f",
          context(filesystem, { initialCwd }),
          plainHost,
        ),
      "unexamined",
    );
  }
  const shared = context(filesystem, { initialCwd: "/owned/work" });
  assert.equal(
    landingOf(inspectNativeScreenPath("/owned/work/f", shared)),
    "/owned/work/f",
  );
  assert.equal(
    inspectNativeMetadataPath("/owned/work/f", shared, plainHost)
      .linksResolvedPath,
    "/owned/work/f",
  );
  // Past an unverified ancestor, a dot-only component cannot be trusted.
  const dotted = inspectNativePermissionPath("/owned/work/...", shared);
  assert.equal(dotted.unresolved, true);
  if (dotted.unresolved) assert.equal(dotted.reason, "unexamined");
});

test("metadata accepts only a clean overlong first component as unprobed", () => {
  const filesystem = tree(
    { "/owned/work/link": "long" },
    {
      "/owned/work/long": { code: "ENAMETOOLONG" },
      "/owned/work/long.": { code: "ENAMETOOLONG" },
    },
  );
  const clean = inspectNativeMetadataPath(
    "/owned/work/long",
    context(filesystem),
    plainHost,
  );
  assert.equal(clean.resolvedPath, "/owned/work/long");
  assert.equal(clean.linksResolvedPath, undefined);
  assert.equal(clean.absentAt, undefined);
  for (const path of [
    "/owned/work/long.",
    "/owned/work/link",
    "/owned/work/long/...",
  ])
    refuses(
      () => inspectNativeMetadataPath(path, context(filesystem), plainHost),
      "unexamined",
    );
});

test("metadata strips Win32 long-path prefixes and refuses residual device spellings", () => {
  const filesystem = tree({});
  const unc = inspectNativeMetadataPath(
    "\\\\?\\UNC\\server\\share\\f",
    context(filesystem),
    plainHost,
  );
  assert.equal(unc.resolvedPath, "/owned/work/\\\\server\\share\\f");
  const drive = inspectNativeMetadataPath(
    "\\\\?\\C:\\dir\\f",
    context(filesystem),
    plainHost,
  );
  assert.equal(drive.resolvedPath, "/owned/work/C:\\dir\\f");
  for (const path of ["\\\\?\\ab", "\\\\?\\abc", "/a/../??/x"])
    refuses(
      () => inspectNativeMetadataPath(path, context(filesystem), plainHost),
      "unexamined",
    );
});

test("metadata never probes a path whose Windows spelling is an NT namespace", () => {
  const filesystem = tree({});
  const path = "/a/..\\..\\??\\y";
  const result = inspectNativeMetadataPath(
    path,
    context(filesystem),
    plainHost,
  );
  assert.equal(result.resolvedPath, path);
  assert.equal(result.linksResolvedPath, undefined);
  assert.equal(result.absentAt, undefined);
  assert.deepEqual(filesystem.probed, []);
});

test("metadata refuses link text naming a foreign share, device or namespace", () => {
  // The NT-namespace spelling's prefix before its dots ("/a") is no network
  // shape, so that refusal reports an unexamined component instead.
  for (const [text, reason] of [
    ["//server/share", "network"],
    ["///x", "network"],
    ["//./pipe/x", "network"],
    ["//server/../x", "network"],
    ["/a/../??/x", "unexamined"],
  ] as const)
    for (const path of ["/owned/work/link", "/net/host/link"])
      refuses(
        () =>
          inspectNativeMetadataPath(
            path,
            context(tree({ [path]: text })),
            plainHost,
          ),
        reason,
      );
});

test("metadata refuses an automount link that continues into a host", () => {
  const filesystem = tree({
    "/owned/work/auto": "/net",
    "/owned/work/climb": "auto/host/../x",
    "/owned/work/back": "auto/..",
  });
  for (const path of ["/owned/work/auto/host/x", "/owned/work/climb"])
    refuses(
      () => inspectNativeMetadataPath(path, context(filesystem), plainHost),
      "network",
    );
  assert.ok(!filesystem.probed.some((path) => path.startsWith("/net/")));
  // Leaving the automount root again lands lexically at its parent.
  assert.equal(
    inspectNativeMetadataPath(
      "/owned/work/back",
      context(filesystem),
      plainHost,
    ).linksResolvedPath,
    "/",
  );
});

test("metadata relative link text is checked against the raw joined host", () => {
  for (const [path, text] of [
    ["/link", "net/host/x"],
    ["/owned/work/link", "../../net/host/../other"],
  ])
    refuses(
      () =>
        inspectNativeMetadataPath(
          path ?? "",
          context(tree({ [path ?? ""]: text ?? "" })),
          plainHost,
        ),
      "network",
    );
});

test("metadata refuses dotted same-provider link text whatever aliases it passes", () => {
  const texts = [
    "/net/host/../host/y",
    "/.vol/../net/host",
    "/home/bob/../../net/host/y",
    "/System/Volumes/Data/home/bob/../../../../../net/host/y",
    "/System/Volumes/Data/usr/local/../../../../../net/host/y",
    "/System/Volumes/Data/Users/x/../../../../../net/host/y",
    "/System/Volumes/Data/xyz/../../../../net/host/y",
    "/System/Volumes/Other/x/../../../../net/host/y",
    "/System/Other/a/b/../../../../net/host/y",
    "/net/host/a/b/c/d/e/../../../../../../../net/host/y",
  ];
  for (const home of ["/System/Volumes/Data/home/alice", "/home/bob"])
    for (const text of texts)
      refuses(
        () =>
          inspectNativeMetadataPath(
            "/net/host/link/rest",
            context(tree({ "/net/host/link": text }), { home }),
            { homeIsAutomount: true },
          ),
        "network",
      );
});

test("metadata dotted link text that stays local walks on, while volume and automount text refuses", () => {
  const filesystem = tree({
    "/owned/work/local": "/owned/x/../file",
    "/owned/work/volume": "/Network/../Network/x",
    "/owned/work/auto": "/net/.",
  });
  assert.equal(
    inspectNativeMetadataPath(
      "/owned/work/local",
      context(filesystem),
      plainHost,
    ).linksResolvedPath,
    "/owned/file",
  );
  for (const path of ["/owned/work/volume", "/owned/work/auto"])
    refuses(
      () => inspectNativeMetadataPath(path, context(filesystem), plainHost),
      "network",
    );
});

test("metadata compares a host link against an own volume anchor by provider", () => {
  refuses(
    () =>
      inspectNativeMetadataPath(
        "/Network/foo/link",
        context(tree({ "/Network/foo/link": "/net/host/x" })),
        plainHost,
      ),
    "network",
  );
});

test("metadata own Network volume walks its share but refuses a different share", () => {
  const own = inspectNativeMetadataPath(
    "/Network/share/x",
    context(tree({})),
    plainHost,
  );
  assert.equal(own.linksResolvedPath, "/Network/share/x");
  const filesystem = tree({
    "/Network/share/root/y": "/Network",
    "/Network/share/sibling": "/Network/share/other",
    "/Network/share/up": "..",
  });
  for (const path of [
    "/Network/share/root/y/z",
    "/Network/share/sibling",
    "/Network/share/up",
  ])
    refuses(
      () => inspectNativeMetadataPath(path, context(filesystem), plainHost),
      "network",
    );
});

test("permission link text that reaches a network host only after climbing is followed lexically", () => {
  const filesystem = tree({
    "/owned/work/host": "/a/b/../../net/host/z",
    "/owned/work/volume": "/x/../Network/y",
    "/owned/work/opaque": "/a/b/../../net/h\uFFFD",
    "/owned/work/opaqueVolume": "/x/../Network/\uFFFD",
    "/owned/work/hop": "/hop/../Network/y",
    "/hop": "/elsewhere\uFFFD",
  });
  assert.equal(
    landingOf(
      inspectNativePermissionPath("/owned/work/host", context(filesystem)),
    ),
    "/net/host/z",
  );
  assert.equal(
    landingOf(
      inspectNativePermissionPath("/owned/work/volume", context(filesystem)),
    ),
    "/Network/y",
  );
  // Opaque text anywhere after a network-bound target refuses.
  for (const path of [
    "/owned/work/opaque",
    "/owned/work/opaqueVolume",
    "/owned/work/hop",
  ]) {
    const opaque = inspectNativePermissionPath(path, context(filesystem));
    assert.equal(opaque.unresolved, true);
    if (opaque.unresolved) assert.equal(opaque.reason, "past-a-link");
  }
});

test("permission refuses network link text that is not valid UTF-8", () => {
  const result = inspectNativePermissionPath(
    "/owned/work/link",
    context(tree({ "/owned/work/link": "/net/h\uFFFD/x" })),
  );
  assert.equal(result.unresolved, true);
  if (result.unresolved) assert.equal(result.reason, "past-a-link");
});

test("screen probes climbing links that land on a network share or another climbing link", () => {
  const direct = inspectNativeScreenPath(
    "/owned/work/l",
    context(tree({ "/owned/work/l": "d/../../../net/host" })),
  );
  assert.equal(landingOf(direct), "/net/host");
  assert.equal(direct.linkTextClimbs, true);
  const nested = inspectNativeScreenPath(
    "/owned/work/l",
    context(tree({ "/owned/work/l": "d/../m", "/owned/work/m": "e/../f" })),
  );
  assert.equal(landingOf(nested), "/owned/work/f");
  assert.equal(nested.linkTextClimbs, true);
  const throughNetwork = inspectNativeScreenPath(
    "/owned/work/l",
    context(
      tree({ "/owned/work/l": "d/../n", "/owned/work/n": "/net/host/x" }),
    ),
  );
  assert.equal(landingOf(throughNetwork), "/net/host/x");
  assert.ok(throughNetwork.spellings.includes("/net/host/x"));
});

test("screen refuses a nine-link climbing chain that ends on a network share or a cycle", () => {
  for (const end of ["/net/host", "l9"]) {
    const links: Record<string, string> = {};
    for (let index = 0; index < 9; index++)
      links[`/owned/work/l${index}`] = `d/../l${index + 1}`;
    links["/owned/work/l9"] = end;
    const result = inspectNativeScreenPath(
      "/owned/work/l0",
      context(tree(links)),
    );
    assert.equal(result.unresolved, true);
  }
});

test("a canonical ancestor adds its physical spelling unless it matches after NFC", () => {
  const physical = inspectNativePermissionPath(
    "/owned/work/new",
    context(
      tree(
        {},
        { "/owned/work/new": { code: "ENOENT" } },
        {
          realpath: (path) =>
            path === "/owned/work" ? "/physical/work" : path,
        },
      ),
    ),
  );
  assert.equal(landingOf(physical), "/owned/work/new");
  assert.ok(physical.spellings.includes("/physical/work/new"));
  const decomposed = "/owned/cafe\u0301";
  const composed = decomposed.normalize("NFC");
  const nfc = inspectNativePermissionPath(
    decomposed,
    context(tree({}, {}, { realpath: (path) => path.normalize("NFC") })),
  );
  assert.equal(landingOf(nfc), composed);
  assert.deepEqual(nfc.spellings, [decomposed, composed]);
});
