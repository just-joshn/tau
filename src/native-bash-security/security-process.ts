import type { NativeBashSemantics } from "../native-bash-semantics.js";
import type { NativeBashCommandPreparation } from "../native-bash-command-preparation.js";
import { createNativeBashSecurityPolicyControl } from "./policy-control.js";
import { createNativeBashSecurityObservations } from "./security-observations.js";
import { createNativeBashInlineScript } from "./inline-script.js";
import { createNativeBashSecurityOutcomeControl } from "./outcome-control.js";
import { createNativeBashSecurityRemovalShapes } from "./removal-shapes.js";
import { createNativeBashSecurityRecursiveSyntax } from "./recursive-syntax.js";
import { createNativeBashSecurityInlineRecursion } from "./inline-recursion.js";
import { createNativeBashLiteralRemoval } from "./literal-removal.js";
import { createNativeBashSecurityNestedRemoval } from "./nested-removal.js";
import { createNativeBashComplexityControl } from "./complexity-control.js";
import { createNativeBashStateControl } from "./state-control.js";
import { createNativeBashDescendantDeny } from "./descendant-deny.js";
import { createNativeBashCwdReadControl } from "./cwd-read-control.js";
import { createNativeBashSecurityGitStructure } from "./git-structure.js";
import { createNativeBashSecurityPipelineControl } from "./pipeline-control.js";
import { createNativeBashMainControl } from "./main-control.js";
import { createNativeBashCwdAlternates } from "./cwd-alternates.js";
import { createNativeBashOuterPrimitives } from "./outer-primitives.js";
import { createNativeBashOuterControl } from "./outer-control.js";
import type {
  NativeBashSecurityContext as Context,
  NativeBashSecurityPrefixReader as PrefixReader,
  NativeBashSecurityRecursiveCheck as Check,
} from "./security-recursion-types.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityInput as Input,
  type NativeBashSecurityProvenance as Provenance,
} from "./security-types.js";

export interface NativeBashSecurityProcessHosts {
  policy: Parameters<typeof createNativeBashSecurityPolicyControl>[2];
  shapes: Parameters<typeof createNativeBashSecurityRemovalShapes>[3];
  syntax: Parameters<typeof createNativeBashSecurityRecursiveSyntax>[1];
  inline: Parameters<typeof createNativeBashSecurityInlineRecursion>[2];
  nested: Parameters<typeof createNativeBashSecurityNestedRemoval>[2];
  complexity: Parameters<typeof createNativeBashComplexityControl>[1];
  state: Parameters<typeof createNativeBashStateControl>[1];
  descendant: Parameters<typeof createNativeBashDescendantDeny>[1];
  cwd: Parameters<typeof createNativeBashCwdReadControl>[2];
  pipeline: Parameters<typeof createNativeBashSecurityPipelineControl>[5];
  main: Parameters<typeof createNativeBashMainControl>[3];
  alternates: Parameters<typeof createNativeBashCwdAlternates>[1];
  primitives: Parameters<typeof createNativeBashOuterPrimitives>[1];
  outer: Parameters<typeof createNativeBashOuterControl>[2];
}
export type NativeBashSecurityProcessResult =
  | { status: "resolved"; outcome: Decision; provenance: readonly Provenance[] }
  | {
      status: "unresolved";
      dependency: string;
      message: string;
      provenance: readonly Provenance[];
    };
