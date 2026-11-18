import type { NativePermissionRuleBehavior } from "./native-permission-outcome.js";
export interface NativeRawRuleValue {
  toolName: string;
  ruleContent?: string | undefined;
}

export type NativeRawRuleSyntax =
  | { kind: "bare" }
  | { kind: "malformed" }
  | { kind: "call"; toolName: string; rawContent: string };

function delimiter(text: string, character: string, last: boolean): number {
  for (
    let index = last ? text.length - 1 : 0;
    last ? index >= 0 : index < text.length;
    index += last ? -1 : 1
  ) {
    if (text[index] !== character) continue;
    let slashes = 0,
      previous = index - 1;
    while (previous >= 0 && text[previous] === "\\") {
      slashes++;
      previous--;
    }
    if (slashes % 2 === 0) return index;
  }
  return -1;
}

/** O0 preserves raw empty/star content and an empty-name call for its own validators. */
export function nativeRawRuleSyntax(text: string): NativeRawRuleSyntax {
  if (!text.includes("(") && !text.includes(")")) return { kind: "bare" };
  const open = delimiter(text, "(", false),
    close = delimiter(text, ")", true);
  if (open === -1 && close === -1) return { kind: "bare" };
  const toolName = text.substring(0, open);
  if (
    open === -1 ||
    close <= open ||
    close !== text.length - 1 ||
    /[()]/.test(toolName)
  )
    return { kind: "malformed" };
  return {
    kind: "call",
    toolName,
    rawContent: text.substring(open + 1, close),
  };
}

export interface NativeNgContext {
  /** Actual Wio table; this parser does not invent a build's alias map. */
  aliases: Readonly<Record<string, string>>;
  /** Exact native h set, not arbitrary user-declared whole-tool names. */
  selectedCompatibilityTools: ReadonlySet<string>;
  /** Actual feature owner, read only for source-joi-eligible allow forms. */
  loneStarFeature(): boolean;
}
export function nativeNgRuleValue(
  text: string,
  behavior: NativePermissionRuleBehavior,
  context: NativeNgContext,
): NativeRawRuleValue {
  const syntax = nativeRawRuleSyntax(text);
  if (
    behavior === "allow" &&
    (text.endsWith("(*)") || text.endsWith("()")) &&
    syntax.kind === "call" &&
    (syntax.rawContent === "*" || syntax.rawContent === "") &&
    context.selectedCompatibilityTools.has(syntax.toolName) &&
    context.loneStarFeature()
  )
    return { toolName: syntax.toolName, ruleContent: "*" };
  const alias = (value: string): string => {
    if (!Object.hasOwn(context.aliases, value)) return value;
    const actual = context.aliases[value];
    if (actual === undefined)
      throw new TypeError(
        "Actual parser alias table contains an unavailable entry",
      );
    return actual;
  };
  if (syntax.kind !== "call" || !syntax.toolName)
    return { toolName: alias(text) };
  if (syntax.rawContent === "" || syntax.rawContent === "*")
    return { toolName: alias(syntax.toolName) };
  return {
    toolName: alias(syntax.toolName),
    ruleContent: syntax.rawContent
      .replaceAll("\\(", "(")
      .replaceAll("\\)", ")")
      .replaceAll("\\\\", "\\"),
  };
}

/** aW is a separate actual-owner check, even for a previously parsed star row. */
export function nativeIsAllowCompatibility(
  value: NativeRawRuleValue,
  context: NativeNgContext,
): boolean {
  return (
    value.ruleContent === "*" &&
    context.selectedCompatibilityTools.has(value.toolName) &&
    context.loneStarFeature()
  );
}
