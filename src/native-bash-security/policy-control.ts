import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";
import type {
  NativeBashSemantics,
  NativeBashSemanticCommand as Command,
} from "../native-bash-semantics.js";
import type {
  NativeBashCommandPreparation,
  NativeBashPreparationOptions as MatchOptions,
} from "../native-bash-command-preparation.js";
import {
  createNativeBashSecurityPathControl,
  type NativeBashSecurityPathHost,
} from "./path-control.js";
import { createNativeBashSecuritySed } from "./sed.js";
import {
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  NativeBashSecurityUnsupported,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityReason as Reason,
  type NativeBashSecurityInput as Input,
  type NativeBashSecurityRule as Rule,
  type NativeBashSecuritySuggestion as Suggestion,
} from "./security-types.js";
type SafetyReason = Extract<Reason, { type: "safetyCheck" }>;
type Behavior = "allow" | "ask" | "deny";
export interface NativeBashSecurityEvaluationContext {
  sessionEnvVars?: ReadonlyMap<string, string> | undefined;
}
export interface NativeBashSandboxProbeInput {
  command?: string | undefined;
  shellType?: "bash" | "powershell" | undefined;
  dangerouslyDisableSandbox?: boolean | undefined;
}
export interface NativeBashSecuritySandboxDispatch {
  disableUnsandboxedCommands?: boolean;
  userTypedShellDispatch?: boolean;
}
export interface NativeBashSecuritySpawnEnvironmentOwner {
  spawnEnvKeys: (
    keys: ReadonlySet<string> | undefined,
    scope: Scope,
  ) => Fact<ReadonlySet<string> | undefined>;
}
export interface NativeBashSecurityPolicyHost extends NativeBashSecurityPathHost {
  orderedRules?: (
    policy: Policy,
    behavior: Behavior,
    scope: Scope,
  ) => Fact<ReadonlyMap<string, Rule>>;
  allDenyRules?: (policy: Policy, scope: Scope) => Fact<readonly Rule[]>;
  commandDenyBuiltinRuleNames?: (scope: Scope) => Fact<ReadonlySet<string>>;
  ruleSuggestions?: (command: string, scope: Scope) => Fact<Suggestion[]>;
  readOnly?: (
    input: Input,
    context: NativeBashSecurityEvaluationContext | undefined,
    scope: Scope,
  ) => Fact<boolean>;
  spawnEnvironmentOwner?: (
    scope: Scope,
  ) => Fact<NativeBashSecuritySpawnEnvironmentOwner>;
  isConfined?: (scope: Scope) => Fact<boolean>;
  executingConfined?: (scope: Scope) => Fact<boolean>;
  windowsBashAvailable?: (scope: Scope) => Fact<boolean>;
  evalConfined?: (scope: Scope) => Fact<boolean>;
  sandboxCommandExempt?: (
    command: string,
    shell: "bash" | "powershell",
    scope: Scope,
  ) => Fact<boolean>;
  sandboxReadFencesUsable?: (scope: Scope) => Fact<boolean>;
  globalReadBlock?: (scope: Scope) => Fact<boolean>;
  securityFeature?: (
    kind: "b" | "je",
    key:
      | "tengu_binary_lollipop"
      | "tengu_lively_cook"
      | "tengu_melodic_pelican"
      | "tengu_replicated_falcon",
    fallback: true,
    scope: Scope,
  ) => Fact<boolean>;
  xargsSafeFlags?: (scope: Scope) => Fact<Readonly<Record<string, unknown>>>;
  currentCwd?: (scope: Scope) => Fact<string>;
}
function required<T>(v: T | undefined): T {
  if (v === undefined)
    throw new Error("Missing native policy-consumer invariant");
  return v;
}
export function createNativeBashSecurityPolicyControl(
  semantic: NativeBashSemantics,
  preparation: NativeBashCommandPreparation,
  host: NativeBashSecurityPolicyHost,
) {
  const paths = host.platform === "windows" ? win32 : posix;
  const pathOwner = createNativeBashSecurityPathControl(
    semantic,
    preparation,
    host,
  );
  const frames = new AsyncLocalStorage<{
    policy: Policy;
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(fact: Fact<T>) =>
    readNativeBashSecurityFact(fact, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const { P, OA, op, Ge, sc } = pathOwner.gate.bindings;
  const { mD, l1, HOe, jde, Pti, SSn } = pathOwner.native;
  const { Zje, cYn, uYn } = pathOwner.gate.native;
  const { extractors: aM } = pathOwner.arguments;
  const { Ys, E6e } = semantic.native;
  const projection = preparation.projection;
  const {
    splitCommands: Sy,
    redirections: KX,
    staticArgv: iC,
    containsParsingDifferences: I8n,
    hasErrorNode: _At,
    findStaticCommand: cLe,
    redirectsNeedReview: XKs,
    maxCommandCharacters: sC,
  } = projection;
  const oE = preparation.stripSimpleWrappers;
  const bU = preparation.environmentValueSafe;
  const Uwn = preparation.environmentNeedsReview;
  const Ult = preparation.environmentNameAllowed;
  const DY = () => preparation.features.refuseEnvironment();
  const HF = (...parts: string[]) => paths.resolve(...parts);
  const _x = (path: string) => paths.isAbsolute(path);
  const $Mr = (path: string) => paths.dirname(path);
  const exists = (path: string) =>
    use(need(host.filesystem.exists, "filesystem.exists")(path, frame().scope));
  const D1 = (
    path: string,
    cwd: string,
    policy: Policy,
    operation: "read" | "write" | "create",
  ) => pathOwner.gate.check(path, cwd, policy, operation);
  const pt = /^[\\/]\?\?[\\/]/;
  const Ar = (path: string) =>
    /^[\\/]{2}/.test(path) ||
    pt.test(path) ||
    (path.includes("??") && pt.test(win32.normalize(path)));
  const bQ = (reason: string): Decision => {
    const text = `${reason}; under the read block (permissions.blockReadsOutsideWorkingDirectories) a command the shell parser cannot analyze asks the person`;
    return {
      behavior: "ask",
      message: text,
      decisionReason: {
        type: "safetyCheck",
        reason: text,
        classifierApprovable: false,
        circuitBreaker: "outsideReadsBlocked",
      },
    };
  };
  const dk = (command: string): Decision => {
    const reason = `${command} names a path that is computed at run time, which cannot be checked against the read block (permissions.blockReadsOutsideWorkingDirectories)`;
    return {
      behavior: "ask",
      message: reason,
      decisionReason: {
        type: "safetyCheck",
        reason,
        classifierApprovable: false,
        circuitBreaker: "outsideReadsBlocked",
      },
    };
  };
  const Mcr = (): Decision => {
    const reason =
      "This sed script is not on the allowlist and can read or write any file, which cannot be checked against the read block (permissions.blockReadsOutsideWorkingDirectories)";
    return {
      behavior: "ask",
      message: reason,
      decisionReason: {
        type: "safetyCheck",
        reason,
        classifierApprovable: false,
        circuitBreaker: "outsideReadsBlocked",
      },
    };
  };
  const R0 = (reason: Reason | undefined): reason is SafetyReason =>
    reason?.type === "safetyCheck" &&
    reason.circuitBreaker === "outsideReadsBlocked";
  const ue = () => use(need(host.currentCwd, "cwd.current")(frame().scope));
  const Tzn = (command: string) =>
    use(
      need(host.ruleSuggestions, "suggestions.command")(command, frame().scope),
    );
  const dpe = (policy: Policy, _tool: { name: string }, behavior: Behavior) =>
    use(
      need(host.orderedRules, "rules.ordered")(policy, behavior, frame().scope),
    );
  const na = (policy: Policy) =>
    use(need(host.allDenyRules, "rules.allDeny")(policy, frame().scope));
  const xQn = (decision: Decision) =>
    decision.behavior === "ask" &&
    decision.decisionReason?.type === "rule" &&
    decision.decisionReason.rule.source === "session";
  const fn = (rule: { toolName: string; ruleContent?: string | undefined }) =>
    !rule.ruleContent
      ? rule.toolName
      : `${rule.toolName}(${rule.ruleContent.replace(/[\\()]/g, "\\$&")})`;
  const R8 = (
    input: Input,
    rules: ReadonlyMap<string, Rule>,
    phase: "prefix" | "exact",
    options: MatchOptions,
  ) => {
    const result = preparation.matchRules(input, rules, phase, options);
    if (result.status === "unresolved")
      throw new NativeBashSecurityUnsupported(
        result.dependency,
        "Native rule preparation is unresolved",
      );
    return result.matches;
  };
  const Ks = {
    name: "Bash",
    isReadOnly: (input: Input, context?: NativeBashSecurityEvaluationContext) =>
      use(
        need(host.readOnly, "readonly.classification")(
          input,
          context,
          frame().scope,
        ),
      ),
  };
  const iPe = "Read-only command is allowed";
  const wEe = "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)";
  const XMr = (prefix: string): Suggestion[] => [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: prefix + " *" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ];
  const readFeature = (
    kind: "b" | "je",
    key:
      | "tengu_binary_lollipop"
      | "tengu_lively_cook"
      | "tengu_melodic_pelican"
      | "tengu_replicated_falcon",
  ) =>
    use(
      need(host.securityFeature, "features.security")(
        kind,
        key,
        true,
        frame().scope,
      ),
    );
  const KOe = () => readFeature("b", "tengu_binary_lollipop");
  const _wn = () => readFeature("b", "tengu_lively_cook");
  const Pat = new AsyncLocalStorage<{
    refused?: boolean;
    off?: boolean;
    pathListRefused?: boolean;
  }>();
  const jSn = new AsyncLocalStorage<boolean>();
  const iwn = new Set([
    "sha256sum",
    "sha1sum",
    "md5sum",
    "strings",
    "wc",
    "du",
  ]);
  const je = (_key: string, _options: { safe: true }) =>
    readFeature("je", "tengu_melodic_pelican");
  const gMr = "tengu_melodic_pelican";
  const Zat = /^\d+(?:\.\d+)?[smhd]?$/;
  const mOr = new Set([
    "echo",
    "printf",
    "test",
    "[",
    "[[",
    "true",
    "false",
    "which",
    "type",
    "basename",
    "dirname",
    "df",
  ]);
  const IMr = (name: string) => OMr.includes(name);
  const OMr = ["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed"];
  const EMr = new Set(["[[", "alias", "cd", "help", "history", "type"]);
  const Rat = ["grep", "egrep", "fgrep", "head", "tail"];
  const mMr = new Set([
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "stat",
    "grep",
    "egrep",
    "fgrep",
    "diff",
    "du",
    "df",
    "echo",
    "strings",
    "hexdump",
    "od",
    "nl",
    "cut",
    "column",
    "tr",
    "tac",
    "rev",
    "cmp",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "sha256sum",
    "sha1sum",
    "md5sum",
    "cd",
  ]);
  const KPn = new Map<string, Set<string>>([
    ["python", new Set(["-c"])],
    ["node", new Set(["-e", "--eval", "-p", "--print"])],
    ["nodejs", new Set(["-e", "--eval", "-p", "--print"])],
    ["bun", new Set(["-e", "--eval", "-p", "--print"])],
    ["perl", new Set(["-e", "-E"])],
    ["ruby", new Set(["-e"])],
    ["php", new Set(["-r"])],
    ["bash", new Set(["-c"])],
    ["sh", new Set(["-c"])],
    ["zsh", new Set(["-c"])],
    ["dash", new Set(["-c"])],
    ["ksh", new Set(["-c"])],
    ["lua", new Set(["-e"])],
    ["luajit", new Set(["-e"])],
    ["tsx", new Set(["-e", "--eval", "-p", "--print"])],
    ["deno", new Set(["eval"])],
    ["Rscript", new Set(["-e"])],
    ["julia", new Set(["-e", "-E"])],
    ["osascript", new Set(["-e"])],
  ]);
  const sed = createNativeBashSecuritySed(
    projection,
    semantic,
    () =>
      use(
        need(host.feature, "features.reader")(
          "bot_protected_tengu_quiet_peacock",
          true,
          frame().scope,
        ),
      ).value,
  );
  const PF = sed.isReadOnly;
  const UAt = () =>
    use(need(host.sandboxReadFencesUsable, "sandbox.UAt")(frame().scope));
  const j6e = () =>
    use(need(host.globalReadBlock, "readblock.global")(frame().scope));
  const cp = () => use(need(host.isConfined, "confined.mode")(frame().scope));
  const ore = () =>
    use(need(host.executingConfined, "confined.executing")(frame().scope));
  const KY = () =>
    use(need(host.windowsBashAvailable, "windows.bashAvailable")(frame().scope))
      ? "available"
      : null;
  const sandbox = () =>
    use(need(host.sandbox, "sandbox.facts")(frame().policy, frame().scope));
  const IIo = (command: string, shell: "bash" | "powershell") =>
    use(
      need(host.sandboxCommandExempt, "sandbox.commandExempt")(
        command,
        shell,
        frame().scope,
      ),
    );
  const gh = () => sandbox();
  const s = {
    get CLAUDE_CODE_EVAL_CONFINED() {
      return use(
        need(host.evalConfined, "environment.evalConfined")(frame().scope),
      );
    },
  };
  const V_ = () => semantic.parser;
  const SG = semantic.analyzeTree;
  const spawnOwner = () =>
    use(
      need(host.spawnEnvironmentOwner, "environment.spawnOwner")(frame().scope),
    );
  const kzn = (keys: ReadonlySet<string> | undefined) =>
    use(spawnOwner().spawnEnvKeys(keys, frame().scope));
  const qde = (keys: ReadonlySet<string> | undefined) => {
    spawnOwner();
    return () => kzn(keys);
  };
  const b0e = (context: NativeBashSecurityEvaluationContext) =>
    new Set(context.sessionEnvVars?.keys());
  const eOr = (name: string, keys: () => ReadonlySet<string> | undefined) =>
    name === "PWD" ||
    name === "OLDPWD" ||
    (!Ult(name) && keys()?.has(name) !== false);
  const T8 = (names: string[], read: () => ReadonlySet<string> | undefined) => {
    let called = false;
    let value: ReadonlySet<string> | undefined;
    const once = () => {
      if (!called) {
        called = true;
        value = read();
      }
      return value;
    };
    return names.some((name) => eOr(name, once));
  };
  const title: Readonly<Record<string, string | undefined>> = {
    default: "Manual",
    plan: "Plan",
    acceptEdits: "Accept edits",
    bypassPermissions: "Bypass Permissions",
    dontAsk: "Don't Ask",
    auto: "Auto",
  };
  const KB = (mode: string) => title[mode] ?? "Manual";
  const sourceNames: Readonly<Record<string, string | undefined>> = {
    userSettings: "user settings",
    projectSettings: "shared project settings",
    localSettings: "project local settings",
    flagSettings: "command line arguments",
    policySettings: "enterprise managed settings",
    cliArg: "CLI argument",
    command: "command configuration",
    session: "current session",
    toolsNarrowing: "CLI tool narrowing",
    mcpServerPolicy: "MCP server policy",
    hostCredential: "cloud-session credential guard",
    mcpMount: "Remote Control server mount",
  };
  const Ast = (source: string) => sourceNames[source];
  const O = (n: number, one: string, many = one + "s") =>
    n === 1 ? one : many;
  const X4o = (tool: string) =>
    `Claude requested permissions to use ${tool}, but you haven't granted it yet.`;
  const vy = pathOwner.gate.bindings.vy;
  const RMr = () => readFeature("je", "tengu_replicated_falcon");
  function Ikn(e: string): number | null {
    let n = 0;
    while (n < e.length) {
      let r = e[n];
      if (r === " " || r === "\t") break;
      if (r === "\\" && n + 1 < e.length) {
        n += 2;
        continue;
      }
      if (r === "'") {
        let a = e.indexOf("'", n + 1);
        if (a === -1) return null;
        n = a + 1;
        continue;
      }
      if (r === '"') {
        let a = n + 1;
        for (;;) {
          if (a >= e.length) return null;
          if (e[a] === "\\" && a + 1 < e.length) {
            a += 2;
            continue;
          }
          if (e[a] === '"') break;
          a++;
        }
        n = a + 1;
        continue;
      }
      n++;
    }
    return n;
  }

  function Xxr(e: string): string {
    let n = e;
    for (;;) {
      if (n.startsWith("<<<") && n[3] !== "<" && n[3] !== "(") {
        let k = n.slice(3),
          E = k.startsWith(" ") || k.startsWith("\t") ? k.trimStart() : k;
        if (!E) return n;
        let N = Ikn(E);
        if (N === null) return n;
        n = E.slice(N).trimStart();
        continue;
      }
      let r =
        /^(?:\d*|&)(?:>>(?!\()|>\|(?!\()|>&(?!\()|<&(?!\()|<>(?!\()|>(?![>|&(])|<(?![<>&(]))/.exec(
          n,
        );
      if (!r) return n;
      let a = n.slice(r[0].length),
        h = a.startsWith(" ") || a.startsWith("\t") ? a.trimStart() : a;
      if (!h) return n;
      let y = Ikn(h);
      if (y === null) return n;
      n = h.slice(y).trimStart();
    }
  }

  function y8(e: string): string {
    let n = e.trim();
    for (;;) {
      let r = Xxr(oE(n));
      if (r === n) break;
      n = r;
    }
    return n;
  }

  function Yxr(e: string): string | null {
    let n = (E: string) => (E.split(/\s+/)[0] === "sed" ? E : null);
    if (e.length > sC) return n(y8(e));
    if (I8n(e)) return n(y8(e));
    let r = V_().parse(e);
    if (!r || _At(r)) return n(y8(e));
    let a = r.children.filter((E) => E.type !== "comment");
    if (
      a.length !== 1 ||
      (required(a[0]).type !== "command" &&
        !(
          required(a[0]).type === "redirected_statement" &&
          required(a[0]).children.some((E) => E.type === "command")
        ))
    )
      return n(y8(e));
    let h = cLe(r, null);
    if (!h) return null;
    let y = h.children.find((E) => E.type === "command_name");
    if (!y) return null;
    let k = Buffer.from(e, "utf8").subarray(y.startIndex).toString("utf8");
    return n(y8(k));
  }

  function Nkn(e: string): string | null {
    let n = e.trim();
    if (!n) return null;
    let r = Yxr(n);
    if (r !== null) return r;
    if (oE(n).split(/\s+/)[0] === "sed") return y8(n);
    return null;
  }

  function Xrt(e: string): boolean {
    return Nkn(e) !== null;
  }

  function Qrt(e: Input, n: Policy, r?: ReadonlySet<string>): Decision {
    let a = (h: string) => Xrt(h) && !(r?.has(h.trim()) ?? !1);
    if (e.command.length > sC || I8n(e.command))
      return {
        behavior: "ask",
        message:
          "sed command requires approval (contains potentially dangerous operations)",
        decisionReason: {
          type: "other",
          reason:
            "sed command could not be statically validated (command is over-length or contains characters bash and the analyzer tokenize differently)",
          bashMissKind: "sed-dangerous",
        },
      };
    if (XKs(e.command, a))
      return {
        behavior: "ask",
        message:
          "sed command requires approval (contains potentially dangerous operations)",
        decisionReason: {
          type: "other",
          reason:
            "sed command carries redirect-borne content that cannot be statically validated (swallowed arguments, unanalyzable heredoc, or expansion in a redirect target)",
          bashMissKind: "sed-dangerous",
        },
      };
    return {
      behavior: "passthrough",
      message: "No redirect-borne sed risk detected",
    };
  }

  function Yrt(e: Input, n: Policy, r: Command | "none"): Decision {
    let a = Sy(e.command),
      h;
    for (let y of a) {
      let k = Nkn(y);
      if (k === null) continue;
      let E = n.mode === "acceptEdits";
      if (((h ??= Qrt(e, n)), h.behavior === "ask")) {
        if (n.blockReadsOutsideWorkingDirectories === !0) return Mcr();
        return h;
      }
      if (!PF(k, { allowFileWrites: E, source: r })) {
        if (n.blockReadsOutsideWorkingDirectories === !0) return Mcr();
        return {
          behavior: "ask",
          message:
            "sed command requires approval (contains potentially dangerous operations)",
          decisionReason: {
            type: "other",
            reason:
              "sed command contains operations that require explicit approval (e.g., write commands, execute commands)",
            bashMissKind: "sed-dangerous",
          },
        };
      }
    }
    return {
      behavior: "passthrough",
      message: "No dangerous sed operations detected",
    };
  }

  function pOr(
    e: string,
    n: string[],
    r: string,
    a: Policy,
  ): Decision | undefined {
    let h: Decision | undefined;
    for (let y of n) {
      if (y === "") continue;
      if (Ys(y)) {
        h ??= dk(e);
        continue;
      }
      if (y.startsWith("~") && y !== "~" && !y.startsWith("~/")) {
        h ??= dk(e);
        continue;
      }
      let k = op(y);
      if (Ar(k) || OA(k) !== -1) {
        h ??= dk(e);
        continue;
      }
      let E = _x(k) ? k : HF(r, k);
      if (!Zje(k) && !exists(E)) continue;
      let N = D1(y, r, a, "read");
      if (N.allowed) continue;
      if (N.decisionReason?.type === "rule")
        return {
          behavior: "deny",
          message: `${e} in '${N.resolvedPath}' was blocked by a deny rule`,
          decisionReason: N.decisionReason,
        };
      if (R0(N.decisionReason)) {
        h ??= {
          behavior: "ask",
          message: `${e} names '${N.resolvedPath}', outside the working directories, which the read block does not allow without asking (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.`,
          decisionReason: N.decisionReason,
        };
        continue;
      }
      h ??= dk(e);
    }
    return h;
  }

  function gOr(
    e: Command | undefined,
    n: string,
    r: Policy,
    a: boolean,
    h: boolean,
  ): Decision | undefined {
    if (!e) return;
    let y = e.argv[0] ?? "";
    if (
      !h &&
      y.slice(y.lastIndexOf("/") + 1) === "env" &&
      e.argv.slice(1).some((re) => {
        let _e = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(re);
        return _e !== null && !bU(required(_e[1]), re.slice(_e[0].length));
      })
    )
      return bQ(
        "an environment variable assignment outside the safe list cannot be checked against the read block",
      );
    let k = l1([...e.argv]),
      E = k[0];
    if (E === void 0) return;
    let N = E.slice(E.lastIndexOf("/") + 1);
    if (N === "git") {
      let re = [];
      for (let _e = 1; _e < k.length; _e++) {
        let ke = required(k[_e]);
        if (
          (ke === "-C" ||
            ke === "--git-dir" ||
            ke === "--work-tree" ||
            ke === "--file" ||
            ke === "-f") &&
          k[_e + 1] !== void 0
        ) {
          re.push(required(k[_e + 1]));
          _e++;
        } else if (/^--(git-dir|work-tree|file)=/.test(ke))
          re.push(ke.slice(ke.indexOf("=") + 1));
        else if (ke.startsWith("-C") && ke.length > 2) re.push(ke.slice(2));
      }
      return re.length === 0 ? void 0 : pOr(N, re, n, r);
    }
    if (Object.hasOwn(aM, E) || mOr.has(N)) return;
    let V = KPn.get(N.replace(/[\d.]+$/, ""));
    if (!h && V !== void 0 && k.slice(1).includes("-"))
      return bQ(
        `${N} runs code from stdin, which cannot be checked against the read block`,
      );
    if (N === "xargs") return dk(N);
    if (
      !h &&
      V !== void 0 &&
      k
        .slice(1)
        .some(
          (re) =>
            V.has(re) ||
            [...V].some((_e) =>
              _e.startsWith("--")
                ? re.startsWith(_e + "=")
                : re.startsWith("-") &&
                  !re.startsWith("--") &&
                  re.length > 2 &&
                  re.includes(_e.slice(1)),
            ),
        )
    )
      return bQ(
        `${N} runs inline code, which cannot be checked against the read block`,
      );
    let oe: Decision | undefined;
    for (let re of k.slice(1)) {
      if (re === "") continue;
      if (Ys(re)) {
        oe ??= dk(N);
        continue;
      }
      let _e = re.indexOf("="),
        ke = re.startsWith("-")
          ? _e > 0
            ? [re.slice(_e + 1)]
            : !re.startsWith("--") && re.length > 2
              ? [re.slice(2)]
              : []
          : _e > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(re.slice(0, _e))
            ? [re, re.slice(_e + 1)]
            : [re];
      for (let Re of ke) {
        if (Re === "") continue;
        if (Re.startsWith("~") && Re !== "~" && !Re.startsWith("~/")) {
          oe ??= dk(N);
          continue;
        }
        let xe = op(Re);
        if (Ar(xe)) {
          oe ??= dk(N);
          continue;
        }
        if (a && !_x(xe)) {
          oe ??= dk(N);
          continue;
        }
        let Pe = Re,
          Be = OA(xe);
        if (Be !== -1) {
          let ot = xe.slice(0, Be);
          if (
            ((Pe = ot.endsWith("/") ? ot : $Mr(ot)),
            cYn(xe).some((it) => HOe(it)) || uYn(xe))
          ) {
            let it = D1(Pe, n, r, "read");
            if (!it.allowed && it.decisionReason?.type === "rule")
              return {
                behavior: "deny",
                message: `${N} in '${it.resolvedPath}' was blocked by a deny rule`,
                decisionReason: it.decisionReason,
              };
            oe ??= dk(N);
            continue;
          }
        }
        let Fe = op(Pe),
          Ke = _x(Fe) ? Fe : HF(n, Fe);
        if (!Zje(Fe) && !exists(Ke)) continue;
        let Qe = D1(Pe, n, r, "read");
        if (Qe.allowed) continue;
        if (Qe.decisionReason?.type === "rule")
          return {
            behavior: "deny",
            message: `${N} in '${Qe.resolvedPath}' was blocked by a deny rule`,
            decisionReason: Qe.decisionReason,
          };
        if (R0(Qe.decisionReason)) {
          oe ??= {
            behavior: "ask",
            message: `${N} names '${Qe.resolvedPath}', outside the working directories, which the read block does not allow without asking (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.`,
            decisionReason: Qe.decisionReason,
          };
          continue;
        }
        oe ??= {
          behavior: "ask",
          message: `${N} names '${Pe}', which cannot be checked against the read block (permissions.blockReadsOutsideWorkingDirectories)`,
          decisionReason: {
            type: "safetyCheck",
            reason: `${N} names '${Pe}', which cannot be checked against the read block (permissions.blockReadsOutsideWorkingDirectories)`,
            classifierApprovable: !1,
            circuitBreaker: "outsideReadsBlocked",
          },
        };
      }
    }
    return oe;
  }

  function DMr(e: string, n: Policy): Decision {
    let r = oE(e),
      [a] = r.split(/\s+/);
    if (!a)
      return { behavior: "passthrough", message: "Base command not found" };
    let h =
      a === "touch" &&
      (r !== e.trim() ||
        !r
          .split(/\s+/)
          .slice(1)
          .every((y) => /^['"]?[\w./~]/.test(y)));
    if (n.mode === "acceptEdits" && IMr(a) && !h)
      return {
        behavior: "allow",
        updatedInput: { command: e },
        decisionReason: { type: "mode", mode: "acceptEdits" },
      };
    return {
      behavior: "passthrough",
      message: `No mode-specific handling for '${a}' in ${n.mode} mode`,
    };
  }

  function bwn(e: Input, n: Policy): Decision {
    if (n.mode === "bypassPermissions")
      return {
        behavior: "passthrough",
        message: "Bypass mode is handled in main permission flow",
      };
    if (n.mode === "dontAsk")
      return {
        behavior: "passthrough",
        message: "DontAsk mode is handled in main permission flow",
      };
    let r = Sy(e.command),
      a = !1;
    for (let h of r) {
      let y = DMr(h, n);
      if (y.behavior === "ask" || y.behavior === "deny") return y;
      if (y.behavior === "passthrough")
        return {
          behavior: "passthrough",
          message: "No mode-specific validation required",
        };
      a = !0;
    }
    if (a)
      return {
        behavior: "allow",
        updatedInput: e,
        decisionReason: { type: "mode", mode: n.mode },
      };
    return {
      behavior: "passthrough",
      message: "No mode-specific validation required",
    };
  }

  function Vat(e: string[]): string[] {
    let n = e.slice();
    for (;;)
      if (n[0] === "command") {
        let r = 1;
        while (n[r] !== void 0 && /^-p+$/.test(required(n[r]))) r++;
        if (n[r] === "--") r++;
        if (r >= n.length || required(n[r]).startsWith("-")) return n;
        n = n.slice(r);
      } else if (n[0] === "builtin") {
        let r = n[1] === "--" ? 2 : 1;
        if (r >= n.length) return n;
        n = n.slice(r);
      } else if (n[0] === "noglob") {
        if (n.length <= 1) return n;
        n = n.slice(1);
      } else return n;
  }

  function WSn(): boolean {
    return _wn() && (jSn.getStore() !== !0 || !DY());
  }

  function Jat(e: string[]): string[] {
    let n = Vat(e);
    while (
      n[0] === "timeout" &&
      Zat.test(n[1] ?? "") &&
      !EMr.has(n[2] ?? "") &&
      WSn()
    )
      n = n.slice(2);
    return n;
  }

  function Lat(e: string): boolean {
    let n = Pat.getStore();
    if (
      P() !== "windows" ||
      !iwn.has(e) ||
      n?.off === !0 ||
      !je(gMr, { safe: !0 })
    )
      return !1;
    if (n !== void 0) n.pathListRefused = !0;
    return !0;
  }

  function awn(e: string): boolean {
    return mMr.has(e) && !Lat(e);
  }

  function hMr(e: Command): boolean {
    return (
      e.argvUnquotedGlob === void 0 &&
      e.argv[0] === "[[" &&
      /^\[\[[ \t\n]/.test(e.text)
    );
  }

  function Hat(e: Command): boolean {
    if (hMr(e) || !E6e(e)) return !1;
    let n = Jat(e.argv)[0] ?? "";
    return !awn(n) && (Lat(n) || KOe());
  }

  function oMr(e: string[]): boolean {
    if (e[0] !== "xargs") return !1;
    let n = use(
      need(host.xargsSafeFlags, "readonly.xargsSafeFlags")(frame().scope),
    );
    for (let r = 1; r < e.length; r++) {
      let a = required(e[r]);
      if (a === "--") return Rat.includes(e[r + 1] ?? "");
      if (a.startsWith("-")) {
        if (a.length === 2 && n[a] !== void 0 && n[a] !== "none") r++;
        continue;
      }
      return Rat.includes(a);
    }
    return !1;
  }

  function XSn(e: string): boolean {
    let n = e.length > sC ? null : V_()?.parse(e),
      r = n ? SG(e, n) : void 0;
    return (
      r?.kind === "simple" ? r.commands.map((h) => h.argv) : Sy(e).map(iC)
    ).some((h) => oMr(Jat(h)));
  }

  function lM(e: Policy): boolean {
    return !sc() && e.servedCall !== !0 && UAt() && j6e();
  }

  function Vh(
    e: NativeBashSandboxProbeInput,
    n?: NativeBashSecuritySandboxDispatch,
  ): boolean {
    if (cp() && ore()) return !0;
    if (!Ge.isSandboxingEnabled()) return !1;
    if (
      (e.shellType ?? "bash") === "bash" &&
      P() === "windows" &&
      KY() === null
    )
      return !1;
    let r =
      n?.disableUnsandboxedCommands === !0 ||
      gh().unsandboxedCommandsDisabled ||
      s.CLAUDE_CODE_EVAL_CONFINED;
    if (
      e.dangerouslyDisableSandbox &&
      !r &&
      (n?.userTypedShellDispatch === !0 || sandbox().unsandboxedCommandsAllowed)
    )
      return !1;
    if (!e.command) return Boolean(r);
    if (!r && IIo(e.command, e.shellType ?? "bash")) return !1;
    return !0;
  }

  function El(e: string, n?: Reason): string {
    if (n) {
      if (n.type === "classifier")
        return `Classifier '${n.classifier}' requires approval for this ${e} command: ${n.reason}`;
      switch (n.type) {
        case "hook":
          return n.reason
            ? `Hook '${n.hookName}' blocked this action: ${n.reason}`
            : `Hook '${n.hookName}' requires approval for this ${e} command`;
        case "rule": {
          let r = fn(n.rule.ruleValue),
            a = Ast(n.rule.source);
          return `Permission rule '${r}' from ${a} requires approval for this ${e} command`;
        }
        case "subcommandResults": {
          let r = [];
          for (let [a, h] of n.reasons)
            if (h.behavior === "ask" || h.behavior === "passthrough")
              if (e === "Bash") {
                let { commandWithoutRedirections: y, redirections: k } = KX(a),
                  E = k.length > 0 ? y : a;
                r.push(E);
              } else r.push(a);
          if (r.length > 0) {
            let a = r.length;
            return `This ${e} command contains multiple operations. The following ${O(a, "part")} ${O(a, "requires", "require")} approval: ${r.join(", ")}`;
          }
          return `This ${e} command contains multiple operations that require approval`;
        }
        case "permissionPromptTool":
          return `Tool '${n.permissionPromptToolName}' requires approval for this ${e} command`;
        case "sandboxOverride":
          return "Run outside of the sandbox";
        case "workingDir":
          return n.reason;
        case "safetyCheck":
        case "other":
          return n.reason;
        case "mode":
          return `Current permission mode (${KB(n.mode)}) requires approval for this ${e} command`;
        case "asyncAgent":
          return n.reason;
      }
    }
    return X4o(e);
  }

  function yD(
    e: Input,
    n: Policy,
    r: "exact" | "prefix",
    {
      skipCompoundCheck: a = false,
      astCommand: h,
      compoundBareAssignmentNames: y = [],
    }: MatchOptions = {},
  ): {
    matchingDenyRules: Rule[];
    matchingAskRules: Rule[];
    matchingAllowRules: Rule[];
  } {
    let k = dpe(n, Ks, "deny"),
      E;
    if (r === "prefix" && n.alwaysDenyRules.command?.length) {
      let commandBuiltinNames = use(
        need(
          host.commandDenyBuiltinRuleNames,
          "rules.commandDenyBuiltinNames",
        )(frame().scope),
      );
      let ke: string[] = [],
        Re = new Set(
          na(n)
            .filter((xe) => xe.source !== "command")
            .map((xe) => xe.ruleValue.ruleContent),
        );
      E = new Set(
        Array.from(k)
          .filter(
            ([xe, Pe]) =>
              (commandBuiltinNames.has(fn(Pe.ruleValue)) || ke.includes(xe)) &&
              !Re.has(xe),
          )
          .map(([xe]) => xe),
      );
    }
    let N = R8(e, k, r, {
        stripAllEnvVars: !0,
        skipCompoundCheck: !0,
        ...(h !== undefined ? { astCommand: h } : {}),
        ruleBehavior: "deny",
        ...(E !== undefined ? { firstCommandRuleContents: E } : {}),
      }),
      V = dpe(n, Ks, "ask"),
      oe = R8(e, V, r, {
        stripAllEnvVars: !0,
        skipCompoundCheck: !0,
        ...(h !== undefined ? { astCommand: h } : {}),
        ruleBehavior: "ask",
      }),
      re = dpe(n, Ks, "allow"),
      _e = R8(e, re, r, {
        skipCompoundCheck: a,
        ruleBehavior: "allow",
        ...(h !== undefined ? { astCommand: h } : {}),
        compoundBareAssignmentNames: y,
      });
    return {
      matchingDenyRules: N,
      matchingAskRules: oe,
      matchingAllowRules: _e,
    };
  }

  const Aun = (e: Input, n: Policy): Decision => {
    let r = e.command.trim(),
      {
        matchingDenyRules: a,
        matchingAskRules: h,
        matchingAllowRules: y,
      } = yD(e, n, "exact");
    if (a[0] !== void 0)
      return {
        behavior: "deny",
        message: `Permission to use ${Ks.name} with command ${r} has been denied.`,
        decisionReason: { type: "rule", rule: a[0] },
      };
    if (h[0] !== void 0)
      return {
        behavior: "ask",
        message: El(Ks.name),
        decisionReason: { type: "rule", rule: h[0] },
      };
    if (y[0] !== void 0)
      return {
        behavior: "allow",
        updatedInput: e,
        decisionReason: { type: "rule", rule: y[0] },
      };
    let k: Reason = {
      type: "other",
      reason: "This command requires approval",
      bashMissKind: "no-rule-match",
    };
    return {
      behavior: "passthrough",
      message: El(Ks.name, k),
      decisionReason: k,
      suggestions: Tzn(r),
    };
  };

  const PIoCore = (
    e: Input,
    n: Policy,
    r: boolean | undefined,
    a: Command | undefined,
    h = ue(),
    y: string[] = [],
    k?: boolean,
    E?: NativeBashSecurityEvaluationContext,
  ): Decision => {
    let N = e.command.trim(),
      V = Aun(e, n),
      oe = xQn(V);
    if (V.behavior === "deny" || (V.behavior === "ask" && !oe)) return V;
    let {
      matchingDenyRules: re,
      matchingAskRules: _e,
      matchingAllowRules: ke,
    } = yD(e, n, "prefix", {
      skipCompoundCheck: a !== void 0,
      ...(a !== undefined ? { astCommand: a } : {}),
      compoundBareAssignmentNames: y,
    });
    if (re[0] !== void 0)
      return {
        behavior: "deny",
        message: `Permission to use ${Ks.name} with command ${N} has been denied.`,
        decisionReason: { type: "rule", rule: re[0] },
      };
    if (oe) return V;
    if (_e[0] !== void 0)
      return {
        behavior: "ask",
        message: El(Ks.name),
        decisionReason: { type: "rule", rule: _e[0] },
      };
    let Re = mD(e, h, n, r, a?.redirects, a ? [a] : void 0, k);
    if (
      Re.behavior === "deny" ||
      (Re.behavior === "ask" && !Re.bashAllowRuleOverridable)
    )
      return Re;
    if (n.blockReadsOutsideWorkingDirectories === !0) {
      let it = Yrt(e, n, a ?? "none");
      if (it.behavior === "ask" && R0(it.decisionReason)) return it;
    }
    if (n.blockReadsOutsideWorkingDirectories === !0) {
      if (Uwn(e, a) && !(Vh(e) && lM(n)))
        return bQ(
          "an environment variable prefix that is not known to be safe cannot be checked against the read block",
        );
      let it = gOr(a, h, n, r === !0, Vh(e) && lM(n));
      if (it) return it;
    }
    if (V.behavior === "allow") return V;
    if (ke[0] !== void 0)
      return {
        behavior: "allow",
        updatedInput: e,
        decisionReason: { type: "rule", rule: ke[0] },
      };
    if (Re.behavior === "ask") return Re;
    let xe = Yrt(e, n, a ?? "none");
    if (xe.behavior !== "passthrough") return xe;
    let Pe = n.mode === "auto",
      Be = bwn(e, Pe ? { ...n, mode: "acceptEdits" } : n);
    if (!Pe && Be.behavior !== "passthrough") return Be;
    let Fe = qde(E && b0e(E)),
      Ke = jde(n) && XSn(e.command),
      Qe = a !== void 0 && Hat(a);
    if (!Ke && !Qe && Ks.isReadOnly(e, E) && !Uwn(e, a) && !T8(y, Fe))
      return {
        behavior: "allow",
        updatedInput: e,
        decisionReason: { type: "other", reason: iPe },
      };
    let ot: Reason = {
      type: "other",
      reason: "This command requires approval",
      bashMissKind: "no-rule-match",
      ...(Pe && Be.behavior !== "allow" && { acceptEditsCannotAllow: !0 }),
    };
    return {
      behavior: "passthrough",
      message: El(Ks.name, ot),
      decisionReason: ot,
      suggestions: Tzn(N),
    };
  };

  function PIo(
    e: Input,
    n: Policy,
    r: boolean | undefined,
    a: Command | undefined,
    h = ue(),
    y: string[] = [],
    k?: boolean,
    E?: NativeBashSecurityEvaluationContext,
  ): Decision {
    const previous = frame();
    return frames.run(
      { ...previous, policy: n, scope: { policyId: n.scope.policyId, cwd: h } },
      () =>
        pathOwner.withPolicyScope(
          n,
          h,
          () => PIoCore(e, n, r, a, h, y, k, E),
          previous.receipts,
        ).result,
    );
  }
  function klt(e: string): boolean {
    return !/[\s\\$`'"*?[\]{}<>|&;()]/.test(e);
  }

  function Tbn(e: string): boolean {
    return (
      _x(e) ||
      e.startsWith("./") ||
      e.startsWith("../") ||
      e === "." ||
      e === ".."
    );
  }

  function vbn(e: string, n: string): boolean {
    let r = e,
      a,
      h = /^[A-Za-z]:[\\/]/.exec(e);
    if (h) {
      r = e.slice(h[0].length);
      a = 0;
    } else if (/^[\\/]/.test(e) || e.includes("\\")) return !1;
    else {
      if (/^[\\/]{2}/.test(n)) return !1;
      a = 0;
      for (let E of n.replace(/^[A-Za-z]:/, "").split(/[\\/]/)) {
        if (E === "" || E === ".") continue;
        a += E === ".." ? -1 : 1;
      }
    }
    let y = !h,
      k = !1;
    for (let E of r.split(/[\\/]/)) {
      if (E === "" || E === ".") continue;
      if (E === "..") {
        if (a === 0) return !1;
        {
          a -= 1;
          k = !0;
        }
        continue;
      }
      if (y && k) return !1;
      if (E.includes(":") || /[ .]$/.test(E)) return !1;
      a += 1;
    }
    return !0;
  }

  function Wlt(e: Command | undefined, n: string, r: Policy): string | null {
    if (!e) return null;
    if (e.envVars.length > 0 || e.redirects.length > 0) return null;
    if (e.argv.length !== 2 || e.argv[0] !== "cd") return null;
    let a = required(e.argv[1]);
    if (Ys(a)) return null;
    if (a.startsWith("-")) return null;
    if (!Tbn(a)) return null;
    if (!_x(a) && a.split(/[\\/]/).includes("..")) return null;
    if (P() === "windows" && !vbn(a, n)) return null;
    if (/[*?[\]]/.test(a)) return null;
    let { allowed: h, resolvedPath: y } = D1(a, n, r, "read");
    if (!h) return null;
    if (!vy(y, r, [y])) return null;
    return y;
  }

  function Elt(e: Command[], n: string, r: Policy): Decision | null {
    let a = new Set([n]),
      h: string | undefined = n,
      y: string | undefined,
      k: (string | undefined)[] = [],
      E = !1;
    for (let N of e) {
      let V = l1(N.argv),
        oe = V[0]?.replace(/^.*[\\/]/, "");
      if (oe === "cd" || oe === "chdir" || oe === "pushd" || oe === "popd") {
        let re = V.slice(1).filter(
            (Pe) => Pe !== "--" && (Pe === "-" || !Pe.startsWith("-")),
          ),
          _e =
            re.length === 1
              ? re[0]
              : re.length === 0 && (oe === "cd" || oe === "chdir")
                ? "~"
                : void 0,
          ke = V.slice(1).filter(
            (Pe) =>
              Pe !== "--" &&
              Pe !== "-" &&
              Pe.startsWith("-") &&
              !/^-[PLe@]+$/.test(Pe),
          );
        if (
          (oe === "pushd" || oe === "popd") &&
          ke.length === 1 &&
          ke[0] === "-n"
        )
          continue;
        let Re: boolean =
            oe !== "popd" &&
            ke.length === 0 &&
            _e !== void 0 &&
            _e !== "-" &&
            !/^[+-]\d+$/.test(_e) &&
            !Ys(_e) &&
            !/[*?[\]$`]/.test(_e) &&
            !(_e.startsWith("~") && _e !== "~" && !_e.startsWith("~/")) &&
            !N.envVars.some((Pe) => Ys(Pe.value)),
          xe =
            ke.length === 0 &&
            (oe === "popd"
              ? re.length === 0 && k.length > 0
                ? { dir: k.pop() }
                : void 0
              : _e === "-" && y !== void 0
                ? { dir: y }
                : void 0);
        if (xe) [y, h] = [h, xe.dir];
        else if (Re) {
          if (oe === "pushd") k.push(h);
          if (((y = h), a.add(HF(n, op(required(_e)))), h !== void 0)) {
            h = HF(h, op(required(_e)));
            a.add(h);
          }
        } else {
          if (oe === "pushd") k.push(h);
          {
            E = !0;
            y = h;
            h = void 0;
          }
        }
        if (h === void 0 && (xe || Re)) E = !0;
        continue;
      }
      for (let re of a) {
        let _e = mD({ command: N.text }, re, r, !1, N.redirects, [N]);
        if (_e.behavior === "deny" && _e.decisionReason?.type === "rule")
          return _e;
      }
      if (E)
        for (let re of SSn(N)) {
          let _e = Pti(re, r, "read");
          if (_e !== null)
            return {
              behavior: "deny",
              message: `${V[0]} reads '${re}' after a cd whose target cannot be resolved, and a deny rule (${_e.ruleValue.ruleContent ?? _e.ruleValue.toolName}) names that file under a directory it may run in`,
              decisionReason: { type: "rule", rule: _e },
            };
        }
    }
    return null;
  }

  function kwn(e: Command | undefined): boolean {
    return e?.andChainOperand === !0 || !RMr();
  }

  function wOr(
    e: string[],
    n: (Command | undefined)[] | undefined,
    r: string,
    a: string,
  ): { subcommands: string[]; astCommandsByIdx: (Command | undefined)[] } {
    let h: string[] = [],
      y: (Command | undefined)[] = [];
    for (let k = 0; k < e.length; k++) {
      let E = required(e[k]),
        N = n?.[k];
      if (
        ((E === `cd ${r}` && klt(r)) || (E === `cd ${a}` && klt(a))) &&
        N !== void 0 &&
        N.argv.length === 2 &&
        N.argv[0] === "cd" &&
        N.envVars.length === 0 &&
        N.redirects.length === 0 &&
        !/[*?[\]]/.test(required(N.argv[1])) &&
        !Ys(required(N.argv[1]))
      )
        continue;
      {
        h.push(E);
        y.push(N);
      }
    }
    return { subcommands: h, astCommandsByIdx: y };
  }

  function D5e(
    tool: { name: string },
    input: { command?: unknown; dangerouslyDisableSandbox?: unknown },
  ): boolean {
    const r = input.dangerouslyDisableSandbox;
    if (r !== true && r !== "true") return false;
    const command =
      typeof input.command === "string" ? input.command : undefined;
    const shellType = tool.name === "PowerShell" ? "powershell" : undefined;
    return (
      !Vh({ command, dangerouslyDisableSandbox: true, shellType }) &&
      Vh({ command, dangerouslyDisableSandbox: false, shellType })
    );
  }
  function Cbn(e: Input, n: Policy): Decision | null {
    let { matchingDenyRules: r, matchingAskRules: a } = yD(e, n, "prefix");
    if (r[0] !== void 0)
      return {
        behavior: "deny",
        message: `Permission to use ${Ks.name} with command ${e.command} has been denied.`,
        decisionReason: { type: "rule", rule: r[0] },
      };
    let h = Aun(e, n);
    if (h.behavior === "deny") return h;
    if (a[0] !== void 0)
      return {
        behavior: "ask",
        message: El(Ks.name),
        decisionReason: { type: "rule", rule: a[0] },
      };
    if (h.behavior !== "passthrough") return h;
    return null;
  }

  function kbn(e: Input, n: Policy, r: Command[]): Decision {
    let a = e.command.trim(),
      { matchingDenyRules: h, matchingAskRules: y } = yD(
        e,
        n,
        "prefix",
        r.length === 1 ? { astCommand: required(r[0]) } : {},
      );
    if (h[0] !== void 0)
      return {
        behavior: "deny",
        message: `Permission to use ${Ks.name} with command ${a} has been denied.`,
        decisionReason: { type: "rule", rule: h[0] },
      };
    if (r.length > 1 || r[0]?.text !== a) {
      let k;
      for (let E of r) {
        let N = yD({ command: E.text }, n, "prefix", { astCommand: E });
        if (N.matchingDenyRules[0] !== void 0)
          return {
            behavior: "deny",
            message: `Permission to use ${Ks.name} with command ${a} has been denied.`,
            decisionReason: { type: "rule", rule: N.matchingDenyRules[0] },
          };
        k ??= N.matchingAskRules[0];
      }
      if (k)
        return {
          behavior: "ask",
          message: El(Ks.name),
          decisionReason: { type: "rule", rule: k },
        };
    }
    if (y[0] !== void 0)
      return {
        behavior: "ask",
        message: El(Ks.name),
        decisionReason: { type: "rule", rule: y[0] },
      };
    return {
      behavior: "allow",
      updatedInput: e,
      decisionReason: { type: "other", reason: wEe },
    };
  }

  async function qwn(
    e: Input,
    n: Policy,
    r: { commandPrefix?: string | undefined } | null | undefined,
    a: boolean | undefined,
    h: Command | undefined,
    y: string,
    k: string[] = [],
    E?: NativeBashSecurityEvaluationContext,
  ): Promise<Decision> {
    let N = Aun(e, n);
    if (N.behavior === "deny" || (N.behavior === "ask" && !xQn(N))) return N;
    let V = PIo(e, n, a, h, y, k, void 0, E);
    if (V.behavior === "deny" || V.behavior === "ask") return V;
    if (V.behavior === "allow") return V;
    let oe = r?.commandPrefix ? XMr(r.commandPrefix) : Tzn(e.command);
    return { ...V, suggestions: oe };
  }

  function jOr(e: Input, n: Policy, r: Command[]): Decision | null {
    let a = Cbn(e, n);
    if (a?.behavior === "deny") return a;
    for (let h of r) {
      let y = yD({ ...e, command: h.text }, n, "prefix", { astCommand: h })
        .matchingDenyRules[0];
      if (y !== void 0)
        return {
          behavior: "deny",
          message: `Permission to use ${Ks.name} with command ${e.command} has been denied.`,
          decisionReason: { type: "rule", rule: y },
        };
    }
    if (a?.behavior === "allow") {
      if (
        (a.decisionReason?.type === "rule"
          ? a.decisionReason.rule.ruleValue.ruleContent
          : void 0) === e.command.trim()
      )
        return a;
    }
    if (a?.behavior === "ask") return a;
    return null;
  }

  return {
    pathOwner,
    contexts: { pathList: Pat, timeout: jSn },
    native: {
      isReadOnly: Ks.isReadOnly,
      R0,
      KOe,
      bQ,
      Mcr,
      Tzn,
      dpe,
      fn,
      Cbn,
      kbn,
      qwn,
      jOr,
      D5e,
      klt,
      Tbn,
      vbn,
      Wlt,
      Elt,
      kwn,
      wOr,
      Ikn,
      Xxr,
      y8,
      Yxr,
      Nkn,
      Xrt,
      Qrt,
      Yrt,
      pOr,
      gOr,
      DMr,
      bwn,
      Vat,
      WSn,
      Jat,
      Lat,
      awn,
      hMr,
      Hat,
      oMr,
      XSn,
      lM,
      Vh,
      El,
      yD,
      Aun,
      PIo,
      T8,
      qde,
      kzn,
      xQn,
    },
    withPolicyScope<T>(
      policy: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { policy, scope: { policyId: policy.scope.policyId, cwd }, receipts },
        () => pathOwner.withPolicyScope(policy, cwd, run, receipts),
      );
    },
  };
}
