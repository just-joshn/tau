import { expect, test } from "bun:test";
import { win32 } from "node:path";
import { createNativeBashSecurityFileGate } from "../../../src/native-bash-security/file-gate.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityFileHost as Host,
  NativeBashSecurityFileOperation as Operation,
  NativeBashSecurityInspection as Inspection,
  NativeBashSecurityLinkNote as LinkNote,
  NativeBashSecurityPolicy as Policy,
  NativeBashSecurityRule as Rule,
  NativeBashSecuritySensitivePath as Sensitive,
} from "../../../src/native-bash-security/security-types.js";
import { fixture, known, policy } from "./security-fixture.js";

interface Patch {
  host?: Partial<Omit<Host, "filesystem" | "filePolicy">>;
  filesystem?: Partial<Host["filesystem"]>;
  filePolicy?: Partial<Host["filePolicy"]>;
}

const allowRule: Rule = {
  source: "localSettings",
  ruleBehavior: "allow",
  ruleValue: { toolName: "Edit", ruleContent: "/outside/**" },
};

function resolved(path: string): Inspection {
  return {
    requested: path,
    landing: path,
    spellings: [path],
    unresolved: false,
    leafIsSymlink: false,
  };
}

function unresolved(path: string): Inspection {
  return {
    requested: path,
    spellings: [path],
    unresolved: true,
    stoppedAt: path,
    reason: "past-a-link",
    leafIsSymlink: true,
  };
}

