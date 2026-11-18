import { describe, expect, test } from "bun:test";
import {
  nativeAncestryNetworkShape,
  nativeAncestryPathSpelling,
  nativePermissionAncestryRisk,
  nativePermissionComparableContains,
  nativePermissionComparablePath,
  type NativeAncestryFilesystem,
  type NativeAncestryReport,
} from "../../src/native-path-ancestry.js";

type Entry =
  | { kind: "directory" | "file" }
  | { kind: "link"; target: string }
  | { kind: "error"; error: unknown };

/** An in-memory metadata tree; a path with no entry is missing (ENOENT). */
function tree(
  entries: Record<string, Entry>,
  options: {
    readlinkError?: unknown;
    realpath?: (path: string) => string;
  } = {},
): NativeAncestryFilesystem {
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  return {
    lstat(path) {
      const entry = entries[path];
      if (entry === undefined) throw missing();
      if (entry.kind === "error") throw entry.error;
      return {
        isSymbolicLink: () => entry.kind === "link",
        isDirectory: () => entry.kind === "directory",
        dev: 1n,
        ino: BigInt(Object.keys(entries).indexOf(path) + 2),
      };
    },
    readlink(path) {
      if (options.readlinkError !== undefined) throw options.readlinkError;
      const entry = entries[path];
      if (entry?.kind !== "link") throw missing();
      return entry.target;
    },
    realpath(path) {
      if (options.realpath) return options.realpath(path);
      throw missing();
    },
  };
}

describe("verbatim drive spellings", () => {
  test("a clean verbatim drive path loses only its prefix", () => {
    expect(nativeAncestryPathSpelling("\\\\?\\C:\\dir\\file")).toBe(
      "C:\\dir\\file",
    );
    expect(nativeAncestryPathSpelling("\\\\.\\D:\\dir")).toBe("D:\\dir");
    expect(nativeAncestryPathSpelling("\\??\\C:\\dir")).toBe("C:\\dir");
  });

  test("a verbatim path with mixed separators or a suspect component is kept whole", () => {
    for (const path of [
      "\\\\?\\C:/dir/file",
      "\\\\?\\C:\\a\\..\\b",
      "\\\\?\\C:\\file.",
      "\\\\?\\C:\\dir \\x",
      "\\\\?\\C:\\CON.txt",
      "\\\\?\\C:\\nul:stream",
      "\\\\?\\C:\\COM\u00B9",
      "\\\\?\\C:\\lpt1 .log",
    ])
      expect(nativeAncestryPathSpelling(path)).toBe(path);
  });

  test("other spellings pass through unchanged", () => {
    expect(nativeAncestryPathSpelling("/plain/path")).toBe("/plain/path");
    expect(nativeAncestryPathSpelling("\\\\?\\UNC\\server\\share")).toBe(
      "\\\\?\\UNC\\server\\share",
    );
  });

  test("Windows object-manager roots are network shaped", () => {
    expect(nativeAncestryNetworkShape("/GLOBAL??/C:/x")).toBe(true);
    expect(nativeAncestryNetworkShape("\\Device\\HarddiskVolume1\\x")).toBe(
      true,
    );
    expect(nativeAncestryNetworkShape("/Devices/x")).toBe(false);
  });
});