/** One retained parser/semantic/preparation owner and source observation graph per process. */
export function createNativeBashSecurityProcess(
  semantic: NativeBashSemantics,
  preparation: NativeBashCommandPreparation,
  hosts: NativeBashSecurityProcessHosts,
) {
  if (
    semantic.parser !== preparation.projection.parser ||
    semantic.features !== preparation.features
  )
    throw new Error(
      "Native Bash parser and preparation feature owners must be shared",
    );
  let main: ReturnType<typeof createNativeBashMainControl> | undefined;
  let outer: ReturnType<typeof createNativeBashOuterControl> | undefined;
  const mainCheck: Check = (...args) => {
    if (main === undefined)
      throw new Error(
        "Native Bash main recursion used before process initialization",
      );
    return main.native.nIe(...args);
  };
  const qdeCheck: Check = (
    input,
    context,
    prefixes,
    originalCommand,
    recursion,
    declarations,
    onDeclarations,
    reading,
  ) => {
    if (outer === undefined)
      throw new Error(
        "Native Bash outer recursion used before process initialization",
      );
    return outer.native.Qde(
      input,
      context,
      prefixes,
      originalCommand,
      recursion,
      declarations,
      onDeclarations,
      reading,
    );
  };
  const policy = createNativeBashSecurityPolicyControl(
    semantic,
    preparation,
    hosts.policy,
  );
  const observations = createNativeBashSecurityObservations(policy);
  const inlineScript = createNativeBashInlineScript(
    semantic,
    preparation,
    policy.pathOwner,
  );
  const outcomes = createNativeBashSecurityOutcomeControl(policy.native.El);
  const shapes = createNativeBashSecurityRemovalShapes(
    observations,
    inlineScript,
    outcomes,
    hosts.shapes,
  );
  const syntax = createNativeBashSecurityRecursiveSyntax(policy, hosts.syntax);
  const inline = createNativeBashSecurityInlineRecursion(
    syntax,
    shapes,
    hosts.inline,
    mainCheck,
  );
  const literal = createNativeBashLiteralRemoval(
    semantic,
    preparation,
    policy.pathOwner,
  );
  const nested = createNativeBashSecurityNestedRemoval(
    inline,
    literal,
    hosts.nested,
    mainCheck,
  );
  const complexity = createNativeBashComplexityControl(
    nested,
    hosts.complexity,
  );
  const state = createNativeBashStateControl(complexity, hosts.state);
  const descendant = createNativeBashDescendantDeny(policy, hosts.descendant);
  const cwd = createNativeBashCwdReadControl(syntax, descendant, hosts.cwd);
  const git = createNativeBashSecurityGitStructure(
    semantic,
    preparation,
    policy.pathOwner,
    hosts.policy,
  );
  const pipeline = createNativeBashSecurityPipelineControl(
    semantic,
    preparation,
    git,
    outcomes,
    policy.native.El,
    hosts.pipeline,
  );
  main = createNativeBashMainControl(
    state,
    cwd,
    pipeline,
    hosts.main,
    qdeCheck,
  );
  const alternates = createNativeBashCwdAlternates(main, hosts.alternates);
  const primitives = createNativeBashOuterPrimitives(main, hosts.primitives);
  outer = createNativeBashOuterControl(primitives, alternates, hosts.outer);
  const owner = outer;
  async function check(
    input: Input,
    options: {
      policy: Policy;
      cwd: string;
      context: Context;
      prefixes?: PrefixReader;
      transform?: (outcome: Decision) => Decision | undefined;
    },
  ): Promise<NativeBashSecurityProcessResult> {
    const provenance: Provenance[] = [];
    try {
      const outcome = await owner.withPolicyScope(
        options.policy,
        options.cwd,
        () =>
          owner.native.OIo(
            input,
            options.context,
            options.prefixes,
            options.transform,
          ),
        provenance,
      ).result;
      return { status: "resolved", outcome, provenance };
    } catch (error) {
      if (error instanceof NativeBashSecurityUnsupported)
        return {
          status: "unresolved",
          dependency: error.dependency,
          message: error.message,
          provenance,
        };
      throw error;
    }
  }
  return {
    semantic,
    preparation,
    hosts,
    policy,
    observations,
    inlineScript,
    outcomes,
    shapes,
    syntax,
    inline,
    literal,
    nested,
    complexity,
    state,
    descendant,
    cwd,
    git,
    pipeline,
    main,
    alternates,
    primitives,
    outer: owner,
    check,
  };
}
