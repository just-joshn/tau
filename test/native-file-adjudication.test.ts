import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  adjudicateNativeFileEdit,
  adjudicateNativeFileRead,
  type NativeFileAdjudicationHost,
  type NativeFileAdjudicationPolicy,
  type NativeFileAdjudicationResult,
  type NativeFilePermissionInspection,
} from "../src/native-file-adjudication.js";
import type {
  NativePermissionFact,
  NativePermissionOutcome,
  NativePermissionRule,
} from "../src/native-permission-outcome.js";

type Input = { file_path: string };
const scope = { policyId: "authored-policy", cwd: "/actual/evaluation" };
const fact = <T>(value: T): NativePermissionFact<T> => ({
  status: "known",
  value,
  provenance: {
    provider: "authored-fixture",
    sourceContracts: ["TO/iA"],
    scope,
  },
});
const pass: NativePermissionOutcome<Input> = {
  behavior: "passthrough",
  message: "",
};
const ask: NativePermissionOutcome<Input> = {
  behavior: "ask",
  message: "actual classifier ask",
};
const deny: NativePermissionOutcome<Input> = {
  behavior: "deny",
  message: "actual deny",
};
const rule: NativePermissionRule = {
  source: "userSettings",
  ruleBehavior: "allow",
  ruleValue: { toolName: "Read", ruleContent: "./selected.md" },
};
const input = { file_path: "/owned/selected.md" };
const tool = { name: "Read", getPath: (value: Input) => value.file_path };
const policy: NativeFileAdjudicationPolicy = {
  scope,
  mode: "default",
  restricted: false,
  alwaysAllowRules: {},
};
const inspection: NativeFilePermissionInspection = {
  requested: input.file_path,
  spellings: [input.file_path],
  unresolved: false,
  landing: input.file_path,
  leafIsSymlink: false,
};
function host(
  changes: Partial<NativeFileAdjudicationHost<Input>> = {},
): NativeFileAdjudicationHost<Input> {
  return {
    inspect: () => fact(inspection),
    normalize: (path) => fact(path),
    format: (path) => fact(path),
    unresolvedPathText: (path) =>
      fact({ quotedPath: `quoted:${path}`, reason: `guard:${path}` }),
    matchRule: () => fact(null),
    allowAlias: (path) => fact(path),
    readProtection: () => fact({}),
    outsideReadBlock: () => fact(false),
    readFence: () => fact(null),
    servedReadFenceAskStaysDenied: () => fact(false),
    networkRead: () => fact(null),
    readBypassAvailable: () => fact(false),
    writeFloor: () => fact(undefined),
    sessionEditRuleEligible: () => fact(false),
    writePathShape: () =>
      fact({ suspiciousNetwork: false, nestedConfigDirectories: 0 }),
    protectedWrite: () => fact(pass),
    sensitiveWrite: () => fact({ safe: true }),
    writeNote: () => fact(null),
    specialSessionWriteRule: () => fact(null),
    inWorkingDirectories: () => fact(false),
    wholeToolAllow: () => fact(null),
    protectedRead: () => fact(pass),
    modelReadMode: () => fact(false),
    suggestions: () => fact([]),
    outsideAsk: () =>
      fact({
        message: "actual outside-root ask",
        decisionReason: { type: "workingDir", reason: "actual root boundary" },
      }),
    ...changes,
  };
}
function outcome(
  result: NativeFileAdjudicationResult<Input>,
): NativePermissionOutcome<Input> {
  if (result.status !== "decided")
    throw new Error(`${result.dependency}: ${result.reason}`);
  return result.outcome;
}
const read = (
  changes: Partial<NativeFileAdjudicationHost<Input>> = {},
  state: Partial<NativeFileAdjudicationPolicy> = {},
  selected: NativeFilePermissionInspection = inspection,
) =>
  adjudicateNativeFileRead({
    tool,
    input,
    policy: { ...policy, ...state },
    host: host(changes),
    inspection: selected,
  });
const edit = (
  changes: Partial<NativeFileAdjudicationHost<Input>> = {},
  state: Partial<NativeFileAdjudicationPolicy> = {},
  selected: NativeFilePermissionInspection = inspection,
) =>
  adjudicateNativeFileEdit({
    tool: { ...tool, name: "Edit" },
    input,
    policy: { ...policy, ...state },
    host: host(changes),
    inspection: selected,
  });