// A virtual disk: `links` maps a link path to its target. Paths in `missing`
// and any path that contains a glob character do not exist, so canonical
// walks climb past them.
function disk(
  links: ReadonlyMap<string, string>,
  missing: ReadonlySet<string> = new Set(),
): Partial<Host["filesystem"]> {
  return {
    canonical(path, s) {
      const target = links.get(path);
      return known(
        target === undefined
          ? {
              resolvedPath: path,
              isCanonical: !/[*?[]/.test(path) && !missing.has(path),
              isSymlink: false,
            }
          : { resolvedPath: target, isCanonical: true, isSymlink: true },
        s,
      );
    },
    spellings(path, s) {
      const target = links.get(path);
      return known(target === undefined ? [path] : [path, target], s);
    },
  };
}

function build(options: Parameters<typeof fixture>[0] = {}, patch: Patch = {}) {
  const f = fixture(options);
  const host: Host = {
    ...f.host,
    ...patch.host,
    filesystem: { ...f.host.filesystem, ...patch.filesystem },
    filePolicy: { ...f.host.filePolicy, ...patch.filePolicy },
  };
  const gate = createNativeBashSecurityFileGate(f.semantic, host, f.receipts);
  return {
    ...f,
    host,
    gate,
    check: (
      path: string,
      operation: Operation = "read",
      p: Policy = policy(),
      cwd = "/work",
    ) => gate.check(path, cwd, p, operation),
    scoped: <T>(run: () => T, p: Policy = policy()) =>
      gate.withPolicyScope(p, "/work", run),
  };
}

function safety(reason: Decision["decisionReason"]) {
  if (reason?.type !== "safetyCheck")
    throw new Error(`expected a safety check, got ${reason?.type}`);
  return reason;
}

test("helpers used outside a policy scope refuse instead of guessing a scope", () => {
  const f = build();
  expect(() => f.gate.native.D1("file", "/work", policy(), "read")).toThrow(
    "Missing native file-gate invariant",
  );
});

test("Windows network spellings are held as UNC paths, local spellings are not", () => {
  const f = build({}, { host: { platform: "windows" } });
  const network: [string, boolean][] = [
    ["\\\\server\\share\\file", true],
    ["//server/share/file", true],
    ["\\??\\C:\\x", true],
    ["\\.\\??\\x", true],
    ["-o\\\\server\\share", true],
    ["--output=//server/share/x", true],
    ["-I--x=//server/share/x", true],
    ["x\\\\host\\share", true],
    ["x=/??/c", true],
    ["a//host/x", true],
    ["=/\\host\\x", true],
    ["=\\/host/x", true],
    ["file@SSL@443", true],
    ["file@443@SSL", true],
    ["DavWWWRoot\\x", true],
    ["-oC:\\x", false],
    ["-x", false],
    ["--out=", false],
    ["--out=C:\\x", false],
    ["C:\\work\\file", false],
    ["http://host/x", false],
  ];
  for (const [path, expected] of network)
    expect([path, f.gate.bindings.tP(path, true)]).toEqual([path, expected]);
  // A bare argument (not a redirect or path operand) keeps the strict
  // separator shapes: a single slash-backslash run is not a share.
  const bare: [string, boolean][] = [
    ["a\\\\/host", true],
    ["=/\\host\\x", false],
    ["C:\\x", false],
  ];
  for (const [path, expected] of bare)
    expect([path, f.gate.bindings.tP(path)]).toEqual([path, expected]);
  const unc = f.check("\\\\server\\share\\file");
  expect(unc).toEqual({
    allowed: false,
    resolvedPath: "\\\\server\\share\\file",
    decisionReason: {
      type: "other",
      reason: "UNC network paths require manual approval",
    },
  });
  expect(build().gate.bindings.tP("//server/share", true)).toBe(false);
});

test("Windows percent expansion and traversal stay unresolved", () => {
  const f = build({}, { host: { platform: "windows" } });
  expect(f.check("C:\\work\\%TEMP%\\x", "read", policy(), "C:\\work")).toEqual({
    allowed: false,
    resolvedPath: "C:\\work\\%TEMP%\\x",
    decisionReason: {
      type: "other",
      reason: "Shell expansion syntax in paths requires manual approval",
    },
  });
  const traversal = f.check("C:\\work\\a\\..\\b", "read", policy(), "C:\\work");
  expect(traversal.allowed).toBe(false);
  expect(traversal.decisionReason).toEqual({
    type: "other",
    reason:
      "Path contains '..' traversal after a directory segment, which may follow a symlink outside the working directory",
  });
  expect(f.gate.native.cYn("a\\b/c")).toEqual(["a", "b", "c", "a\\b", "c"]);
  expect(f.gate.native.Zje("a\\..\\b")).toBe(true);
  expect(build().gate.native.Zje("a\\..\\b")).toBe(false);
});

test("traversal resolves through the real parent and surfaces a stronger refusal", () => {
  const denied = build({ deny: "/etc/passwd" });
  const read = denied.check("/work/../etc/passwd");
  expect(read.allowed).toBe(false);
  expect(read.resolvedPath).toBe("/etc/passwd");
  expect(read.decisionReason?.type).toBe("rule");
  // Climbing above / stays at /.
  expect(denied.check("/work/../../etc/passwd").decisionReason?.type).toBe(
    "rule",
  );

  const fenced = build({ outsideBlocked: true });
  const outside = fenced.check(
    "a/../../secret",
    "read",
    policy({ blockReadsOutsideWorkingDirectories: true }),
  );
  expect(outside.resolvedPath).toBe("/secret");
  expect(safety(outside.decisionReason).circuitBreaker).toBe(
    "outsideReadsBlocked",
  );

  // Inside the working directory the traversal itself is the only concern.
  const inside = build().check("/work/a/../b");
  expect(inside.decisionReason).toEqual({
    type: "other",
    reason:
      "Path contains '..' traversal after a directory segment, which may follow a symlink outside the working directory",
  });

  // A parent that is itself a link cannot be climbed lexically.
  const linked = build(
    { deny: "/etc/passwd" },
    {
      filesystem: {
        canonical: (path, s) =>
          known(
            {
              resolvedPath: path,
              isCanonical: path !== "/work/link",
              isSymlink: false,
            },
            s,
          ),
      },
    },
  );
  expect(linked.check("/work/link/../../etc/passwd").decisionReason?.type).toBe(
    "other",
  );
});

test("write traversal checks the landing and reports a carried-out link landing", () => {
  const denied = build({ writeDeny: "/work/out" });
  const write = denied.check("/work/a/../out", "write");
  expect(write).toMatchObject({ allowed: false, resolvedPath: "/work/out" });
  expect(write.decisionReason?.type).toBe("rule");

  // An overrideable in-directory write gives way to the traversal hold.
  expect(build().check("/work/a/../out", "write").decisionReason?.type).toBe(
    "other",
  );

  const note: LinkNote = {
    landing: "/outside/real",
    landingOutside: true,
    spellingInside: true,
    carriedOut: true,
  };
  const carried = build(
    {},
    {
      filePolicy: { symlinkNote: (_i, _p, s) => known(note, s) },
    },
  );
  const result = carried.check("/work/a/../out", "create");
  expect(result.resolvedPath).toBe("/outside/real");
  expect(safety(result.decisionReason)).toEqual({
    type: "safetyCheck",
    reason:
      "/work/a/../out resolves through a symlink to /outside/real, which is outside the allowed working directories",
    classifierApprovable: false,
  });
  // The plain write path reports the same carried-out landing.
  expect(carried.check("/work/out", "write").resolvedPath).toBe(
    "/outside/real",
  );
});

test("a glob before '..' cannot be checked against the read block or Read denies", () => {
  const blocked = policy({ blockReadsOutsideWorkingDirectories: true });
  const withReadDeny = policy({
    alwaysDenyRules: { projectSettings: ["Read(/secret)"] },
  });
  const otherDeny = policy({
    alwaysDenyRules: { projectSettings: ["Bash(rm:*)"], session: undefined },
  });
  const f = build();
  for (const path of ["/work/*/../secret", "/work/[a/../b]"]) {
    for (const p of [blocked, withReadDeny]) {
      const r = f.check(path, "read", p);
      expect(r.resolvedPath).toBe(path);
      expect(safety(r.decisionReason).circuitBreaker).toBe(
        "outsideReadsBlocked",
      );
    }
    expect(f.check(path, "read", otherDeny).decisionReason?.type).toBe("other");
  }
  expect(f.check("/work/a/../b", "read", blocked).decisionReason?.type).toBe(
    "other",
  );
  // A Read deny on the climbed landing still wins over the glob hold.
  const denied = build({ deny: "/work/secret" });
  expect(
    denied.check("/work/*/../secret", "read", blocked).decisionReason?.type,
  ).toBe("rule");
});

test("glob reads are checked at the deepest existing directory", () => {
  const f = build(
    { outsideBlocked: true, deny: "/work/link" },
    { filesystem: disk(new Map([["/work/link", "/outside/target"]])) },
  );
  const blocked = policy({ blockReadsOutsideWorkingDirectories: true });
  expect(f.check("/outside/*.txt", "read", blocked).resolvedPath).toBe(
    "/outside",
  );
  expect(f.check("*.txt").resolvedPath).toBe("/work");
  expect(f.check("/*", "read", blocked).resolvedPath).toBe("/");
  expect(build().check("/work/file[12].txt").allowed).toBe(true);
  // A Read deny on a link spelling applies when the policy has deny rules.
  const withDeny = policy({
    alwaysDenyRules: { projectSettings: ["Read(/work/link)"] },
  });
  const viaGlob = f.check("/work/link/*.txt", "read", withDeny);
  expect(viaGlob.resolvedPath).toBe("/outside/target");
  expect(viaGlob.decisionReason?.type).toBe("rule");
  const direct = f.check("/work/link", "read", withDeny);
  expect(direct.decisionReason?.type).toBe("rule");
  // Without any deny rules only the landing is consulted.
  expect(f.check("/work/link").decisionReason?.type).not.toBe("rule");
  // Earlier sessions make ask rules count as well.
  const earlier = build(
    { deny: "/work/link" },
    {
      host: { earlierSessionIds: (_p, s) => known(["old"], s) },
      filesystem: disk(new Map([["/work/link", "/outside/target"]])),
    },
  );
  const asked = policy({ alwaysAskRules: { session: ["Read(/x)"] } });
  expect(earlier.check("/work/link", "read", asked).decisionReason?.type).toBe(
    "rule",
  );
  expect(f.check("/work/link", "read", asked).decisionReason?.type).not.toBe(
    "rule",
  );
});

test("glob base directories follow the platform separator", () => {
  const f = build({}, { host: { platform: "windows" } });
  const native = f.gate.native;
  expect(native.bol("C:\\work\\*.txt")).toBe("C:\\work");
  expect(native.bol("C:/work/sub\\*.txt")).toBe("C:/work/sub");
  expect(native.bol("plain")).toBe("plain");
  expect(native.bol("*.txt")).toBe(".");
  expect(build().gate.native.bol("C:\\work\\*.txt")).toBe(".");
  expect(build().gate.native.bol("/*")).toBe("/");
});

test("Unresolvable link inspections are held by operation and mode", () => {
  const f = build(
    {},
    {
      filesystem: {
        inspect: (path, s) => known(unresolved(path), s),
        canonicalInspection: (path, s) => known(unresolved(path), s),
      },
    },
  );
  const reason =
    "Where /work/file leads on disk could not be determined (a link or directory on the way could not be examined, or the links do not resolve)";
  expect(f.check("file").decisionReason).toEqual({ type: "other", reason });
  expect(f.check("file", "write").decisionReason).toEqual({
    type: "safetyCheck",
    reason,
    classifierApprovable: false,
  });
  expect(f.check("file", "write", policy({ restricted: true }))).toEqual({
    allowed: false,
    resolvedPath: "/work/file",
    decisionReason: {
      type: "safetyCheck",
      reason,
      classifierApprovable: false,
      circuitBreaker: "restrictedMode",
    },
  });
  expect(
    safety(f.check("file", "read", policy({ restricted: true })).decisionReason)
      .circuitBreaker,
  ).toBe("restrictedMode");
});

test("file-tool read blocks are reported with their own setting name", () => {
  const seen: (boolean | undefined)[] = [];
  const f = build(
    {},
    {
      filePolicy: {
        outsideReadBlocked: (_path, _spellings, p, s) => {
          seen.push(p.blockFileToolReadsOutsideWorkingDirectories);
          return known(true, s);
        },
      },
    },
  );
  const r = f.check(
    "/outside/file",
    "read",
    policy({ blockFileToolReadsOutsideWorkingDirectories: true }),
  );
  expect(safety(r.decisionReason)).toEqual({
    type: "safetyCheck",
    reason:
      "Reads outside the working directories are blocked (permissions.blockFileToolReadsOutsideWorkingDirectories).",
    classifierApprovable: false,
    circuitBreaker: "outsideReadsBlocked",
  });
  // Bash reads only see the Bash read block, never the file-tool setting.
  expect(seen).toEqual([false]);
});

test("protected-write allows grant only outside served calls", () => {
  const grant: Decision = {
    behavior: "allow",
    decisionReason: { type: "other", reason: "settings file" },
  };
  const f = build(
    {},
    { filePolicy: { protectedWrite: (_p, _s, _q, s) => known(grant, s) } },
  );
  expect(f.check("/outside/file", "write")).toEqual({
    allowed: true,
    resolvedPath: "/outside/file",
    decisionReason: { type: "other", reason: "settings file" },
  });
  expect(
    f.check("/outside/file", "write", policy({ servedCall: true })).allowed,
  ).toBe(false);
});

test("protected reads deny with a demoted reason and allow outside served calls", () => {
  const decisions: Decision[] = [
    {
      behavior: "deny",
      decisionReason: {
        type: "safetyCheck",
        reason: "transcript",
        classifierApprovable: false,
      },
    },
    {
      behavior: "deny",
      decisionReason: { type: "other", reason: "plain" },
    },
    {
      behavior: "allow",
      decisionReason: { type: "other", reason: "internal file" },
    },
  ];
  const options: { forTheModelHere?: boolean }[] = [];
  let next: Decision = { behavior: "passthrough" };
  const f = build(
    {},
    {
      filePolicy: {
        protectedRead: (_path, _spellings, _p, o, s) => {
          options.push(o);
          return known(next, s);
        },
      },
    },
  );
  const results = decisions.map((d) => {
    next = d;
    return f.check("/outside/file");
  });
  expect(results).toEqual([
    {
      allowed: false,
      resolvedPath: "/outside/file",
      decisionReason: {
        type: "other",
        reason: "transcript",
        wasSafetyCheck: true,
      },
    },
    {
      allowed: false,
      resolvedPath: "/outside/file",
      decisionReason: { type: "other", reason: "plain" },
    },
    {
      allowed: true,
      resolvedPath: "/outside/file",
      decisionReason: { type: "other", reason: "internal file" },
    },
  ]);
  expect(options.every((o) => o.forTheModelHere === true)).toBe(true);
  expect(
    f.check("/outside/file", "read", policy({ servedCall: true })),
  ).toEqual({
    allowed: false,
    resolvedPath: "/outside/file",
    refusedByDefault: true,
    isInWorkingDir: false,
  });
  // Sending a file to the model is never a read for the model here.
  options.length = 0;
  f.scoped(() => f.gate.native.Qje("/outside/file", policy()));
  expect(options.map((o) => o.forTheModelHere)).toEqual([false]);
});

test("allow rules grant only when every spelling, or its trusted alias, is allowed", () => {
  const matches = new Set(["/outside/a", "/trusted/b"]);
  const f = build(
    {},
    {
      filesystem: {
        inspect: (path, s) =>
          known(
            {
              ...resolved(path),
              spellings:
                path === "/outside/ab" ? ["/outside/a", "/outside/b"] : [path],
            },
            s,
          ),
      },
      filePolicy: {
        matchRule: (path, _p, _family, behavior, s) =>
          known(
            behavior === "allow" && matches.has(path) ? allowRule : null,
            s,
          ),
        trustedAlias: (path, s) =>
          known(path === "/outside/b" ? "/trusted/b" : path, s),
      },
    },
  );
  expect(f.check("/outside/ab", "write")).toEqual({
    allowed: true,
    resolvedPath: "/outside/ab",
    decisionReason: { type: "rule", rule: allowRule },
  });
  expect(f.check("/outside/c", "write").allowed).toBe(false);
});

test("served machines, served calls and stopped sandboxes never use sandbox write roots", () => {
  const sandbox = (onButNotRunning: boolean, short = false) => ({
    enabled: true,
    onButNotRunning,
    storedDenyListsMayBeShort: short,
    allowOnly: ["/outside"],
    denyWithinAllow: ["/outside/keep"],
    autoAllowSupported: false,
    autoAllowBashIfSandboxed: false,
    unsandboxedCommandsAllowed: false,
    unsandboxedCommandsDisabled: false,
  });
  const running = build(
    {},
    { host: { sandbox: (_p, s) => known(sandbox(false), s) } },
  );
  expect(running.check("/outside/file", "write").allowed).toBe(true);
  expect(running.check("/outside/keep/file", "write").allowed).toBe(false);
  expect(
    running.check("/outside/file", "write", policy({ servedCall: true }))
      .allowed,
  ).toBe(false);
  const served = build(
    { sandbox: true },
    { host: { servedMachine: (_p, s) => known(true, s) } },
  );
  expect(served.check("/outside/file", "write").allowed).toBe(false);
  const stopped = build(
    {},
    { host: { sandbox: (_p, s) => known(sandbox(true), s) } },
  );
  expect(stopped.check("/outside/file", "write").allowed).toBe(false);
  const short = build(
    {},
    { host: { sandbox: (_p, s) => known(sandbox(false, true), s) } },
  );
  expect(short.check("/outside/file", "write").allowed).toBe(false);
  // Config paths are resolved once per root.
  let lookups = 0;
  const counted = build(
    { sandbox: true },
    {
      filesystem: {
        spellings: (path, s) => {
          lookups += 1;
          return known([path], s);
        },
      },
    },
  );
  counted.scoped(() => {
    expect(counted.gate.native.pyn("/outside/a")).toBe(true);
    expect(counted.gate.native.pyn("/outside/b")).toBe(true);
  });
  expect(lookups).toBe(3);
});

test("sensitive writes merge internal denies, link notes and restricted mode", () => {
  const internal: Decision = {
    behavior: "deny",
    message: "internal deny",
    decisionReason: { type: "rule", rule: allowRule },
  };
  const settings: Decision = {
    behavior: "deny",
    decisionReason: {
      type: "safetyCheck",
      reason: "settings file",
      classifierApprovable: false,
      circuitBreaker: "claudeSettingsFile",
    },
  };
  const sensitive: Sensitive = {
    safe: false,
    message: "sensitive path",
    classifierApprovable: true,
    circuitBreaker: "connectorFileSend",
    also: ["isolatePeerMachines"],
  };
  function run(
    protectedWrite: Decision,
    sensitivity: Sensitive,
    note: { sentence: string; personOnly: boolean } | null,
    writeProtected: boolean,
    p: Policy = policy(),
  ) {
    const remote: boolean[] = [];
    const f = build(
      {},
      {
        filePolicy: {
          protectedWrite: (_a, _b, _c, s) => known(protectedWrite, s),
          sensitiveWrite: (_a, _b, _c, o, s) => {
            remote.push(o.remote);
            return known(sensitivity, s);
          },
          writeNote: (_a, _b, _c, s) => known(note, s),
          pathWriteProtected: (_a, _b, s) => known(writeProtected, s),
        },
      },
    );
    return { result: f.check("/work/file", "write", p), remote };
  }
  const plain = run({ behavior: "passthrough" }, sensitive, null, false);
  expect(plain.result.decisionReason).toEqual({
    type: "safetyCheck",
    reason: "sensitive path",
    classifierApprovable: true,
    circuitBreaker: "connectorFileSend",
    also: ["isolatePeerMachines"],
  });
  expect(plain.remote).toEqual([false]);

  const merged = run(
    internal,
    { safe: false, message: "sensitive path.", classifierApprovable: true },
    { sentence: "It is a link", personOnly: false },
    false,
  );
  expect(merged.result.decisionReason).toEqual({
    type: "safetyCheck",
    reason: "sensitive path. It is a link.",
    classifierApprovable: false,
    also: ["internalHardDeny"],
  });

  const fromSettings = run(
    settings,
    { safe: false, message: "sensitive path.", classifierApprovable: true },
    { sentence: "It is a link", personOnly: true },
    true,
  );
  expect(fromSettings.result.decisionReason).toEqual({
    type: "safetyCheck",
    reason: "settings file. It is a link.",
    classifierApprovable: false,
    circuitBreaker: "claudeSettingsFile",
    also: ["internalHardDeny"],
  });

  const restricted = run(
    { behavior: "passthrough" },
    sensitive,
    null,
    false,
    policy({ restricted: true }),
  );
  expect(restricted.result.decisionReason).toEqual({
    type: "safetyCheck",
    reason: "sensitive path",
    classifierApprovable: false,
    circuitBreaker: "restrictedMode",
    also: ["connectorFileSend", "isolatePeerMachines"],
  });

  // Remote sessions ask the sensitive-path check about remote rules.
  const remoteCases: [Partial<Policy>, boolean][] = [
    [{ isRemoteMode: true }, true],
    [{ isRemoteMode: true, restricted: true }, false],
    [{ isRemoteMode: true, mode: "auto" }, false],
    [{ isRemoteMode: true, mode: "plan", prePlanMode: "auto" }, false],
    [{ isRemoteMode: true, mode: "plan", strippedDangerousRules: true }, false],
    [{ isRemoteMode: true, mode: "plan" }, true],
    [{ isRemoteMode: true, modeBeforeRewrite: "auto" }, false],
  ];
  for (const [options, expected] of remoteCases)
    expect([
      options,
      run({ behavior: "passthrough" }, sensitive, null, false, policy(options))
        .remote,
    ]).toEqual([options, [expected]]);
});

test("internal hard denies on safe paths carry link sentences and restricted circuits", () => {
  function run(
    protectedWrite: Decision,
    note: LinkNote | null,
    writeProtected: boolean,
    p: Policy = policy(),
  ) {
    const f = build(
      {},
      {
        filePolicy: {
          protectedWrite: (_a, _b, _c, s) => known(protectedWrite, s),
          symlinkNote: (_a, _b, s) => known(note, s),
          pathWriteProtected: (_a, _b, s) => known(writeProtected, s),
        },
      },
    );
    return f.check("/work/file", "write", p).decisionReason;
  }
  const insideNote: LinkNote = {
    landing: "/work/real",
    landingOutside: false,
    spellingInside: true,
    carriedOut: false,
  };
  const deny: Decision = { behavior: "deny", message: "hard deny" };
  expect(run(deny, insideNote, true)).toEqual({
    type: "safetyCheck",
    reason: "hard deny. /work/file resolves through a symlink to /work/real.",
    classifierApprovable: true,
    circuitBreaker: "internalHardDeny",
  });
  expect(run(deny, insideNote, false)).toEqual({
    type: "safetyCheck",
    reason: "hard deny. /work/file resolves through a symlink to /work/real.",
    classifierApprovable: false,
    circuitBreaker: "internalHardDeny",
  });
  expect(
    run(
      {
        behavior: "deny",
        decisionReason: {
          type: "safetyCheck",
          reason: "settings.",
          classifierApprovable: false,
          circuitBreaker: "unfinishedCheck",
        },
      },
      null,
      false,
      policy({ restricted: true }),
    ),
  ).toEqual({
    type: "safetyCheck",
    reason: "settings.",
    classifierApprovable: false,
    circuitBreaker: "restrictedMode",
    also: ["internalHardDeny", "unfinishedCheck"],
  });
  expect(run(deny, null, false, policy({ restricted: true }))).toEqual({
    type: "safetyCheck",
    reason: "hard deny",
    classifierApprovable: false,
    circuitBreaker: "restrictedMode",
    also: ["internalHardDeny"],
  });
  // A host-only circuit keeps its own name with the internal hard deny.
  expect(
    run(
      {
        behavior: "deny",
        decisionReason: {
          type: "safetyCheck",
          reason: "settings",
          classifierApprovable: false,
          circuitBreaker: "claudeSettingsFile",
        },
      },
      insideNote,
      true,
    ),
  ).toEqual({
    type: "safetyCheck",
    reason: "settings. /work/file resolves through a symlink to /work/real.",
    classifierApprovable: false,
    circuitBreaker: "claudeSettingsFile",
    also: ["internalHardDeny"],
  });
  expect(
    run({ behavior: "deny", message: "done." }, insideNote, true),
  ).toMatchObject({
    reason: "done. /work/file resolves through a symlink to /work/real.",
  });
  expect(() =>
    run(
      { behavior: "deny", decisionReason: { type: "rule", rule: allowRule } },
      null,
      false,
    ),
  ).toThrow();
});

test("decision helpers keep reasons, person-only circuits and refusal shape", () => {
  const n = build().gate.native;
  expect(n.eVr({ type: "other", reason: "o" })).toBe("o");
  expect(n.eVr({ type: "rule", rule: allowRule })).toBeUndefined();
  expect(n.eVr(undefined)).toBeUndefined();
  const person: Extract<Decision["decisionReason"], { type: "safetyCheck" }> = {
    type: "safetyCheck",
    reason: "r",
    classifierApprovable: false,
  };
  expect(n.tVr({ ...person, circuitBreaker: "claudeSettingsFile" })).toBe(
    "claudeSettingsFile",
  );
  expect(
    n.tVr({ ...person, circuitBreaker: "dangerousRemoval" }),
  ).toBeUndefined();
  expect(
    n.tVr({
      ...person,
      circuitBreaker: "dangerousRemoval",
      also: ["unfinishedCheck"],
    }),
  ).toBe("dangerousRemoval");
  expect(n.tVr(person)).toBeUndefined();
  expect(n.tVr({ type: "other", reason: "o" })).toBeUndefined();
  expect(
    n.IAt({ allowed: false, refusedByDefault: true, isInWorkingDir: false }),
  ).toBe(true);
  expect(
    n.IAt({ allowed: true, refusedByDefault: true, isInWorkingDir: false }),
  ).toBe(false);
  expect(n.IAt({ allowed: false, isInWorkingDir: false })).toBe(false);
  expect(
    n.IAt({
      allowed: false,
      refusedByDefault: true,
      isInWorkingDir: false,
      decisionReason: { type: "other", reason: "x" },
    }),
  ).toBe(false);
  expect(
    n.IAt({ allowed: false, refusedByDefault: true, isInWorkingDir: true }),
  ).toBe(false);
  expect(n.Zzr(["a", "b"])).toBe("'a', 'b'");
  expect(n.Zzr(["a", "b", "c", "d", "e", "f", "g"])).toBe(
    "'a', 'b', 'c', 'd', 'e', and 2 more",
  );
  expect(n.uYn("/work/a/../b")).toBe(false);
});

// Path primitives a Windows-aware host would supply. They are deliberately
// small: enough to give each critical-path shape a concrete spelling.
function criticalHost(
  platform: Host["platform"],
  home: string,
  links = new Map<string, string>(),
): Patch {
  const shortName = (long: string, short: string) =>
    short.toLowerCase() === long.toLowerCase() ||
    (short.includes("~") &&
      long
        .toLowerCase()
        .startsWith(short.toLowerCase().slice(0, short.indexOf("~"))));
  return {
    host: {
      platform,
      home: (s) => known(home, s),
      pathPrimitive: (kind, path, s) => {
        switch (kind) {
          case "o7n":
            return known(win32.normalize(path), s);
          case "Do":
            return known(path.toLowerCase(), s);
          case "y4": {
            const trimmed = path.replace(/[ .]+$/, "");
            return known(
              trimmed === "" && path.startsWith("..")
                ? ".."
                : trimmed === ""
                  ? "."
                  : path,
              s,
            );
          }
          default:
            return known(path, s);
        }
      },
      networkHostShape: (path, s) =>
        known(
          /^\\\\localhost\\$/i.test(path)
            ? "own_host"
            : /^\\\\[\d.]+\\$/.test(path)
              ? "numeric_host"
              : undefined,
          s,
        ),
      windowsPathAliases: (homeRest, pathRest, s) => {
        const want = homeRest.split("/");
        const got = pathRest.split("/");
        return known(
          [want.filter((segment, i) => !shortName(segment, got[i] ?? ""))],
          s,
        );
      },
    },
    filesystem: disk(links),
  };
}

test("critical removal targets on macOS cover roots, top-level folders, home and globs", () => {
  const f = build(
    {},
    criticalHost(
      "macos",
      "/home/test",
      new Map([["/home/test", "/Users/test"]]),
    ),
  );
  const cases: [string, boolean][] = [
    ["/", true],
    ["/etc", true],
    ["/etc/", true],
    ["/private/etc", true],
    ["/private/etc/hosts", false],
    ["/./etc", true],
    ["/.vol/1/2", true],
    ["/home/test", true],
    ["/HOME/TEST", true],
    ["/Users/test", true],
    ["*", true],
    ["/work/*", true],
    ["/work/project", false],
    ["//?/C:/x", true],
    ["//server/admin$", true],
    ["//10.0.0.1/c$/x", true],
    ["//other/c$/x", false],
    ["//server/share/x", false],
    ["/.", true],
    ["", false],
    ["//localhost/c$", true],
    ["//localhost/c$/Users", true],
    ["//localhost/c$/Users/me", false],
  ];
  f.scoped(() => {
    for (const [path, expected] of cases)
      expect([path, f.gate.native.Blt(path)]).toEqual([path, expected]);
  });
  const linux = build({}, criticalHost("linux", "/home/test"));
  linux.scoped(() => {
    expect(linux.gate.native.Blt("/.vol/1/2")).toBe(false);
    expect(linux.gate.native.Blt("/private/etc")).toBe(false);
  });
});

test("critical removal targets on Windows cover drive roots, system folders and home aliases", () => {
  const f = build({}, criticalHost("windows", "C:/Users/testuser-long"));
  const cases: [string, boolean][] = [
    ["C:\\", true],
    ["C:", true],
    ["C:\\Windows", true],
    ["C:\\x\\.. ", true],
    ["C:\\Users\\testuser-long", true],
    ["C:\\Users\\TESTUS~1", true],
    ["C:\\Users\\other", false],
    ["D:\\Users\\test", false],
    ["C:\\work\\project", false],
  ];
  f.scoped(() => {
    for (const [path, expected] of cases)
      expect([path, f.gate.native.Blt(path)]).toEqual([path, expected]);
  });
  const share = build({}, criticalHost("windows", "//localhost/c$/Users/test"));
  share.scoped(() => {
    expect(share.gate.native.Blt("C:\\Users\\test")).toBe(true);
    expect(share.gate.native.Blt("C:\\Users\\else")).toBe(false);
  });
});

test("missing paths and leading parent segments resolve lexically", () => {
  const f = build(
    { deny: "/work/missing", writeDeny: "/work/out" },
    { filesystem: disk(new Map(), new Set(["/work/missing", "/work/gone"])) },
  );
  // A missing file is checked at its own spelling.
  expect(f.check("/work/missing").decisionReason?.type).toBe("rule");
  expect(f.check("/work/a/../missing").decisionReason?.type).toBe("rule");
  // A glob under a missing directory stops at that directory.
  const glob = f.check("/work/gone/*.txt");
  expect(glob).toEqual({ allowed: true, resolvedPath: "/work/gone" });
  // A leading '..' has no directory before it to follow.
  expect(f.check("../x").resolvedPath).toBe("/x");
  expect(f.gate.native.cYn("a//b")).toEqual(["a", "b"]);
  // An empty deny-rule bucket does not make links consult extra spellings.
  const linked = build(
    { deny: "/work/link" },
    { filesystem: disk(new Map([["/work/link", "/outside/target"]])) },
  );
  expect(
    linked.check(
      "/work/link",
      "read",
      policy({ alwaysDenyRules: { session: undefined } }),
    ).decisionReason?.type,
  ).not.toBe("rule");
  // A write whose landing cannot be resolved is checked at the climbed path.
  const lost = build(
    { writeDeny: "/work/out" },
    { filesystem: { inspect: (path, s) => known(unresolved(path), s) } },
  );
  expect(lost.check("/work/a/../out", "write").decisionReason?.type).toBe(
    "rule",
  );
});
