/** Source-backed independent typed port; bounded byte proofs: artifacts/native-bash-command-port.
 * Parsing, projection and preparation are not permission or execution certificates. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeBashFeatureReader } from "./native-bash-parser-features.js";
import type { NativeBashParser } from "./native-bash-parser.js";
import {
  matchNativeBashText,
  type NativeRuleBehavior,
} from "./native-permission-rules.js";
import { createNativeBashCommandProjection } from "./native-bash-command-projection.js";

export interface NativeBashPreparationEnvironment {
  name: string;
  value: string;
  isAppend?: boolean;
}
/** Must come from the semantic command producer; a raw syntax tree is insufficient. */
export interface NativeBashPreparationAstCommand {
  argv: string[];
  envVars: NativeBashPreparationEnvironment[];
  redirects: NativeBashPreparationRedirect[];
  text: string;
  hasUnquotedGlob: boolean;
  argvSourceLiteral?: boolean;
  carveOutMayDesyncQuoteScan?: boolean;
}
export interface NativeBashPreparationRedirect {
  op: string;
  target: string;
  fd?: number | undefined;
  targetSourceLiteral?: boolean;
}
export interface NativeBashPreparationOptions {
  stripAllEnvVars?: boolean;
  skipCompoundCheck?: boolean;
  astCommand?: NativeBashPreparationAstCommand;
  ruleBehavior?: NativeRuleBehavior;
  compoundBareAssignmentNames?: string[];
  firstCommandRuleContents?: ReadonlySet<string>;
}
export type NativeBashPreparationResult<T> =
  | { status: "resolved"; matches: T[] }
  | { status: "unresolved"; matches: []; dependency: string };
export interface NativeBashPreparationHost {
  /** Actual semantic certificate verifier. This callback is not called for ordinary rules. */
  verifyCertifiedRule?: (
    rule: string,
    command: NativeBashPreparationAstCommand,
    compoundAssignments: readonly string[],
  ) => boolean;
  /** je(VMr,{safe:false}) provider; native host default is false, not a parser feature bit. */
  escapedWhitespaceFeature?: () => boolean;
}
export interface NativeBashPreparationFeatureOptions {
  environmentReader?: NativeBashFeatureReader;
  removalReader?: NativeBashFeatureReader;
  commandReader?: NativeBashFeatureReader;
  stagedReader?: NativeBashFeatureReader;
  nestedReader?: NativeBashFeatureReader;
}
interface ReadingScope {
  reading: "refuse" | "rule off" | "as bash reads it";
  refusals: number;
  firstReason?: string;
}
function readDefault(
  reader: NativeBashFeatureReader | null | undefined,
  key: string,
): boolean {
  if (reader === undefined || reader === null) return true;
  try {
    const result = reader(key, true);
    return result.value === false &&
      result.source === "payload" &&
      result.defaultHost
      ? false
      : true;
  } catch {
    return true;
  }
}
function readGuard(
  reader: NativeBashFeatureReader | null | undefined,
  key: string,
): boolean {
  if (reader === undefined || reader === null) return true;
  try {
    const { value, source, defaultHost } = reader(key, true);
    return value !== false || source !== "payload" || !defaultHost;
  } catch {
    return true;
  }
}
/** Complete sy360446 context/reader owner, shared with subsequent semantic consumers. */
export function createNativeBashPreparationFeatures(
  options: NativeBashPreparationFeatureOptions = {},
) {
  let environmentReader: NativeBashFeatureReader | null | undefined =
    options.environmentReader ?? null;
  let removalReader: NativeBashFeatureReader | null | undefined =
    options.removalReader ?? null;
  let commandReader: NativeBashFeatureReader | null | undefined =
    options.commandReader ?? null;
  let stagedReader: NativeBashFeatureReader | null | undefined =
    options.stagedReader ?? null;
  let nestedReader: NativeBashFeatureReader | null | undefined =
    options.nestedReader ?? null;
  const environment = new AsyncLocalStorage<{
    accepted: boolean;
    refused: boolean;
  }>();
  const reading = new AsyncLocalStorage<ReadingScope>();
  const features = {
    registerEnvironmentReader(
      reader: NativeBashFeatureReader | null | undefined,
    ) {
      const previous = environmentReader;
      environmentReader = reader;
      return previous;
    },
    registerRemovalReader(reader: NativeBashFeatureReader | null | undefined) {
      const previous = removalReader;
      removalReader = reader;
      return previous;
    },
    registerCommandReader(reader: NativeBashFeatureReader | null | undefined) {
      const previous = commandReader;
      commandReader = reader;
      return previous;
    },
    registerStagedReader(reader: NativeBashFeatureReader | null | undefined) {
      const previous = stagedReader;
      stagedReader = reader;
      return previous;
    },
    registerNestedReader(reader: NativeBashFeatureReader | null | undefined) {
      const previous = nestedReader;
      nestedReader = reader;
      return previous;
    },
    async observeEnvironment<T>(accepted: boolean, run: () => T | Promise<T>) {
      const scope = { accepted, refused: false };
      const result = await environment.run(scope, run);
      return { result, refused: scope.refused };
    },
    withAcceptedEnvironment<T>(run: () => T): T {
      return environment.run({ accepted: true, refused: false }, run);
    },
    refuseEnvironment(): boolean {
      const scope = environment.getStore();
      if (scope === undefined) return true;
      scope.refused = true;
      return !scope.accepted;
    },
    environmentGuardEnabled(): boolean {
      return readDefault(
        environmentReader,
        "bot_protected_tengu_reflective_ember",
      );
    },
    appendEnvironmentNeedsReview(): boolean {
      return features.environmentGuardEnabled() && features.refuseEnvironment();
    },
    removalOptionAccepted(option: string): boolean {
      return option !== "-rm" || readGuard(removalReader, "tengu_warm_sunrise");
    },
    vastPuddleEnabled(): boolean {
      return readGuard(commandReader, "tengu_vast_puddle");
    },
    snappyTowerEnabled(): boolean {
      return readGuard(commandReader, "tengu_snappy_tower");
    },
    stagedPumpkinEnabled(): boolean {
      return readGuard(stagedReader, "tengu_staged_pumpkin");
    },
    nestedRippleEnabled(): boolean {
      return readGuard(nestedReader, "tengu_nested_ripple");
    },
    async observeReading<T>(
      run: () => T | Promise<T>,
    ): Promise<[T, string | undefined]> {
      const scope = reading.getStore() ?? { reading: "refuse", refusals: 0 };
      const before = scope.refusals;
      return [
        await reading.run(scope, run),
        scope.refusals > before ? scope.firstReason : undefined,
      ];
    },
    markReadingRefusal(reason: string): void {
      const scope = reading.getStore();
      if (scope !== undefined && scope.reading === "refuse") {
        scope.refusals++;
        scope.firstReason ??= reason;
      }
    },
    withoutReadingRule<T>(run: () => T): T {
      return reading.run({ reading: "rule off", refusals: 0 }, run);
    },
    asBashReads<T>(run: () => T): T {
      return reading.run({ reading: "as bash reads it", refusals: 0 }, run);
    },
    readingRuleOff(): boolean {
      const mode = reading.getStore()?.reading;
      return mode === "rule off" || mode === "as bash reads it";
    },
    readsAsBash(): boolean {
      return reading.getStore()?.reading === "as bash reads it";
    },
  };
  return features;
}
export type NativeBashPreparationFeatures = ReturnType<
  typeof createNativeBashPreparationFeatures