test("missing getPath asks without consuming path, mode or classifier facts", () => {
  const result = adjudicateNativeFileRead({
    tool: { name: "Unknown" },
    input,
    policy,
    host: {},
  });
  assert.equal(outcome(result).behavior, "ask");
  assert.deepEqual(result.facts, []);
});

test("Read deny traverses spellings first and stops before protection or edit implication", () => {
  const order: string[] = [];
  const result = read(
    {
      matchRule: (path, _state, family, behavior) => {
        order.push(`${family}:${behavior}:${path}`);
        return fact(path === "/resolved" ? rule : null);
      },
      readProtection: () => {
        throw new Error("must not reach protected floor");
      },
    },
    {},
    { ...inspection, spellings: ["/original", "/resolved"] },
  );
  assert.equal(outcome(result).decisionReason?.type, "rule");
  assert.equal(outcome(result).behavior, "deny");
  assert.deepEqual(order, ["read:deny:/original", "read:deny:/resolved"]);
});

test("paused-memory and session read floors precede network and rules", () => {
  assert.equal(
    outcome(
      read({
        readProtection: () => fact({ memoryPausedFloor: deny }),
        networkRead: () => {
          throw new Error("network is later");
        },
      }),
    ).behavior,
    "deny",
  );
  const result = outcome(
    read({
      readProtection: () =>
        fact({ sessionDenyReason: "retained history floor" }),
    }),
  );
  assert.deepEqual(result.decisionReason, {
    type: "other",
    reason: "retained history floor",
  });
});

test("served fenced reads convert actual deny to hard ask only in the source branch", () => {
  const changes = {
    outsideReadBlock: () => fact(true),
    readFence: () => fact(deny),
  };
  const result = outcome(read(changes, { servedCall: true }));
  assert.equal(result.behavior, "ask");
  assert.equal(result.decisionReason?.type, "safetyCheck");
  assert.equal(
    outcome(read(changes, { servedCall: true, restricted: true })).behavior,
    "deny",
  );
  assert.equal(
    outcome(
      read(changes, {
        servedCall: true,
        blockFileToolReadsOutsideWorkingDirectories: true,
      }),
    ).behavior,
    "deny",
  );
  assert.equal(
    outcome(
      read(
        { ...changes, servedReadFenceAskStaysDenied: () => fact(true) },
        { servedCall: true },
      ),
    ).behavior,
    "deny",
  );
});

test("unresolved read keeps actual diagnostic and reason facts and cannot cross a null fence", () => {
  const unresolved: NativeFilePermissionInspection = {
    requested: input.file_path,
    spellings: [input.file_path],
    unresolved: true,
    stoppedAt: "/owned",
    reason: "unexamined",
    leafIsSymlink: false,
  };
  const result = outcome(read({}, {}, unresolved));
  assert.equal(result.behavior, "deny");
  assert.deepEqual(result.decisionReason, {
    type: "other",
    reason: `guard:${input.file_path}`,
  });
  assert.match(result.message ?? "", /quoted:/);
  assert.equal(
    read({ outsideReadBlock: () => fact(true) }, {}, unresolved).status,
    "unsupported",
  );
  assert.equal(edit({}, {}, unresolved).status, "unsupported");
});

test("network floor exception requires nonserved bypass plus an actual explicit Read ask", () => {
  const network = { ...ask, message: "network floor" };
  const changes = {
    networkRead: () => fact(network),
    readBypassAvailable: () => fact(true),
    matchRule: (
      _path: string,
      _state: NativeFileAdjudicationPolicy,
      family: "read" | "edit",
      behavior: "allow" | "deny" | "ask",
    ) => fact(family === "read" && behavior === "ask" ? rule : null),
  };
  assert.equal(outcome(read(changes)).decisionReason?.type, "rule");
  assert.equal(
    outcome(read(changes, { servedCall: true })).message,
    "network floor",
  );
  assert.equal(
    outcome(read({ ...changes, matchRule: () => fact(null) })).message,
    "network floor",
  );
});

