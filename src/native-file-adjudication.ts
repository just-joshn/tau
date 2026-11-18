import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact,
  type NativePermissionOutcome,
  type NativePermissionProvenance,
  type NativePermissionRule,
  type NativePermissionRuleBehavior,
  type NativePermissionScope,
  type NativePermissionSuggestion,
} from "./native-permission-outcome.js";
import { nativePermissionReasonText as reason } from "./native-permission-reason-codes.js";

export type NativeFilePermissionInspection = {
  requested: string;
  spellings: readonly string[];
  leafIsSymlink: boolean;
  endsUnexamined?: boolean | undefined;
  linkTextClimbs?: boolean | undefined;
} & (
  | { unresolved: false; landing: string }
  | {
      unresolved: true;
      stoppedAt: string;
      reason: "past-a-link" | "unexamined";
    }
);

export interface NativeFileAdjudicationPolicy {
  scope: NativePermissionScope;
  mode: string;
  restricted: boolean;
  servedCall?: boolean | undefined;
  blockFileToolReadsOutsideWorkingDirectories?: boolean | undefined;
  blockReadsOutsideWorkingDirectories?: boolean | undefined;
  blockWritesOutsideWorkingDirectories?: boolean | undefined;
  alwaysAllowRules: Readonly<Record<string, readonly string[] | undefined>>;
  trustedNetworkDirectories?: readonly string[] | undefined;
  prePlanMode?: string | undefined;
  modeBeforeRewrite?: string | undefined;
  strippedDangerousRules?: boolean | undefined;
  isRemoteMode?: boolean | undefined;
  isBypassPermissionsModeAvailable?: boolean | undefined;
  readBlockExemptPaths?: readonly string[] | undefined;
  additionalWorkingDirectories?: ReadonlyMap<string, unknown> | undefined;
}

export interface NativeFilePermissionTool<Input> {
  name: string;
  getPath?: ((input: Input) => string) | undefined;
}

export type NativeFileSensitiveWrite =
  | { safe: true }
  | {
      safe: false;
      message: string;
      classifierApprovable: boolean;
      circuitBreaker?: string | undefined;
      also?: string[] | undefined;
    };

export interface NativeProtectedReadOptions {
  restricted: boolean;
  blockOutsideReads: boolean;
  remoteSurface?: boolean | undefined;
  transcriptsJudged: true;
  readBlockFence?: boolean | undefined;
  searchRootFence?: boolean | undefined;
  forTheModelHere?: boolean | undefined;
}

