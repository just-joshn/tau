import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  combineToolPolicy,
  matchingToolRule,
  parseToolPolicy,
  type PermissionRuleBehavior,
  type ToolPolicy,
} from "../../src/tool-policy.js";

const cli = (behavior: "allow" | "deny", ...rules: string[]): ToolPolicy =>
  parseToolPolicy(
    behavior === "allow" ? { allowedTools: rules } : { disallowedTools: rules },
  );
const settings = (behavior: PermissionRuleBehavior, rule: string) =>
  combineToolPolicy(parseToolPolicy({}), [
    { source: "projectSettings", behavior, rule },
  ]);
const decides = (
  policy: ToolPolicy,
  behavior: PermissionRuleBehavior,
  name: string,
  input?: unknown,
) =>
  matchingToolRule(
    policy,
    behavior,
    name,
    input === undefined ? {} : { input },
  ) !== undefined;

test("INV-01 a CLI Read(key:pattern) deny blocks only that tool's matching primitive argument", () => {
  const policy = cli("deny", "Read(file_path:/secret/*)");
  assert.ok(decides(policy, "deny", "Read", { file_path: "/secret/a" }));
  assert.ok(!decides(policy, "deny", "Read", { file_path: "/public/a" }));
  assert.ok(!decides(policy, "deny", "Write", { file_path: "/secret/a" }));
  assert.ok(!decides(policy, "deny", "Read", { path: "/secret/a" }));
  assert.ok(!decides(policy, "deny", "Read"));
  assert.ok(!decides(policy, "deny", "Read", null));
  assert.ok(
    !decides(cli("deny", "Read(file_path:*)"), "deny", "Read", {
      file_path: { nested: "/secret/a" },
    }),
  );
});

test("INV-01 a CLI Bash(key:pattern) deny matches number and boolean arguments by their text", () => {
  assert.ok(
    decides(cli("deny", "Bash(timeout:5000)"), "deny", "Bash", {
      command: "sleep 1",
      timeout: 5000,
    }),
  );
  assert.ok(
    decides(cli("deny", "Bash(run_in_background:true)"), "deny", "Bash", {
      command: "sleep 1",
      run_in_background: true,
    }),
  );
});

test("INV-01 a CLI Read(key:pattern) allow never preapproves the call", () => {
  assert.ok(
    !decides(cli("allow", "Read(file_path:/tmp/*)"), "allow", "Read", {
      file_path: "/tmp/a",
    }),
  );
});

test("INV-01 other CLI deny rules neither match nor break a Read decision", () => {
  const policy = cli(
    "deny",
    "TaskStop(shell-1)",
    "Write",
    "Write(file_path:/x)",
    "Read(/x)",
  );
  assert.equal(
    matchingToolRule(policy, "deny", "Read", { input: { file_path: "/x" } }),
    undefined,
  );
});

test("INV-01 a settings Read path rule without a non-empty key:pattern is never a primitive argument deny", () => {
  // Read(file_pathX) has no colon, and Read(file_path:) has an empty pattern.
  // Both stay path rules for the dedicated host, so the generic matcher ignores them.
  assert.ok(
    !decides(settings("deny", "Read(file_pathX)"), "deny", "Read", {
      file_path: "file_pathX",
    }),
  );
  assert.ok(
    !decides(settings("deny", "Read(file_path:)"), "deny", "Read", {
      file_path: " ",
    }),
  );
});

test("INV-01 settings key:pattern rules on built-ins without a dedicated consumer are rejected", () => {
  for (const rule of ["Grep(pattern:secret)", "Glob(path:/x)"])
    assert.throws(
      () => settings("deny", rule),
      /Unsupported settings permission rule/,
      rule,
    );
});