test("Read ask beats Edit implication and Edit receives plan/write-fence overrides", () => {
  assert.equal(
    outcome(
      read({
        matchRule: (_path, _state, family, behavior) =>
          fact(family === "read" && behavior === "ask" ? rule : null),
        writeFloor: () => {
          throw new Error("Edit implication is later");
        },
      }),
    ).decisionReason?.type,
    "rule",
  );
  let seen: NativeFileAdjudicationPolicy | undefined;
  const original = {
    ...policy,
    mode: "plan",
    blockWritesOutsideWorkingDirectories: true,
  };
  const result = adjudicateNativeFileRead({
    tool,
    input,
    policy: original,
    inspection,
    host: host({
      writeFloor: (_path, _inspection, _normal, state) => {
        seen = state;
        return fact({
          behavior: "allow",
          updatedInput: input,
          decisionReason: { type: "rule", rule },
        });
      },
    }),
  });
  assert.equal(outcome(result).behavior, "allow");
  assert.equal(seen?.mode, "default");
  assert.equal(seen?.blockWritesOutsideWorkingDirectories, false);
  assert.equal(original.mode, "plan");
  assert.equal(original.blockWritesOutsideWorkingDirectories, true);
});

test("known working-dir Read allow is a real mode-default branch after failed Edit implication", () => {
  const result = outcome(
    read({
      protectedWrite: () => fact(ask),
      inWorkingDirectories: () => fact(true),
      protectedRead: () => {
        throw new Error("working dir is earlier");
      },
    }),
  );
  assert.deepEqual(result, {
    behavior: "allow",
    updatedInput: input,
    decisionReason: { type: "mode", mode: "default" },
  });
});

test("served internal Read allow is skipped while actual scoped Read allow still applies", () => {
  const changes = {
    protectedRead: () =>
      fact({
        behavior: "allow",
        updatedInput: input,
      } satisfies NativePermissionOutcome<Input>),
    matchRule: (
      _path: string,
      _state: NativeFileAdjudicationPolicy,
      family: "read" | "edit",
      behavior: "allow" | "ask" | "deny",
    ) => fact(family === "read" && behavior === "allow" ? rule : null),
  };
  assert.equal(outcome(read(changes)).decisionReason, undefined);
  assert.equal(
    outcome(read(changes, { servedCall: true })).decisionReason?.type,
    "rule",
  );
});

test("eligible session Edit allow precedes ask but plan and dangerous path shapes exclude it", () => {
  const sessionRule = { ...rule, source: "session" };
  const changes = {
    sessionEditRuleEligible: () => fact(true),
    matchRule: (
      _path: string,
      state: NativeFileAdjudicationPolicy,
      _family: "read" | "edit",
      behavior: "allow" | "ask" | "deny",
    ) =>
      fact(
        behavior === "allow" && Object.keys(state.alwaysAllowRules).length === 1
          ? sessionRule
          : behavior === "ask"
            ? rule
            : null,
      ),
  };
  const state = { alwaysAllowRules: { session: ["Edit(~/.claude/**)"] } };
  assert.equal(outcome(edit(changes, state)).behavior, "allow");
  assert.equal(
    outcome(edit(changes, { ...state, mode: "plan" })).behavior,
    "ask",
  );
  assert.equal(
    outcome(
      edit(
        {
          ...changes,
          writePathShape: () =>
            fact({ suspiciousNetwork: false, nestedConfigDirectories: 2 }),
        },
        state,
      ),
    ).behavior,
    "ask",
  );
});

test("Edit ask and protected classifier floor precede sensitivity and mode acceptance", () => {
  assert.equal(
    outcome(
      edit(
        {
          matchRule: (_path, _state, _family, behavior) =>
            fact(behavior === "ask" ? rule : null),
          protectedWrite: () => {
            throw new Error("ask is earlier");
          },
        },
        { mode: "acceptEdits" },
      ),
    ).behavior,
    "ask",
  );
  assert.equal(
    outcome(
      edit(
        {
          protectedWrite: () => fact(deny),
          sensitiveWrite: () => {
            throw new Error("protected verdict is earlier");
          },
        },
        { mode: "acceptEdits" },
      ),
    ).behavior,
    "deny",
  );
  assert.equal(
    outcome(
      edit(
        {
          protectedWrite: () =>
            fact({ behavior: "allow", updatedInput: input }),
        },
        { mode: "plan" },
      ),
    ).behavior,
    "allow",
  );
});

