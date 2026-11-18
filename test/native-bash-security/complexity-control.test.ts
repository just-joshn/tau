import { expect, test } from "bun:test";
import { createComplexityFixture as owner } from "./complexity-fixture.js";
import { policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
} from "../../src/native-bash-security/security-types.js";
test("native complex sandbox admission requires genuine dispatch facts and rejects source structure hazards", () => {
  const f = owner();
  const direct = (command: string, kind: string | undefined = "command") =>
    f.run(() => f.complex.native._Or({ command }, policy(), kind));
  expect(direct("echo hello")?.decisionReason).toMatchObject({
    type: "other",
    reason: "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)",
  });
  for (const text of [
    "cat <<EOF",
    "echo ${!DYNAMIC}",
    "cat /proc/self/environ",
    "jq . file",
    "awk '{ print }' file",
  ])
    expect(direct(text)).toBeNull();
  expect(direct("echo hello", "ERROR")).toBeNull();
  expect(
    f.run(() =>
      f.complex.native._Or({ command: "echo hello" }, policy(), undefined),
    ),
  ).toBeNull();
  expect(direct("env echo hello")?.behavior).toBe("allow");
  expect(direct("echo $(compute)")?.behavior).toBe("allow");
  delete f.host.sandboxPolicyDataSuspended;
  expect(() => direct("echo hello")).toThrow(NativeBashSecurityUnsupported);
});

test("native complex sandbox rules retain deny before ask and source suspended-policy gate", () => {
  const f = owner();
  const ask = f.add("ask", "echo *");
  expect(
    f.run(() =>
      f.complex.native._Or({ command: "echo value" }, policy(), "command"),
    )?.decisionReason,
  ).toMatchObject({ type: "rule", rule: ask });
  const deny = f.add("deny", "echo *");
  expect(
    f.run(() =>
      f.complex.native._Or({ command: "echo value" }, policy(), "command"),
    )?.decisionReason,
  ).toMatchObject({ type: "rule", rule: deny });
  expect(
    f.run(() =>
      f.complex.native._Or(
        { command: "echo value" },
        policy({ sandboxAutoAllowSuspended: true }),
        "command",
      ),
    ),
  ).toBeNull();
});

test("native semantic sandbox admission refuses tilde-user and unsafe environment records", async () => {
  const f = owner();
  const safe = await f.analyze("echo value");
  expect(
    f.run(() =>
      f.complex.native.elt(
        { command: "echo value" },
        policy(),
        safe.commands,
        safe.bareAssignmentNames,
        f.context("").context,
      ),
    )?.behavior,
  ).toBe("allow");
  const tilde = await f.analyze("echo ~other");
  expect(
    f.run(() =>
      f.complex.native.elt(
        { command: "echo ~other" },
        policy(),
        tilde.commands,
        tilde.bareAssignmentNames,
        f.context("").context,
      ),
    ),
  ).toBeNull();
  const unsafe = await f.analyze(
    "NODE_OPTIONS=--require=/tmp/hook node script.js",
  );
  expect(
    f.run(() =>
      f.complex.native.elt(
        { command: "NODE_OPTIONS=--require=/tmp/hook node script.js" },
        policy(),
        unsafe.commands,
        unsafe.bareAssignmentNames,
        f.context("").context,
      ),
    ),
  ).toBeNull();
  expect(
    f.complex.native.vCe("CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER"),
  ).toBe(true);
  expect(f.complex.native.I8e("pythonpath")).toBe(true);
});

test("native complex text deny is found before read-block callback and retains the ordered rule", async () => {
  const f = owner();
  const command = "if true; then $'r\\x6d' -rf /; fi";
  const deny = f.add("deny", "rm:*");
  const tree = await f.semantic.parse(command);
  if (tree === f.semantic.parseAbort) throw new Error("Expected authored tree");
  const state = f.context(command);
  const result = await f.run(() =>
    f.complex.native.AOr(
      { command },
      policy(),
      tree,
      "ERROR",
      () => {
        throw new Error("Read callback should follow deny");
      },
      undefined,
      false,
      state,
      state.context,
    ),
  );
  expect(result?.behavior).toBe("deny");
  expect(result?.decisionReason).toMatchObject({ type: "rule", rule: deny });
  expect(f.events).toEqual(["tengu_bash_rule_found_in_text:deny"]);
});

test("native source filter excludes command-scoped text rules and explicit read-block floor remains", async () => {
  const f = owner();
  f.raw.deny.push({
    source: "command",
    ruleBehavior: "deny",
    ruleValue: { toolName: "Bash", ruleContent: "rm:*" },
  });
  const command = "echo 'rm /'";
  const tree = await f.semantic.parse(command);
  if (tree === f.semantic.parseAbort) throw new Error("Expected authored tree");
  const state = f.context(command);
  const floor: Decision = {
    behavior: "ask",
    decisionReason: {
      type: "safetyCheck",
      reason: "authored read block",
      circuitBreaker: "outsideReadsBlocked",
      classifierApprovable: false,
    },
  };
  expect(
    await f.run(() =>
      f.complex.native.AOr(
        { command },
        policy(),
        tree,
        "ERROR",
        () => floor,
        undefined,
        false,
        state,
        state.context,
      ),
    ),
  ).toBe(floor);
  expect(f.events).toEqual([]);
});

test("native exact allow on parse abort is controlled by the actual tender-quill feature", async () => {
  const f = owner();
  const command = "echo value";
  const allow = f.add("allow", command);
  const state = f.context(command);
  expect(
    await f.run(() =>
      f.complex.native.AOr(
        { command },
        policy(),
        f.semantic.parseAbort,
        "PARSE_ABORT",
        undefined,
        undefined,
        false,
        state,
        state.context,
      ),
    ),
  ).toBeNull();
  f.setTender(false);
  const result = await f.run(() =>
    f.complex.native.AOr(
      { command },
      policy(),
      f.semantic.parseAbort,
      "PARSE_ABORT",
      undefined,
      undefined,
      false,
      state,
      state.context,
    ),
  );
  expect(result?.decisionReason).toMatchObject({ type: "rule", rule: allow });
});