describe("ancestry risk walk", () => {
  test("a relative spelling cannot be vetted", () => {
    expect(nativePermissionAncestryRisk("relative/x", tree({}))).toBe(true);
    expect(nativePermissionAncestryRisk("\\\\?\\C:\\x", tree({}))).toBe(true);
  });

  test("a plain directory chain is safe and is recorded", () => {
    const report: NativeAncestryReport = {};
    const fs = tree({
      "/a": { kind: "directory" },
      "/a/b": { kind: "directory" },
      "/a/b/f": { kind: "file" },
    });
    expect(nativePermissionAncestryRisk("/a/b/f", fs, report)).toBe(false);
    expect(report.chain?.map((row) => row.path)).toEqual(["/a", "/a/b"]);
    expect(report).toMatchObject({ metLink: false, endedMissing: false });
  });

  test("dot segments are followed lexically and the resolved spelling is checked too", () => {
    const fs = tree({
      "/a": { kind: "directory" },
      "/a/b": { kind: "directory" },
    });
    expect(nativePermissionAncestryRisk("/a/./b/../b", fs)).toBe(false);
    expect(nativePermissionAncestryRisk("/a/../net/host", fs)).toBe(true);
  });

  test("a network component on the way is a risk", () => {
    expect(nativePermissionAncestryRisk("/net/host/x", tree({}))).toBe(true);
    const fs = tree({ "/a": { kind: "directory" } });
    expect(nativePermissionAncestryRisk("/a/missing/../../net/h", fs)).toBe(
      true,
    );
  });

  test("a missing tail ends the walk unless it climbs into a network root", () => {
    const report: NativeAncestryReport = {};
    const fs = tree({ "/a": { kind: "directory" } });
    expect(
      nativePermissionAncestryRisk("/a/missing/./deeper", fs, report),
    ).toBe(false);
    expect(report.endedMissing).toBe(true);
    const notDirectory = tree({
      "/a": {
        kind: "error",
        error: Object.assign(new Error("x"), { code: "ENOTDIR" }),
      },
    });
    expect(nativePermissionAncestryRisk("/a/b", notDirectory)).toBe(false);
  });

  test("an unreadable component is unclassifiable", () => {
    const report: NativeAncestryReport = {};
    const denied = tree({
      "/a": {
        kind: "error",
        error: Object.assign(new Error("x"), { code: "EACCES" }),
      },
    });
    expect(nativePermissionAncestryRisk("/a/b", denied, report)).toBe(true);
    expect(report.unclassifiable).toBe("EACCES");
    const odd = tree({ "/a": { kind: "error", error: "not an error" } });
    const unknown: NativeAncestryReport = {};
    expect(nativePermissionAncestryRisk("/a/b", odd, unknown)).toBe(true);
    expect(unknown.unclassifiable).toBe("UNKNOWN");
  });

  test("links are followed, absolute or relative, and a network target is a risk", () => {
    const report: NativeAncestryReport = {};
    const fs = tree({
      "/a": { kind: "directory" },
      "/a/abs": { kind: "link", target: "//b" },
      "/b": { kind: "directory" },
      "/a/rel": { kind: "link", target: "../b" },
      "/a/net": { kind: "link", target: "/net/host" },
    });
    expect(nativePermissionAncestryRisk("/a/abs/x", fs, report)).toBe(false);
    expect(report.metLink).toBe(true);
    expect(nativePermissionAncestryRisk("/a/rel/x", fs)).toBe(false);
    expect(nativePermissionAncestryRisk("/a/net/x", fs)).toBe(true);
  });

  test("a link loop stops after forty hops", () => {
    const fs = tree({
      "/a": { kind: "directory" },
      "/a/loop": { kind: "link", target: "loop" },
    });
    expect(nativePermissionAncestryRisk("/a/loop/x", fs)).toBe(true);
  });

  test("an unreadable link is unclassifiable", () => {
    const entries: Record<string, Entry> = {
      "/a": { kind: "link", target: "/b" },
    };
    const report: NativeAncestryReport = {};
    const coded = tree(entries, {
      readlinkError: Object.assign(new Error("x"), { code: "EPERM" }),
    });
    expect(nativePermissionAncestryRisk("/a/x", coded, report)).toBe(true);
    expect(report.unclassifiable).toBe("EPERM");
    const bare = tree(entries, { readlinkError: 7 });
    const unknown: NativeAncestryReport = {};
    expect(nativePermissionAncestryRisk("/a/x", bare, unknown)).toBe(true);
    expect(unknown.unclassifiable).toBe("UNKNOWN");
  });
});

describe("comparable paths", () => {
  const safe = tree({
    "/w": { kind: "directory" },
    "/w/link": { kind: "directory" },
  });

  test("the cwd must be an explicit absolute path", () => {
    expect(() =>
      nativePermissionComparablePath("x", { cwd: "w", filesystem: safe }),
    ).toThrow(TypeError);
    expect(() =>
      nativePermissionComparablePath("x", { cwd: "/w\0", filesystem: safe }),
    ).toThrow(TypeError);
  });

  test("the physical spelling of a verbatim realpath is unwrapped", () => {
    const unc = tree(
      { "/w": { kind: "directory" }, "/w/x": { kind: "file" } },
      { realpath: () => "\\\\?\\UNC\\server\\share" },
    );
    expect(
      nativePermissionComparablePath("/w/x", { cwd: "/w", filesystem: unc }),
    ).toBe("\\\\server\\share");
    const drive = tree(
      { "/w": { kind: "directory" }, "/w/x": { kind: "file" } },
      { realpath: () => "\\\\?\\C:\\Data" },
    );
    expect(
      nativePermissionComparablePath("/w/x", {
        cwd: "/w",
        filesystem: drive,
        foldCase: false,
      }),
    ).toBe("C:\\Data");
    const short = tree(
      { "/w": { kind: "directory" }, "/w/x": { kind: "file" } },
      { realpath: () => "\\\\?\\ab" },
    );
    expect(
      nativePermissionComparablePath("/w/x", { cwd: "/w", filesystem: short }),
    ).toBe("\\\\?\\ab");
  });

  test("a path that never resolves keeps its lexical spelling, folded", () => {
    expect(
      nativePermissionComparablePath("/W/Missing/File", {
        cwd: "/w",
        filesystem: tree({}),
        knownNotSuspect: true,
      }),
    ).toBe("/w/missing/file");
    expect(
      nativePermissionComparablePath("/", {
        cwd: "/w",
        filesystem: tree({}),
        knownNotSuspect: true,
      }),
    ).toBe("/");
  });

  test("a missing tail is appended to the deepest resolved ancestor", () => {
    const fs = tree(
      { "/w": { kind: "directory" } },
      {
        realpath: (path) => {
          if (path === "/w") return "/Physical/W";
          throw Object.assign(new Error("x"), { code: "ENOENT" });
        },
      },
    );
    expect(
      nativePermissionComparablePath("new/File", { cwd: "/w", filesystem: fs }),
    ).toBe("/physical/w/new/file");
  });

  test("containment is lexical and refuses a parent climb", () => {
    expect(nativePermissionComparableContains("/a", "/a")).toBe(true);
    expect(nativePermissionComparableContains("/a", "/a/b")).toBe(true);
    expect(nativePermissionComparableContains("/a", "/b")).toBe(false);
    expect(nativePermissionComparableContains("/a/b", "/a")).toBe(false);
    expect(nativePermissionComparableContains("/a", "/a/..b")).toBe(true);
  });
});