test("unsafe writes retain source circuit/also/link and restricted/person-only facts", () => {
  const result = outcome(
    edit(
      {
        sensitiveWrite: () =>
          fact({
            safe: false,
            message: "sensitive",
            classifierApprovable: true,
            circuitBreaker: "claudeSettingsFile",
            also: ["suspiciousWindowsPath"],
          }),
        writeNote: () =>
          fact({
            landing: "/outside",
            sentence: "actual link",
            personOnly: true,
          }),
      },
      { restricted: true },
    ),
  );
  assert.equal(result.blockedPath, "/outside");
  assert.equal(result.message, "sensitive actual link.");
  assert.deepEqual(result.decisionReason, {
    type: "safetyCheck",
    reason: "sensitive actual link.",
    classifierApprovable: false,
    circuitBreaker: "restrictedMode",
    also: ["claudeSettingsFile", "suspiciousWindowsPath"],
  });
});

test("safe plan write asks before whole-tool allow and acceptEdits needs working scope", () => {
  assert.deepEqual(
    outcome(
      edit(
        {
          wholeToolAllow: () => {
            throw new Error("plan is earlier");
          },
        },
        { mode: "plan" },
      ),
    ).decisionReason,
    { type: "mode", mode: "plan" },
  );
  assert.deepEqual(
    outcome(
      edit(
        {
          inWorkingDirectories: () => fact(true),
          wholeToolAllow: () => {
            throw new Error("mode is earlier");
          },
        },
        { mode: "acceptEdits" },
      ),
    ).decisionReason,
    { type: "mode", mode: "acceptEdits" },
  );
  assert.equal(outcome(edit({}, { mode: "acceptEdits" })).behavior, "ask");
});

test("scoped Edit allow requires each spelling and can use only an actual alias fact", () => {
  const selected = { ...inspection, spellings: ["/one", "/two"] };
  const changes = {
    matchRule: (
      path: string,
      _state: NativeFileAdjudicationPolicy,
      _family: "read" | "edit",
      behavior: "allow" | "ask" | "deny",
    ) =>
      fact(
        behavior === "allow" && (path === "/one" || path === "/alias")
          ? rule
          : null,
      ),
  };
  assert.equal(outcome(edit(changes, {}, selected)).behavior, "ask");
  assert.equal(
    outcome(
      edit(
        {
          ...changes,
          allowAlias: (path) => fact(path === "/two" ? "/alias" : path),
        },
        {},
        selected,
      ),
    ).behavior,
    "allow",
  );
});

test("missing and foreign host facts fail explicitly instead of falling through to mode", () => {
  const missing = host();
  delete missing.writeFloor;
  assert.equal(
    adjudicateNativeFileEdit({
      tool,
      input,
      policy: { ...policy, mode: "acceptEdits" },
      host: missing,
      inspection,
    }).status,
    "unsupported",
  );
  const foreign = read({
    readProtection: () => ({
      status: "known",
      value: {},
      provenance: {
        provider: "foreign",
        sourceContracts: ["TO"],
        scope: { ...scope, cwd: "/foreign" },
      },
    }),
  });
  assert.equal(foreign.status, "unsupported");
  if (foreign.status === "unsupported")
    assert.equal(foreign.dependency, "host-scope");
});

test("native lexical path spaces are retained and model-read gate is separately factual", () => {
  const spaced = { file_path: " /owned/selected.md " },
    seen: string[] = [];
  let modelGate: boolean | undefined;
  const before = structuredClone(policy);
  const result = adjudicateNativeFileRead({
    tool,
    input: spaced,
    policy,
    forTheModelHere: true,
    host: host({
      inspect: (path) => {
        seen.push(path);
        return fact({
          ...inspection,
          requested: path,
          spellings: [path],
          landing: path,
        });
      },
      modelReadMode: () => fact(true),
      protectedRead: (_path, _input, _spellings, _policy, options) => {
        modelGate = options.forTheModelHere;
        return fact(pass);
      },
    }),
  });
  assert.equal(outcome(result).behavior, "ask");
  assert.deepEqual(seen, [spaced.file_path]);
  assert.equal(modelGate, false);
  assert.deepEqual(policy, before);
});
