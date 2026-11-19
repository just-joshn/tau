import { posix, win32 } from "node:path";

export type NativeRuleBehavior = "allow" | "ask" | "deny";
export type NativeRulePlatform = "posix" | "windows";
export type ParsedNativePermissionRule =
  | { kind: "bare"; toolName: string; original: string }
  | { kind: "call"; toolName: string; content: string; original: string }
  | { kind: "malformed"; original: string; nativeFallbackToolName: string };

const aliases: Readonly<Record<string, string>> = {
  Task: "Agent",
  KillShell: "TaskStop",
  KillBash: "TaskStop",
  ListPeers: "ListAgents",
  Brief: "SendUserMessage",
  ListMcpResources: "ListMcpResourcesTool",
  ReadMcpResource: "ReadMcpResourceTool",
  ReadMcpResourceDir: "ReadMcpResourceDirTool",
  ProposeGoal: "SetGoal",
};

function toolAlias(name: string): string {
  return aliases[name] ?? name;
}
function unescapedAt(text: string, at: number): boolean {
  let count = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) count++;
  return count % 2 === 0;
}

/** Malformed syntax is diagnosed, while preserving xr's literal-name fallback. */
export function parseNativePermissionRule(
  original: string,
  options: { evalAliasEnabled?: boolean } = {},
): ParsedNativePermissionRule {
  const canonicalName = (name: string) =>
    name === "Eval" && options.evalAliasEnabled === true
      ? "REPL"
      : toolAlias(name);
  let open = -1;
  let close = -1;
  for (let i = 0; i < original.length; i++) {
    if (!unescapedAt(original, i)) continue;
    if (original[i] === "(" && open === -1) open = i;
    if (original[i] === ")") close = i;
  }
  if (open === -1 && close === -1)
    return { kind: "bare", toolName: canonicalName(original), original };
  const name = original.slice(0, open);
  if (
    open === -1 ||
    close <= open ||
    close !== original.length - 1 ||
    /[()]/.test(name) ||
    !name
  ) {
    return {
      kind: "malformed",
      original,
      nativeFallbackToolName: canonicalName(original),
    };
  }
  const raw = original.slice(open + 1, close);
  if (raw === "" || raw === "*")
    return { kind: "bare", toolName: canonicalName(name), original };
  const content = raw
    .replaceAll("\\(", "(")
    .replaceAll("\\)", ")")
    .replaceAll("\\\\", "\\");
  return { kind: "call", toolName: canonicalName(name), content, original };
}

export interface NativeIgnoreBackend {
  /** Return null only for patterns actually accepted by the Gitignore backend. */
  validate(pattern: string): string | null;
  /** Must implement ordered Gitignore rules, parent exclusion, default case-insensitive matching and matching-rule identity. */
  test(
    patterns: readonly string[],
    relativePath: string,
  ): { ignored: boolean; pattern?: string };
}
export interface NativeFileRule {
  /** Host must perform native permission-mode/provenance admission before providing this list. */
  rule: ParsedNativePermissionRule;
  source: string;
}
export interface NativeFileRuleEnvironment {
  platform: NativeRulePlatform;
  cwd: string;
  home: string;
  /** Twn/GQe equivalent; receives explicit source, never reads settings. */
  sourceRoot(source: string): string;
  ignore: NativeIgnoreBackend;
}
export interface PreparedNativeFileRule {
  root: string | null;
  pattern: string;
  matcherPattern: string;
  rule: NativeFileRule;
  diagnostics: string[];
}
export type NativeFilePreparation =
  | { status: "prepared"; value: PreparedNativeFileRule }
  | { status: "dropped" | "unsupported"; reason: string; rule: NativeFileRule };