/** Source classifiers remain explicit capabilities, never default false/allow. */
export interface NativeFileAdjudicationHost<Input> {
  inspect?: (
    path: string,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativeFilePermissionInspection>;
  normalize?: (
    path: string,
    scope: NativePermissionScope,
  ) => NativePermissionFact<string>;
  format?: (
    path: string,
    scope: NativePermissionScope,
  ) => NativePermissionFact<string>;
  unresolvedPathText?: (
    path: string,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{ quotedPath: string; reason: string }>;
  matchRule?: (
    path: string,
    policy: NativeFileAdjudicationPolicy,
    family: "read" | "edit",
    behavior: NativePermissionRuleBehavior,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionRule | null>;
  allowAlias?: (
    path: string,
    scope: NativePermissionScope,
  ) => NativePermissionFact<string>;
  readProtection?: (
    path: string,
    inspection: NativeFilePermissionInspection,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{
    memoryPausedFloor?: NativePermissionOutcome<Input> | undefined;
    sessionDenyReason?: string | undefined;
  }>;
  outsideReadBlock?: (
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  readFence?: (
    path: string,
    inspection: NativeFilePermissionInspection,
    input: Input,
    policy: NativeFileAdjudicationPolicy,
    options: NativeProtectedReadOptions,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionOutcome<Input> | null>;
  servedReadFenceAskStaysDenied?: (
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  networkRead?: (
    tool: NativeFilePermissionTool<Input>,
    input: Input,
    policy: NativeFileAdjudicationPolicy,
    spellings: readonly string[],
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionOutcome<Input> | null>;
  readBypassAvailable?: (
    tool: NativeFilePermissionTool<Input>,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  writeFloor?: (
    path: string,
    inspection: NativeFilePermissionInspection,
    normalizedPath: string,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionOutcome<Input> | undefined>;
  sessionEditRuleEligible?: (
    rule: string,
    spellings: readonly string[],
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  writePathShape?: (
    path: string,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{
    suspiciousNetwork: boolean;
    nestedConfigDirectories: number;
  }>;
  protectedWrite?: (
    normalizedPath: string,
    input: Input,
    spellings: readonly string[],
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionOutcome<Input>>;
  sensitiveWrite?: (
    path: string,
    spellings: readonly string[],
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativeFileSensitiveWrite>;
  writeNote?: (
    path: string,
    inspection: NativeFilePermissionInspection,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{
    landing: string;
    sentence: string;
    personOnly: boolean;
  } | null>;
  specialSessionWriteRule?: (
    path: string,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{ pattern: string } | null>;
  inWorkingDirectories?: (
    path: string,
    spellings: readonly string[],
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  wholeToolAllow?: (
    toolName: string,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionRule | null>;
  protectedRead?: (
    normalizedPath: string,
    input: Input,
    spellings: readonly string[],
    policy: NativeFileAdjudicationPolicy,
    options: NativeProtectedReadOptions,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionOutcome<Input>>;
  modelReadMode?: (
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  suggestions?: (
    path: string,
    family: "read" | "write",
    spellings: readonly string[],
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionSuggestion[]>;
  outsideAsk?: (
    operation: "read from" | "write to",
    path: string,
    inspection: NativeFilePermissionInspection,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<Omit<NativePermissionOutcome<Input>, "behavior">>;
}

export type NativeFileAdjudicationResult<Input> =
  | {
      status: "decided";
      outcome: NativePermissionOutcome<Input>;
      facts: readonly NativePermissionProvenance[];
    }
  | {
      status: "unsupported";
      dependency: string;
      reason: string;
      facts: readonly NativePermissionProvenance[];
    };

class Evaluation<Input> {
  readonly facts: NativePermissionProvenance[] = [];
  constructor(
    readonly host: NativeFileAdjudicationHost<Input>,
    readonly policy: NativeFileAdjudicationPolicy,
  ) {}
  read<T>(fact: NativePermissionFact<T>): T {
    return readNativePermissionFact(fact, this.policy.scope, this.facts);
  }
  need<T>(value: T | undefined, name: string): T {
    if (value === undefined)
      throw new NativePermissionDependencyError(
        name,
        "Required source-backed host capability is unavailable",
      );
    return value;
  }
  format(path: string): string {
    return this.read(
      this.need(this.host.format, "format")(path, this.policy.scope),
    );
  }
  match(
    path: string,
    policy: NativeFileAdjudicationPolicy,
    family: "read" | "edit",
    behavior: NativePermissionRuleBehavior,
  ): NativePermissionRule | null {
    return this.read(
      this.need(this.host.matchRule, "Oa")(
        path,
        policy,
        family,
        behavior,
        this.policy.scope,
      ),
    );
  }
  allAllow(
    paths: readonly string[],
    policy: NativeFileAdjudicationPolicy,
    family: "read" | "edit",
  ): NativePermissionRule | null {
    let first: NativePermissionRule | null = null;
    for (const path of paths) {
      let rule = this.match(path, policy, family, "allow");
      if (!rule) {
        const alias = this.read(
          this.need(this.host.allowAlias, "GSe")(path, this.policy.scope),
        );
        if (alias !== path) rule = this.match(alias, policy, family, "allow");
      }
      if (!rule) return null;
      first ??= rule;
    }
    return first;
  }
  suggestions(
    path: string,
    family: "read" | "write",
    spellings: readonly string[],
    policy: NativeFileAdjudicationPolicy,
  ): NativePermissionSuggestion[] {
    return this.read(
      this.need(this.host.suggestions, "KKt")(
        path,
        family,
        spellings,
        policy,
        this.policy.scope,
      ),
    );
  }
}

function missingPath<Input>(
  tool: NativeFilePermissionTool<Input>,
): NativePermissionOutcome<Input> {
  return {
    behavior: "ask",
    message: `Claude requested permissions to use ${tool.name}, but you haven't granted it yet.`,
  };
}

function edit<Input>(
  evaluation: Evaluation<Input>,
  tool: NativeFilePermissionTool<Input>,
  input: Input,
  policy: NativeFileAdjudicationPolicy,
  supplied?: NativeFilePermissionInspection,
): NativePermissionOutcome<Input> {
  if (typeof tool.getPath !== "function") return missingPath(tool);
  const { host } = evaluation,
    scope = policy.scope,
    path = tool.getPath(input),
    inspection =
      supplied ??
      evaluation.read(evaluation.need(host.inspect, "pa")(path, scope)),
    spellings = inspection.spellings,
    normalized = evaluation.read(
      evaluation.need(host.normalize, "wt")(path, scope),
    ),
    floor = evaluation.read(
      evaluation.need(host.writeFloor, "TVo")(
        path,
        inspection,
        normalized,
        policy,
        scope,
      ),
    );
  if (floor !== undefined) return floor;
  if (inspection.unresolved)
    throw new NativePermissionDependencyError(
      "TVo",
      "An unresolved write identity requires its actual protected/unresolved floor",
    );
  const sessionRules = (policy.alwaysAllowRules.session ?? []).filter((rule) =>
      evaluation.read(
        evaluation.need(host.sessionEditRuleEligible, "GZn/pg")(
          rule,
          spellings,
          policy,
          scope,
        ),
      ),
    ),
    sessionAllow = sessionRules.length
      ? evaluation.allAllow(
          spellings,
          { ...policy, alwaysAllowRules: { session: sessionRules } },
          "edit",
        )
      : null;
  let shapes:
    | { suspiciousNetwork: boolean; nestedConfigDirectories: number }[]
    | undefined;
  const pathShapes = () =>
    (shapes ??= spellings.map((spelling) =>
      evaluation.read(
        evaluation.need(host.writePathShape, "Hte/ic")(spelling, policy, scope),
      ),
    ));
  if (
    sessionAllow &&
    policy.mode !== "plan" &&
    !pathShapes().some((shape) => shape.suspiciousNetwork) &&
    !pathShapes().some((shape) => shape.nestedConfigDirectories > 1)
  )
    return {
      behavior: "allow",
      updatedInput: input,
      decisionReason: { type: "rule", rule: sessionAllow },
    };
  for (const spelling of spellings) {
    const rule = evaluation.match(spelling, policy, "edit", "ask");
    if (rule)
      return {
        behavior: "ask",
        message: `Claude requested permissions to write to ${evaluation.format(path)}, but you haven't granted it yet.`,
        decisionReason: { type: "rule", rule },
      };
  }
  const classified = evaluation.read(
    evaluation.need(host.protectedWrite, "vct")(
      normalized,
      input,
      spellings,
      policy,
      scope,
    ),
  );
  if (
    classified.behavior !== "passthrough" &&
    !(policy.servedCall === true && classified.behavior === "allow")
  )
    return classified;
  const sensitive = evaluation.read(
    evaluation.need(host.sensitiveWrite, "uJ")(path, spellings, policy, scope),
  );
  if (!sensitive.safe) {
    const special =
        policy.restricted ||
        pathShapes().some(
          (shape) =>
            shape.nestedConfigDirectories > 1 || shape.suspiciousNetwork,
        )
          ? null
          : evaluation.read(
              evaluation.need(host.specialSessionWriteRule, "Gp")(
                path,
                policy,
                scope,
              ),
            ),
      suggestions = special
        ? [
            {
              type: "addRules",
              rules: [{ toolName: "Edit", ruleContent: special.pattern }],
              behavior: "allow",
              destination: "session",
            } satisfies NativePermissionSuggestion,
          ]
        : evaluation.suggestions(path, "write", spellings, policy),
      note = evaluation.read(
        evaluation.need(host.writeNote, "vVo")(path, inspection, policy, scope),
      ),
      message =
        note === null
          ? sensitive.message
          : `${sensitive.message} ${note.sentence}.`,
      also = [
        ...(sensitive.circuitBreaker ? [sensitive.circuitBreaker] : []),
        ...(sensitive.also ?? []),
      ];
    return {
      behavior: "ask",
      message,
      suggestions,
      ...(note === null ? {} : { blockedPath: note.landing }),
      decisionReason: {
        type: "safetyCheck",
        reason: message,
        ...(policy.restricted
          ? {
              classifierApprovable: false,
              circuitBreaker: "restrictedMode",
              ...(also.length ? { also } : {}),
            }
          : {
              classifierApprovable: sensitive.classifierApprovable,
              ...(sensitive.circuitBreaker
                ? { circuitBreaker: sensitive.circuitBreaker }
                : {}),
              ...(sensitive.also ? { also: sensitive.also } : {}),
            }),
        ...(note?.personOnly ? { classifierApprovable: false } : {}),
      },
    };
  }
  if (policy.mode === "plan")
    return {
      behavior: "ask",
      message: `Cannot write to ${evaluation.format(path)} while in plan mode.`,
      decisionReason: { type: "mode", mode: "plan" },
    };
  const inside = evaluation.read(
    evaluation.need(host.inWorkingDirectories, "vy")(
      path,
      spellings,
      policy,
      scope,
    ),
  );
  if (policy.mode === "acceptEdits" && inside)
    return {
      behavior: "allow",
      updatedInput: input,
      decisionReason: { type: "mode", mode: policy.mode },
    };
  const allow =
    (inside
      ? evaluation.read(
          evaluation.need(host.wholeToolAllow, "OLa")(tool.name, policy, scope),
        )
      : null) ?? evaluation.allAllow(spellings, policy, "edit");
  if (allow)
    return {
      behavior: "allow",
      updatedInput: input,
      decisionReason: { type: "rule", rule: allow },
    };
  if (inside)
    return {
      behavior: "ask",
      message: `Claude requested permissions to write to ${evaluation.format(path)}, but you haven't granted it yet.`,
      suggestions: evaluation.suggestions(path, "write", spellings, policy),
    };
  return {
    behavior: "ask",
    suggestions: evaluation.suggestions(path, "write", spellings, policy),
    ...evaluation.read(
      evaluation.need(host.outsideAsk, "Kc")(
        "write to",
        path,
        inspection,
        policy,
        scope,
      ),
    ),
  };
}

function read<Input>(
  evaluation: Evaluation<Input>,
  tool: NativeFilePermissionTool<Input>,
  input: Input,
  policy: NativeFileAdjudicationPolicy,
  supplied?: NativeFilePermissionInspection,
  forTheModelHere?: boolean,
): NativePermissionOutcome<Input> {
  if (typeof tool.getPath !== "function") return missingPath(tool);
  const { host } = evaluation,
    scope = policy.scope,
    path = tool.getPath(input),
    inspection =
      supplied ??
      evaluation.read(evaluation.need(host.inspect, "pa")(path, scope)),
    spellings = inspection.spellings;
  for (const spelling of spellings) {
    const rule = evaluation.match(spelling, policy, "read", "deny");
    if (rule)
      return {
        behavior: "deny",
        message: `Permission to read ${evaluation.format(path)} has been denied.`,
        decisionReason: { type: "rule", rule },
      };
  }
  const protection = evaluation.read(
    evaluation.need(host.readProtection, "ale/Jc/La/C5r")(
      path,
      inspection,
      policy,
      scope,
    ),
  );
  if (protection.memoryPausedFloor !== undefined)
    return protection.memoryPausedFloor;
  if (protection.sessionDenyReason !== undefined)
    return {
      behavior: "deny",
      message: `${protection.sessionDenyReason} Claude Code does not read this file in this session.`,
      decisionReason: { type: "other", reason: protection.sessionDenyReason },
    };
  const outsideBlock = evaluation.read(
    evaluation.need(host.outsideReadBlock, "lk")(policy, scope),
  );
  let normalized: string | undefined;
  const normalizedPath = () =>
    (normalized ??= evaluation.read(
      evaluation.need(host.normalize, "wt")(path, scope),
    ));
  if (policy.restricted || outsideBlock) {
    const fence = evaluation.read(
      evaluation.need(host.readFence, "Nc/read")(
        path,
        inspection,
        input,
        policy,
        {
          restricted: policy.restricted,
          blockOutsideReads: outsideBlock,
          readBlockFence: outsideBlock,
          searchRootFence: outsideBlock,
          transcriptsJudged: true,
        },
        scope,
      ),
    );
    if (fence === null && inspection.unresolved)
      throw new NativePermissionDependencyError(
        "Nc/read",
        "An unresolved read identity cannot have an admitted fence result",
      );
    if (fence) {
      if (fence.behavior !== "deny")
        throw new NativePermissionDependencyError(
          "Nc/read",
          "The source fence must produce deny or null",
        );
      if (
        policy.servedCall === true &&
        policy.blockFileToolReadsOutsideWorkingDirectories !== true &&
        !policy.restricted &&
        fence.behavior === "deny" &&
        !evaluation.read(
          evaluation.need(host.servedReadFenceAskStaysDenied, "hVo")(scope),
        )
      )
        return {
          behavior: "ask",
          message: fence.message,
          decisionReason: {
            type: "safetyCheck",
            reason: reason.outsideReadsBlocked,
            classifierApprovable: false,
            circuitBreaker: "outsideReadsBlocked",
          },
        };
      return fence;
    }
  } else if (inspection.unresolved) {
    const rendered = evaluation.read(
      evaluation.need(host.unresolvedPathText, "qc/hx/$7t")(path, scope),
    );
    return {
      behavior: "deny",
      message: `Refusing to read ${rendered.quotedPath}: where it leads on disk could not be determined (a link on the way could not be examined, or the links do not resolve).`,
      decisionReason: { type: "other", reason: rendered.reason },
    };
  }
  const network = evaluation.read(
    evaluation.need(host.networkRead, "bct")(
      tool,
      input,
      policy,
      spellings,
      scope,
    ),
  );
  if (network) {
    if (network.behavior !== "ask")
      throw new NativePermissionDependencyError(
        "bct",
        "The source network floor must produce ask or null",
      );
    let explicitAsk = false;
    if (
      policy.servedCall !== true &&
      evaluation.read(
        evaluation.need(host.readBypassAvailable, "Vmt")(tool, policy, scope),
      )
    )
      explicitAsk = spellings.some(
        (spelling) =>
          evaluation.match(spelling, policy, "read", "ask") !== null,
      );
    if (!explicitAsk) return network;
  }
  for (const spelling of spellings) {
    const rule = evaluation.match(spelling, policy, "read", "ask");
    if (rule)
      return {
        behavior: "ask",
        message: `Claude requested permissions to read from ${evaluation.format(path)}, but you haven't granted it yet.`,
        decisionReason: { type: "rule", rule },
      };
  }
  const editPolicy =
      policy.mode === "plan" || policy.blockWritesOutsideWorkingDirectories
        ? {
            ...policy,
            ...(policy.mode === "plan" ? { mode: "default" } : {}),
            blockWritesOutsideWorkingDirectories: false,
          }
        : policy,
    implied = edit(evaluation, tool, input, editPolicy, inspection);
  if (implied.behavior === "allow") return implied;
  if (
    evaluation.read(
      evaluation.need(host.inWorkingDirectories, "vy")(
        path,
        spellings,
        policy,
        scope,
      ),
    )
  )
    return {
      behavior: "allow",
      updatedInput: input,
      decisionReason: { type: "mode", mode: "default" },
    };
  const modelReadMode = forTheModelHere
      ? evaluation.read(
          evaluation.need(host.modelReadMode, "sLe")(policy, scope),
        )
      : false,
    classified = evaluation.read(
      evaluation.need(host.protectedRead, "lLe")(
        normalizedPath(),
        input,
        spellings,
        policy,
        {
          restricted: policy.restricted,
          blockOutsideReads: outsideBlock,
          transcriptsJudged: true,
          ...(forTheModelHere === undefined
            ? {}
            : { forTheModelHere: forTheModelHere && !modelReadMode }),
        },
        scope,
      ),
    );
  if (
    classified.behavior !== "passthrough" &&
    !(policy.servedCall === true && classified.behavior === "allow")
  )
    return classified;
  const allow = evaluation.allAllow(spellings, policy, "read");
  if (allow)
    return {
      behavior: "allow",
      updatedInput: input,
      decisionReason: { type: "rule", rule: allow },
    };
  return {
    behavior: "ask",
    suggestions: evaluation.suggestions(path, "read", spellings, policy),
    ...evaluation.read(
      evaluation.need(host.outsideAsk, "Kc")(
        "read from",
        path,
        inspection,
        policy,
        scope,
      ),
    ),
  };
}

function run<Input>(
  options: {
    tool: NativeFilePermissionTool<Input>;
    input: Input;
    policy: NativeFileAdjudicationPolicy;
    host: NativeFileAdjudicationHost<Input>;
    inspection?: NativeFilePermissionInspection | undefined;
    forTheModelHere?: boolean | undefined;
  },
  operation: "read" | "edit",
): NativeFileAdjudicationResult<Input> {
  const evaluation = new Evaluation(options.host, options.policy);
  try {
    const outcome =
      operation === "read"
        ? read(
            evaluation,
            options.tool,
            options.input,
            options.policy,
            options.inspection,
            options.forTheModelHere,
          )
        : edit(
            evaluation,
            options.tool,
            options.input,
            options.policy,
            options.inspection,
          );
    return {
      status: "decided",
      outcome,
      facts: Object.freeze(evaluation.facts.slice()),
    };
  } catch (error) {
    if (!(error instanceof NativePermissionDependencyError)) throw error;
    return {
      status: "unsupported",
      dependency: error.dependency,
      reason: error.reason,
      facts: Object.freeze(evaluation.facts.slice()),
    };
  }
}

export function adjudicateNativeFileRead<Input>(
  options: Parameters<typeof run<Input>>[0],
): NativeFileAdjudicationResult<Input> {
  return run(options, "read");
}
export function adjudicateNativeFileEdit<Input>(
  options: Parameters<typeof run<Input>>[0],
): NativeFileAdjudicationResult<Input> {
  return run(options, "edit");
}
