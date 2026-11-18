import { AsyncLocalStorage } from "node:async_hooks";
import {
  classifyNativeBashPlainLine as R_i,
  nativeBashDollarOperandPattern as Rar,
  nativeBashAlternateArithmeticPattern as CXt,
} from "../native-bash-parser-features.js";
import type { NativeBashSemanticCommand as Command } from "../native-bash-semantics.js";
import type { createNativeBashOuterPrimitives } from "./outer-primitives.js";
import type { createNativeBashCwdAlternates } from "./cwd-alternates.js";
import {
  nativeBashRemovalReviewConfig,
  type NativeBashSecurityContext as Context,
  type NativeBashSecurityPrefixReader as PrefixReader,
  type NativeBashSecurityRecursion as Recursion,
  type NativeBashSecurityDeclarationObserver as DeclarationObserver,
} from "./security-recursion-types.js";
import {
  NativeBashSecurityUnsupported,
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityInput as Input,
  type NativeBashSecurityReason as Reason,
  type NativeBashSecurityRule as Rule,
} from "./security-types.js";
export type NativeBashOuterSafeFeature =
  | "tengu_quiet_sextant"
  | "bot_protected_tengu_zazzy_parasol"
  | "tengu_curried_squirrel";
export interface NativeBashOuterHost {
  livePolicy?: (context: Context, scope: Scope) => Fact<Policy>;
  currentCwd?: (scope: Scope) => Fact<string>;
  safeFeature?: (
    key: NativeBashOuterSafeFeature,
    safe: true,
    scope: Scope,
  ) => Fact<boolean>;
  glimmeringGlacier?: (fallback: true, scope: Scope) => Fact<boolean>;
  servedValuesChangeCount?: (scope: Scope) => Fact<number>;
  exportedVariablePromptDisabled?: (
    scope: Scope,
  ) => Fact<"absent" | "string-empty" | "string-nonempty">;
  replBridgeActive?: (scope: Scope) => Fact<boolean>;
  backgroundMode?: (scope: Scope) => Fact<string | undefined>;
  teammateAgentId?: (scope: Scope) => Fact<string | undefined>;
  telemetry?: (
    event: string,
    metadata: Readonly<Record<string, string | number | boolean | undefined>>,
    scope: Scope,
  ) => Fact<void>;
  reportError?: (error: unknown, scope: Scope) => Fact<void>;
  isAbortError?: (error: unknown, scope: Scope) => Fact<boolean>;
}
type Transform = (decision: Decision) => Decision | undefined;
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native outer-control invariant");
  return value;
}
/** Complete outer reconciliation. Internal stage results alone are not permission authority. */
export function createNativeBashOuterControl(
  primitives: ReturnType<typeof createNativeBashOuterPrimitives>,
  alternates: ReturnType<typeof createNativeBashCwdAlternates>,
  host: NativeBashOuterHost,
) {
  const { main } = alternates;
  if (primitives.main !== main)
    throw new Error("Native Bash outer process owners must be shared");
  const { state } = main;
  const { complexity } = state;
  const { nested } = complexity;
  const { syntax, shapes } = nested.recursion;
  const { semantic, preparation, policy } = syntax;
  const path = policy.pathOwner;
  const parser = semantic.parser;
  const frames = new AsyncLocalStorage<{
    policy: Policy;
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(fact: Fact<T>) =>
    readNativeBashSecurityFact(fact, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const ee = (context: Context) => {
    const value = use(
      need(host.livePolicy, "policy.live")(context, frame().scope),
    );
    frame().policy = value;
    frame().scope = { ...frame().scope, policyId: value.scope.policyId };
    return value;
  };
  const ue = () => {
    const value = use(need(host.currentCwd, "cwd.current")(frame().scope));
    frame().scope = { ...frame().scope, cwd: value };
    return value;
  };
  const scoped = <T>(permission: Policy, cwd: string, run: () => T) =>
    withPolicyScope(permission, cwd, run, frame().receipts).result;
  const current = <T>(run: () => T) =>
    scoped(frame().policy, frame().scope.cwd, run);
  const s = {
    get CLAUDE_CODE_DISABLE_EXPORTED_VARIABLE_PROMPT() {
      return (
        use(
          need(
            host.exportedVariablePromptDisabled,
            "environment.exportedVariablePromptDisabled",
          )(frame().scope),
        ) === "string-nonempty"
      );
    },
  };
  const je = (key: NativeBashOuterSafeFeature, _options: { safe: true }) =>
    use(need(host.safeFeature, "features.outerSafe")(key, true, frame().scope));
  const b = (_key: "tengu_glimmering_glacier", fallback: true) =>
    use(
      need(host.glimmeringGlacier, "features.glimmeringGlacier")(
        fallback,
        frame().scope,
      ),
    );
  const kmi = () =>
    use(
      need(
        host.servedValuesChangeCount,
        "features.servedValuesChangeCount",
      )(frame().scope),
    );
  const Sc = () =>
    use(need(host.replBridgeActive, "surface.replBridgeActive")(frame().scope));
  const Xt = () =>
    use(need(host.backgroundMode, "surface.backgroundMode")(frame().scope)) ===
    "bg";
  const wu = () =>
    use(need(host.teammateAgentId, "surface.teammateAgentId")(frame().scope));
  const hl = () => Sc() || Xt() || wu() !== undefined;
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
  const Qv = (
    event: string,
    metadata: Readonly<Record<string, string | number | boolean | undefined>>,
  ) =>
    shapes.observations.native.Qv(() => {
      use(
        need(host.telemetry, "telemetry.outer")(event, metadata, frame().scope),
      );
    });
  const f = <T extends string>(value: T) => value;
  const le = <T>(value: T | null | undefined) => value ?? undefined;
  const _ = (text: string) => required(JSON.stringify(text));
  const Ks = {
    name: "Bash",
    sandboxNetworkLists: primitives.native.Fce,
    isReadOnly: (input: Input, context: Context) =>
      current(() => policy.native.isReadOnly(input, context)),
  };
  const V1 = semantic.parse;
  const $b: typeof semantic.parseAbort = semantic.parseAbort;
  const SG = (
    text: string,
    tree: Parameters<typeof semantic.analyzeTree>[1],
    options: { declarationPrefix?: boolean[] | undefined } = {},
  ) =>
    semantic.analyzeTree(
      text,
      tree,
      options.declarationPrefix === undefined
        ? {}
        : { declarationPrefix: options.declarationPrefix },
    );
  const { F5r, MVo, jti, tPt, ePt } = semantic.native;
  const oR = semantic.analyze;
  const $de = main.pipeline.document.fromTree;
  const { splitCommands: Sy, nestedCommandTexts: yAt } = preparation.projection;
  const { Sa, VS, nS, IOr, gbn, wU, qOr, bk, A8, Az } = shapes.outcomes;
  const R0 = policy.native.R0;
  const { El, qde, T8 } = policy.native;
  const b0e = (context: Context) => new Set(context.sessionEnvVars?.keys());
  const { BOe, jde } = path.native;
  const P = path.gate.bindings.P;
  const nIe = (...args: Parameters<typeof main.native.nIe>) =>
    current(() => main.native.nIe(...args));
  const { Mat, Ekn, kOe, qat, zOe, N6 } = shapes.observations.native;
  const qgi = <T>(accepted: boolean, run: () => T | Promise<T>) =>
    preparation.features.observeEnvironment(accepted, run);
  const Ygi = <T>(run: () => T | Promise<T>) =>
    preparation.features.observeReading(run);
  const Xgi = <T>(run: () => T) => preparation.features.asBashReads(run);
  const cXt = <T>(run: () => T) => preparation.features.withoutReadingRule(run);
  const TXt = <T>(off: boolean, run: () => T | Promise<T>) =>
    parser.features.observeKeywordGuard(off, run);
  const iZo = <T>(run: () => T | Promise<T>) =>
    parser.features.observeMayDiffer(run);
  const vro = <T>(run: () => T) => parser.features.withoutArithmeticGuard(run);
  const C3a = <T>(run: () => T) =>
    parser.features.withAlternateArithmeticRead(run);
  const O_i = <T>(run: () => T) =>
    parser.features.withoutDollarOperandGuard(run);
  const wxe = (input: string) =>
    parser.features.dollarOperandGuardEnabled(input);
  const M_i = () => parser.features.dollarOperandFeatureEnabled();
  const D_i = () => parser.features.plainLineExemptionEnabled();
  const xar = () => parser.features.arithmeticGuardEnabled();
  const Hwn = (...args: Parameters<typeof parser.featureAnswers>) =>
    parser.featureAnswers(...args);
  const P3a = <T>(run: () => T | Promise<T>) =>
    parser.features.observeMisreading(run);
  const qMa = semantic.observeCutShort,
    YMa = semantic.withBudget;
  const { Fbn } = primitives.native;
  const cOr = (...args: Parameters<typeof primitives.native.cOr>) =>
    current(() => primitives.native.cOr(...args));
  const sIr = (...args: Parameters<typeof primitives.native.sIr>) =>
    current(() => primitives.native.sIr(...args));
  const zK = (
    _tool: typeof Ks,
    ...args: Parameters<typeof primitives.native.zK> extends [
      unknown,
      ...infer A,
    ]
      ? A
      : never
  ) => current(() => primitives.native.zK(Ks, ...args));
  const yoi = (context: Context) =>
    current(() => primitives.native.yoi(context));
  const { nIr, AIo } = alternates.native;
  const VOe = (...args: Parameters<typeof alternates.native.VOe>) =>
    current(() => alternates.native.VOe(...args));
  const mbn = (input: Input) => current(() => alternates.native.mbn(input));
  const Own = (...args: Parameters<typeof alternates.native.Own>) =>
    current(() => alternates.native.Own(...args));
  const Plt = (decision: Decision, input: Input, permission: Policy) =>
    scoped(permission, frame().scope.cwd, () =>
      state.native.Plt(decision, input, permission),
    );
  const ZOr = (decision: Decision, context: Context) =>
    current(() => state.native.ZOr(decision, context));
  const Hbn = (input: Input, context: Context) =>
    current(() => state.native.Hbn(input, context));
  const edt = (context: Context) => current(() => state.native.edt(context));
  const Ubn = (...args: Parameters<typeof state.native.Ubn>) =>
    current(() => state.native.Ubn(...args));
  const Qlt = (decision: Decision, context: Context) =>
    current(() => state.native.Qlt(decision, context));
  const fxe = (permission: Policy) =>
    scoped(permission, frame().scope.cwd, () => state.native.fxe(permission));
  const { Ilt, rbn, Bbn } = state.native;
  const D5e = (_tool: typeof Ks, input: Input) =>
    current(() => policy.native.D5e({ name: "Bash" }, input));
  const Vh = (input: Input) => current(() => policy.native.Vh(input));
  const dpe = (
    permission: Policy,
    _tool: typeof Ks,
    behavior: "deny" | "ask",
  ) =>
    scoped(permission, frame().scope.cwd, () =>
      policy.native.dpe(permission, { name: "Bash" }, behavior),
    );
  const yD = (input: Input, permission: Policy, phase: "prefix") =>
    scoped(permission, frame().scope.cwd, () =>
      policy.native.yD(input, permission, phase),
    );
  const S8 = () => current(path.native.S8);
  const { oat } = shapes.native;
  const XK = (reason: Parameters<typeof shapes.native.XK>[0]) =>
    current(() => shapes.native.XK(reason));
  const iM = () => {
    const receipt = use(
      need(
        nested.host.removalReviewFeature,
        "features.removalReview",
      )(frame().scope),
    );
    const disabled = use(
      need(
        nested.host.dangerousRemovalTimeoutDisabled,
        "environment.dangerousRemovalTimeoutDisabled",
      )(frame().scope),
    );
    return nativeBashRemovalReviewConfig(receipt, disabled);
  };
  const Fun = () => je("tengu_curried_squirrel", { safe: true });
  const KOr = "tengu_quiet_sextant",
    VOr = "tengu_glimmering_glacier",
    oIr = "bot_protected_tengu_zazzy_parasol";
  const GOr = new RegExp(`[\\uE000-\\uF8FF]|${tPt.source}|${ePt.source}`, "g");
  const uQt = "bashCommandClamp: no clamp rule matches this command",
    KD = "permission_check_crashed",
    wEe = "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)";
  const KQn: Readonly<Record<string, string | undefined>> = {
    words_after_test:
      "Text after a closing ] in this command can't be checked before it runs",
    words_after_redirect:
      "Words after a redirect in this command can't be checked before it runs",
    reserved_word_after_prefix:
      "A shell keyword or opening brace in this command can't be checked before it runs",
    equals_in_test:
      "Text right after an = inside [[ ]] in this command can't be checked before it runs",
    hash_in_test:
      "Text after a # inside [ ] or [[ ]] in this command can't be checked before it runs",
    hash_in_for_list:
      "Text after a # in a for or select list in this command can't be checked before it runs",
    digits_before_redirect:
      "Your shell may read the digits just before a redirect in this command differently from Claude Code, so it can't be checked before it runs. To pass the digits as an argument, put a space after them.",
    dollar_quote_string:
      "A $'\u2026' string in this command may hide code that can't be checked before it runs",
    brace_text_read_again:
      "Text in or next to a brace pattern in this command can't be checked before it runs",
    pattern_flag:
      "A $ followed by ~ in this command may make zsh read a value as a pattern, which may run code that can't be checked before it runs",
    quoted_code_in_subscript:
      "Quoted text in square brackets in this command may run as code that can't be checked before it runs",
    bracket_word:
      "A bracket word or a ( ) list in this command can't be checked before it runs: your shell may read it as going on past where Claude Code ended it",
  };

  async function Qde(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: string,
    h?: Recursion,
    y?: boolean[],
    k?: DeclarationObserver,
    E?: "read" | "refused",
  ): Promise<Decision> {
    let N: { commands?: Command[] } = {},
      V = await iIr(e, n, r, a, h, y, k, E, (oe) => {
        N.commands = oe;
      });
    return a === void 0 && h === void 0 && N.commands !== void 0
      ? sIr(V, e, n, N.commands)
      : V;
  }
  async function iIr(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: string,
    h?: Recursion,
    y?: boolean[],
    k?: DeclarationObserver,
    E?: "read" | "refused",
    N?: (commands: Command[]) => void,
  ): Promise<Decision> {
    let V = ee(n).bashCommandClamps;
    if (V !== void 0 && V.length > 0) {
      let xe = await cOr(e, V);
      if (xe !== null)
        return (
          Qv("tengu_bash_command_clamp_denied", { groupCount: V.length }),
          {
            behavior: "deny",
            message:
              `Permission to use ${Ks.name} with command ${e.command.trim()} has been denied: this agent's Bash use is clamped to a fixed set of command forms (per-spawn bashCommandClamp), and ` +
              (xe.kind === "unverifiable"
                ? "the command has structure the clamp cannot verify " +
                  "(substitution, control flow, or an undecomposable compound) \u2014 " +
                  "no clamp rule can admit it. Issue plain commands matching the clamped forms."
                : `the span ${_(xe.span)} matches none of them. Allowed forms: ${xe.group.join(", ")}`),
            decisionReason: { type: "other", reason: uQt },
          }
        );
    }
    let oe = { laterPassesDiffer: !1 },
      re = Plt(
        await zOe(E === "read", () =>
          nIe(
            e,
            n,
            r,
            a,
            h,
            y,
            k,
            E,
            () => {
              oe.laterPassesDiffer = !0;
            },
            N,
          ),
        ),
        e,
        ee(n),
      ),
      _e = re;
    if (
      oe.laterPassesDiffer &&
      a === void 0 &&
      (re.behavior === "allow" || re.behavior === "passthrough" || VS(re))
    ) {
      let xe: Reason = {
          type: "other",
          reason:
            "Only the first pass of a loop in this command could be checked, and its later passes may run something else",
          bashMissKind: "loop-later-pass",
          ...(ee(n).mode === "auto" && { acceptEditsCannotAllow: !0 }),
        },
        Pe = El(Ks.name, xe),
        Be = Plt(
          { behavior: "ask", message: Pe, decisionReason: xe },
          e,
          ee(n),
        ),
        Fe = re.behavior === "allow" && Hbn(e, n);
      if (!VS(Be) && (Fe || !D5e(Ks, e))) _e = Be;
      else if (re.behavior === "allow" && !Fe)
        _e = { behavior: "passthrough", message: Pe, decisionReason: xe };
    }
    if (
      oe.laterPassesDiffer &&
      a === void 0 &&
      (_e.behavior === "ask" || _e.behavior === "passthrough")
    )
      _e = { ..._e, suggestions: [] };
    if (re.behavior !== "allow" || _e.behavior === "ask")
      return Zwn(_e, e, ee(n));
    if (
      !e.command.includes("&") ||
      (re.decisionReason?.type === "other" && re.decisionReason.reason === wEe)
    )
      return _e;
    let ke = await V1(e.command);
    if (ke && ke !== $b && !Fbn(ke)) return _e;
    let Re: Reason = {
      type: "safetyCheck",
      reason:
        "This command uses the `&` background operator, which defers execution past approval-time safety checks. Approve only if you trust it.",
      classifierApprovable: !1,
      circuitBreaker: "backgroundOperator",
    };
    return Zwn(
      { behavior: "ask", decisionReason: Re, message: El(Ks.name, Re) },
      e,
      ee(n),
    );
  }
  async function ibn(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let h: {
        names?: number;
        operands?: boolean[] | undefined;
        fromUncertainWrite?: boolean;
      } = {},
      y = await Qde(e, n, r, void 0, void 0, void 0, (V, oe, re) => {
        h.names = V;
        h.operands = oe;
        h.fromUncertainWrite = re;
      }),
      k = a?.(y) ?? y,
      E: (boolean[] | undefined)[] = [void 0];
    if (h.names !== void 0) {
      let { readings: V, exhaustive: oe } = F5r(h.names, h.operands);
      E.push(...V);
      let re: Decision[] = [];
      for (let ke of V) {
        let Re = await N6(() => Qde(e, n, r, void 0, void 0, ke));
        re.push(a?.(Re) ?? Re);
      }
      let _e = Plt(IOr(k, re, oe, h.fromUncertainWrite === !0), e, ee(n));
      if (_e === k || _e.behavior !== "ask" || !VS(_e)) k = _e;
      else if (k.behavior !== "passthrough")
        k = {
          behavior: "passthrough",
          message: _e.message,
          ...(_e.decisionReason !== void 0 && {
            decisionReason: _e.decisionReason,
          }),
        };
    }
    let N =
      k.behavior === "allow" &&
      !s.CLAUDE_CODE_DISABLE_EXPORTED_VARIABLE_PROMPT &&
      je(oIr, { safe: !0 });
    if (
      k.behavior !== "deny" &&
      (N || /[$|*?[~]/.test(e.command)) &&
      !(
        k.decisionReason?.type === "other" && k.decisionReason.reason === wEe
      ) &&
      !(
        k.decisionReason?.type === "rule" &&
        k.decisionReason.rule.ruleValue.ruleContent === e.command.trim()
      )
    ) {
      let V = (await V1(e.command)) ?? $b,
        oe = E.map((xe) => SG(e.command, V, { declarationPrefix: xe })),
        re = qde(b0e(n)),
        _e = V !== $b && $de(e.command, V).getPipeSegments().length > 1,
        ke = oe.some((xe) => xe.kind === "simple" && xe.commands.some(nIr)),
        Re = oe.some((xe) => {
          if (xe.kind !== "simple") return !1;
          if (
            xe.usesAssignedValue === !0 ||
            (_e && T8(xe.bareAssignmentNames, re))
          )
            return !0;
          if (!N) return !1;
          let Pe = [...xe.bareAssignmentNames];
          for (let { argv: Be } of xe.commands)
            for (let Fe of Be[0] === "export" ? Be : []) {
              let Ke = Pe.findIndex((Qe) => Fe.startsWith(`${Qe}=`));
              if (Ke !== -1) Pe.splice(Ke, 1);
            }
          return T8(Pe, re) || VOe(Pe, e);
        });
      if (k.behavior !== "allow") {
        if (ke || Re) k = { ...k, suggestions: [] };
      } else if (ke || Re || oe.some((xe) => xe.kind !== "simple")) {
        let xe: Reason = {
            type: "other",
            reason: ke
              ? "A pattern or ~ word here may become an option, a variable name or a number, so this command can't be checked before it runs"
              : Re
                ? "A variable set in this command can't be checked before it runs"
                : "This command couldn't be checked automatically",
            bashMissKind: "assigned-variable",
          },
          Pe: Decision = {
            behavior: "passthrough",
            decisionReason: xe,
            message: El(Ks.name, xe),
            suggestions: [],
          };
        k = a?.(Pe) ?? Pe;
      }
    }
    if (k.behavior === "allow" && gbn(k.decisionReason) && mbn(e)) {
      let V = (await V1(e.command)) ?? $b,
        oe = SG(e.command, V),
        re = oe.kind !== "simple";
      if (oe.kind !== "simple" || VOe(oe.bareAssignmentNames, e)) {
        let _e: Reason = {
            type: "other",
            reason: re
              ? "Claude Code couldn't finish checking this command. Approve only if you trust it."
              : "This command sets a variable that can make git run a program. Approve only if you trust it.",
            bashMissKind: re ? "too-complex" : "assigned-variable",
          },
          ke: Decision = {
            behavior: "passthrough",
            decisionReason: _e,
            message: El(Ks.name, _e),
            suggestions: [],
          };
        k = a?.(ke) ?? ke;
      }
    }
    return k;
  }
  async function sbn(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let { result: h, refused: y } = await qgi(!1, () => ibn(e, n, r, a));
    if (!y || h.behavior === "deny") return h;
    try {
      let { result: k } = await qgi(!0, () => N6(() => ibn(e, n, r, a))),
        N = !(
          k.behavior !== "allow" &&
          !(nS(k) === 4 && edt(n)) &&
          Ubn(k, h, n)
        )
          ? h
          : k.behavior === "deny" || h.behavior === "allow"
            ? k
            : wU({ ...k, suggestions: [] }, h),
        V =
          VS(N) && (h.behavior !== "ask" || k.behavior !== "ask")
            ? (zK(Ks, e, n, void 0) ?? N)
            : N;
      return V.behavior === "ask" && (k.behavior === "allow" || Ilt(k))
        ? { ...V, standsInUnderHookAsk: !0 }
        : V;
    } catch (k) {
      if (k instanceof NativeBashSecurityUnsupported) throw k;
      if ($e(k)) throw k;
      return (i(k), Qlt(h, n));
    }
  }
  async function JOr(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let {
      result: h,
      refused: y,
      pathListRefused: k,
    } = await Mat(!1, () => sbn(e, n, r, a));
    if ((!y && !k) || h.behavior === "deny") return h;
    let { result: E } = await Mat(!0, () => N6(() => sbn(e, n, r, a)));
    if (E.behavior === "deny" || (E.behavior === "ask" && !VS(E))) return E;
    if (h.behavior === "ask" && E.behavior !== "ask")
      return VS(h)
        ? {
            behavior: "passthrough",
            message: h.message,
            ...(h.decisionReason !== void 0 && {
              decisionReason: h.decisionReason,
            }),
            ...(h.suggestions !== void 0 && { suggestions: h.suggestions }),
            ...(h.blockedPath !== void 0 && { blockedPath: h.blockedPath }),
          }
        : h;
    let N = nS(E) - nS(h);
    return N > 0 || (N === 0 && !y) ? E : h;
  }
  async function QOr(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let h = () => JOr(e, n, r, a),
      [y, k] = await Ygi(h),
      E = y;
    if (k !== void 0 && y.behavior !== "deny") {
      let N = await N6(() => Xgi(h));
      E = rbn(E, N, k);
      let V = await N6(() => cXt(h));
      if (
        ((E = rbn(E, V, k)),
        e.dangerouslyDisableSandbox &&
          !Vh(e) &&
          Vh({ ...e, dangerouslyDisableSandbox: !1 }))
      ) {
        if (Ilt(V) && E.behavior !== "deny" && Fun()) E = Bbn(k);
      } else if (Ilt(E))
        E = zK(Ks, e, n, { behavior: "passthrough", message: "" }) ?? E;
      if (
        E.behavior === "ask" &&
        (V.behavior === "allow" ||
          V.behavior === "passthrough" ||
          (V.behavior === "ask" &&
            !bk(V) &&
            Sa(V.decisionReason) === void 0 &&
            V.decisionReason?.type !== "sandboxOverride"))
      )
        E = { ...E, standsInUnderHookAsk: !0 };
    }
    if (E.behavior === "ask" && VS(E)) {
      let N = zK(Ks, e, n, { behavior: "passthrough", message: "" });
      if (N !== void 0) {
        let V = (await V1(e.command)) ?? $b,
          oe = SG(e.command, V);
        if (oe.kind === "too-complex" && oe.keepsRemovalVerdict) E = N;
      }
    }
    if (S8()) {
      let N = Sa(
          E.decisionReason,
          (oe) => oe.circuitBreaker === "dangerousRemoval",
        ),
        V = N === void 0 ? void 0 : oat(N.reason);
      if (V !== void 0) XK(V);
    }
    return E;
  }
  async function XOr(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let h = () => QOr(e, n, r, a),
      { result: y, fired: k } = await TXt(!1, h);
    if (!k || y.behavior === "deny") return y;
    try {
      let { result: E } = await TXt(!0, () => N6(h));
      return E.behavior === "deny" ? E : y;
    } catch (E) {
      if (E instanceof NativeBashSecurityUnsupported) throw E;
      if ($e(E)) throw E;
      return (i(E), y);
    }
  }
  async function YOr(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    if (Rar.test(e.command))
      Qv("tengu_bash_plain_line_check", {
        guard_enabled: M_i(),
        exemption_enabled: D_i(),
        not_spared_for: f(R_i(e.command) ?? "none"),
      });
    let h = wxe(e.command),
      y = CXt.test(e.command),
      k = y ? obn(e.command) : void 0,
      E = XOr.bind(null, e, n, r, a),
      { result: N, mayDiffer: V } = y
        ? await iZo(E)
        : { result: await E(), mayDiffer: !1 };
    if (N.behavior === "deny") return N;
    let oe = (h || wxe(e.command)) && je(KOr, { safe: !0 }),
      re = y && (oe || V || k === void 0 || obn(e.command) !== k);
    if (!(oe || re)) return N;
    try {
      let _e = re ? [vro, C3a] : [vro];
      for (let ke of _e) {
        let Re = await ke(() => N6(() => (oe ? O_i(E) : E())));
        if (Re.behavior === "deny")
          return {
            ...Re,
            decisionReason: {
              type: "subcommandResults",
              reasons: new Map([
                [e.command, Re],
                [`${e.command} (as refused)`, N],
              ]),
            },
          };
      }
      return N;
    } catch (_e) {
      if (_e instanceof NativeBashSecurityUnsupported) throw _e;
      if (n.abortController.signal.aborted && $e(_e)) throw _e;
      try {
        i(_e);
      } catch (error) {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
      }
      return N;
    }
  }
  async function tbn(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let h = () => YOr(e, n, r, a),
      { verdict: y, refused: k } = await qat(h);
    if (!k || y.behavior === "deny") return y;
    let { verdict: E } = await N6(() => qat(h, { byName: !0 }));
    return qOr(E, y);
  }
  async function ebn(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let h = await tbn(e, n, r, a);
    if (
      h.behavior === "deny" ||
      !jti.test(e.command) ||
      n.forRemoteExecution === !0 ||
      P() === "windows"
    )
      return h;
    try {
      let y = await oR(e.command),
        k = n,
        E =
          y.kind === "simple"
            ? Own(
                e.command,
                y,
                ue(),
                (oe) => kOe(() => Ks.isReadOnly({ command: oe }, k)),
                AIo,
              )
            : [],
        N: Decision | undefined;
      for (let oe of E) {
        let re = await N6(() => tbn({ ...e, command: oe }, n, r, a));
        if (
          !(
            re.decisionReason?.type === "other" &&
            re.decisionReason.reason === uQt
          ) &&
          (N === void 0 || nS(re) > nS(N))
        )
          N = re;
        if (N?.behavior === "deny") break;
      }
      if (
        N === void 0 ||
        (N.behavior !== "deny" &&
          !(N.behavior === "ask" && bk(N)) &&
          h.behavior !== "passthrough" &&
          !VS(h)) ||
        (h.behavior === "passthrough" && VS(N))
      )
        return h;
      let V = nS(N) - nS(h);
      if (V <= 0) {
        let oe = ee(n);
        if (
          !E.every((re) => kOe(() => Ks.isReadOnly({ command: re }, k))) ||
          (V < 0 &&
            !(
              (oe.mode === "default" || oe.mode === "acceptEdits") &&
              oe.modeBeforeRewrite === void 0 &&
              oe.shouldAvoidPermissionPrompts !== !0 &&
              !n.options.isNonInteractiveSession &&
              n.asksNoHost !== !0 &&
              n.agentId === void 0 &&
              !hl() &&
              !jde(oe) &&
              !Object.values(oe.alwaysAskRules).some((re) =>
                (re ?? []).some(BOe),
              ) &&
              oe.blockReadsOutsideWorkingDirectories !== !0 &&
              !e.command.includes("..") &&
              !(
                y.kind === "simple" &&
                y.commands.some(({ argv: re }) =>
                  re.some((_e) => _e.includes("..")),
                )
              )
            ))
        )
          return h;
      }
      if (N.behavior === "deny")
        return {
          ...N,
          decisionReason: {
            type: "subcommandResults",
            reasons: new Map([
              [required(N.message), N],
              [e.command, h],
            ]),
          },
        };
      return "updatedInput" in N && N.updatedInput !== void 0
        ? { ...N, updatedInput: e }
        : N;
    } catch (y) {
      if (y instanceof NativeBashSecurityUnsupported) throw y;
      if (n.abortController.signal.aborted && $e(y)) throw y;
      try {
        i(y);
      } catch (error) {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
      }
      if (h.behavior === "ask") return h;
      return {
        behavior: "ask",
        message: "This command could not be fully checked",
        decisionReason: { type: "other", reason: KD },
      };
    }
  }
  async function zOr(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let h = await ebn(e, n, r, a),
      y = e.command.replace(GOr, "\uFFFD");
    if (y === e.command || h.behavior === "deny") return h;
    try {
      let k = await N6(() => ebn({ ...e, command: y }, yoi(n), r, void 0));
      if (k.behavior === "deny") return A8(e.command, k, h);
      if (
        k.behavior !== "ask" ||
        !Ubn(k, h, n) ||
        (!bk(k) && Sa(k.decisionReason, (N) => Az(N) && !R0(N)) === void 0)
      )
        return h;
      return (nS(h) === 4 || e.dangerouslyDisableSandbox === !0) &&
        fxe(ee(n)) &&
        !iM().enabled
        ? h
        : wU({ ...k, suggestions: [] }, h);
    } catch (k) {
      if (k instanceof NativeBashSecurityUnsupported) throw k;
      if (n.abortController.signal.aborted && $e(k)) throw k;
      try {
        i(k);
      } catch (error) {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
      }
      return Qlt(h, n);
    }
  }
  async function OIo(
    e: Input,
    n: Context,
    r?: PrefixReader,
    a?: Transform,
  ): Promise<Decision> {
    let { result: h, misreading: y } = await P3a(() =>
        Ekn(() => qMa(() => YMa(() => zOr(e, n, r, a)))),
      ),
      { result: k, untrustedCheckout: E } = h,
      N = k.cutShort ? ZOr(k.result, n) : k.result,
      V =
        N.behavior === "ask"
          ? Sa(
              N.decisionReason,
              (Re) => Re.circuitBreaker === "dangerousRemoval",
            )
          : void 0;
    if (V !== void 0)
      try {
        Qv("tengu_bash_dangerous_rm_ask", {
          cause: le(V.removalRule),
          permissionMode: f(ee(n).mode),
        });
      } catch (error) {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
      }
    if (N.behavior === "ask" && Sa(N.decisionReason) !== void 0)
      return {
        ...N,
        suggestions: N.suggestions?.filter((Re) => Re.type !== "addRules"),
      };
    let oe = y === void 0 ? E : KQn[y];
    if (oe === void 0 || N.behavior !== "allow" || Hbn(e, n)) return N;
    if (y !== void 0)
      Qv("tengu_bash_ast_too_complex", {
        nodeTypeId: MVo(void 0),
        reason: f(y),
      });
    let { mode: re, modeBeforeRewrite: _e } = ee(n);
    if (y === void 0 && _e === void 0)
      Qv("tengu_bash_git_untrusted_checkout", { permission_mode: f(re) });
    let ke: Reason = {
      type: "other",
      reason: oe,
      bashMissKind: y === void 0 ? "git-untrusted-checkout" : "too-complex",
    };
    return {
      behavior: "passthrough",
      decisionReason: ke,
      message: El(Ks.name, ke),
      suggestions: [],
    };
  }
  function Zwn(e: Decision, n: Input, r: Policy): Decision {
    if (e.behavior !== "ask" || bk(e)) return e;
    if (dpe(r, Ks, "ask").size === 0 && dpe(r, Ks, "deny").size === 0) return e;
    let a = new Set([
        n.command,
        ...Sy(n.command),
        ...(e.decisionReason?.type === "subcommandResults"
          ? e.decisionReason.reasons.keys()
          : []),
        ...yAt(n.command),
        ...(CXt.test(n.command) ? vro(() => yAt(n.command)) : []),
      ]),
      h: Rule | undefined;
    for (let y of a) {
      let { matchingDenyRules: k, matchingAskRules: E } = yD(
        { ...n, command: y },
        r,
        "prefix",
      );
      if (k[0] !== void 0)
        return {
          behavior: "deny",
          message: `Permission to use ${Ks.name} with command ${n.command} has been denied.`,
          decisionReason: { type: "rule", rule: k[0] },
        };
      h ??= E[0];
    }
    return h === void 0 ? e : { ...e, matchedAskRule: h };
  }
  function obn(e: string): string | undefined {
    try {
      return b(VOr, !0) === !0 && xar() ? `${Hwn(-1, e)} ${kmi()}` : void 0;
    } catch (n) {
      if (n instanceof NativeBashSecurityUnsupported) throw n;
      try {
        i(n);
      } catch (error) {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
      }
      return;
    }
  }

  function withPolicyScope<T>(
    permission: Policy,
    cwd: string,
    run: () => T,
    receipts: Provenance[] = [],
  ) {
    return frames.run(
      {
        policy: permission,
        scope: { policyId: permission.scope.policyId, cwd },
        receipts,
      },
      () =>
        alternates.withPolicyScope(
          permission,
          cwd,
          () =>
            primitives.withPolicyScope(permission, cwd, run, receipts).result,
          receipts,
        ),
    );
  }
  return {
    main,
    primitives,
    alternates,
    host,
    native: {
      Qde,
      iIr,
      ibn,
      sbn,
      JOr,
      QOr,
      XOr,
      YOr,
      tbn,
      ebn,
      zOr,
      OIo,
      Zwn,
      obn,
    },
    withPolicyScope,
  };
}
