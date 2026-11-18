import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type {
  NativeBashSemantics,
  NativeBashSemanticCommand as Command,
} from "../native-bash-semantics.js";
import type { NativeBashCommandPreparation } from "../native-bash-command-preparation.js";
import type { createNativeBashSecurityGitStructure } from "./git-structure.js";
import { createNativeBashSecurityShellDocument } from "./shell-document.js";
import type { createNativeBashSecurityOutcomeControl } from "./outcome-control.js";
import {
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityReason as Reason,
  type NativeBashSecurityInput as Input,
} from "./security-types.js";
type SafetyReason = Extract<Reason, { type: "safetyCheck" }>;
type Check = (input: Input) => Decision | Promise<Decision>;
interface Predicates {
  isNormalizedCdCommand: (command: string) => boolean;
  isNormalizedGitCommand: (command: string) => boolean;
  shouldUseSandbox?: (input: Input) => boolean;
}
export interface NativeBashSecurityPipelineHost {
  duplicatePipeReasons?: (scope: Scope) => Fact<boolean>;
  currentCwd?: (scope: Scope) => Fact<string>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing native pipeline invariant");
  return value;
}
export function createNativeBashSecurityPipelineControl(
  semantic: NativeBashSemantics,
  preparation: NativeBashCommandPreparation,
  git: ReturnType<typeof createNativeBashSecurityGitStructure>,
  outcomes: ReturnType<typeof createNativeBashSecurityOutcomeControl>,
  El: (tool: string, reason?: Reason) => string,
  host: NativeBashSecurityPipelineHost,
) {
  if (git.semantic !== semantic || git.preparation !== preparation)
    throw new Error("Native Bash process owners must be shared");
  const document = createNativeBashSecurityShellDocument(semantic);
  type Document = NonNullable<Awaited<ReturnType<typeof document.parse>>>;
  type Tree = Awaited<ReturnType<typeof semantic.parse>> | undefined;
  const frames = new AsyncLocalStorage<{
    policy: Policy;
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(fact: Fact<T>) =>
    readNativeBashSecurityFact(fact, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const Vde = () =>
    use(
      need(
        host.duplicatePipeReasons,
        "features.tengu_moonlit_kettle",
      )(frame().scope),
    );
  const ue = () => use(need(host.currentCwd, "cwd.current")(frame().scope));
  const $b: typeof semantic.parseAbort = semantic.parseAbort;
  const $de = document.fromTree;
  const Hrt = document;
  const Ks = { name: "Bash" };
  const wEe = "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)";
  const { OEt, YOe, Az, bF, Sa } = outcomes;
  const { splitCommands: Sy } = preparation.projection;
  const DY = () => preparation.features.refuseEnvironment();
  const qOe = (commands: (Command | undefined)[], cwd: string) =>
    git.withPolicyScope(
      frame().policy,
      cwd,
      () => git.native.qOe(commands, cwd),
      frame().receipts,
    ).result;
  const zde = (text: string) => git.native.zde(text);
  const oR = semantic.analyze;
  // Source Tn sees only newly constructed argv arrays and the semantic producer's
  // plain {name,value,isAppend?} environment records here. No numeric or exotic values.
  const Tn = isDeepStrictEqual;
  function a2(e: Iterable<Decision>, n = false): Decision | undefined {
    let r = (a: SafetyReason) => Az(a) && (!n || !bF(a));
    for (let a of e)
      if (a.behavior === "ask" && Sa(a.decisionReason, r) !== void 0) return a;
    return;
  }

  function wwn({ decisionReason: e }: Decision): boolean {
    return e?.type === "subcommandResults"
      ? [...e.reasons.values()].some(wwn)
      : e?.type === "other" && e.reason === wEe;
  }

  async function MMr(e: string[], n: Command[]): Promise<boolean> {
    let r = (y: Command[]) =>
        y
          .filter(({ envVars: k, argv: E }) => k.length + E.length > 0)
          .map(({ envVars: k, argv: E }) => [k, E]),
      a = await Promise.all(e.map((y) => oR(y, { readsDivergentShapes: !0 }))),
      h = a.filter((y) => y.kind === "simple");
    return (
      h.length === a.length && Tn(r(h.flatMap(({ commands: y }) => y)), r(n))
    );
  }

  async function xMr(e: string): Promise<string> {
    if (!e.includes(">")) return e;
    return (await Hrt.parse(e))?.withoutOutputRedirections() ?? e;
  }

  async function AMr(
    e: Input,
    n: string[],
    r: string[],
    a: Check,
    h: Predicates,
    y: Command[] | undefined,
    k: ((commands: string[]) => boolean | Promise<boolean>) | undefined,
    E: (() => Decision | undefined) | undefined,
  ): Promise<Decision> {
    let N = new Map<string, Decision>(),
      V: [string, Decision][] = [],
      oe = Vde();
    for (let Be = 0; Be < n.length; Be++) {
      let Fe = required(n[Be]).trim();
      if (!Fe) {
        let it = required(r[Be]),
          bt = await a({ ...e, command: it }),
          vt: Decision =
            bt.behavior === "passthrough"
              ? {
                  behavior: "allow",
                  updatedInput: { ...e, command: it },
                  decisionReason: {
                    type: "other",
                    reason:
                      "Bare output redirection with no command; path layer approved",
                  },
                }
              : bt;
        {
          N.set(it, vt);
          V.push([it, vt]);
        }
        continue;
      }
      let Ke = await a({ ...e, command: Fe });
      N.set(Fe, Ke);
      let Qe = required(r[Be]).trim(),
        ot = Ke;
      if (
        oe &&
        Qe !== Fe &&
        Ke.behavior === "allow" &&
        OEt(Ke.decisionReason)
      ) {
        let it = await a({ ...e, command: Qe });
        ot =
          it.behavior === "allow"
            ? it
            : {
                ...Ke,
                decisionReason: {
                  type: "subcommandResults",
                  reasons: new Map([
                    [Fe, Ke],
                    [
                      Qe,
                      {
                        behavior: "allow",
                        updatedInput: Ke.updatedInput,
                        decisionReason: {
                          type: "other",
                          reason:
                            "Allowed by a permission rule only with its output redirection removed; not allowed as written",
                        },
                      },
                    ],
                  ]),
                },
              };
      }
      V.push([Qe, ot]);
    }
    let re = Array.from(N.entries()).find(([, Be]) => Be.behavior === "deny");
    if (re) {
      let [Be, Fe] = re;
      return {
        behavior: "deny",
        message:
          Fe.behavior === "deny" ? Fe.message : `Permission denied for: ${Be}`,
        decisionReason: { type: "subcommandResults", reasons: N },
      };
    }
    let _e = () => a2(N.values(), !0) ?? E?.() ?? a2(N.values());
    if (
      n.filter((Be) => {
        let Fe = Be.trim();
        return h.isNormalizedCdCommand(Fe);
      }).length > 1
    ) {
      let Be = _e();
      if (Be) return Be;
      let Fe: Reason = {
        type: "other",
        reason:
          "Multiple directory changes in one command require approval for clarity",
        bashMissKind: "multi-cd",
      };
      return { behavior: "ask", decisionReason: Fe, message: El(Ks.name, Fe) };
    }
    let Re = Array.from(N.values()).every((Be) => Be.behavior === "allow");
    {
      let Be, Fe;
      if (y) {
        Be = y.some((Qe) => h.isNormalizedCdCommand(Qe.text));
        Fe = y.some((Qe) => h.isNormalizedGitCommand(Qe.text));
      } else {
        {
          Be = !1;
          Fe = !1;
        }
        for (let Qe of n)
          for (let ot of Sy(Qe)) {
            let it = ot.trim();
            if (h.isNormalizedCdCommand(it)) Be = !0;
            if (h.isNormalizedGitCommand(it)) Fe = !0;
          }
      }
      if (Fe && (y ? qOe(y, ue()) : zde(e.command))) {
        let Qe = _e();
        if (Qe) return Qe;
        let ot: Reason = {
          type: "other",
          reason:
            "This command creates git repository structure files (HEAD/objects/refs/hooks) and then runs git, which can execute hooks/fsmonitor from the created files.",
          bashMissKind: "cd-git-compound",
        };
        return {
          behavior: "ask",
          decisionReason: ot,
          message: El(Ks.name, ot),
        };
      }
      if (Be && Fe) {
        let Qe = [];
        for (let it of n) for (let bt of Sy(it)) Qe.push(bt.trim());
        if (!(
          k !== void 0 &&
          (await k(Qe)) &&
          (!Re || (y !== void 0 && (await k(y.map((it) => it.text)))))
        )) {
          let it = _e();
          if (it) return it;
          let bt: Reason = {
            type: "other",
            reason:
              "This command changes directory before running a version-control command, which can pick up untrusted hooks or repository configuration from the target directory. Approve only if you trust it.",
            bashMissKind: "cd-git-compound",
          };
          return {
            behavior: "ask",
            decisionReason: bt,
            message: El(Ks.name, bt),
          };
        }
      }
    }
    if (Re)
      return {
        behavior: "allow",
        updatedInput: e,
        decisionReason: { type: "subcommandResults", reasons: oe ? YOe(V) : N },
      };
    let xe = [];
    for (let [, Be] of N)
      if (Be.behavior !== "allow" && "suggestions" in Be && Be.suggestions)
        xe.push(...Be.suggestions);
    let Pe: Reason = { type: "subcommandResults", reasons: N };
    return {
      behavior: "ask",
      message: El(Ks.name, Pe),
      decisionReason: Pe,
      suggestions: xe.length > 0 ? xe : void 0,
    };
  }

  async function PMr(
    e: Input,
    n: Check,
    r: Predicates,
    a: Document,
    h: Command[] | undefined,
    y: ((commands: string[]) => boolean | Promise<boolean>) | undefined,
    k: (() => Decision | undefined) | undefined,
  ): Promise<Decision> {
    let { compoundStructure: E } = a;
    if (E.hasSubshell || E.hasCommandGroup) {
      let ke: Reason = {
        type: "other",
        reason:
          "This command uses shell operators that require approval for safety",
        bashMissKind: "shell-operators",
      };
      return { behavior: "ask", message: El(Ks.name, ke), decisionReason: ke };
    }
    let V = a.getPipeSegments();
    if (V.length <= 1)
      return { behavior: "passthrough", message: "No pipes found in command" };
    let oe = await Promise.all(V.map((ke) => xMr(ke))),
      re = await AMr(e, oe, V, n, r, h, y, k);
    if (
      re.behavior !== "allow" ||
      h === void 0 ||
      (wwn(re) && r.shouldUseSandbox?.(e)) ||
      (!a.hasAssignmentStage && (await MMr(oe, h))) ||
      !DY()
    )
      return re;
    let _e: Reason = {
      type: "other",
      reason:
        "The parts of this pipe can't be checked one by one, so the command needs approval",
      bashMissKind: "assigned-variable",
    };
    return {
      behavior: "ask",
      message: El(Ks.name, _e),
      decisionReason: _e,
      suggestions: [],
    };
  }

  async function Swn(
    e: Input,
    n: Check,
    r: Predicates,
    a: Tree,
    h: Command[] | undefined,
    y: ((commands: string[]) => boolean | Promise<boolean>) | undefined,
    k: (() => Decision | undefined) | undefined,
  ): Promise<Decision> {
    let E = a && a !== $b ? $de(e.command, a) : await Hrt.parse(e.command);
    if (!E)
      return { behavior: "passthrough", message: "Failed to parse command" };
    return PMr(e, n, r, E, h, y, k);
  }

  return {
    git,
    document,
    native: { Vde, a2, wwn, MMr, xMr, AMr, PMr, Swn },
    withPolicyScope<T>(
      policy: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { policy, scope: { policyId: policy.scope.policyId, cwd }, receipts },
        () => git.withPolicyScope(policy, cwd, run, receipts),
      );
    },
  };
}
