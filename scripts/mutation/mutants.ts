// Mutant enumeration and splicing for scripts/mutation/run.ts. Each mutant
// replaces one source range, so the rest of the file stays byte-identical.
import { parse } from "@babel/parser";
import type { Expression, Node, ReturnStatement } from "@babel/types";

export type Operator =
  | "equality"
  | "relational"
  | "logical"
  | "remove-not"
  | "negate-test"
  | "boolean-literal"
  | "negate-return";

export interface Mutant {
  operator: Operator;
  start: number;
  end: number;
  replacement: string;
  original: string;
  line: number;
  column: number;
}

const FLIPS: Readonly<Record<string, [Operator, string]>> = {
  "===": ["equality", "!=="],
  "!==": ["equality", "==="],
  "==": ["equality", "!="],
  "!=": ["equality", "=="],
  "<": ["relational", "<="],
  "<=": ["relational", "<"],
  ">": ["relational", ">="],
  ">=": ["relational", ">"],
  "&&": ["logical", "||"],
  "||": ["logical", "&&"],
};

// TypeScript nodes that still run. Every other TS* node is type-only.
const RUNTIME_TS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSExportAssignment",
  "TSEnumDeclaration",
  "TSEnumMember",
]);
const SKIPPED_KEYS = new Set([
  "loc",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

export function enumerateMutants(source: string): Mutant[] {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") lineStarts.push(index + 1);
  const mutants: Mutant[] = [];
  const add = (
    operator: Operator,
    start: number,
    end: number,
    replacement: string,
  ) => {
    let line = lineStarts.length;
    while ((lineStarts[line - 1] ?? 0) > start) line--;
    mutants.push({
      operator,
      start,
      end,
      replacement,
      original: source.slice(start, end),
      line,
      column: start - (lineStarts[line - 1] ?? 0) + 1,
    });
  };
  // A negation that another operator already produces is a duplicate.
  const negate = (operator: Operator, node: Expression) => {
    if (node.type === "UnaryExpression" && node.operator === "!") return;
    if (
      node.type === "BinaryExpression" &&
      FLIPS[node.operator]?.[0] === "equality"
    )
      return;
    const [start, end] = span(node);
    add(operator, start, end, `!(${source.slice(start, end)})`);
  };

  walk(ast.program, (node) => {
    switch (node.type) {
      case "BinaryExpression":
      case "LogicalExpression": {
        const flip = FLIPS[node.operator];
        if (flip === undefined) return;
        const gap = span(node.left)[1];
        const at = source.indexOf(node.operator, gap);
        if (at < 0 || at >= span(node.right)[0])
          throw new Error(`operator ${node.operator} not found at ${gap}`);
        add(flip[0], at, at + node.operator.length, flip[1]);
        return;
      }
      case "UnaryExpression": {
        if (node.operator !== "!") return;
        const [start, end] = span(node);
        add("remove-not", start, end, source.slice(start + 1, end));
        return;
      }
      case "IfStatement":
      case "ConditionalExpression":
      case "WhileStatement":
        negate("negate-test", node.test);
        return;
      case "BooleanLiteral": {
        const [start, end] = span(node);
        add("boolean-literal", start, end, String(!node.value));
        return;
      }
      default: {
        const body = "body" in node ? node.body : undefined;
        if (!FUNCTIONS.has(node.type) || !isNode(body)) return;
        const returns: ReturnStatement[] = [];
        walk(body, (inner) => {
          if (inner.type === "ReturnStatement") returns.push(inner);
          return !FUNCTIONS.has(inner.type);
        });
        if (
          !returns.some(({ argument }) => argument?.type === "BooleanLiteral")
        )
          return;
        for (const { argument } of returns)
          if (argument && argument.type !== "BooleanLiteral")
            negate("negate-return", argument);
      }
    }
  });

  mutants.sort((a, b) => a.start - b.start || a.end - b.end);
  for (const mutant of mutants) {
    try {
      parse(applyMutant(source, mutant), {
        sourceType: "module",
        plugins: ["typescript"],
      });
    } catch (error) {
      throw new Error(
        `mutant ${describeMutant(mutant)} does not parse: ${String(error)}`,
      );
    }
  }
  return mutants;
}

export function applyMutant(source: string, mutant: Mutant): string {
  return (
    source.slice(0, mutant.start) +
    mutant.replacement +
    source.slice(mutant.end)
  );
}

/** `line:col operator original → mutated`, whitespace collapsed. */
export function describeMutant(mutant: Mutant): string {
  const flat = (text: string) => text.replace(/\s+/g, " ");
  return `${mutant.line}:${mutant.column} ${mutant.operator} ${flat(mutant.original)} → ${flat(mutant.replacement)}`;
}

/** Visits runtime nodes depth-first. A visitor returning false skips children. */
function walk(node: Node, visit: (node: Node) => boolean | void): void {
  if (node.type.startsWith("TS") && !RUNTIME_TS.has(node.type)) return;
  if (visit(node) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    for (const child of Array.isArray(value) ? value : [value])
      if (isNode(child)) walk(child, visit);
  }
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number"
  );
}

function span(node: Node): [number, number] {
  if (typeof node.start !== "number" || typeof node.end !== "number")
    throw new Error(`${node.type} has no source range`);
  return [node.start, node.end];
}
