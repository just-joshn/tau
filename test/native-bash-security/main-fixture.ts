import { posix } from "node:path";
import { createNativeIgnoreBackend } from "../../src/native-file-permission-host.js";
import { createStateFixture } from "./state-fixture.js";
import { createNativeBashDescendantDeny } from "../../src/native-bash-security/descendant-deny.js";
import { createNativeBashCwdReadControl } from "../../src/native-bash-security/cwd-read-control.js";
import { createNativeBashSecurityGitStructure } from "../../src/native-bash-security/git-structure.js";
import { createNativeBashSecurityPipelineControl } from "../../src/native-bash-security/pipeline-control.js";
import { createNativeBashMainControl } from "../../src/native-bash-security/main-control.js";
import { known, policy } from "./security-fixture.js";
import { type NativeBashSecurityRule as Rule } from "../../src/native-bash-security/security-types.js";

export function createMainFixture() {
  const f = createStateFixture();
  const permissionCalls: string[] = [];
  const denyRead = new Map<string, Rule>();
  const denyEdit = new Map<string, Rule>();
  const originalSandbox = f.policyHost.sandbox;
  if (!originalSandbox) throw new Error("Missing authored sandbox profile");
  f.policyHost.sandbox = (permission, s) => {
    const fact = originalSandbox(permission, s);
    if (fact.status !== "known")
      throw new Error("Missing authored sandbox profile");
    return known(
      {
        ...fact.value,
        enabled: false,
        autoAllowBashIfSandboxed: false,
        autoAllowSupported: false,
      },
      s,
    );
  };
  f.policyHost.protectedRoots = (s) => known([], s);
  f.policyHost.workingDirectories = (_permission, s) => known(["/work"], s);
  f.policyHost.suggestionDirectory = (path, s) => known(posix.dirname(path), s);
  f.policyHost.readDirectorySuggestion = (path, destination, s) =>
    known(
      {
        type: "addRules",
        rules: [{ toolName: "Read", ruleContent: path + "/**" }],
        behavior: "allow",
        destination,
      },
      s,
    );
  f.policyHost.nativePathSpelling = (path, s) =>
    known(posix.normalize(path.trim()), s);
  f.policyHost.originalWorkingDirectory = (s) => known("/work", s);
  f.policyHost.fileDenyRules = (family, _permission, s) =>
    known([...(family === "read" ? denyRead : denyEdit).values()], s);
  f.policyHost.securityFeature = (_kind, _key, _fallback, s) => known(true, s);
  f.policyHost.feature = (_key, _fallback, s) =>
    known({ value: true, source: "authored-test" }, s);
  f.policyHost.mountedDriveRmPromptDisabled = (s) => known(false, s);
  f.policyHost.filePolicy.matchRule = (
    path,
    permission,
    family,
    behavior,
    s,
  ) => {
    permissionCalls.push(
      `${family}:${behavior}:${path}:${permission.scope.policyId}:${s.cwd}`,
    );
    return known(
      behavior === "deny"
        ? ((family === "read" ? denyRead : denyEdit).get(path) ?? null)
        : null,
      s,
    );
  };
  const descendant = createNativeBashDescendantDeny(f.syntax.policy, {
    platformProfile: "macos",
    compileErrorMessage: (pattern, s) =>
      known(createNativeIgnoreBackend().validate(pattern), s),
    denyReadRules: (_permission, s) => known([...denyRead.values()], s),
    denialRelativeRoots: (_permission, _path, s) => known(["/work"], s),
  });
  const cwd = createNativeBashCwdReadControl(f.syntax, descendant, {
    statDirectory: (_path, s) =>
      known({ status: "stat", isDirectory: true }, s),
    delightfulGoblet: (s) => known(false, s),
    cozyRaven: (s) => known(true, s),
  });
  const git = createNativeBashSecurityGitStructure(
    f.semantic,
    f.syntax.preparation,
    f.syntax.policy.pathOwner,
    f.policyHost,
  );
  const pipeline = createNativeBashSecurityPipelineControl(
    f.semantic,
    f.syntax.preparation,
    git,
    f.shapes.outcomes,
    f.syntax.policy.native.El,
    {
      currentCwd: (s) => known(s.cwd, s),
      duplicatePipeReasons: (s) => known(true, s),
    },
  );
  let main: ReturnType<typeof createNativeBashMainControl> | undefined;
  main = createNativeBashMainControl(
    f.state,
    cwd,
    pipeline,
    {
      currentCwd: (s) => known(s.cwd, s),
      livePolicy: (context, s) => {
        const read = f.stateHost.livePolicy;
        if (!read) throw new Error("Missing authored live policy");
        return read(context, s);
      },
      replaceLastCheckedSessionEnvVarKeys: (_keys, s) => known(undefined, s),
      amberLarch: (s) => known(true, s),
      telemetry: (_event, _metadata, s) => known(undefined, s),
      reportError: (error) => {
        throw error;
      },
      isAbortError: (_error, s) => known(false, s),
    },
    async (...args) => {
      if (!main)
        throw new Error("Main authored test callback was not connected");
      return main.native.nIe(...args);
    },
  );
  const mainOwner = main;
  async function run(command: string, permission = policy()) {
    const context = f.context(command).context;
    return mainOwner.withPolicyScope(permission, "/work", () =>
      mainOwner.native.nIe({ command }, context),
    ).result;
  }
  function deny(path: string, family: "read" | "edit") {
    const rule: Rule = {
      source: "projectSettings",
      ruleBehavior: "deny",
      ruleValue: {
        toolName: family === "read" ? "Read" : "Edit",
        ruleContent: "/" + path,
      },
    };
    (family === "read" ? denyRead : denyEdit).set(path, rule);
    f.denied.push(rule);
    return rule;
  }
  return {
    ...f,
    main: mainOwner,
    run,
    deny,
    permissionCalls,
    denyRead,
    denyEdit,
  };
}
