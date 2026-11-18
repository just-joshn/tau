import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { triBoolean } from "./env-settings.js";
import { plainMemory } from "./native-file-adjudication-host.js";
import {
  encodeNativeProjectDirectoryName,
  validateNativeProjectDirectoryOverride,
} from "./native-storage-paths.js";
import {
  AUTO_MEMORY_BODY,
  AUTO_MEMORY_DIRECTORY_EXISTS,
} from "./auto-memory-text.js";

export const AUTO_MEMORY_INDEX = "MEMORY.md";
export const AUTO_MEMORY_INDEX_LINES = 200;
/** Source Iae bounds UTF-16 units, despite the original's byteCount name. */
export const AUTO_MEMORY_INDEX_UNITS = 25_000;

type Env = Readonly<Record<string, string | undefined>>;
type DirectorySettingSource =
  | "policySettings"
  | "flagSettings"
  | "localSettings"
  | "projectSettings"
  | "userSettings";

/** One session's auto memory: where it lives and whether the model is told about it. */
export interface AutoMemoryStore {
  /** Source Gg(): gates the prompt section, MEMORY.md and init memory_paths. */
  readonly enabled: boolean;
  /** Source pd(): absolute, NFC, trailing separator. Resolved even when disabled. */
  readonly directory: string;
  readonly indexPath: string;
  /** Source resolveOwnProjectDir: the cwd-keyed folder, writable only while enabled. */
  readonly ownProjectDirectory: string | null;
  /** Source Mpt(): a cowork path override withholds the write allowance. */
  readonly pathOverridden: boolean;
  /** CLAUDE_CODE_REMOTE withholds the read allowance. */
  readonly remoteSurface: boolean;
}

export interface AutoMemoryFacts {
  /** The shared Gg() gate, already evaluated by the session's memory facts. */
  enabled: boolean;
  env: Env;
  /** Source Ye(): CLAUDE_CONFIG_DIR or ~/.claude. */
  configDirectory: string;
  /** Expansion root for a `~/` autoMemoryDirectory. */
  home: string;
  /** Source Te(): the session's original working directory. */
  cwd: string;
  canonicalGitRoot: string | null;
  /** autoMemoryDirectory as each settings source carries it. */
  settings: Partial<Record<DirectorySettingSource, unknown>>;
  /** Source kT() && !pre(): project and local settings may move the folder. */
  projectSettingsAdmitted: boolean;
}

/** Source Vf: absolute, at least three characters, no drive-only, UNC or NUL spelling. */
function memoryRoot(value: unknown, home?: string): string | undefined {
  if (typeof value !== "string" || !value) return;
  let path = value;
  if (home !== undefined && (path.startsWith("~/") || path.startsWith("~\\"))) {
    const rest = path.slice(2),
      inner = normalize(rest || ".");
    if (
      inner === "." ||
      inner === ".." ||
      inner.startsWith(`..${sep}`) ||
      inner.startsWith("../") ||
      inner.startsWith("..\\")
    )
      return;
    path = join(home, rest);
  }
  const base = normalize(path).replace(/[/\\]+$/, "");
  if (
    !isAbsolute(base) ||
    base.length < 3 ||
    /^[A-Za-z]:$/.test(base) ||
    /^(?:\\\\|\/\/)/.test(base) ||
    base.includes("\0")
  )
    return;
  return (base + sep).normalize("NFC");
}

/** Source Yf.resolveEntry: cowork override, then settings, then the project key. */
export function resolveAutoMemoryStore(
  facts: AutoMemoryFacts,
): AutoMemoryStore {
  const { env } = facts;
  const override = memoryRoot(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE);
  const sources = [
    "policySettings",
    "flagSettings",
    ...(facts.projectSettingsAdmitted
      ? (["localSettings", "projectSettings"] as const)
      : []),
    "userSettings",
  ] as const;
  const configured = sources.find((source) => facts.settings[source] != null);
  const setting =
    configured === undefined
      ? undefined
      : memoryRoot(facts.settings[configured], facts.home);
  const remote = env.CLAUDE_CODE_REMOTE_MEMORY_DIR
    ? resolve(facts.cwd, env.CLAUDE_CODE_REMOTE_MEMORY_DIR)
    : undefined;
  const base = remote ?? facts.configDirectory;
  // Source pD: CLAUDE_CODE_PROJECT_DIR_NAME applies only beside CLAUDE_CONFIG_DIR.
  const named = (path: string) =>
    (env.CLAUDE_CONFIG_DIR
      ? validateNativeProjectDirectoryOverride(env.CLAUDE_CODE_PROJECT_DIR_NAME)
      : undefined) ?? encodeNativeProjectDirectoryName(path);
  const folder = (path: string, key: (path: string) => string) =>
    (join(base, "projects", key(path), "memory") + sep).normalize("NFC");
  const configHome = remote === undefined || remote === facts.configDirectory;
  const ownKey = configHome ? named : encodeNativeProjectDirectoryName;
  const directory =
    override ?? setting ?? folder(facts.canonicalGitRoot ?? facts.cwd, ownKey);
  return Object.freeze({
    enabled: facts.enabled,
    directory,
    indexPath: join(directory, AUTO_MEMORY_INDEX),
    ownProjectDirectory:
      override !== undefined || setting !== undefined || !configHome
        ? null
        : folder(facts.cwd, named),
    pathOverridden: override !== undefined,
    remoteSurface: triBoolean(env.CLAUDE_CODE_REMOTE) === true,
  });
}

