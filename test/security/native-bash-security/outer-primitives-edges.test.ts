import { expect, test } from "bun:test";
import { createMainFixture } from "./main-fixture.js";
import { removal } from "./state-fixture.js";
import { createNativeBashOuterPrimitives } from "../../../src/native-bash-security/outer-primitives.js";
import { known, policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityPolicy as Policy,
} from "../../../src/native-bash-security/security-types.js";

function owner(sandboxOn = false) {
  const f = createMainFixture();
  let active = policy();
  let unsandboxedAllowed = false;
  if (sandboxOn) {
    const base = f.policyHost.sandbox;
    if (!base) throw new Error("Missing authored sandbox profile");
    f.policyHost.sandbox = (permission, s) => {
      const fact = base(permission, s);
      if (fact.status !== "known") throw new Error("Missing sandbox fact");
      return known(
        {
          ...fact.value,
          enabled: true,
          autoAllowBashIfSandboxed: true,
          autoAllowSupported: true,
          unsandboxedCommandsAllowed: unsandboxedAllowed,
        },
        s,
      );
    };
  }
  const primitives = createNativeBashOuterPrimitives(f.main, {
    livePolicy: (context, s) =>
      known(context.getAppState?.().toolPermissionContext ?? active, s),
    networkClassifierEnabled: (s) => known(true, s),
  });
  const run = <T>(callback: () => T) =>
    primitives.withPolicyScope(active, "/work", callback).result;
  async function sandboxed(
    decision: Decision,
    command: string,
    options: { remote?: boolean; disable?: boolean } = {},
  ) {
    const receipt = await f.semantic.analyze(command);
    if (receipt.kind !== "simple") throw new Error(receipt.reason);
    const context = f.context(command).context;
    if (options.remote === true) context.forRemoteExecution = true;
    return run(() =>
      primitives.native.sIr(
        decision,
        options.disable === true
          ? { command, dangerouslyDisableSandbox: true }
          : { command },
        context,
        receipt.commands,
      ),
    );
  }
  return {
    ...f,
    primitives,
    run,
    sandboxed,
    setActive(value: Policy) {
      active = value;
    },
    allowUnsandboxed() {
      unsandboxedAllowed = true;
    },
  };
}

test("primitive reads outside a policy scope fail instead of reading an unscoped policy", () => {
  const f = owner();
  expect(() =>
    f.primitives.native.zK(
      { name: "Bash", sandboxNetworkLists: f.primitives.native.Fce },
      { command: "curl x", allowed_domains: ["one.example"] },
      f.context("").context,
      undefined,
    ),
  ).toThrow("Missing native outer primitive invariant");
});

test.each([
  {
    name: "a backslash-escaped space is structure the clamp cannot verify",
    command: "cat my\\ file",
    clamps: [["Bash(cat:*)"]],
    expected: { kind: "unverifiable", span: "cat my\\ file" },
  },
  {
    name: "a malformed clamp rule admits nothing",
    command: "cat file",
    clamps: [["Bash(cat:*"]],
    expected: { kind: "unmatched", span: "cat file" },
  },
  {
    name: "an empty command has no span the clamp can verify",
    command: "",
    clamps: [["Bash(cat:*)"]],
    expected: { kind: "unverifiable", span: "" },
  },
  {
    name: "a comment-only command has no span the clamp can verify",
    command: "# cat file",
    clamps: [["Bash(cat:*)"]],
    expected: { kind: "unverifiable", span: "# cat file" },
  },
])("command clamp: $name", async ({ command, clamps, expected }) => {
  const f = owner();
  expect(
    await f.run(() => f.primitives.native.cOr({ command }, clamps)),
  ).toMatchObject(expected);
});

test.each([
  { command: "if true; then sleep 1 & fi", background: true },
  { command: "while true; do sleep 1 & done", background: true },
  { command: "echo $(sleep 1 &)", background: true },
  { command: "[[ a && b ]]", background: false },
  { command: "echo a && echo b", background: false },
])(
  "background scan of $command finds nested & operators: $background",
  async ({ command, background }) => {
    const f = owner();
    const root = await f.semantic.parse(command);
    if (!root || root === f.semantic.parseAbort)
      throw new Error("Missing authored tree");
    expect(f.primitives.native.Fbn(root)).toBe(background);
  },
);

