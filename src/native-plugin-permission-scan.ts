import { readdirSync } from "node:fs";
import { posix } from "node:path";
import {
  inspectNativePermissionPath,
  inspectNativeScreenPath,
  type NativePermissionPathContext,
} from "./native-path-inspection.js";
import { nativePermissionComparableContains } from "./native-path-ancestry.js";

export interface NativePluginDirectoryEntry {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}
export interface NativePluginDirectoryFilesystem {
  readDirectory(path: string): readonly NativePluginDirectoryEntry[];
}
export const nativeLocalPluginDirectoryFilesystem: NativePluginDirectoryFilesystem =
  { readDirectory: (path) => readdirSync(path, { withFileTypes: true }) };
export interface NativeDevModsScan {
  links: string[];
  isWhole: boolean;
}

/** I5r's two actual bounded scan profiles, including L5's separate screen check. */
export function scanNativeDevMods(options: {
  root: string;
  followLinks: boolean;
  context: NativePermissionPathContext;
  filesystem: NativePluginDirectoryFilesystem;
}): NativeDevModsScan {
  const root = posix.resolve(options.context.cwd, options.root);
  function code(error: unknown): string | undefined {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
      ? error.code
      : undefined;
  }
  function rawTarget(path: string): string[] {
    try {
      let parent = posix.dirname(path);
      try {
        parent = options.context.filesystem.realpath(parent);
      } catch {
        /* Native v preserves the named parent. */
      }
      return [posix.resolve(parent, options.context.filesystem.readlink(path))];
    } catch {
      return [];
    }
  }
  const seen = new Map<string, number>();
  function scan(path: string, depth: number): NativeDevModsScan {
    if (options.followLinks) {
      if ((seen.get(path) ?? 0) >= depth) return { links: [], isWhole: true };
      seen.set(path, depth);
    }
    const children: NativeDevModsScan[] = [];
    try {
      for (const entry of options.filesystem.readDirectory(path)) {
        const child = posix.join(path, entry.name);
        if (!options.followLinks) {
          children.push(
            entry.isSymbolicLink()
              ? { links: [child, ...rawTarget(child)], isWhole: true }
              : entry.isDirectory() &&
                  depth > 1 &&
                  entry.name !== "node_modules"
                ? scan(child, depth - 1)
                : { links: [], isWhole: true },
          );
          continue;
        }
        const nextDepth =
          entry.name === "node_modules" && depth < 4 ? 0 : depth - 1;
        if (!entry.isSymbolicLink()) {
          children.push(
            entry.isDirectory() && nextDepth > 0
              ? scan(child, nextDepth)
              : { links: [], isWhole: true },
          );
          continue;
        }
        const inspection = inspectNativePermissionPath(child, options.context);
        if (inspection.unresolved) {
          children.push({
            links: [...inspection.spellings, ...rawTarget(child)],
            isWhole: !inspectNativeScreenPath(child, options.context)
              .unresolved,
          });
          continue;
        }
        if (inspection.endsUnexamined) {
          children.push({
            links: [...inspection.spellings, ...rawTarget(child)],
            isWhole: nextDepth === 0,
          });
          continue;
        }
        if (nextDepth === 0) {
          children.push({ links: [...inspection.spellings], isWhole: true });
          continue;
        }
        const nested = scan(inspection.landing, nextDepth);
        children.push({
          links: [
            ...inspection.spellings,
            ...nested.links.filter(
              (target) =>
                !nativePermissionComparableContains(inspection.landing, target),
            ),
          ],
          isWhole: nested.isWhole,
        });
      }
    } catch (error) {
      const errno = code(error);
      return { links: [], isWhole: errno === "ENOENT" || errno === "ENOTDIR" };
    }
    return {
      links: children.flatMap((child) => child.links),
      isWhole: children.every((child) => child.isWhole),
    };
  }
  const result = scan(root, options.followLinks ? 5 : 4);
  return options.followLinks
    ? { ...result, links: [...new Set(result.links)] }
    : result;
}
