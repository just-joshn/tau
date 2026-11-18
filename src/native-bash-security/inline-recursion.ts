import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeBashSyntaxNode as Node } from "../native-bash-parser.js";
import type { NativeBashSemanticCommand as Command } from "../native-bash-semantics.js";
import type { createNativeBashSecurityRecursiveSyntax } from "./recursive-syntax.js";
import type { createNativeBashSecurityRemovalShapes } from "./removal-shapes.js";
import type {
  NativeBashSecurityInlineContext as InlineContext,
  NativeBashSecurityContext as Context,
  NativeBashSecurityRemovalHistory as History,
  NativeBashSecurityRecursiveCheck as RecursiveCheck,
} from "./security-recursion-types.js";
import {
  NativeBashSecurityUnsupported,
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityFact as Fact,
} from "./security-types.js";

export interface NativeBashSecurityInlineRecursionHost {
  currentCwd?: (scope: Scope) => Fact<string>;
  /** Fact proves this live read at the requesting scope; value.scope retains the actual new generation. */
  livePolicy?: (context: Context, scope: Scope) => Fact<Policy>;
  inlineShellRemovalDisabled?: (scope: Scope) => Fact<boolean>;
  /** Native Bm/hn: scope the actual getter/provider context to NFC cwd without changing process cwd. */
  withCwd?: <T>(cwd: string, run: () => T, scope: Scope) => Fact<T>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native inline-recursion invariant");
  return value;
}
export function createNativeBashSecurityInlineRecursion(
  syntax: ReturnType<typeof createNativeBashSecurityRecursiveSyntax>,
  shapes: ReturnType<typeof createNativeBashSecurityRemovalShapes>,
  host: NativeBashSecurityInlineRecursionHost,
  check: RecursiveCheck,
) {
  const policy = syntax.policy;
  if (shapes.observations.policy !== policy)
    throw new Error("Native Bash process owners must be shared");
  const { semantic, preparation } = syntax;
  const path = policy.pathOwner;
  const frames = new AsyncLocalStorage<{
    policy: Policy;
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(receipt: Fact<T>) =>
    readNativeBashSecurityFact(receipt, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const ue = () => use(need(host.currentCwd, "cwd.current")(frame().scope));
  const ee = (context: Context) =>
    use(need(host.livePolicy, "policy.live")(context, frame().scope));
  const Bm = <T>(cwd: string, run: () => T): T => {
    const current = frame();
    const normalized = cwd.normalize("NFC");
    return use(
      need(host.withCwd, "cwd.Bm")(
        normalized,
        () =>
          withPolicyScope(current.policy, normalized, run, current.receipts)
            .result,
        current.scope,
      ),
    );
  };
  const { S8, l1 } = path.native;
  const { KI, k6e, dLe, F5r, SG } = semantic.native;
  const { FOr, u2, P5e, P8 } = shapes.inline.native;
  const { Vlt, yx, Ibn } = shapes.inline.constants;
  const { ZOe, Dbn, XOe, Ylt, XK, QOe, BOr, WOr } = shapes.native;
  const { Lbn, $Or } = syntax.native;
  const { Sa } = shapes.outcomes;
  const { N6, kOe, zOe } = shapes.observations.native;
  const x5e = preparation.stripWrapperArgv;
  const Sy = preparation.projection.splitCommands;
  const V1 = semantic.parse;
  const oR = semantic.analyze;
  const KMa = semantic.isCutShort;
  const rmt = () => preparation.features.appendEnvironmentNeedsReview();
  const nIe = check;
  const El = policy.native.El;
  const Ks = { name: "Bash" };
  const dat = 2;
  const DOr = 8;
  const UOr = 8;
  const Rlt = "*";
  const Nbn: History = {
    text: `cd "${yx}"`,
    cd: true,
    names: [],
    exports: false,
  };
  const Abn = " (removal)";
  const D = <T>(values: T[]) => [...new Set(values)];
  const U = <T>(values: T[], predicate: (value: T) => unknown) =>
    values.reduce((n, value) => n + +!!predicate(value), 0);
  async function HOr(
    e: string,
    n: History,
    r: string[],
    a: Context,
  ): Promise<string | undefined> {
    if (
      a.forRemoteExecution === !0 ||
      r.some(
        (E) =>
          /^(?:-[A-Za-z]*[CDiR]|--(?:chdir|login|chroot))/.test(E) ||
          /^(?:unshare|nsenter|chroot|pkexec|runuser|su)$/.test(KI(E)),
      )
    )
      return;
    let h: string[];
    try {
      h = Sy(e);
    } catch (error) {
      if (error instanceof NativeBashSecurityUnsupported) throw error;
      return;
    }
    let y = await Lbn(e, h.length);
    if (h[0]?.trim() !== n.text || y === null || y.some((E) => E.type !== "&&"))
      return;
    let k = await oR(n.text);
    return k.kind === "simple" && k.commands.length === 1
      ? (liveWlt(k.commands[0], ue(), ee(a)) ?? void 0)
      : void 0;
  }

  async function Jwn(
    e: Command,
    n: History[],
    r: InlineContext,
    a: boolean,
  ): Promise<Decision | null> {
    let { input: h, context: y, depth: k, divergentShapes: E, budget: N } = r,
      V = e.argv.slice();
    if (V[0] !== void 0) V[0] = KI(V[0]);
    let oe = x5e(l1(V)),
      re = FOr(oe);
    if (
      re === void 0 ||
      !(Dbn(re.judged ?? re.script) || re.script.includes("$'"))
    )
      return null;
    let _e = V.slice(0, V.length - oe.length),
      ke = (Lt: string[]) =>
        Lt.flatMap(($t) => {
          let [, gn, Ht = ""] = /^([A-Za-z_]\w*)=(.*)$/s.exec($t) ?? [];
          return gn === void 0
            ? []
            : [`export ${gn}=${/^[\w./@%+=:,-]*$/.test(Ht) ? Ht : yx}`];
        }),
      Re: { word: string; appends: boolean }[] = [];
    for (let { name: Lt, value: $t, isAppend: gn } of e.envVars) {
      let Ht = gn === !0 && rmt(),
        Qt = Ht
          ? Re.findLast(({ word: nn }) => nn.startsWith(`${Lt}=`))
          : void 0;
      if (Qt === void 0) Re.push({ word: `${Lt}=${$t}`, appends: Ht });
      else Qt.word += $t;
    }
    let xe = Re.flatMap(({ word: Lt, appends: $t }) =>
        ke([Lt]).map((gn) => ($t ? gn.replace("=", "+=") : gn)),
      ),
      Pe = ke(_e),
      Be = new Set(
        [...re.script.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((Lt) =>
          required(Lt[1]),
        ),
      ),
      Fe = n.filter((Lt) => Lt.cd),
      Ke =
        Fe.length === 1 && !a
          ? await HOr(h.command, required(Fe[0]), _e, y)
          : void 0,
      Qe =
        Ke !== void 0
          ? []
          : Fe.length > 1
            ? [`cd "${yx}"`]
            : Fe.map((Lt) => Lt.text),
      ot = n.filter((Lt) =>
        Lt.names.some(($t) => Be.has($t) || ($t === Rlt && Be.size > 0)),
      ),
      it = new Set(ot.filter((Lt) => Lt.exports).flatMap((Lt) => Lt.names)),
      bt = [{ before: [...Qe, ...ot.map((Lt) => Lt.text)], own: !0, from: 0 }];
    if (ot.some((Lt) => !Lt.exports && Lt.names.some(($t) => !it.has($t))))
      bt.push({
        before: [...Qe, ...ot.filter((Lt) => Lt.exports).map((Lt) => Lt.text)],
        own: !0,
        from: 0,
      });
    let vt = _e.reduce((Lt, $t, gn) => {
      let Ht = [];
      for (let yn of _e.slice(gn + 1)) {
        if (!yn.startsWith("-")) break;
        Ht.push(yn);
      }
      let Qt = _e.slice(gn + 1),
        nn = KI($t);
      return (/^(?:sudo|doas)$/.test(nn) &&
        !Ht.some((yn) => /^(?:-\w*E\w*|--preserve-env)$/.test(yn))) ||
        nn === "pkexec" ||
        (nn === "exec" && Qt.some((yn) => /^-\w*c/.test(yn))) ||
        (nn === "env" &&
          Qt.some((yn) => /^(?:-\w*[iu]\w*|-|--i\S*|--u\S*)$/.test(yn)))
        ? gn
        : Lt;
    }, -1);
    if (
      (ot.length > 0 || xe.length > 0 || Pe.length > 0) &&
      (vt !== -1 ||
        ot.some((Lt) =>
          /^(?:export(?:\s+-\w+)*\s+-\w*n\w*|(?:declare|typeset)(?:\s+[-+]\w+)*\s+\+\w*x\w*)(?:\s|$)/.test(
            Lt.text,
          ),
        ))
    )
      bt.push({ before: Qe, own: vt === -1, from: vt + 1 });
    if (a && (Qe.length > 0 || ot.length > 0))
      bt.push({ before: [], own: !0, from: 0 });
    let Ct = ZOe(h.command) ? " && " : " ; ",
      Pt =
        re.judged === void 0 ||
        (re.homeWritten &&
          ([...xe, ...Pe].some((Lt) => /^export HOME\+?=/.test(Lt)) ||
            n.some((Lt) => Lt.names.includes("HOME")))) ||
        ot.some((Lt) => Lt.unread) ||
        k >= dat ||
        re.judged.length > Ibn ||
        U(u2(re.judged).flat(), (Lt) =>
          /^(?:cd|pushd|popd|chdir)$/.test(KI(Lt)),
        ) > DOr,
      Dt = !1;
    for (let { before: Lt, own: $t, from: gn } of Pt ? [] : bt) {
      let Ht = [...Lt, ...($t ? xe : []), ...ke(_e.slice(gn)), re.judged]
          .join(Ct)
          .replace(
            /__CMDSUB_OUTPUT__|__CMDSUB__|__INLINE_SHELL_VALUE__/g,
            (Cn) => (Cn === "__CMDSUB__" ? "$(__CMDSUB__)" : "${" + yx + "}"),
          ),
        Qt = `${k}
${E}
${Ke ?? ue()}
${Ht}`,
        nn = N.judged.get(Qt);
      if (nn === void 0) {
        if (
          N.left <= 0 ||
          N.chars < Ht.length ||
          (await V1(Ht)) === semantic.parseAbort
        ) {
          Pt = !0;
          break;
        }
        {
          N.left--;
          N.chars -= Ht.length;
        }
        let Cn = () =>
          N6(async () => {
            let vn: { names?: number; operands?: boolean[] | undefined } = {},
              An = await V1(Ht),
              io = await nIe(
                { ...h, command: Ht },
                y,
                void 0,
                void 0,
                { depth: k + 1, budget: N },
                void 0,
                (Ao, _o) => {
                  {
                    vn.names = Ao;
                    vn.operands = _o;
                  }
                },
              ),
              { readings: Qn, exhaustive: so } =
                vn.names === void 0
                  ? { readings: [], exhaustive: !0 }
                  : F5r(vn.names, vn.operands);
            Pt ||= !so;
            for (let Ao of Qn) {
              if (
                Sa(
                  io.decisionReason,
                  (Mo) => Mo.circuitBreaker === "dangerousRemoval",
                ) !== void 0
              )
                break;
              if (N.left <= 0) {
                Pt = !0;
                break;
              }
              N.left--;
              let _o = await nIe(
                { ...h, command: Ht },
                y,
                void 0,
                void 0,
                { depth: k + 1, budget: N },
                Ao,
              );
              if (
                _o.behavior === "deny" ||
                Sa(
                  _o.decisionReason,
                  (Mo) => Mo.circuitBreaker === "dangerousRemoval",
                ) !== void 0
              )
                io = _o;
              Pt ||=
                WOr(_o) !== void 0 ||
                (An !== null &&
                  An !== semantic.parseAbort &&
                  SG(Ht, An, { declarationPrefix: Ao }).kind === "too-complex");
            }
            return io;
          });
        {
          nn = await kOe(() =>
            zOe(!1, () => (Ke === void 0 ? Cn() : Bm(Ke, Cn))),
          );
          N.judged.set(Qt, nn);
        }
      }
      let yn =
        nn.behavior === "ask" ||
        (nn.decisionReason?.type === "subcommandResults" &&
          [...nn.decisionReason.reasons.keys()].some((Cn) => Cn.endsWith(Abn)))
          ? Sa(
              nn.decisionReason,
              (Cn) => Cn.circuitBreaker === "dangerousRemoval",
            )
          : void 0;
      if (yn !== void 0) {
        if (k === 0) XK("inline_shell_script");
        return BOr(
          nn.decisionReason === yn
            ? nn
            : { behavior: "ask", decisionReason: yn, message: El(Ks.name, yn) },
        );
      }
      {
        Dt ||= nn.behavior === "deny";
        Pt ||= KMa();
      }
    }
    return P8(re.judged ?? re.script) &&
      ((Dt && !Pt) || (Pt && XOe(N.command, re.judged ?? re.script)))
      ? QOe(Dt && !Pt, k)
      : null;
  }

  async function xlt(
    e: string,
    n: InlineContext,
    r: History[],
    a: Command[],
    h: boolean,
    y = false,
    k = 0,
    E = false,
  ): Promise<Decision | null> {
    let N: string[];
    try {
      N = Sy(e);
    } catch (error) {
      if (error instanceof NativeBashSecurityUnsupported) throw error;
      N = [e];
    }
    let V = e
        .replace(/\\[\s\S]|'[^']*'|"(?:[^"\\]|\\.)*"/g, "")
        .replace(/[<>]&|&>/g, ">"),
      oe =
        /(?:^|[;|&\n]\s*)(?:export|unset|declare|typeset|readonly|local|cd|pushd|popd|[A-Za-z_]\w*\+?=)[^;|&\n]*&(?!&)/.test(
          V,
        ),
      re = await Lbn(e, N.length),
      _e = !1,
      ke = (Qe: number) => {
        if (y || oe || _e) return !0;
        if (re === null) return /\|\||&&/.test(V) && !ZOe(e);
        let ot = re.filter((it) => it.after < Qe).map((it) => it.type);
        return (
          ot.some((it) => it === "&&" || it === "||") &&
          ot.some((it) => it !== "&&")
        );
      },
      Re = E ? r : [...r],
      xe = (Qe: string) => {
        if (
          [...u2(Qe), ...u2(Qe, !1)].some((ot) =>
            ot.some(
              (it, bt) =>
                (it.startsWith("$") ||
                  /^(?:cd|pushd|popd|chdir)$/.test(KI(it))) &&
                ot
                  .slice(0, bt)
                  .every((vt) => Vlt.has(KI(vt)) || vt.startsWith("-")),
            ),
          ) ||
          (/\b(?:cd|pushd|popd|chdir)\b/.test(Qe) &&
            /\$\(|`|\$\{?IFS\b/.test(Qe))
        )
          Re.push(Nbn);
        Re.push({
          text: Qe,
          cd: !1,
          names:
            /\beval\b|\bprintf\b[^;&|\n]*\s-v|\b(?:read|declare|typeset|local|export|readonly|mapfile|readarray|getopts)\b[^;&|\n]*\$|\b(?:declare|typeset|local)\b[^;&|\n]*\s-\w*n|\$\{!?[A-Za-z_]\w*:{0,2}=|\$\(\(/.test(
              Qe,
            ) ||
            /\bprintf\b[^;&|\n]*\s-v|\b(?:unset|export|declare|typeset|local|readonly)\b[^;&|\n]*\$/.test(
              Qe.replace(/["'\\]/g, ""),
            )
              ? [Rlt]
              : D(
                  Qe.replace(/\$\{?[A-Za-z_]\w*/g, " ").match(
                    /[A-Za-z_]\w*/g,
                  ) ?? [],
                ),
          exports: !1,
          unread: !0,
        });
      },
      Pe = (Qe: number) =>
        re === null
          ? /[|&]/.test(V.replace(/&&|\|\|/g, ""))
          : re.some(
              (ot) =>
                (ot.after === Qe - 1 && /^\|&?$/.test(ot.type)) ||
                (ot.after === Qe && /^(?:\|&?|&)$/.test(ot.type)),
            ),
      Be = 0,
      Fe = new Set();
    for (let [Qe, ot] of N.entries()) {
      let it = ot.trim(),
        bt = ke(Qe),
        vt = !Pe(Qe),
        Ct = it.startsWith("{") && /;?\s*\}$/.test(it);
      if (Ct || (it.startsWith("(") && it.endsWith(")"))) {
        let vn = it.slice(1).replace(/;?\s*[)}]$/, "");
        if (k >= UOr) {
          if ((P8(vn) || Dbn(vn)) && XOe(n.budget.command, it))
            return QOe(!1, n.depth);
          xe(it);
          continue;
        }
        let An = await xlt(vn, n, Re, [], h, bt, k + 1, Ct && vt);
        if (An !== null) return An;
        if (Ct) {
          xe(it);
          let io = vn.replace(/\\[\s\S]|'[^']*'|"(?:[^"\\]|\\.)*"/g, "");
          _e ||=
            (/\|\||&&/.test(io) && !ZOe(vn)) ||
            /&(?!&)/.test(io.replace(/&&|[<>]&|&>/g, ""));
        }
        continue;
      }
      let Pt = u2(it).flat(),
        Dt = Pt.some((vn) => k6e.has(P5e(vn)));
      if (
        !Dt &&
        !/^(?:[A-Za-z_]\w*\+?=|(?:cd|pushd|popd|chdir|export|unset|declare|typeset|readonly|local)\b)/.test(
          it,
        )
      ) {
        xe(it);
        continue;
      }
      let Lt = await V1(it);
      if (Lt === null || Lt === semantic.parseAbort) {
        if (
          Dt &&
          Pt.some((vn) => dLe(vn, "c")) &&
          P8(it) &&
          XOe(n.budget.command, it)
        )
          return QOe(!1, n.depth);
        xe(it);
        continue;
      }
      let $t: [number, number, string][] = [],
        gn = !1,
        Ht = (vn: string | undefined) => {
          let An = Re.filter(
            (Qn) => vn && (Qn.names.includes(vn) || Qn.names.includes(Rlt)),
          );
          gn ||= bt && An.length > 0;
          let io = "";
          for (let Qn of An.reverse()) {
            if (Qn.unread) return yx;
            if (/^unset(?:\s|$)/.test(Qn.text)) return io;
            let so = new RegExp(
              `(?:^|\\s)${vn}(\\+?)=(?:"([^"$\`\\\\]*)"|'([^']*)'|([^\\s"'$\`\\\\]*))(?:\\s|$)`,
            ).exec(Qn.text);
            if (so !== null) {
              let Ao = (so[2] ?? so[3] ?? so[4] ?? "") + io;
              if (!/^[\w./@%+=:,-]*$/.test(Ao)) return yx;
              if (so[1] !== "+") return Ao;
              io = Ao;
              continue;
            }
            if (new RegExp(`(?:^|\\s)${vn}\\+?=`).test(Qn.text)) return yx;
          }
          return io === "" ? yx : io;
        },
        Qt = (vn: Node): void => {
          if (
            /^(?:simple_expansion|expansion|arithmetic_expansion)$/.test(
              vn.type,
            )
          )
            $t.push([
              vn.startIndex,
              vn.endIndex,
              Ht(/^\$\{?([A-Za-z_]\w*)\}?$/.exec(vn.text)?.[1]),
            ]);
          else if (/^(?:command|process)_substitution$/.test(vn.type))
            $t.push([vn.startIndex, vn.endIndex, "__CMDSUB__"]);
          else {
            gn ||= vn.type === "ansi_c_string";
            for (let An of vn.children) Qt(An);
          }
        };
      Qt(Lt);
      let nn = Buffer.from(it);
      for (let [vn, An, io] of $t.reverse())
        nn = Buffer.concat([
          nn.subarray(0, vn),
          Buffer.from(io),
          nn.subarray(An),
        ]);
      let yn = await oR(nn.toString(), { readsDivergentShapes: h });
      if (yn.kind !== "simple" || gn) {
        if (
          Dt &&
          Pt.some((vn) => dLe(vn, "c")) &&
          ((P8(
            it.replace(
              /\\[ntr]/g,
              `
`,
            ),
          ) &&
            XOe(n.budget.command, it, nn.toString())) ||
            Ylt(it))
        )
          return QOe(!1, n.depth);
        xe(it);
        continue;
      }
      if (
        /^(?:[A-Za-z_]\w*\+?=(?:'[^']*'|"[^"]*"|[^\s'"])*\s+)*(?:declare|typeset|local)\b[^;&|\n]*\s-\w*n/.test(
          it,
        )
      ) {
        xe(it);
        continue;
      }
      let Cn = $Or(it, yn.commands);
      if (Cn?.names.some((vn) => /__INLINE_SHELL_VALUE__|__CMDSUB/.test(vn))) {
        xe(it);
        continue;
      }
      if (Cn !== void 0) {
        if (vt) Re.push(Cn);
        else xe(it);
        continue;
      }
      for (let vn of yn.commands) {
        let An = a.findIndex(
          (so, Ao) =>
            Ao >= Be &&
            so.argv.length === vn.argv.length &&
            vn.argv.every(
              (_o, Mo) =>
                _o === so.argv[Mo] ||
                /__INLINE_SHELL_VALUE__|__CMDSUB__/.test(_o),
            ),
        );
        if (An !== -1) {
          Be = An + 1;
          Fe.add(An);
        }
        let io = a[An],
          Qn = await Jwn(
            io === void 0
              ? vn
              : {
                  ...io,
                  argv: io.argv.map((so, Ao) =>
                    required(vn.argv[Ao]).includes("__CMDSUB__") ||
                    (required(vn.argv[Ao]).includes(yx) &&
                      Re.some((_o) => _o.unread))
                      ? required(vn.argv[Ao])
                      : so,
                  ),
                },
            Re,
            n,
            bt,
          );
        if (Qn !== null) return Qn;
      }
      xe(
        /\b(?:eval|trap|source)\b|(?:^|\s)\.\s/.test(it)
          ? it
          : it.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''"),
      );
    }
    let Ke = ke(N.length);
    for (let [Qe, ot] of a.entries()) {
      let it = Fe.has(Qe) ? null : await Jwn(ot, Re, n, Ke);
      if (it !== null) return it;
    }
    return null;
  }

  async function JOe(
    e: string,
    n: InlineContext,
    r: History[] = [],
    a: Command[] = [],
  ): Promise<Decision | null> {
    if (
      use(
        need(
          host.inlineShellRemovalDisabled,
          "environment.inlineShellRemovalDisabled",
        )(frame().scope),
      ) ||
      !S8()
    )
      return null;
    let h = `${n.depth}
${n.divergentShapes}
${String(n.declarationPrefix)}
${ue()}
${r.map((k) => k.text).join(`
`)}
${e}`;
    if (n.budget.asked.has(h)) return n.budget.asked.get(h) ?? null;
    let y =
      (await xlt(e, n, r, a, !1)) ??
      (/\b(?:export|declare|typeset|readonly|local)\b/.test(e)
        ? await xlt(e, n, r, a, !0)
        : null);
    return (n.budget.asked.set(h, y), y);
  }

  function liveWlt(
    command: Command | undefined,
    cwd: string,
    currentPolicy: Policy,
  ): string | null {
    return policy.withPolicyScope(
      currentPolicy,
      cwd,
      () => policy.native.Wlt(command, cwd, currentPolicy),
      frame().receipts,
    ).result;
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
        shapes.withPolicyScope(
          permission,
          cwd,
          () => syntax.withPolicyScope(permission, cwd, run, receipts).result,
          receipts,
        ),
    );
  }
  return {
    syntax,
    shapes,
    host,
    constants: { Nbn },
    native: { HOr, Jwn, xlt, JOe },
    withPolicyScope,
  };
}
