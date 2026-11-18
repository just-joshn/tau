import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  nativeBroadBashAllow,
  nativeBroadPowerShellAllow,
  nativeBroadRunnerAllow,
} from "../../src/native-broad-rule-predicates.js";

test("Bash admission marks bare, wildcard, interpreter and wrapper prefixes broad", () => {
  for (const rule of [
    undefined,
    "",
    "*",
    "node:*",
    "python3.11 *",
    "/usr/bin/python*",
    "MODE=* harmless",
    "env python -c *",
    "bash /c *",
  ])
    assert.equal(nativeBroadBashAllow(rule), true, rule ?? "bare rule");
});

test("Bash exact commands and a selected script do not become a broad-grant verdict", () => {
  for (const rule of [
    "git status",
    "git status *",
    "node ./owned-script.js",
    "node ./owned-script.js *",
    "echo \\*",
    "harmless-prefix *",
  ])
    assert.equal(nativeBroadBashAllow(rule), false, rule);
});

test("source Python module exception requires a dotted module and the exact trailing shape", () => {
  assert.equal(nativeBroadBashAllow("python -m package.module *"), false);
  assert.equal(nativeBroadBashAllow("python -m package *"), true);
  assert.equal(nativeBroadBashAllow("python -c *"), true);
});

test("generic runner classifier retains command-specific option/subcommand scanning", () => {
  const runners = ["kubectl", "curl", "wget", "aws"];
  for (const rule of [
    "kubectl --context owned exec *",
    "kubectl apply *",
    "aws --profile owned *",
    "curl --silent *",
  ])
    assert.equal(nativeBroadRunnerAllow(rule, runners), true, rule);
  for (const rule of [
    "kubectl get pods *",
    "kubectl --context=owned get pods *",
    "wget https://owned.invalid/file *",
    "curl --output https://owned.invalid/file *",
  ])
    assert.equal(nativeBroadRunnerAllow(rule, runners), false, rule);
});

test("generic dynamic runner options are broad while an unrelated exact command stays narrow", () => {
  assert.equal(nativeBroadRunnerAllow("curl --url $OWNED *", ["curl"]), true);
  assert.equal(nativeBroadRunnerAllow("kubectl get pods", ["kubectl"]), false);
  assert.equal(nativeBroadRunnerAllow("*", []), true);
});

test("PowerShell admission retains aliases, executable variants and case folding", () => {
  for (const rule of [
    undefined,
    "",
    "*",
    "Invoke-Expression *",
    "START-PROCESS.exe -Wait *",
    "python.exe -c *",
    "npm.exe run *",
    "pwsh:*",
    "add-type *",
  ])
    assert.equal(nativeBroadPowerShellAllow(rule), true, rule ?? "bare rule");
  for (const rule of [
    "Get-Content ./owned.txt",
    "Get-Content ./owned.txt *",
    "Write-Output literal",
    "python ./owned-script.py",
  ])
    assert.equal(nativeBroadPowerShellAllow(rule), false, rule);
});
