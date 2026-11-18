import { AsyncLocalStorage } from "node:async_hooks";
import type { createNativeBashSecurityObservations } from "./security-observations.js";
import type { createNativeBashInlineScript } from "./inline-script.js";
import type { createNativeBashSecurityOutcomeControl } from "./outcome-control.js";
import {
  needNativeBashSecurityCapability,
  readNativeBashSecurityFact,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityDecision as Decision,
} from "./security-types.js";
import type { NativeBashSecurityNestedRemoval as Nested } from "./security-recursion-types.js";

export interface NativeBashSecurityRemovalShapeHost {
  strictInlineShellRemovalDisabled?: (scope: Scope) => Fact<boolean>;
  paleKestrel?: (scope: Scope) => Fact<boolean>;
  removalShapeEvent?: (shape: string, scope: Scope) => Fact<void>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native removal shape scope");
  return value;
}

export function createNativeBashSecurityRemovalShapes(
  observations: ReturnType<typeof createNativeBashSecurityObservations>,
  inline: ReturnType<typeof createNativeBashInlineScript>,
  outcomes: ReturnType<typeof createNativeBashSecurityOutcomeControl>,
  host: NativeBashSecurityRemovalShapeHost,
) {
  if (inline.pathOwner !== observations.policy.pathOwner)
    throw new Error("Native Bash process owners must be shared");
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(receipt: Fact<T>) =>
    readNativeBashSecurityFact(receipt, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const { nb } = observations.policy.pathOwner.native;
  const { tIe, Xlt } = inline.native;
  const { Sa } = outcomes;
  const Kkn = "use a literal path: when the expansion is empty this removes /";
  const Vkn = "on drive root: ";
  const Ykn = "on mounted drive path: ";
  const oPr = new RegExp(
    String.raw`^Dangerous rm(?:dir)? operation on possibly-empty variable path: \$\{\u2026\}\S* \(${Kkn}[A-Za-z0-9+]+\)$`,
  );
  const rPr = new RegExp(
    String.raw`^Dangerous rm(?:dir)? operation ${Vkn}\\+$`,
  );
  const sPr = new RegExp(`^Dangerous rm(?:dir)? operation ${Ykn}/`);
  const Xwn = /\$'(?:\\'|[^'])*\\[xuUc0-7]/;
  const misses: Record<string, boolean | undefined> = {
    "too-complex": true,
    semantics: true,
    "multi-cd": true,
    "shell-operators": true,
    "cd-git-compound": true,
    "process-substitution": true,
    "loop-later-pass": true,
    "cd-compound-write": false,
    "cd-compound-read": false,
    "cd-compound-redirect": false,
    "dangerous-path": false,
    "flag-validation": false,
    "cd-multi-positional": false,
    "shell-expansion": false,
    "net-redirect": false,
    "sed-dangerous": false,
    "assigned-variable": false,
    "git-untrusted-checkout": false,
    "no-rule-match": false,
    "ask-rule": false,
    "working-dir": false,
    "safety-check": false,
    "other-untagged": false,
  };
  function XK(shape: string): void {
    observations.native.Qv(() => {
      use(
        need(host.removalShapeEvent, "telemetry.removalShape")(
          shape,
          frame().scope,
        ),
      );
    });
  }
  function ZOe(text: string): boolean {
    if (text.includes("||") || text.includes(";")) return false;
    if (text.includes("\n")) return false;
    if (text.replaceAll("&&", "").includes("&")) return false;
    return true;
  }
  function Dbn(text: string): boolean {
    const unquoted = text.replace(/\$(?=['"])|['"\\]/g, "");
    return (
      /\{[^{}\s]*(?:,|\.\.)/.test(unquoted) ||
      /(?:^|[^\w.-])rm(?:dir)?(?![\w.-])/i.test(unquoted) ||
      /(?:^|[;&|(){}\n`!])\s*(?:\w+\+?=\S*\s+)*\$/.test(unquoted)
    );
  }
  function Ylt(text: string): boolean {
    return [text, text.replace(/\\\n/g, "")].some(
      (value) =>
        Xwn.test(value) || Xwn.test(value.replace(/'(?:\\'|"'")'/g, "'")),
    );
  }
  function Xde(text: string): boolean {
    const removal =
      /(?:^|[^\w.-]|\$\{[^{}:-]*:?-)rm(?:dir)?(?:\.exe)?(?![\w.-])/i;
    const variables = [
      /\$[=~^]*(?:[A-Za-z_]\w*|[0-9]+|[@*#?!$-]|\{[^{}]*\})/g,
      /\$(?:[0-9]+|[@*#?!$-]|\{[^{}]*\})/g,
    ];
    const alternatives = (value: string) =>
      value.replace(/\$\{[^{}:=?+-]*:?[-=?+]([^{}]*)\}/g, "$1");
    const continued = text.replace(/\\\n/g, "");
    const unquote = (value: string) => value.replace(/\$(?=['"])|['"\\]/g, "");
    const forms = [
      continued,
      unquote(continued),
      unquote(continued.replace(/\\[ntr]/g, " ")),
    ].flatMap((value) => [value, alternatives(value)]);
    const substituted = variables.flatMap((pattern) =>
      [" ", ""].flatMap((replacement) => [
        unquote(alternatives(continued).replace(pattern, replacement)),
        ...forms.map((form) => form.replace(pattern, replacement)),
      ]),
    );
    return (
      [...forms, ...substituted].some((value) => removal.test(value)) ||
      [...tIe(continued), ...tIe(unquote(continued))].some((value) =>
        Xlt(value.replace(/\.exe$/i, "")),
      )
    );
  }
  function LOr(): boolean {
    return (
      !use(
        need(
          host.strictInlineShellRemovalDisabled,
          "environment.strictInlineShellRemovalDisabled",
        )(frame().scope),
      ) && use(need(host.paleKestrel, "features.paleKestrel")(frame().scope))
    );
  }
  function XOe(...texts: string[]): boolean {
    return !LOr() || texts.some((text) => Xde(text) || Ylt(text));
  }
  function QOe(denied: boolean, depth: number): Decision {
    if (depth === 0) XK("inline_shell_unchecked");
    return {
      behavior: "ask",
      message: denied
        ? "A permission rule denies a command inside this shell -c script, so Claude Code could not check it for dangerous removals. Approving runs the whole script, including that command."
        : "This command passes a shell -c script that runs rm, and Claude Code could not check the script for dangerous removals. Approve only if you have read the script.",
      decisionReason: {
        type: "safetyCheck",
        reason: denied
          ? "A permission rule denies a command in this shell -c script"
          : "This shell -c script runs rm and could not be checked",
        classifierApprovable: false,
        circuitBreaker: "dangerousRemoval",
        removalRule: "inline_shell_unchecked",
      },
      suggestions: [],
    };
  }
  function BOr(decision: Decision): Decision {
    if (decision.behavior !== "ask") return decision;
    const reason = decision.decisionReason;
    return reason?.type !== "safetyCheck" ||
      !/__INLINE_SHELL_|__CMDSUB/.test(`${decision.message}${reason.reason}`)
      ? decision
      : {
          ...decision,
          message:
            "Dangerous rm operation in a shell -c script: its target is built from a variable or command output known only when it runs, and if that is empty the rm can reach a directory like / or your home directory. This requires explicit approval and cannot be auto-allowed by permission rules. Pass a literal path, or guard the value with ${NAME:?}.",
          decisionReason: {
            ...reason,
            reason:
              "Dangerous rm operation in a shell -c script, on a target built from a value known only when it runs",
          },
        };
  }
  function WOr(decision: Decision): string | undefined {
    const reason =
      decision.behavior === "ask" ? decision.decisionReason : undefined;
    return reason?.type === "other" &&
      reason.bashMissKind !== undefined &&
      misses[reason.bashMissKind]
      ? reason.bashMissKind
      : undefined;
  }
  function oat(
    reason: string,
  ):
    | "placeholder_root_child"
    | "backslash_only"
    | "mounted_drive_path"
    | undefined {
    if (oPr.test(reason)) return "placeholder_root_child";
    if (rPr.test(reason)) return "backslash_only";
    if (sPr.test(reason)) return "mounted_drive_path";
    return undefined;
  }
  function rlt(decision: Decision): boolean {
    return (
      decision.behavior === "ask" &&
      oat(Sa(decision.decisionReason)?.reason ?? "") === "mounted_drive_path"
    );
  }
  function C8(): Nested {
    return {
      result: nb(
        "rm",
        "This command could not be fully checked for dangerous rm operations: not all of its nested commands or function substitutions could be analyzed. This requires explicit approval.",
        "not ruled out — some nested commands or function substitutions could not be analyzed",
        "nestedSpansOverrun",
      ),
      kind: "nestedSpansOverrun",
    };
  }
  function v8(previous: Nested | undefined, next: Nested): Nested {
    return previous !== undefined &&
      Sa(
        next.result.decisionReason,
        (reason) => reason.circuitBreaker === "dangerousRemoval",
      ) === undefined
      ? previous
      : next;
  }
  return {
    observations,
    inline,
    outcomes,
    native: {
      XK,
      ZOe,
      Dbn,
      Ylt,
      Xde,
      LOr,
      XOe,
      QOe,
      BOr,
      WOr,
      oat,
      rlt,
      C8,
      v8,
    },
    withPolicyScope<T>(
      policy: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { scope: { policyId: policy.scope.policyId, cwd }, receipts },
        () => observations.policy.withPolicyScope(policy, cwd, run, receipts),
      );
    },
  };
}