test("background scan treats a parse error node as unverifiable background", async () => {
  const f = owner();
  const root = await f.semantic.parse("echo ) &&");
  if (!root || root === f.semantic.parseAbort)
    throw new Error("Missing authored tree");
  expect(f.primitives.native.Fbn(root)).toBe(true);
});

test("allowed-domain reader treats an array whose length cannot be read as unreadable", () => {
  const f = owner();
  const throwing = (error: Error) =>
    new Proxy(["one.example"], {
      get(_target, key) {
        if (key === "length") throw error;
        return key === "0" ? "one.example" : undefined;
      },
    });
  expect(
    f.primitives.native.Fce({
      command: "curl x",
      allowed_domains: throwing(new Error("authored unreadable length")),
    }),
  ).toBeUndefined();
  expect(() =>
    f.primitives.native.Fce({
      command: "curl x",
      allowed_domains: throwing(
        new NativeBashSecurityUnsupported("actual.length", "not supplied"),
      ),
    }),
  ).toThrow(NativeBashSecurityUnsupported);
});

const plainAsk: Decision = {
  behavior: "ask",
  message: "ordinary",
  decisionReason: { type: "other", reason: "ordinary" },
};
const allowed: Decision = { behavior: "allow", message: "inner allow" };

test("sandbox prefix rules: a deny rule replaces the inner decision", async () => {
  const f = owner(true);
  const rule = f.add("deny", "rm:*");
  const result = await f.sandboxed(allowed, "rm -rf build");
  expect(result.behavior).toBe("deny");
  expect(result.decisionReason).toEqual({ type: "rule", rule });
});

test("sandbox prefix rules: a deny rule keeps a removal ask beside it", async () => {
  const f = owner(true);
  f.add("deny", "rm:*");
  const dangerous = removal();
  const result = await f.sandboxed(dangerous, "rm -rf build");
  expect(result.behavior).toBe("deny");
  expect(result.decisionReason?.type).toBe("subcommandResults");
  if (result.decisionReason?.type === "subcommandResults")
    expect([...result.decisionReason.reasons.values()]).toContain(dangerous);
});

test("sandbox prefix rules: an ask rule replaces an allow and annotates an ordinary ask", async () => {
  const f = owner(true);
  const rule = f.add("ask", "git push:*");
  const replaced = await f.sandboxed(allowed, "git push origin");
  expect(replaced.behavior).toBe("ask");
  expect(replaced.decisionReason).toEqual({ type: "rule", rule });
  const annotated = await f.sandboxed(plainAsk, "git push origin");
  expect(annotated).toMatchObject({
    behavior: "ask",
    decisionReason: plainAsk.decisionReason,
    matchedAskRule: rule,
  });
  const asked: Decision = {
    behavior: "ask",
    message: "already ruled",
    decisionReason: { type: "rule", rule },
  };
  expect(await f.sandboxed(asked, "git push origin")).toBe(asked);
});

test("sandbox prefix rules: no matching rule keeps the inner decision", async () => {
  const f = owner(true);
  f.add("ask", "git push:*");
  expect(await f.sandboxed(plainAsk, "git status")).toBe(plainAsk);
});

test("sandbox prefix rules do not apply off the sandbox auto-allow path", async () => {
  const f = owner(true);
  f.add("deny", "rm:*");
  const deny: Decision = { behavior: "deny", message: "inner deny" };
  expect(await f.sandboxed(deny, "rm -rf build")).toBe(deny);
  expect(await f.sandboxed(allowed, "rm -rf build", { remote: true })).toBe(
    allowed,
  );
  f.setActive(policy({ sandboxAutoAllowSuspended: true }));
  expect(await f.sandboxed(allowed, "rm -rf build")).toBe(allowed);
});

test("disabling the sandbox only leaves the auto-allow path when unsandboxed commands are allowed", async () => {
  const f = owner(true);
  f.add("deny", "rm:*");
  expect(
    (await f.sandboxed(allowed, "rm -rf build", { disable: true })).behavior,
  ).toBe("deny");
  f.allowUnsandboxed();
  expect(await f.sandboxed(allowed, "rm -rf build", { disable: true })).toBe(
    allowed,
  );
});

test("sandbox prefix rules do not apply when sandboxing is off", async () => {
  const f = owner(false);
  f.add("deny", "rm:*");
  expect(await f.sandboxed(allowed, "rm -rf build")).toBe(allowed);
});
