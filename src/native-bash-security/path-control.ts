import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";
import type {
  NativeBashSemantics,
  NativeBashSemanticCommand as Command,
} from "../native-bash-semantics.js";
import type { NativeBashCommandPreparation } from "../native-bash-command-preparation.js";
import type { NativeBashPreparationRedirect as Redirect } from "../native-bash-command-preparation.js";
import { createNativeBashSecurityFileGate } from "./file-gate.js";
import { createNativeBashSecurityArguments } from "./arguments.js";
import { createNativeBashSecuritySed } from "./sed.js";
import {
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityFileHost,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityReason as Reason,
  type NativeBashSecurityInput as Input,
  type NativeBashSecurityFileOperation as Operation,
  type NativeBashSecurityInspection as Inspection,
  type NativeBashSecurityResolvedFileVerdict as Verdict,
  type NativeBashSecuritySuggestion as Suggestion,
  type NativeBashSecurityRule as Rule,
} from "./security-types.js";
type SafetyReason = Extract<Reason, { type: "safetyCheck" }>;
interface OutputRedirect {
  target: string;
  operator: ">" | ">>";
}
interface RedirectAnalysis {
  redirections: OutputRedirect[];
  inputRedirections: string[];
  hasDangerousRedirection: boolean;
  dangerousRedirectionReason:
    "network_device" | "unc_path" | "shell_expansion" | undefined;
  denyCheckOutputRedirections: OutputRedirect[];
}
export interface NativeBashSecurityPathHost extends NativeBashSecurityFileHost {
  protectedRoots?: (scope: Scope) => Fact<readonly string[]>;
  workingDirectories?: (
    policy: Policy,
    scope: Scope,
  ) => Fact<readonly string[]>;
  normalizeShellPath?: (path: string, scope: Scope) => Fact<string>;
  suggestionDirectory?: (path: string, scope: Scope) => Fact<string>;
  readDirectorySuggestion?: (
    path: string,
    destination: string,
    scope: Scope,
  ) => Fact<Suggestion | undefined>;
  feature?: (
    key: "bot_protected_tengu_quiet_peacock" | "tengu_bright_lake",
    fallback: true,
    scope: Scope,
  ) => Fact<{ value: boolean; source: string }>;
  nativePathSpelling?: (path: string, scope: Scope) => Fact<string>;
  sourceRuleRoot?: (source: string, scope: Scope) => Fact<string>;
  fileDenyRules?: (
    family: "read" | "edit",
    policy: Policy,
    scope: Scope,
  ) => Fact<readonly Rule[]>;
  originalWorkingDirectory?: (scope: Scope) => Fact<string>;
  mountedDriveRmPromptDisabled?: (scope: Scope) => Fact<boolean>;
}
function required<T>(v: T | undefined): T {
  if (v === undefined)
    throw new Error("Missing native path-consumer invariant");
  return v;
}
export function createNativeBashSecurityPathControl(
  semantic: NativeBashSemantics,
  preparation: NativeBashCommandPreparation,
  host: NativeBashSecurityPathHost,
) {
  if (
    semantic.parser !== preparation.parser ||
    semantic.features !== preparation.features
  )
    throw new Error(
      "Native Bash owners must share parser and feature contexts",
    );
  const frames = new AsyncLocalStorage<{
    policy: Policy;
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(fact: Fact<T>) =>
    readNativeBashSecurityFact(fact, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const gate = createNativeBashSecurityFileGate(
    semantic,
    host,
    () => frame().receipts,
  );
  const {
    P,
    v: dR,
    g: POe,
    w: zkn,
    D,
    OA,
    op,
    pa,
    ko,
    gs,
    Oa,
    Qd,
    vct,
    uJ,
    Pwn,
    S6e,
    f7e,
    tP,
  } = gate.bindings;
  const { Zje, cYn, uYn, eVr, tVr, Y2o, Zzr, Blt } = gate.native;
  const D1 = (
    path: string,
    cwd: string,
    policy: Policy,
    operation: Operation,
  ) => gate.check(path, cwd, policy, operation);
  const paths = host.platform === "windows" ? win32 : posix;
  const Jxr = (path: string) => paths.dirname(path);
  const Zxr = (path: string) => paths.normalize(path);
  const xOe = posix;
  const ePr = paths.sep;
  const se = () => host.filesystem;
  const features = preparation.features;
  const { Ys, Dwn, m7e, eB } = semantic.native;
  const {
    splitCommands: Sy,
    redirections: KX,
    staticArgv: iC,
  } = preparation.projection;
  const oE = preparation.stripSimpleWrappers;
  const DY = () => features.refuseEnvironment();
  const MOe = new AsyncLocalStorage<{ ignoreBelowRm?: boolean }>();
  const args = createNativeBashSecurityArguments(host.platform, zkn);
  const { extractors: aM, operations: DF, validators: IPr, verbs: OPr } = args;
  const { ty, hat, yat, fat, wSn, ESn, TSn, vSn, lSn, dSn, UOe } = args.native;
  const $Oe = Object.keys(aM);
  const GPr = new Set(["rm", "rmdir", "tee", "cp", "mv"]);
  const Bwn = /^[A-Za-z0-9_.+-]+$/;
  const $Pr =
    /^(HOME|XDG_CONFIG_HOME|PROGRAMDATA|GIT_DIR|GIT_COMMON_DIR|GIT_CEILING_DIRECTORIES|GIT_EXEC_PATH|PATH)$|^GIT_CONFIG/i;
  const ZB =
    "Reads outside the working directories are blocked (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.";
  const feature = (
    key: "bot_protected_tengu_quiet_peacock" | "tengu_bright_lake",
  ) => use(need(host.feature, "features.reader")(key, true, frame().scope));
  const sed = createNativeBashSecuritySed(
    preparation.projection,
    semantic,
    () => feature("bot_protected_tengu_quiet_peacock").value,
  );
  const { isReadOnly: PF } = sed;
  const wVo = (): string[] => [];
  const wti = () => wVo().length > 0;
  const rwn = () =>
    use(need(host.protectedRoots, "protected.roots")(frame().scope));
  const mv = (policy: Policy) =>
    use(
      need(host.workingDirectories, "cwd.workingDirectories")(
        policy,
        frame().scope,
      ),
    );
  const yre = (path: string) =>
    use(
      need(host.suggestionDirectory, "suggestions.directory")(
        path,
        frame().scope,
      ),
    );
  const Gxt = (path: string, destination: string) =>
    use(
      need(host.readDirectorySuggestion, "suggestions.readDirectory")(
        path,
        destination,
        frame().scope,
      ),
    );
  const MQn = (path: string) =>
    host.platform === "windows" && /^\/(?:cygdrive\/)?[A-Za-z]\//.test(path)
      ? use(need(host.normalizeShellPath, "path.MQn")(path, frame().scope))
      : path;
  const Y4e = (path: string) =>
    use(need(host.pathPrimitive, "path.Y4e")("Y4e", path, frame().scope));
  const kgt = (i: Inspection): readonly string[] => {
    if (!i.unresolved) return i.spellings;
    const n = ko(se(), i.requested);
    return (n.isCanonical || n.isSymlink) &&
      !i.spellings.includes(n.resolvedPath)
      ? [...i.spellings, n.resolvedPath]
      : i.spellings;
  };
  const pt = /^[\\/]\?\?[\\/]/;
  const Ar = (path: string) =>
    /^[\\/]{2}/.test(path) ||
    pt.test(path) ||
    (path.includes("??") && pt.test(win32.normalize(path)));
  const bypassImmune = new Set([
    "dangerousRemoval",
    "isolatePeerMachines",
    "restrictedMode",
    "outsideReadsBlocked",
    "connectorFileSend",
    "unfinishedCheck",
  ]);
  const classifierRouted = new Set([
    "dangerousRemoval",
    "backgroundOperator",
    "suspiciousWindowsPath",
  ]);
  const Az = (reason: SafetyReason) =>
    [
      ...(reason.circuitBreaker !== undefined ? [reason.circuitBreaker] : []),
      ...(reason.also ?? []),
    ].some((k) => bypassImmune.has(k));
  const bF = (reason: SafetyReason) =>
    reason.circuitBreaker !== undefined &&
    classifierRouted.has(reason.circuitBreaker);
  const R0 = (reason: Reason | undefined): reason is SafetyReason =>
    reason?.type === "safetyCheck" &&
    reason.circuitBreaker === "outsideReadsBlocked";
  const dk = (command: string): Decision => {
    const reason = `${command} names a path that is computed at run time, which cannot be checked against the read block (permissions.blockReadsOutsideWorkingDirectories)`;
    return {
      behavior: "ask",
      message: reason,
      decisionReason: {
        type: "safetyCheck",
        reason,
        classifierApprovable: false,
        circuitBreaker: "outsideReadsBlocked",
      },
    };
  };
  const modeRewrites = (mode: string | undefined) =>
    mode === "auto" ||
    mode === "bypassPermissions" ||
    mode === "acceptEdits" ||
    mode === "dontAsk";
  const zKt = (p: Policy) =>
    !modeRewrites(p.modeBeforeRewrite) &&
    (p.mode === "default" ||
      (p.mode === "plan" && !modeRewrites(p.prePlanMode)));
  const We = "Read";
  const hPr = /^[\\/](?:(?:proc[\\/])?cygdrive[\\/])?([A-Za-z])(?=[\\/]|$)/i;
  const Kkn = "use a literal path: when the expansion is empty this removes /";
  const Vkn = "on drive root: ";
  const Ykn = "on mounted drive path: ";
  const Zkn =
    "bin|boot|dev|etc|home|lib|lib32|lib64|libx32|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var|snap|nix|lost\\+found|private|cores|Applications|Library|System|Users|Volumes|Windows|ProgramData|cygdrive";
  const lPr = new RegExp(
    String.raw`^(?:__TRACKED_VAR__)+[\\/]+(${Zkn})(?:[\\/]+\*+)*[\\/]*$`,
    "i",
  );
  const iPr =
    /^\/(?:system\/)?volumes(?:\/[^/]+){0,2}$|^\/mnt\/(?:[^/]+|[a-z]\/[^/]+)$|^\/(?:run\/)?media(?:\/[^/]+){0,3}$/i;
  const S8 = () => {
    const { value, source } = feature("tengu_bright_lake");
    return value !== false || source !== "payload";
  };
  const s = {
    get CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT() {
      return use(
        need(
          host.mountedDriveRmPromptDisabled,
          "environment.mountedDriveRmPromptDisabled",
        )(frame().scope),
      );
    },
  };
  const U = <T>(values: T[], fn: (a: T) => unknown) =>
    values.reduce((n, a) => n + +!!fn(a), 0);
  const wt = (path: string) =>
    use(need(host.nativePathSpelling, "path.wt")(path, frame().scope));
  const ki = (path: string) => paths.isAbsolute(path);
  const Rt = zkn;
  const _e = "/";
  const Twn = (source: string) =>
    use(need(host.sourceRuleRoot, "rules.sourceRoot")(source, frame().scope));
  const Te = () =>
    use(need(host.originalWorkingDirectory, "cwd.original")(frame().scope));
  const lt = "Edit";
  const Bct = (policy: Policy, tool: string, _behavior: "deny") =>
    use(
      need(host.fileDenyRules, "rules.fileDenies")(
        tool === We ? "read" : "edit",
        policy,
        frame().scope,
      ),
    );
  function inScope<T>(policy: Policy, cwd: string, run: () => T): T {
    const previous = frame();
    return frames.run(
      { ...previous, policy, scope: { policyId: policy.scope.policyId, cwd } },
      () => gate.withPolicyScope(policy, cwd, run),
    );
  }
  function _at(e: string[]): number {
    let n = 1;
    while (n < e.length) {
      let r = required(e[n]),
        a = e[n + 1];
      if (
        r === "--foreground" ||
        r === "--preserve-status" ||
        r === "--verbose"
      )
        n++;
      else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(r)) n++;
      else if ((r === "--kill-after" || r === "--signal") && a && Bwn.test(a))
        n += 2;
      else if (r === "--") {
        n++;
        break;
      } else if (r.startsWith("--")) return -1;
      else if (r === "-v") n++;
      else if ((r === "-k" || r === "-s") && a && Bwn.test(a)) n += 2;
      else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(r)) n++;
      else if (r.startsWith("-")) return -1;
      else break;
    }
    return n;
  }

  function qPr(e: string[]): number {
    let n = 1;
    while (n < e.length) {
      let r = required(e[n]);
      if (/^-[ioe]$/.test(r) && e[n + 1]) n += 2;
      else if (/^-[ioe]./.test(r)) n++;
      else if (/^--(input|output|error)=/.test(r)) n++;
      else if (r.startsWith("-")) return -1;
      else break;
    }
    return n > 1 && n < e.length ? n : -1;
  }

  function KPr(e: string[]): number {
    let n = 1;
    while (n < e.length) {
      let r = required(e[n]);
      if (r.includes("=") && !r.startsWith("-")) n++;
      else if (r === "-i" || r === "-0" || r === "-v") n++;
      else if (r === "-u" && e[n + 1]) n += 2;
      else if (r.startsWith("-")) return -1;
      else break;
    }
    return n < e.length ? n : -1;
  }

  function l1(e: string[]): string[] {
    let n = e;
    for (;;) {
      let r = n[0]?.replace(/^.*[\\/]/, ""),
        a =
          r === "time" ||
          r === "nohup" ||
          r === "timeout" ||
          r === "nice" ||
          r === "stdbuf" ||
          r === "env" ||
          r === "command"
            ? r
            : n[0];
      if (a === "time" || a === "nohup") n = n.slice(n[1] === "--" ? 2 : 1);
      else if (a === "timeout") {
        let h = _at(n);
        if (h < 0 || !n[h] || !/^\d+(?:\.\d+)?[smhd]?$/.test(required(n[h])))
          return n;
        n = n.slice(h + 1);
      } else if (a === "nice")
        if (n[1] === "-n" && n[2] && /^-?\d+$/.test(n[2]))
          n = n.slice(n[3] === "--" ? 4 : 3);
        else if (n[1] && /^-\d+$/.test(required(n[1])))
          n = n.slice(n[2] === "--" ? 3 : 2);
        else n = n.slice(n[1] === "--" ? 2 : 1);
      else if (a === "stdbuf") {
        let h = qPr(n);
        if (h < 0) return n;
        n = n.slice(h);
      } else if (a === "env") {
        let h = KPr(n);
        if (h < 0) return n;
        n = n.slice(h);
      } else if (a === "command") {
        let h = 1;
        while (n[h] !== void 0 && /^-p+$/.test(required(n[h]))) h++;
        if (n[h] === "--") h++;
        if (h >= n.length || required(n[h]).startsWith("-")) return n;
        n = n.slice(h);
      } else if (n[0] === "builtin") {
        let h = n[1] === "--" ? 2 : 1;
        if (h >= n.length) return n;
        n = n.slice(h);
      } else if (n[0] === "noglob") {
        if (n.length <= 1) return n;
        n = n.slice(1);
      } else return n;
    }
  }

  function kSn(e: string): string[] {
    return iC(e);
  }

  function sD(e: string | undefined): string | undefined {
    if (!e) return e;
    let n = e.replace(/^.*[\\/]/, "");
    if (GPr.has(n)) return n;
    let r = n.toLowerCase().replace(/\.exe$/, "");
    return r === "tee" || r === "cp" || r === "mv" ? r : e;
  }

  function HPr(e: string[], n: string[]): string[] {
    let r = new Set(n),
      a = [];
    for (let h of e)
      if (OA(h) !== -1 && !r.has(h)) {
        r.add(h);
        a.push(h);
      }
    return a;
  }

  function NPr(e: string): number {
    let n = e[1] === "!" || e[1] === "^" ? 2 : 1;
    if (e[n] === "]") n++;
    for (; n < e.length; n++) {
      let r = required(e[n]);
      if (r === "]") return n;
      if (r === "[" && /^[:=.]/.test(e.slice(n + 1))) {
        let a = e[n + 1],
          h = e.indexOf(a + "]", n + 2);
        if (h !== -1) n = h + 1;
      }
    }
    return e.length - 1;
  }

  function HOe(e: string): boolean {
    if (OA(e) === -1) return !1;
    if (e.startsWith("[")) {
      let r = e.slice(NPr(e) + 1);
      if (OA(r) === -1 && r !== ".") return !1;
    }
    if (/\[[:=.]/.test(e)) return !0;
    if (e.startsWith("*") || e.startsWith("?")) return !1;
    let n = "^";
    for (let r = 0; r < e.length; r++) {
      let a = required(e[r]);
      if (a === "*") n += ".*";
      else if (a === "?") n += ".";
      else if (a === "[") {
        let h = e[r + 1] === "!" || e[r + 1] === "^",
          y = e.indexOf("]", r + (h ? 3 : 2));
        if (y === -1) {
          n += "\\[";
          continue;
        }
        if (r > 0 && (h || e.indexOf("]", y + 1) !== -1)) {
          n += ".*";
          break;
        }
        let k = e.slice(r + 1, y);
        if (k.startsWith("!") || k.startsWith("^")) k = "^" + k.slice(1);
        {
          n += "[" + k.replace(/[\\\]]/g, "\\$&") + "]";
          r = y;
        }
      } else n += a.replace(/[.+^$()|{}\\]/g, "\\$&");
    }
    n += "$";
    try {
      return new RegExp(n).test("..");
    } catch {
      return !0;
    }
  }

  function pSn(e: string[], n: string): { named: string[]; below: string[] } {
    if (e.length === 0) return { named: [], below: [] };
    let r = [...rwn(), ...wVo()],
      a = e.map((k) => MQn(op(k))).map((k) => (dR(k) ? k : POe(n, k))),
      h = r.map((k) => POe(k)).filter((k) => a.some((E) => Qd(k, E))),
      y = h.filter((k) => a.some((E) => Qd(E, k)));
    return { named: y, below: h.filter((k) => !y.includes(k)) };
  }

  function cSn(
    e: string,
    n: Command | undefined,
    r: string[],
    a: string[],
  ): string[] {
    if (
      e === "git" &&
      n !== void 0 &&
      !n.argv
        .slice(0, n.argv.length - r.length - 1)
        .some((E) => /(^|[\\/])env$/.test(E)) &&
      !n.envVars.some((E) => $Pr.test(E.name))
    ) {
      let { index: E, options: N } = dSn(r),
        V = r[E],
        oe = n.argvUnquotedGlob,
        re = n.argv.length - r.length,
        _e =
          oe === void 0 ||
          oe.length !== n.argv.length ||
          re < 1 ||
          oe.slice(0, re + E + 1).some(Boolean);
      if (
        !N.some(({ opt: Re, value: xe }) => {
          if (
            Re === "--bare" ||
            Re.startsWith("--config-env") ||
            Re.startsWith("--exec-path") ||
            Re.startsWith("--git-dir")
          )
            return !0;
          let Pe = xe?.trim() ?? "";
          return (
            Ys(Pe) || /^(alias|include|includeif|help\.autocorrect)\b/i.test(Pe)
          );
        }) &&
        !_e &&
        V !== void 0 &&
        !Ys(V) &&
        V !== "grep" &&
        V !== "diff"
      )
        return [];
    }
    let h = HPr(r, a);
    if (h.length === 0) return [];
    if (n === void 0 || n.carveOutMayDesyncQuoteScan === !0) return h;
    let y = n.argvUnquotedGlob,
      k = n.argv.length - r.length;
    if (y === void 0 || y.length !== n.argv.length || k < 1) return h;
    return h.filter((E) => r.some((N, V) => N === E && y[k + V] === !0));
  }

  function BOe(e: string): boolean {
    return e === We || e.startsWith(`${We}(`);
  }

  function jde(e: Policy): boolean {
    return Object.values(e.alwaysDenyRules).some((n) => (n ?? []).some(BOe));
  }

  function cat(e: Policy): boolean {
    return Object.entries(e.alwaysDenyRules).every(
      ([n, r]) => n === "hostCredential" || !(r ?? []).some(BOe),
    );
  }

  function k8(e: string, n: string, r: string): string {
    return `${e} ${n} '${r}' was blocked by a deny rule.`;
  }

  function ASn(e: string, n: string): string {
    return `${e} needs approval. The path is inside the working directories for this session (${n}), and Claude Code asks before a shell command creates, changes or removes files there.`;
  }

  function xSn(e: string, n: string): string {
    return `${e} needs approval. The path is outside the working directories for this session (${n}). Allowing runs the command as written.`;
  }

  function gSn(e: string): string {
    return `This command reaches ${e}, which Claude Code\u2019s tools cannot write`;
  }

  function hSn(e: Reason | undefined): e is SafetyReason {
    return (
      e?.type === "safetyCheck" &&
      !e.classifierApprovable &&
      (e.circuitBreaker === "internalHardDeny" ||
        e.also?.includes("internalHardDeny") === !0)
    );
  }

  function ROe(e: Decision): boolean {
    return (
      e.behavior === "ask" &&
      e.decisionReason?.type === "safetyCheck" &&
      Az(e.decisionReason) &&
      !bF(e.decisionReason)
    );
  }

  function wU(e: Decision, n: Decision | undefined): Decision {
    let r = e.decisionReason,
      a = n?.decisionReason;
    if (r?.type !== "safetyCheck" || a?.type !== "safetyCheck") return e;
    let h = D([
      ...(r.also ?? []),
      ...(a.circuitBreaker !== void 0 ? [a.circuitBreaker] : []),
      ...(a.also ?? []),
    ]).filter((y) => y !== r.circuitBreaker);
    return h.length === 0 ? e : { ...e, decisionReason: { ...r, also: h } };
  }

  function Gkn(e: Decision, n: Verdict[]): Decision {
    return n.reduce(
      (r, a) =>
        a.allowed
          ? r
          : wU(r, {
              behavior: "ask",
              message: "",
              decisionReason: a.decisionReason,
            }),
      e,
    );
  }

  function COeCore(
    e: string,
    n: string[],
    r: string,
    a: Policy,
    h: Operation,
    y: string[] = [],
  ): Decision | undefined {
    const pairs: [string[], Operation][] = [
      [n, h],
      [y, "read"],
    ];
    for (let [k, E] of pairs)
      for (let N of k) {
        if (Ys(N)) continue;
        let V = D1(N, r, a, E);
        if (!V.allowed && V.decisionReason?.type === "rule")
          return {
            behavior: "deny",
            message: `${e} in '${V.resolvedPath}' was blocked by a deny rule`,
            decisionReason: V.decisionReason,
          };
      }
    return;
  }

  function CSn(
    e: string,
    n: string,
  ): { path: string; cwdIndependent: boolean }[] {
    let r = [],
      a = op(e);
    if (a !== e) r.push({ path: a, cwdIndependent: !0 });
    if (!e.startsWith("~")) r.push({ path: POe(n, e), cwdIndependent: dR(e) });
    return r;
  }

  function RSn(e: Redirect[]): RedirectAnalysis {
    let n: OutputRedirect[] = [],
      r: string[] = [],
      a: OutputRedirect[] = [],
      h = !1,
      y: RedirectAnalysis["dangerousRedirectionReason"];
    for (let k of e) {
      if (/^\/dev\/(tcp|udp)\//.test(k.target)) {
        {
          h = !0;
          y = "network_device";
        }
        continue;
      }
      if (tP(k.target.replace(/\\/g, "/"), !0)) {
        if (((h = !0), y !== "network_device")) y = "unc_path";
        continue;
      }
      if (
        (k.op === ">" ||
          k.op === ">|" ||
          k.op === "&>" ||
          k.op === ">>" ||
          k.op === "&>>" ||
          k.op === ">&") &&
        (k.target.startsWith("~") || OA(k.target) !== -1)
      ) {
        if (((h = !0), y !== "network_device" && y !== "unc_path"))
          y = "shell_expansion";
        a.push({
          target: k.target,
          operator: k.op === ">>" || k.op === "&>>" ? ">>" : ">",
        });
        continue;
      }
      switch (k.op) {
        case ">":
        case ">|":
        case "&>":
          n.push({ target: k.target, operator: ">" });
          break;
        case ">>":
        case "&>>":
          n.push({ target: k.target, operator: ">>" });
          break;
        case ">&":
          if (!/^(?:\d+|-)$/.test(k.target))
            n.push({ target: k.target, operator: ">" });
          break;
        case "<":
          r.push(k.target);
          break;
        case "<&":
          if (!/^(?:\d+|-)$/.test(k.target)) r.push(k.target);
          break;
        case "<<":
        case "<<<":
          break;
      }
    }
    return {
      redirections: n,
      inputRedirections: r,
      hasDangerousRedirection: h,
      dangerousRedirectionReason: y,
      denyCheckOutputRedirections: a,
    };
  }

  function WknCore(
    e: OutputRedirect[],
    n: string,
    r: Policy,
    a: boolean | undefined,
  ): Decision {
    let h = e
        .filter((E) => E.target !== "/dev/null")
        .filter((E) => !a || dR(E.target) || E.target.startsWith("~"))
        .map((E) => D1(E.target, n, r, "create")),
      y = h.find((E) => !E.allowed && E.decisionReason?.type === "rule");
    if (y?.decisionReason !== void 0)
      return {
        behavior: "deny",
        message: k8("Output redirection", "to", y.resolvedPath),
        decisionReason: y.decisionReason,
      };
    if (a && e.some((E) => E.target !== "/dev/null"))
      return {
        behavior: "ask",
        message:
          "Commands that change directories and write via output redirection require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.",
        decisionReason: {
          type: "other",
          reason:
            "Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass",
          bashMissKind: "cd-compound-redirect",
        },
      };
    let k: Decision | undefined;
    for (let {
      allowed: E,
      resolvedPath: N,
      decisionReason: V,
      isInWorkingDir: oe,
    } of h)
      if (!E) {
        let re = Array.from(mv(r)),
          _e = Zzr(re),
          ke =
            V?.type === "other" || V?.type === "safetyCheck"
              ? V.reason
              : V?.type === "rule"
                ? k8("Output redirection", "to", N)
                : oe === !0 && V === void 0
                  ? ASn(`Output redirection to '${N}'`, _e)
                  : xSn(`Output redirection to '${N}'`, _e);
        if (V?.type === "rule")
          return { behavior: "deny", message: ke, decisionReason: V };
        let Re: Decision = {
          behavior: "ask",
          message: ke,
          blockedPath: N,
          decisionReason: V,
          suggestions: [
            {
              type: "addDirectories",
              directories: [yre(N)],
              destination: "session",
            },
          ],
        };
        if (V?.type === "safetyCheck") return Re;
        k ??= Re;
      }
    return (
      k ?? { behavior: "passthrough", message: "No unsafe redirections found" }
    );
  }

  function zPrCore(
    e: string[],
    n: string,
    r: Policy,
    a: boolean | undefined,
  ): Decision {
    let h: Decision | undefined;
    for (let y of e) {
      if (UOe(y)) continue;
      if (OA(y) !== -1 || (a && !dR(y) && !y.startsWith("~"))) {
        for (let oe of CSn(y, n)) {
          if (!oe.cwdIndependent && a) continue;
          for (let re of gs(oe.path)) {
            let _e = Oa(re, r, "read", "deny");
            if (_e !== null)
              return {
                behavior: "deny",
                message: k8("Input redirection", "from", re),
                decisionReason: { type: "rule", rule: _e },
              };
          }
        }
        h ??= {
          behavior: "ask",
          message: `Input redirection from '${y}' requires manual approval: the file it names depends on glob expansion or a directory change in the same command.`,
          blockedPath: y,
          decisionReason: {
            type: "other",
            reason:
              "Input redirection target is a glob or follows a cd - manual approval required",
            bashMissKind: "shell-expansion",
          },
        };
        continue;
      }
      let {
        allowed: k,
        resolvedPath: E,
        decisionReason: N,
      } = D1(y, n, r, "read");
      if (k) continue;
      if (N?.type === "rule")
        return {
          behavior: "deny",
          message: k8("Input redirection", "from", E),
          decisionReason: N,
        };
      let V = Gxt(yre(E), "session");
      h ??= {
        behavior: "ask",
        message:
          N?.type === "other" || N?.type === "safetyCheck"
            ? N.reason
            : `Input redirection from '${E}' was blocked. For security, Claude Code may only read files in the allowed working directories for this session: ${Zzr(Array.from(mv(r)))}.`,
        blockedPath: E,
        decisionReason: N,
        ...(V && { suggestions: [V] }),
      };
    }
    return (
      h ?? {
        behavior: "passthrough",
        message: "No unsafe input redirections found",
      }
    );
  }

  function LPrCore(e: string[], n: string, r: Policy): Decision | undefined {
    let a = l1([...e]),
      h = a[0],
      y = h?.slice(h.lastIndexOf("/") + 1);
    if (y !== "ln" && y !== "link") return;
    let k = a.slice(1),
      E = ty(k),
      V = E.length !== k.length || E.length === 1 ? E : E.slice(0, -1);
    if (V.some((oe) => Ys(oe))) return dk(y);
    for (let oe of V) {
      let re = D1(oe, n, r, "read");
      if (re.allowed) continue;
      if (re.decisionReason?.type === "rule")
        return {
          behavior: "deny",
          message: `${y} in '${re.resolvedPath}' was blocked by a deny rule`,
          decisionReason: re.decisionReason,
        };
      if (
        re.decisionReason?.type === "safetyCheck" &&
        re.decisionReason.reason === ZB
      )
        return {
          behavior: "ask",
          message: `${y} names a path outside the working directories, which the read block does not allow without asking (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.`,
          decisionReason: re.decisionReason,
        };
      return dk(y);
    }
    return;
  }

  function DPrCore(e: string[], n: string, r: Policy): Decision | undefined {
    let a = e[0];
    if (a === void 0) return;
    let h = a.slice(a.lastIndexOf("/") + 1),
      y;
    if (h === "pushd") {
      if (((y = ty(e.slice(1))[0]), y === void 0)) return;
    } else if (h === "env") {
      for (let E = 1; E < e.length; E++) {
        let N = required(e[E]);
        if (N === "-C" || N === "--chdir") {
          y = e[E + 1];
          break;
        }
        if (N.startsWith("--chdir=")) {
          y = N.slice(8);
          break;
        }
        if (N.startsWith("-C") && N.length > 2) {
          y = N.slice(2);
          break;
        }
      }
      if (y === void 0) return;
    } else return;
    if (Ys(y)) return dk(h);
    let k = D1(y, n, r, "read");
    if (k.allowed) return;
    if (k.decisionReason?.type === "rule")
      return {
        behavior: "deny",
        message: `${h} in '${k.resolvedPath}' was blocked by a deny rule`,
        decisionReason: k.decisionReason,
      };
    if (
      k.decisionReason?.type === "safetyCheck" &&
      k.decisionReason.reason === ZB
    )
      return {
        behavior: "ask",
        message: `${h} moves later reads to a directory outside the working directories, which the read block does not allow without asking (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.`,
        decisionReason: k.decisionReason,
      };
    return dk(h);
  }

  function BPrCore(
    e: string,
    n: string[],
    r: string,
    a: Policy,
    h: boolean | undefined,
    y: Operation | undefined,
    k: boolean | undefined,
    E: Command | undefined,
  ): Decision {
    let N = required(y ?? DF[e]),
      V = required(aM[e])(n),
      oe = cSn(e, E, n, V),
      re = N === "read" ? [...V, ...oe] : V;
    if (e === "tee" && re.length === 0 && oe.length === 0)
      return {
        behavior: "passthrough",
        message: "Path validation passed for tee command",
      };
    let _e = a.blockReadsOutsideWorkingDirectories === !0,
      ke = IPr[e],
      Re = ke !== void 0 && !ke(n),
      { targetDirectoryGiven: xe, attachedDestinations: Pe } = fat(e, n),
      Be = e === "cp" || e === "mv" ? hat(n, re, Pe) : [],
      Fe = yat(re, Be),
      Ke = n.some((Hn) => Hn.startsWith("--pa"))
        ? Be.flatMap((Hn) =>
            re
              .filter((jn) => jn !== Hn)
              .map(
                (jn) =>
                  `${Hn.replace(/[\\/]+$/, "")}/${jn.replace(/^[\\/]+/, "")}`,
              ),
          )
        : [],
      Qe = e === "cp" || e === "mv" ? wSn(n) : [],
      it = Qe.filter((Hn) => Hn.name === "S").map((Hn) => Hn.value ?? ""),
      bt = ESn(n) ? ["~", ...it].filter(Boolean) : [],
      vt = (Hn: string) => !Ys(Hn) && (!h || dR(Hn) || Hn.startsWith("~")),
      Ct = xe ? re : lSn(e, re),
      Pt = [
        ...(e === "rm" && !MOe.getStore()?.ignoreBelowRm ? re : []),
        ...(e === "mv" || (e === "cp" && !vSn(n))
          ? Ct.filter(
              (Hn) =>
                !Qe.some(
                  (jn) =>
                    jn.name === "t" && !jn.afterOperand && jn.value === Hn,
                ),
            )
          : []),
        ...Fe,
        ...Ke,
        ...(TSn(n, e === "mv" ? [] : Ct) ? Be : []),
      ],
      Dt = pSn(Pt.filter(vt), r),
      Lt = [
        ...Fe,
        ...Ke,
        ...[...Be, ...Fe, ...Ke].flatMap((Hn) =>
          bt.map((jn) => `${Hn.replace(/[\\/]+$/, "")}${jn}`),
        ),
        ...Dt.named,
        ...Dt.below,
      ],
      $t =
        !Qe.some((Hn) => Hn.name === "S" && !Hn.afterOperand && Hn.value) &&
        Qe.some(
          (Hn) =>
            Hn.name === "b" &&
            !(
              Hn.value === "t" ||
              (Hn.value !== void 0 &&
                Hn.value.length > 1 &&
                ["none", "off", "numbered"].some((jn) =>
                  jn.startsWith(Hn.value ?? ""),
                ))
            ),
        ) &&
        wti(),
      gn = N === "read" ? [] : [...Ct, ...oe],
      Ht = !_e ? [] : N === "read" ? re : gn;
    if (
      _e &&
      (Ht.some((Hn) => cYn(Hn).some((jn) => HOe(jn))) ||
        (m7e.has(e) && n.some((Hn) => /getline/.test(Hn) || Dwn(Hn) !== !1)))
    ) {
      let Hn = COe(e, [...re, ...Pe, ...Lt], r, a, N, gn);
      if (Hn) return Hn;
      return dk(e);
    }
    if (
      Ht.some((Hn) => Ys(Hn)) ||
      Ht.some((Hn) => Hn.startsWith("~") && Hn !== "~" && !Hn.startsWith("~/"))
    ) {
      let Hn = COe(e, [...re, ...Pe, ...Lt], r, a, N, gn);
      if (Hn) return Hn;
      return dk(e);
    }
    if (N !== "read")
      for (let Hn of Ht) {
        let {
          allowed: jn,
          resolvedPath: Ln,
          decisionReason: oo,
        } = D1(Hn, r, a, "read");
        if (!jn && oo?.type === "rule")
          return {
            behavior: "deny",
            message: `${e} in '${Ln}' was blocked by a deny rule`,
            decisionReason: oo,
          };
        if (!jn && R0(oo)) {
          let Go = COe(e, [...re, ...Pe, ...Lt], r, a, N, gn);
          if (Go) return Go;
          return {
            behavior: "ask",
            message:
              Re && (e === "cp" || e === "mv")
                ? `${e} names a path outside the working directories, which the read block does not allow without asking (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.`
                : oo.reason,
            decisionReason: oo,
          };
        }
      }
    let Qt = gn.map((Hn) => D1(Hn, r, a, "read")),
      nn =
        E?.argv[0] === "cp" &&
        E.argvSourceLiteral === !0 &&
        E.envVars.length === 0 &&
        !h &&
        n
          .slice(0, n.length - re.length)
          .every((Hn) => /^(?:-[pfinv]+|--)$/.test(Hn)) &&
        re.every((Hn) => /^(?!\d+$)[\w./][^*?[#^=]*$/.test(Hn)),
      yn = re.map((Hn, jn) => {
        let Ln = D1(Hn, r, a, N),
          oo = jn < Ct.length ? Qt[jn] : void 0;
        if (
          !nn ||
          oo === void 0 ||
          Ln.allowed ||
          Ln.decisionReason?.type !== "rule"
        )
          return Ln;
        let Go = D1(Hn, r, { ...a, alwaysDenyRules: {} }, N);
        return Go.allowed ? oo : Go;
      }),
      Cn = Pe.map((Hn) => D1(Hn, r, a, N)),
      vn = Lt.map((Hn) => D1(Hn, r, a, N)),
      An =
        yn.find(
          (Hn, jn) =>
            !Hn.allowed &&
            Hn.decisionReason?.type === "rule" &&
            vt(required(re[jn])),
        ) ??
        Cn.find(
          (Hn, jn) =>
            !Hn.allowed &&
            Hn.decisionReason?.type === "rule" &&
            vt(required(Pe[jn])),
        ) ??
        Qt.find(
          (Hn, jn) =>
            !Hn.allowed &&
            Hn.decisionReason?.type === "rule" &&
            vt(required(gn[jn])),
        ) ??
        vn.find(
          (Hn, jn) =>
            !Hn.allowed &&
            Hn.decisionReason?.type === "rule" &&
            vt(required(Lt[jn])),
        );
    if (An?.decisionReason !== void 0)
      return {
        behavior: "deny",
        message: k8(
          e,
          N === "read" || Qt.includes(An) ? "from" : "to",
          An.resolvedPath,
        ),
        decisionReason: An.decisionReason,
      };
    let io = [
        ...yn.filter((Hn, jn) => vt(required(re[jn]))),
        ...Cn.filter((Hn, jn) => vt(required(Pe[jn]))),
        ...vn.filter((Hn, jn) => vt(required(Lt[jn]))),
      ].find((Hn) => N !== "read" && !Hn.allowed && hSn(Hn.decisionReason)),
      Qn = [...yn, ...Cn, ...vn];
    if (io?.decisionReason?.type === "safetyCheck") {
      let Hn = Lt[vn.indexOf(io)],
        jn =
          Hn !== void 0 && Dt.below.includes(Hn)
            ? gSn(Hn)
            : io.decisionReason.reason;
      return Gkn(
        {
          behavior: "ask",
          message: jn,
          blockedPath: io.resolvedPath,
          decisionReason: { ...io.decisionReason, reason: jn },
        },
        Qn,
      );
    }
    if ($t) {
      let Hn = `${e} makes a backup whose name depends on the environment (no -S suffix on the line)`;
      return Gkn(
        {
          behavior: "ask",
          message: Hn,
          decisionReason: {
            type: "safetyCheck",
            reason: Hn,
            classifierApprovable: !1,
          },
        },
        Qn,
      );
    }
    if (N !== "read" && re.some((Hn) => Ys(Hn)))
      return {
        behavior: "ask",
        message: `${e} target contains command-substitution or untracked-variable output \u2014 the path is runtime-determined and cannot be validated`,
        decisionReason: {
          type: "other",
          reason: `${e} path argument is runtime-determined`,
          bashMissKind: "shell-expansion",
        },
      };
    if (Re) {
      if (e === "cd") {
        if (_e) return dk(e);
        return {
          behavior: "ask",
          message: `cd with two or more directory arguments requires manual approval. zsh's "cd OLD NEW" form substitutes OLD\u2192NEW in $PWD, producing a target path that cannot be statically validated.`,
          decisionReason: {
            type: "other",
            reason: "cd with two or more directory arguments",
            bashMissKind: "cd-multi-positional",
          },
        };
      }
      return {
        behavior: "ask",
        message: `${e} with flags requires manual approval to ensure path safety. For security, Claude Code cannot automatically validate ${e} commands that use flags, as some flags like --target-directory=PATH can bypass path validation.`,
        decisionReason: {
          type: "other",
          reason: `${e} command with flags requires manual approval`,
          bashMissKind: "flag-validation",
        },
      };
    }
    if (
      h &&
      N === "read" &&
      re.some((Hn) => !dR(op(Hn))) &&
      (_e || (e !== "cd" && k !== !0 && jde(a)))
    ) {
      let Hn = COe(e, re, r, a, N);
      if (Hn) return Hn;
      if (_e) return dk(e);
      let jn = cat(a);
      return {
        behavior: "ask",
        message: jn
          ? `${e} reads a relative path after cd. That can't be checked against this computer's keys and sign-in files first.`
          : `${e} reads a file by a relative path after a cd in a compound command; which file that is cannot be resolved statically while a Read() deny rule is configured, so this needs approval.`,
        decisionReason: {
          type: "other",
          reason: jn
            ? "A relative read after cd can't be checked against keys and sign-in files"
            : "Compound command contains cd with a relative file read while a Read() deny rule exists",
          bashMissKind: "cd-compound-read",
        },
      };
    }
    if (h && N !== "read")
      return {
        behavior: "ask",
        message:
          "Commands that change directories and perform write operations require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.",
        decisionReason: {
          type: "other",
          reason:
            "Compound command contains cd with write operation - manual approval required to prevent path resolution bypass",
          bashMissKind: "cd-compound-write",
        },
      };
    let so: Decision | undefined,
      Ao = [
        ...yn,
        ...vn.filter(
          (Hn) => !Hn.allowed && Hn.decisionReason?.type === "safetyCheck",
        ),
      ],
      _o = Ao.filter(
        (Hn) => !Hn.allowed && Hn.decisionReason?.type === "safetyCheck",
      ),
      Mo =
        _o.length === 0 ||
        (e === "cp" && _o.at(-1) !== Ao.at(-1)) ||
        yn.some((Hn) => !Hn.allowed && Hn.decisionReason?.type === "rule"),
      co = yn.at(-1)?.allowed
        ? vn.filter(
            (Hn) => !Hn.allowed && Hn.decisionReason?.type !== "safetyCheck",
          )
        : [],
      ao = co.length > 0 && DY() ? co : [];
    for (let {
      allowed: Hn,
      resolvedPath: jn,
      decisionReason: Ln,
      isInWorkingDir: oo,
    } of Mo ? [...Ao, ...ao] : _o.slice(0, 1))
      if (!Hn) {
        let Go = Array.from(mv(a)),
          Qr = Zzr(Go),
          ws = oo === !0 && Ln === void 0,
          Ko =
            Ln?.type === "other" || Ln?.type === "safetyCheck"
              ? Ln.reason
              : ws
                ? ASn(`${e} in '${jn}'`, Qr)
                : N !== "read" && Ln?.type !== "rule"
                  ? xSn(`${e} in '${jn}'`, Qr)
                  : `${e} in '${jn}' was blocked. For security, Claude Code may only ${OPr[e]} the allowed working directories for this session: ${Qr}.`;
        if (Ln?.type === "rule")
          return { behavior: "deny", message: Ko, decisionReason: Ln };
        let go: Decision = {
          behavior: "ask",
          message: Ko,
          blockedPath: jn,
          decisionReason: Ln,
          bashAllowRuleOverridable: ws,
        };
        if (ws) {
          so ??= go;
          continue;
        }
        return go;
      }
    if (so) return so;
    return {
      behavior: "passthrough",
      message: `Path validation passed for ${e} command`,
    };
  }

  function tat(
    e: string,
    n?: Operation,
  ): (
    r: string[],
    a: string,
    h: Policy,
    y?: boolean,
    k?: boolean,
    E?: Command,
  ) => Decision {
    return (r, a, h, y, k, E) => {
      let N = BPr(e, r, a, h, y, n, k, E);
      if (N.behavior === "deny") return N;
      if (e === "rm" || e === "rmdir") {
        let V = o2(e, r, a, h, y);
        if (V.behavior !== "passthrough") return V;
      }
      if (N.behavior === "passthrough") return N;
      if (N.behavior === "ask") {
        let V = n ?? DF[e],
          oe: Suggestion[] = [];
        if (N.blockedPath)
          if (V === "read") {
            let re = yre(N.blockedPath),
              _e = Gxt(re, "session");
            if (_e) oe.push(_e);
          } else
            oe.push({
              type: "addDirectories",
              directories: [yre(N.blockedPath)],
              destination: "session",
            });
        if ((V === "write" || V === "create") && zKt(h))
          oe.push({
            type: "setMode",
            mode: "acceptEdits",
            destination: "session",
          });
        N.suggestions = oe;
      }
      return N;
    };
  }

  function UPrCore(
    e: string,
    n: string,
    r: Policy,
    a: boolean | undefined,
    h: boolean | undefined,
  ): Decision {
    let y = oE(e),
      k = kSn(y);
    if (k.length === 0)
      return {
        behavior: "passthrough",
        message: "Empty command - no paths to validate",
      };
    let [E, ...N] = k,
      V = sD(E);
    if (!V || !$Oe.includes(V)) return ySn(E, N, n, r);
    let oe: Operation | undefined =
      V === "sed" && PF(y, { source: "none" }) ? "read" : void 0;
    return tat(V, oe)(N, n, r, a, h);
  }

  function jPrCore(
    e: Command,
    n: string,
    r: Policy,
    a: boolean | undefined,
    h: boolean | undefined,
  ): Decision {
    let y = l1(e.argv);
    if (y.length === 0)
      return {
        behavior: "passthrough",
        message: "Empty command - no paths to validate",
      };
    let [k, ...E] = y,
      N = sD(k);
    if (!N || !$Oe.includes(N)) return ySn(k, E, n, r);
    let V = oE(e.text),
      oe = r.blockReadsOutsideWorkingDirectories === !0,
      re: Operation | undefined =
        N === "sed" && PF(V, { source: oe ? "none" : e }) ? "read" : void 0,
      ke = tat(N, re)(E, n, r, a, h, e);
    if (
      oe &&
      re !== void 0 &&
      ke.behavior !== "deny" &&
      !PF(V, { source: e })
    ) {
      let Re = tat(N)(E, n, r, a, h, e);
      if (Re.behavior === "deny") return Re;
      if (!R0(ke.decisionReason)) return wU(dk("sed"), ke);
    }
    return ke;
  }

  function ySnCore(
    e: string | undefined,
    n: string[],
    r: string,
    a: Policy,
  ): Decision {
    let h = (e ?? "")
        .replace(/^.*[\\/]/, "")
        .toLowerCase()
        .replace(/\.exe$/, ""),
      y: Decision = {
        behavior: "passthrough",
        message: `Command '${e}' is not a path-restricted command`,
      };
    if (h !== "ln" && h !== "link") return y;
    let k = ty(n),
      E = { ...a, alwaysDenyRules: {} },
      N = [...hat(n, k, []), ...(k.length === 1 ? ["."] : [])],
      V =
        fat("mv", n).targetDirectoryGiven || k.length === 1
          ? k
          : k.slice(0, -1),
      oe = pSn(
        [
          ...V,
          ...V.flatMap((_e) =>
            N.flatMap((ke) => [`${ke}/${_e}`, `${Jxr(ke)}/${_e}`]),
          ),
        ],
        r,
      ),
      re = [...k.filter((_e) => !V.includes(_e)), ...yat(k, N)];
    for (let _e of D([...V, ...re, ...oe.named, ...oe.below])) {
      let { decisionReason: ke, resolvedPath: Re } = D1(_e, r, E, "write");
      if (hSn(ke)) {
        let xe = re.includes(_e)
          ? ke.reason
          : oe.below.includes(_e)
            ? gSn(_e)
            : `${ke.reason.replace(/\.$/, "")}. A link gives the file a second name, and later writes to that name change it.`;
        return {
          behavior: "ask",
          message: xe,
          blockedPath: Re,
          decisionReason: { ...ke, reason: xe },
        };
      }
    }
    return y;
  }

  function nb(e: string, n: string, r: string, a: string): Decision {
    return {
      behavior: "ask",
      message: n,
      decisionReason: {
        type: "safetyCheck",
        reason: `Dangerous ${e} operation ${r}`,
        classifierApprovable: !1,
        circuitBreaker: "dangerousRemoval",
        removalRule: a,
      },
      suggestions: [],
    };
  }

  function Fkn(e: string): string {
    return xOe.normalize(e.replaceAll("\\", "/")).replace(/(.)\/$/, "$1");
  }

  function OOe(e: string): boolean {
    return rSn(e, Blt);
  }

  function rSn(e: string, n: (a: string) => boolean): boolean {
    if (n(e)) return !0;
    let r = NOe(e);
    return r !== void 0 && n(r);
  }

  function NOe(e: string): string | undefined {
    if (P() !== "windows") return;
    let n = Y4e(e);
    if (n !== e) return n;
    let r = hPr.exec(e);
    if (r === null) return;
    let a = e.slice(r[0].length).replace(/\//g, "\\");
    return `${required(r[1]).toUpperCase()}:${a === "" ? "\\" : a}`;
  }

  function rat(e: string): boolean {
    if (P() !== "windows") return !1;
    let n = e.replace(/\\/g, "/"),
      r = n.replace(/^[A-Za-z]:(?=\/)/, "");
    return (
      /^[A-Za-z]:[^/]/.test(n) ||
      (r.startsWith("/") && !/^\/\/[^/]/.test(n) && xOe.normalize(r) !== r)
    );
  }

  function o2Core(
    e: string,
    n: string[],
    r: string,
    a: Policy | undefined,
    h: boolean | undefined,
  ): Decision {
    let y = required(aM[e]),
      k = y(n),
      { resolvedPath: E } = ko(se(), r),
      N = E === r ? [r] : [r, E],
      V = D(
        [...N, ...(a ? mv(a) : [])].flatMap((xe) => {
          let { resolvedPath: Pe } = ko(se(), xe);
          return Pe === xe ? [xe] : [xe, Pe];
        }),
      ),
      oe = S8(),
      _e = (n.includes("--") ? n.slice(0, n.indexOf("--")) : n).some(
        (xe) =>
          /^--r|^-[a-zA-Z]*[rR]/.test(xe) ||
          (!xe.includes("/") &&
            (xe.includes("__CMDSUB__") || Ys(xe)) &&
            /^(?:-|__(?:CMDSUB(?:_OUTPUT)?|TRACKED_VAR)__)/.test(xe)),
      ),
      ke,
      Re;
    for (let xe of k) {
      if (oe) {
        let ot = lPr.exec(xe)?.[1];
        if (ot !== void 0) {
          let it = eB(xe);
          return nb(
            e,
            `Dangerous ${e} operation detected: '${it}'

The target starts with a shell expansion this check cannot read and ends in a top-level directory name: if the expansion is empty, this removes '/${ot}'. This requires explicit approval and cannot be auto-allowed by permission rules.

Use a literal absolute path instead.`,
            `on possibly-empty variable path: ${it} (${Kkn}${ot})`,
            "placeholder_root_child",
          );
        }
        if (/^\\+$/.test(xe))
          return nb(
            e,
            `Dangerous ${e} operation detected: '${xe}'

A backslash-only target is the drive root in Git Bash on Windows. This requires explicit approval and cannot be auto-allowed by permission rules.

Write the directory you mean as a path, for example /c/work/build or C:/work/build.`,
            `${Vkn}${xe}`,
            "backslash_only",
          );
      }
      if (rat(xe))
        Re ??= nb(
          e,
          `Dangerous ${e} operation detected: '${xe}'

Git Bash may read this Windows path differently from this check, so where it lands is unknown. This requires explicit approval and cannot be auto-allowed by permission rules.

Write the directory you mean as a plain path, for example /c/work/build or C:/work/build.`,
          `on a Windows path this check cannot place: ${xe}`,
          "windows_unplaceable_path",
        );
      let Pe = op(xe),
        Be = dR(Pe) ? Pe : POe(r, Pe),
        Fe = Be;
      for (let ot = ""; ot !== Fe;) {
        ot = Fe;
        let it = Fe.replace(/([\\/]\*+)+[\\/]*$/, "") || "/";
        if (it !== Fe) Fe = /[\\/]/.test(it) ? Zxr(it) : it;
      }
      let Ke = Fe !== Be;
      if (h && Ke && !dR(Pe) && /[\\/]\*$/.test(Be))
        return nb(
          e,
          `Dangerous ${e} operation detected: '${Be}'

This command changes directories before the removal, so the relative glob target cannot be statically resolved. This requires explicit approval and cannot be auto-allowed by permission rules.`,
          `on statically-unresolvable target: ${Be}`,
          "relative_glob_after_cd",
        );
      let Qe = Fe;
      if (!dR(Pe)) {
        let ot = /[\\/]$/.test(r) ? r : r + ePr;
        if (Fe.startsWith(ot)) Qe = Fe.slice(ot.length);
        else if (Fe === r) Qe = "";
      }
      if (
        Ke &&
        (Zje(Pe) ||
          Ys(Be) ||
          Pe.startsWith("~") ||
          Ar(Pe) ||
          (!dR(Pe) &&
            /(^|[\\/])\.\.([\\/]|$)/.test(Pe) &&
            /[\\/]\*$/.test(Be)) ||
          (e === "rmdir" &&
            /[\\/]\*$/.test(Be) &&
            n.some((ot) => ot.startsWith("--p") || /^-[a-z]*p/.test(ot))) ||
          (!dR(Pe) && /\*[\\/]+$/.test(Pe) && /[\\/]\*$/.test(Be)))
      )
        return nb(
          e,
          `Dangerous ${e} operation detected: '${Be}'

This command's removal target cannot be statically resolved to a directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
          `on statically-unresolvable target: ${Be}`,
          "unresolvable_target",
        );
      if (!Ke || !/[*?[]/.test(Qe)) {
        let ot = [Fe];
        if (Fe !== Be) {
          let { resolvedPath: it } = ko(se(), Fe);
          if (it !== Fe) ot.push(it);
        }
        for (let it of ot) {
          if (OOe(it)) {
            let vt = Fkn(it);
            return nb(
              e,
              `Dangerous ${e} operation detected: '${Be}'

This command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
              `on critical path: ${Be}`,
              vt === "/"
                ? "root"
                : vt === Fkn(zkn())
                  ? "home"
                  : xOe.basename(vt) === "tmp"
                    ? "tmp"
                    : "other_critical_path",
            );
          }
          let bt = Ke ? V : N;
          if (rSn(it, (vt) => bt.some((Ct) => Qd(Ct, vt))))
            return nb(
              e,
              `Dangerous ${e} operation detected: '${Be}'

This command would remove a workspace directory (the working directory, an additional working directory, or one of their parent directories). This requires explicit approval and cannot be auto-allowed by permission rules.`,
              `on working directory or its ancestor: ${Be}`,
              "working_directory",
            );
        }
        if (
          ke === void 0 &&
          oe &&
          !s.CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT &&
          e === "rm" &&
          (_e || Ke) &&
          ot.some((it) => {
            let bt = xOe.normalize(it).replace(/(.)\/$/, "$1");
            return it.startsWith("/") && iPr.test(bt);
          })
        ) {
          let it = eB(Be).replaceAll("__CMDSUB__", "$(\u2026)");
          ke = nb(
            e,
            `Dangerous ${e} operation detected: '${it}'

This command would remove a mounted drive, the folder that holds mounted drives, or a file or folder at the top level of a drive. This requires explicit approval and cannot be auto-allowed by permission rules.

If you meant something deeper inside, name it by its full path.`,
            `${Ykn}${it}`,
            "mounted_drive_path",
          );
        }
      }
      if (Ke && /[\\/]\*$/.test(Be)) {
        let ot =
            U(Be.split(/[\\/]+/), (bt) => bt && bt !== ".") -
            U(Fe.split(/[\\/]+/), (bt) => bt && bt !== "."),
          it = U(Qe.split(/[\\/]+/), (bt) => /[*?[]/.test(bt));
        if (ot + it > 1)
          return nb(
            e,
            `Dangerous ${e} operation detected: '${Be}'

This command's glob pattern traverses directories that cannot be statically enumerated. This requires explicit approval and cannot be auto-allowed by permission rules.`,
            `on statically-unresolvable target: ${Be}`,
            "multi_level_glob",
          );
      }
    }
    return (
      ke ??
      Re ?? {
        behavior: "passthrough",
        message: `No dangerous removals detected for ${e} command`,
      }
    );
  }

  function mDCore(
    e: Input,
    n: string,
    r: Policy,
    a: boolean | undefined,
    h: Redirect[] | undefined,
    y: Command[] | undefined,
    k?: boolean,
  ): Decision {
    let E: Decision | undefined =
        !y && />>\s*>\s*\(|>\s*>\s*\(|<\s*\(/.test(e.command)
          ? {
              behavior: "ask",
              message:
                "Process substitution (>(...) or <(...)) can execute arbitrary commands and requires manual approval",
              decisionReason: {
                type: "other",
                reason: "Process substitution requires manual approval",
                bashMissKind: "process-substitution",
              },
            }
          : void 0,
      N = h ? RSn(h) : void 0,
      {
        redirections: V,
        hasDangerousRedirection: oe,
        dangerousRedirectionReason: re,
      } = N ?? KX(e.command),
      _e = zPr(N?.inputRedirections ?? [], n, r, a);
    if (_e.behavior === "deny") return _e;
    let ke = y
        ? y.map((Pt) => jPr(Pt, n, r, a, k))
        : Sy(e.command).map((Pt) => UPr(Pt, n, r, a, k)),
      Re = ke.find((Pt) => Pt.behavior === "deny");
    if (Re !== void 0) return Re;
    let xe = ke.find(
      (Pt) =>
        Pt.behavior === "ask" &&
        Pt.decisionReason?.type === "safetyCheck" &&
        Az(Pt.decisionReason),
    );
    if (E !== void 0) return xe ?? E;
    let Pe: Decision | undefined;
    if (oe) {
      let Pt: Decision | undefined,
        Dt: Decision | undefined,
        Lt: Decision | undefined,
        $t = [],
        gn = !1;
      for (let Cn of [...(N?.denyCheckOutputRedirections ?? []), ...V].filter(
        (vn) => Zje(vn.target),
      )) {
        let vn = Wkn([Cn], n, r, a);
        if (vn.behavior === "deny") return vn;
        if (
          vn.behavior === "ask" &&
          vn.decisionReason?.type === "safetyCheck"
        ) {
          let {
            circuitBreaker: An,
            also: io,
            classifierApprovable: Qn,
          } = vn.decisionReason;
          {
            Lt ??= vn;
            $t.push(...(An !== void 0 ? [An] : []), ...(io ?? []));
            gn ||= !Qn;
          }
        }
      }
      if (N !== void 0) {
        let Cn = [...N.denyCheckOutputRedirections, ...V];
        for (let vn of Cn)
          for (let An of CSn(vn.target, n)) {
            let io = pa(An.path),
              Qn = kgt(io);
            for (let oo of Qn) {
              let Go = Oa(oo, r, "edit", "deny");
              if (Go !== null) {
                if (An.cwdIndependent || !a)
                  return {
                    behavior: "deny",
                    message: k8("Output redirection", "to", oo),
                    decisionReason: { type: "rule", rule: Go },
                  };
              }
            }
            let so = vct(An.path, {}, Qn, { restricted: r.restricted }),
              Ao = so.behavior === "deny" && !0,
              _o = Ao ? eVr(so.decisionReason) : void 0,
              Mo = Ao ? tVr(so.decisionReason) : void 0,
              co = uJ(An.path, Qn),
              ao = S6e(io, r),
              Hn;
            if (Ao) {
              if (
                ((Hn =
                  ao === null
                    ? void 0
                    : {
                        sentence: f7e(An.path, ao),
                        personOnly: ao.carriedOut || !Pwn(An.path, r),
                      }),
                $t.push("internalHardDeny", ...(Mo !== void 0 ? [Mo] : [])),
                Mo !== void 0 || Hn?.personOnly === !0)
              )
                gn = !0;
            }
            let jn =
                co.safe || ao === null
                  ? null
                  : {
                      sentence: f7e(An.path, ao),
                      personOnly: ao.carriedOut || uJ(An.path, [An.path]).safe,
                    },
              Ln =
                co.safe ||
                (co.classifierApprovable &&
                  jn?.personOnly !== !0 &&
                  Hn?.personOnly !== !0);
            if (!co.safe) {
              if (
                ($t.push(
                  ...(co.circuitBreaker !== void 0 ? [co.circuitBreaker] : []),
                  ...(co.also ?? []),
                ),
                jn?.personOnly === !0)
              )
                gn = !0;
            }
            if (
              Pt === void 0 ||
              (Pt.decisionReason?.type === "safetyCheck" &&
                Pt.decisionReason.classifierApprovable)
            ) {
              let oo =
                Pt?.decisionReason?.type === "safetyCheck"
                  ? Pt.decisionReason.circuitBreaker
                  : void 0;
              if (
                !co.safe &&
                (Pt === void 0 ||
                  !Ln ||
                  (co.circuitBreaker !== void 0 && oo === void 0))
              ) {
                let Go = _o ?? co.message,
                  Qr =
                    jn === null
                      ? Go
                      : `${Go.endsWith(".") ? Go : `${Go}.`} ${jn.sentence}.`;
                Pt = {
                  behavior: "ask",
                  message: Qr,
                  decisionReason: {
                    type: "safetyCheck",
                    reason: Qr,
                    ...(r.restricted
                      ? {
                          classifierApprovable: !1,
                          circuitBreaker: "restrictedMode",
                        }
                      : {
                          classifierApprovable: Ln,
                          circuitBreaker: co.circuitBreaker ?? Mo,
                        }),
                  },
                };
                continue;
              }
            }
            if (
              co.safe &&
              Ao &&
              (Dt === void 0 ||
                ((Mo !== void 0 || Hn?.personOnly === !0) &&
                  Dt.decisionReason?.type === "safetyCheck" &&
                  Dt.decisionReason.classifierApprovable))
            )
              Dt = {
                behavior: "ask",
                message: _o ?? so.message,
                decisionReason: Y2o(so, r.restricted, Hn),
              };
            if (co.safe && !Ao && ao?.carriedOut === !0) {
              gn = !0;
              let oo = f7e(An.path, ao),
                Go: Decision = {
                  behavior: "ask",
                  message: oo,
                  decisionReason: {
                    type: "safetyCheck",
                    reason: oo,
                    classifierApprovable: !1,
                  },
                };
              if (Pt === void 0) Lt ??= Go;
              else if (
                Pt.decisionReason?.type === "safetyCheck" &&
                Pt.decisionReason.classifierApprovable
              )
                Pt = Go;
            }
          }
      }
      let Ht = (Cn: Decision): Decision => {
        if (Cn.behavior !== "ask" || Cn.decisionReason?.type !== "safetyCheck")
          return Cn;
        let vn = Cn.decisionReason,
          An = D([...(vn.also ?? []), ...$t]).filter(
            (io) => io !== vn.circuitBreaker,
          );
        return {
          ...Cn,
          decisionReason: {
            ...vn,
            classifierApprovable: vn.classifierApprovable && !gn,
            ...(An.length > 0 && { also: An }),
          },
        };
      };
      if (Pt !== void 0) {
        let Cn = Ht(Pt);
        return xe === void 0 || ROe(Cn) ? Cn : Ht(xe);
      }
      let Qt =
          re === "network_device"
            ? "Redirect involving /dev/tcp or /dev/udp opens a network connection"
            : re === "unc_path"
              ? "Redirect target is a Windows UNC path \u2014 opening it triggers an SMB connection"
              : "Shell expansion syntax in paths requires manual approval",
        yn: Decision =
          Lt !== void 0
            ? Ht(Lt)
            : Dt !== void 0
              ? Ht(Dt)
              : {
                  behavior: "ask",
                  message: Qt,
                  decisionReason: {
                    type: "other",
                    reason: Qt,
                    bashMissKind:
                      re === "network_device" || re === "unc_path"
                        ? "net-redirect"
                        : "shell-expansion",
                  },
                };
      if (r.blockReadsOutsideWorkingDirectories !== !0)
        return xe === void 0 || ROe(yn) ? yn : Ht(xe);
      Pe = yn;
    }
    let Be: Decision | undefined;
    function Fe(Pt: Decision): Decision | undefined {
      if (Pt.behavior === "deny") return Pt;
      if (Pt.behavior === "ask") {
        if (Pt.bashAllowRuleOverridable) {
          Be ??= Pt;
          return;
        }
        return Pt;
      }
      return;
    }
    let Ke = Wkn(V, n, r, a),
      Qe = Fe(Ke),
      ot;
    if (Qe) {
      if (
        Qe.behavior === "deny" ||
        r.blockReadsOutsideWorkingDirectories !== !0
      )
        return Qe.behavior === "ask" && xe !== void 0 && !ROe(Qe)
          ? wU(xe, Qe)
          : Qe;
      ot = Qe;
    }
    let it: Decision | undefined;
    if (r.blockReadsOutsideWorkingDirectories === !0 && h)
      for (let Pt of h) {
        if (Pt.op !== "<") continue;
        if (Ys(Pt.target)) {
          it ??= dk("input redirect");
          continue;
        }
        let Dt = D1(Pt.target, n, r, "read");
        if (!Dt.allowed && Dt.decisionReason?.type === "rule")
          return {
            behavior: "deny",
            message: `Input redirection from '${Dt.resolvedPath}' was blocked by a deny rule.`,
            decisionReason: Dt.decisionReason,
          };
        if (!Dt.allowed && R0(Dt.decisionReason)) {
          it ??= {
            behavior: "ask",
            message: Dt.decisionReason.reason,
            decisionReason: Dt.decisionReason,
          };
          continue;
        }
        if (cYn(Pt.target).some((Lt) => HOe(Lt)) || uYn(Pt.target)) {
          it ??= dk("input redirect");
          continue;
        }
        if (Dt.allowed) continue;
        it ??= dk("input redirect");
      }
    let bt;
    if (r.blockReadsOutsideWorkingDirectories === !0) {
      let Pt = y ? y.map((Dt) => Dt.argv) : Sy(e.command).map((Dt) => kSn(Dt));
      for (let Dt of Pt) {
        let Lt = LPr(Dt, n, r) ?? DPr(Dt, n, r);
        if (Lt?.behavior === "deny") return Lt;
        bt ??= Lt;
      }
    }
    bt ??= it;
    let vt = r.blockReadsOutsideWorkingDirectories === !0,
      Ct;
    for (let Pt of ke) {
      let Dt = Fe(Pt);
      if (!Dt) continue;
      if (Dt.behavior === "deny" || !vt) return Dt;
      if (R0(Dt.decisionReason)) bt ??= Dt;
      else Ct ??= Dt;
    }
    if (bt) return bt;
    if (xe)
      return (
        [Pe, ot].find((Pt) => Pt !== void 0 && ROe(Pt)) ?? wU(xe, Pe ?? ot)
      );
    if (Pe) return Pe;
    if (ot) return ot;
    if (Ct) return Ct;
    if (_e.behavior === "ask") return _e;
    if (Be) return Be;
    return {
      behavior: "passthrough",
      message: "All path commands validated successfully",
    };
  }

  function mD(
    e: Input,
    n: string,
    r: Policy,
    a: boolean | undefined,
    h: Redirect[] | undefined,
    y: Command[] | undefined,
    k?: boolean,
  ): Decision {
    return inScope(r, n, () => mDCore(e, n, r, a, h, y, k));
  }
  function BPr(
    e: string,
    n: string[],
    r: string,
    a: Policy,
    h: boolean | undefined,
    y: Operation | undefined,
    k: boolean | undefined,
    E: Command | undefined,
  ): Decision {
    return inScope(a, r, () => BPrCore(e, n, r, a, h, y, k, E));
  }
  function o2(
    e: string,
    n: string[],
    r: string,
    a: Policy | undefined,
    h?: boolean,
  ): Decision {
    return inScope(a ?? frame().policy, r, () => o2Core(e, n, r, a, h));
  }
  function ySn(
    e: string | undefined,
    n: string[],
    r: string,
    a: Policy,
  ): Decision {
    return inScope(a, r, () => ySnCore(e, n, r, a));
  }
  function UPr(
    e: string,
    n: string,
    r: Policy,
    a: boolean | undefined,
    h: boolean | undefined,
  ): Decision {
    return inScope(r, n, () => UPrCore(e, n, r, a, h));
  }
  function jPr(
    e: Command,
    n: string,
    r: Policy,
    a: boolean | undefined,
    h: boolean | undefined,
  ): Decision {
    return inScope(r, n, () => jPrCore(e, n, r, a, h));
  }
  function Wkn(
    e: OutputRedirect[],
    n: string,
    r: Policy,
    a: boolean | undefined,
  ): Decision {
    return inScope(r, n, () => WknCore(e, n, r, a));
  }
  function zPr(
    e: string[],
    n: string,
    r: Policy,
    a: boolean | undefined,
  ): Decision {
    return inScope(r, n, () => zPrCore(e, n, r, a));
  }
  function LPr(e: string[], n: string, r: Policy): Decision | undefined {
    return inScope(r, n, () => LPrCore(e, n, r));
  }
  function DPr(e: string[], n: string, r: Policy): Decision | undefined {
    return inScope(r, n, () => DPrCore(e, n, r));
  }
  function COe(
    e: string,
    n: string[],
    r: string,
    a: Policy,
    h: Operation,
    y: string[] = [],
  ): Decision | undefined {
    return inScope(a, r, () => COeCore(e, n, r, a, h, y));
  }
  function Wc(
    e: string,
    n: () => string,
  ): { relativePattern: string; root: string | null } {
    if (
      P() === "windows" &&
      (e.startsWith("~\\") ||
        (e.startsWith("\\") && e[1] !== "!" && e[1] !== "#"))
    )
      e = e.replaceAll("\\", "/");
    if (e.startsWith(`${_e}${_e}`)) {
      let a = e.slice(1);
      if (P() === "windows" && a.match(/^\/[a-z]\//i)) {
        let h = a[1]?.toUpperCase() ?? "C",
          y = a.slice(2),
          k = `${h}:\\`;
        return { relativePattern: y.startsWith("/") ? y : "/" + y, root: k };
      }
      return { relativePattern: a, root: _e };
    } else if (P() === "windows" && e.match(/^[A-Za-z]:[/\\]/)) {
      let a = required(e[0]).toUpperCase(),
        h = e.slice(2).replaceAll("\\", "/");
      return {
        relativePattern: h.startsWith("/") ? h : "/" + h,
        root: `${a}:\\`,
      };
    } else if (e.startsWith(`~${_e}`))
      return { relativePattern: e.slice(1), root: Rt().normalize("NFC") };
    else if (e.startsWith(_e)) return { relativePattern: e, root: n() };
    let r = e;
    if (e.startsWith(`.${_e}`)) r = e.slice(2);
    return { relativePattern: r, root: null };
  }

  function $t(e: string): string {
    let n = e.replace(/\/{2,}/g, "/");
    if (/^\s*(?:\/\*\*)?$/.test(n)) return n;
    return n
      .replace(/^\uFEFF([!#]?)/, (r: string, a: string) => (a ? "\\" + a : ""))
      .replace(/^\uFEFF/, "[\uFEFF]");
  }

  function u7e(
    e: string,
    n: string,
  ): { relativePattern: string; root: string | null } {
    return Wc(e, () => Twn(n));
  }

  function Pti(e: string, n: Policy, r: "read" | "edit"): Rule | null {
    let a = wt(e);
    if (ki(e) || e.startsWith("~")) return Oa(a, n, r, "deny");
    let h = e.split(/[\\/]+/).filter((E) => E !== "" && E !== ".");
    while (h[0] === "..") h.shift();
    if (h.length === 0) return null;
    let y = h.join("/"),
      k = Bct(n, r === "read" ? We : lt, "deny"),
      R = new Set();
    for (let E of k) {
      let M = E.ruleValue.ruleContent;
      if (M === void 0) continue;
      let { relativePattern: O, root: j } = u7e(M, E.source),
        N = j ?? Te(),
        H = $t(O)
          .split("/")
          .filter((V) => V !== "");
      for (let V = 0; V < Math.max(1, H.length); V++) {
        let X = [N, ...H.slice(0, V), y].join("/");
        if (R.has(X) || X.includes("\x00")) continue;
        R.add(X);
        let re = Oa(X, n, r, "deny");
        if (re !== null) return re;
      }
    }
    return null;
  }

  function SSn(e: Command): string[] {
    let n = l1(e.argv),
      [r, ...a] = n,
      h = sD(r),
      y = [];
    if (h && $Oe.includes(h)) {
      let k = h,
        E = required(aM[k])(a);
      {
        y.push(...(DF[k] === "read" ? E : lSn(k, E)));
        y.push(...cSn(k, e, a, E));
      }
    }
    return (
      y.push(...RSn(e.redirects).inputRedirections),
      y.filter((k) => !Ys(k) && !UOe(k))
    );
  }

  return {
    semantic,
    preparation,
    filesystem: host.filesystem,
    gate,
    arguments: args,
    sed,
    withPolicyScope<T>(
      policy: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { policy, scope: { policyId: policy.scope.policyId, cwd }, receipts },
        () =>
          gate.withPolicyScope(policy, cwd, () => ({
            result: run(),
            facts: receipts,
          })),
      );
    },
    native: {
      mv,
      S8,
      SSn,
      Pti,
      Wc,
      $t,
      u7e,
      _at,
      qPr,
      KPr,
      l1,
      kSn,
      sD,
      HPr,
      NPr,
      HOe,
      pSn,
      cSn,
      BOe,
      jde,
      cat,
      k8,
      ASn,
      xSn,
      gSn,
      hSn,
      ROe,
      wU,
      Gkn,
      COe,
      CSn,
      RSn,
      Wkn,
      zPr,
      LPr,
      DPr,
      BPr,
      tat,
      UPr,
      jPr,
      ySn,
      nb,
      Fkn,
      OOe,
      rSn,
      NOe,
      rat,
      o2,
      mD,
    },
    contexts: { removal: MOe },
  };
}
