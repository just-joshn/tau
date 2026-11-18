import type { NativeFileAdjudicationPolicy } from "./native-file-adjudication.js";
import type { NativeFilePermissionRoots } from "./native-file-permission-host.js";
import type { NativeFileRule } from "./native-permission-rules.js";
import type {
  NativePermissionFact,
  NativePermissionRuleBehavior,
  NativePermissionScope,
} from "./native-permission-outcome.js";
import type { NativePermissionPathContext } from "./native-path-inspection.js";

/** These are owner snapshots, never conclusions about the candidate being judged. */
export interface NativeFileResourceSnapshot {
  diskless: boolean;
  configDirectory: string;
  configHome: string | null;
  configContextCwd: string | null;
  originalCwd: string;
  nativeSessionId: string;
  aliasTranslationRoots: readonly (string | null)[];
  launchContextRoot: string | null;
  initialReadRoot: string | null | undefined;
  extraWorkingDirectories: readonly {
    path: string;
    source: string;
    readFenceAdmitted: boolean;
  }[];
  workingDirPathsHeldAsNamed: ReadonlySet<string>;
  blockFileReadProtectedExceptions: boolean;
  merryBoot: boolean;
  memory: {
    paused: boolean;
    canLackFolderAndUnresolved: boolean;
    autoMemoryRoot: string | null;
    ownProjectMemoryRoot: string | null;
    ownProjectMemoryEnabled: boolean;
    requireExplicitMemoryWrites: boolean;
    memoryBlockedByReadFence: boolean;
    agentMemoryRoots: readonly string[];
  };
  runtime: {
    plan: { directory: string; slug: string } | null;
    workflowDirectory: string | null;
    scratchDirectory: string | null;
    backgroundJobDirectory: string | null;
    projectStoreDirectory: string | null;
    originalProjectStoreDirectory: string | null;
    connectorDownloadDirectory: string | null;
    toolResultDirectories: readonly string[];
    ownSessionDirectory: string | null;
    taskOutputDirectory: string | null;
    projectTempPrefix: string;
    earlierToolResultDirectories: readonly string[];
    allowEarlierToolResultsForModel: boolean;
    bundledSkillReferenceDirectory: string;
    syncedPluginDirectories: readonly string[];
    reservedSkillDirectories: readonly string[];
  };
  protected: {
    hostCredentialsPath: string | null;
    profileStore: {
      directories: readonly string[];
      files: readonly string[];
    } | null;
    signInFiles: readonly {
      kind: "tokens" | "device" | "lock";
      paths: readonly string[];
    }[];
    settingsFiles: readonly string[];
    settingsSourcePaths: readonly string[];
    flagSettingsPath: string | null;
    policySettingsPath: string | null;
    settingsBodyTemplates: readonly {
      root: string;
      relativePaths: readonly string[];
    }[];
    managedSettingsDirectories: readonly string[];
  };
  /** Registries supply actual roots; the host computes metadata scan completeness. */
  plugins: {
    devModsFollowLinks: boolean;
    producerRoots: readonly string[];
    retainedProducerPaths: readonly string[];
    wslProviderUndeterminable: boolean;
    inlineRoots: readonly string[];
    additionalProducerRoot: string | null;
  };
}

export interface NativeConcreteFileHostOptions {
  pathContext: NativePermissionPathContext;
  readResources(
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeFileResourceSnapshot>;
  /** Admission remains with the actual native settings/permission source owner. */
  readRules(
    policy: NativeFileAdjudicationPolicy,
    behavior: NativePermissionRuleBehavior,
    scope: NativePermissionScope,
  ): NativePermissionFact<readonly NativeFileRule[]>;
  readRuleRoots(
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeFilePermissionRoots>;
  relativeRuleRoots(
    target: string,
    behavior: "deny" | "ask",
    scope: NativePermissionScope,
  ): NativePermissionFact<readonly string[]>;
  physicalRuleTwins: boolean;
  fixedRuleRootsBeforeRelative: boolean;
  trustedAlias(path: string): string;
}