>;
class UnresolvedPreparationDependency extends Error {
  constructor(readonly dependency: string) {
    super(dependency);
  }
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing command preparation invariant");
  return value;
}
function KI(value: string): string {
  return value.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
}
const pJ = "__CMDSUB_OUTPUT__";
function Ys(value: string): boolean {
  return (
    value.includes(pJ) ||
    value.includes("__TRACKED_VAR__") ||
    value.includes("__UNCERTAIN_VAR__")
  );
}
function Act(value: string): string {
  return value.replaceAll(pJ, "").replaceAll("__TRACKED_VAR__", "");
}
function Qxt(value: string): boolean {
  return /^-[pvV]+$/.test(value) && /[vV]/.test(value);
}
function wts(value: string): boolean {
  const pattern = value.trimEnd();
  if (!pattern.endsWith("*")) return false;
  let escapes = 0;
  for (
    let offset = pattern.length - 2;
    offset >= 0 && pattern[offset] === "\\";
    offset--
  )
    escapes++;
  return escapes % 2 === 0;
}
function Ekt(
  value: string,
):
  | { type: "prefix"; prefix: string }
  | { type: "wildcard"; pattern: string }
  | { type: "exact"; command: string } {
  const prefix = /^(.+):\*$/.exec(value)?.[1];
  if (prefix !== undefined) return { type: "prefix", prefix };
  if (value.endsWith(":*")) return { type: "exact", command: value };
  for (let offset = 0; offset < value.length; offset++) {
    if (
      value[offset] === "\\" &&
      (value[offset + 1] === "*" || value[offset + 1] === "\\")
    ) {
      offset++;
      continue;
    }
    if (value[offset] === "*") return { type: "wildcard", pattern: value };
  }
  return { type: "exact", command: value };
}
const Jde = (pattern: string, text: string) =>
  matchNativeBashText(pattern, text);
const vzn = (rule: string) => rule.startsWith("certified: ");
const XKt = /\\[ \t]/;

