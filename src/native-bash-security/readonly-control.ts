import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeBashSyntaxNode as Node } from "../native-bash-parser.js";
import type {
  NativeBashSemanticCommand as Command,
  NativeBashSemanticResult as SemanticResult,
} from "../native-bash-semantics.js";
import type {
  NativeBashSecurityInput as Input,
  NativeBashSecurityPolicy as Policy,
  NativeBashSecurityContext as Context,
} from "../native-bash-security.js";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact as Fact,
  type NativePermissionScope as Scope,
  type NativePermissionProvenance as Provenance,
} from "../native-permission-outcome.js";
import type { createNativeBashReadonlyProfiles } from "./readonly-profiles.js";
export type NativeBashReadonlyVerdict =
  | { behavior: "allow"; updatedInput: Input }
  | {
      behavior: "ask" | "passthrough";
      message: string;
      notReadOnlyCommand?: string;
    };
export type NativeBashReadonlyCheckoutProbe =
  "unexaminable" | "none" | { checkout: string };
export type NativeBashReadonlyBareRepo =
  | false
  | "bare-indicators"
  | "gitdir-redirect-plantable"
  | "gitdir-file-oversized";
export interface NativeBashReadonlyHost {
  disklessLaunch?: (scope: Scope) => Fact<boolean>;
  currentCwd?: (scope: Scope) => Fact<string>;
  originalCwd?: (scope: Scope) => Fact<string>;
  projectRoot?: (scope: Scope) => Fact<string>;
  lastCheckedSessionEnvVarKeys?: (
    scope: Scope,
  ) => Fact<ReadonlySet<string> | undefined>;
  safeFeature?: (key: string, safe: true, scope: Scope) => Fact<boolean>;
  bareRepositoryInspection?: (scope: Scope) => Fact<NativeBashReadonlyBareRepo>;
  cloudRemoteSurface?: (scope: Scope) => Fact<boolean>;
  checkoutProbe?: (
    cwd: string,
    mayBeGone: true,
    scope: Scope,
  ) => Fact<NativeBashReadonlyCheckoutProbe>;
  checkoutTrusted?: (checkout: string, scope: Scope) => Fact<boolean>;
  checkoutSessionTrusted?: (checkout: string, scope: Scope) => Fact<boolean>;
  startupAdditionalDirectoriesSupported?: (scope: Scope) => Fact<boolean>;
}
function need<T>(value: T | undefined, dependency: string): T {
  if (value === undefined)
    throw new NativePermissionDependencyError(
      dependency,
      "Required native readonly fact is unavailable",
    );
  return value;
}
export function createNativeBashReadonlyControl(
  profiles: ReturnType<typeof createNativeBashReadonlyProfiles>,
  host: NativeBashReadonlyHost,
) {
  const { process } = profiles;
  const { semantic, preparation, policy, observations } = process;
  const frames = new AsyncLocalStorage<{
    permission: Policy;
    scope: Scope;
    provenance: Provenance[];
  }>();
  const frame = () => need(frames.getStore(), "readonly.scope");
  const use = <T>(fact: Fact<T>) =>
    readNativePermissionFact(fact, frame().scope, frame().provenance);
  const current = <T>(fn: () => T) =>
    withPolicyScope(
      frame().permission,
      frame().scope.cwd,
      fn,
      frame().provenance,
    ).result;
  const K = () =>
    use(need(host.disklessLaunch, "launch.diskless")(frame().scope));
  // GE's source selected-tool set contains Bash; its K() is Tt()/diskless().
  const GE = (_tool: "Bash") => K();
  const ue = () => {
    const value = use(need(host.currentCwd, "cwd.current")(frame().scope));
    frame().scope = { ...frame().scope, cwd: value };
    return value;
  };
  const Te = () => use(need(host.originalCwd, "cwd.original")(frame().scope));
  const Co = () =>
    use(need(host.projectRoot, "project.projectRoot")(frame().scope));
  const H_n = () =>
    use(
      need(
        host.lastCheckedSessionEnvVarKeys,
        "environment.lastCheckedSessionEnvVarKeys",
      )(frame().scope),
    );
  const b0e = (context: Pick<Context, "sessionEnvVars">) =>
    new Set(context.sessionEnvVars?.keys());
  const je = (
    key: Parameters<NonNullable<NativeBashReadonlyHost["safeFeature"]>>[0],
    _options: { safe: true },
  ) =>
    use(need(host.safeFeature, "features.readonly")(key, true, frame().scope));
  const Rxr = "bot_protected_tengu_frolicking_pelican";
  const YZe = () =>
    use(need(host.bareRepositoryInspection, "git.YZe")(frame().scope));
  const F0 = () =>
    use(need(host.cloudRemoteSurface, "surface.F0")(frame().scope));
  const qrt = (cwd: string, _options: { mayBeGone: true }) =>
    use(need(host.checkoutProbe, "git.qrt")(cwd, true, frame().scope));
  const Ixr = (checkout: string) =>
    use(need(host.checkoutTrusted, "git.Ixr")(checkout, frame().scope));
  const sQo = (checkout: string) =>
    use(need(host.checkoutSessionTrusted, "git.sQo")(checkout, frame().scope));
  const bkn = () =>
    use(
      need(
        host.startupAdditionalDirectoriesSupported,
        "startup.bkn",
      )(frame().scope),
    );
  const hn = (text: string) => text.normalize("NFC");
  const O5e = (text: string) => current(() => process.syntax.native.O5e(text));
  const Oat = <T>(run: () => T) => policy.contexts.timeout.run(true, run);
  const P = policy.pathOwner.gate.bindings.P;
  const tP = policy.pathOwner.gate.bindings.tP;
  const { Ys } = semantic.native;
  const { sC } = { sC: preparation.projection.maxCommandCharacters };
  const V_ = () => semantic.parser;
  const SG = semantic.analyzeTree;
  const KSn = observations.contexts.divergentRead;
  const qde = (keys: ReadonlySet<string> | undefined) =>
    current(() => policy.native.qde(keys));
  const T8 = policy.native.T8;
  const VOe = (...args: Parameters<typeof process.alternates.native.VOe>) =>
    current(() => process.alternates.native.VOe(...args));
  const { Aat } = profiles.native;
  const O3a = () => semantic.parser.features.hasMayDifferObservation();
  const { CMr, TMr, vMr, BSn, USn, iwn } = profiles.constants;
  const Kde = (text: string) => current(() => process.main.native.Kde(text));
  const sb = (text: string) => current(() => process.syntax.native.sb(text));
  const zde = (text: string) => current(() => process.git.native.zde(text));
  const Ge = {
    isSandboxingEnabled: () =>
      current(process.complexity.native.Ge.isSandboxingEnabled),
  };
  const Vh = (input: Input) => current(() => policy.native.Vh(input));
  const bU = preparation.environmentValueSafe;
  const jxt = (text: string) =>
    current(() => process.complexity.native.jxt(text));
  const Jat = (args: string[]) => current(() => policy.native.Jat(args));
  const Hat = (command: Command) => current(() => policy.native.Hat(command));
  const awn = (name: string) => current(() => policy.native.awn(name));
  const Lat = (name: string) => current(() => policy.native.Lat(name));
  const fMr = (args: string[]) => current(() => profiles.native.fMr(args));
  const WSn = () => current(policy.native.WSn);
  const _Mr = (text: string) => current(() => profiles.native._Mr(text));
  const yMr = observations.native.yMr;
  const iC = preparation.projection.staticArgv;
  const DY = () => preparation.features.refuseEnvironment();
  const Rkn = observations.native.Rkn;
  function hwn(e: Node): boolean {
    if (e.type === "subshell" || e.type === "compound_statement") return !0;
    for (let n of e.children) if (n && hwn(n)) return !0;
    return !1;
  }

  function ywn(e: Node): boolean {
    if (!vMr.has(e.type)) return !1;
    for (let n of e.children) {
      if (!n) continue;
      if (n.type === "&") return !0;
      if (ywn(n)) return !0;
    }
    return !1;
  }

  function CIo(): string | undefined {
    if (K() || ue() === Co() || F0() || !je(Rxr, { safe: !0 })) return;
    let e = qrt(ue(), { mayBeGone: !0 });
    if (e === "unexaminable")
      return "Claude Code cannot tell which repository git would use here, and a repository's settings can make git run programs.";
    if (e === "none" || Ixr(e.checkout)) return;
    let n = hn(e.checkout).replace(
        /[^\p{Lu}\p{Ll}\p{Lo}\w ./\\:@+~#,()=&'\u30FC-]| {2,}|'{2,}/gu,
        "?",
      ),
      r = sQo(e.checkout)
        ? ""
        : "start Claude Code there once and accept the trust dialog, or ";
    return `Git would use a repository that Claude Code cannot match to this project or to one you trusted. Its settings can make git run programs. ${bkn() ? `If you trust it, ${r}name it with --add-dir at the start, which also loads its skills and commands.` : "An allow rule for git would apply in every repository."} Its folder: "${n}"`;
  }

  function XWt(
    e: Input,
    n: boolean,
    r?: {
      offlineEstimate?: boolean;
      sessionEnvVarKeys?: ReadonlySet<string> | undefined;
    },
  ): NativeBashReadonlyVerdict {
    let { command: a } = e,
      h = r?.offlineEstimate === !0;
    if (a.length > sC)
      return {
        behavior: "passthrough",
        message: "Command too long for read-only analysis",
      };
    let y = V_().parse(a),
      k: SemanticResult = y
        ? SG(a, y, { readsDivergentShapes: KSn.getStore() === !0 })
        : { kind: "simple", commands: [], bareAssignmentNames: [] };
    if (k.kind === "too-complex")
      return {
        behavior: "passthrough",
        message: `Not a simple read-only command: ${k.reason}`,
      };
    if (y && hwn(y))
      return {
        behavior: "passthrough",
        message: "Not a simple read-only command: contains a subshell",
      };
    if (y && ywn(y))
      return {
        behavior: "passthrough",
        message:
          "Not a simple read-only command: `&` defers execution past approval-time checks",
      };
    let E = h ? () => new Set<string>() : qde(r?.sessionEnvVarKeys);
    if (T8(k.bareAssignmentNames, E))
      return {
        behavior: "passthrough",
        message:
          "Bare assignment to a non-allowlisted environment variable can alter behavior of subsequent commands",
      };
    if (!h && VOe(k.bareAssignmentNames, e))
      return {
        behavior: "passthrough",
        message: "This command sets a variable that can make git run a program",
      };
    let N = Aat(a);
    if (N === "variable")
      return {
        behavior: "passthrough",
        message: "Command contains unquoted variable expansion",
      };
    if (
      (k.usesAssignedValue === !0 || k.laterLoopPassesDiffer === !0) &&
      !O3a() &&
      je(CMr, { safe: !0 })
    )
      return {
        behavior: "passthrough",
        message:
          "A variable or loop in this command can't be checked before it runs",
      };
    if (tP(a))
      return {
        behavior: "ask",
        message:
          "Command contains Windows UNC path that could be vulnerable to WebDAV attacks",
      };
    let V = k.commands.some((xe) => Kde(xe.text));
    if ((n || k.commands.some((xe) => sb(xe.text))) && V)
      return {
        behavior: "passthrough",
        message:
          "Compound commands with cd and git require permission checks for enhanced security",
      };
    let re = V && !h && YZe();
    if (re)
      return {
        behavior: "passthrough",
        message:
          re === "bare-indicators"
            ? "The current directory has bare-repo indicators (HEAD/objects/refs outside a .git/ directory). Git may treat it as a git dir and run config/hooks from here, so git commands need approval."
            : "The .git file or symlink here redirects to a location Claude cannot verify is safe (it may have been planted by an untrusted archive). Git commands need approval.",
      };
    if (V && zde(a))
      return {
        behavior: "passthrough",
        message:
          "Compound commands that create git internal files and run git require permission checks for enhanced security",
      };
    if (V && !h && Ge.isSandboxingEnabled() && ue() !== Te())
      return {
        behavior: "passthrough",
        message:
          "Git commands outside the original working directory require permission checks when sandbox is enabled",
      };
    let _e: Command | undefined,
      ke =
        k.commands.length > 0 &&
        k.commands.every((xe) => {
          if (
            ((_e = xe),
            xe.redirects.some(
              (ot) =>
                !TMr.has(ot.op) &&
                ot.target !== "/dev/null" &&
                !(ot.op === ">&" && /^\d+$/.test(ot.target)),
            ))
          )
            return !1;
          if (xe.redirects.some((ot) => /^\/dev\/(tcp|udp)\//.test(ot.target)))
            return !1;
          if (xe.redirects.some((ot) => ot.op === "<" && tP(ot.target, !0)))
            return !1;
          if (
            P() === "windows" &&
            xe.redirects.some(
              (ot) =>
                ot.op === "<" &&
                /(?<![:\w])[\\/]{2,}[^ \t\r\n\f\v\\/]/.test(ot.target),
            )
          )
            return !1;
          if (xe.envVars.some((ot) => !bU(ot.name, ot.value))) return !1;
          if (
            xe.argv.some((ot) => tP(ot, !0)) ||
            xe.envVars.some(
              (ot) => ot.isAppend || tP(ot.value.replace(/^:/, ""), !0),
            )
          )
            return !1;
          if (
            xe.argv.slice(1).some(jxt) ||
            xe.redirects.some((ot) => ot.op === "<" && jxt(ot.target))
          )
            return !1;
          if (
            P() === "windows" &&
            xe.argv.some((ot) =>
              /(?<![:\w])[\\/]{2,}[^ \t\r\n\f\v\\/]/.test(ot),
            )
          )
            return !1;
          let Pe = Jat(xe.argv);
          if (Hat(xe)) return !1;
          if (
            Aat(xe.text) === "glob" ||
            (N === "glob" && xe.argv.some((ot) => /[*?]|\[.*\]/.test(ot)))
          )
            return awn(Pe[0] ?? "");
          let Be = iwn.get(Pe[0] ?? "");
          if (
            Be !== void 0 &&
            Pe.slice(1).some((ot) => Be(ot) || Ys(ot)) &&
            Lat(Pe[0] ?? "")
          )
            return !1;
          let Fe = fMr(Pe);
          if (Fe !== null) return Fe;
          if (Pe.length !== xe.argv.length && !/^[\w./-]+$/.test(Pe[0] ?? ""))
            return !1;
          let Ke = xe.text;
          while (BSn.test(Ke)) Ke = Ke.replace(BSn, "");
          while (USn.test(Ke) && WSn()) Ke = Ke.replace(USn, "");
          if (Ke !== xe.text && iC(Ke)[0] !== Pe[0]) return !1;
          return (
            (_Mr(Ke) || (Pe[0] === "which" && yMr())) &&
            (iC(xe.text).length === xe.argv.length || !DY())
          );
        }),
      Re = ke && V && !h ? CIo() : void 0;
    if (Re !== void 0 && !Rkn(Re))
      return { behavior: "passthrough", message: Re };
    if (ke) return { behavior: "allow", updatedInput: e };
    return {
      behavior: "passthrough",
      message: "Command is not read-only, requires further permission checks",
      ...(_e !== void 0 && { notReadOnlyCommand: _e.text }),
    };
  }

  function _Wo(
    e: Pick<Context, "sessionEnvVars"> | undefined,
  ): ReadonlySet<string> | undefined {
    return e === void 0 ? H_n() : b0e(e);
  }

  function PWo(
    e: Input,
    n: ReadonlySet<string> | undefined,
  ): NativeBashReadonlyVerdict {
    let r = () => XWt(e, O5e(e.command), { sessionEnvVarKeys: n });
    return Ge.isSandboxingEnabled() && !Vh(e) ? Oat(r) : r();
  }

  function ABt(e: Input, n: ReadonlySet<string> | undefined): boolean {
    return PWo(e, n).behavior === "allow";
  }

  function jxi(e: string): boolean {
    return (
      XWt({ command: e }, O5e(e), { offlineEstimate: !0 }).behavior === "allow"
    );
  }

  function isReadOnly(
    input: Input,
    context?: Pick<Context, "sessionEnvVars">,
  ): boolean {
    return !GE("Bash") && ABt(input, _Wo(context));
  }
  function notReadOnlyReason(
    input: Input,
    context?: Pick<Context, "sessionEnvVars">,
  ):
    | { message: string; everyInput?: true; part?: string | undefined }
    | undefined {
    if (GE("Bash"))
      return {
        message:
          "This session runs shell commands only in its cloud environment, so none can be verified as read-only here",
        everyInput: true,
      };
    const result = PWo(input, _Wo(context));
    if (result.behavior === "allow") return undefined;
    return "notReadOnlyCommand" in result
      ? { message: result.message, part: result.notReadOnlyCommand }
      : { message: result.message };
  }
  function withPolicyScope<T>(
    permission: Policy,
    cwd: string,
    run: () => T,
    provenance: Provenance[] = [],
  ) {
    return frames.run(
      {
        permission,
        scope: { policyId: permission.scope.policyId, cwd },
        provenance,
      },
      () => profiles.withPolicyScope(permission, cwd, run, provenance),
    );
  }
  return {
    process,
    profiles,
    host,
    native: { hwn, ywn, CIo, XWt, _Wo, PWo, ABt, jxi },
    isReadOnly,
    notReadOnlyReason,
    withPolicyScope,
  };
}
