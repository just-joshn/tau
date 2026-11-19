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
import { posix } from "node:path";
import { nativeLocalPermissionPathFilesystem } from "../../src/native-path-inspection.js";
import {
  nativeLocalAncestryFilesystem,
  nativePermissionAncestryRisk,
  nativePermissionComparablePath,
  type NativeAncestryReport,
} from "../../src/native-path-ancestry.js";
import {
  nativeLocalPluginDirectoryFilesystem,
  scanNativeDevMods,
} from "../../src/native-plugin-permission-scan.js";

function owned(run: (root: string) => void) {
  const root = realpathSync(
    mkdtempSync(posix.join(tmpdir(), "tau-native-ancestry-")),
  );
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}
test("actual ancestry and uS preserve physical aliases and missing descendants", () =>
  owned((root) => {
    mkdirSync(posix.join(root, "actual"));
    symlinkSync("actual", posix.join(root, "alias"));
    const path = posix.join(root, "alias/new/file");
    const report: NativeAncestryReport = {};
    assert.equal(
      nativePermissionAncestryRisk(path, nativeLocalAncestryFilesystem, report),
      false,
    );
    assert.equal(report.metLink, true);
    assert.equal(report.endedMissing, true);
    assert.equal(
      nativePermissionComparablePath(path, {
        cwd: root,
        filesystem: nativeLocalAncestryFilesystem,
        foldCase: false,
      }),
      posix.join(root, "actual/new/file"),
    );
  }));
test("native 40-hop ancestry gate is independent of the pa 64-hop gate", () =>
  owned((root) => {
    writeFileSync(posix.join(root, "target"), "owned");
    for (let index = 40; index >= 0; index--)
      symlinkSync(
        index === 40 ? "target" : `hop${index + 1}`,
        posix.join(root, `hop${index}`),
      );
    assert.equal(
      nativePermissionAncestryRisk(
        posix.join(root, "hop1"),
        nativeLocalAncestryFilesystem,
      ),
      false,
    );
    assert.equal(
      nativePermissionAncestryRisk(
        posix.join(root, "hop0"),
        nativeLocalAncestryFilesystem,
      ),
      true,
    );
  }));
test("missing components cannot hide a later network surface; network links never probe target", () =>
  owned((root) => {
    const path =
      posix.join(root, "missing") +
      "/" +
      "../".repeat(root.split("/").filter(Boolean).length + 1) +
      "net/host/file";
    assert.equal(
      nativePermissionAncestryRisk(path, nativeLocalAncestryFilesystem),
      true,
    );
    symlinkSync("/net/host/file", posix.join(root, "network"));
    const calls: string[] = [];
    const filesystem = {
      ...nativeLocalAncestryFilesystem,
      lstat(path: string) {
        calls.push(path);
        return nativeLocalAncestryFilesystem.lstat(path);
      },
    };
    assert.equal(
      nativePermissionAncestryRisk(posix.join(root, "network"), filesystem),
      true,
    );
    assert.ok(calls.every((path) => !path.startsWith("/net/")));
  }));
test("unreadable ancestry stays risky and comparable fallback does not discover an invented physical path", () => {
  const filesystem = {
    ...nativeLocalAncestryFilesystem,
    lstat(): never {
      throw Object.assign(new Error("owned synthetic EACCES"), {
        code: "EACCES",
      });
    },
    realpath(): never {
      throw new Error("must not canonicalize risky ancestry");
    },
  };
  const report: NativeAncestryReport = {};
  assert.equal(
    nativePermissionAncestryRisk("/owned/file", filesystem, report),
    true,
  );
  assert.equal(report.unclassifiable, "EACCES");
  assert.equal(
    nativePermissionComparablePath("/owned/file", {
      cwd: "/owned",
      filesystem,
    }),
    "/owned/file",
  );
});
test("actual old/new dev-mod scans retain external link landings", () =>
  owned((root) => {
    const mods = posix.join(root, "dev-mods");
    const outside = posix.join(root, "outside");
    mkdirSync(mods);
    mkdirSync(outside);
    symlinkSync("../outside", posix.join(mods, "plugin"));
    for (const followLinks of [false, true]) {
      const scan = scanNativeDevMods({
        root: mods,
        followLinks,
        context: {
          cwd: root,
          home: root,
          initialCwd: root,
          macos: true,
          filesystem: nativeLocalPermissionPathFilesystem,
        },
        filesystem: nativeLocalPluginDirectoryFilesystem,
      });
      assert.equal(scan.isWhole, true);
      assert.ok(scan.links.includes(outside));
    }
  }));
test("new scan unresolved links use the actual L5 screen profile", () =>
  owned((root) => {
    const mods = posix.join(root, "dev-mods");
    mkdirSync(mods);
    symlinkSync("cycle", posix.join(mods, "cycle"));
    const context = {
      cwd: root,
      home: root,
      initialCwd: root,
      macos: true,
      filesystem: nativeLocalPermissionPathFilesystem,
    };
    const first = scanNativeDevMods({
      root: mods,
      followLinks: true,
      context,
      filesystem: nativeLocalPluginDirectoryFilesystem,
    });
    assert.equal(first.isWhole, true);
    rmSync(posix.join(mods, "cycle"));
    const links = posix.join(root, "chain");
    mkdirSync(links);
    for (let index = 0; index < 65; index++)
      symlinkSync(`hop${index + 1}`, posix.join(links, `hop${index}`));
    symlinkSync(posix.join(links, "hop0"), posix.join(mods, "long-chain"));
    const second = scanNativeDevMods({
      root: mods,
      followLinks: true,
      context,
      filesystem: nativeLocalPluginDirectoryFilesystem,
    });
    assert.equal(second.isWhole, false);
  }));
test("dev-mod scan completeness distinguishes missing roots from unavailable metadata", () => {
  const context = {
    cwd: "/owned",
    home: "/owned",
    initialCwd: "/owned",
    macos: true,
    filesystem: nativeLocalPermissionPathFilesystem,
  };
  for (const errno of ["ENOENT", "ENOTDIR", "EACCES", "EIO"]) {
    const scan = scanNativeDevMods({
      root: "/owned/dev-mods",
      followLinks: true,
      context,
      filesystem: {
        readDirectory(): never {
          throw Object.assign(new Error(errno), { code: errno });
        },
      },
    });
    assert.equal(scan.isWhole, errno === "ENOENT" || errno === "ENOTDIR");
  }
});
