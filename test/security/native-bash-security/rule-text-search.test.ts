import { expect, test } from "bun:test";
import {
  nativeBashTextRuleSearch as search,
  classifyNativeBashTextRule as classify,
  findNativeBashTextRule as find,
} from "../../../src/native-bash-security/rule-text-search.js";
import type { NativeBashSecurityRule as Rule } from "../../../src/native-bash-security/security-types.js";

function rule(pattern: string, source = "projectSettings"): Rule {
  return {
    source,
    ruleBehavior: "deny",
    ruleValue: { toolName: "Bash", ruleContent: pattern },
  };
}
test("native fallback text search preserves ASCII word boundaries and command option separation", () => {
  for (const text of ["confirm", "wormhole", "--rm", "rm-extra"])
    expect(search(text)(classify("rm"))).toBe(false);
  for (const text of [
    "rm /",
    "echo 'rm'",
    "command rm -- /",
    "echo ; rm /root",
  ])
    expect(search(text)(classify("rm"))).toBe(true);
  expect(search("RM /")(classify("rm"))).toBe(false);
});

test("native fallback scans continued and ANSI-decoded forms while keeping first ordered rule identity", () => {
  const certified = rule("certified: rm");
  const first = rule("rm:*");
  const later = rule("rm *", "session");
  expect(find(search("r\\\nm -rf /"), [certified, first, later])).toBe(first);
  expect(find(search("$'r\\x6d' -rf /"), [first, later])).toBe(first);
  expect(find(search("$'r\\155' -rf /"), [first, later])).toBe(first);
  expect(search("echo $'ok'; r\\x6d /")(classify("rm"))).toBe(true);
  expect(find(search("rm /"), [certified])).toBeUndefined();
});

test("native fallback wildcard fragments retain order and require a letter or number", () => {
  expect(search("rm --recursive /root")(classify("rm * /root"))).toBe(true);
  expect(search("/root rm --recursive")(classify("rm * /root"))).toBe(false);
  expect(search("rm --recursive /root-other")(classify("rm * /root"))).toBe(
    false,
  );
  for (const pattern of ["*", "**", " * ", "?", "[?!]"])
    expect(search("rm /root ? [?!]")(classify(pattern))).toBe(false);
});

test("native rule classification preserves escaped-star parity and nonempty prefix syntax", () => {
  expect(classify("git:*")).toEqual({ type: "prefix", prefix: "git" });
  expect(classify(":*")).toEqual({ type: "exact", command: ":*" });
  expect(classify("git \\*")).toEqual({ type: "exact", command: "git \\*" });
  expect(classify("git \\\\*")).toEqual({
    type: "wildcard",
    pattern: "git \\\\*",
  });
  expect(search("git *")(classify("git \\*"))).toBe(true);
  expect(search("git status")(classify("git \\*"))).toBe(false);
});
