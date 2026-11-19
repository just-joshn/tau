import { posix } from "node:path";
import type { ToolPolicy } from "./tool-policy.js";
import {
  matchNativeBashRule,
  matchNativeBashText,
  parseNativePermissionRule,
  type NativeRuleBehavior,
  type ParsedNativePermissionRule,
} from "./native-permission-rules.js";

export interface BashPermissionPolicyRule {
  rule: string;
  source: string;
  behavior: NativeRuleBehavior;
  path?: string;
  origin: "direct" | "sourced";
}
export interface BashPermissionSessionProfile {
  kind: "ordinary-local-posix";
  mode: string;
  restricted: boolean;
  servedCall: boolean;
}
export type BashRuleAdmission =
  { status: "admit" } | { status: "exclude" | "unsupported"; reason: string };
export interface BashPermissionRuleCandidate extends BashPermissionPolicyRule {
  phase: "exact" | "prefix";
  matchedText: string;
  /** Unresolved source admission or shell preparation is never an execution grant. */
  resolved: boolean;
}
export interface BashPermissionPhaseCandidates {
  deny?: BashPermissionRuleCandidate;
  ask?: BashPermissionRuleCandidate;
  allow?: BashPermissionRuleCandidate;
}
export interface BashPermissionSessionResult {
  status: "classified" | "unsupported";
  exact: BashPermissionPhaseCandidates;
  prefix: BashPermissionPhaseCandidates;
  command: string;
  nativeArgv?: readonly string[];
  generation: number;
  diagnostics: readonly string[];
  unsupported: readonly {
    reason: string;
    rule?: BashPermissionPolicyRule;
    matchedText?: string;
  }[];
}

const sourceOrder = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
  "cliArg",
  "command",
  "session",
  "mcpMount",
  "toolsNarrowing",
  "mcpServerPolicy",
  "hostCredential",
];
// R8's oE/x5e transform these. This first adapter deliberately does not infer
// wrapper option parsing, environment safety, AST certificates or shell state.
const wrappers = new Set([
  "timeout",
  "time",
  "nice",
  "stdbuf",
  "nohup",
  "command",
  "builtin",
  "noglob",
  "env",
  "sudo",
  "doas",
  "pkexec",
  "watch",
  "ionice",
  "setsid",
  "taskset",
  "chrt",
  "strace",
  "ltrace",
  "flock",
  "script",
  "unshare",
  "nsenter",
  "sandbox-exec",
  "exec",
  "nocorrect",
]);
const reserved = new Set([
  "!",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "case",
  "esac",
  "do",
  "done",
  "function",
  "select",
  "in",
  "[[",
  "]]",
]);
interface LiteralCommand {
  command: string;
  argv: string[];
  allowTexts: string[];
  restrictiveTexts: string[];
  unsupported: string[];
}