function pathApi(platform: NativeRulePlatform) {
  return platform === "windows" ? win32 : posix;
}
function collapseDirectoryGlob(pattern: string, allow: boolean): string {
  if (!pattern.endsWith("/**")) return pattern;
  const base = pattern.slice(0, -3);
  if (!/[^/]/.test(base)) return "/**";
  return base.includes("/") || !allow || /^[!#]/.test(base) ? base : `/${base}`;
}
function unescapeFileLiteral(value: string): string {
  return value.replace(/\\([\s\\[\]!#()|+^$*?])/g, "$1");
}
function escapeFileLiteral(value: string): string {
  let escaped = value.replaceAll("\\", "\\\\").replace(/[[\]()|+^$]/g, "\\$&");
  if (/^[!#]/.test(escaped)) escaped = `\\${escaped}`;
  return escaped.replace(/\s+$/, (tail) =>
    Array.from(tail)
      .map((char) => `\\${char}`)
      .join(""),
  );
}
function literalizePattern(pattern: string): string {
  const negation = pattern.startsWith("!") ? "!" : "";
  const tail = pattern.endsWith("/**") ? "/**" : "";
  return (
    negation +
    escapeFileLiteral(
      unescapeFileLiteral(
        pattern.slice(negation.length, pattern.length - tail.length),
      ),
    ) +
    tail
  );
}
function patternError(
  pattern: string,
  backend: NativeIgnoreBackend,
): string | null {
  if (/^\s*$|^#|(?:^|[^\\])\\$/.test(pattern))
    return "blank, comment or trailing backslash";
  return backend.validate(pattern);
}

export function prepareNativeFileRule(
  rule: NativeFileRule,
  behavior: NativeRuleBehavior,
  env: NativeFileRuleEnvironment,
): NativeFilePreparation {
  if (rule.rule.kind !== "call")
    return {
      status: "unsupported",
      reason: "A file-content rule is required",
      rule,
    };
  let text = rule.rule.content;
  if (
    env.platform === "windows" &&
    (text.startsWith("~\\") ||
      (text.startsWith("\\") && !/[!#]/.test(text[1] ?? "")))
  )
    text = text.replaceAll("\\", "/");
  let root: string | null = null;
  if (text.startsWith("//")) {
    text = text.slice(1);
    if (env.platform === "windows" && /^\/[a-z]\//i.test(text)) {
      root = `${text[1]?.toUpperCase()}:\\`;
      text = text.slice(2);
    } else root = env.platform === "windows" ? "\\" : "/";
  } else if (env.platform === "windows" && /^[a-z]:[/\\]/i.test(text)) {
    root = `${text[0]?.toUpperCase()}:\\`;
    text = text.slice(2).replaceAll("\\", "/");
  } else if (text.startsWith("~/")) {
    root = env.home.normalize("NFC");
    text = text.slice(1);
  } else if (text.startsWith("/")) root = env.sourceRoot(rule.source);
  else if (text.startsWith("./")) text = text.slice(2);
  text = text.replace(/\/{2,}/g, "/");
  if (!/^\s*(?:\/\*\*)?$/.test(text)) {
    text = text
      .replace(/^\uFEFF([!#]?)/, (_all, first: string) =>
        first ? `\\${first}` : "",
      )
      .replace(/^\uFEFF/, "[\uFEFF]");
  }
  const allow = behavior === "allow";
  const error =
    !allow && /^!\s*$/.test(collapseDirectoryGlob(text, allow))
      ? "negation of every path"
      : patternError(collapseDirectoryGlob(text, allow), env.ignore);
  const diagnostics: string[] = [];
  if (error !== null) {
    const negative = text.startsWith("!");
    const grants = negative ? !allow : allow;
    if (grants)
      return {
        status: "dropped",
        reason: `Unusable grant pattern: ${error}`,
        rule,
      };
    const literal = literalizePattern(text);
    const literalWorks =
      env.ignore.validate(collapseDirectoryGlob(literal, false)) === null;
    text = literalWorks ? literal : `${negative ? "!" : ""}**`;
    diagnostics.push(
      `Unusable pattern: ${error}; ${literalWorks ? "literalized" : "broadened below root"}`,
    );
  }
  return {
    status: "prepared",
    value: {
      root,
      pattern: text,
      matcherPattern: collapseDirectoryGlob(text, allow),
      rule,
      diagnostics,
    },
  };
}

export interface NativeFileMatchOptions extends NativeFileRuleEnvironment {
  toolName: "Read" | "Write" | "Edit";
  behavior: NativeRuleBehavior;
  rules: readonly NativeFileRule[];
  /** pa/gs-equivalent spelling list, including relevant canonical and symlink spellings. */
  targetSpellings: readonly string[];
  /** Native Ewn roots; caller supplies gated worktree/additional-root computation. */
  candidateRoots(
    target: string,
    behavior: NativeRuleBehavior,
  ): readonly string[];
  /** Mg-equivalent canonical twins for deny/ask patterns. No implicit filesystem access. */
  physicalTwins(
    prepared: PreparedNativeFileRule,
  ): readonly { root: string; pattern: string }[];
  /** Xxt's trusted realpath equivalences, when independently verified by the host. */
  trustedAlias(target: string): string;
  fixedRootsBeforeRelative: boolean;
  isDirectory?: boolean;
  caseInsensitiveTarget?: boolean;
}
export type NativeRuleMatch =
  | { status: "matched"; rule: NativeFileRule; diagnostics: string[] }
  | { status: "no-match"; diagnostics: string[] }
  | { status: "unsupported"; reason: string; diagnostics: string[] };
interface PatternGroup {
  source: string | null;
  patterns: Map<string, NativeFileRule>;
}
function folded(text: string) {
  return text
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u017f/g, "s");
}

/** Matches rule content only. A match is not a complete native permission verdict. */
export function matchNativeFileRules(
  options: NativeFileMatchOptions,
): NativeRuleMatch {
  const family = options.toolName === "Read" ? "Read" : "Edit";
  const allow = options.behavior === "allow";
  const diagnostics: string[] = [];
  let selected = options.rules.filter(
    (entry) => entry.rule.kind === "call" && entry.rule.toolName === family,
  );
  if (allow) {
    const dedup = new Map<string, NativeFileRule>();
    for (const entry of selected)
      if (entry.rule.kind === "call") dedup.set(entry.rule.content, entry);
    selected = [...dedup.values()];
    // Native dc/kVo moves malformed negative exceptions behind ordinary allow patterns.
    const isExceptionalNegative = (entry: NativeFileRule) => {
      if (entry.rule.kind !== "call") return false;
      const pattern = entry.rule.content
        .replace(/^\.\//, "")
        .replace(/\/{2,}/g, "/");
      return (
        pattern.startsWith("!") &&
        patternError(collapseDirectoryGlob(pattern, false), options.ignore) !==
          null &&
        options.ignore.validate(
          collapseDirectoryGlob(literalizePattern(pattern), false),
        ) !== null
      );
    };
    selected = [
      ...selected.filter((entry) => !isExceptionalNegative(entry)),
      ...selected.filter(isExceptionalNegative),
    ];
  }
  const buckets = new Map<string | null, PatternGroup[]>();
  function add(
    root: string | null,
    source: string | null,
    pattern: string,
    rule: NativeFileRule,
    overwrite: boolean,
    move = !allow,
  ) {
    let groups = buckets.get(root);
    if (!groups) {
      groups = [];
      buckets.set(root, groups);
    }
    let group = groups.find((item) => item.source === source);
    if (!group) {
      group = { source, patterns: new Map() };
      groups.push(group);
    }
    if (!overwrite && group.patterns.has(pattern)) return;
    if (move) group.patterns.delete(pattern);
    group.patterns.set(pattern, rule);
  }
  for (const entry of selected) {
    const prepared = prepareNativeFileRule(entry, options.behavior, options);
    if (prepared.status === "unsupported")
      return { status: "unsupported", reason: prepared.reason, diagnostics };
    if (prepared.status === "dropped") {
      diagnostics.push(prepared.reason);
      continue;
    }
    if (prepared.status !== "prepared") continue;
    const value = prepared.value;
    diagnostics.push(...value.diagnostics);
    add(
      value.root,
      allow ? null : entry.source,
      value.pattern,
      entry,
      true,
      !allow || (value.pattern === "!**" && value.diagnostics.length > 0),
    );
    if (!allow && value.root !== null)
      for (const twin of options.physicalTwins(value))
        add(twin.root, entry.source, twin.pattern, entry, false);
  }
  const api = pathApi(options.platform);
  const bucketsInOrder = [...buckets];
  if (options.fixedRootsBeforeRelative)
    bucketsInOrder.sort(([a], [b]) => Number(a === null) - Number(b === null));
  function matchOne(target: string): NativeFileRule | undefined {
    const insensitive =
      !allow &&
      (options.platform === "windows" ||
        options.caseInsensitiveTarget === true);
    for (const [root, groups] of bucketsInOrder) {
      for (const base of root === null
        ? allow
          ? [options.cwd]
          : options.candidateRoots(target, options.behavior)
        : [root]) {
        const relativePath = api.relative(
          insensitive ? folded(base) : base,
          insensitive ? folded(target) : target,
        );
        const relative =
          options.platform === "windows"
            ? relativePath.replaceAll("\\", "/")
            : relativePath;
        if (
          !relative ||
          /^(?:\.\.?)(?:\/|$)/.test(relative) ||
          api.isAbsolute(relative)
        )
          continue;
        for (let i = groups.length - 1; i >= 0; i--) {
          const group = groups[i];
          if (!group) continue;
          let result: ReturnType<NativeIgnoreBackend["test"]>;
          try {
            result = options.ignore.test(
              [...group.patterns.keys()].map((pattern) =>
                collapseDirectoryGlob(pattern, allow),
              ),
              relative + (options.isDirectory === true ? "/" : ""),
            );
          } catch {
            if (allow) continue;
            return [...group.patterns].find(
              ([pattern]) => !pattern.startsWith("!"),
            )?.[1];
          }
          if (!result.ignored || result.pattern === undefined) continue;
          const pattern = result.pattern;
          if (
            group.patterns.has(`${pattern}/**`) &&
            (pattern.includes("/") || !allow)
          )
            return group.patterns.get(`${pattern}/**`);
          if (
            pattern.startsWith("/") &&
            group.patterns.has(`${pattern.slice(1)}/**`)
          )
            return group.patterns.get(`${pattern.slice(1)}/**`);
          const matched = group.patterns.get(pattern);
          if (matched || allow) return matched;
        }
      }
    }
    return undefined;
  }
  if (!options.targetSpellings.length)
    return {
      status: "unsupported",
      reason: "Canonical path spellings are required",
      diagnostics,
    };
  let first: NativeFileRule | undefined;
  for (const spelling of options.targetSpellings) {
    let matched = matchOne(spelling);
    if (!matched && allow) {
      const alias = options.trustedAlias(spelling);
      if (alias !== spelling) matched = matchOne(alias);
    }
    if (allow && !matched) return { status: "no-match", diagnostics };
    if (matched) {
      first ??= matched;
      if (!allow) break;
    }
  }
  return first
    ? { status: "matched", rule: first, diagnostics }
    : { status: "no-match", diagnostics };
}

/** Native wre primitive: no tokenization, shell expansion, AST validation or authorization. */
export function matchNativeBashText(
  pattern: string,
  text: string,
  normalizeWhitespace = true,
): boolean {
  if (pattern.includes("\0")) return false;
  let normalized = pattern.trim();
  if (normalizeWhitespace) {
    normalized = normalized.replace(/[ \t]+/g, " ");
    text = text.replace(/[ \t]+/g, " ");
  }
  let regex = "";
  let stars = 0;
  for (let i = 0; i < normalized.length; i++)
    if (normalized[i] === "*" && unescapedAt(normalized, i)) stars++;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i] ?? "";
    if (
      char === "\\" &&
      (normalized[i + 1] === "*" || normalized[i + 1] === "\\")
    ) {
      regex += normalized[++i] === "*" ? "\\*" : "\\\\";
      continue;
    }
    if (char === "/" && normalized.slice(i + 1).startsWith("**/")) {
      do {
        i += 3;
      } while (normalized.slice(i + 1).startsWith("**/"));
      regex += "/(?:.*/)?";
      continue;
    }
    if (char === "*") {
      regex += ".*";
    } else regex += char.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  }
  if (regex.endsWith(" .*") && stars === 1)
    regex = regex.slice(0, -3) + "( .*)?";
  return new RegExp(`^${regex}$`, "s").test(text);
}
export type NativeBashCandidate = {
  text: string;
  compound: boolean;
  allowWildcardSafe: boolean;
};
export function matchNativeBashRule(options: {
  rule: ParsedNativePermissionRule;
  behavior: NativeRuleBehavior;
  phase: "exact" | "prefix";
  /** Required R8 host preparation: AST, wrappers, env, redirects and safety checks. */
  candidates: readonly NativeBashCandidate[];
}): { status: "matched" | "no-match" | "unsupported"; reason?: string } {
  if (options.rule.kind !== "call" || options.rule.toolName !== "Bash")
    return { status: "unsupported", reason: "Expected Bash content rule" };
  const pattern = options.rule.content;
  if (pattern.startsWith("certified: "))
    return {
      status: "unsupported",
      reason:
        "Certified Bash rules require the native AST certificate validator",
    };
  const prefix = /^(.+):\*$/.exec(pattern)?.[1];
  let wildcard = false;
  for (let i = 0; i < pattern.length; i++)
    if (pattern[i] === "*" && unescapedAt(pattern, i)) wildcard = true;
  for (const candidate of options.candidates) {
    if (prefix !== undefined) {
      const text = candidate.text.replace(/[ \t]+/g, " ");
      const start = prefix.replace(/[ \t]+/g, " ");
      if (options.phase === "exact") {
        if (start === text) return { status: "matched" };
      } else if (
        (options.behavior !== "allow" || !candidate.compound) &&
        (text === start ||
          text.startsWith(`${start} `) ||
          text === `xargs ${start}` ||
          text.startsWith(`xargs ${start} `))
      )
        return { status: "matched" };
    } else if (!wildcard) {
      if (pattern === candidate.text) return { status: "matched" };
    } else if (
      options.phase === "prefix" &&
      (options.behavior !== "allow" || !candidate.compound) &&
      (options.behavior !== "allow" || candidate.allowWildcardSafe) &&
      matchNativeBashText(pattern, candidate.text)
    )
      return { status: "matched" };
  }
  return { status: "no-match" };
}
