import type { NativeBashSemanticCommand } from "../native-bash-semantics.js";
import type {
  NativeBashSecurityPolicy,
  NativeBashSecurityInput,
  NativeBashSecurityDecision,
} from "./security-types.js";

export interface NativeBashSecurityAppState {
  readonly [key: string]: unknown;
  toolPermissionContext: NativeBashSecurityPolicy;
}
export interface NativeBashSecurityContext {
  getAppState?: (() => NativeBashSecurityAppState) | undefined;
  abortController: AbortController;
  options: { isNonInteractiveSession: boolean };
  sessionEnvVars?: ReadonlyMap<string, string> | undefined;
  forRemoteExecution?: boolean | undefined;
  asksNoHost?: boolean | undefined;
  agentId?: string | undefined;
  permissionLayers?:
    readonly { kind: string; allowOnly?: boolean | undefined }[] | undefined;
}
export interface NativeBashSecurityNestedBudget {
  left: number;
  chars: number;
  judged: Map<string, NativeBashSecurityDecision>;
  asked: Map<string, NativeBashSecurityDecision | null>;
  command: string;
  rereading: boolean;
}
export interface NativeBashSecurityRecursion {
  depth: number;
  budget: NativeBashSecurityNestedBudget;
}
export interface NativeBashSecurityInlineContext extends NativeBashSecurityRecursion {
  input: NativeBashSecurityInput;
  context: NativeBashSecurityContext;
  divergentShapes: "read" | "refused" | undefined;
  declarationPrefix: boolean[] | undefined;
}
export interface NativeBashSecurityPrefix {
  commandPrefix?: string | undefined;
  subcommandPrefixes: ReadonlyMap<
    string,
    { commandPrefix?: string | undefined }
  >;
}
export type NativeBashSecurityPrefixReader = (
  command: string,
  signal: AbortSignal,
  nonInteractive: boolean,
) => Promise<NativeBashSecurityPrefix | null | undefined>;
export type NativeBashSecurityDeclarationObserver = (
  names: number,
  kept: boolean[] | undefined,
  uncertainWrite: boolean,
) => void;
export type NativeBashSecurityRecursiveCheck = (
  input: NativeBashSecurityInput,
  context: NativeBashSecurityContext,
  prefixes?: NativeBashSecurityPrefixReader,
  originalCommand?: string,
  recursion?: NativeBashSecurityRecursion,
  declarationPrefix?: boolean[],
  onDeclarations?: NativeBashSecurityDeclarationObserver,
  reading?: "read" | "refused",
  onLoopDifference?: () => void,
  onCommands?: (commands: NativeBashSemanticCommand[]) => void,
) => Promise<NativeBashSecurityDecision>;
export interface NativeBashSecurityRemovalHistory {
  text: string;
  cd: boolean;
  names: string[];
  exports: boolean;
  unread?: boolean | undefined;
}
export interface NativeBashSecurityNestedRemoval {
  result: NativeBashSecurityDecision;
  kind:
    | "literalTarget"
    | "emptyVariable"
    | "emptyExpansion"
    | "inlineShellScript"
    | "tooManySubstitutions"
    | "nestedSpansOverrun"
    | "wholeSubstitution";
}
export interface NativeBashSecurityRemovalReviewConfig {
  enabled: boolean;
  showDialog: boolean;
  denyOnHostCard: boolean;
  timeoutMs: number;
  maxDialogTimeouts: number;
}
interface RemovalFeatureObject {
  enabled?: unknown;
  showDialog?: unknown;
  denyOnHostCard?: unknown;
  timeoutMs?: unknown;
  maxDialogTimeouts?: unknown;
}
function removalFeatureObject(value: unknown): value is RemovalFeatureObject {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}
/** Complete source iM field order over its actual typed flag and feature receipt. */
export function nativeBashRemovalReviewConfig(
  receipt: { value: unknown; source: string },
  disabled: boolean,
): NativeBashSecurityRemovalReviewConfig {
  const e = removalFeatureObject(receipt.value) ? receipt.value : undefined;
  return {
    enabled: disabled
      ? false
      : typeof e?.enabled === "boolean" && receipt.source === "payload"
        ? e.enabled
        : true,
    showDialog: typeof e?.showDialog === "boolean" ? e.showDialog : true,
    denyOnHostCard:
      typeof e?.denyOnHostCard === "boolean" ? e.denyOnHostCard : true,
    timeoutMs:
      typeof e?.timeoutMs === "number" &&
      Number.isFinite(e.timeoutMs) &&
      e.timeoutMs >= 5000 &&
      e.timeoutMs <= 3600000
        ? e.timeoutMs
        : 120000,
    maxDialogTimeouts:
      typeof e?.maxDialogTimeouts === "number" &&
      Number.isInteger(e.maxDialogTimeouts) &&
      e.maxDialogTimeouts >= 0 &&
      e.maxDialogTimeouts <= 100
        ? e.maxDialogTimeouts
        : 3,
  };
}