/** Bounded literal-word recognizer, not a replacement for the native shell AST. */
function prepareLiteralCommand(input: string): LiteralCommand {
  const command = input.trim();
  const unsupported: string[] = [];
  const argv: string[] = [];
  const words: { raw: string; value: string }[] = [];
  if (!command || command.length > 10_000 || /[\0\r\n]/.test(command))
    unsupported.push("Empty, multiline, NUL or over-10000-character command");
  let i = 0;
  while (i < command.length && !unsupported.length) {
    while (/[ \t]/.test(command[i] ?? "") && i < command.length) i++;
    if (i === command.length) break;
    const start = i;
    let value = "";
    let quote: "'" | '"' | undefined;
    while (i < command.length) {
      const char = command[i] ?? "";
      if (quote === "'") {
        if (char === "'") quote = undefined;
        else value += char;
        i++;
        continue;
      }
      if (quote === '"') {
        if (char === '"') quote = undefined;
        else if (/[$`\\]/.test(char)) {
          unsupported.push(
            "Double-quote expansion or escape requires native AST preparation",
          );
          break;
        } else value += char;
        i++;
        continue;
      }
      if (/[ \t]/.test(char)) break;
      if (char === "'" || char === '"') {
        quote = char;
        i++;
        continue;
      }
      if (char === "\\") {
        const next = command[i + 1];
        if (next === undefined || /[\r\n\0]/.test(next)) {
          unsupported.push(
            "Incomplete escape or line continuation requires native AST preparation",
          );
          break;
        }
        value += next;
        i += 2;
        continue;
      }
      if (/[$`|&;()<>#{}*?[\]~]/.test(char) || /[^\S \t]/.test(char)) {
        unsupported.push(
          "Expansion, comment, redirection, compound or nonliteral shell syntax",
        );
        break;
      }
      value += char;
      i++;
    }
    if (quote !== undefined && !unsupported.length)
      unsupported.push("Unterminated quote requires native AST preparation");
    if (unsupported.length) break;
    words.push({ raw: command.slice(start, i), value });
    argv.push(value);
  }
  const executable = argv[0];
  if (!unsupported.length && (executable === undefined || executable === ""))
    unsupported.push("A nonempty literal executable is required");
  if (executable !== undefined) {
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(executable))
      unsupported.push(
        "Environment assignments require behavior-dependent native stripping",
      );
    if (wrappers.has(posix.basename(executable)))
      unsupported.push(
        "Wrapper commands require native option and environment preparation",
      );
    if (reserved.has(executable))
      unsupported.push("Reserved shell syntax requires the native AST");
    if (/\s/.test(executable))
      unsupported.push(
        "Executable names containing whitespace require the native AST",
      );
    else if (!/^[\p{L}\p{M}\p{N}_.+\-:@%,/]+$/u.test(executable))
      unsupported.push(
        "Executable punctuation outside the literal-name subprofile requires native candidate checks",
      );
  }
  // oE dequotes only the first lexical word in this supported no-wrapper scope.
  const first = words[0];
  const normalized =
    first !== undefined && !/\s/.test(first.raw)
      ? first.value + command.slice(first.raw.length)
      : command;
  const allowTexts = [...new Set([command, normalized])];
  const restrictiveTexts = [...allowTexts];
  if (!unsupported.length && executable !== undefined) {
    // R8(stripAllEnvVars) adds iC's static argv joined by spaces and basename
    // alternatives for deny/ask. Allow has neither transformation.
    restrictiveTexts.push(argv.join(" "));
    if (posix.basename(executable) !== executable)
      restrictiveTexts.push(
        [posix.basename(executable), ...argv.slice(1)].join(" "),
      );
  }
  return {
    command,
    argv,
    allowTexts,
    restrictiveTexts: [...new Set(restrictiveTexts)],
    unsupported,
  };
}

function unescapedStarAt(pattern: string, at: number): boolean {
  let count = 0;
  for (let i = at - 1; i >= 0 && pattern[i] === "\\"; i--) count++;
  return count % 2 === 0;
}
function firstStar(pattern: string): number {
  for (let i = 0; i < pattern.length; i++)
    if (pattern[i] === "*" && unescapedStarAt(pattern, i)) return i;
  return -1;
}
function trailingWildcard(pattern: string): boolean {
  const text = pattern.trimEnd();
  return text.endsWith("*") && unescapedStarAt(text, text.length - 1);
}

/** dOr's executable-name cases require its full parser. They are unresolved here. */
function wildcardNeedsExecutableHost(pattern: string): boolean {
  const star = firstStar(pattern);
  if (star < 0 || /^(.+):\*$/.test(pattern)) return false;
  const literal = pattern
    .slice(0, star)
    .trimStart()
    .replace(/\\([*\\])/g, "$1");
  // A fully literal first executable followed by a space is within the bounded
  // subprofile. Everything else is unsupported, not declared unsafe by native.
  return !/^[^\s'"\\$`=]+[ \t]/.test(literal);
}

interface CompiledRule {
  metadata: BashPermissionPolicyRule;
  parsed: Extract<ParsedNativePermissionRule, { kind: "call" }>;
  admissionResolved: boolean;
}

/** Rule candidates only. The caller must retain native shell/Plan/cwd/approval floors. */
export function createBashPermissionSession(options: {
  /** Effective live policy; never reappend a launch snapshot's stripped grants. */
  policy: () => ToolPolicy;
  profile: () => BashPermissionSessionProfile;
  /** Required H/Bct mode/provenance admission, including active-auto filtering. */
  admitRule: (
    rule: BashPermissionPolicyRule,
    profile: BashPermissionSessionProfile,
  ) => BashRuleAdmission;
}) {
  let fingerprint: string | undefined;
  let generation = 0;
  return {
    invalidate() {
      fingerprint = undefined;
    },
    evaluate(request: {
      command: string;
      signal: AbortSignal;
    }): BashPermissionSessionResult {
      request.signal.throwIfAborted();
      const profile = options.profile();
      const policy = options.policy();
      const diagnostics: string[] = [];
      const unsupported: {
        reason: string;
        rule?: BashPermissionPolicyRule;
        matchedText?: string;
      }[] = [];
      if (
        profile.kind !== "ordinary-local-posix" ||
        typeof profile.restricted !== "boolean" ||
        typeof profile.servedCall !== "boolean" ||
        profile.restricted ||
        profile.servedCall ||
        ![
          "default",
          "acceptEdits",
          "dontAsk",
          "plan",
          "auto",
          "bypassPermissions",
        ].includes(profile.mode)
      )
        unsupported.push({
          reason:
            "Unknown, restricted or served permission profile requires a native host",
        });
      const prepared = prepareLiteralCommand(request.command);
      unsupported.push(...prepared.unsupported.map((reason) => ({ reason })));
      const raw: BashPermissionPolicyRule[] = [];
      for (const behavior of ["deny", "ask", "allow"] as const)
        for (const rule of behavior === "deny"
          ? policy.disallowedTools
          : behavior === "ask"
            ? (policy.askedTools ?? [])
            : policy.allowedTools)
          raw.push({ rule, behavior, source: "cliArg", origin: "direct" });
      for (const rule of policy.sourcedRules ?? [])
        raw.push({
          rule: rule.rule,
          source: rule.source,
          behavior: rule.behavior,
          ...(rule.path === undefined ? {} : { path: rule.path }),
          origin: "sourced",
        });
      raw.sort((left, right) => {
        const a = sourceOrder.indexOf(left.source),
          b = sourceOrder.indexOf(right.source);
        return (
          (a < 0 ? sourceOrder.length : a) - (b < 0 ? sourceOrder.length : b)
        );
      });
      const rules: Record<NativeRuleBehavior, Map<string, CompiledRule>> = {
        deny: new Map(),
        ask: new Map(),
        allow: new Map(),
      };
      for (const metadata of raw) {
        const parsed = parseNativePermissionRule(metadata.rule);
        if (parsed.kind !== "call" || parsed.toolName !== "Bash") {
          if (parsed.kind === "malformed" && metadata.rule.startsWith("Bash("))
            diagnostics.push(
              `Malformed Bash rule retains literal-name fallback: ${metadata.rule}`,
            );
          continue;
        }
        let decision: BashRuleAdmission;
        if (!sourceOrder.includes(metadata.source))
          decision = {
            status: "unsupported",
            reason: `Unknown Bash-rule provenance: ${metadata.source}`,
          };
        else if (metadata.source === "command")
          decision = {
            status: "unsupported",
            reason:
              "Command-origin first-command-tail exceptions require the native host",
          };
        else decision = options.admitRule(metadata, profile);
        if (decision.status === "exclude" && metadata.behavior === "allow") {
          diagnostics.push(`Bash grant excluded by host: ${decision.reason}`);
          continue;
        }
        if (decision.status !== "admit")
          unsupported.push({ reason: decision.reason, rule: metadata });
        // Native tE uses Map.set: last duplicate content wins but retains the
        // original insertion position. Provenance stays attached to that winner.
        rules[metadata.behavior].set(parsed.content, {
          metadata,
          parsed,
          admissionResolved: decision.status === "admit",
        });
      }
      const nextFingerprint = JSON.stringify({
        profile,
        rules: Object.entries(rules).map(([behavior, map]) => [
          behavior,
          [...map],
        ]),
      });
      if (nextFingerprint !== fingerprint) {
        fingerprint = nextFingerprint;
        generation++;
      }
      const commandResolved = !unsupported.length;
      const phases: Record<"exact" | "prefix", BashPermissionPhaseCandidates> =
        { exact: {}, prefix: {} };
      for (const phase of ["exact", "prefix"] as const)
        for (const behavior of ["deny", "ask", "allow"] as const)
          for (const entry of rules[behavior].values()) {
            const pattern = entry.parsed.content;
            if (pattern.startsWith("certified: ")) {
              if (behavior === "allow" && phase === "prefix")
                unsupported.push({
                  reason:
                    "Certified rules require native AST argv/options/redirection validation",
                  rule: entry.metadata,
                });
              continue;
            }
            const unresolvedWildcard =
              behavior === "allow" &&
              phase === "prefix" &&
              wildcardNeedsExecutableHost(pattern);
            let matchedText: string | undefined;
            for (const text of behavior === "allow"
              ? prepared.allowTexts
              : prepared.restrictiveTexts) {
              const match = matchNativeBashRule({
                rule: entry.parsed,
                behavior,
                phase,
                candidates: [
                  { text, compound: false, allowWildcardSafe: true },
                ],
              });
              if (
                match.status === "matched" ||
                (phase === "prefix" &&
                  firstStar(pattern) >= 0 &&
                  !/^(.+):\*$/.test(pattern) &&
                  (behavior !== "allow" || trailingWildcard(pattern)) &&
                  matchNativeBashText(`xargs ${pattern}`, text))
              ) {
                matchedText = text;
                break;
              }
            }
            if (matchedText === undefined) continue;
            const candidate: BashPermissionRuleCandidate = {
              ...entry.metadata,
              phase,
              matchedText,
              resolved:
                commandResolved &&
                entry.admissionResolved &&
                !unresolvedWildcard,
            };
            if (unresolvedWildcard)
              unsupported.push({
                reason:
                  "Wildcard executable-name boundary needs native dOr preparation",
                rule: entry.metadata,
                matchedText,
              });
            // Keep restrictive evidence on unresolved commands/admission. An
            // unresolved allow may never become an executable grant candidate.
            if (behavior === "allow" && !candidate.resolved) continue;
            phases[phase][behavior] ??= candidate;
          }
      request.signal.throwIfAborted();
      const dedup = [
        ...new Map(
          unsupported.map((item) => [JSON.stringify(item), item]),
        ).values(),
      ];
      return {
        status: dedup.length ? "unsupported" : "classified",
        ...phases,
        command: prepared.command,
        ...(prepared.unsupported.length ? {} : { nativeArgv: prepared.argv }),
        generation,
        diagnostics: [...new Set(diagnostics)],
        unsupported: dedup,
      };
    },
  };
}
