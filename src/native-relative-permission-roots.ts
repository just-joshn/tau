import { posix } from "node:path";
import {
  inspectNativePosixPermissionPath,
  type NativePosixPermissionFilesystem,
} from "./native-file-permission-host.js";

export interface NativeRelativePermissionRootFacts {
  platform: "posix";
  cwd: string;
  /** Te(), even where a scoped/null project makes _s() absent. */
  originalCwd: string;
  /** _s(): nullable project/scoped original cwd, not the Git repository root. */
  launchContextRoot: string | null;
  /** kd(): nullable project/scoped projectRoot, not an inferred Git root. */
  projectRoot: string | null;
  additionalWorkingDirectories: readonly string[];
  initialReadRoot: string | null | undefined;
  blockFileToolReadsOutsideWorkingDirectories: boolean;
  /** xc's undefined state defaults true. */
  relativeRuleRootsSwitch: boolean | undefined;
  evalConfined: boolean;
  diskless: boolean;
}
export type NativeRelativeRootSpellings =
  | { status: "known"; spellings: readonly string[] }
  | { status: "unsupported"; reason: string };
export type NativeRelativePermissionRootsResult =
  | {
      status: "resolved";
      roots: readonly string[];
      switchEnabled: boolean;
      groups: readonly (readonly string[])[];
      worktrees: readonly string[];
      selectedWorktree: string | undefined;
    }
  | { status: "unsupported"; reason: string };
export class NativeRelativePermissionRootsUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeRelativePermissionRootsUnsupported";
  }
}
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
function absolute(path: string, label: string): string {
  if (
    typeof path !== "string" ||
    !posix.isAbsolute(path) ||
    path.includes("\0")
  )
    throw new NativeRelativePermissionRootsUnsupported(
      `${label} requires a known absolute POSIX path`,
    );
  return path;
}
function isArray(value: unknown): boolean {
  return Array.isArray(value);
}
function knownSpellings(values: readonly string[]): readonly string[] {
  if (!isArray(values) || values.length === 0)
    throw new NativeRelativePermissionRootsUnsupported(
      "Working directory spelling evidence must contain its known path",
    );
  for (const value of values) absolute(value, "Working directory spelling");
  return values;
}
/** si/wt on already absolute POSIX root spellings: preserve meaningful trailing whitespace. */
function named(path: string): string {
  absolute(path, "Root spelling");
  const protectedTail =
    path === path.trimEnd() || path.trim() === "" ? path : `${path}/.`;
  return posix.normalize(protectedTail.trim()).normalize("NFC");
}
/** Pi is lexical component ancestry, including equality; POSIX remains case-sensitive. */
function contains(root: string, target: string): boolean {
  return posix.relative(root, target).split("/", 1)[0] !== "..";
}
/** wg/Cct: lexical .claude/worktrees/name boundaries, no Git/filesystem enumeration. */
export function nativeLexicalPermissionWorktrees(
  path: string,
): readonly string[] {
  absolute(path, "Worktree spelling");
  const marker = "/.claude/worktrees/";
  const roots: string[] = [];
  for (
    let at = path.indexOf(marker);
    at !== -1;
    at = path.indexOf(marker, at + 1)
  ) {
    const name = at + marker.length;
    const next = path.indexOf("/", name);
    if (name < path.length)
      roots.push(next === -1 ? path : path.slice(0, next));
  }
  return roots;
}

