import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";
import type {
  NativeBashSemanticCommand as Command,
  NativeBashSemanticResult as SemanticResult,
} from "../native-bash-semantics.js";
import type { createNativeBashStateControl } from "./state-control.js";
import type { createNativeBashCwdReadControl } from "./cwd-read-control.js";
import type { createNativeBashSecurityPipelineControl } from "./pipeline-control.js";
import type {
  NativeBashSecurityContext as Context,
  NativeBashSecurityRecursion as Recursion,
  NativeBashSecurityInlineContext as InlineContext,
  NativeBashSecurityPrefixReader as PrefixReader,
  NativeBashSecurityDeclarationObserver as DeclarationObserver,
  NativeBashSecurityRecursiveCheck as RecursiveCheck,
  NativeBashSecurityPrefix as Prefix,
} from "./security-recursion-types.js";
import { equalNativeBashOutcomes as Tn } from "./outcome-equality.js";
import { classifyNativeBashTextRule as Ekt } from "./rule-text-search.js";
import {
  NativeBashSecurityUnsupported,
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityReason as Reason,
  type NativeBashSecurityInput as Input,
  type NativeBashSecuritySuggestion as Suggestion,
} from "./security-types.js";
export interface NativeBashMainControlHost {
  currentCwd?: (scope: Scope) => Fact<string>;
  livePolicy?: (context: Context, scope: Scope) => Fact<Policy>;
  replaceLastCheckedSessionEnvVarKeys?: (
    keys: ReadonlySet<string>,
    scope: Scope,
  ) => Fact<void>;
  amberLarch?: (scope: Scope) => Fact<boolean>;
  telemetry?: (
    event: "tengu_bash_ast_too_complex" | "tengu_bash_dangerous_rm_too_complex",
    metadata: { nodeTypeId?: number; kind?: string },
    scope: Scope,
  ) => Fact<void>;
  reportError?: (error: unknown, scope: Scope) => Fact<void>;
  isAbortError?: (error: unknown, scope: Scope) => Fact<boolean>;
}
export class NativeBashSecurityAbortError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AbortError";
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native main-control invariant");
  return value;
}
export function createNativeBashMainControl(
  state: ReturnType<typeof createNativeBashStateControl>,
  cwd: ReturnType<typeof createNativeBashCwdReadControl>,
  pipeline: ReturnType<typeof createNativeBashSecurityPipelineControl>,
  host: NativeBashMainControlHost,
  qdeCheck: RecursiveCheck,
) {
  const { complexity } = state;
  const { nested } = complexity;
  const { recursion, literal } = nested;
  const { syntax, shapes } = recursion;
  const { policy, semantic, preparation } = syntax;
  const path = policy.pathOwner;
  if (cwd.syntax !== syntax || pipeline.git.pathOwner !== path)
    throw new Error("Native Bash process owners must be shared");
  const frames = new AsyncLocalStorage<{
    policy: Policy;
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(fact: Fact<T>) =>
    readNativeBashSecurityFact(fact, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const ue = () => {
    const value = use(need(host.currentCwd, "cwd.current")(frame().scope));
    frame().scope = { ...frame().scope, cwd: value };
    return value;
  };
  const ee = (context: Context) => {
    const value = use(
      need(host.livePolicy, "policy.live")(context, frame().scope),
    );
    frame().policy = value;
    frame().scope = { ...frame().scope, policyId: value.scope.policyId };
    return value;
  };
  const scoped = <T>(
    permission: Policy,
    evaluationCwd: string,
    run: () => T,
  ): T =>
    withPolicyScope(permission, evaluationCwd, run, frame().receipts).result;
  const current = <T>(run: () => T) =>
    scoped(frame().policy, frame().scope.cwd, run);
  const XMa = semantic.resetSplicedBudget;
  const V1 = semantic.parse;
  const SG = (
    text: string,
    tree: Parameters<typeof semantic.analyzeTree>[1],
    options: {
      declarationPrefix?: boolean[] | undefined;
      readsDivergentShapes?: boolean;
      plainUnquotedHeredocs?: boolean;
    } = {},
  ) => {
    const { declarationPrefix, ...rest } = options;
    return semantic.analyzeTree(text, tree, {
      ...rest,
      ...(declarationPrefix !== undefined ? { declarationPrefix } : {}),
    });
  };
  const v6e = semantic.commandSafety;
  const { MVo, Uti, Ys } = semantic.native;
  const Qde = qdeCheck;
  const { N6 } = shapes.observations.native;
  const { Sa, nS, eIe, Ywn, VS, A8, YOe, Az, bF } = shapes.outcomes;
  const edt = (context: Context) => current(() => state.native.edt(context));
  const Zde = (decision: Decision, context: Context) =>
    current(() => state.native.Zde(decision, context));
  const R0 = policy.native.R0;
  const KOe = () => current(policy.native.KOe);
  const Vh = (input: Input) => current(() => policy.native.Vh(input));
  const lM = (permission: Policy) =>
    scoped(permission, frame().scope.cwd, () => policy.native.lM(permission));
  const Ge = {
    isSandboxingEnabled: () =>
      current(complexity.native.Ge.isSandboxingEnabled),
    isAutoAllowBashIfSandboxedEnabled: () =>
      current(complexity.native.Ge.isAutoAllowBashIfSandboxedEnabled),
    isAutoAllowSupported: () =>
      current(complexity.native.Ge.isAutoAllowSupported),
  };
  const El = policy.native.El;
  const { ZOe } = shapes.native;
  const b = (_key: "tengu_amber_larch", _default: true) =>
    use(need(host.amberLarch, "features.amberLarch")(frame().scope));
  const IDt = (permission: Policy) =>
    scoped(permission, frame().scope.cwd, () =>
      complexity.native.IDt(permission),
    );
  const bQ = policy.native.bQ;
  const AOr = (...args: Parameters<typeof complexity.native.AOr>) =>
    scoped(args[1], frame().scope.cwd, () => complexity.native.AOr(...args));
  const _Or = (...args: Parameters<typeof complexity.native._Or>) =>
    scoped(args[1], frame().scope.cwd, () => complexity.native._Or(...args));
  const elt = (...args: Parameters<typeof complexity.native.elt>) =>
    scoped(args[1], frame().scope.cwd, () => complexity.native.elt(...args));
  const Yde = (...args: Parameters<typeof complexity.native.Yde>) =>
    current(() => complexity.native.Yde(...args));
  const Qv = (
    event: "tengu_bash_ast_too_complex" | "tengu_bash_dangerous_rm_too_complex",
    metadata: { nodeTypeId?: number; kind?: string },
  ) =>
    shapes.observations.native.Qv(() => {
      use(
        need(host.telemetry, "telemetry.main")(event, metadata, frame().scope),
      );
    });
  const f = <T extends string>(value: T) => value;
  const { jde, cat, l1 } = path.native;
  const EOr = (
    commands: Command[],
    evaluationCwd: string,
    permission: Policy,
    context: Context,
  ) =>
    scoped(permission, evaluationCwd, () =>
      cwd.native.EOr(commands, evaluationCwd, permission, context),
    );
  const vOr = (
    commands: Command[],
    evaluationCwd: string,
    permission: Policy,
    context: Context,
  ) =>
    scoped(permission, evaluationCwd, () =>
      cwd.native.vOr(commands, evaluationCwd, permission, context),
    );
  const Q_n = () => current(cwd.native.Q_n);
  const { fOr } = cwd.native;
  const jOr = (input: Input, permission: Policy, commands: Command[]) =>
    scoped(permission, frame().scope.cwd, () =>
      policy.native.jOr(input, permission, commands),
    );
  const qlt = (...args: Parameters<typeof nested.native.qlt>) =>
    current(() => nested.native.qlt(...args));
  const { LOe } = literal.native;
  const JOe = (...args: Parameters<typeof recursion.native.JOe>) =>
    current(() => recursion.native.JOe(...args));
  const Aun = (input: Input, permission: Policy) =>
    scoped(permission, frame().scope.cwd, () =>
      policy.native.Aun(input, permission),
    );
  const Swn = (...args: Parameters<typeof pipeline.native.Swn>) =>
    current(() => pipeline.native.Swn(...args));
  const sb = (text: string) => current(() => syntax.native.sb(text));
  function Kde(text: string): boolean {
    if (text.startsWith("git ") || text === "git") return true;
    if (
      current(() =>
        syntax.native.jbn(
          text,
          l1,
          (argv) =>
            argv[0] === "git" || (argv[0] === "xargs" && argv.includes("git")),
        ),
      )
    )
      return true;
    return false;
  }
  const TOr = (commands: string[], evaluationCwd: string) =>
    current(() => cwd.native.TOr(commands, evaluationCwd));
  const O5e = (text: string) => current(() => syntax.native.O5e(text));
  const Pbn = (...args: Parameters<typeof nested.native.Pbn>) =>
    scoped(args[2], args[1], () => nested.native.Pbn(...args));
  const mD = (...args: Parameters<typeof path.native.mD>) =>
    scoped(args[2], args[1], () => path.native.mD(...args));
  const i = (error: unknown) => {
    use(need(host.reportError, "errors.report")(error, frame().scope));
  };
  const $e = (error: unknown) =>
    use(
      need(host.isAbortError, "errors.abortClassification")(
        error,
        frame().scope,
      ),
    );
  const P = path.gate.bindings.P;
  const { zB, Do } = cwd.descendant.native;
  const wOr = (...args: Parameters<typeof policy.native.wOr>) =>
    current(() => policy.native.wOr(...args));
  const Elt = (
    commands: Command[],
    evaluationCwd: string,
    permission: Policy,
  ) =>
    scoped(permission, evaluationCwd, () =>
      policy.native.Elt(commands, evaluationCwd, permission),
    );
  const paths = P() === "windows" ? win32 : posix;
  const l2 = (value: string) => paths.normalize(value);
  const mv = (permission: Policy) =>
    scoped(permission, frame().scope.cwd, () => path.native.mv(permission));
  const ko = path.gate.bindings.ko;
  const se = () => path.filesystem;
  const kwn = (command: Command | undefined) =>
    current(() => policy.native.kwn(command));
  const _x = (value: string) => paths.isAbsolute(value);
  const HF = (...parts: string[]) => paths.resolve(...parts);
  const o2 = (...args: Parameters<typeof path.native.o2>) =>
    scoped(args[3] ?? frame().policy, args[2], () => path.native.o2(...args));
  const Wlt = (
    command: Command | undefined,
    evaluationCwd: string,
    permission: Policy,
  ) =>
    scoped(permission, evaluationCwd, () =>
      policy.native.Wlt(command, evaluationCwd, permission),
    );
  const bOr = (
    commands: (Command | undefined)[],
    texts: string[],
    evaluationCwd: string,
  ) => current(() => cwd.native.bOr(commands, texts, evaluationCwd));
  const qOe = (commands: (Command | undefined)[], evaluationCwd: string) =>
    pipeline.git.withPolicyScope(
      frame().policy,
      evaluationCwd,
      () => pipeline.git.native.qOe(commands, evaluationCwd),
      frame().receipts,
    ).result;
  const zde = (text: string) => current(() => pipeline.git.native.zde(text));
  const PIo = (...args: Parameters<typeof policy.native.PIo>) =>
    scoped(args[1], args[4] ?? frame().scope.cwd, () =>
      policy.native.PIo(...args),
    );
  const { a2 } = pipeline.native;
  const Xrt = (text: string) => current(() => policy.native.Xrt(text));
  const Qrt = (input: Input, permission: Policy, seen: Set<string>) =>
    scoped(permission, frame().scope.cwd, () =>
      policy.native.Qrt(input, permission, seen),
    );
  const Mcr = policy.native.Mcr;
  const dpe = (
    permission: Policy,
    tool: { name: string },
    behavior: "allow" | "ask" | "deny",
  ) =>
    scoped(permission, frame().scope.cwd, () =>
      policy.native.dpe(permission, tool, behavior),
    );
  const oE = preparation.stripSimpleWrappers;
  const ier = (mode: string, permission: Policy): Policy => ({
    ...permission,
    mode,
    modeBeforeRewrite: permission.modeBeforeRewrite ?? permission.mode,
  });
  const g6e = path.gate.bindings.g6e;
  const RIo = () => current(cwd.native.RIo);
  const DY = () => preparation.features.refuseEnvironment();
  const qwn = (...args: Parameters<typeof policy.native.qwn>) =>
    scoped(args[1], args[5], () => policy.native.qwn(...args));
  const Tzn = (command: string) => current(() => policy.native.Tzn(command));
  const fn = policy.native.fn;
  const Jfe = (suggestions: Suggestion[] | undefined) =>
    suggestions
      ? suggestions.flatMap((suggestion) =>
          suggestion.type === "addRules" ? suggestion.rules : [],
        )
      : [];
  const $_n = (keys: ReadonlySet<string>) => {
    use(
      need(
        host.replaceLastCheckedSessionEnvVarKeys,
        "environment.replaceLastCheckedSessionEnvVarKeys",
      )(keys, frame().scope),
    );
  };
  const b0e = (context: Context) => new Set(context.sessionEnvVars?.keys());
  const Ks = { name: "Bash" };
  const Mbn = 32,
    Obn = 20000,
    zMr = 5,
    HMr = paths.sep;
  const D = <T>(values: T[]) => [...new Set(values)];
  const U = <T>(values: T[], predicate: (value: T) => unknown) =>
    values.reduce((n, value) => n + +!!predicate(value), 0);
  const Ne = NativeBashSecurityAbortError;
  const mQt = (reason: Reason | undefined) =>
    reason?.type === "subcommandResults"
      ? (reason.typeOnWire ?? reason.type)
      : reason?.type;
  const Vde = () => current(pipeline.native.Vde);
  const aIr =
    "git after a directory change, or after writes to files git reads (HEAD, config, hooks), cannot be checked against the read block";
  function plt(
    e: string[],
    n: (Command | undefined)[],
    r: Decision[],
  ): Map<string, Decision> {
    let a = new Map<string, number>();
    for (let h of e) a.set(h, (a.get(h) ?? 0) + 1);
    return YOe(
      r.map((h, y) => {
        let k = required(e[y]);
        return [
          (a.get(k) ?? 0) > 1
            ? [
                k,
                ...(n[y]?.redirects ?? []).map(
                  (N) =>
                    `${N.fd ?? ""}${N.op}${N.op === ">&" || N.op === "<&" ? "" : " "}${N.target}`,
                ),
              ].join(" ")
            : k,
          h,
        ];
      }),
    );
  }
  async function nIe(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: string,
    h?: Recursion,
    y?: boolean[],
    k?: DeclarationObserver,
    E?: "read" | "refused",
    N?: () => void,
    V?: (commands: Command[]) => void,
  ): Promise<Decision> {
    XMa();
    let oe = ee(n),
      re: InlineContext = {
        input: e,
        context: n,
        depth: h?.depth ?? 0,
        divergentShapes: E,
        declarationPrefix: y,
        budget: h?.budget ?? {
          left: Mbn,
          chars: Obn,
          judged: new Map(),
          asked: new Map(),
          command: a ?? e.command,
          rereading: !1,
        },
      };
    $_n(b0e(n));
    let _e = await V1(e.command),
      ke: SemanticResult = _e
        ? SG(e.command, _e, {
            declarationPrefix: y,
            readsDivergentShapes: E === "read",
          })
        : { kind: "simple", commands: [], bareAssignmentNames: [] };
    if (ke.kind === "simple") V?.(ke.commands);
    if (ke.kind === "simple" && ke.laterLoopPassesDiffer) N?.();
    let Re =
      ke.kind === "simple"
        ? v6e(ke.commands, {
            sourceGlobRecord: KOe(),
            ...(ke.hasLoop !== undefined ? { hasLoop: ke.hasLoop } : {}),
          })
        : null;
    if (
      E === void 0 &&
      (ke.kind === "too-complex" ? ke.divergentShape === !0 : Re?.ok === !1)
    ) {
      let Ko = await Qde(e, n, r, a, h, y, k, "read"),
        go = await N6(() => Qde(e, n, r, a, h, y, void 0, "refused")),
        jo = (nS(Ko) === 4 && edt(n) ? 3 : nS(Ko)) - nS(go),
        Er = ke.kind === "too-complex" && ke.keepsRemovalVerdict === !0;
      if (
        Er &&
        Ko.behavior === "ask" &&
        go.behavior === "ask" &&
        R0(go.decisionReason)
      ) {
        let as = Sa(
          Ko.decisionReason,
          (cr) => cr.circuitBreaker === "dangerousRemoval",
        );
        if (as !== void 0)
          return {
            ...Ko,
            message: `${Ko.message} ${go.message}`,
            decisionReason: {
              type: "subcommandResults",
              typeOnWire: "safetyCheck",
              reasons: new Map([
                [
                  `${e.command} (as refused)`,
                  {
                    ...go,
                    decisionReason: {
                      ...go.decisionReason,
                      reason: `${as.reason}; ${go.decisionReason.reason}`,
                    },
                  },
                ],
                [e.command, Ko],
              ]),
            },
            suggestions: [],
          };
      }
      let Rr = jo > 0 || (jo === 0 && eIe(Ko) > eIe(go)) ? Ko : go,
        ss = { ...Rr, matchedAskRule: void 0 };
      return Er && h !== void 0 && Zde(ss, n) ? ss : Rr;
    }
    let xe =
        n.forRemoteExecution !== !0 &&
        ke.kind === "too-complex" &&
        ((ke.nodeType === "heredoc_redirect" && ke.differential === !0) ||
          (ke.nodeType === "pipeline" && ke.afterHeredocDelimiter === !0)),
      Pe =
        xe &&
        Ge.isSandboxingEnabled() &&
        Ge.isAutoAllowBashIfSandboxedEnabled() &&
        Vh(e) &&
        b("tengu_amber_larch", !0);
    if (
      _e &&
      V !== void 0 &&
      xe &&
      (!Pe || IDt(oe)) &&
      Ge.isSandboxingEnabled() &&
      Ge.isAutoAllowSupported() &&
      Vh(e) &&
      b("tengu_amber_larch", !0)
    ) {
      let Ko = SG(e.command, _e, {
        plainUnquotedHeredocs: !0,
        declarationPrefix: y,
      });
      if (Ko.kind === "simple") V(Ko.commands);
    }
    if (k !== void 0) {
      let Ko =
          ke.declarationPrefixes === void 0 && _e && Pe
            ? SG(e.command, _e, { plainUnquotedHeredocs: !0 })
            : void 0,
        go = ke.declarationPrefixes === void 0 ? Ko : ke;
      if (go?.declarationPrefixes !== void 0)
        k(
          go.declarationPrefixes,
          go.declarationPrefixBashKeeps,
          ke.uncertainWrite === !0,
        );
    }
    if (ke.kind === "too-complex") {
      let Ko = await AOr(
        e,
        oe,
        _e,
        ke.nodeType,
        () =>
          oe.blockReadsOutsideWorkingDirectories === !0 && !(Vh(e) && lM(oe))
            ? bQ(ke.reason)
            : void 0,
        a,
        n.forRemoteExecution === !0,
        re,
        n,
      );
      if (Ko !== null) return Ko;
      let go = n.forRemoteExecution === !0 ? null : _Or(e, oe, ke.nodeType);
      if (go !== null) return go;
      if (_e && Pe) {
        let Er = SG(e.command, _e, {
          plainUnquotedHeredocs: !0,
          declarationPrefix: y,
        });
        if (Er.kind === "simple" && Er.laterLoopPassesDiffer) N?.();
        let Rr =
          Er.kind === "simple" &&
          v6e(Er.commands, {
            sourceGlobRecord: KOe(),
            ...(Er.hasLoop !== undefined ? { hasLoop: Er.hasLoop } : {}),
          }).ok
            ? elt(e, oe, Er.commands, Er.bareAssignmentNames, n)
            : null;
        if (Rr !== null) return Rr;
      }
      Qv("tengu_bash_ast_too_complex", { nodeTypeId: MVo(ke.nodeType) });
      let Oo = Yde(_e, a, re);
      if (Oo !== void 0) return Oo;
      let jo: Reason = {
        type: "other",
        reason: ke.reason,
        bashMissKind: "too-complex",
        ...(oe.mode === "auto" &&
          _e !== semantic.parseAbort && { acceptEditsCannotAllow: !0 }),
      };
      return {
        behavior: "ask",
        decisionReason: jo,
        message: El(Ks.name, jo),
        suggestions: [],
      };
    }
    let Be = ke.commands,
      Fe = (Ko: Policy) =>
        jde(Ko) &&
        ((cat(Ko) && !EOr(Be, ue(), Ko, n)) ||
          (n.forRemoteExecution !== !0 &&
            ke.bareAssignmentNames.length === 0 &&
            ke.hasLoop === !1 &&
            Q_n() &&
            vOr(Be, ue(), Ko, n)));
    if (
      oe.blockReadsOutsideWorkingDirectories === !0 &&
      Be.some(
        (Ko, go) =>
          fOr(Ko.argv) &&
          (/<<</.test(e.command) ||
            /<<(?!<)/.test(e.command) ||
            (go > 0 && e.command.includes("|"))),
      ) &&
      !(Vh(e) && lM(oe))
    )
      return bQ("code on stdin cannot be checked against the read block");
    if (Re !== null && !Re.ok && E !== "read") {
      let Ko = jOr(e, oe, Be);
      if (Ko?.behavior === "deny") return Ko;
      if (Re.kind === "newline-hash" && n.forRemoteExecution !== !0) {
        let Er = elt(e, oe, Be, ke.bareAssignmentNames, n);
        if (Er) return Er;
      }
      if (oe.blockReadsOutsideWorkingDirectories === !0 && !(Vh(e) && lM(oe)))
        return bQ(Re.reason);
      let go = qlt(e.command, !0, a, n.forRemoteExecution === !0, n);
      if (go !== null) return LOe(go, !1);
      let Oo = await JOe(e.command, re, [], Be);
      if (Oo !== null) return Oo;
      if (Ko !== null) return Ko;
      let jo: Reason = {
        type: "other",
        reason: Re.reason,
        bashMissKind: "semantics",
        ...(oe.mode === "auto" && { acceptEditsCannotAllow: !0 }),
      };
      return {
        behavior: "ask",
        decisionReason: jo,
        message: El(Ks.name, jo),
        suggestions: [],
      };
    }
    let Ke = Be.map((Ko) => Ko.text),
      Qe = Be.flatMap((Ko) => Ko.redirects),
      ot =
        n.forRemoteExecution === !0
          ? null
          : elt(e, oe, Be, ke.bareAssignmentNames, n);
    if (
      ot &&
      (E !== "read" ||
        ot.behavior === "deny" ||
        (Re?.ok === !1 && Re.kind === "newline-hash"))
    )
      return ot;
    let it = Aun(e, oe);
    if (it.behavior === "deny") return it;
    let bt = () =>
        oe.blockReadsOutsideWorkingDirectories === !0 && !(Vh(e) && lM(oe))
          ? bQ(aIr)
          : void 0,
      vt = await Swn(
        e,
        (Ko) => Qde(Ko, n, r, a ?? e.command, re, y, void 0, E),
        {
          isNormalizedCdCommand: sb,
          isNormalizedGitCommand: Kde,
          shouldUseSandbox: Vh,
        },
        _e,
        Be,
        (Ko) => TOr(Ko, ue()),
        bt,
      );
    if (vt.behavior !== "passthrough") {
      let Ko =
        vt.behavior === "ask" &&
        vt.decisionReason?.type === "other" &&
        vt.decisionReason.bashMissKind === "shell-operators";
      if (Ko) {
        if (oe.blockReadsOutsideWorkingDirectories === !0 && !(Vh(e) && lM(oe)))
          return bQ("a subshell cannot be checked against the read block");
        if (_e && _e !== semantic.parseAbort) {
          let as = await Pbn(
            _e,
            ue(),
            oe,
            a,
            n.forRemoteExecution === !0,
            re,
            n,
          );
          if (as !== null) {
            Qv("tengu_bash_dangerous_rm_too_complex", { kind: f(as.kind) });
            try {
              let cr = ee(n),
                Po = O5e(e.command),
                vs = Po || Be.some((Jo) => sb(Jo.text)),
                ns = [
                  mD(e, ue(), cr, vs, Qe, Be, Fe(cr)),
                  ...(vs && !Po ? [mD(e, ue(), cr, !1, Qe, Be)] : []),
                ].find((Jo) => Jo.behavior === "deny");
              return ns !== void 0 ? A8(e.command, ns, as.result) : as.result;
            } catch (cr) {
              if (cr instanceof NativeBashSecurityUnsupported) throw cr;
              if (Uti(cr) || (n.abortController.signal.aborted && $e(cr)))
                throw cr;
              try {
                i(cr);
              } catch (error) {
                if (error instanceof NativeBashSecurityUnsupported) throw error;
              }
              return as.result;
            }
          }
        }
      }
      oe = ee(n);
      let go = O5e(e.command),
        Oo = go || Be.some((as) => sb(as.text)),
        jo = mD(e, ue(), oe, Oo, Qe, Be, Fe(oe)),
        Er = !Ko || E === "read",
        Rr = Ywn(jo, vt, Er);
      if (!Oo || go || Rr.behavior === "deny") return Rr;
      let ss = Ywn(mD(e, ue(), oe, !1, Qe, Be), vt, Er);
      if (
        !Tn(ss, Rr) &&
        ss.behavior === "ask" &&
        Rr.behavior === "ask" &&
        !VS(ss) &&
        !VS(Rr)
      )
        return {
          ...ss,
          message: `${Rr.message}

${ss.message}`,
          suggestions: [],
          decisionReason: {
            type: "subcommandResults",
            ...([Rr, ss].some(
              (as) => mQt(as.decisionReason) === "safetyCheck",
            ) && { typeOnWire: "safetyCheck" }),
            reasons: YOe([
              [e.command, Rr],
              [e.command, ss],
            ]),
          },
        };
      return nS(ss) > nS(Rr) ? ss : Rr;
    }
    let Ct = ue(),
      Pt = P() === "windows" ? zB(Ct) : Ct,
      { subcommands: Dt, astCommandsByIdx: Lt } = wOr(Ke, Be, Ct, Pt),
      $t = Dt.filter((Ko) => sb(Ko));
    if ($t.length > 1) {
      let Ko = Elt(Be, Ct, oe);
      if (Ko) return Ko;
      if (oe.blockReadsOutsideWorkingDirectories === !0 && !(Vh(e) && lM(oe)))
        return bQ(
          "multiple directory changes cannot be checked against the read block",
        );
      let Oo = D(
          [Ct, ...mv(ee(n))]
            .flatMap((ns) => {
              let { resolvedPath: Jo } = ko(se(), ns);
              return Jo === ns ? [ns] : [ns, Jo];
            })
            .map((ns) => l2(ns)),
        ).map((ns) => ({
          exact: Do(ns),
          prefix: Do(/[\\/]$/.test(ns) ? ns : ns + HMr),
        })),
        jo = (ns: string) => {
          let Jo = Do(l2(ns));
          return Oo.some(($r) => Jo === $r.exact || Jo.startsWith($r.prefix));
        },
        Rr =
          !/[;|\n&(`!]/.test(e.command.replace(/&&/g, "")) &&
          Be.every((ns) => {
            let Jo = l1(ns.argv)[0]?.replace(/^.*[\\/]/, "");
            return (
              !(
                Jo === "cd" ||
                Jo === "chdir" ||
                Jo === "pushd" ||
                Jo === "popd"
              ) || kwn(ns)
            );
          }),
        { resolvedPath: ss } = ko(se(), Ct),
        as = D([l2(Ct), l2(ss)]),
        cr: string[][] = [],
        Po = await JOe(e.command, re, [], Be);
      if (Po !== null) return Po;
      for (let ns of Be) {
        let [Jo, ...$r] = l1(ns.argv),
          Hs = Jo?.replace(/^.*[\\/]/, "");
        if (Hs === "cd" || Hs === "chdir" || Hs === "pushd" || Hs === "popd") {
          if (
            ((Rr &&= ns.argv[0] === Hs && ns.envVars.length === 0),
            Hs === "popd")
          )
            if ($r.length === 0 && cr.length > 0) as = required(cr.pop());
            else Rr = !1;
          else {
            let Oi = $r[0] === "--" ? $r.slice(1) : $r,
              Yi = Oi.length === 1 ? Oi[0] : void 0,
              oi = !1,
              Pi: string[] = [];
            if (
              Yi !== void 0 &&
              !/^[-+]/.test(Yi) &&
              !Yi.startsWith("~") &&
              !/[*?[]/.test(Yi) &&
              !Ys(Yi) &&
              !/(^|[\\/])\.\.([\\/]|$)/.test(Yi)
            ) {
              oi = !0;
              for (let aa of as) {
                let ul = _x(Yi) ? l2(Yi) : HF(aa, Yi),
                  { resolvedPath: fs } = ko(se(), ul);
                if (!jo(ul) || !jo(fs)) {
                  oi = !1;
                  break;
                }
                Pi.push(l2(ul), l2(fs));
              }
            }
            if (((Rr &&= oi), oi)) {
              if (Hs === "pushd") cr.push(as);
              as = D(Pi);
            }
          }
          continue;
        }
        if (Hs !== "rm" && Hs !== "rmdir") continue;
        let zs = o2(Hs, $r, Ct, ee(n), !Rr);
        if (zs.behavior !== "passthrough") return zs;
      }
      let vs: Reason = {
        type: "other",
        reason:
          "Multiple directory changes in one command require approval for clarity",
        bashMissKind: "multi-cd",
      };
      return { behavior: "ask", decisionReason: vs, message: El(Ks.name, vs) };
    }
    let gn = $t.length > 0,
      Ht = Ct,
      Qt = gn,
      nn = !1;
    if (
      n.forRemoteExecution !== !0 &&
      gn &&
      Dt.length > 1 &&
      Dt.length === Ke.length &&
      sb(required(Dt[0])) &&
      ZOe(e.command) &&
      e.command.trimStart().startsWith(required(Dt[0])) &&
      /^[ \t]*&&/.test(e.command.trimStart().slice(required(Dt[0]).length))
    ) {
      let Ko = Wlt(Lt[0], Ct, oe);
      if (Ko !== null) {
        Ht = Ko;
        Qt = false;
        nn = true;
      }
    }
    if (Qt || (gn && E === "read")) {
      let Ko = Elt(Be, Ct, oe);
      if (Ko) return Ko;
    }
    let yn: Decision | undefined;
    if (gn) {
      if (Dt.some((go) => Kde(go.trim())) && !(await bOr(Lt, Dt, Ct))) {
        let go: Reason = {
          type: "other",
          reason:
            "This command changes directory before running a version-control command, which can pick up untrusted hooks or repository configuration from the target directory. Approve only if you trust it.",
          bashMissKind: "cd-git-compound",
        };
        yn = { behavior: "ask", decisionReason: go, message: El(Ks.name, go) };
      }
    }
    let Cn: Decision | undefined;
    if (Dt.some((go) => Kde(go.trim())) && (qOe(Lt, Ht) || zde(e.command))) {
      let go: Reason = {
        type: "other",
        reason:
          "This command creates git repository structure files (HEAD/objects/refs/hooks) and then runs git, which can execute hooks/fsmonitor from the created files.",
        bashMissKind: "cd-git-compound",
      };
      Cn = { behavior: "ask", decisionReason: go, message: El(Ks.name, go) };
    }
    oe = ee(n);
    let vn = Dt.map((Ko, go) =>
      PIo(
        { command: Ko },
        oe,
        Qt,
        Lt[go],
        nn && go === 0 ? Ct : Ht,
        ke.bareAssignmentNames,
        Fe(oe),
        n,
      ),
    );
    if (vn.find((Ko) => Ko.behavior === "deny") !== void 0)
      return {
        behavior: "deny",
        message: `Permission to use ${Ks.name} with command ${e.command} has been denied.`,
        decisionReason: {
          type: "subcommandResults",
          reasons: Vde()
            ? plt(Dt, Lt, vn)
            : new Map(
                vn.map((Ko, go): [string, Decision] => [required(Dt[go]), Ko]),
              ),
        },
      };
    let io = Lt.slice(nn ? 1 : 0).filter((Ko) => Ko !== void 0),
      Qn = mD(e, Ht, oe, Qt, Qe, io, Fe(oe));
    if (Qn.behavior === "deny") return Qn;
    let so = await JOe(e.command, re, [], Be),
      Ao =
        Qn.behavior === "ask" &&
        Qn.decisionReason?.type === "safetyCheck" &&
        Qn.decisionReason.classifierApprovable === !1
          ? Qn
          : (so ?? Qn);
    if (
      Ao.behavior === "ask" &&
      Ao.decisionReason?.type === "safetyCheck" &&
      Ao.decisionReason.classifierApprovable === !1
    ) {
      if (!Az(Ao.decisionReason) || bF(Ao.decisionReason)) {
        let Ko =
          a2(vn, !0) ??
          (yn !== void 0 || Cn !== void 0 ? bt() : void 0) ??
          a2(vn) ??
          so ??
          void 0;
        if (Ko) return Ko;
      }
      return Ao;
    }
    if (yn !== void 0 || Cn !== void 0) {
      let Ko = a2(vn, !0) ?? bt() ?? a2(vn);
      if (Ko) return Ko;
    }
    if (yn !== void 0) return yn;
    if (Cn !== void 0) return Cn;
    let _o = Dt.map((Ko, go): [string, number] => [Ko, go])
      .filter(([Ko]) => Xrt(Ko))
      .map(([, Ko]) => Ko);
    if (_o.length > 0) {
      let Ko = _o.every((jo) => {
          let Er = vn[jo];
          return Er?.behavior === "allow" && Er.decisionReason?.type === "rule";
        }),
        go = vn.some((jo) => jo.behavior !== "allow"),
        Oo = Qn.behavior === "ask" && !Qn.bashAllowRuleOverridable;
      if (!Ko && !go && !Oo && it.behavior !== "allow") {
        let jo = new Set(
            _o
              .filter((Rr) => {
                let ss = vn[Rr];
                return (
                  ss?.behavior === "allow" && ss.decisionReason?.type === "rule"
                );
              })
              .map((Rr) => required(Dt[Rr]).trim()),
          ),
          Er = Qrt(e, oe, jo);
        if (Er.behavior === "ask") {
          if (oe.blockReadsOutsideWorkingDirectories === !0) return Mcr();
          return Er;
        }
      }
    }
    let Mo = vn.find((Ko) => Ko.behavior === "ask"),
      co = U(vn, (Ko) => Ko.behavior !== "allow");
    if (Qn.behavior === "ask" && Mo === void 0 && !Qn.bashAllowRuleOverridable)
      return Qn;
    if (Mo !== void 0 && co === 1) return Mo;
    if (it.behavior === "allow") {
      let Ko = e.command.trim(),
        go = dpe(oe, Ks, "allow");
      if (
        [Ko, oE(Ko)].some((Oo) => Ekt(Oo).type === "exact" && go.has(Oo)) ||
        mD(
          e,
          Ht,
          { ...ier("acceptEdits", oe), isRemoteMode: g6e(oe) },
          Qt,
          Qe,
          [],
        ).behavior === "passthrough" ||
        !RIo() ||
        !DY()
      )
        return it;
    }
    if (vn.every((Ko) => Ko.behavior === "allow"))
      return {
        behavior: "allow",
        updatedInput: e,
        decisionReason: {
          type: "subcommandResults",
          reasons: Vde()
            ? plt(Dt, Lt, vn)
            : new Map(
                vn.map((Ko, go): [string, Decision] => [required(Dt[go]), Ko]),
              ),
        },
      };
    let ao: Prefix | null | undefined = null;
    if (r) {
      if (
        ((ao = await r(
          e.command,
          n.abortController.signal,
          n.options.isNonInteractiveSession,
        )),
        n.abortController.signal.aborted)
      )
        throw new Ne();
    }
    if (((oe = ee(n)), Dt.length === 1))
      return await qwn(
        { command: required(Dt[0]) },
        oe,
        ao,
        Qt,
        Lt[0],
        Ht,
        ke.bareAssignmentNames,
        n,
      );
    let Hn: Decision[] = [];
    for (let Ko = 0; Ko < Dt.length; Ko++) {
      let go = required(Dt[Ko]);
      Hn.push(
        await qwn(
          { ...e, command: go },
          oe,
          ao?.subcommandPrefixes.get(go),
          Qt,
          Lt[Ko],
          nn && Ko === 0 ? Ct : Ht,
          ke.bareAssignmentNames,
          n,
        ),
      );
    }
    let jn = { deny: 3, ask: 2, passthrough: 1, allow: 0 },
      Ln = new Map<string, Decision>();
    for (let Ko = 0; Ko < Dt.length; Ko++) {
      let go = required(Dt[Ko]),
        Oo = required(Hn[Ko]),
        jo = Ln.get(go),
        Er = jn[Oo.behavior],
        Rr = jo ? jn[jo.behavior] : -1;
      if (
        !jo ||
        Er > Rr ||
        (Er === Rr &&
          Sa(Oo.decisionReason) !== void 0 &&
          Sa(jo.decisionReason) === void 0)
      )
        Ln.set(go, Oo);
    }
    if (Hn.every((Ko) => Ko.behavior === "allow"))
      return {
        behavior: "allow",
        updatedInput: e,
        decisionReason: {
          type: "subcommandResults",
          reasons: Vde() ? plt(Dt, Lt, Hn) : Ln,
        },
      };
    let oo = new Map<
      string,
      { toolName: string; ruleContent?: string | undefined }
    >();
    for (let Ko = 0; Ko < Hn.length; Ko++) {
      let go = required(Dt[Ko]),
        Oo = required(Hn[Ko]);
      if (Oo.behavior === "ask" || Oo.behavior === "passthrough") {
        let jo = "suggestions" in Oo ? Oo.suggestions : void 0,
          Er = Jfe(jo);
        for (let Rr of Er) {
          let ss = fn(Rr);
          oo.set(ss, Rr);
        }
        if (
          Oo.behavior === "ask" &&
          Er.length === 0 &&
          Oo.decisionReason?.type !== "rule"
        )
          for (let Rr of Jfe(Tzn(go))) {
            let ss = fn(Rr);
            oo.set(ss, Rr);
          }
      }
    }
    let Go: Reason = { type: "subcommandResults", reasons: Ln },
      Qr = Array.from(oo.values()).slice(0, zMr),
      ws: Suggestion[] | undefined =
        Qr.length > 0
          ? [
              {
                type: "addRules",
                rules: Qr,
                behavior: "allow",
                destination: "localSettings",
              },
            ]
          : void 0;
    return {
      behavior: Mo !== void 0 ? "ask" : "passthrough",
      message: El(Ks.name, Go),
      decisionReason: Go,
      suggestions: ws,
    };
  }

  function withPolicyScope<T>(
    permission: Policy,
    evaluationCwd: string,
    run: () => T,
    receipts: Provenance[] = [],
  ) {
    return frames.run(
      {
        policy: permission,
        scope: { policyId: permission.scope.policyId, cwd: evaluationCwd },
        receipts,
      },
      () =>
        state.withPolicyScope(
          permission,
          evaluationCwd,
          () =>
            pipeline.withPolicyScope(
              permission,
              evaluationCwd,
              () =>
                cwd.withPolicyScope(permission, evaluationCwd, run, receipts)
                  .result,
              receipts,
            ).result,
          receipts,
        ),
    );
  }
  return {
    state,
    cwd,
    pipeline,
    host,
    native: { nIe, Kde, plt },
    withPolicyScope,
  };
}
