import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { nativeLocalPermissionPathFilesystem } from "../../src/native-path-inspection.js";
import {
  nativeLocalPluginDirectoryFilesystem,
  scanNativeDevMods,
  type NativePluginDirectoryFilesystem,
} from "../../src/native-plugin-permission-scan.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(posix.join(tmpdir(), "tau-dev-mods-")));
  temporary.push(root);
  const mods = posix.join(root, "dev-mods");
  const outside = posix.join(root, "outside");
  mkdirSync(mods);
  mkdirSync(outside);
  const context = {
    cwd: root,
    home: posix.join(root, "home"),
    initialCwd: root,
    macos: true,
    filesystem: nativeLocalPermissionPathFilesystem,
  };
  const scan = (
    followLinks: boolean,
    filesystem: NativePluginDirectoryFilesystem = nativeLocalPluginDirectoryFilesystem,
  ) =>
    scanNativeDevMods({ root: "dev-mods", followLinks, context, filesystem });
  const directory = (...parts: string[]) => {
    const path = posix.join(...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { root, mods, outside, scan, directory };
}

function failing(error: unknown): NativePluginDirectoryFilesystem {
  return {
    readDirectory: () => {
      throw error;
    },
  };
}

describe("dev-mods scan without following links", () => {
  test("links are recorded with their targets down to the depth bound", () => {
    const w = world();
    const shallow = posix.join(w.directory(w.mods, "a", "b", "c"), "link");
    symlinkSync(w.outside, shallow);
    const deep = posix.join(w.directory(w.mods, "a", "b", "c", "d"), "link");
    symlinkSync(w.outside, deep);
    const hidden = posix.join(
      w.directory(w.mods, "node_modules", "pkg"),
      "link",
    );
    symlinkSync(w.outside, hidden);
    const result = w.scan(false);
    expect(result.isWhole).toBe(true);
    expect(result.links).toEqual([shallow, w.outside]);
  });

  test("a relative link target resolves against the link's folder", () => {
    const w = world();
    const link = posix.join(w.mods, "named");
    symlinkSync("relative-target", link);
    expect(w.scan(false).links).toEqual([
      link,
      posix.join(w.mods, "relative-target"),
    ]);
  });

  test("a missing folder is whole but an unreadable one is not", () => {
    const w = world();
    rmSync(w.mods, { recursive: true });
    expect(w.scan(false)).toEqual({ links: [], isWhole: true });
    const notDirectory = Object.assign(new Error("x"), { code: "ENOTDIR" });
    expect(w.scan(false, failing(notDirectory)).isWhole).toBe(true);
    const denied = Object.assign(new Error("x"), { code: "EACCES" });
    expect(w.scan(false, failing(denied)).isWhole).toBe(false);
    expect(
      w.scan(false, failing(Object.assign(new Error("x"), { code: 13 })))
        .isWhole,
    ).toBe(false);
    expect(w.scan(false, failing("odd failure")).isWhole).toBe(false);
  });
});

describe("dev-mods scan following links", () => {
  test("a followed link adds its landing and the links found beyond it", () => {
    const w = world();
    const further = w.directory(w.root, "further");
    symlinkSync(further, posix.join(w.outside, "onward"));
    w.directory(w.outside, "plain-folder");
    symlinkSync(
      posix.join(w.outside, "plain-folder"),
      posix.join(w.outside, "inner"),
    );
    const link = posix.join(w.mods, "linked");
    symlinkSync(w.outside, link);
    const result = w.scan(true);
    expect(result.isWhole).toBe(true);
    expect(result.links).toContain(link);
    expect(result.links).toContain(w.outside);
    expect(result.links).toContain(further);
    // A link that stays inside the followed landing is not reported again.
    expect(result.links).not.toContain(posix.join(w.outside, "plain-folder"));
    expect(new Set(result.links).size).toBe(result.links.length);
  });

  test("plain folders are walked and files are whole", () => {
    const w = world();
    const nested = posix.join(w.directory(w.mods, "a", "b"), "link");
    symlinkSync(w.outside, nested);
    w.directory(w.mods, "a", "file-holder");
    expect(w.scan(true).links).toContain(nested);
  });

  test("a node_modules folder deep in the tree is not walked", () => {
    const w = world();
    const modules = w.directory(w.mods, "a", "b", "node_modules");
    const inside = posix.join(w.directory(modules, "pkg"), "link");
    symlinkSync(w.outside, inside);
    expect(w.scan(true).links).not.toContain(inside);
    // A linked node_modules at that depth is named but not followed.
    const target = w.directory(w.root, "store");
    symlinkSync(w.outside, posix.join(target, "beyond"));
    const linked = posix.join(w.directory(w.mods, "x", "y"), "node_modules");
    symlinkSync(target, linked);
    const links = w.scan(true).links;
    expect(links).toContain(linked);
    expect(links).not.toContain(w.outside);
  });

  test("a link back into the tree is not walked twice", () => {
    const w = world();
    symlinkSync(w.mods, posix.join(w.mods, "self"));
    const result = w.scan(true);
    expect(result.isWhole).toBe(true);
    expect(result.links).toContain(posix.join(w.mods, "self"));
  });

  test("a link cycle is named, and the screen profile still vets it as whole", () => {
    // The permission walk cannot resolve a cycle, but the separate screen
    // profile returns a vetted spelling for a non-climbing cycle.
    const w = world();
    const loop = posix.join(w.mods, "loop");
    symlinkSync(loop, loop);
    const result = w.scan(true);
    expect(result.isWhole).toBe(true);
    expect(result.links).toContain(loop);
  });

  test("a link onto a network mount is incomplete unless depth is spent", () => {
    const w = world();
    const network = posix.join(w.mods, "network");
    symlinkSync("/net/remote-host/share", network);
    const result = w.scan(true);
    expect(result.isWhole).toBe(false);
    expect(result.links).toContain(network);
  });
});