/** Full ordinary POSIX Tc/Dc/Ewn over explicit session-owned metadata and ac caches. */
export function createNativeRelativePermissionRoots(options: {
  facts: () => NativeRelativePermissionRootFacts;
  workingDirPathsHeldAsNamed: () => ReadonlySet<string>;
  resolvedWorkingDirPaths: () => ReadonlyMap<string, readonly string[]>;
  /** Exact gs-equivalent spelling evidence; unsupported is never represented by an invented singleton. */
  readSpellings: (path: string) => NativeRelativeRootSpellings;
}) {
  const folderCache = new Map<string, readonly string[]>();
  function evaluate(
    target: string,
    behavior: "allow" | "deny" | "ask",
  ): NativeRelativePermissionRootsResult {
    try {
      const facts = options.facts();
      if (
        facts.platform !== "posix" ||
        typeof facts.evalConfined !== "boolean" ||
        typeof facts.diskless !== "boolean" ||
        typeof facts.blockFileToolReadsOutsideWorkingDirectories !==
          "boolean" ||
        (facts.relativeRuleRootsSwitch !== undefined &&
          typeof facts.relativeRuleRootsSwitch !== "boolean") ||
        !isArray(facts.additionalWorkingDirectories)
      )
        throw new NativeRelativePermissionRootsUnsupported(
          "Relative roots require an explicit ordinary POSIX session profile",
        );
      const cwd = absolute(facts.cwd, "Live cwd");
      const switchEnabled = facts.relativeRuleRootsSwitch ?? true;
      if (behavior === "allow" || !switchEnabled)
        return {
          status: "resolved",
          roots: [cwd],
          switchEnabled,
          groups: [],
          worktrees: [],
          selectedWorktree: undefined,
        };
      absolute(target, "Permission target");
      absolute(facts.originalCwd, "Original cwd");
      const ac = (path: string): readonly string[] => {
        absolute(path, "Working directory root");
        if (options.workingDirPathsHeldAsNamed().has(path)) return [path];
        const resolved = options.resolvedWorkingDirPaths().get(path);
        if (resolved !== undefined) return knownSpellings(resolved);
        const cached = folderCache.get(path);
        if (cached !== undefined) return cached;
        const result: NativeRelativeRootSpellings =
          (facts.evalConfined && path === facts.originalCwd) || facts.diskless
            ? { status: "known", spellings: [path] }
            : options.readSpellings(path);
        if (result.status !== "known")
          throw new NativeRelativePermissionRootsUnsupported(result.reason);
        const saved = [...knownSpellings(result.spellings)];
        folderCache.set(path, saved);
        return saved;
      };
      const inputRoots = unique([
        facts.launchContextRoot,
        ...facts.additionalWorkingDirectories,
        facts.projectRoot,
      ]).filter(
        (root): root is string => root !== null && !root.includes("\0"),
      );
      const groups = inputRoots.map((root) => unique(ac(root).map(named)));
      const translated = groups.filter((group) => group.length > 1);
      const spellingsOf = (path: string): readonly string[] =>
        unique([
          path,
          ...translated.flatMap((group) =>
            group
              .filter((root) => path === root || path.startsWith(`${root}/`))
              .flatMap((root) =>
                group.map((twin) => twin + path.slice(root.length)),
              ),
          ),
        ]);
      const normalizedCwd = named(cwd);
      const readRoot =
        behavior === "deny" && facts.blockFileToolReadsOutsideWorkingDirectories
          ? facts.initialReadRoot
          : null;
      const others =
        readRoot && !readRoot.includes("\0")
          ? [...groups, unique(ac(readRoot).map(named))]
          : groups;
      // The read-fence group is deliberately not a translation or worktree-discovery input.
      const worktrees = unique(
        [normalizedCwd, ...groups.flat()]
          .flatMap(spellingsOf)
          .flatMap(nativeLexicalPermissionWorktrees),
      );
      const selectedWorktree = worktrees
        .filter((root) => contains(root, target))
        .reduce<string | undefined>(
          (selected, root) =>
            selected === undefined || root.length > selected.length
              ? root
              : selected,
          undefined,
        );
      const selectedSpellings =
        selectedWorktree === undefined ? [] : spellingsOf(selectedWorktree);
      const candidates = others.flatMap((group) =>
        selectedWorktree !== undefined &&
        group.some((root) =>
          selectedSpellings.some(
            (twin) => root !== twin && contains(root, twin),
          ),
        )
          ? [selectedWorktree]
          : group,
      );
      return {
        status: "resolved",
        roots: unique([
          cwd,
          ...candidates.filter(
            (root) => root !== cwd && root !== normalizedCwd,
          ),
        ]),
        switchEnabled,
        groups,
        worktrees,
        selectedWorktree,
      };
    } catch (error) {
      return {
        status: "unsupported",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    evaluate,
    /** Source q_ folder-cache lifecycle is an explicit host invalidation event. */
    clearSpellingsCache() {
      folderCache.clear();
    },
    /** Directly compatible with the released file host's relativeRoots.resolve callback. */
    resolve(
      this: void,
      target: string,
      behavior: "deny" | "ask",
    ): readonly string[] {
      const result = evaluate(target, behavior);
      if (result.status === "unsupported")
        throw new NativeRelativePermissionRootsUnsupported(result.reason);
      return result.roots;
    },
  };
}

/** Native Ot/QPe ordinary direct launch: all project anchors start at canonical launch cwd. */
export function createOrdinaryNativeRelativePermissionRoots(options: {
  launchCwd: string;
  cwd: () => string;
  /** Explicit host declaration: no native scoped/root/worktree override or extra-directory feature. */
  admitOrdinaryLaunch: () => boolean | string;
  home: string;
  evalConfined: boolean;
  blockFileToolReadsOutsideWorkingDirectories: () => boolean;
  filesystem?: NativePosixPermissionFilesystem;
  admitPath?: (path: string) => boolean | string;
}) {
  const launch = named(options.launchCwd);
  const held = new Set<string>();
  const resolved = new Map<string, readonly string[]>();
  return createNativeRelativePermissionRoots({
    facts() {
      const admission = options.admitOrdinaryLaunch();
      if (admission !== true)
        throw new NativeRelativePermissionRootsUnsupported(
          typeof admission === "string"
            ? admission
            : "The native ordinary launch profile is unresolved",
        );
      const cwd = options.cwd();
      if (cwd !== launch)
        throw new NativeRelativePermissionRootsUnsupported(
          "A cwd/root transition requires its explicit native session anchors",
        );
      return {
        platform: "posix",
        cwd,
        originalCwd: launch,
        launchContextRoot: launch,
        projectRoot: launch,
        additionalWorkingDirectories: [],
        // ONa either has not captured _s yet, or captured this same immutable launch anchor.
        // Both states yield the same candidate roots; no consent-store/Git-root inference occurs.
        initialReadRoot: launch,
        blockFileToolReadsOutsideWorkingDirectories:
          options.blockFileToolReadsOutsideWorkingDirectories(),
        relativeRuleRootsSwitch: undefined,
        evalConfined: options.evalConfined,
        diskless: false,
      };
    },
    workingDirPathsHeldAsNamed: () => held,
    resolvedWorkingDirPaths: () => resolved,
    readSpellings(path) {
      const inspected = inspectNativePosixPermissionPath({
        path,
        cwd: launch,
        home: options.home,
        ...(options.filesystem === undefined
          ? {}
          : { filesystem: options.filesystem }),
        ...(options.admitPath === undefined
          ? {}
          : { admitPath: options.admitPath }),
      });
      return inspected.status === "resolved"
        ? { status: "known", spellings: inspected.spellings }
        : { status: "unsupported", reason: inspected.reason };
    },
  });
}
