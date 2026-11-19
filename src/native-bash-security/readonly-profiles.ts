import { AsyncLocalStorage } from "node:async_hooks";
import type { createNativeBashSecurityProcess } from "../native-bash-security.js";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionScope as Scope,
  type NativePermissionFact as Fact,
  type NativePermissionProvenance as Provenance,
} from "../native-permission-outcome.js";
import type { NativeBashSecurityPolicy as Policy } from "../native-bash-security.js";
export type NativeBashReadonlyFlagValue =
  "none" | "number" | "string" | "char" | "{}" | "EOF";
export interface NativeBashReadonlyProfile {
  safeFlags: Readonly<Record<string, NativeBashReadonlyFlagValue>>;
  respectsDoubleDash?: boolean;
  regex?: RegExp;
  additionalCommandIsDangerousCallback?: (
    command: string,
    args: string[],
  ) => boolean;
}
export interface NativeBashReadonlyProfileHost {
  safeFeature?: (key: string, safe: true, scope: Scope) => Fact<boolean>;
}
function need<T>(value: T | undefined, dependency: string): T {
  if (value === undefined)
    throw new NativePermissionDependencyError(
      dependency,
      "Required native readonly profile fact is unavailable",
    );
  return value;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native readonly profile invariant");
  return value;
}
export function createNativeBashReadonlyProfiles(
  process: ReturnType<typeof createNativeBashSecurityProcess>,
  host: NativeBashReadonlyProfileHost,
) {
  const { semantic, preparation, policy } = process;
  if (
    policy.pathOwner.semantic !== semantic ||
    policy.pathOwner.preparation !== preparation
  )
    throw new Error("Native readonly process owners must be shared");
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    provenance: Provenance[];
  }>();
  const frame = () => need(frames.getStore(), "readonlyProfile.scope");
  const use = <T>(fact: Fact<T>) =>
    readNativePermissionFact(fact, frame().scope, frame().provenance);
  const je = (key: string, _options: { safe: true }) =>
    use(
      need(host.safeFeature, "features.readonlyProfiles")(
        key,
        true,
        frame().scope,
      ),
    );
  const P = policy.pathOwner.gate.bindings.P;
  const { Ys, zti, ZKt, Lwn, VQn, zQn, Mwn } = semantic.native;
  const iC = preparation.projection.staticArgv;
  const DY = () => preparation.features.refuseEnvironment();
  const ero = (option: string) =>
    preparation.features.removalOptionAccepted(option);
  const PF = policy.pathOwner.sed.isReadOnly;
  const Pat = policy.contexts.pathList;

  const tP = policy.pathOwner.gate.bindings.tP;
  const nt = (text: string, delimiter: string) => {
    const at = text.indexOf(delimiter);
    return at === -1 ? text : text.slice(0, at);
  };
  const fp = /^-[a-zA-Z0-9_-]/;

  const hp = /:[\\/]{2}/;

  const yp = "tengu_jaunty_honey";

  const pp = "tengu_amber_thimble";

  const S5r = [
    "-H",
    "-c",
    "-r",
    "--host",
    "--context",
    "--config",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
    "--url",
    "--connection",
    "--identity",
    "--remote",
    "--module",
    "--out",
  ];

  const up = new Set(S5r.filter((e) => e.length === 2).map((e) => e[1]));

  const zl = /%[-+ ]?G|%\(\*?signature/;

  const ap = new Set([
    "oneline",
    "short",
    "medium",
    "full",
    "fuller",
    "email",
    "raw",
  ]);

  const cp = /(?:^|[=:])~/;

  const zn: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "--all": "none",
    "--branches": "none",
    "--tags": "none",
    "--remotes": "none",
  };

  const Er: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "--since": "string",
    "--after": "string",
    "--until": "string",
    "--before": "string",
  };

  const Pr: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "--oneline": "none",
    "--graph": "none",
    "--decorate": "none",
    "--no-decorate": "none",
    "--date": "string",
    "--relative-date": "none",
  };

  const Mr: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "--max-count": "number",
    "-n": "number",
  };

  const Cr: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "--stat": "none",
    "--numstat": "none",
    "--shortstat": "none",
    "--name-only": "none",
    "--name-status": "none",
  };

  const Hn: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "--color": "none",
    "--no-color": "none",
  };

  const Qo: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "--patch": "none",
    "-p": "none",
    "--no-patch": "none",
    "--no-ext-diff": "none",
    "-s": "none",
  };

  const ti: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "--author": "string",
    "--committer": "string",
    "--grep": "string",
  };

  function Wxt(e: string): boolean {
    return e.startsWith("-") && e.length > 1 && fp.test(e);
  }

  function Yl(e: string, n: NativeBashReadonlyFlagValue): boolean {
    switch (n) {
      case "none":
        return !1;
      case "number":
        return /^\d+$/.test(e);
      case "string":
        return !0;
      case "char":
        return e.length === 1;
      case "{}":
        return e === "{}";
      case "EOF":
        return e === "EOF";
      default:
        return !1;
    }
  }

  function TQn(e: string[]): boolean {
    return e.some((n) => cp.test(n) || (n.includes("~") && n.includes("{")));
  }

  function mVo(e: string[]): boolean {
    return e.some((n) => {
      if (
        S5r.some(
          (a) =>
            n === a ||
            n.startsWith(`${a}=`) ||
            (a.length === 2 && n.length > 2 && n.startsWith(a)),
        )
      )
        return !0;
      let r = n.match(/^-([A-Za-z]+)/)?.[1];
      if (r !== void 0 && r.length >= 2) {
        for (let a of r) if (up.has(a)) return !0;
      }
      return !1;
    });
  }

  function pVo(e: string[]): boolean {
    return e.some((n) => n.includes("~"));
  }

  function St(e: string[]): boolean {
    let n = (r: string) => TQn([r]) || Ys(r) || zl.test(r) || sp(r);
    for (let r = 0; r < e.length; r++) {
      let a = required(e[r]);
      if (zl.test(a)) return !0;
      for (let h of ["--format", "--pretty", "--sort", "--group"]) {
        let y;
        if (a === h && r + 1 < e.length) y = e[r + 1];
        else if (a.startsWith(`${h}=`)) y = a.slice(h.length + 1);
        if (y === void 0) continue;
        if (n(y)) return !0;
        if ((h === "--format" || h === "--pretty") && lp(y)) return !0;
      }
    }
    return !1;
  }

  function sp(e: string): boolean {
    return e.includes("signature");
  }

  function lp(e: string): boolean {
    if (e === "") return !1;
    if (e.includes("%")) return !1;
    if (e.startsWith("format:") || e.startsWith("tformat:")) return !1;
    return !ap.has(e);
  }

  function hct(
    e: string[],
    n: number,
    r: NativeBashReadonlyProfile,
    a?: {
      commandName?: string | undefined;
      xargsTargetCommands?: string[] | undefined;
    },
  ): boolean {
    let h = n;
    if (
      a?.commandName === "git" &&
      P() === "windows" &&
      e.slice(n).some((y) => hp.test(y) || Ys(y)) &&
      je(yp, { safe: !0 })
    )
      return !1;
    while (h < e.length) {
      let y = e[h];
      if (!y) {
        h++;
        continue;
      }
      if (
        a?.xargsTargetCommands &&
        a.commandName === "xargs" &&
        (!y.startsWith("-") || y === "--")
      ) {
        if (y === "--" && h + 1 < e.length) {
          h++;
          y = e[h];
        }
        if (y && a.xargsTargetCommands.includes(y)) break;
        return !1;
      }
      if (y === "--") {
        if (r.respectsDoubleDash !== !1) {
          h++;
          break;
        }
        h++;
        continue;
      }
      if (
        Wxt(y) ||
        (y.startsWith("-") && y.length > 1 && je(pp, { safe: !0 }))
      ) {
        let k = y.includes("="),
          [R, ...E] = y.split("="),
          M = E.join("=");
        if (!R) return !1;
        let O = r.safeFlags[R];
        if (!O) {
          if (a?.commandName === "git" && R.match(/^-\d+$/)) {
            h++;
            continue;
          }
          if (
            (a?.commandName === "grep" ||
              a?.commandName === "egrep" ||
              a?.commandName === "fgrep" ||
              a?.commandName === "rg") &&
            R.startsWith("-") &&
            !R.startsWith("--") &&
            R.length > 2
          ) {
            let j = R.substring(0, 2),
              N = R.substring(2);
            if (r.safeFlags[j] && /^\d+$/.test(N)) {
              let H = r.safeFlags[j];
              if (H === "number" || H === "string")
                if (Yl(N, H)) {
                  h++;
                  continue;
                } else return !1;
            }
          }
          if (R.startsWith("-") && !R.startsWith("--") && R.length > 2) {
            for (let j = 1; j < R.length; j++) {
              let N = "-" + R[j],
                H = r.safeFlags[N];
              if (!H) return !1;
              if (H !== "none") return !1;
            }
            h++;
            continue;
          } else return !1;
        }
        if (O === "none") {
          if (k) return !1;
          h++;
        } else {
          let j;
          if (k) {
            j = M;
            h++;
          } else {
            if (h + 1 >= e.length || (e[h + 1] && Wxt(required(e[h + 1]))))
              return !1;
            {
              j = e[h + 1] || "";
              h += 2;
            }
          }
          if (zti(j)) return !1;
          if (O === "string" && j.startsWith("-")) {
            if (!(
              R === "--sort" &&
              a?.commandName === "git" &&
              j.match(/^-[a-zA-Z]/)
            ))
              return !1;
          }
          if (!Yl(j, O)) return !1;
        }
      } else {
        if (Ys(y)) return !1;
        h++;
      }
    }
    return !0;
  }

  const b5r: Readonly<Record<string, NativeBashReadonlyProfile>> = {
    "docker logs": {
      safeFlags: {
        "--follow": "none",
        "-f": "none",
        "--tail": "string",
        "-n": "string",
        "--timestamps": "none",
        "-t": "none",
        "--since": "string",
        "--until": "string",
        "--details": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) =>
        mVo(n) || TQn(n) || n.some(Ys),
    },
    "docker inspect": {
      safeFlags: {
        "--format": "string",
        "-f": "string",
        "--type": "string",
        "--size": "none",
        "-s": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) =>
        mVo(n) || TQn(n) || n.some(Ys),
    },
  };

  const TMa: Readonly<Record<string, NativeBashReadonlyProfile>> = {
    rg: {
      safeFlags: {
        "-e": "string",
        "--regexp": "string",
        "-f": "string",
        "-i": "none",
        "--ignore-case": "none",
        "-S": "none",
        "--smart-case": "none",
        "-F": "none",
        "--fixed-strings": "none",
        "-w": "none",
        "--word-regexp": "none",
        "-v": "none",
        "--invert-match": "none",
        "-c": "none",
        "--count": "none",
        "-l": "none",
        "--files-with-matches": "none",
        "--files-without-match": "none",
        "-n": "none",
        "--line-number": "none",
        "-o": "none",
        "--only-matching": "none",
        "-A": "number",
        "--after-context": "number",
        "-B": "number",
        "--before-context": "number",
        "-C": "number",
        "--context": "number",
        "-H": "none",
        "-h": "none",
        "--heading": "none",
        "--no-heading": "none",
        "-q": "none",
        "--quiet": "none",
        "--column": "none",
        "-g": "string",
        "--glob": "string",
        "-t": "string",
        "--type": "string",
        "-T": "string",
        "--type-not": "string",
        "--type-list": "none",
        "--hidden": "none",
        "--no-ignore": "none",
        "-u": "none",
        "-m": "number",
        "--max-count": "number",
        "-d": "number",
        "--max-depth": "number",
        "-a": "none",
        "--text": "none",
        "-L": "none",
        "--follow": "none",
        "--color": "string",
        "--json": "none",
        "--stats": "none",
        "--help": "none",
        "--version": "none",
        "--debug": "none",
        "--": "none",
      },
    },
  };

  const vQn: Readonly<Record<string, NativeBashReadonlyProfile>> = {
    "git diff": {
      safeFlags: {
        ...Cr,
        ...Hn,
        "--dirstat": "none",
        "--summary": "none",
        "--patch-with-stat": "none",
        "--word-diff": "none",
        "--word-diff-regex": "string",
        "--color-words": "none",
        "--no-renames": "none",
        "--no-ext-diff": "none",
        "--check": "none",
        "--ws-error-highlight": "string",
        "--full-index": "none",
        "--binary": "none",
        "--abbrev": "number",
        "--break-rewrites": "none",
        "--find-renames": "none",
        "--find-copies": "none",
        "--find-copies-harder": "none",
        "--irreversible-delete": "none",
        "--diff-algorithm": "string",
        "--histogram": "none",
        "--patience": "none",
        "--minimal": "none",
        "--ignore-space-at-eol": "none",
        "--ignore-space-change": "none",
        "--ignore-all-space": "none",
        "--ignore-blank-lines": "none",
        "--inter-hunk-context": "number",
        "--function-context": "none",
        "--exit-code": "none",
        "--quiet": "none",
        "--cached": "none",
        "--staged": "none",
        "--pickaxe-regex": "none",
        "--pickaxe-all": "none",
        "--no-index": "none",
        "--relative": "string",
        "--diff-filter": "string",
        "-p": "none",
        "-u": "none",
        "-s": "none",
        "-M": "none",
        "-C": "none",
        "-B": "none",
        "-D": "none",
        "-l": "none",
        "-S": "string",
        "-G": "string",
        "-O": "string",
        "-R": "none",
      },
    },
    "git log": {
      safeFlags: {
        ...Pr,
        ...zn,
        ...Er,
        ...Mr,
        ...Cr,
        ...Hn,
        ...Qo,
        ...ti,
        "--abbrev-commit": "none",
        "--full-history": "none",
        "--dense": "none",
        "--sparse": "none",
        "--simplify-merges": "none",
        "--ancestry-path": "none",
        "--source": "none",
        "--first-parent": "none",
        "--merges": "none",
        "--no-merges": "none",
        "--reverse": "none",
        "--walk-reflogs": "none",
        "--skip": "number",
        "--max-age": "number",
        "--min-age": "number",
        "--no-min-parents": "none",
        "--no-max-parents": "none",
        "--follow": "none",
        "--no-walk": "none",
        "--left-right": "none",
        "--cherry-mark": "none",
        "--cherry-pick": "none",
        "--boundary": "none",
        "--topo-order": "none",
        "--date-order": "none",
        "--author-date-order": "none",
        "--pretty": "string",
        "--format": "string",
        "--diff-filter": "string",
        "-S": "string",
        "-G": "string",
        "--pickaxe-regex": "none",
        "--pickaxe-all": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => St(n),
    },
    "git show": {
      safeFlags: {
        ...Pr,
        ...Cr,
        ...Hn,
        ...Qo,
        "--abbrev-commit": "none",
        "--word-diff": "none",
        "--word-diff-regex": "string",
        "--color-words": "none",
        "--pretty": "string",
        "--format": "string",
        "--first-parent": "none",
        "--raw": "none",
        "--diff-filter": "string",
        "-m": "none",
        "--quiet": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => St(n),
    },
    "git shortlog": {
      safeFlags: {
        ...zn,
        ...Er,
        "-s": "none",
        "--summary": "none",
        "-n": "none",
        "--numbered": "none",
        "-e": "none",
        "--email": "none",
        "-c": "none",
        "--committer": "none",
        "--group": "string",
        "--format": "string",
        "--no-merges": "none",
        "--author": "string",
      },
      additionalCommandIsDangerousCallback: (e, n) => St(n),
    },
    "git reflog": {
      safeFlags: { ...Pr, ...zn, ...Er, ...Mr, ...ti },
      additionalCommandIsDangerousCallback: (e, n) => {
        let r = new Set(["show", "list"]),
          a = new Set(["expire", "delete", "exists", "drop", "write"]),
          h = n[0];
        if (h && !h.startsWith("-") && !r.has(h)) return !0;
        for (let y of n) if (a.has(y)) return !0;
        return !1;
      },
    },
    "git stash list": {
      safeFlags: { ...Pr, ...zn, ...Mr },
      respectsDoubleDash: !1,
    },
    "git ls-remote": {
      safeFlags: {
        "--branches": "none",
        "-b": "none",
        "--tags": "none",
        "-t": "none",
        "--heads": "none",
        "-h": "none",
        "--refs": "none",
        "--quiet": "none",
        "-q": "none",
        "--exit-code": "none",
        "--get-url": "none",
        "--symref": "none",
        "--sort": "string",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        if (St(n)) return !0;
        let r = !1;
        for (let a = 0; a < n.length; a++) {
          let h = required(n[a]);
          if (!r && h === "--") {
            r = !0;
            continue;
          }
          if (!r && (!h || h.startsWith("-"))) {
            if (h === "--sort") a++;
            continue;
          }
          return !0;
        }
        return !1;
      },
    },
    "git status": {
      safeFlags: {
        "--short": "none",
        "-s": "none",
        "--branch": "none",
        "-b": "none",
        "--porcelain": "none",
        "--long": "none",
        "--verbose": "none",
        "-v": "none",
        "--untracked-files": "string",
        "-u": "string",
        "--ignored": "none",
        "--ignore-submodules": "string",
        "--column": "none",
        "--no-column": "none",
        "--ahead-behind": "none",
        "--no-ahead-behind": "none",
        "--renames": "none",
        "--no-renames": "none",
        "--find-renames": "string",
        "-M": "string",
      },
    },
    "git blame": {
      safeFlags: {
        ...Hn,
        "-L": "string",
        "--porcelain": "none",
        "-p": "none",
        "--line-porcelain": "none",
        "--incremental": "none",
        "--root": "none",
        "--show-stats": "none",
        "--show-name": "none",
        "--show-number": "none",
        "-n": "none",
        "--show-email": "none",
        "-e": "none",
        "-f": "none",
        "--date": "string",
        "-w": "none",
        "--ignore-rev": "string",
        "--ignore-revs-file": "string",
        "-M": "none",
        "-C": "none",
        "--score-debug": "none",
        "--abbrev": "number",
        "-s": "none",
        "-l": "none",
        "-t": "none",
      },
      respectsDoubleDash: !1,
    },
    "git ls-files": {
      safeFlags: {
        "--cached": "none",
        "-c": "none",
        "--deleted": "none",
        "-d": "none",
        "--modified": "none",
        "-m": "none",
        "--others": "none",
        "-o": "none",
        "--ignored": "none",
        "-i": "none",
        "--stage": "none",
        "-s": "none",
        "--killed": "none",
        "-k": "none",
        "--unmerged": "none",
        "-u": "none",
        "--directory": "none",
        "--no-empty-directory": "none",
        "--eol": "none",
        "--full-name": "none",
        "--abbrev": "number",
        "--debug": "none",
        "-z": "none",
        "-t": "none",
        "-v": "none",
        "-f": "none",
        "--exclude": "string",
        "-x": "string",
        "--exclude-from": "string",
        "-X": "string",
        "--exclude-per-directory": "string",
        "--exclude-standard": "none",
        "--error-unmatch": "none",
        "--recurse-submodules": "none",
      },
    },
    "git config --get": {
      safeFlags: {
        "--local": "none",
        "--global": "none",
        "--system": "none",
        "--worktree": "none",
        "--default": "string",
        "--type": "string",
        "--bool": "none",
        "--int": "none",
        "--bool-or-int": "none",
        "--path": "none",
        "--expiry-date": "none",
        "-z": "none",
        "--null": "none",
        "--name-only": "none",
        "--show-origin": "none",
        "--show-scope": "none",
      },
    },
    "git remote show": {
      safeFlags: { "-n": "none" },
      additionalCommandIsDangerousCallback: (e, n) => {
        let r = n.indexOf("--"),
          a = r === -1 ? n : n.slice(0, r),
          h = r === -1 ? [] : n.slice(r + 1),
          y = a.filter((k) => k !== "-n").concat(h);
        if (y.length !== 1) return !0;
        if (!a.includes("-n")) return !0;
        return !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(required(y[0]));
      },
    },
    "git remote": {
      safeFlags: { "-v": "none", "--verbose": "none" },
      additionalCommandIsDangerousCallback: (e, n) =>
        n.some((r) => r !== "-v" && r !== "--verbose"),
    },
    "git merge-base": {
      safeFlags: {
        "--is-ancestor": "none",
        "--fork-point": "none",
        "--octopus": "none",
        "--independent": "none",
        "--all": "none",
      },
    },
    "git rev-parse": {
      safeFlags: {
        "--verify": "none",
        "--short": "string",
        "--abbrev-ref": "none",
        "--symbolic": "none",
        "--symbolic-full-name": "none",
        "--show-toplevel": "none",
        "--show-cdup": "none",
        "--show-prefix": "none",
        "--git-dir": "none",
        "--git-common-dir": "none",
        "--absolute-git-dir": "none",
        "--is-inside-work-tree": "none",
        "--is-inside-git-dir": "none",
        "--is-bare-repository": "none",
        "--is-shallow-repository": "none",
        "--is-shallow-update": "none",
        "--path-prefix": "none",
      },
    },
    "git rev-list": {
      safeFlags: {
        ...zn,
        ...Er,
        ...Mr,
        ...ti,
        "--count": "none",
        "--reverse": "none",
        "--first-parent": "none",
        "--ancestry-path": "none",
        "--merges": "none",
        "--no-merges": "none",
        "--min-parents": "number",
        "--max-parents": "number",
        "--no-min-parents": "none",
        "--no-max-parents": "none",
        "--skip": "number",
        "--max-age": "number",
        "--min-age": "number",
        "--walk-reflogs": "none",
        "--oneline": "none",
        "--abbrev-commit": "none",
        "--pretty": "string",
        "--format": "string",
        "--abbrev": "number",
        "--full-history": "none",
        "--dense": "none",
        "--sparse": "none",
        "--source": "none",
        "--graph": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => St(n),
    },
    "git describe": {
      safeFlags: {
        "--tags": "none",
        "--match": "string",
        "--exclude": "string",
        "--long": "none",
        "--abbrev": "number",
        "--always": "none",
        "--contains": "none",
        "--first-match": "none",
        "--exact-match": "none",
        "--candidates": "number",
        "--dirty": "none",
        "--broken": "none",
      },
    },
    "git cat-file": {
      safeFlags: {
        "-t": "none",
        "-s": "none",
        "-p": "none",
        "-e": "none",
        "--batch-check": "none",
        "--allow-undetermined-type": "none",
      },
    },
    "git for-each-ref": {
      safeFlags: {
        "--format": "string",
        "--sort": "string",
        "--count": "number",
        "--contains": "string",
        "--no-contains": "string",
        "--merged": "string",
        "--no-merged": "string",
        "--points-at": "string",
      },
      additionalCommandIsDangerousCallback: (e, n) => St(n),
    },
    "git grep": {
      safeFlags: {
        "-e": "string",
        "-E": "none",
        "--extended-regexp": "none",
        "-G": "none",
        "--basic-regexp": "none",
        "-F": "none",
        "--fixed-strings": "none",
        "-P": "none",
        "--perl-regexp": "none",
        "-i": "none",
        "--ignore-case": "none",
        "-v": "none",
        "--invert-match": "none",
        "-w": "none",
        "--word-regexp": "none",
        "-n": "none",
        "--line-number": "none",
        "-c": "none",
        "--count": "none",
        "-l": "none",
        "--files-with-matches": "none",
        "-L": "none",
        "--files-without-match": "none",
        "-h": "none",
        "-H": "none",
        "--heading": "none",
        "--break": "none",
        "--full-name": "none",
        "--color": "none",
        "--no-color": "none",
        "-o": "none",
        "--only-matching": "none",
        "-A": "number",
        "--after-context": "number",
        "-B": "number",
        "--before-context": "number",
        "-C": "number",
        "--context": "number",
        "--and": "none",
        "--or": "none",
        "--not": "none",
        "--max-depth": "number",
        "--untracked": "none",
        "--no-index": "none",
        "--recurse-submodules": "none",
        "--cached": "none",
        "--threads": "number",
        "-q": "none",
        "--quiet": "none",
      },
    },
    "git stash show": {
      safeFlags: {
        ...Cr,
        ...Hn,
        ...Qo,
        "--word-diff": "none",
        "--word-diff-regex": "string",
        "--diff-filter": "string",
        "--abbrev": "number",
      },
    },
    "git worktree list": {
      safeFlags: {
        "--porcelain": "none",
        "-v": "none",
        "--verbose": "none",
        "--expire": "string",
      },
    },
    "git tag": {
      safeFlags: {
        "-l": "none",
        "--list": "none",
        "-n": "number",
        "--contains": "string",
        "--no-contains": "string",
        "--merged": "string",
        "--no-merged": "string",
        "--sort": "string",
        "--format": "string",
        "--points-at": "string",
        "--column": "none",
        "--no-column": "none",
        "-i": "none",
        "--ignore-case": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        if (St(n)) return !0;
        let r = new Set([
            "--contains",
            "--no-contains",
            "--merged",
            "--no-merged",
            "--points-at",
            "--sort",
            "--format",
            "-n",
          ]),
          a = 0,
          h = !1,
          y = !1;
        while (a < n.length) {
          let k = n[a];
          if (!k) {
            a++;
            continue;
          }
          if (k === "--" && !y) {
            {
              y = !0;
              a++;
            }
            continue;
          }
          if (!y && k.startsWith("-")) {
            if (k === "--list" || k === "-l") h = !0;
            else if (
              k[0] === "-" &&
              k[1] !== "-" &&
              k.length > 2 &&
              !k.includes("=") &&
              k.slice(1).includes("l")
            )
              h = !0;
            if (k.includes("=")) a++;
            else if (r.has(k)) a += 2;
            else a++;
          } else {
            if (!h) return !0;
            a++;
          }
        }
        return !1;
      },
    },
    "git branch": {
      safeFlags: {
        "-l": "none",
        "--list": "none",
        "-a": "none",
        "--all": "none",
        "-r": "none",
        "--remotes": "none",
        "-v": "none",
        "-vv": "none",
        "--verbose": "none",
        "--color": "none",
        "--no-color": "none",
        "--column": "none",
        "--no-column": "none",
        "--abbrev": "number",
        "--no-abbrev": "none",
        "--contains": "string",
        "--no-contains": "string",
        "--merged": "none",
        "--no-merged": "none",
        "--points-at": "string",
        "--sort": "string",
        "--show-current": "none",
        "-i": "none",
        "--ignore-case": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        if (St(n)) return !0;
        let r = new Set([
            "--contains",
            "--no-contains",
            "--points-at",
            "--sort",
          ]),
          a = new Set(["--merged", "--no-merged"]),
          h = 0,
          y = "",
          k = !1,
          R = !1;
        while (h < n.length) {
          let E = n[h];
          if (!E) {
            h++;
            continue;
          }
          if (E === "--" && !R) {
            {
              R = !0;
              y = "";
              h++;
            }
            continue;
          }
          if (!R && E.startsWith("-")) {
            if (E === "--list" || E === "-l") k = !0;
            else if (
              E[0] === "-" &&
              E[1] !== "-" &&
              E.length > 2 &&
              !E.includes("=") &&
              E.slice(1).includes("l")
            )
              k = !0;
            if (E.includes("=")) {
              y = nt(E, "=");
              h++;
            } else if (r.has(E)) {
              y = E;
              h += 2;
            } else {
              y = E;
              h++;
            }
          } else {
            let M = a.has(y);
            if (!k && !M) return !0;
            h++;
          }
        }
        return !1;
      },
    },
  };

  const w5r = ["docker ps", "docker images"];

  const JSn = "[lLhqjzZt]*";

  const Iat = [
    ...w5r,
    "cal",
    "uptime",
    "cat",
    "head",
    "tail",
    "wc",
    "stat",
    "strings",
    "hexdump",
    "od",
    "nl",
    "id",
    "uname",
    "free",
    "df",
    "du",
    "locale",
    "groups",
    "nproc",
    "basename",
    "dirname",
    "realpath",
    "cut",
    "paste",
    "tr",
    "column",
    "tac",
    "rev",
    "fold",
    "expand",
    "unexpand",
    "fmt",
    "comm",
    "cmp",
    "numfmt",
    "readlink",
    "diff",
    "true",
    "false",
    "sleep",
    "type",
    "expr",
    "seq",
    "tsort",
    "pr",
  ];

  const aMr = Iat.filter((e) => e.includes(" "));

  const uMr = new Set(["pwd", "whoami", "alias"]);

  const cMr = [
    ["claude", "-h"],
    ["claude", "--help"],
    ["node", "-v"],
    ["node", "--version"],
    ["python", "--version"],
    ["python3", "--version"],
    ["ip", "addr"],
  ];

  const iMr = new Set(Iat);

  const TMr = new Set(["<", "<<", "<&", "<<<"]);

  const vMr = new Set(["program", "list", "pipeline", "redirected_statement"]);

  const CMr = "bot_protected_tengu_stateful_milner";

  const ZPr = /^[A-Za-z0-9:,]+$/;

  const YPr = "tengu_tender_thunder";

  const WPr = new Set([">", ">|", "&>", ">>", "&>>", ">&"]);

  const QPr = /^\+(?:[DEMdew]|c\d*|f[cfgGn]*|[Lr]\d*)?$/;

  const JPr = /^[-+][a-zA-Z]*[LSor]$/;

  const XPr = "bot_protected_tengu_pewter_kettle";

  const lMr = new Set([
    "-delete",
    "-rm",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fls",
    "-fprintf",
    "-files0-from",
  ]);

  const dMr =
    /^-[a-zA-Z]*[fL]|^--(?:from-file|rawfile|slurpfile|argfile|run-tests|library-path)|\b(?:env|include|import)\b|\bsystem\s*\(|\$(?:\s|#.*\n)*ENV\b/;

  const nwn = /%(?:%|[-+ 0#']*(?:[1-9][0-9]*)?(?:b|(?:\.[0-9]*)?[scq]))/g;

  const twn = new RegExp(`%[-+ 0#']*[0-9.*]*${JSn}[diouxXeEfFgGaAn]`);

  const ZSn = new RegExp(`%[^%a-zA-Z]*${JSn}\\\\[0-7xX]`);

  const tMr = ["echo", "printf", "wc"];

  const Rat = ["grep", "egrep", "fgrep", "head", "tail"];

  const nMr = [...tMr, ...Rat];

  const DSn: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "-h": "none",
    "--help": "none",
    "-V": "none",
    "--version": "none",
    "-H": "none",
    "--hidden": "none",
    "-I": "none",
    "--no-ignore": "none",
    "--no-ignore-vcs": "none",
    "--no-ignore-parent": "none",
    "-s": "none",
    "--case-sensitive": "none",
    "-i": "none",
    "--ignore-case": "none",
    "-g": "none",
    "--glob": "none",
    "--regex": "none",
    "-F": "none",
    "--fixed-strings": "none",
    "-a": "none",
    "--absolute-path": "none",
    "-L": "none",
    "--follow": "none",
    "-p": "none",
    "--full-path": "none",
    "-0": "none",
    "--print0": "none",
    "-d": "number",
    "--max-depth": "number",
    "--min-depth": "number",
    "--exact-depth": "number",
    "-t": "string",
    "--type": "string",
    "-e": "string",
    "--extension": "string",
    "-S": "string",
    "--size": "string",
    "--changed-within": "string",
    "--changed-before": "string",
    "-o": "string",
    "--owner": "string",
    "-E": "string",
    "--exclude": "string",
    "--ignore-file": "string",
    "-c": "string",
    "--color": "string",
    "-j": "number",
    "--threads": "number",
    "--max-buffer-time": "string",
    "--max-results": "number",
    "-1": "none",
    "-q": "none",
    "--quiet": "none",
    "--show-errors": "none",
    "--strip-cwd-prefix": "none",
    "--one-file-system": "none",
    "--prune": "none",
    "--search-path": "string",
    "--base-directory": "string",
    "--path-separator": "string",
    "--batch-size": "number",
    "--no-require-git": "none",
    "--hyperlink": "string",
    "--and": "string",
    "--format": "string",
  };

  const wat: Readonly<Record<string, NativeBashReadonlyFlagValue>> = {
    "-e": "string",
    "--regexp": "string",
    "-f": "string",
    "--file": "string",
    "-F": "none",
    "--fixed-strings": "none",
    "-G": "none",
    "--basic-regexp": "none",
    "-E": "none",
    "--extended-regexp": "none",
    "-P": "none",
    "--perl-regexp": "none",
    "-i": "none",
    "--ignore-case": "none",
    "--no-ignore-case": "none",
    "-v": "none",
    "--invert-match": "none",
    "-w": "none",
    "--word-regexp": "none",
    "-x": "none",
    "--line-regexp": "none",
    "-c": "none",
    "--count": "none",
    "--color": "string",
    "--colour": "string",
    "-L": "none",
    "--files-without-match": "none",
    "-l": "none",
    "--files-with-matches": "none",
    "-m": "number",
    "--max-count": "number",
    "-o": "none",
    "--only-matching": "none",
    "-q": "none",
    "--quiet": "none",
    "--silent": "none",
    "-s": "none",
    "--no-messages": "none",
    "-b": "none",
    "--byte-offset": "none",
    "-H": "none",
    "--with-filename": "none",
    "-h": "none",
    "--no-filename": "none",
    "--label": "string",
    "-n": "none",
    "--line-number": "none",
    "-T": "none",
    "--initial-tab": "none",
    "-u": "none",
    "--unix-byte-offsets": "none",
    "-Z": "none",
    "--null": "none",
    "-z": "none",
    "--null-data": "none",
    "-A": "number",
    "--after-context": "number",
    "-B": "number",
    "--before-context": "number",
    "-C": "number",
    "--context": "number",
    "--group-separator": "string",
    "--no-group-separator": "none",
    "-a": "none",
    "--text": "none",
    "--binary-files": "string",
    "-I": "none",
    "-D": "string",
    "--devices": "string",
    "-d": "string",
    "--directories": "string",
    "--exclude": "string",
    "--exclude-from": "string",
    "--exclude-dir": "string",
    "--include": "string",
    "-r": "none",
    "--recursive": "none",
    "-R": "none",
    "--dereference-recursive": "none",
    "--line-buffered": "none",
    "-U": "none",
    "--binary": "none",
    "--help": "none",
    "-V": "none",
    "--version": "none",
  };

  const pMr = new Set([
    ...Iat.map(sMr),
    /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,
    /^claude -h$/,
    /^claude --help$/,
    /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/,
    /^pwd$/,
    /^whoami$/,
    /^node -v$/,
    /^node --version$/,
    /^python --version$/,
    /^python3 --version$/,
    /^history(?:\s+\d+)?\s*$/,
    /^alias$/,
    /^arch(?:\s+(?:--help|-h))?\s*$/,
    /^ip addr$/,
    /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/,
    /^jq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,
    /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
    /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
    /^find(?:[ \t]+(?:\\[()]|(?!-delete\b|-rm\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b|-files0-from\b)[^<>()$`|{}&;\n\r\s]|[ \t])+)?$/,
  ]);

  const YSn: Readonly<Record<string, NativeBashReadonlyProfile>> = {
    xargs: {
      safeFlags: {
        "-I": "{}",
        "-n": "number",
        "-P": "number",
        "-L": "number",
        "-s": "number",
        "-E": "EOF",
        "-0": "none",
        "-t": "none",
        "-r": "none",
        "-x": "none",
        "-d": "char",
      },
    },
    ...vQn,
    file: {
      safeFlags: {
        "--brief": "none",
        "-b": "none",
        "--mime": "none",
        "-i": "none",
        "--mime-type": "none",
        "--mime-encoding": "none",
        "--apple": "none",
        "--check-encoding": "none",
        "-c": "none",
        "--exclude": "string",
        "--exclude-quiet": "string",
        "--print0": "none",
        "-0": "none",
        "-F": "string",
        "--separator": "string",
        "--help": "none",
        "--version": "none",
        "-v": "none",
        "--no-dereference": "none",
        "-h": "none",
        "--dereference": "none",
        "-L": "none",
        "--keep-going": "none",
        "-k": "none",
        "--list": "none",
        "-l": "none",
        "--no-buffer": "none",
        "-n": "none",
        "--preserve-date": "none",
        "-p": "none",
        "--raw": "none",
        "-r": "none",
        "-s": "none",
        "--special-files": "none",
      },
    },
    sed: {
      safeFlags: {
        "--expression": "string",
        "-e": "string",
        "--quiet": "none",
        "--silent": "none",
        "-n": "none",
        "--regexp-extended": "none",
        "-r": "none",
        "--posix": "none",
        "-E": "none",
        "--line-length": "number",
        "-l": "number",
        "--zero-terminated": "none",
        "-z": "none",
        "--separate": "none",
        "-s": "none",
        "--unbuffered": "none",
        "-u": "none",
        "--debug": "none",
        "--help": "none",
        "--version": "none",
      },
      additionalCommandIsDangerousCallback: (e, _n) =>
        !PF(e, { source: "none" }),
    },
    sort: {
      safeFlags: {
        "--ignore-leading-blanks": "none",
        "-b": "none",
        "--dictionary-order": "none",
        "-d": "none",
        "--ignore-case": "none",
        "-f": "none",
        "--general-numeric-sort": "none",
        "-g": "none",
        "--human-numeric-sort": "none",
        "-h": "none",
        "--ignore-nonprinting": "none",
        "-i": "none",
        "--month-sort": "none",
        "-M": "none",
        "--numeric-sort": "none",
        "-n": "none",
        "--random-sort": "none",
        "-R": "none",
        "--reverse": "none",
        "-r": "none",
        "--sort": "string",
        "--stable": "none",
        "-s": "none",
        "--unique": "none",
        "-u": "none",
        "--version-sort": "none",
        "-V": "none",
        "--zero-terminated": "none",
        "-z": "none",
        "--key": "string",
        "-k": "string",
        "--field-separator": "string",
        "-t": "string",
        "--check": "none",
        "-c": "none",
        "--check-char-order": "none",
        "-C": "none",
        "--merge": "none",
        "-m": "none",
        "--buffer-size": "string",
        "-S": "string",
        "--parallel": "number",
        "--batch-size": "number",
        "--help": "none",
        "--version": "none",
      },
    },
    man: {
      additionalCommandIsDangerousCallback: (e, n) => {
        for (let E = 0; E < n.length; E++) {
          let N = required(n[E]);
          if (N === "--" || N === "-" || !N.startsWith("-")) break;
          let V;
          if (N === "-S" || N === "-s") {
            E++;
            V = n[E] ?? "";
          } else if (N.startsWith("-S=") || N.startsWith("-s=")) V = N.slice(2);
          if (V === void 0 || ZPr.test(V)) continue;
          let oe = Pat.getStore();
          if (oe?.off !== !0 && je(YPr, { safe: !0 })) {
            if (oe !== void 0) oe.refused = !0;
            return !0;
          }
        }
        let r = new Set(["-k", "-f", "--apropos", "--whatis"]),
          a = new Set(["-S", "-s"]),
          h = !1;
        for (let E of n) {
          if (E === "--") break;
          if (!E.startsWith("-") || E === "-") continue;
          if (E.startsWith("--")) {
            if (r.has(E)) h = !0;
          } else if (/[kf]/.test(E.slice(1))) h = !0;
        }
        let y = !1,
          k = !1;
        for (let E = 0; E < n.length; E++) {
          let N = required(n[E]);
          if (!k && N === "--") {
            k = !0;
            continue;
          }
          if (!(k || !N.startsWith("-") || N === "-")) {
            if (r.has(N)) y = !0;
            else if (a.has(N)) E++;
            continue;
          }
          if (((k = !0), Ys(N))) return !0;
          if (h && N.startsWith("-")) return !0;
          if (!y && (N.includes("/") || N.includes("\\") || N.includes("~")))
            return !0;
        }
        return !1;
      },
      safeFlags: {
        "-a": "none",
        "--all": "none",
        "-d": "none",
        "-f": "none",
        "--whatis": "none",
        "-h": "none",
        "-k": "none",
        "--apropos": "none",
        "-w": "none",
        "-S": "string",
        "-s": "string",
      },
    },
    help: {
      additionalCommandIsDangerousCallback: (e, n) =>
        pVo(n) || n.some((r) => r.includes("/") || r.includes("\\") || Ys(r)),
      safeFlags: { "-d": "none" },
    },
    netstat: {
      safeFlags: {
        "-a": "none",
        "-L": "none",
        "-l": "none",
        "-n": "none",
        "-f": "string",
        "-g": "none",
        "-i": "none",
        "-I": "string",
        "-s": "none",
        "-r": "none",
        "-m": "none",
        "-v": "none",
      },
    },
    ps: {
      respectsDoubleDash: !1,
      safeFlags: {
        "-e": "none",
        "-A": "none",
        "-a": "none",
        "-d": "none",
        "-N": "none",
        "--deselect": "none",
        "-f": "none",
        "-F": "none",
        "-l": "none",
        "-j": "none",
        "-y": "none",
        "-w": "none",
        "-ww": "none",
        "--width": "number",
        "-c": "none",
        "-H": "none",
        "--forest": "none",
        "--headers": "none",
        "--no-headers": "none",
        "-n": "string",
        "--sort": "string",
        "-L": "none",
        "-T": "none",
        "-m": "none",
        "-C": "string",
        "-G": "string",
        "-g": "string",
        "-p": "string",
        "--pid": "string",
        "-q": "string",
        "--quick-pid": "string",
        "-s": "string",
        "--sid": "string",
        "-t": "string",
        "--tty": "string",
        "-U": "string",
        "-u": "string",
        "--user": "string",
        "--help": "none",
        "--info": "none",
        "-V": "none",
        "--version": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        let r = n.some((k) => !Wxt(k) && /[eE]/.test(k)),
          a = n.some((k) => /^-[a-zA-Z]*e/.test(k)),
          h = n.every(
            (k) => k === "--forest" || /^-[AacdeFfjlwHLTm]+$/.test(k),
          ),
          y = n.flatMap((k) =>
            k === "--forest" ? [k] : (k.match(/[HLTm]/g) ?? []),
          );
        return r || (a && !(h && y.length <= 1));
      },
    },
    base64: {
      respectsDoubleDash: !1,
      safeFlags: {
        "-d": "none",
        "-D": "none",
        "--decode": "none",
        "-b": "number",
        "--break": "number",
        "-w": "number",
        "--wrap": "number",
        "-i": "string",
        "--input": "string",
        "--ignore-garbage": "none",
        "-h": "none",
        "--help": "none",
        "--version": "none",
      },
    },
    grep: { safeFlags: wat },
    egrep: { safeFlags: wat },
    fgrep: { safeFlags: wat },
    ...TMa,
    sha256sum: {
      safeFlags: {
        "-b": "none",
        "--binary": "none",
        "-t": "none",
        "--text": "none",
        "-c": "none",
        "--check": "none",
        "--ignore-missing": "none",
        "--quiet": "none",
        "--status": "none",
        "--strict": "none",
        "-w": "none",
        "--warn": "none",
        "--tag": "none",
        "-z": "none",
        "--zero": "none",
        "--help": "none",
        "--version": "none",
      },
    },
    sha1sum: {
      safeFlags: {
        "-b": "none",
        "--binary": "none",
        "-t": "none",
        "--text": "none",
        "-c": "none",
        "--check": "none",
        "--ignore-missing": "none",
        "--quiet": "none",
        "--status": "none",
        "--strict": "none",
        "-w": "none",
        "--warn": "none",
        "--tag": "none",
        "-z": "none",
        "--zero": "none",
        "--help": "none",
        "--version": "none",
      },
    },
    md5sum: {
      safeFlags: {
        "-b": "none",
        "--binary": "none",
        "-t": "none",
        "--text": "none",
        "-c": "none",
        "--check": "none",
        "--ignore-missing": "none",
        "--quiet": "none",
        "--status": "none",
        "--strict": "none",
        "-w": "none",
        "--warn": "none",
        "--tag": "none",
        "-z": "none",
        "--zero": "none",
        "--help": "none",
        "--version": "none",
      },
    },
    tree: {
      safeFlags: {
        "-a": "none",
        "-d": "none",
        "-l": "none",
        "-f": "none",
        "-x": "none",
        "-L": "number",
        "-P": "string",
        "-I": "string",
        "--gitignore": "none",
        "--gitfile": "string",
        "--ignore-case": "none",
        "--matchdirs": "none",
        "--metafirst": "none",
        "--prune": "none",
        "--info": "none",
        "--infofile": "string",
        "--noreport": "none",
        "--charset": "string",
        "--filelimit": "number",
        "-q": "none",
        "-N": "none",
        "-Q": "none",
        "-p": "none",
        "-u": "none",
        "-g": "none",
        "-s": "none",
        "-h": "none",
        "--si": "none",
        "--du": "none",
        "-D": "none",
        "--timefmt": "string",
        "-F": "none",
        "--inodes": "none",
        "--device": "none",
        "-v": "none",
        "-t": "none",
        "-c": "none",
        "-U": "none",
        "-r": "none",
        "--dirsfirst": "none",
        "--filesfirst": "none",
        "--sort": "string",
        "-i": "none",
        "-A": "none",
        "-S": "none",
        "-n": "none",
        "-C": "none",
        "-X": "none",
        "-J": "none",
        "-H": "string",
        "--nolinks": "none",
        "--hintro": "string",
        "--houtro": "string",
        "-T": "string",
        "--hyperlink": "none",
        "--scheme": "string",
        "--authority": "string",
        "--fromfile": "none",
        "--fromtabfile": "none",
        "--fflinks": "none",
        "--help": "none",
        "--version": "none",
      },
    },
    date: {
      safeFlags: {
        "-d": "string",
        "--date": "string",
        "-r": "string",
        "--reference": "string",
        "-u": "none",
        "--utc": "none",
        "--universal": "none",
        "-I": "none",
        "--iso-8601": "string",
        "-R": "none",
        "--rfc-email": "none",
        "--rfc-3339": "string",
        "--debug": "none",
        "--help": "none",
        "--version": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        let r = new Set(["-d", "--date", "-r", "--reference", "--rfc-3339"]),
          a = 0;
        while (a < n.length) {
          let h = required(n[a]);
          if (h.startsWith("--") && h.includes("=")) a++;
          else if (h.startsWith("-"))
            if (r.has(h)) a += 2;
            else a++;
          else {
            if (!h.startsWith("+")) return !0;
            a++;
          }
        }
        return !1;
      },
    },
    hostname: {
      safeFlags: {
        "-f": "none",
        "--fqdn": "none",
        "--long": "none",
        "-s": "none",
        "--short": "none",
        "-i": "none",
        "--ip-address": "none",
        "-I": "none",
        "--all-ip-addresses": "none",
        "-a": "none",
        "--alias": "none",
        "-d": "none",
        "--domain": "none",
        "-A": "none",
        "--all-fqdns": "none",
        "-v": "none",
        "--verbose": "none",
        "-h": "none",
        "--help": "none",
        "-V": "none",
        "--version": "none",
      },
      regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/,
    },
    which: {
      safeFlags: {
        "-a": "none",
        "--all": "none",
        "-s": "none",
        "-p": "none",
        "-w": "none",
        "--skip-dot": "none",
        "--skip-tilde": "none",
        "--show-dot": "none",
        "--show-tilde": "none",
        "--skip-alias": "none",
        "--skip-functions": "none",
        "-v": "none",
        "-V": "none",
        "--version": "none",
        "--help": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        let r = !1;
        for (let a of n) {
          if (Ys(a)) return !0;
          if (r) continue;
          if (a === "--") r = !0;
          else if (a.startsWith("-") && !/^(?:-[A-Za-z]+|--[a-z-]+)$/.test(a))
            return !0;
        }
        return !1;
      },
    },
    lsof: {
      safeFlags: {
        "-?": "none",
        "-h": "none",
        "-v": "none",
        "-a": "none",
        "-b": "none",
        "-C": "none",
        "-l": "none",
        "-n": "none",
        "-N": "none",
        "-O": "none",
        "-P": "none",
        "-Q": "none",
        "-R": "none",
        "-t": "none",
        "-U": "none",
        "-V": "none",
        "-X": "none",
        "-H": "none",
        "-E": "none",
        "-F": "none",
        "-g": "none",
        "-i": "none",
        "-K": "none",
        "-L": "none",
        "-o": "none",
        "-r": "none",
        "-s": "none",
        "-S": "none",
        "-T": "none",
        "-x": "none",
        "-A": "string",
        "-c": "string",
        "-d": "string",
        "-e": "string",
        "-k": "string",
        "-p": "string",
        "-u": "string",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        for (let r = 0; r < n.length; r++) {
          let a = required(n[r]);
          if (a === "+m" || a.startsWith("+m")) return !0;
          if (/^-[a-zA-Z]*i\S*@/.test(a)) {
            let h = nt(a.slice(a.indexOf("@") + 1), ":");
            if (/[a-zA-Z]/.test(h)) return !0;
          }
          if (/^-[a-zA-Z]*i$/.test(a)) {
            let h = n[r + 1] ?? "";
            if (h.includes("~")) return !0;
            if (h.includes("@")) {
              let y = nt(h.slice(h.indexOf("@") + 1), ":");
              if (/[a-zA-Z]/.test(y)) return !0;
            }
          }
        }
        return (
          n.some(
            (r, a) =>
              (r !== "--" && /^-[a-zA-Z]*[^a-zA-Z]/.test(r)) ||
              (r.startsWith("+") && !QPr.test(r)) ||
              (/^\d+\D/.test(r) && JPr.test(n[a - 1] ?? "")) ||
              Ys(r),
          ) &&
          je(XPr, { safe: !0 }) &&
          DY()
        );
      },
    },
    pgrep: {
      safeFlags: {
        "-d": "string",
        "--delimiter": "string",
        "-l": "none",
        "--list-name": "none",
        "-a": "none",
        "--list-full": "none",
        "-v": "none",
        "--inverse": "none",
        "-w": "none",
        "--lightweight": "none",
        "-c": "none",
        "--count": "none",
        "-f": "none",
        "--full": "none",
        "-g": "string",
        "--pgroup": "string",
        "-G": "string",
        "--group": "string",
        "-i": "none",
        "--ignore-case": "none",
        "-n": "none",
        "--newest": "none",
        "-o": "none",
        "--oldest": "none",
        "-O": "string",
        "--older": "string",
        "-P": "string",
        "--parent": "string",
        "-s": "string",
        "--session": "string",
        "-t": "string",
        "--terminal": "string",
        "-u": "string",
        "--euid": "string",
        "-U": "string",
        "--uid": "string",
        "-x": "none",
        "--exact": "none",
        "-F": "string",
        "--pidfile": "string",
        "-L": "none",
        "--logpidfile": "none",
        "-r": "string",
        "--runstates": "string",
        "--ns": "string",
        "--nslist": "string",
        "--help": "none",
        "-V": "none",
        "--version": "none",
      },
    },
    tput: {
      safeFlags: { "-T": "string", "-V": "none", "-x": "none" },
      additionalCommandIsDangerousCallback: (e, n) => {
        let r = new Set([
            "init",
            "reset",
            "rs1",
            "rs2",
            "rs3",
            "is1",
            "is2",
            "is3",
            "iprog",
            "if",
            "rf",
            "clear",
            "flash",
            "mc0",
            "mc4",
            "mc5",
            "mc5i",
            "mc5p",
            "pfkey",
            "pfloc",
            "pfx",
            "pfxl",
            "smcup",
            "rmcup",
          ]),
          a = new Set(["-T"]),
          h = 0,
          y = !1;
        while (h < n.length) {
          let k = required(n[h]);
          if (k === "--") {
            y = !0;
            h++;
          } else if (!y && k.startsWith("-")) {
            if (k === "-S") return !0;
            if (!k.startsWith("--") && k.length > 2 && k.includes("S"))
              return !0;
            if (a.has(k)) h += 2;
            else h++;
          } else {
            if (r.has(k)) return !0;
            h++;
          }
        }
        return !1;
      },
    },
    ss: {
      safeFlags: {
        "-h": "none",
        "--help": "none",
        "-V": "none",
        "--version": "none",
        "-n": "none",
        "--numeric": "none",
        "-a": "none",
        "--all": "none",
        "-l": "none",
        "--listening": "none",
        "-o": "none",
        "--options": "none",
        "-e": "none",
        "--extended": "none",
        "-m": "none",
        "--memory": "none",
        "-p": "none",
        "--processes": "none",
        "-i": "none",
        "--info": "none",
        "-s": "none",
        "--summary": "none",
        "-4": "none",
        "--ipv4": "none",
        "-6": "none",
        "--ipv6": "none",
        "-0": "none",
        "--packet": "none",
        "-t": "none",
        "--tcp": "none",
        "-M": "none",
        "--mptcp": "none",
        "-S": "none",
        "--sctp": "none",
        "-u": "none",
        "--udp": "none",
        "-d": "none",
        "--dccp": "none",
        "-w": "none",
        "--raw": "none",
        "-x": "none",
        "--unix": "none",
        "--tipc": "none",
        "--vsock": "none",
        "-f": "string",
        "--family": "string",
        "-A": "string",
        "--query": "string",
        "--socket": "string",
        "-Z": "none",
        "--context": "none",
        "-z": "none",
        "--contexts": "none",
        "-b": "none",
        "--bpf": "none",
        "-E": "none",
        "--events": "none",
        "-H": "none",
        "--no-header": "none",
        "-O": "none",
        "--oneline": "none",
        "--tipcinfo": "none",
        "--tos": "none",
        "--cgroup": "none",
        "--inet-sockopt": "none",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        let r =
            /^(dst|src|dport|sport|and|or|not|eq|ne|ge|le|gt|lt|autobound|state|exclude|dev|fwmark|cgroup)$/,
          a = /^(state|exclude|dport|sport|dev|fwmark|cgroup)$/,
          h = /^(-f|--family|-A|--query|--socket)$/,
          y = [],
          k = !1;
        for (let V = 0; V < n.length; V++) {
          let oe = required(n[V]);
          if (!k && oe === "--") {
            k = !0;
            continue;
          }
          if (!k && oe.startsWith("-")) {
            if (h.test(oe)) V++;
            continue;
          }
          y.push(oe);
        }
        if (pVo(y)) return !0;
        let E = y
            .join(" ")
            .split(/[\s()=!<>&|,]+/)
            .filter(Boolean),
          N = !1;
        for (let V of E) {
          if (N) {
            N = !1;
            continue;
          }
          if (r.test(V)) {
            N = a.test(V);
            continue;
          }
          if (
            /[g-zG-Z]/.test(V) ||
            (/[a-fA-F]/.test(V) && (V.includes(".") || !V.includes(":")))
          )
            return !0;
        }
        return !1;
      },
    },
    fd: { safeFlags: { ...DSn } },
    fdfind: { safeFlags: { ...DSn } },
    ...b5r,
    test: {
      respectsDoubleDash: !1,
      safeFlags: {
        "-b": "string",
        "-c": "string",
        "-d": "string",
        "-e": "string",
        "-f": "string",
        "-g": "string",
        "-G": "string",
        "-h": "string",
        "-k": "string",
        "-L": "string",
        "-N": "string",
        "-O": "string",
        "-p": "string",
        "-r": "string",
        "-s": "string",
        "-S": "string",
        "-t": "string",
        "-u": "string",
        "-w": "string",
        "-x": "string",
        "-z": "string",
        "-n": "string",
        "-eq": "string",
        "-ne": "string",
        "-lt": "string",
        "-le": "string",
        "-gt": "string",
        "-ge": "string",
        "-nt": "string",
        "-ot": "string",
        "-ef": "string",
      },
      additionalCommandIsDangerousCallback: (e, n) => {
        if (
          n.some(
            (r) =>
              r === "-v" ||
              r === "-R" ||
              r === "-a" ||
              r === "-o" ||
              /\[/.test(r),
          )
        )
          return !0;
        for (let r = 0; r < n.length; r++) {
          if (Lwn.has(required(n[r]))) {
            for (let a of [n[r - 1], n[r + 1]])
              if (a !== void 0 && !ZKt.test(a)) return !0;
          }
          if (n[r] === "-t") {
            let a = n[r + 1];
            if (a !== void 0 && !ZKt.test(a)) return !0;
          }
        }
        return !1;
      },
    },
  };

  function sMr(e: string): RegExp {
    return new RegExp(`^${e}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`);
  }

  function eMr(): Readonly<Record<string, NativeBashReadonlyProfile>> {
    let e = YSn;
    if (P() === "windows") {
      let { xargs: _n, ...r } = e;
      e = r;
    }
    return e;
  }

  function fMr(e: string[]): boolean | null {
    if (e.length === 0) return !1;
    let n = required(e[0]);
    if (uMr.has(n)) return e.length === 1;
    for (let a of cMr)
      if (e.length === a.length && e.every((h, y) => h === a[y])) return !0;
    if (iMr.has(n)) return !0;
    for (let a of aMr) {
      let h = a.split(" ");
      if (e.length >= h.length && h.every((y, k) => e[k] === y)) {
        if (
          h[0] === "docker" &&
          (mVo(e) || TQn(e.slice(h.length)) || e.slice(h.length).some(Ys))
        )
          return !1;
        return !0;
      }
    }
    if (n === "echo") return !0;
    let r =
      /^[-+]?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)$/;
    if (n === "printf") {
      if (e[1]?.startsWith("-") && e[1] !== "--") return !1;
      let a = e[1] === "--" ? 2 : 1,
        h = e[a] ?? "";
      if (Ys(h)) return !1;
      if (h.includes("$")) return !1;
      let y = h.replace(/%%/g, "");
      if (ZSn.test(y) || /\\[uU]/.test(y)) return !1;
      if (
        twn.test(y) ||
        /%[^%a-zA-Z]*\*/.test(y) ||
        h.replace(nwn, "").includes("%")
      )
        for (let k = a + 1; k < e.length; k++) {
          let E = required(e[k]);
          if (
            E.includes("[") ||
            E.includes("`") ||
            E.includes("$(") ||
            Ys(E) ||
            !r.test(E)
          )
            return !1;
        }
      return !0;
    }
    if (n === "[[") {
      for (let a = 1; a < e.length; a++) {
        let h = required(e[a]),
          y = e[a + 1];
        if (
          (h === "-v" || h === "-R" || h === "-t") &&
          y !== void 0 &&
          (y.includes("[") || Ys(y))
        )
          return !1;
        if (h === "-t" && y !== void 0 && !ZKt.test(y)) return !1;
        if (Lwn.has(h)) {
          for (let k of [e[a - 1], e[a + 1]])
            if (k !== void 0 && (k.includes("[") || !ZKt.test(k))) return !1;
        }
      }
      return !0;
    }
    if (n === "ls") return !0;
    if (n === "cd") return e.length <= 2;
    if (n === "find") {
      let a = !1;
      for (let h = 1; h < e.length; h++) {
        let y = required(e[h]),
          k = a;
        if (((a = !1), lMr.has(y) && ero(y))) return !1;
        if (VQn(y)) return !1;
        if (!k && zQn(y)) {
          a = !0;
          continue;
        }
        if (!k && Mwn(y)) {
          h++;
          continue;
        }
        if (Ys(y)) return !1;
      }
      return !0;
    }
    if (n === "history")
      return e.length === 1 || (e.length === 2 && /^\d+$/.test(required(e[1])));
    if (n === "arch")
      return (
        e.length === 1 ||
        (e.length === 2 && (e[1] === "-h" || e[1] === "--help"))
      );
    if (n === "ifconfig")
      return (
        e.length === 1 || (e.length === 2 && /^[a-zA-Z]/.test(required(e[1])))
      );
    if (n === "jq" && e.some((a) => Ys(a) || dMr.test(a)) && DY()) return !1;
    return null;
  }

  function rMr(e: string): boolean {
    let n = iC(e);
    if (n.length === 0) return !1;
    let r: NativeBashReadonlyProfile | undefined,
      a = 0,
      h = eMr();
    for (let [y] of Object.entries(h)) {
      let k = y.split(" ");
      if (n.length >= k.length) {
        let E = !0;
        for (let N = 0; N < k.length; N++)
          if (n[N] !== k[N]) {
            E = !1;
            break;
          }
        if (E) {
          {
            r = h[y];
            a = k.length;
          }
          break;
        }
      }
    }
    if (!r) return !1;
    if (n[0] === "git" && n[1] === "ls-remote") {
      if (
        n.some(
          (k) =>
            k === "-o" ||
            k === "--server-option" ||
            k.startsWith("--server-option="),
        )
      )
        return !1;
      let y = !1;
      for (let k = 2; k < n.length; k++) {
        let E = n[k];
        if (!E) continue;
        if (!y && E === "--") {
          y = !0;
          continue;
        }
        if (y || E === "-" || !E.startsWith("-")) return !1;
      }
    }
    for (let y = a; y < n.length; y++) {
      let k = n[y];
      if (!k) continue;
      if (k.includes("$")) return !1;
      if (k.includes("{") && (k.includes(",") || k.includes(".."))) return !1;
    }
    if (
      !hct(n, a, r, {
        commandName: n[0],
        xargsTargetCommands: n[0] === "xargs" ? nMr : void 0,
      })
    )
      return !1;
    if (r.regex && !r.regex.test(e)) return !1;
    if (!r.regex && /`/.test(e)) return !1;
    if (
      !r.regex &&
      (n[0] === "rg" ||
        n[0] === "grep" ||
        n[0] === "egrep" ||
        n[0] === "fgrep") &&
      /[\n\r]/.test(e)
    )
      return !1;
    if (
      r.additionalCommandIsDangerousCallback &&
      r.additionalCommandIsDangerousCallback(e, n.slice(a))
    )
      return !1;
    return !0;
  }

  function _Mr(e: string): boolean {
    let n = e.trim();
    if (n.endsWith(" 2>&1")) n = n.slice(0, -5).trim();
    if (tP(n)) return !1;
    if (Aat(n) === "variable") return !1;
    if (rMr(n)) return !0;
    for (let r of pMr)
      if (r.test(n)) {
        if (n.startsWith("find")) {
          let a = n.replace(/['"\\]/g, "");
          if (
            /-delete\b|-rm\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b|-files0-from\b/.test(
              a,
            )
          )
            return !1;
        }
        if (n.includes("git") && /\s-c[\s=]/.test(n)) return !1;
        if (n.includes("git") && /\s--exec-path[\s=]/.test(n)) return !1;
        if (n.includes("git") && /\s--config-env[\s=]/.test(n)) return !1;
        return !0;
      }
    return !1;
  }

  function Aat(e: string): "variable" | "glob" | false {
    let n = !1,
      r = !1,
      a = !1,
      h = !1,
      y = !1,
      k = !1,
      E = !0;
    for (let N = 0; N < e.length; N++) {
      let V = e[N];
      if (h) {
        {
          h = !1;
          E = !1;
        }
        continue;
      }
      if (V === "\\" && !n) {
        if (
          e[N + 1] ===
          `
`
        ) {
          N++;
          continue;
        }
        h = !0;
        continue;
      }
      if (a) {
        if (V === "`") {
          a = !1;
          E = !1;
        }
        continue;
      }
      if (V === "`" && !n) {
        {
          a = !0;
          E = !1;
        }
        continue;
      }
      if (V === "#" && E && !n && !r) {
        while (
          N < e.length &&
          e[N] !==
            `
`
        )
          N++;
        E = !0;
        continue;
      }
      if (V === "'" && !r) {
        {
          n = !n;
          E = !1;
        }
        continue;
      }
      if (V === '"' && !n) {
        {
          r = !r;
          E = !1;
        }
        continue;
      }
      if (n) continue;
      if (V === "$") {
        let oe = e[N + 1];
        if (oe && /[A-Za-z_@*#?!$0-9-]/.test(oe)) return "variable";
      }
      if (r) continue;
      if (
        V === " " ||
        V === "\t" ||
        V ===
          `
` ||
        V === "|" ||
        V === "&" ||
        V === ";" ||
        V === "(" ||
        V === ")" ||
        V === "<" ||
        V === ">"
      ) {
        {
          k = !1;
          E = !0;
        }
        continue;
      }
      if (((E = !1), V === "?" || V === "*")) {
        y = !0;
        continue;
      }
      if (V === "[") {
        k = !0;
        continue;
      }
      if (V === "]" && k) y = !0;
    }
    return y ? "glob" : !1;
  }

  function withPolicyScope<T>(
    permission: Policy,
    cwd: string,
    run: () => T,
    provenance: Provenance[] = [],
  ) {
    return frames.run(
      { scope: { policyId: permission.scope.policyId, cwd }, provenance },
      () => process.outer.withPolicyScope(permission, cwd, run, provenance),
    );
  }

  function swn(e: string, n: string): boolean {
    const r = nt(e, "=");
    return r.length > 2 && n.startsWith(r);
  }

  function bat(e: string): boolean {
    return /^-[^-]*c/.test(e) || swn(e, "--check");
  }

  function $Sn(e: string): boolean {
    return swn(e, "--files0-from");
  }

  const iwn = new Map([
    ["sha256sum", bat],
    ["sha1sum", bat],
    ["md5sum", bat],
    ["strings", (e) => e.startsWith("@")],
    ["wc", $Sn],
    ["du", $Sn],
  ]);

  const BSn =
    /^(?:(?:command(?:[ \t]+-p+)*|builtin)(?:[ \t]+--)?|noglob)[ \t]+(?!-)/;

  const USn = /^timeout[ \t]+\d+(?:\.\d+)?[smhd]?[ \t]+/;
  return {
    process,
    host,
    native: { hct, Yl, Wxt, St, TQn, mVo, pVo, lp, fMr, rMr, _Mr, eMr, Aat },
    profiles: YSn,
    constants: { TMr, vMr, CMr, WPr, BSn, USn, iwn },
    withPolicyScope,
  };
}
