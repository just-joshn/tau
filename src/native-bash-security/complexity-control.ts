import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeBashSyntaxNode as Node } from "../native-bash-parser.js";
import type { NativeBashSemanticCommand as Command } from "../native-bash-semantics.js";
import type { NativeBashPreparationEnvironment as Environment } from "../native-bash-command-preparation.js";
import type { createNativeBashSecurityNestedRemoval } from "./nested-removal.js";
import type {
  NativeBashSecurityInlineContext as InlineContext,
  NativeBashSecurityContext as Context,
} from "./security-recursion-types.js";
import { nativeBashRemovalReviewConfig } from "./security-recursion-types.js";
import {
  nativeBashTextRuleSearch as f9a,
  findNativeBashTextRule as zwn,
} from "./rule-text-search.js";
import {
  NativeBashSecurityUnsupported,
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityInput as Input,
  type NativeBashSecurityRule as Rule,
} from "./security-types.js";
export interface NativeBashComplexityHost {
  currentCwd?: (scope: Scope) => Fact<string>;
  rawBashRules?: (
    permission: Policy,
    behavior: "deny" | "ask",
    scope: Scope,
  ) => Fact<readonly Rule[]>;
  readFeature?: (
    kind: "b" | "je",
    key:
      | "tengu_humble_hartmanis"
      | "tengu_tender_quill"
      | "tengu_quiet_larkspur"
      | "tengu_plain_sorrel"
      | "tengu_umber_plover",
    defaultValue: boolean,
    scope: Scope,
  ) => Fact<boolean>;
  sandboxPolicyDataSuspended?: (
    permission: Policy,
    scope: Scope,
  ) => Fact<boolean>;
  sandboxCommandExempt?: (command: string, scope: Scope) => Fact<boolean>;
  unsandboxedFallbackClosedByTrustedSource?: (scope: Scope) => Fact<boolean>;
  permissionMode?: (scope: Scope) => Fact<string>;
  reportError?: (error: unknown, scope: Scope) => Fact<void>;
  escapedWhitespaceStackOverflow?: (scope: Scope) => Fact<void>;
  telemetry?: (
    event:
      "tengu_bash_rule_found_in_text" | "tengu_bash_dangerous_rm_too_complex",
    metadata: { behavior?: "deny" | "ask"; kind?: string },
    scope: Scope,
  ) => Fact<void>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing native complexity scope");
  return value;
}
export function createNativeBashComplexityControl(
  nested: ReturnType<typeof createNativeBashSecurityNestedRemoval>,
  host: NativeBashComplexityHost,
) {
  const { recursion, literal } = nested;
  const { syntax, shapes } = recursion;
  const { policy, semantic, preparation } = syntax;
  const path = policy.pathOwner;
  type Tree = Node | typeof semantic.parseAbort | null;
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(receipt: Fact<T>) =>
    readNativeBashSecurityFact(receipt, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const ue = () => use(need(host.currentCwd, "cwd.current")(frame().scope));
  const readFeature = (
    kind: "b" | "je",
    key: Parameters<NonNullable<NativeBashComplexityHost["readFeature"]>>[1],
    fallback: boolean,
  ) =>
    use(
      need(host.readFeature, "features.complexity")(
        kind,
        key,
        fallback,
        frame().scope,
      ),
    );
  const ubn = () => readFeature("je", "tengu_humble_hartmanis", false);
  const je = (_key: "tengu_tender_quill", _options: { safe: true }) =>
    readFeature("je", "tengu_tender_quill", true);
  const b = (
    key: "tengu_quiet_larkspur" | "tengu_plain_sorrel" | "tengu_umber_plover",
    fallback: true,
  ) => readFeature("b", key, fallback);
  const ROr = "tengu_tender_quill";
  const sources: Record<string, boolean | undefined> = {
    userSettings: true,
    projectSettings: true,
    localSettings: true,
    flagSettings: true,
    policySettings: true,
    cliArg: true,
    session: true,
    command: false,
    toolsNarrowing: false,
    mcpServerPolicy: false,
    hostCredential: false,
    mcpMount: false,
  };
  const xri = (
    permission: Policy,
    _tool: { name: "Bash" },
    behavior: "deny" | "ask",
  ) =>
    use(
      need(host.rawBashRules, "rules.rawBashSet")(
        permission,
        behavior,
        frame().scope,
      ),
    ).filter((rule) => sources[rule.source]);
  const IDt = (permission: Policy) =>
    use(
      need(host.sandboxPolicyDataSuspended, "sandbox.policyDataSuspended")(
        permission,
        frame().scope,
      ),
    ) || permission.sandboxAutoAllowSuspended === true;
  const Czn = (command: string) =>
    use(
      need(host.sandboxCommandExempt, "sandbox.commandExempt")(
        command,
        frame().scope,
      ),
    );
  const gO = () =>
    use(need(host.permissionMode, "sandbox.permissionMode")(frame().scope));
  const Ge = {
    ...path.gate.bindings.Ge,
    isAutoAllowBashIfSandboxedEnabled: () =>
      path.gate.bindings.Ge.getFsWriteConfig().autoAllowBashIfSandboxed,
    isAutoAllowSupported: () =>
      path.gate.bindings.Ge.getFsWriteConfig().autoAllowSupported,
    isUnsandboxedFallbackClosedByTrustedSource: () =>
      use(
        need(
          host.unsandboxedFallbackClosedByTrustedSource,
          "sandbox.unsandboxedFallbackClosedByTrustedSource",
        )(frame().scope),
      ),
  };
  const { Cbn, yD, El, Elt, Vh, lM, kbn, qde, T8, dpe } = policy.native;
  const Ks = { name: "Bash" } satisfies { name: "Bash" };
  const { sb } = syntax.native;
  const { Xde, Ylt, C8 } = shapes.native;
  const { Sa, A8 } = shapes.outcomes;
  const { LOe } = literal.native;
  const { qlt, Pbn } = nested.native;
  const { l1, o2, nb } = path.native;
  const {
    epe,
    nPt,
    Lwn,
    QKt,
    VQn,
    Mwn,
    zQn,
    m7e,
    FVo,
    $Vo,
    UVo,
    XKt,
    SG,
    qti,
  } = semantic.native;
  const {
    alternateLines: YKs,
    hasUnparsedBodies: qKs,
    nestedTextsFromTree: r2o,
    hasParenthesizedExpansion: d2o,
    flattenCommandTexts: M8n,
    hasErroredAlternatives: s2o,
    splitCommands: Sy,
  } = preparation.projection;
  const bU = preparation.environmentValueSafe;
  const rmt = () => preparation.features.appendEnvironmentNeedsReview();
  const b0e = (context: Context) => new Set(context.sessionEnvVars?.keys());
  const mD = path.native.mD;
  const iM = () => {
    const receipt = use(
      need(
        nested.host.removalReviewFeature,
        "features.removalReview",
      )(frame().scope),
    );
    return nativeBashRemovalReviewConfig(
      receipt,
      use(
        need(
          nested.host.dangerousRemovalTimeoutDisabled,
          "environment.dangerousRemovalTimeoutDisabled",
        )(frame().scope),
      ),
    );
  };
  const Qv = (
    event:
      "tengu_bash_rule_found_in_text" | "tengu_bash_dangerous_rm_too_complex",
    metadata: { behavior?: "deny" | "ask"; kind?: string },
  ) =>
    shapes.observations.native.Qv(() => {
      use(
        need(host.telemetry, "telemetry.complexity")(
          event,
          metadata,
          frame().scope,
        ),
      );
    });
  const f = <T extends string>(value: T) => value;
  const i = (error: unknown) => {
    use(need(host.reportError, "errors.report")(error, frame().scope));
  };
  const t = (_message: string, _options: { level: "error" }) => {
    use(
      need(
        host.escapedWhitespaceStackOverflow,
        "errors.escapedWhitespaceStackOverflow",
      )(frame().scope),
    );
  };
  const wEe = "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)";
  const Vwn = new Set([
    "time",
    "nohup",
    "timeout",
    "nice",
    "stdbuf",
    "env",
    "command",
    "builtin",
    "noglob",
  ]);

  const kOr = new Set(["printf", "test", "read", "wait", "unset", ...nPt]);

  const Kwn = new Set([
    "python",
    "python3",
    "node",
    "bun",
    "deno",
    "ruby",
    "perl",
  ]);

  const hOr = new Set([
    "if",
    "of",
    "bs",
    "ibs",
    "obs",
    "cbs",
    "count",
    "skip",
    "seek",
    "iseek",
    "oseek",
    "conv",
    "status",
    "iflag",
    "oflag",
  ]);

  const yOr = /[^ \t\n][ \t\n]+[^ \t\n]/;

  const XCt = [
    "PATH",
    "PYTHONPATH",
    "NODE_PATH",
    "RUBYLIB",
    "PERL5LIB",
    "PERLLIB",
    "GEM_PATH",
    "CLASSPATH",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "LD_LIBRARY_PATH",
    "LIBRARY_PATH",
    "CPATH",
    "C_INCLUDE_PATH",
    "CPLUS_INCLUDE_PATH",
    "R_LIBS",
    "R_LIBS_USER",
    "R_LIBS_SITE",
  ];

  const yqs = new Set([
    "GOFLAGS",
    "RUSTFLAGS",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_EXTERNAL_DIFF",
    "GIT_PROXY_COMMAND",
    "SUDO_ASKPASS",
    "ZDOTDIR",
    "NULLCMD",
    "READNULLCMD",
    "CDPATH",
    "GCONV_PATH",
    "NLSPATH",
    "DOTNET_STARTUP_HOOKS",
    "npm_config_node_options",
    "NPM_CONFIG_NODE_OPTIONS",
    "LESSOPEN",
    "LESSCLOSE",
    "MANPAGER",
    "MAVEN_OPTS",
    "MAVEN_ARGS",
    "MAVEN_CONFIG",
    "ANT_OPTS",
    "ANT_ARGS",
    "GRADLE_OPTS",
    "JAVA_OPTS",
    "JVM_OPTS",
    "LEIN_JVM_OPTS",
    "ES_JAVA_OPTS",
    "SBT_OPTS",
    "SONAR_SCANNER_OPTS",
    "SONAR_SCANNER_JAVA_OPTS",
    "MAKEFLAGS",
    "GNUMAKEFLAGS",
    "MFLAGS",
    "MAKEFILES",
    "AWKPATH",
    "AWKLIBPATH",
    "DEVELOPER_DIR",
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
    "LDLIBS",
    "CC",
    "CXX",
    "CPP",
    "MAKE",
    "AR",
    "AS",
    "LD",
    "LEX",
    "YACC",
    "RANLIB",
    "ARFLAGS",
    "RANLIBFLAGS",
    "NM",
    "STRIP",
    "OBJCOPY",
    "OBJDUMP",
    "PKG_CONFIG",
    "FC",
    "F77",
    "FFLAGS",
    "FCFLAGS",
    "CGO_CFLAGS",
    "CGO_CPPFLAGS",
    "CGO_CXXFLAGS",
    "CGO_FFLAGS",
    "CGO_LDFLAGS",
    "HOST_CC",
    "HOST_CXX",
    "HOST_AR",
    "HOST_RANLIB",
    "HOST_ARFLAGS",
    "HOST_CFLAGS",
    "HOST_CXXFLAGS",
    "TARGET_RANLIB",
    "TARGET_ARFLAGS",
    "TARGET_CC",
    "TARGET_CXX",
    "TARGET_AR",
    "TARGET_CFLAGS",
    "TARGET_CXXFLAGS",
    "GCC_EXEC_PREFIX",
    "COMPILER_PATH",
    "DEPENDENCIES_OUTPUT",
    "SUNPRO_DEPENDENCIES",
    "GOAUTH",
    "GOTOOLCHAIN",
    "OPENSSL_ENGINES",
    "SHELLOPTS",
    "BASHOPTS",
    "PS4",
    "PROMPT_COMMAND",
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "GIT_EXEC_PATH",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_PAGER",
    "PAGER",
    "EDITOR",
    "VISUAL",
    "BROWSER",
    "PYTHONWARNINGS",
    "PYTHONBREAKPOINT",
    "PERL5DB",
    "NODE_REPL_EXTERNAL_MODULE",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "IBM_JAVA_OPTIONS",
    "OPENJ9_JAVA_OPTIONS",
    "NODE_OPTIONS",
    "NODE_COMPILE_CACHE",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "PYTHONUSERBASE",
    "BASH_ENV",
    "ENV",
    "PERL5OPT",
    "RUBYOPT",
    "GEM_HOME",
    "RUBYGEMS_GEMDEPS",
    "BUNDLE_GEMFILE",
    "OPENSSL_CONF",
    "OPENSSL_CONF_INCLUDE",
    "OPENSSL_MODULES",
    "DYLD_INSERT_LIBRARIES",
    "LD_PRELOAD",
    "LD_AUDIT",
    "BUN_OPTIONS",
    "npm_config_script_shell",
    "NPM_CONFIG_SCRIPT_SHELL",
    "RUSTC",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTDOC",
    "CARGO_BUILD_RUSTC",
    "CARGO_BUILD_RUSTC_WRAPPER",
    "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
    "CARGO_BUILD_RUSTDOC",
    "CARGO_BUILD_RUSTFLAGS",
    "RUSTDOCFLAGS",
    "CARGO_BUILD_RUSTDOCFLAGS",
    "CARGO_ENCODED_RUSTDOCFLAGS",
    "CARGO_ENCODED_RUSTFLAGS",
    "GOROOT",
    "PSModulePath",
    "PSMODULEPATH",
    "JAVA_HOME",
    "JAVACMD",
    "JDK_HOME",
    "DOTNET_ROOT",
    "COREPACK_HOME",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "PYENV_ROOT",
    "PYENV_VERSION",
    "VOLTA_HOME",
    "ASDF_DIR",
    "ASDF_DATA_DIR",
    "RBENV_ROOT",
    "RBENV_VERSION",
    "NODENV_ROOT",
    "NODENV_VERSION",
    "GOENV_ROOT",
    "GOENV_VERSION",
    "JENV_ROOT",
    "JENV_VERSION",
    "PLENV_ROOT",
    "PLENV_VERSION",
    "PERL5SHELL",
    "RUBYSHELL",
    "NODE_V8_COVERAGE",
    "NODE_REDIRECT_WARNINGS",
    "AWS_PAGER",
    "GH_PAGER",
    "CLOUDSDK_PYTHON",
    "CLOUDSDK_PYTHON_ARGS",
    "CLOUDSDK_GSUTIL_PYTHON",
    "CLOUDSDK_BQ_PYTHON",
    "UV_PYTHON",
    "GH_BROWSER",
    "SOPS_GPG_EXEC",
    "RSYNC_RSH",
    "CVS_RSH",
    "TAR_OPTIONS",
    "DOCKER_CLI_PLUGIN_EXTRA_DIRS",
    "R_PROFILE",
    "R_PROFILE_USER",
    "R_ENVIRON",
    "R_ENVIRON_USER",
  ]);

  const Lr = new Set([...yqs].map((e) => e.toUpperCase()));

  const Dr =
    /^(?:DYLD_|LD_|BASH_FUNC_|GIT_CONFIG_|LUA_|TF_CLI_ARGS|CARGO_ALIAS_|CARGO_TARGET_[A-Z0-9_]+_(?:RUNNER|LINKER|RUSTFLAGS|RUSTDOCFLAGS)$|(?:CC|CXX|AR|RANLIB|(?:AR|RANLIB)FLAGS|FC?FLAGS|CFLAGS|CXXFLAGS|LDFLAGS)_(?:X86_64|I[3-6]86|AARCH64|ARM|RISCV|WASM|POWERPC|S390X|MIPS|SPARC|LOONGARCH|THUMB)[A-Z0-9_-]*$|[A-Z0-9][A-Z0-9_]*_(?:EXTERNAL_DIFF|PAGER|EDITOR)$)/;

  const vr = new Set(XCt);
  function vCe(e: string): boolean {
    let n = e.toUpperCase().replace(/-/g, "_");
    return Lr.has(n) || Dr.test(n);
  }

  function I8e(e: string): boolean {
    return vr.has(e.toUpperCase().replace(/-/g, "_"));
  }

  function jxt(e: string): boolean {
    return /^~(?!\/|$)/.test(e);
  }

  function mlt(e: string | undefined): boolean {
    return e !== void 0 && e !== "PARSE_ABORT" && e !== "ERROR";
  }

  function SOr(e: string[]): string[] | null {
    let n = 0;
    while (n < e.length) {
      let a = required(e[n]).match(/^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/);
      if (a === null) break;
      if (epe(required(a[1]))) return null;
      if (/["'`$\\(){}|;&<>*?[\]]/.test(required(a[2]))) return null;
      n++;
    }
    return n === 0 ? e : e.slice(n);
  }

  function uOr(e: string, n: Node, r: string | undefined): boolean {
    if (r !== void 0 || !XKt.test(e) || e.includes("\\\n")) return mlt(r);
    try {
      let a = SG(e, n, { passesEscapedBlanks: !0 });
      return (
        a.kind === "simple" || (a.kind === "too-complex" && mlt(a.nodeType))
      );
    } catch (a) {
      if (a instanceof NativeBashSecurityUnsupported) throw a;
      if (a instanceof RangeError)
        t(
          "Bash permissions: stack overflow while analyzing a command with an escaped space or tab, so deny and ask rules are searched for in its text",
          { level: "error" },
        );
      else i(a);
      return !1;
    }
  }

  function ybn(e: Environment): boolean {
    return (e.isAppend === !0 && rmt()) || !bU(e.name, e.value);
  }

  function Yde(
    e: Tree,
    n: string | undefined,
    { budget: r }: InlineContext,
  ): Decision | undefined {
    if (
      e === null ||
      e === semantic.parseAbort ||
      n !== void 0 ||
      (e.type !== "ERROR" && !s2o(e))
    )
      return;
    if ([e.text, r.command].some((h) => Xde(h) || Ylt(h)))
      return nb(
        "rm",
        "This command could not be checked for dangerous rm operations: the shell may read it differently than it was parsed. This requires explicit approval.",
        "not ruled out \u2014 the shell may read this command differently than it was parsed",
        "unparsed_line",
      );
    let a =
      "Claude Code can't be sure it read this command the way the shell will, so it can't rule out a dangerous removal.";
    return {
      behavior: "ask",
      message: `${a} This requires explicit approval.`,
      decisionReason: {
        type: "safetyCheck",
        reason: `${a} Read the command, and don't go ahead if you can't tell what it does.`,
        classifierApprovable: !1,
        circuitBreaker: "dangerousRemoval",
        removalRule: "unparsed_line",
      },
      suggestions: [],
    };
  }

  function COr(e: string, n: Node, r: Policy): Decision | undefined {
    let a = ue();
    for (let { line: h, lineRoot: y } of YKs(e, n)) {
      let k = y && SG(h, y, { readsDivergentShapes: !0 });
      if (k?.kind !== "simple") continue;
      let E = k.commands.some((_e) => sb(_e.text)),
        N = E ? Elt(k.commands, a, r) : null;
      if (N) return N;
      let V: Decision | undefined,
        oe: Decision | undefined,
        re: Decision | undefined;
      for (let _e of k.commands) {
        let { matchingDenyRules: ke, matchingAskRules: Re } = yD(
            { command: _e.text },
            r,
            "prefix",
            {
              skipCompoundCheck: !0,
              astCommand: _e,
              compoundBareAssignmentNames: k.bareAssignmentNames,
            },
          ),
          xe = ke[0];
        if (xe !== void 0)
          return {
            behavior: "deny",
            message: `Permission to use ${Ks.name} with command ${e} has been denied.`,
            decisionReason: { type: "rule", rule: xe },
          };
        let Pe = Re[0];
        if (Pe !== void 0 && V === void 0)
          V = {
            behavior: "ask",
            message: El(Ks.name),
            decisionReason: { type: "rule", rule: Pe },
          };
        let Be = mD({ command: _e.text }, a, r, E, _e.redirects, [_e]);
        if (Be.behavior === "deny") return Be;
        if (Be.behavior === "ask" && Be.decisionReason?.type === "safetyCheck")
          if (Be.decisionReason.circuitBreaker === "dangerousRemoval")
            re ??= Be;
          else oe ??= Be;
      }
      return re && V?.decisionReason?.type === "rule"
        ? iM().enabled
          ? re
          : { ...re, matchedAskRule: V.decisionReason.rule }
        : (re ?? V ?? oe);
    }
    return;
  }

  async function AOr(
    e: Input,
    n: Policy,
    r: Tree,
    a: string | undefined,
    h: (() => Decision | undefined) | undefined,
    y: string | undefined,
    k: boolean,
    E: InlineContext,
    N: Context,
  ): Promise<Decision | null> {
    let V = Cbn(e, n);
    if (V?.behavior === "deny") return V;
    let oe = xri(n, Ks, "deny"),
      re = xri(n, Ks, "ask"),
      ke =
        (oe.length > 0 || re.length > 0) &&
        ubn() &&
        (!r || r === semantic.parseAbort || !uOr(e.command, r, a) || qKs(r))
          ? f9a(e.command)
          : void 0,
      Re = ke && zwn(ke, oe);
    if (Re !== void 0)
      return (
        Qv("tengu_bash_rule_found_in_text", { behavior: f("deny") }),
        {
          behavior: "deny",
          message: `Permission to use ${Ks.name} with command ${e.command} has been denied.`,
          decisionReason: { type: "rule", rule: Re },
        }
      );
    if (dpe(n, Ks, "deny").size > 0) {
      let ot = new Set([
        ...Sy(e.command),
        ...(r && r !== semantic.parseAbort ? r2o(r) : []),
      ]);
      for (let it of ot) {
        let bt = yD({ ...e, command: it }, n, "prefix").matchingDenyRules[0];
        if (bt !== void 0)
          return {
            behavior: "deny",
            message: `Permission to use ${Ks.name} with command ${e.command} has been denied.`,
            decisionReason: { type: "rule", rule: bt },
          };
      }
    }
    let xe = r && r !== semantic.parseAbort ? COr(e.command, r, n) : void 0,
      Pe = xe?.behavior === "deny" ? xe : void 0,
      Be = h?.();
    if (Be) return Pe ?? Be;
    let Fe = qlt(e.command, !1, y, k, N);
    if (Fe !== null) {
      Qv("tengu_bash_dangerous_rm_too_complex", { kind: f("emptyVariable") });
      let ot = LOe(Fe, !1);
      return Pe ? A8(e.command, Pe, ot) : ot;
    }
    if (r && r !== semantic.parseAbort) {
      let ot = await Pbn(r, ue(), n, y, k, E, N);
      if (ot !== null)
        return (
          Qv("tengu_bash_dangerous_rm_too_complex", { kind: f(ot.kind) }),
          Pe ? A8(e.command, Pe, ot.result) : ot.result
        );
    } else if (E.budget.rereading) return C8().result;
    if (Pe) {
      let ot = Yde(r, y, E);
      return ot ? A8(e.command, Pe, ot) : Pe;
    }
    let Ke = ke && V?.behavior !== "ask" ? zwn(ke, re) : void 0;
    if (Ke !== void 0) {
      Qv("tengu_bash_rule_found_in_text", { behavior: f("ask") });
      let ot = Yde(r, y, E),
        it =
          ot?.behavior === "ask"
            ? ot
            : xe?.behavior === "ask" &&
                Sa(
                  xe.decisionReason,
                  (bt) => bt.circuitBreaker === "dangerousRemoval",
                )
              ? xe
              : void 0;
      if (it !== void 0)
        return iM().enabled ? it : { ...it, matchedAskRule: Ke };
      return {
        behavior: "ask",
        message: El(Ks.name),
        decisionReason: { type: "rule", rule: Ke },
      };
    }
    if (xe !== void 0) return Yde(r, y, E) ?? xe;
    if (V === null || V.behavior !== "allow") return V;
    if (
      (V.decisionReason?.type === "rule"
        ? V.decisionReason.rule.ruleValue.ruleContent
        : void 0) !== e.command.trim()
    )
      return null;
    if (!je(ROr, { safe: !0 })) return V;
    if (r === semantic.parseAbort) return null;
    return Yde(r, y, E) ?? V;
  }

  function _Or(e: Input, n: Policy, r: string | undefined): Decision | null {
    if (
      !Ge.isSandboxingEnabled() ||
      !Ge.isAutoAllowBashIfSandboxedEnabled() ||
      !Vh(e) ||
      IDt(n) ||
      Czn(e.command) ||
      (n.blockReadsOutsideWorkingDirectories === !0 && !lM(n))
    )
      return null;
    if (!mlt(r)) return null;
    if (/(?<!<)<<(?!<)/.test(e.command)) return null;
    if (/\$\{[\s|]/.test(e.command.replace(/['"\\]/g, ""))) return null;
    if (/\$\{![A-Za-z_0-9]/.test(e.command.replace(/['"\\]/g, ""))) return null;
    if (/\/proc\/.*\/environ/.test(e.command.replace(/['"\\]/g, "")))
      return null;
    if (d2o(e.command)) return null;
    let a = M8n(e.command);
    if (a === null || a.length === 0) return null;
    let h: Rule | undefined;
    for (let y of a) {
      let { matchingDenyRules: k, matchingAskRules: E } = yD(
        { ...e, command: y },
        n,
        "prefix",
      );
      if (k[0] !== void 0)
        return {
          behavior: "deny",
          message: `Permission to use ${Ks.name} with command ${e.command.trim()} has been denied.`,
          decisionReason: { type: "rule", rule: k[0] },
        };
      h ??= E[0];
    }
    for (let y of a) {
      let k = y.trim().split(/\s+/).filter(Boolean),
        E = SOr(k);
      if (E === null) return null;
      if (E.length === 0) continue;
      let N = l1(E),
        V = E.slice(0, E.length - N.length);
      if (V.some((xe) => /["'`$\\(){}|;&<>*?[\]]/.test(xe))) return null;
      if (
        V.some((xe) => {
          let Pe = xe.match(/^([A-Za-z_]\w*)\+?=/);
          return Pe !== null && epe(required(Pe[1]));
        })
      )
        return null;
      let oe = N.map((xe) => xe.replace(/['"\\]/g, ""));
      if (
        oe.some((xe) => {
          let Pe = xe.match(/^([A-Za-z_]\w*)\+?=/);
          return Pe !== null && epe(required(Pe[1]));
        })
      )
        return null;
      let re = N.some((xe, Pe) => {
          if (Pe === 0) return !1;
          if (
            (xe.includes("$'") && !/^'[^']*\$'$/.test(xe)) ||
            (xe.includes('$"') && !/^"[^"]*\$"$/.test(xe))
          )
            return !0;
          let Be = required(oe[Pe]);
          return (
            Be.includes("`") ||
            /\$\((?!\()/.test(Be) ||
            (/\$[^(\s]/.test(Be) && Be.includes("-")) ||
            /\$\{[^}]*:?[+=]/.test(Be) ||
            /\{[^\s]*(,|\.\.)/.test(xe) ||
            (Be.match(/\{/g) ?? []).length !== (Be.match(/\}/g) ?? []).length
          );
        }),
        _e = oe.some((xe, Pe) => Pe > 0 && xe.includes("$")),
        ke = N.some(
          (xe, Pe) => Pe > 0 && (/[<>]/.test(xe) || xe.endsWith("\\")),
        ),
        Re = N[0];
      if (
        Re === void 0 ||
        !/^[A-Za-z0-9._/~+][A-Za-z0-9._/~+-]*$/.test(Re) ||
        qti(Re) ||
        Vwn.has(Re) ||
        Vwn.has(Re.replace(/^.*[\\/]/, "")) ||
        (kOr.has(Re) &&
          (re || oe.some((xe) => xe.includes("[") && /[$`]/.test(xe)))) ||
        (Re === "test" &&
          (re ||
            ke ||
            oe.some((xe) => xe === "-t" || Lwn.has(xe)) ||
            oe.some(
              (xe, Pe) =>
                Pe > 0 &&
                xe.includes("$") &&
                (oe.length > 4 || Pe === oe.length - 2),
            ))) ||
        Re === "jq" ||
        m7e.has(Re) ||
        (Re === "find" &&
          (re ||
            ke ||
            (() => {
              let xe = !1;
              for (let Pe = 1; Pe < oe.length; Pe++) {
                let Be = required(oe[Pe]),
                  Fe = xe;
                if (((xe = !1), QKt(Be))) return !0;
                if (VQn(Be) || (N[Pe] !== Be && Mwn(Be))) return !0;
                if (!Fe && zQn(required(N[Pe]))) {
                  xe = !0;
                  continue;
                }
                if (!Fe && Mwn(required(N[Pe]))) {
                  let Ke = oe[Pe + 1],
                    Qe = /^'[^']*'$|^"[^"]*"$/.test(N[Pe + 1] ?? "");
                  if (Ke !== void 0 && /[[\]*?]/.test(Ke) && !Qe) return !0;
                  if (
                    Ke !== void 0 &&
                    (!Ke.includes("$") ||
                      (Qe && /^\$\{?[A-Za-z_]\w*\}?$/.test(Ke)))
                  ) {
                    Pe++;
                    continue;
                  }
                }
                if (Be.includes("$") || /[[\]*?]/.test(Be)) return !0;
              }
              return !1;
            })())) ||
        (Re === "jobs" &&
          (re || _e || ke || oe.some((xe) => /^-[^-]*x/.test(xe)))) ||
        (Re === "print" &&
          (re ||
            (_e && /^[+-]|\$/.test(oe[1] ?? "")) ||
            ke ||
            /\\['"]/.test(y) ||
            /[[\]*?]/.test(y.replace(/'[^']*'|"[^"]*"/g, "")) ||
            oe.some((xe) => FVo.test(xe)))) ||
        (Re === "set" &&
          (re ||
            ke ||
            (() => {
              for (let xe = 1; xe < oe.length; xe++) {
                let Pe = required(oe[xe]);
                if (Pe === "--") return !1;
                if (Pe.includes("$")) return !0;
                if (!/^[-+]/.test(Pe)) continue;
                for (let Be = 1; Be < Pe.length; Be++) {
                  let Fe = required(Pe[Be]);
                  if (Fe === "o") {
                    let Ke = Be < Pe.length - 1 ? Pe.slice(Be + 1) : oe[xe + 1];
                    if (
                      Ke !== void 0 &&
                      Ke !== "" &&
                      !$Vo.has(Ke.toLowerCase().replace(/[_-]/g, ""))
                    )
                      return !0;
                    break;
                  }
                  if (Fe === "A") break;
                  if (!UVo.has(Fe)) return !0;
                }
              }
              return !1;
            })()))
      )
        return null;
    }
    if (h)
      return {
        behavior: "ask",
        message: El(Ks.name),
        decisionReason: { type: "rule", rule: h },
      };
    return {
      behavior: "allow",
      updatedInput: e,
      decisionReason: { type: "other", reason: wEe },
    };
  }

  function elt(
    e: Input,
    n: Policy,
    r: Command[],
    a: string[],
    h: Context,
  ): Decision | null {
    if (
      !Ge.isSandboxingEnabled() ||
      !Ge.isAutoAllowBashIfSandboxedEnabled() ||
      !Vh(e) ||
      IDt(n) ||
      Czn(e.command) ||
      (n.blockReadsOutsideWorkingDirectories === !0 && !lM(n))
    )
      return null;
    let y = kbn(e, n, r);
    if (y.behavior === "passthrough") return null;
    let k = qde(b0e(h)),
      E =
        T8(a, k) ||
        r.some((re) => {
          let _e = l1(re.argv),
            ke = re.argv.length - _e.length + 1,
            Re =
              Kwn.has(_e[0] ?? "") && b("tengu_quiet_larkspur", !0)
                ? ke
                : Number.POSITIVE_INFINITY,
            xe =
              _e[0] === "dd" && b("tengu_plain_sorrel", !0)
                ? ke
                : Number.POSITIVE_INFINITY;
          return (
            re.envVars.some(
              (Pe) =>
                ybn(Pe) &&
                (!Kwn.has(re.argv[0] ?? "") ||
                  epe(Pe.name) ||
                  vCe(Pe.name) ||
                  I8e(Pe.name) ||
                  !b("tengu_umber_plover", !0) ||
                  gO() === "relaxed" ||
                  !Ge.isUnsandboxedFallbackClosedByTrustedSource()),
            ) ||
            (re.operandAppends === !0 && rmt()) ||
            re.argv.slice(1).some(jxt) ||
            re.redirects.some((Pe) => Pe.op === "<" && jxt(Pe.target)) ||
            re.argv.some((Pe, Be) => {
              if (!Pe.includes("=") || Pe.startsWith("-")) return !1;
              let Fe = Pe.indexOf("=");
              if (
                Be >= xe &&
                hOr.has(Pe.slice(0, Fe)) &&
                !Pe.slice(Fe + 1)
                  .split(":")
                  .some(jxt)
              )
                return !1;
              let Ke =
                Pe[Fe - 1] === "+" ? Pe.slice(0, Fe - 1) : Pe.slice(0, Fe);
              if (Be >= Re && yOr.test(Ke)) return !1;
              return (Pe[Fe - 1] === "+" && rmt()) || !bU(Ke, Pe.slice(Fe + 1));
            })
          );
        }),
      N = r.some((re) =>
        re.redirects.some((_e) => /^\/dev\/(tcp|udp)\//.test(_e.target)),
      );
    if (E || N) return null;
    let V = !1,
      oe = !1;
    for (let re of r) {
      let [_e, ...ke] = l1(re.argv),
        Re = _e?.replace(/^.*[\\/]/, "");
      if (Re === "cd" || Re === "pushd" || Re === "popd" || Re === "chdir") {
        V = !0;
        continue;
      }
      if (Re !== "rm" && Re !== "rmdir") continue;
      if (((oe = !0), o2(Re, ke, ue(), n).behavior !== "passthrough"))
        return null;
    }
    if (V && oe) return null;
    return y;
  }

  return {
    nested,
    host,
    native: {
      IDt,
      Ge,
      mlt,
      SOr,
      uOr,
      ybn,
      Yde,
      COr,
      AOr,
      _Or,
      elt,
      vCe,
      I8e,
      jxt,
    },
    withPolicyScope<T>(
      permission: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { scope: { policyId: permission.scope.policyId, cwd }, receipts },
        () => nested.withPolicyScope(permission, cwd, run, receipts),
      );
    },
  };
}
