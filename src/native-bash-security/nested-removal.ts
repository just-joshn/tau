import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeBashSyntaxNode as Node } from "../native-bash-parser.js";
import type { createNativeBashSecurityInlineRecursion } from "./inline-recursion.js";
import type {
  createNativeBashLiteralRemoval,
  NativeBashLiteralAssignments as Assignments,
  NativeBashLiteralRemovalCandidate as Candidate,
} from "./literal-removal.js";
import {
  nativeBashRemovalReviewConfig,
  type NativeBashSecurityInlineContext as InlineContext,
  type NativeBashSecurityContext as Context,
  type NativeBashSecurityNestedRemoval as Nested,
  type NativeBashSecurityRecursiveCheck as RecursiveCheck,
} from "./security-recursion-types.js";
import {
  NativeBashSecurityUnsupported,
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityFact as Fact,
} from "./security-types.js";

export interface NativeBashSecurityNestedRemovalHost {
  processEnvironment?: (
    name: string,
    scope: Scope,
  ) => Fact<{ kind: "string"; empty: boolean } | { kind: "absent" }>;
  shellExportHasOwn?: (name: string, scope: Scope) => Fact<boolean>;
  removalReviewFeature?: (
    scope: Scope,
  ) => Fact<{ value: unknown; source: string }>;
  dangerousRemovalTimeoutDisabled?: (scope: Scope) => Fact<boolean>;
  substitutionRemovalDisabled?: (scope: Scope) => Fact<boolean>;
  iridescentBoot?: (scope: Scope) => Fact<{ value: boolean; source: string }>;
  tooComplexTelemetry?: (kind: "wholeSubstitution", scope: Scope) => Fact<void>;
  /** Complete native $e including hf, Ne, Error AbortError/__CANCEL__, with its native catch behavior. */
  isAbortError?: (error: unknown, scope: Scope) => Fact<boolean>;
  reportError?: (error: unknown, scope: Scope) => Fact<void>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native nested-removal invariant");
  return value;
}
export function createNativeBashSecurityNestedRemoval(
  recursion: ReturnType<typeof createNativeBashSecurityInlineRecursion>,
  literal: ReturnType<typeof createNativeBashLiteralRemoval>,
  host: NativeBashSecurityNestedRemovalHost,
  check: RecursiveCheck,
) {
  const { syntax, shapes } = recursion;
  const { semantic, preparation, policy } = syntax;
  const path = policy.pathOwner;
  if (literal.pathOwner !== path)
    throw new Error("Native Bash process owners must be shared");
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(receipt: Fact<T>) =>
    readNativeBashSecurityFact(receipt, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const { S8, o2, nb, l1, sD } = path.native;
  const { Ge } = path.gate.bindings;
  const { FOe, LOe, aat } = literal.native;
  const { JOe } = recursion.native;
  const { Nbn } = recursion.constants;
  const { sb, O5e, slt, MOr, xbn } = syntax.native;
  const { C8, v8, rlt, Xde, XK } = shapes.native;
  const { P8 } = shapes.inline.native;
  const { Sa, bk } = shapes.outcomes;
  const { N6, zOe, Qv: observeEvent } = shapes.observations.native;
  const {
    extractInlineShellBody: a2o,
    enqueueBodyAlternatives: i2o,
    readBodyAlternatives: o2o,
    collectNestedTexts: ozr,
    splitCommands: Sy,
  } = preparation.projection;
  const V1 = semantic.parse;
  const oR = semantic.analyze;
  const wro = () => semantic.parser.features.keywordGuardEnabled();
  const { F5r, Uti } = semantic.native;
  const M5r = semantic.observeBudget;
  const x5e = preparation.stripWrapperArgv;
  const El = policy.native.El;
  const Ks = { name: "Bash" };
  const D5e = policy.native.D5e;
  const nIe = check;
  const D = <T>(values: T[]) => [...new Set(values)];
  const xOr = 128;
  const POr = 65536;
  const Mbn = 32;
  const Obn = 20000;
  const iM = () => {
    const receipt = use(
      need(host.removalReviewFeature, "features.removalReview")(frame().scope),
    );
    return nativeBashRemovalReviewConfig(
      receipt,
      use(
        need(
          host.dangerousRemovalTimeoutDisabled,
          "environment.dangerousRemovalTimeoutDisabled",
        )(frame().scope),
      ),
    );
  };
  const s = {
    get CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT() {
      return use(
        need(
          host.substitutionRemovalDisabled,
          "environment.substitutionRemovalDisabled",
        )(frame().scope),
      );
    },
  };
  const dn = (_key: string, _default: true) =>
    use(need(host.iridescentBoot, "features.iridescentBoot")(frame().scope));
  const Qv = (
    _event: "tengu_bash_dangerous_rm_too_complex",
    metadata: { kind: "wholeSubstitution" },
  ) =>
    observeEvent(() => {
      use(
        need(host.tooComplexTelemetry, "telemetry.removalTooComplex")(
          metadata.kind,
          frame().scope,
        ),
      );
    });
  const f = (kind: "wholeSubstitution") => kind;
  const $e = (error: unknown) =>
    use(
      need(host.isAbortError, "errors.abortClassification")(
        error,
        frame().scope,
      ),
    );
  const i = (error: unknown) => {
    use(need(host.reportError, "errors.report")(error, frame().scope));
  };
  function Rbn(
    e: boolean,
    n: Context,
  ): { mayBeUnset: (name: string) => boolean } | undefined {
    if (!S8()) return;
    return {
      mayBeUnset: (r: string) => {
        if (e) return !0;
        if (r === "TMPDIR" && Ge.isSandboxingEnabled()) return !1;
        let a = use(
          need(host.processEnvironment, "environment.processPresence")(
            r,
            frame().scope,
          ),
        );
        if (a.kind === "string") return a.empty;
        return (
          /^(?:TMPDIR|TMP|TEMP)$/.test(r) ||
          policy.native.kzn(new Set(n.sessionEnvVars?.keys()))?.has(r) !== !0 ||
          use(
            need(host.shellExportHasOwn, "environment.shellExportHasOwn")(
              r,
              frame().scope,
            ),
          )
        );
      },
    };
  }

  function qlt(
    e: string,
    n: boolean,
    r: string | undefined,
    a: boolean,
    h: Context,
    y?: Assignments,
  ): Candidate | null {
    let k = Rbn(a, h);
    if (k === void 0) return n ? null : FOe(e);
    let E = FOe(e, {
      ...k,
      wholeCommand: r,
      skipAssignedOriginalHits: n,
      assignments: y,
    });
    if (E === null) return null;
    if (E.rootChild !== void 0) XK("var_root_child");
    else if (E.derived !== void 0) XK("derived_var");
    else if (n || FOe(e) === null) XK("eval_trap_string");
    return E;
  }

  async function OOr(
    e: Node,
    n: string,
    r: Policy,
    a: string | undefined,
    h: boolean,
    y: InlineContext,
    k: Context,
  ): Promise<Nested | null> {
    let E: string[] = [],
      N = { first: [], second: [] },
      V: string[] = [],
      oe = (Qt: Node): void => {
        let nn = Qt.text,
          yn = a2o(Qt);
        if (
          Qt.type === "command_substitution" ||
          Qt.type === "process_substitution" ||
          yn !== null
        ) {
          let vn =
              nn.startsWith("$(") || nn.startsWith("<(") || nn.startsWith(">(")
                ? 2
                : nn.startsWith("`")
                  ? 1
                  : 0,
            An =
              nn.endsWith(")") || nn.endsWith("`") ? nn.length - 1 : nn.length;
          E.push(yn ?? nn.slice(vn, An).trim());
        }
        if (Qt.type === "backtick_body_overrun")
          V.push(nn.replace(/^[\s;&|]+/, ""));
        i2o(Qt, N);
        for (let Cn of Qt.children) if (Cn) oe(Cn);
      };
    oe(e);
    let re = Rbn(h, k),
      _e = re === void 0 ? void 0 : aat(a ?? e.text, re.mayBeUnset),
      ke = e.keywordAfterPrefix === !0;
    if (E.length > 64) {
      if (wro() || /\brm(?:dir)?\b/.test(e.text))
        return {
          result: nb(
            "rm",
            `This command contains ${E.length} command substitutions \u2014 too many to analyze for catastrophic removals. This requires explicit approval.`,
            `not ruled out \u2014 too many command substitutions to analyze (${E.length})`,
            "tooManySubstitutions",
          ),
          kind: "tooManySubstitutions",
        };
      return null;
    }
    let Re = E.length;
    for (let { body: Qt, bodyRoot: nn } of o2o(N))
      if ((E.push(Qt), V.push(Qt), nn)) oe(nn);
    if (E.length - Re > xOr)
      return {
        result: nb(
          "rm",
          "This command holds too many nested command substitutions to analyze for catastrophic removals. This requires explicit approval.",
          "not ruled out \u2014 too many nested command substitutions to analyze",
          "tooManySubstitutions",
        ),
        kind: "tooManySubstitutions",
      };
    let xe = ke ? ozr(e, { unparsedBodyOverruns: !0 }) : [];
    if (xe === null) return C8();
    let Pe = xe ?? [],
      Be = Pe.some((Qt) => sb(Qt.trim())),
      Fe = O5e(e.text) || E.some((Qt) => O5e(Qt)) || Be,
      Ke = Fe
        ? [
            ...[e.text, ...E]
              .flatMap((Qt) => {
                try {
                  return Sy(Qt);
                } catch (error) {
                  if (error instanceof NativeBashSecurityUnsupported)
                    throw error;
                  return [Qt];
                }
              })
              .map((Qt) => Qt.trim())
              .filter((Qt) => sb(Qt))
              .map((Qt) => ({ text: Qt, cd: !0, names: [], exports: !1 })),
            ...(Be ? [Nbn] : []),
          ]
        : [],
      Qe = S8() && iM().enabled && y.depth === 0 && !D5e(Ks, y.input),
      ot: Nested | undefined,
      it: Nested[] = [];
    for (let Qt of [e.text, ...E]) {
      let nn: string[];
      try {
        nn = Sy(Qt);
      } catch (error) {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
        nn = [Qt];
      }
      if (Qt === e.text && Pe.length > 0) nn = D([...nn, ...Pe]);
      for (let yn of nn) {
        let Cn = yn.trim();
        if (
          (Cn.startsWith("{") && /;?\s*\}$/.test(Cn)) ||
          (Cn.startsWith("(") && Cn.endsWith(")"))
        )
          Cn = Cn.slice(1)
            .replace(/;?\s*[)}]$/, "")
            .trim();
        let vn = qlt(Cn, !1, a ?? e.text, h, k, _e);
        if (vn !== null)
          return v8(ot, { result: LOe(vn, !0), kind: "emptyVariable" });
        let An = Cn.replace(/`[^`]*`/g, "__CMDSUB__");
        for (let Ao = "", _o = 0; Ao !== An && _o < 16; _o++) {
          Ao = An;
          An = An.replace(/\$\([^()]*\)/g, "__CMDSUB__");
        }
        for (let Ao = "", _o = 0; Ao !== An && _o < 16; _o++) {
          Ao = An;
          An = An.replace(
            /\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?!$-]):?[-=+?]"?((?:__CMDSUB__[/*.]*)+)"?\}/g,
            "$1",
          );
        }
        let io = An !== Cn,
          Qn = Qe && Cn.includes("${HOME") ? await V1(Cn) : null;
        if (Qn !== null && Qn !== semantic.parseAbort)
          it.push(...(await slt(Qn, n, r)));
        let so = await oR(An, { readsDivergentShapes: !0 });
        if (so.kind === "simple")
          for (let Ao of so.commands) {
            let _o = Ao.argv.slice();
            if (_o[0] !== void 0) _o[0] = _o[0].replace(/^.*[\\/]/, "");
            let Mo = x5e(l1(_o)),
              co = sD(Mo[0]);
            if (co !== "rm" && co !== "rmdir") continue;
            let ao = Mo.slice(1),
              Hn = o2(co, ao, n, r, Fe),
              jn = rlt(Hn) ? Hn : void 0,
              Ln: Nested["kind"] = "literalTarget";
            if (Hn.behavior === "ask" && jn === void 0)
              return v8(ot, { result: Hn, kind: "literalTarget" });
            if (
              io &&
              ao.some((Go) =>
                /.(?:__CMDSUB__(?:(?!\.\.)[/*.])*)+(?:\/\.\.)*\/*$/.test(Go),
              )
            ) {
              let Go = ao.indexOf("--"),
                Qr = Go === -1 ? ao.length : Go,
                ws = ao;
              for (let Ko of [!0, !1]) {
                let go = ao.map((Er, Rr) =>
                    Ko && Rr < Qr && Er.startsWith("-") && !Er.includes("/")
                      ? Er
                      : Er.replace(
                          /(.)(?:__CMDSUB__(?:(?!\.\.)[/*.])*)+((?:\/\.\.)*)\/*$/,
                          "$1$2",
                        ),
                  ),
                  Oo = go.every((Er, Rr) => Er === ws[Rr]);
                if (((ws = go), Oo)) continue;
                let jo = xbn(o2(co, go, n, r, Fe));
                if (jo.behavior === "ask" && !rlt(jo))
                  return v8(ot, { result: jo, kind: "emptyExpansion" });
                if (jo.behavior === "ask" && jn === void 0) {
                  jn = jo;
                  Ln = "emptyExpansion";
                }
              }
            }
            let oo = ao.includes("--") ? ao.slice(0, ao.indexOf("--")) : ao;
            if (
              io &&
              co === "rm" &&
              oo.some(
                (Go) => Go.startsWith("--r") || /^-[a-zA-Z]*[rR]/.test(Go),
              ) &&
              ao.some((Go) => /^(?:__CMDSUB__[/*.]*)+$/.test(Go))
            ) {
              let Go = dn("tengu_iridescent_boot", !0);
              if (
                !s.CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT &&
                !(Go.value === !1 && Go.source === "payload")
              )
                return v8(ot, {
                  result: nb(
                    co,
                    "Dangerous rm operation detected: the target is the output of a command substitution (`$(...)` or backticks) and cannot be checked before the command runs. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nRun the substitution on its own first, then remove the literal paths it prints.",
                    "on statically-unresolvable target: command substitution output",
                    "wholeSubstitution",
                  ),
                  kind: "wholeSubstitution",
                });
              Qv("tengu_bash_dangerous_rm_too_complex", {
                kind: f("wholeSubstitution"),
              });
            }
            if (jn !== void 0) ot ??= { result: jn, kind: Ln };
          }
      }
    }
    for (let Qt of [e.text, ...E]) {
      let nn = await JOe(Qt, y, Qt === e.text ? [] : Ke);
      if (nn !== null) return v8(ot, { result: nn, kind: "inlineShellScript" });
    }
    let bt = Qe ? [e] : [],
      vt: Node[] = [],
      Ct: string[] = [],
      Pt: [number, number][] = [],
      Dt: Node[] = [],
      Lt = 0,
      $t = !1;
    for (let Qt of Qe ? V : []) {
      let nn = await V1(Qt);
      if (nn !== null && nn !== semantic.parseAbort) bt.push(nn);
      else $t ||= Xde(Qt) || P8(Qt);
    }
    let gn = !1;
    for (let Qt = bt.pop(); Qt !== void 0; Qt = bt.pop()) {
      {
        bt.push(...Qt.children);
        gn ||= Qt === e;
      }
      let nn = ot === void 0 ? MOr(Qt) : void 0;
      if (nn !== void 0) {
        if ((Ct.unshift(nn.whole), (Lt += nn.whole.length), gn))
          Pt.push(...nn.heads);
      }
      if (Qt.type === "command") {
        if ((Dt.push(Qt), (Lt += Qt.text.length), Qt.text.includes("${HOME")))
          vt.push(Qt);
      }
    }
    if (Lt > POr && vt.length + Ct.length > 0) {
      $t = !0;
      vt.length = 0;
      Ct.length = 0;
      Pt.length = 0;
    }
    for (let Qt of vt) it.push(...(await slt(Qt, n, r)));
    let Ht = Ct.length > 0 && (Fe || Dt.some((Qt) => sb(Qt.text)));
    for (let Qt of Ct) {
      let nn = await V1(Qt),
        yn = nn === semantic.parseAbort ? void 0 : nn?.children[0];
      if (yn !== void 0) it.push(...(await slt(yn, n, r, !0, Ht)));
      else $t ||= Xde(Qt) || P8(Qt);
    }
    if ($t) it.push(C8());
    if (Pt.length > 0 && !y.budget.rereading && Xde(e.text)) {
      let Qt = Buffer.from(e.text);
      for (let [Cn, vn] of Pt)
        Qt.fill(" ", Cn - e.startIndex, vn - e.startIndex);
      let nn = Qt.toString(),
        yn: (boolean[] | undefined)[] = [void 0];
      for (let Cn of yn) {
        if ((await V1(nn)) === semantic.parseAbort) {
          it.push(C8());
          break;
        }
        let { result: vn, outOfTime: An } = await M5r(() =>
          zOe(!1, () =>
            N6(() =>
              nIe(
                { ...y.input, command: nn },
                y.context,
                void 0,
                void 0,
                {
                  depth: y.depth,
                  budget: {
                    left: Mbn,
                    chars: Obn,
                    judged: new Map(),
                    asked: new Map(),
                    command: y.budget.command,
                    rereading: !0,
                  },
                },
                Cn,
                Cn === void 0
                  ? (Qn, so) => {
                      yn.push(...F5r(Qn, so).readings);
                    }
                  : void 0,
              ),
            ),
          ),
        );
        if (vn === void 0 || An) {
          it.push(C8());
          break;
        }
        let io =
          vn.behavior === "ask"
            ? Sa(
                vn.decisionReason,
                (Qn) => Qn.circuitBreaker === "dangerousRemoval",
              )
            : void 0;
        if (io !== void 0) {
          it.push({
            result:
              vn.decisionReason === io
                ? vn
                : {
                    behavior: "ask",
                    decisionReason: io,
                    message: El(Ks.name, io),
                  },
            kind: "literalTarget",
          });
          break;
        }
        if (vn.behavior === "deny" || (vn.behavior === "ask" && bk(vn))) {
          it.push({
            result: vn.behavior === "ask" ? { ...vn, suggestions: [] } : vn,
            kind: "literalTarget",
          });
          break;
        }
      }
    }
    for (let Qt of it) {
      if (!rlt(Qt.result)) return v8(ot, Qt);
      ot ??= Qt;
    }
    return ot ?? null;
  }

  async function Pbn(...e: Parameters<typeof OOr>): Promise<Nested | null> {
    try {
      return await OOr(...e);
    } catch (n) {
      if (n instanceof NativeBashSecurityUnsupported) throw n;
      if (Uti(n) || (e[5].context.abortController.signal.aborted && $e(n)))
        throw n;
      try {
        i(n);
      } catch (error) {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
      }
      return C8();
    }
  }

  function withPolicyScope<T>(
    permission: Policy,
    cwd: string,
    run: () => T,
    receipts: Provenance[] = [],
  ) {
    return frames.run(
      { scope: { policyId: permission.scope.policyId, cwd }, receipts },
      () => recursion.withPolicyScope(permission, cwd, run, receipts),
    );
  }
  return {
    recursion,
    literal,
    host,
    native: { Rbn, qlt, OOr, Pbn },
    withPolicyScope,
  };
}
