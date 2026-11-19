import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  matchNativeBashRule,
  matchNativeBashText,
  matchNativeFileRules,
  parseNativePermissionRule,
  prepareNativeFileRule,
  type NativeFileMatchOptions,
  type NativeFileRule,
  type NativeIgnoreBackend,
} from "../../src/native-permission-rules.js";

// Deliberately bounded authored backend. These fixtures test orchestration, not node-ignore parity.
const ignore: NativeIgnoreBackend = {
  validate(pattern) {
    return pattern.includes("[") ? "fixture rejects unclosed bracket" : null;
  },
  test(patterns, relativePath) {
    let ignored = false;
    let matched: string | undefined;
    for (const pattern of patterns) {
      const negative = pattern.startsWith("!");
      const body = (negative ? pattern.slice(1) : pattern).replace(/^\//, "");
      const regex =
        body === "**"
          ? ".*"
          : body
              .split("*")
              .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
              .join("[^/]*");
      const prefix =
        body.includes("/") || pattern.startsWith("/") ? "^" : "(?:^|/)";
      if (new RegExp(prefix + regex + "(?:/|$)", "i").test(relativePath)) {
        ignored = !negative;
        matched = negative ? undefined : pattern;
      }
    }
    return matched === undefined ? { ignored } : { ignored, pattern: matched };
  },
};
function rule(text: string, source = "session"): NativeFileRule {
  return { rule: parseNativePermissionRule(text), source };
}
function env(): NativeFileMatchOptions {
  return {
    platform: "posix",
    cwd: "/workspace",
    home: "/owned-home",
    sourceRoot: (source) =>
      source === "userSettings" ? "/user-config" : "/project-root",
    ignore,
    toolName: "Write",
    behavior: "deny",
    rules: [],
    targetSpellings: ["/workspace/private.txt"],
    candidateRoots: () => ["/workspace", "/additional"],
    physicalTwins: () => [],
    trustedAlias: (path) => path,
    fixedRootsBeforeRelative: true,
  };
}

test("native parser preserves escapes, aliases, empty and star whole-tool rules", () => {
  assert.deepEqual(parseNativePermissionRule("Task(owned\\(task\\))"), {
    kind: "call",
    toolName: "Agent",
    content: "owned(task)",
    original: "Task(owned\\(task\\))",
  });
  assert.deepEqual(parseNativePermissionRule("Bash(echo \\\\path)"), {
    kind: "call",
    toolName: "Bash",
    content: "echo \\path",
    original: "Bash(echo \\\\path)",
  });
  for (const text of ["Write()", "Write(*)"])
    assert.equal(parseNativePermissionRule(text).kind, "bare");
  assert.equal(parseNativePermissionRule("Read(a(b)c)").kind, "call");
  assert.equal(parseNativePermissionRule("Eval").kind, "bare");
  assert.deepEqual(
    parseNativePermissionRule("Eval", { evalAliasEnabled: true }),
    { kind: "bare", toolName: "REPL", original: "Eval" },
  );
  assert.equal(parseNativePermissionRule("Read\\(literal\\)").kind, "bare");
  const malformed = parseNativePermissionRule("Read(private.txt)junk");
  assert.equal(malformed.kind, "malformed");
  if (malformed.kind === "malformed")
    assert.equal(malformed.nativeFallbackToolName, "Read(private.txt)junk");
});
test("file rule root syntax is source scoped and never expands arbitrary environment variables", () => {
  const options = env();
  for (const [text, root, pattern] of [
    ["/x", "/project-root", "/x"],
    ["//x", "/", "/x"],
    ["~/x", "/owned-home", "/x"],
    ["./x", null, "x"],
    ["$HOME/x", null, "$HOME/x"],
  ]) {
    const result = prepareNativeFileRule(
      rule(`Edit(${text})`),
      "deny",
      options,
    );
    assert.equal(result.status, "prepared");
    if (result.status === "prepared") {
      assert.equal(result.value.root, root);
      assert.equal(result.value.pattern, pattern);
    }
  }
  const user = prepareNativeFileRule(
    rule("Read(/x)", "userSettings"),
    "allow",
    options,
  );
  assert.equal(user.status, "prepared");
  if (user.status === "prepared") assert.equal(user.value.root, "/user-config");
});
test("Windows absolute drive, double slash drive and tilde-backslash forms", () => {
  const options = {
    ...env(),
    platform: "windows",
    home: "C:\\owned",
  } satisfies NativeFileMatchOptions;
  for (const text of ["C:\\safe\\file", "//c/safe/file"]) {
    const result = prepareNativeFileRule(
      rule(`Edit(${text.replaceAll("\\", "\\\\")})`),
      "deny",
      options,
    );
    assert.equal(result.status, "prepared");
    if (result.status === "prepared") {
      assert.equal(result.value.root, "C:\\");
      assert.equal(result.value.pattern, "/safe/file");
    }
  }
  const home = prepareNativeFileRule(rule("Read(~\\\\safe)"), "deny", options);
  if (home.status === "prepared") {
    assert.equal(home.value.root, "C:\\owned");
    assert.equal(home.value.pattern, "/safe");
  } else assert.fail(home.reason);
});
test("unusable grants drop; deny patterns broaden, negative deny patterns drop", () => {
  assert.equal(
    prepareNativeFileRule(rule("Read(#comment)"), "allow", env()).status,
    "dropped",
  );
  const denied = prepareNativeFileRule(rule("Read([broken)"), "deny", env());
  assert.equal(denied.status, "prepared");
  if (denied.status === "prepared") {
    assert.equal(denied.value.pattern, "**");
    assert.match(denied.value.diagnostics.join(), /broadened/);
  }
  assert.equal(
    prepareNativeFileRule(rule("Read(![broken)"), "deny", env()).status,
    "dropped",
  );
  assert.equal(
    prepareNativeFileRule(rule("Read(!)"), "ask", env()).status,
    "dropped",
  );
});
test("directory suffix treatment differs for allow and deny", () => {
  const allow = prepareNativeFileRule(rule("Read(src/**)"), "allow", env());
  const deny = prepareNativeFileRule(rule("Read(src/**)"), "deny", env());
  if (allow.status !== "prepared" || deny.status !== "prepared")
    return assert.fail();
  assert.equal(allow.value.matcherPattern, "/src");
  assert.equal(deny.value.matcherPattern, "src");
});
test("Write/Edit share Edit content family; Write content is not an Edit grant", () => {
  const options = { ...env(), rules: [rule("Write(private.txt)")] };
  assert.equal(matchNativeFileRules(options).status, "no-match");
  for (const toolName of ["Write", "Edit"]) {
    if (toolName !== "Write" && toolName !== "Edit") continue;
    const result = matchNativeFileRules({
      ...options,
      toolName,
      rules: [rule("Edit(private.txt)")],
    });
    assert.equal(result.status, "matched");
  }
  assert.equal(
    matchNativeFileRules({
      ...options,
      toolName: "Read",
      rules: [rule("Edit(private.txt)")],
    }).status,
    "no-match",
  );
});
test("deny groups cannot negate a different source; newest matching group wins", () => {
  const first = rule("Edit(private.txt)", "userSettings");
  const second = rule("Edit(!private.txt)", "session");
  const result = matchNativeFileRules({ ...env(), rules: [first, second] });
  assert.equal(result.status, "matched");
  if (result.status === "matched") assert.equal(result.rule, first);
  const latest = rule("Edit(private.txt)", "session");
  const newer = matchNativeFileRules({ ...env(), rules: [first, latest] });
  if (newer.status === "matched") assert.equal(newer.rule, latest);
  else assert.fail();
  assert.equal(
    matchNativeFileRules({
      ...env(),
      rules: [first, rule("Edit(!private.txt)", "userSettings")],
    }).status,
    "no-match",
  );
});
test("allows combine sources, deduplicate last content, and require every path spelling", () => {
  const first = rule("Edit(private.txt)", "userSettings");
  const second = rule("Edit(private.txt)", "session");
  const base = {
    ...env(),
    behavior: "allow",
    rules: [first, second],
  } satisfies NativeFileMatchOptions;
  const result = matchNativeFileRules(base);
  if (result.status === "matched") assert.equal(result.rule, second);
  else assert.fail();
  assert.equal(
    matchNativeFileRules({
      ...base,
      targetSpellings: ["/workspace/private.txt", "/outside/physical.txt"],
    }).status,
    "no-match",
  );
  const denied = matchNativeFileRules({
    ...base,
    behavior: "deny",
    targetSpellings: ["/outside/physical.txt", "/workspace/private.txt"],
  });
  assert.equal(denied.status, "matched");
});
test("relative deny searches host extra roots; allow stays live cwd", () => {
  const base = {
    ...env(),
    rules: [rule("Read(private.txt)")],
    toolName: "Read",
    targetSpellings: ["/additional/private.txt"],
  } satisfies NativeFileMatchOptions;
  assert.equal(matchNativeFileRules(base).status, "matched");
  assert.equal(
    matchNativeFileRules({ ...base, behavior: "allow" }).status,
    "no-match",
  );
});
test("physical deny twins and verified allow aliases remain explicit callbacks", () => {
  const base = { ...env(), rules: [rule("Edit(/safe/private.txt)")] };
  assert.equal(
    matchNativeFileRules({
      ...base,
      targetSpellings: ["/real/private.txt"],
      physicalTwins: () => [{ root: "/", pattern: "/real/private.txt" }],
    }).status,
    "matched",
  );
  assert.equal(
    matchNativeFileRules({
      ...env(),
      behavior: "allow",
      rules: [rule("Edit(//alias/private.txt)")],
      targetSpellings: ["/physical/private.txt"],
      trustedAlias: () => "/alias/private.txt",
    }).status,
    "matched",
  );
  assert.equal(
    matchNativeFileRules({ ...env(), targetSpellings: [] }).status,
    "unsupported",
  );
});
test("backend match failure denies conservatively but does not grant", () => {
  const failing = {
    validate: () => null,
    test: () => {
      throw new Error("owned fixture failure");
    },
  } satisfies NativeIgnoreBackend;
  const base = {
    ...env(),
    ignore: failing,
    rules: [rule("Edit(private.txt)")],
  };
  assert.equal(matchNativeFileRules(base).status, "matched");
  assert.equal(
    matchNativeFileRules({ ...base, behavior: "allow" }).status,
    "no-match",
  );
});
test("Bash wildcard primitive escapes literals, normalizes spaces and optional final arguments", () => {
  assert.equal(matchNativeBashText("git *", "git"), true);
  assert.equal(matchNativeBashText("git *", "git\tstatus"), true);
  assert.equal(matchNativeBashText("echo ?", "echo a"), false);
  assert.equal(matchNativeBashText("echo \\*", "echo *"), true);
  assert.equal(matchNativeBashText("echo \\*", "echo anything"), false);
  assert.equal(matchNativeBashText("cat /a/**/x", "cat /a/x"), true);
  assert.equal(matchNativeBashText("cat /a/**/x", "cat /a/b/c/x"), true);
  assert.equal(matchNativeBashText("echo *", "echo\nhello"), false);
  assert.equal(matchNativeBashText("echo\0*", "echo hi"), false);
});
test("Bash prefix phase requires word boundary, permits xargs, blocks compound wildcard grants", () => {
  const base = {
    rule: parseNativePermissionRule("Bash(git:*)"),
    behavior: "allow",
    phase: "prefix",
    candidates: [
      { text: "git status", compound: false, allowWildcardSafe: true },
    ],
  } satisfies Parameters<typeof matchNativeBashRule>[0];
  assert.equal(matchNativeBashRule(base).status, "matched");
  assert.equal(
    matchNativeBashRule({
      ...base,
      candidates: [
        { text: "github", compound: false, allowWildcardSafe: true },
      ],
    }).status,
    "no-match",
  );
  assert.equal(
    matchNativeBashRule({
      ...base,
      candidates: [
        { text: "xargs git status", compound: false, allowWildcardSafe: true },
      ],
    }).status,
    "matched",
  );
  assert.equal(
    matchNativeBashRule({
      ...base,
      candidates: [
        { text: "git status; evil", compound: true, allowWildcardSafe: false },
      ],
    }).status,
    "no-match",
  );
  const wildcard = {
    ...base,
    rule: parseNativePermissionRule("Bash(git *)"),
    candidates: [
      { text: "git status", compound: false, allowWildcardSafe: false },
    ],
  };
  assert.equal(matchNativeBashRule(wildcard).status, "no-match");
  assert.equal(
    matchNativeBashRule({ ...wildcard, behavior: "deny" }).status,
    "matched",
  );
  assert.equal(
    matchNativeBashRule({ ...wildcard, phase: "exact" }).status,
    "no-match",
  );
});

test("Bash deny and ask deliberately search compound text; certified rules require AST validator", () => {
  for (const behavior of ["deny", "ask"]) {
    if (behavior !== "deny" && behavior !== "ask") continue;
    assert.equal(
      matchNativeBashRule({
        rule: parseNativePermissionRule("Bash(git *)"),
        behavior,
        phase: "prefix",
        candidates: [
          {
            text: "git status; owned",
            compound: true,
            allowWildcardSafe: false,
          },
        ],
      }).status,
      "matched",
    );
  }
  assert.equal(
    matchNativeBashRule({
      rule: parseNativePermissionRule("Bash(certified: git status)"),
      behavior: "allow",
      phase: "prefix",
      candidates: [],
    }).status,
    "unsupported",
  );
});
