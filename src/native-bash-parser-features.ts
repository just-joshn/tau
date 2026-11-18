import { AsyncLocalStorage } from "node:async_hooks";

export interface NativeBashFeatureValue {
  value: unknown;
  source: string;
  defaultHost: boolean;
}
export type NativeBashFeatureReader = (
  key: string,
  defaultValue: boolean,
) => NativeBashFeatureValue;
export interface NativeBashParserFeatureOptions {
  keywordReader?: NativeBashFeatureReader;
  grammarReader?: NativeBashFeatureReader;
  misreadingReader?: NativeBashFeatureReader;
  quoteReader?: NativeBashFeatureReader;
}

export const nativeBashDollarOperandPattern = /\$\$[({[]/;
export const nativeBashAlternateArithmeticPattern =
  /\((?:\\+\n)*\(|\$(?:\\+\n)*\[/;

const plainHeads = new Set(
  "cat tee echo mkdir cd ls pwd touch cp mv chmod head tail wc grep jq diff true date sleep node python python3".split(
    " ",
  ),
);
const headFamilies: Readonly<Record<string, string>> = {
  head_shell: "sh bash zsh dash ksh",
  head_wrapper: "timeout env nice nohup sudo xargs find time command exec",
  head_script_tool: "sed awk perl printf",
  head_git: "git",
  head_package_tool: "npm npx pnpm yarn bun pip pip3 make",
  head_fetch: "curl wget",
  head_keyword: "if for while until case",
};

function classifyHead(head: string | undefined, text: string): string {
  if (head === undefined)
    return /^\w+\+?=/.test(text) ? "head_assignment" : "head_not_bare";
  for (const [family, names] of Object.entries(headFamilies))
    if (names.split(" ").includes(head)) return family;
  return "head_other";
}

/** R_i: source-defined exemption grammar; this is not a shell AST or a permission decision. */
export function classifyNativeBashPlainLine(input: string): string | undefined {
  for (let offset = 0; offset < input.length; offset++) {
    const code = input.charCodeAt(offset);
    if (code <= 8 || (code >= 11 && code <= 31) || code === 127)
      return "control_byte";
  }
  const heads = /[\w.-]+(?=[ \t\n;|&<>]|$)/y;
  const separators = /&&(?![&|!])|\|\|?(?![|&])|;(?![;&])/y;
  const text =
    /(?:[ \t\w%+,./:=@~^-]|\$(?:\w+(?!\w)|\{[A-Za-z_]\w*\})(?![[:])|"(?:[\n\t !#%-[\]-_a-~]|\$(?:\w+(?!\w)|\{[A-Za-z_]\w*\})(?![[:]))*"|>>?(?![>&|(])|<(?![<>&(\d-])|>&\d+(?=[ \t\n;|]|$))+/y;
  const heredoc = /<<(-?)[ \t]*(['"])(\w+)\2(?=[ \t\n;|&<>]|$)/y;
  const pending: { name: string; stripsTabs: boolean }[] = [];
  let head = true;
  let offset = 0;
  while (offset < input.length) {
    const character = input[offset];
    if (character === "\n") {
      offset++;
      for (const { name, stripsTabs } of pending.splice(0))
        for (;;) {
          if (offset >= input.length) return "open_heredoc";
          const newline = input.indexOf("\n", offset);
          const end = newline === -1 ? input.length : newline;
          const line = input.slice(offset, end);
          offset = Math.min(end + 1, input.length);
          if ((stripsTabs ? line.replace(/^\t+/, "") : line) === name) break;
        }
      head = true;
    } else if (head && (character === " " || character === "\t")) offset++;
    else if (head && character === "#") {
      const line = input.lastIndexOf("\n", offset - 1) + 1;
      if (/[^ \t]/.test(input.slice(line, offset))) return "comment";
      const newline = input.indexOf("\n", offset);
      offset = newline === -1 ? input.length : newline;
    } else if (!head && character === "'") {
      const close = input.indexOf("'", offset + 1);
      if (close === -1) return "open_quote";
      offset = close + 1;
    } else {
      const expression: RegExp = head
        ? heads
        : character === "<" && input[offset + 1] === "<"
          ? heredoc
          : character !== undefined && "&|;".includes(character)
            ? separators
            : text;
      expression.lastIndex = offset;
      const match = expression.exec(input);
      if (head && !plainHeads.has(match?.[0] ?? ""))
        return classifyHead(match?.[0], input.slice(offset, offset + 80));
      if (match === null) return "construct";
      if (expression === heredoc) {
        const name = match[3];
        if (name === undefined) throw new Error("Missing heredoc name capture");
        pending.push({ name, stripsTabs: match[1] === "-" });
      }
      head = expression === separators;
      offset += match[0].length;
    }
  }
  return pending.length === 0 ? undefined : "open_heredoc";
}

function readDefault(
  reader: NativeBashFeatureReader | null | undefined,
  key: string,
  fallback: boolean,
): boolean {
  if (reader === undefined || reader === null) return fallback;
  try {
    const result = reader(key, fallback);
    return result.value === !fallback &&
      result.source === "payload" &&
      result.defaultHost
      ? !fallback
      : fallback;
  } catch {
    return fallback;
  }
}

// The three grammar guard readers destructure their receipt eagerly. AR's
// general reader above intentionally retains its separate short-circuit order.
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

/** Concrete feature/context owner. It reads only an explicitly installed reader. */
export function createNativeBashParserFeatures(
  options: NativeBashParserFeatureOptions = {},
) {
  let keywordReader: NativeBashFeatureReader | null | undefined =
    options.keywordReader ?? null;
  let grammarReader: NativeBashFeatureReader | null | undefined =
    options.grammarReader ?? null;
  let misreadingReader: NativeBashFeatureReader | null | undefined =
    options.misreadingReader ?? null;
  let quoteReader: NativeBashFeatureReader | null | undefined =
    options.quoteReader ?? null;
  const keyword = new AsyncLocalStorage<{ off: boolean; fired: boolean }>();
  const arithmeticOff = new AsyncLocalStorage<boolean>();
  const alternateArithmetic = new AsyncLocalStorage<boolean>();
  const dollarOperandOff = new AsyncLocalStorage<boolean>();
  const ignoredMisreading = new AsyncLocalStorage<boolean>();
  const divergence = new AsyncLocalStorage<{ mayDiffer: boolean }>();
  const misreading = new AsyncLocalStorage<{ misreading?: string }>();
  const grammar = (key: string) => readGuard(grammarReader, key);
  const patternFlag = /\$(?:\{\s*(?:['"]|[\^=~]|\\\n?)*|(?:[\^=~]|\\\n?)*)~/;

  const features = {
    registerKeywordReader(reader: NativeBashFeatureReader | null | undefined) {
      const previous = keywordReader;
      keywordReader = reader;
      return previous;
    },
    registerGrammarReader(reader: NativeBashFeatureReader | null | undefined) {
      grammarReader = reader;
    },
    registerMisreadingReader(
      reader: NativeBashFeatureReader | null | undefined,
    ) {
      const previous = misreadingReader;
      misreadingReader = reader;
      return previous;
    },
    registerQuoteReader(reader: NativeBashFeatureReader | null | undefined) {
      const previous = quoteReader;
      quoteReader = reader;
      return previous;
    },
    keywordGuardEnabled() {
      return readGuard(keywordReader, "tengu_tingly_pearl");
    },
    keywordGuardOff() {
      return keyword.getStore()?.off === true;
    },
    markKeywordDesynchronization() {
      const scope = keyword.getStore();
      if (scope) scope.fired = true;
    },
    async observeKeywordGuard<T>(off: boolean, run: () => T | Promise<T>) {
      const scope = { off, fired: false };
      const result = await keyword.run(scope, run);
      return { result, fired: scope.fired };
    },
    withoutKeywordGuard<T>(run: () => T): T {
      return keyword.run({ off: true, fired: false }, run);
    },
    quotedSubscriptGuardEnabled() {
      return readGuard(quoteReader, "tengu_calm_nautilus");
    },
    repeatedDollarGuardEnabled() {
      return grammar("tengu_foamy_heron");
    },
    dollarQuoteGuardEnabled() {
      return grammar("bot_protected_tengu_compressed_axolotl");
    },
    braceRereadGuardEnabled() {
      return grammar("bot_protected_tengu_replicated_mitten");
    },
    prefixFunctionGuardEnabled() {
      return grammar("bot_protected_tengu_ticklish_clock");
    },
    alternateArithmeticRead() {
      return alternateArithmetic.getStore() === true;
    },
    withAlternateArithmeticRead<T>(run: () => T): T {
      return alternateArithmetic.run(true, run);
    },
    arithmeticGuardEnabled() {
      return (
        arithmeticOff.getStore() !== true &&
        grammar("bot_protected_tengu_gilded_abacus")
      );
    },
    withoutArithmeticGuard<T>(run: () => T): T {
      return arithmeticOff.run(true, run);
    },
    dollarOperandGuardEnabled(input: string) {
      return (
        nativeBashDollarOperandPattern.test(input) &&
        dollarOperandOff.getStore() !== true &&
        grammar("tengu_deep_locket") &&
        !(
          readDefault(grammarReader, "tengu_moonlit_crayon", false) &&
          classifyNativeBashPlainLine(input) === undefined
        )
      );
    },
    withoutDollarOperandGuard<T>(run: () => T): T {
      return dollarOperandOff.run(true, run);
    },
    bracketWordGuardEnabled() {
      return readDefault(
        misreadingReader,
        "bot_protected_tengu_reflective_marble",
        true,
      );
    },
    semanticReadGuardEnabled() {
      return (
        ignoredMisreading.getStore() !== true &&
        readDefault(misreadingReader, "tengu_sturdy_lantern", true)
      );
    },
    withoutMisreading<T>(run: () => T): T {
      return ignoredMisreading.run(true, run);
    },
    markMayDiffer() {
      const scope = divergence.getStore();
      if (scope) scope.mayDiffer = true;
    },
    async observeMayDiffer<T>(run: () => T | Promise<T>) {
      const scope = { mayDiffer: false };
      const result = await divergence.run(scope, run);
      return { result, mayDiffer: scope.mayDiffer };
    },
    async observeMisreading<T>(run: () => T | Promise<T>) {
      const scope: { misreading?: string } = {};
      const result = await misreading.run(scope, run);
      return { result, ...scope };
    },
    readMisreading(reason: string | undefined): string | undefined {
      if (
        reason === undefined ||
        ignoredMisreading.getStore() === true ||
        !readDefault(
          misreadingReader,
          "bot_protected_tengu_splendid_melody",
          true,
        )
      )
        return;
      const scope = misreading.getStore();
      if (scope === undefined) return reason;
      scope.misreading ??= reason;
    },
    inputMisreading(input: string) {
      return features.readMisreading(
        patternFlag.test(input) && features.dollarQuoteGuardEnabled()
          ? "pattern_flag"
          : undefined,
      );
    },
    withInputReadGuards<T>(input: string, run: () => T): T {
      const guarded = () =>
        features.dollarOperandGuardEnabled(input)
          ? features.withoutDollarOperandGuard(run)
          : run();
      return nativeBashAlternateArithmeticPattern.test(input)
        ? features.withoutArithmeticGuard(guarded)
        : guarded();
    },
  };
  return features;
}
export type NativeBashParserFeatures = ReturnType<
  typeof createNativeBashParserFeatures
>;