export function createNativeBashCommandPreparation(
  parser: NativeBashParser,
  host: NativeBashPreparationHost = {},
  features: NativeBashPreparationFeatures = createNativeBashPreparationFeatures(),
) {
  const projection = createNativeBashCommandProjection(parser);
  const {
    staticArgv: iC,
    splitCommands: Sy,
    redirections: KX,
    containsUnsupportedSpelling: Y_n,
    maxCommandCharacters: sC,
  } = projection;
  const DY = () => features.refuseEnvironment();
  const rmt = () => features.appendEnvironmentNeedsReview();
  const qr = <T>(
    record: Readonly<Record<string, T>>,
    key: string,
  ): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
  const ubn = (): boolean => {
    if (host.escapedWhitespaceFeature === undefined)
      throw new UnresolvedPreparationDependency("je:tengu_humble_hartmanis");
    return host.escapedWhitespaceFeature();
  };
  const mkn = (
    rule: string,
    command: NativeBashPreparationAstCommand,
    assignments: readonly string[],
  ): boolean => {
    if (host.verifyCertifiedRule === undefined)
      throw new UnresolvedPreparationDependency(
        "semantic-certified-rule-verifier",
      );
    return host.verifyCertifiedRule(rule, command, assignments);
  };
  var Bwn = /^[A-Za-z0-9_.+-]+$/,
    Zat = /^\d+(?:\.\d+)?[smhd]?$/;
  var _bn = String.raw`\p{L}\p{M}\p{N}_.+\-:@%,~`,
    sOr = new RegExp(`^[${_bn}/]*$`, "u"),
    iOr = new RegExp(`^(?:['"]|(?!\\d+<)[${_bn}]*[</])`, "u"),
    sIe = String.raw`(?:\\.|[^\\ '"]|'[^']*'|"(?:\\.|[^"\\])*")*`,
    Wwn = new RegExp(sIe.replace(/\*$/, "+"), "gs"),
    aOr = new RegExp(`^(?:${sIe} )*`, "s"),
    lOr = new RegExp(`^${sIe}`, "s"),
    Gwn = new RegExp(`^${sIe}$`, "s");
  var UMr =
      /^((?!-[A-Za-z0-9]{2})[\w./:=@%+,-]+(?:[ \t]+(?!-[A-Za-z0-9]{2})[\w./:=@%+,-]+)*)(?:[ \t]+2>&1)?[ \t]*(?:&&|\|\||[;|\n])/,
    jMr = {
      git: "status|log|show|diff|add|commit|checkout|push|branch|rev-parse",
      gh: String.raw`pr[ \t]+(?:view|list|checks|status|diff|create)`,
    },
    WMr = "echo|cat|head|tail|grep|cut|wc|date|rm|ls|true|false|sleep";
  function GMr(e: Record<string, string>): RegExp {
    let n = String.raw,
      r = Object.entries(e)
        .map(([V, oe]) => n`${V}[ \t]+(?:${oe})`)
        .join("|"),
      a = n`(?![~=])[\w./:=@%+,~-]+`,
      h = n`'(?!-)[^']*'|"(?!-)[^"\\\`$]*"`,
      y = n`"\$\(cat <<'EOF'\n(?:(?![ \t]*EOF)[^\n]*\n)*EOF\n[ \t]*\)"`,
      k = n`\d?>&\d|\d?>>?[ \t]*(?:/dev/null|/tmp/\w[\w.-]*)`,
      E = n`${a}|(?:-[\w-]+=)?(?:${h})`,
      N = n`(?:${r})(?:[ \t]+(?:(?:-m|--body)[ \t]+${y}|${E}))*|(?:${WMr})(?:[ \t]+(?:${E}|\$\?))*`;
    return new RegExp(
      n`[ \t\n]*(${N})(?:[ \t]+(?:${k}))*[ \t]*(?:&&|\|\||[;|\n]|$)`,
      "gy",
    );
  }
  var Iwn = GMr(jMr);
  const Flt = new Set([
      "GOEXPERIMENT",
      "GOOS",
      "GOARCH",
      "CGO_ENABLED",
      "GO111MODULE",
      "RUST_BACKTRACE",
      "RUST_LOG",
      "NODE_ENV",
      "PYTHONUNBUFFERED",
      "PYTHONDONTWRITEBYTECODE",
      "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
      "PYTEST_DEBUG",
      "ANTHROPIC_API_KEY",
      "LANG",
      "LANGUAGE",
      "LC_ALL",
      "LC_CTYPE",
      "LC_TIME",
      "CHARSET",
      "TERM",
      "COLORTERM",
      "NO_COLOR",
      "FORCE_COLOR",
      "TZ",
      "LS_COLORS",
      "LSCOLORS",
      "GREP_COLOR",
      "GREP_COLORS",
      "GCC_COLORS",
      "TIME_STYLE",
      "BLOCK_SIZE",
      "BLOCKSIZE",
      "COLUMNS",
      "LINES",
      "CLICOLOR",
      "CLICOLOR_FORCE",
      "CI",
      "DEBIAN_FRONTEND",
      "GIT_TERMINAL_PROMPT",
    ]),
    QMr = new Set(["LANG", "LC_ALL", "LC_CTYPE"]),
    JMr = /^(['"]?)(C|POSIX|UTF-?8|[\w-]+\.UTF-?8(@\w+)?)\1$/i;
  function $lt(e: string): boolean {
    return Flt.has(e);
  }
  function Ult(e: string): boolean {
    return Flt.has(e) || !1;
  }
  var Nwn = /^[.~]*[/\\]|[/\\][/\\]|:[/\\.]|(?:^|[/\\])\.\.(?:[/\\]|$)/;
  function oIe(e: string): boolean {
    let n = e.replaceAll('"', "").replaceAll("'", "");
    return (Nwn.test(n) || Nwn.test(Act(n))) && DY();
  }
  function oE(e: string, n = true, r = true): string {
    let a = [
        /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
        /^time[ \t]+(?:--[ \t]+)?/,
        /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
        /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
        /^nohup[ \t]+(?:--[ \t]+)?/,
        /^command(?:[ \t]+-p+)*(?:[ \t]+--)?[ \t]+(?!-)/,
        /^builtin(?:[ \t]+--)?[ \t]+(?!-)/,
        /^noglob[ \t]+(?!-)/,
      ],
      h = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/,
      y = (V: string) => (r ? hbn(V) : V),
      k = e,
      E = "";
    while (k !== E) {
      {
        E = k;
        k = y(k);
      }
      let V = n ? k.match(h) : null;
      if (V && bU(required(V[1]), required(V[2]))) k = k.replace(h, "");
    }
    function N(V: string): string {
      let oe = V.match(/^([^\s]+)([\s\S]*)$/);
      if (!oe) return V;
      let re = required(oe[1]),
        _e: string | null = null,
        ke = !1,
        Re = "";
      for (let xe = 0; xe < re.length; xe++) {
        let Pe = re[xe];
        if (((ke = !1), _e === "'"))
          if (Pe === "'") _e = null;
          else Re += Pe;
        else if (_e === '"')
          if (Pe === "\\") {
            let Be = re[xe + 1];
            if (Be === "$" || Be === "`" || Be === '"' || Be === "\\") {
              Re += Be;
              xe++;
            } else if (Be === void 0) ke = !0;
            else Re += Pe;
          } else if (Pe === '"') _e = null;
          else Re += Pe;
        else if (Pe === "\\") {
          let Be = re[xe + 1];
          if (Be === void 0) ke = !0;
          else {
            Re += Be;
            xe++;
          }
        } else if (Pe === '"' || Pe === "'") _e = Pe;
        else Re += Pe;
      }
      if (_e !== null || ke) return V;
      return Re + oe[2];
    }
    {
      k = N(y(k));
      E = "";
    }
    while (k !== E) {
      E = k;
      for (let V of a) k = k.replace(V, "");
      if (k !== E) k = N(y(k));
    }
    return k.trim();
  }
  function _at(e: string[]): number {
    let n = 1;
    while (n < e.length) {
      let r = required(e[n]),
        a = e[n + 1];
      if (
        r === "--foreground" ||
        r === "--preserve-status" ||
        r === "--verbose"
      )
        n++;
      else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(r)) n++;
      else if ((r === "--kill-after" || r === "--signal") && a && Bwn.test(a))
        n += 2;
      else if (r === "--") {
        n++;
        break;
      } else if (r.startsWith("--")) return -1;
      else if (r === "-v") n++;
      else if ((r === "-k" || r === "-s") && a && Bwn.test(a)) n += 2;
      else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(r)) n++;
      else if (r.startsWith("-")) return -1;
      else break;
    }
    return n;
  }
  function tOr(e: string[]): string[] {
    let n = e;
    for (;;) {
      let r = KI(n[0] ?? "");
      if (r === "time" || r === "nohup") {
        let a = r === "time" && n[1] === "-p" ? 2 : 1;
        if (n[a]?.startsWith("-") && n[a] !== "--") return n;
        n = n.slice(n[a] === "--" ? a + 1 : a);
      } else if (r === "timeout") {
        let a = _at(n);
        if (a < 0 || !n[a] || !Zat.test(required(n[a]))) return n;
        n = n.slice(a + 1);
      } else if (r === "nice" && n[1] === "-n" && n[2] && /^-?\d+$/.test(n[2]))
        n = n.slice(n[3] === "--" ? 4 : 3);
      else return n;
    }
  }
  function ybn(e: NativeBashPreparationEnvironment): boolean {
    return (e.isAppend === !0 && rmt()) || !bU(e.name, e.value);
  }
  function Uwn(
    e: { command: string },
    n?: NativeBashPreparationAstCommand,
  ): boolean {
    if (n) return n.envVars.some(ybn);
    let r = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/,
      a =
        /^[A-Za-z_][A-Za-z0-9_]*\+?=("[^"$`\\]*"|'[^']*'|[A-Za-z0-9_./:+-]*)[ \t]+/,
      h = e.command;
    for (;;) {
      let y = h.match(r);
      if (!y) return !1;
      if (!Ult(required(y[1])) || (y[2] === "+" && rmt())) return !0;
      let k = h.match(a);
      if (!k || !bU(required(y[1]), required(k[1]))) return !0;
      h = h.slice(k[0].length);
    }
  }
  function rIe(
    e: string,
    n?: RegExp | ((name: string, value: string) => boolean),
    r = true,
  ): string {
    let a =
        /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=((?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*)[ \t]+/,
      h = e,
      y = "";
    while (h !== y) {
      if (((y = h), r)) h = hbn(h);
      let k = h.match(a);
      if (!k) continue;
      let E = required(k[1]);
      if (typeof n === "function" ? n(E, required(k[2])) : n?.test(E)) break;
      h = h.slice(k[0].length);
    }
    return h.trim();
  }
  var nOr: Readonly<Record<string, ReadonlySet<string> | undefined>> = {
      env: new Set(["-u", "-C", "--unset", "--chdir"]),
      sudo: new Set([
        "-u",
        "-g",
        "-U",
        "-C",
        "-D",
        "-h",
        "-p",
        "-r",
        "-R",
        "-t",
        "-T",
        "--user",
        "--group",
        "--other-user",
        "--close-from",
        "--chdir",
        "--host",
        "--prompt",
        "--role",
        "--chroot",
        "--type",
        "--command-timeout",
        "-a",
        "--auth-type",
      ]),
      doas: new Set(["-a", "-u", "-C"]),
      pkexec: new Set(["--user"]),
      watch: new Set(["-n", "--interval", "--equexit"]),
      ionice: new Set([
        "-c",
        "-n",
        "-p",
        "-P",
        "-u",
        "--class",
        "--classdata",
        "--pid",
        "--pgid",
        "--uid",
      ]),
      setsid: new Set([]),
      taskset: new Set(["-c", "--cpu-list"]),
      chrt: new Set([
        "-p",
        "--pid",
        "-T",
        "-P",
        "-D",
        "--sched-runtime",
        "--sched-period",
        "--sched-deadline",
      ]),
      strace: new Set([
        "-e",
        "-o",
        "-p",
        "-s",
        "-E",
        "-P",
        "-S",
        "-a",
        "-b",
        "-I",
        "-u",
        "-X",
        "-O",
        "-U",
        "--output",
        "--trace",
        "--expr",
        "--attach",
        "--string-limit",
        "--env",
        "--trace-path",
        "--columns",
        "--user",
        "--interruptible",
        "--detach-on",
        "--const-print-style",
        "--summary-sort-by",
        "--summary-syscall-overhead",
        "--summary-columns",
      ]),
      ltrace: new Set([
        "-a",
        "-A",
        "-e",
        "-l",
        "-n",
        "-o",
        "-p",
        "-s",
        "-u",
        "-x",
        "-D",
        "-F",
        "--align",
        "--config",
        "--debug",
        "--indent",
        "--library",
        "--output",
        "--string-max",
        "-w",
        "--where",
      ]),
      flock: new Set([
        "-w",
        "-E",
        "--timeout",
        "--wait",
        "--conflict-exit-code",
      ]),
      script: new Set([
        "-E",
        "-T",
        "-m",
        "-o",
        "-O",
        "-B",
        "-I",
        "--echo",
        "--log-timing",
        "--logging-format",
        "--output-limit",
        "--log-out",
        "--log-io",
        "--log-in",
      ]),
      unshare: new Set([
        "-R",
        "-w",
        "-S",
        "-G",
        "--setuid",
        "--setgid",
        "--root",
        "--wd",
        "--propagation",
        "--setgroups",
        "--monotonic",
        "--boottime",
      ]),
      nsenter: new Set(["-t", "-S", "-G", "--target", "--setuid", "--setgid"]),
      "sandbox-exec": new Set(["-f", "-n", "-p", "-D"]),
      exec: new Set(["-a"]),
      command: new Set([]),
      builtin: new Set([]),
      noglob: new Set([]),
      nocorrect: new Set([]),
    },
    oOr: Readonly<Record<string, ReadonlySet<string> | undefined>> = {
      env: new Set(["-S", "--split-string"]),
      flock: new Set(["-c", "--command"]),
      script: new Set(["-c", "--command"]),
    },
    rOr: Readonly<Record<string, ((value: string) => boolean) | undefined>> = {
      chrt: (e) => /^\d+$/.test(e),
      taskset: (e) => /^(0x[\da-f]+|\d+)$/i.test(e),
      flock: () => !0,
      script: () => !0,
    },
    jwn = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
  function x5e(
    e: string[],
    { wide: n = false }: { wide?: boolean } = {},
  ): string[] {
    let r = e.slice();
    for (;;) {
      while (r[0] !== void 0 && jwn.test(r[0])) r = r.slice(1);
      if (((r = tOr(r)), r[0] === void 0)) return r;
      let a = KI(required(r[0])),
        h = qr(nOr, a);
      if (h === void 0) return r;
      let y = qr(oOr, a),
        k = qr(rOr, a),
        E = 1,
        N: string | undefined,
        V = !1;
      while (E < r.length) {
        let oe = required(r[E]);
        if (oe === "--") {
          if (
            (E++, !V && k !== void 0 && E + 1 < r.length && k(required(r[E])))
          ) {
            {
              V = !0;
              E++;
            }
            continue;
          }
          break;
        }
        if (y !== void 0) {
          if (y.has(oe) && r[E + 1] !== void 0) {
            let _e = required(r[E + 1]).trim();
            if (_e !== "") {
              N = _e;
              break;
            }
            E += 2;
            continue;
          }
          let re = oe.indexOf("=");
          if (re > 0 && y.has(oe.slice(0, re))) {
            let _e = oe.slice(re + 1).trim();
            if (_e !== "") {
              N = _e;
              break;
            }
            E++;
            continue;
          }
          if (oe.length > 2 && oe[1] !== "-" && y.has(oe.slice(0, 2))) {
            let _e = oe.slice(2).trim();
            if (_e !== "") {
              N = _e;
              break;
            }
            E++;
            continue;
          }
        }
        if (oe.startsWith("-") && (oe !== "-" || k === void 0)) {
          if (a === "command" && Qxt(oe)) return r;
          let re =
            h.has(oe) ||
            (n &&
              /^-[A-Za-z]+$/.test(oe) &&
              oe
                .slice(1)
                .split("")
                .findIndex((_e) => h.has(`-${_e}`)) ===
                oe.length - 2);
          E += re && E + 1 < r.length ? 2 : 1;
          continue;
        }
        if (
          n
            ? (a === "env" || (a === "sudo" && !oe.startsWith("/"))) &&
              oe.includes("=")
            : a === "env" && jwn.test(oe)
        ) {
          E++;
          continue;
        }
        if (!V && k?.(oe) && E + 1 < r.length) {
          {
            V = !0;
            E++;
          }
          continue;
        }
        break;
      }
      if (N !== void 0) {
        if (((r = N.trim().split(/\s+/)), r.length === 0 || r[0] === ""))
          return e.slice();
        continue;
      }
      if (E >= r.length) return r;
      r = r.slice(E);
    }
  }
  function dOr(e: string, n: string): boolean {
    let r = (/^(?:\\[*\\]|[^*])*/.exec(e.trim())?.[0] ?? "")
        .replace(/\\([*\\])/g, "$1")
        .replace(/[ \t]+/g, " ")
        .replace(/^(?:xargs )+(?!-)/, ""),
      a = n.replace(/[ \t]+/g, " ").replace(/^(?:xargs )+(?!-)/, ""),
      h = r.slice(aOr.exec(r)?.[0].length ?? 0);
    if (h === "" || h.includes("=") || !a.startsWith(r)) return !1;
    let y = a.slice(r.length),
      k = Gwn.test(h) ? y.replace(/ .*/s, "") : y,
      E = h + k,
      N =
        Ys(E) ||
        /[$`]|(?:^|[\\/])\.\\?[.?*[]/.test(
          (
            h.slice(h.lastIndexOf("/") + 1) +
            ((Gwn.test(h) && lOr.exec(y)?.[0]) || k)
          ).replace(/['"]/g, ""),
        );
    if (sOr.test(k) && !N) return !1;
    let V = iC(r),
      oe = V.findLastIndex(
        (re, _e) => _e < V.length - 1 && /^(?:env|sudo)$/.test(KI(re)),
      );
    if (oe < 0 && iOr.test(E) && !N) return !1;
    return [!1, !0].some((re) => {
      let _e = x5e(V.slice(Math.max(oe, 0)), { wide: re });
      return (
        _e.length <= 1 &&
        r.replace(/['"\\]/g, "").endsWith((_e[0] ?? "").replace(/['"\\]/g, ""))
      );
    });
  }
  function R8<T>(
    e: { command: string },
    n: ReadonlyMap<string, T>,
    r: "exact" | "prefix",
    {
      stripAllEnvVars: a = false,
      skipCompoundCheck: h = false,
      astCommand: y,
      ruleBehavior: k,
      compoundBareAssignmentNames: E = [],
      firstCommandRuleContents: N,
    }: NativeBashPreparationOptions = {},
  ): T[] {
    if (n.size === 0) return [];
    let V = e.command.trim(),
      oe = KX(V).commandWithoutRedirections,
      _e = (r === "exact" ? [V, oe] : [oe]).flatMap((Be) => {
        let Fe = oE(Be);
        return Fe !== Be ? [Be, Fe] : [Be];
      });
    if (a) {
      let Be = y?.argv ?? iC(oe),
        Fe =
          r === "exact" ||
          (y === void 0 &&
            (/[`(){};|&<>#]|[^\S ]|\$['"]/.test(
              V.replace(/\$\{\w+\}/g, "$V"),
            ) ||
              V.replace(Wwn, "").trim() !== ""))
            ? []
            : (y?.argv ?? V.match(Wwn) ?? []),
        Ke = x5e(Be),
        Qe = x5e(Fe, { wide: !0 }),
        ot: [string[], string[]][] = [[Be, Ke]];
      if (Qe.join(" ") !== Ke.join(" ")) ot.push([Fe, Qe]);
      for (let [vt, Ct] of ot) {
        if (
          Ct.length > 0 &&
          (y !== void 0 || Ct[0] !== vt[0] || Sy(oe).length === 1)
        ) {
          if ((_e.push(Ct.join(" ")), Ct[0] !== vt[0])) _e.push(vt.join(" "));
        }
        if (Ct[0] !== void 0 && KI(Ct[0]) !== Ct[0])
          _e.push([KI(Ct[0]), ...Ct.slice(1)].join(" "));
      }
      if (XKt.test(oe) && ubn()) _e.push(oe.replace(/\\([ \t])/g, "$1"));
      let it = new Set(_e),
        bt = 0;
      while (bt < _e.length) {
        let vt = _e.length;
        for (let Ct = bt; Ct < vt; Ct++) {
          let Pt = _e[Ct];
          if (!Pt) continue;
          let Dt = rIe(Pt);
          if (!it.has(Dt)) {
            _e.push(Dt);
            it.add(Dt);
          }
          let Lt = oE(Pt);
          if (!it.has(Lt)) {
            _e.push(Lt);
            it.add(Lt);
          }
        }
        bt = vt;
      }
    }
    let ke = new Map<string, boolean>();
    if (r === "prefix" && !h) {
      for (let Be of _e) if (!ke.has(Be)) ke.set(Be, Sy(Be).length > 1);
    }
    let Re: boolean | undefined,
      xe: string | undefined,
      Pe: RegExpMatchArray[] | undefined;
    return Array.from(n.entries())
      .filter(([Be]) => {
        if (vzn(Be))
          return (
            k === "allow" && r === "prefix" && y !== void 0 && mkn(Be, y, E)
          );
        let Fe = Ekt(Be);
        return _e.some((Ke) => {
          switch (Fe.type) {
            case "exact":
              return Fe.command === Ke;
            case "prefix": {
              let Qe = Fe.prefix.replace(/[ \t]+/g, " "),
                ot = Ke.replace(/[ \t]+/g, " ");
              switch (r) {
                case "exact":
                  return Qe === ot;
                case "prefix": {
                  if (ke.get(Ke)) return !1;
                  if (ot === Qe) return !0;
                  if (ot.startsWith(Qe + " ")) return !0;
                  let it = "xargs " + Qe;
                  if (ot === it) return !0;
                  return ot.startsWith(it + " ");
                }
              }
              break;
            }
            case "wildcard":
              if (r === "exact") return !1;
              if (ke.get(Ke)) return !1;
              if (k !== "deny" && k !== "ask" && dOr(Fe.pattern, Ke)) return !1;
              if (Jde(Fe.pattern, Ke)) {
                let Qe =
                    N?.has(Be) === !0 && e.command.length <= sC
                      ? UMr.exec(V)
                      : null,
                  ot = /^[a-z]+(?: [a-z]+)*/.exec(Fe.pattern)?.[0];
                if (Qe === null || ot === void 0 || !V.startsWith(`${ot} `))
                  return !0;
                let it = V.slice(Qe[0].length),
                  bt = Iwn,
                  vt =
                    bt === Iwn
                      ? (Pe ??= Array.from(it.matchAll(bt)))
                      : Array.from(it.matchAll(bt));
                if (
                  ((Re ??=
                    R8({ ...e, command: required(Qe[1]) }, n, r, {
                      stripAllEnvVars: a,
                      skipCompoundCheck: h,
                      ...(k === undefined ? {} : { ruleBehavior: k }),
                    }).length > 0),
                  Re ||
                    vt.map((Ct) => Ct[0]).join("") !== it ||
                    new RegExp(ot.replaceAll(" ", "[ \\t]+")).test(it) ||
                    Y_n(e.command) ||
                    (xe ??= Sy(e.command).join("\x00")) !==
                      [Qe[1], ...vt.map((Ct) => Ct[1])].join("\x00"))
                )
                  return !0;
              }
              if (k !== "deny" && k !== "ask" && !wts(Fe.pattern)) return !1;
              return Jde(`xargs ${Fe.pattern}`, Ke);
          }
        });
      })
      .map(([, Be]) => Be);
  }
  function bU(e: string, n: string): boolean {
    if (n.includes(pJ) && (!Ult(e) || DY())) return !1;
    if (
      QMr.has(e) &&
      (!JMr.test(n) || Ys(n)) &&
      !(e === "LANG" && n === "") &&
      DY()
    )
      return !1;
    if (Flt.has(e)) return !oIe(n);
    return !1;
  }
  function hbn(e: string): string {
    let r = e
      .split(
        `
`,
      )
      .filter((a) => !a.trim().startsWith("#"));
    if (r.length === 0) return e;
    return r.join(`
`);
  }
  return {
    parser,
    projection,
    features,
    stripSimpleWrappers: oE,
    timeoutFlagsEnd: _at,
    stripTimedArgv: tOr,
    stripAssignments: rIe,
    stripWrapperArgv: x5e,
    executableWildcardUnsafe: dOr,
    environmentValueSafe: bU,
    environmentNeedsReview: Uwn,
    environmentNameAllowed: Ult,
    environmentNameWhitelisted: $lt,
    stripCommentLines: hbn,
    matchRules<T>(
      input: { command: string },
      rules: ReadonlyMap<string, T>,
      phase: "exact" | "prefix",
      options: NativeBashPreparationOptions = {},
    ): NativeBashPreparationResult<T> {
      try {
        return {
          status: "resolved",
          matches: R8(input, rules, phase, options),
        };
      } catch (error) {
        if (error instanceof UnresolvedPreparationDependency)
          return {
            status: "unresolved",
            matches: [],
            dependency: error.dependency,
          };
        throw error;
      }
    },
  };
}
export type NativeBashCommandPreparation = ReturnType<
  typeof createNativeBashCommandPreparation
>;

type CertifiedOption =
  { arity: "boolean" } | { arity: "value"; valueShape: "opaque" | "ref" };
type CertifiedOperands =
  | { kind: "none" | "revisionsAndPathspecs" | "prNumber" }
  | { kind: "pathspecs"; min: number }
  | { kind: "pushRemoteAndRefspec"; remote: string };
interface CertifiedDescriptor {
  head: string;
  subcommand: string[];
  longOptions: ReadonlyMap<string, CertifiedOption>;
  shortOptions: ReadonlyMap<string, CertifiedOption>;
  operands: CertifiedOperands;
  requiredOptions?: string[];
  allowNumericCountShort?: boolean;
}
function Gti(value: string): boolean {
  if (value.includes("__TRACKED_VAR__") || value.includes("__UNCERTAIN_VAR__"))
    return true;
  let at = value.indexOf(pJ);
  while (at !== -1) {
    if (!(at > 0 && value[at - 1] === "\n")) return true;
    at = value.indexOf(pJ, at + pJ.length);
  }
  return false;
}
var Tun = "certified: git status",
  XHr = "certified: git add",
  JHr = "certified: git commit",
  QHr = "certified: git checkout -b",
  KNs = "certified: git log",
  YNs = "certified: git diff",
  XNs = "certified: git branch --show-current",
  ZHr = "certified: gh pr create",
  jrt = "certified: gh pr edit",
  eNr = "certified: gh pr view",
  Urt = "certified: git push ",
  pkn = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function vIo(e: string): string | null {
  if (!pkn.test(e)) return null;
  return Urt + e;
}
function MK(e: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(e)) return !1;
  if (e.includes("..") || e.includes("@{") || e.endsWith("/")) return !1;
  return !0;
}
function ZAr(e: string): boolean {
  let n = e.indexOf("...");
  if (n !== -1) return MK(e.slice(0, n)) && MK(e.slice(n + 3));
  let r = e.indexOf("..");
  if (r !== -1) return MK(e.slice(0, r)) && MK(e.slice(r + 2));
  return MK(e);
}
function lkn(e: string): boolean {
  if (e === "") return !1;
  for (let n of e.split("/")) {
    if (n === "" || n === "." || n === "..") return !1;
    if (!/^[A-Za-z0-9_.][A-Za-z0-9._@+-]*$/.test(n)) return !1;
  }
  return !0;
}
var rD = new Map<string, CertifiedOption>(),
  ax = (e: [string, CertifiedOption][]) => new Map(e),
  Xv: CertifiedOption = { arity: "boolean" },
  SU: CertifiedOption = { arity: "value", valueShape: "opaque" },
  exr: CertifiedOption = { arity: "value", valueShape: "ref" },
  txr = new Map<string, CertifiedDescriptor>([
    [
      Tun,
      {
        head: "git",
        subcommand: ["status"],
        longOptions: ax([
          ["--porcelain", Xv],
          ["--short", Xv],
        ]),
        shortOptions: ax([
          ["s", Xv],
          ["b", Xv],
        ]),
        operands: { kind: "none" },
      },
    ],
    [
      XHr,
      {
        head: "git",
        subcommand: ["add"],
        longOptions: rD,
        shortOptions: rD,
        operands: { kind: "pathspecs", min: 1 },
      },
    ],
    [
      JHr,
      {
        head: "git",
        subcommand: ["commit"],
        longOptions: rD,
        shortOptions: ax([["m", SU]]),
        requiredOptions: ["-m"],
        operands: { kind: "pathspecs", min: 0 },
      },
    ],
    [
      QHr,
      {
        head: "git",
        subcommand: ["checkout"],
        longOptions: rD,
        shortOptions: ax([["b", exr]]),
        requiredOptions: ["-b"],
        operands: { kind: "none" },
      },
    ],
    [
      KNs,
      {
        head: "git",
        subcommand: ["log"],
        longOptions: ax([
          ["--oneline", Xv],
          ["--stat", Xv],
          ["--name-only", Xv],
        ]),
        shortOptions: rD,
        allowNumericCountShort: !0,
        operands: { kind: "revisionsAndPathspecs" },
      },
    ],
    [
      YNs,
      {
        head: "git",
        subcommand: ["diff"],
        longOptions: ax([
          ["--stat", Xv],
          ["--cached", Xv],
          ["--name-only", Xv],
        ]),
        shortOptions: rD,
        operands: { kind: "revisionsAndPathspecs" },
      },
    ],
    [
      XNs,
      {
        head: "git",
        subcommand: ["branch"],
        longOptions: ax([["--show-current", Xv]]),
        shortOptions: rD,
        requiredOptions: ["--show-current"],
        operands: { kind: "none" },
      },
    ],
    [
      ZHr,
      {
        head: "gh",
        subcommand: ["pr", "create"],
        longOptions: ax([
          ["--title", SU],
          ["--body", SU],
          ["--draft", Xv],
          ["--reviewer", SU],
        ]),
        shortOptions: rD,
        operands: { kind: "none" },
      },
    ],
    [
      jrt,
      {
        head: "gh",
        subcommand: ["pr", "edit"],
        longOptions: ax([
          ["--title", SU],
          ["--body", SU],
          ["--add-reviewer", SU],
        ]),
        shortOptions: rD,
        operands: { kind: "none" },
      },
    ],
    [
      eNr,
      {
        head: "gh",
        subcommand: ["pr", "view"],
        longOptions: ax([["--json", SU]]),
        shortOptions: rD,
        operands: { kind: "prNumber" },
      },
    ],
  ]);
function nxr(e: string): CertifiedDescriptor | null {
  let n = txr.get(e);
  if (n !== void 0) return n;
  if (e.startsWith(Urt)) {
    let r = e.slice(Urt.length);
    if (!pkn.test(r)) return null;
    return {
      head: "git",
      subcommand: ["push"],
      longOptions: ax([["--set-upstream", Xv]]),
      shortOptions: ax([["u", Xv]]),
      operands: { kind: "pushRemoteAndRefspec", remote: r },
    };
  }
  return null;
}
function oxr(e: NativeBashPreparationRedirect): boolean {
  return (
    e.op === ">" &&
    (e.fd === void 0 || e.fd === 2) &&
    e.target === "/dev/null" &&
    e.targetSourceLiteral === !0
  );
}
function ckn(e: CertifiedOption, n: string): boolean {
  if (e.arity !== "value") return !1;
  if (n.startsWith("-")) return !1;
  if (e.valueShape === "ref") return MK(n);
  return !0;
}
function rxr(e: CertifiedOperands, n: string[]): boolean {
  switch (e.kind) {
    case "none":
      return n.length === 0;
    case "pathspecs":
      return n.length >= e.min && n.every(lkn);
    case "revisionsAndPathspecs":
      return n.every((r) => ZAr(r) || lkn(r));
    case "prNumber":
      return n.length <= 1 && n.every((r) => /^[0-9]+$/.test(r));
    case "pushRemoteAndRefspec": {
      if (n.length < 1 || n.length > 2) return !1;
      if (n[0] !== e.remote) return !1;
      let r = n[1];
      return r === void 0 || MK(r);
    }
  }
}
function mkn(
  e: string,
  n: NativeBashPreparationAstCommand,
  r: readonly string[],
): boolean {
  let a = nxr(e);
  if (a === null) return !1;
  if (n.argvSourceLiteral !== !0) return !1;
  if (n.envVars.length > 0) return !1;
  if (r.length > 0) return !1;
  let h =
    n.argv.some((V) => /[*?[]/.test(V)) ||
    n.redirects.some((V) => /[*?[]/.test(V.target));
  if (n.carveOutMayDesyncQuoteScan === !0) {
    if (h) return !1;
  } else if (n.hasUnquotedGlob && h) return !1;
  for (let V of n.redirects) if (!oxr(V)) return !1;
  for (let V of n.argv) if (Gti(V)) return !1;
  if (n.argv[0] !== a.head) return !1;
  for (let V = 0; V < a.subcommand.length; V++)
    if (n.argv[1 + V] !== a.subcommand[V]) return !1;
  let y = n.argv.slice(1 + a.subcommand.length),
    k: string[] = [],
    E = new Set<string>(),
    N = !1;
  for (let V = 0; V < y.length; V++) {
    let oe = y[V];
    if (oe === void 0) return !1;
    if (N) {
      k.push(oe);
      continue;
    }
    if (oe === "--") {
      N = !0;
      continue;
    }
    if (oe.startsWith("--")) {
      if (oe.includes("=")) return !1;
      let re = a.longOptions.get(oe);
      if (re === void 0) return !1;
      if (E.has(oe)) return !1;
      if ((E.add(oe), re.arity === "value")) {
        let _e = y[V + 1];
        if (_e === void 0 || !ckn(re, _e)) return !1;
        V++;
      }
      continue;
    }
    if (oe.startsWith("-") && oe !== "-") {
      if (a.allowNumericCountShort === !0 && /^-[0-9]+$/.test(oe)) continue;
      if (!/^-[A-Za-z]$/.test(oe)) return !1;
      let re = a.shortOptions.get(oe.slice(1));
      if (re === void 0) return !1;
      if (E.has(oe)) return !1;
      if ((E.add(oe), re.arity === "value")) {
        let _e = y[V + 1];
        if (_e === void 0 || !ckn(re, _e)) return !1;
        V++;
      }
      continue;
    }
    k.push(oe);
  }
  if (a.requiredOptions !== void 0) {
    for (let V of a.requiredOptions) if (!E.has(V)) return !1;
  }
  return rxr(a.operands, k);
}

/** Pure native descriptor verifier. Host must supply actual oR/v6e semantic metadata. */
export {
  mkn as verifyNativeBashCertifiedRule,
  vIo as buildNativeBashCertifiedPushRule,
};