/** Source bQn's file-backed branch: the `# auto memory` system prompt section. */
export function autoMemoryPrompt(
  store: AutoMemoryStore | undefined,
  env: Env,
): string | null {
  if (!store?.enabled) return null;
  const replacement = env.CLAUDE_COWORK_MEMORY_GUIDELINES;
  if (replacement) return `# auto memory\n${replacement}`;
  const extra = env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES;
  return [
    "# auto memory",
    "",
    `You have a persistent, file-based memory system at \`${store.directory}\`. ${AUTO_MEMORY_DIRECTORY_EXISTS}`,
    "",
    AUTO_MEMORY_BODY,
    "",
    ...(extra ? [extra] : []),
    "",
  ].join("\n");
}

/** The instruction catalog's MEMORY.md source, absent when it is not loaded. */
export function autoMemoryIndexOption(
  store: AutoMemoryStore | undefined,
  env: Env = process.env,
): { autoMemoryIndex?: { path: string; content?: string } } {
  const inline = env.CLAUDE_COWORK_MEMORY_INDEX_CONTENT;
  if (!store?.enabled || inline === "") return {};
  return {
    autoMemoryIndex:
      inline === undefined
        ? { path: store.indexPath }
        : { path: store.indexPath, content: inline },
  };
}

/** Source a6: shorten to `limit` units at a word boundary, with an ellipsis. */
function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.search(/\s\S*$/),
    word = space === -1 ? "" : cut.slice(0, space).trimEnd();
  return `${word.length > limit / 2 ? word : cut.trimEnd()}\u2026`;
}
/** Source rn. */
function size(units: number): string {
  const fixed = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  const kb = units / 1024,
    mb = kb / 1024;
  if (kb < 1) return `${units} bytes`;
  if (kb < 1024) return `${fixed(kb)}KB`;
  return mb < 1024 ? `${fixed(mb)}MB` : `${fixed(mb / 1024)}GB`;
}

/** Source p5r: 200 lines, then 25,000 units at a line break, then a warning. */
export function truncateAutoMemoryIndex(text: string): string {
  const trimmed = text.trim(),
    lines = trimmed.split("\n").length,
    units = trimmed.length,
    overLines = lines > AUTO_MEMORY_INDEX_LINES,
    overUnits = units > AUTO_MEMORY_INDEX_UNITS;
  if (!overLines && !overUnits) return trimmed;
  let kept = overLines
    ? trimmed.split("\n").slice(0, AUTO_MEMORY_INDEX_LINES).join("\n")
    : trimmed;
  if (kept.length > AUTO_MEMORY_INDEX_UNITS) {
    const lf = kept.lastIndexOf("\n", AUTO_MEMORY_INDEX_UNITS);
    kept = kept.slice(0, lf > 0 ? lf : AUTO_MEMORY_INDEX_UNITS);
  }
  const whole = trimmed[kept.length] === "\n" ? kept.split("\n").length : 0;
  const next = trimmed.indexOf("\n", kept.length + 1);
  const first = trimmed
    .slice(kept.length + 1, next < 0 ? undefined : next)
    .trim();
  const cut =
    whole === 0
      ? `everything after the first ${kept.length} characters of line 1 was cut off`
      : `${lines - whole} of ${lines} lines were cut off, starting at line ${whole + 1}${first ? ` ("${shorten(first, 80)}")` : ""}`;
  const reason =
    overUnits && !overLines
      ? `${size(units)} (limit: ${size(AUTO_MEMORY_INDEX_UNITS)}) \u2014 index entries are too long`
      : overLines && !overUnits
        ? `${lines} lines (limit: ${AUTO_MEMORY_INDEX_LINES})`
        : `${lines} lines and ${size(units)}`;
  return `${kept}\n\n> WARNING: ${AUTO_MEMORY_INDEX} is ${reason}. Only part of it was loaded: ${cut}. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

const KEPT_FORMAT = new Set([0x200c, 0x200d, 0xfe0e, 0xfe0f, 9, 10, 13]);
const INVISIBLE = /^[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{DI}]$/u;
/** Source Phe's literal tag names; the original's fuzzy opener scan is wider. */
const NEUTRALIZED =
  /<(?=\s*\/?\s*(?:system-reminder|system_reminder|function_results|tool_use_error|sandbox_violations|persisted-output|total_tokens|user-prompt-submit-hook|antml)\b)/giu;

/** Source Qbe: drop invisible and control characters, then defuse reminder-tag openers. */
export function sanitizeAutoMemoryIndex(text: string): string {
  let visible = "";
  for (const character of text.replace(/\r\n?|[\u2028\u2029]/g, "\n")) {
    const code = character.codePointAt(0) ?? 0;
    if (
      !KEPT_FORMAT.has(code) &&
      (INVISIBLE.test(character) || code < 32 || (code >= 127 && code <= 159))
    )
      continue;
    visible += character;
  }
  return visible.replace(NEUTRALIZED, "<\\");
}

/** Source vct's `auto memory files are allowed for writing` (Tme, Kza). */
export function autoMemoryWriteAllowed(
  store: AutoMemoryStore,
  path: string,
): boolean {
  return (
    !store.pathOverridden &&
    path.endsWith(".md") &&
    (plainMemory(path, store.directory) ||
      (store.enabled && plainMemory(path, store.ownProjectDirectory)))
  );
}

/** Source `auto memory files are allowed for reading`. */
export function autoMemoryReadAllowed(
  store: AutoMemoryStore,
  path: string,
): boolean {
  return !store.remoteSurface && plainMemory(path, store.directory);
}
