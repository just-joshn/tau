import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeBashSemanticResult as Result } from "../native-bash-semantics.js";
import type { NativeBashSyntaxNode as Node } from "../native-bash-parser.js";
import { parseNativePermissionRule } from "../native-permission-rules.js";
import type { createNativeBashMainControl } from "./main-control.js";
import type {
  NativeBashSecurityContext as Context,
  NativeBashSecurityAppState as AppState,
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
  type NativeBashSecurityRule as Rule,
} from "./security-types.js";
export interface NativeBashOuterPrimitiveHost {
  livePolicy?: (context: Context, scope: Scope) => Fact<Policy>;
  networkClassifierEnabled?: (scope: Scope) => Fact<boolean>;
}
export interface NativeBashCommandClampFailure {
  span: string;
  group: readonly string[];
  kind: "unverifiable" | "unmatched";
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native outer primitive invariant");
  return value;
}
function unknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
export function createNativeBashOuterPrimitives(
  main: ReturnType<typeof createNativeBashMainControl>,
  host: NativeBashOuterPrimitiveHost,
) {
  const { state } = main;
  const { complexity } = state;
  const { nested } = complexity;
  const { syntax } = nested.recursion;
  const { policy, semantic, preparation } = syntax;
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
  const wJ = ee;
  const V1 = semantic.parse;
  const SG = semantic.analyzeTree;
  const M8n = preparation.projection.flattenCommandTexts;
  const D = <T>(values: T[]) => [...new Set(values)];
  const Ks = {
    name: "Bash",
    sandboxNetworkLists: (input: Input) => Fce(input),
  };
  const fxe = (permission: Policy) =>
    withPolicyScope(
      permission,
      frame().scope.cwd,
      () => state.native.fxe(permission),
      frame().receipts,
    ).result;
  const Scn = () =>
    use(
      need(
        host.networkClassifierEnabled,
        "features.networkClassifierEnabled",
      )(frame().scope),
    );
  const R8 = (
    input: Input,
    rules: ReadonlyMap<string, Rule>,
    phase: "exact" | "prefix",
    options: { ruleBehavior: "allow" },
  ) => {
    const result = preparation.matchRules(input, rules, phase, options);
    if (result.status === "unresolved")
      throw new NativeBashSecurityUnsupported(
        result.dependency,
        "Native command-clamp preparation is unresolved",
      );
    return result.matches;
  };
  const xr = (text: string): { toolName: string; ruleContent?: string } => {
    const parsed = parseNativePermissionRule(text);
    if (parsed.kind === "call")
      return { toolName: parsed.toolName, ruleContent: parsed.content };
    return {
      toolName:
        parsed.kind === "malformed"
          ? parsed.nativeFallbackToolName
          : parsed.toolName,
    };
  };
  const wm = Symbol("untrustedArray.unreadable"),
    Zy = 4096;
  function sE(value: unknown): unknown[] | typeof wm | undefined {
    let length: unknown;
    try {
      if (!unknownArray(value)) return undefined;
      length = value.length;
    } catch (error) {
      if (error instanceof NativeBashSecurityUnsupported) throw error;
      return wm;
    }
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > Zy
    )
      return wm;
    const items: unknown[] = [];
    for (let index = 0; index < length; index++) {
      let item: unknown;
      try {
        item = value[index];
      } catch (error) {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
        item = undefined;
      }
      items.push(item);
    }
    return items;
  }
  function Ope(value: unknown): unknown[] | undefined {
    const result = sE(value);
    return result === wm ? undefined : result;
  }
  function Fce(input: Input): { allow: string[] } | undefined {
    const decoded = Ope(input.allowed_domains);
    const domains =
      decoded !== undefined &&
      decoded.every((value): value is string => typeof value === "string")
        ? decoded
        : [];
    return domains.length === 0 ? undefined : { allow: domains };
  }

  const current = <T>(run: () => T) =>
    withPolicyScope(frame().policy, frame().scope.cwd, run, frame().receipts)
      .result;
  const Ge = {
    isSandboxingEnabled: () =>
      current(complexity.native.Ge.isSandboxingEnabled),
    isAutoAllowSupported: () =>
      current(complexity.native.Ge.isAutoAllowSupported),
  };
  const IDt = (permission: Policy) =>
    withPolicyScope(
      permission,
      frame().scope.cwd,
      () => complexity.native.IDt(permission),
      frame().receipts,
    ).result;
  const Vh = (input: Input) => current(() => policy.native.Vh(input));
  const kbn = (
    input: Input,
    permission: Policy,
    commands: Parameters<typeof policy.native.kbn>[2],
  ) =>
    withPolicyScope(
      permission,
      frame().scope.cwd,
      () => policy.native.kbn(input, permission, commands),
      frame().receipts,
    ).result;
  const { Sa, A8, bk } = nested.recursion.shapes.outcomes;
  const Zde = state.native.Zde;
  function yoi(context: Context): Context {
    const get = context.getAppState;
    if (get === undefined)
      throw new NativeBashSecurityUnsupported(
        "context.getAppState",
        "Native clamp-removal rewrite requires the actual source app-state getter",
      );
    return {
      ...context,
      permissionLayers: context.permissionLayers?.filter(
        (layer) => layer.kind !== "bash_command_clamp",
      ),
      getAppState: () => {
        const current = get.call(context);
        const actual = wJ(context);
        const value: AppState = {
          ...current,
          toolPermissionContext: { ...actual, bashCommandClamps: [] },
        };
        return value;
      },
    };
  }
  async function cOr(
    e: Input,
    n: readonly (readonly string[])[],
  ): Promise<NativeBashCommandClampFailure | null> {
    if (n.length === 0) return null;
    let r: NativeBashCommandClampFailure = {
        span: e.command.trim(),
        group: n[0] ?? [],
        kind: "unverifiable",
      },
      a = await V1(e.command);
    if (a === semantic.parseAbort) return r;
    let h: Result = a
      ? SG(e.command, a)
      : { kind: "simple", commands: [], bareAssignmentNames: [] };
    if (h.kind === "too-complex") return r;
    let y = M8n(e.command);
    if (y === null || y.length === 0) return r;
    let k = D([...y, ...h.commands.map((E) => E.text)]);
    for (let E of n) {
      let N = new Map<string, Rule>();
      for (let V of E) {
        let oe = xr(V);
        if (
          oe.toolName !== Ks.name ||
          oe.ruleContent === void 0 ||
          oe.ruleContent === ""
        )
          continue;
        N.set(oe.ruleContent, {
          source: "session",
          ruleBehavior: "allow",
          ruleValue: oe,
        });
      }
      for (let V of k) {
        let oe = { ...e, command: V };
        if (!(
          R8(oe, N, "exact", { ruleBehavior: "allow" }).length > 0 ||
          R8(oe, N, "prefix", { ruleBehavior: "allow" }).length > 0
        ))
          return { span: V, group: E, kind: "unmatched" };
      }
    }
    return null;
  }

  function Fbn(e: Node): boolean {
    for (let n of e.children) {
      if (!n) continue;
      if (n.type === "ERROR") return !0;
      if (n.type === "&") {
        if (e.type !== "binary_expression") return !0;
        continue;
      }
      if (Fbn(n)) return !0;
    }
    return !1;
  }

  function rIr(e: Context): Context {
    return {
      ...e,
      permissionLayers: e.permissionLayers?.filter(
        (n) => n.kind !== "sandbox_auto_allow_suspended" || n.allowOnly !== !0,
      ),
    };
  }

  function sIr(
    e: Decision,
    n: Input,
    r: Context,
    a: Parameters<typeof policy.native.kbn>[2],
  ): Decision {
    let h = ee(r);
    if (
      e.behavior === "deny" ||
      r.forRemoteExecution === !0 ||
      !Ge.isSandboxingEnabled() ||
      !Ge.isAutoAllowSupported() ||
      IDt(ee(rIr(r))) ||
      !Vh(n)
    )
      return e;
    let y = kbn(n, h, a);
    if (y.behavior === "deny")
      return e.behavior === "ask" &&
        Sa(e.decisionReason, (k) => k.circuitBreaker === "dangerousRemoval") !==
          void 0
        ? A8(n.command, y, e)
        : y;
    if (y.behavior !== "ask" || y.decisionReason?.type !== "rule") return e;
    if (e.behavior !== "ask") return y;
    return bk(e) || Zde(e, r)
      ? e
      : { ...e, matchedAskRule: y.decisionReason.rule };
  }

  function zK(
    e: typeof Ks,
    n: Input,
    r: Context,
    a: Decision | undefined,
  ): Decision | undefined {
    if (a?.behavior === "ask" || a?.behavior === "deny") return;
    let h = ee(r);
    if (e.sandboxNetworkLists?.(n) === void 0 || !Scn() || !fxe(h)) return;
    return {
      behavior: "ask",
      message: `${e.name} carries allowed_domains, which the auto-mode classifier reviews together with the command.`,
      ...(a?.behavior === "allow" &&
        a.updatedInput !== void 0 && { updatedInput: a.updatedInput }),
      decisionReason: {
        type: "safetyCheck",
        reason: `A ${e.name} call that carries allowed_domains is reviewed by the auto-mode classifier; allow rules and hook allows approve the command, not the hosts.`,
        classifierApprovable: !0,
      },
    };
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
      () => main.withPolicyScope(permission, cwd, run, receipts),
    );
  }
  return {
    main,
    host,
    native: { sE, Ope, Fce, cOr, Fbn, rIr, yoi, sIr, zK },
    withPolicyScope,
  };
}
