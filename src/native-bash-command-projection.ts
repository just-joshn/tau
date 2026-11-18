/** Source-backed independent typed port; bounded byte proofs: artifacts/native-bash-command-port.
 * Parsing, projection and preparation are not permission or execution certificates. */
import type {
  NativeBashParser,
  NativeBashSyntaxNode,
} from "./native-bash-parser.js";
export interface NativeBashRedirection {
  target: string;
  operator: ">" | ">>";
}
export interface NativeBashRedirectionProjection {
  commandWithoutRedirections: string;
  redirections: NativeBashRedirection[];
  hasDangerousRedirection: boolean;
  dangerousRedirectionReason: "network_device" | "shell_expansion" | undefined;
}
export interface NativeBashBodyAlternative {
  body: string;
  bodyRoot: NativeBashSyntaxNode | null;
}
export interface NativeBashLineAlternative {
  line: string;
  lineRoot: NativeBashSyntaxNode | null;
}
interface BodyQueue {
  first: string[];
  second: string[];
}
interface BacktickBody {
  body: NativeBashSyntaxNode;
  quoted: boolean;
}
export interface NativeBashProjectionRefusal {
  kind: "too-complex";
  reason: string;
  differential: true;
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing command projection invariant");
  return value;
}
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
function count<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  let result = 0;
  for (const value of values) if (predicate(value)) result++;
  return result;
}
const commandTypes = new Set(["command", "declaration_command"]);
const declarationNames = new Set([
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
  "unset",
  "unsetenv",
]);
const staticWordTypes = new Set(["word", "string", "raw_string", "number"]);
const substitutionTypes = new Set([
  "command_substitution",
  "process_substitution",
]);
function cLe(
  node: NativeBashSyntaxNode,
  parent: NativeBashSyntaxNode | null,
): NativeBashSyntaxNode | null {
  if (commandTypes.has(node.type)) return node;
  if (node.type === "variable_assignment" && parent)
    return (
      parent.children.find(
        (child) =>
          commandTypes.has(child.type) && child.startIndex > node.startIndex,
      ) ?? null
    );
  if (node.type === "pipeline") {
    for (const child of node.children) {
      const found = cLe(child, node);
      if (found) return found;
    }
    return null;
  }
  if (node.type === "redirected_statement")
    return node.children.find((child) => commandTypes.has(child.type)) ?? null;
  for (const child of node.children) {
    const found = cLe(child, node);
    if (found) return found;
  }
  return null;
}
function Pn(text: string): string {
  return text.length >= 2 &&
    ((text[0] === '"' && text.at(-1) === '"') ||
      (text[0] === "'" && text.at(-1) === "'"))
    ? text.slice(1, -1)
    : text;
}
function ke(node: NativeBashSyntaxNode): string {
  return node.type === "word"
    ? node.text.replace(/\\(.)/g, "$1")
    : Pn(node.text);
}
function Zxt(node: NativeBashSyntaxNode): string[] {
  if (node.type === "declaration_command") {
    const first = node.children[0];
    return first && declarationNames.has(first.text) ? [first.text] : [];
  }
  const argv: string[] = [];
  let named = false;
  for (const child of node.children) {
    if (child.type === "variable_assignment") continue;
    if (child.type === "command_name" || (!named && child.type === "word")) {
      named = true;
      const part = child.children[0] ?? child;
      argv.push(
        part.type === "concatenation"
          ? part.children.some((piece) => substitutionTypes.has(piece.type))
            ? part.text
            : part.children.map(ke).join("")
          : ke(part),
      );
      continue;
    }
    if (staticWordTypes.has(child.type)) argv.push(ke(child));
    else if (child.type === "concatenation") {
      if (child.children.some((piece) => substitutionTypes.has(piece.type)))
        break;
      argv.push(child.children.map(ke).join(""));
    } else if (substitutionTypes.has(child.type)) break;
  }
  return argv;
}
const containerTypes = new Set([
  "program",
  "list",
  "pipeline",
  "redirected_statement",
]);
const adjacencyTypes = new Set([
  "command",
  "variable_assignment",
  "variable_assignments",
  "list",
  "pipeline",
  "redirected_statement",
  "negated_command",
  "declaration_command",
  "unset_command",
  "test_command",
  "subshell",
  "compound_statement",
  "if_statement",
  "while_statement",
  "for_statement",
  "case_statement",
  "function_definition",
  "ERROR",
]);
const ambiguousAdjacencyTypes = new Set([
  "negated_command",
  "if_statement",
  "while_statement",
  "for_statement",
  "subshell",
]);
function sameLine(
  parent: NativeBashSyntaxNode,
  left: NativeBashSyntaxNode,
  right: NativeBashSyntaxNode,
): boolean {
  return !Buffer.from(parent.text, "utf8")
    .subarray(
      left.endIndex - parent.startIndex,
      right.startIndex - parent.startIndex,
    )
    .toString("utf8")
    .replace(/\\\r?\n/g, "")
    .includes("\n");
}
function $5r(node: NativeBashSyntaxNode): NativeBashProjectionRefusal | null {
  let previous: NativeBashSyntaxNode | null = null;
  for (const child of node.children) {
    if (!child) continue;
    if (adjacencyTypes.has(child.type)) {
      if (previous !== null) {
        let first = child;
        while (containerTypes.has(first.type)) {
          const nested = first.children.find((value) => value != null);
          if (!nested) break;
          first = nested;
        }
        if (
          ambiguousAdjacencyTypes.has(first.type) &&
          sameLine(node, previous, first)
        )
          return {
            kind: "too-complex",
            reason:
              first.type === "subshell"
                ? "`(…)` group directly follows a statement or word on the same line — bash rejects the line, but zsh reads the glued `(…)` as a glob-group word and expands what follows it"
                : "statement directly follows another statement on the same line — bash reads the text as one command (`!` and shell keywords are plain words after an assignment), not two statements",
            differential: true,
          };
      }
      previous = child;
    } else previous = null;
    const refusal = $5r(child);
    if (refusal) return refusal;
  }
  return null;
}
function Rct(text: string): string {
  let result = "",
    quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") index++;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    result += character;
  }
  return result;
}
const p7e = new RegExp(String.raw`[\x00-\x08\x0B-\x1F\x7F]`);
const ePt =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const XKt = /\\[ \t]/;
const D5r = /(?:^|[^ \t\\])(?:\\\\)*\\\n|[ \t](?:\\\\)+\\\n|\\[ \t]\\\n/;
const L5r = /(?:^|[^\\])(?:\\\\)*(?:[`$]|[<>=]\()/;
const DVo = /(?:^|[^\\])(?:\\\\)*['"]/;
const H5r = /~\[/;
const N5r = /(?:^|[\s;&|])=[a-zA-Z_]/;
const LVo = /<\d*-\d*>/;
/** Complete native text/AST consumers over one retained parser owner; no permission authority. */
export function createNativeBashCommandProjection(parser: NativeBashParser) {
  const V_ = () => parser;
  const D = unique;
  const U = count;
  function I8n(e: string): boolean {
    return XKt.test(e) || Y_n(e);
  }
  function Y_n(e: string): boolean {
    return (
      p7e.test(e) ||
      ePt.test(e) ||
      D5r.test(e) ||
      H5r.test(e) ||
      N5r.test(e) ||
      LVo.test(e)
    );
  }
  function _At(e: NativeBashSyntaxNode): boolean {
    return e.type === "ERROR" || e.children.some(_At);
  }
  var R = new Set(["program", "list", "pipeline"]),
    N = new Set([
      "&&",
      "||",
      "|",
      ";",
      "&",
      "|&",
      `
`,
    ]),
    sC = 1e4,
    X = 65536,
    G = 16,
    W = 128;
  function Sy(e: string): string[] {
    if (!e) return [];
    if (e.length > sC) return [e];
    let t = V_().parse(e);
    if (!t) return [e];
    let r: string[] = [],
      n = (i: NativeBashSyntaxNode): void => {
        if (N.has(i.type) || i.type === "comment") return;
        if (i.type === "redirected_statement") {
          for (let s of i.children) if (!s.type.endsWith("_redirect")) n(s);
          return;
        }
        if (R.has(i.type)) {
          for (let s of i.children) n(s);
          return;
        }
        r.push(i.text);
      };
    return (
      n(
        t.type === "ERROR" && t.children[0]?.type === "program"
          ? t.children[0]
          : t,
      ),
      r
    );
  }
  function E(e: NativeBashSyntaxNode): boolean {
    switch (e.type) {
      case "ERROR":
        return !0;
      case "heredoc_redirect":
        if (
          !e.children.some((t) => t.type === "heredoc_body") ||
          (T(e) && /(?:^|[^\\])(?:\\\\)*`/.test(e.text))
        )
          return !0;
        break;
      case "heredoc_start":
        if (e.text.includes("$")) return !0;
        break;
      case "subscript":
        if (/\$\((?!\([^()]*\)\))|`|\$\{[ \t\n|]|\[.*\[/s.test(e.text))
          return !0;
        return e.children.some((t) => t.type !== "word" && E(t));
      case "word":
        if (L5r.test(e.text)) return !0;
        break;
      case "regex":
      case "extglob_pattern":
        if (
          /(?:^|[^\\])(?:\\\\)*(?:`|\$\((?!\([^()]*\)\))|\$\{[ \t\n|]|[<>]\()/.test(
            e.text,
          )
        )
          return !0;
        break;
    }
    return e.children.some(E);
  }
  function qKs(e: NativeBashSyntaxNode): boolean {
    return E(e) || ozr(e, { unparsedBodyOverruns: !0 }) === null;
  }
  function KKs(e: string): boolean {
    if (e.length > sC) return !0;
    let t = V_().parse(e);
    if (t?.type !== "program") return !0;
    let r: NativeBashSyntaxNode | undefined = t;
    while (
      r !== void 0 &&
      (R.has(r.type) || r.type === "redirected_statement")
    ) {
      let n = r.children.findLastIndex(
        (i) =>
          !N.has(i.type) &&
          i.type !== "comment" &&
          !i.type.endsWith("_redirect"),
      );
      if (r.type === "list" && r.children[n - 1]?.type === "&&") return !0;
      r = r.children[n];
    }
    return !1;
  }
  function yAt(e: string): string[] {
    if (!e || e.length > sC) return [];
    let t = V_().parse(e);
    return t ? r2o(t) : [];
  }
  function r2o(e: NativeBashSyntaxNode): string[] {
    return ozr(e) ?? [];
  }
  function ozr(
    e: NativeBashSyntaxNode,
    {
      unparsedBodyOverruns: t = false,
    }: { unparsedBodyOverruns?: boolean } = {},
  ): string[] | null {
    let r: string[] = [],
      n = X,
      i = G,
      s = { first: [], second: [] },
      o = !1,
      u = (l: NativeBashSyntaxNode): void => {
        if (o) return;
        if (l.type === "command") {
          r.push(l.text);
          n -= l.text.length;
        }
        let f = a2o(l);
        if (f !== null) {
          i -= 1;
          n -= f.length;
        }
        if (n < 0 || i < 0) {
          o = !0;
          return;
        }
        if (f !== null) {
          let a = V_()?.parse(f);
          if (a) u(a);
          else if (t) o = !0;
          return;
        }
        i2o(l, s);
        for (let a of l.children) u(a);
      };
    if ((u(e), o)) return null;
    for (let { bodyRoot: l } of o2o(s)) {
      if (l) u(l);
      if (o) break;
    }
    return r;
  }
  function* o2o(
    e: BodyQueue,
  ): Generator<NativeBashBodyAlternative, void, unknown> {
    for (let t = 0; t < W; t += 1) {
      let r = e.first.shift() ?? e.second.shift();
      if (r === void 0) return;
      yield { body: r, bodyRoot: V_()?.parse(r) ?? null };
    }
  }
  function v(e: NativeBashSyntaxNode, t: boolean, r: BacktickBody[]): void {
    if (e.type === "backtick_escape_unsupported")
      r.push({ body: e, quoted: t });
    let n =
      e.type === "string" ||
      (t && e.type === "command_substitution" && e.children[0]?.type === "`");
    for (let i of e.children) v(i, n, r);
  }
  function Y(e: string, t: BacktickBody[], r: string): string {
    let n = Buffer.from(e),
      i = "",
      s = 0;
    for (let { body: o, quoted: u } of t) {
      i += n.toString("utf8", s, o.startIndex) + P(o.text, u ? r : "%");
      s = o.endIndex;
    }
    return i + n.toString("utf8", s);
  }
  function YKs(
    e: string,
    t: NativeBashSyntaxNode,
  ): NativeBashLineAlternative[] {
    let r: BacktickBody[] = [];
    if (
      (v(t, !1, r),
      r.length === 0 || r.some(({ body: n }) => /\\[`$\\]/.test(n.text)))
    )
      return [];
    return D(['"', "%"].map((n) => Y(e, r, n))).map((n) => ({
      line: n,
      lineRoot: V_()?.parse(n) ?? null,
    }));
  }
  function s2o(
    e: NativeBashSyntaxNode,
    t: { parsesLeft: number } = { parsesLeft: W },
  ): boolean {
    let r = t.parsesLeft > 0 ? I(e) : [];
    t.parsesLeft -= r.length;
    let n = r.flatMap((i) => V_()?.parse(i) ?? []);
    return (
      (r.length > 0 &&
        !/\\[`$\\]/.test(e.text) &&
        U(n, (i) => i.type === "ERROR") === r.length) ||
      [...e.children, ...n].some((i) => s2o(i, t))
    );
  }
  function i2o(e: NativeBashSyntaxNode, t: BodyQueue): void {
    let [r, n] = I(e);
    if (r !== void 0) t.first.push(r);
    if (n !== void 0) t.second.push(n);
  }
  function I(e: NativeBashSyntaxNode): string[] {
    if (e.type !== "backtick_escape_unsupported") return [];
    return D(['\\"', '"'].map((t) => P(e.text, t)));
  }
  function P(e: string, t: string): string {
    return e.replace(/\\([`$\\\n"])/g, (r: string, n: string) =>
      n ===
      `
`
        ? ""
        : n === '"'
          ? t
          : n,
    );
  }
  function a2o(e: NativeBashSyntaxNode): string | null {
    if (e.type !== "expansion" && e.type !== "ERROR") return null;
    let t = e.text;
    if (!/^\$\{[ \t\n|]/.test(t)) return null;
    let r = t.endsWith("}") ? t.length - 1 : t.length;
    return t.slice(2, r).trim().replace(/^\|/, "").replace(/;$/, "").trim();
  }
  function M8n(e: string): string[] | null {
    if (!e || e.length > sC) return null;
    let t = V_().parse(e);
    if (!t) return null;
    return F(t);
  }
  function l2o(e: string): string[] | null {
    if (!e || e.length > sC) return null;
    let t = V_().parse(e);
    if (!t) return null;
    if (_At(t) || $5r(t) !== null || H(t) || q(t) || d2o(e)) return null;
    if (e.includes("`")) return null;
    let r = F(t);
    if (r === null) return null;
    return r.some(j) ? null : r;
  }
  var B = /(?<!\$)\{|(?<=[$\\]\$)\{|\$'|\$"/,
    M = /[;&|<>\n]/,
    Z = /(?:^|[ \t])[-/]/,
    K = /[()]/;
  function z(e: string): boolean {
    let t = e.search(/(?<!\$)\{|(?<=[$\\]\$)\{/);
    return t === -1 || /['"\\]/.test(e.slice(t));
  }
  function j(e: string): boolean {
    if (B.test(e) && C(e)) return !0;
    let t = Rct(e),
      r = e.replace(/['"\\]/g, "");
    if (B.test(t) && (M.test(t) || K.test(t) || (Z.test(r) && z(e)))) return !0;
    return J.test(e) || V(e);
  }
  var J = /\$\(|`|<\(|>\(|\$\[|\$\{[ \t\n|]/;
  function V(e: string): boolean {
    let t;
    for (let r = 0; r < e.length; r++) {
      let n = e[r];
      if (t !== void 0) {
        if (t === '"' && n === "\\") r++;
        else if (n === t) t = void 0;
        continue;
      }
      if (n === "\\") {
        r++;
        continue;
      }
      if (n === "'" || n === '"') {
        t = n;
        continue;
      }
      if (n === "$" && e[r + 1] === '"') return !0;
    }
    return !1;
  }
  var ee = new Set(["file_descriptor", "number", ">&", "<&"]);
  function q(e: NativeBashSyntaxNode): boolean {
    if (e.type.endsWith("_redirect")) {
      if (!te(e)) return !0;
    }
    return e.children.some(q);
  }
  function te(e: NativeBashSyntaxNode): boolean {
    let t = e.children.map((n) => n.type);
    if (!(
      (t.length === 2 && t[0] !== "file_descriptor") ||
      (t.length === 3 && t[0] === "file_descriptor")
    ))
      return !1;
    return e.children.every((n) => {
      if (!ee.has(n.type) || n.children.length !== 0) return !1;
      return n.type === "number" || n.type === "file_descriptor"
        ? /^\d+$/.test(n.text)
        : !0;
    });
  }
  function F(e: NativeBashSyntaxNode): string[] | null {
    let t: string[] = [],
      r = !0,
      n = (i: NativeBashSyntaxNode): void => {
        if (!r) return;
        if (N.has(i.type) || i.type === "comment") return;
        if (i.type === "redirected_statement") {
          for (let s of i.children) {
            if (s.type.endsWith("_redirect")) {
              if (S(s)) {
                r = !1;
                return;
              }
              continue;
            }
            n(s);
          }
          return;
        }
        if (R.has(i.type)) {
          for (let s of i.children) n(s);
          return;
        }
        if (i.type === "negated_command") {
          for (let s of i.children) if (s.type !== "!") n(s);
          return;
        }
        if (i.type === "command" || i.type === "variable_assignment") {
          if (S(i)) {
            r = !1;
            return;
          }
          t.push(i.text);
          return;
        }
        r = !1;
      };
    return (n(e), r ? t : null);
  }
  function S(e: NativeBashSyntaxNode): boolean {
    let t = e.type === "command" || e.type === "variable_assignment";
    for (let r of e.children) {
      if (r.type === "subshell" && t) return !0;
      if (S(r)) return !0;
    }
    return !1;
  }
  function d2o(e: string): boolean {
    if (!e) return !1;
    if (e.length > sC) return !0;
    let t = V_()?.parse(e);
    if (!t) return !0;
    let r = !1,
      n = (i: NativeBashSyntaxNode): void => {
        if (r) return;
        if (i.type === "expansion" && i.text.includes("(")) {
          r = !0;
          return;
        }
        for (let s of i.children) n(s);
      };
    return (n(t), r);
  }
  function iC(e: string): string[] {
    if (!e || e.length > sC) return [];
    let t = V_().parse(e);
    if (!t) return [];
    let r = cLe(t, null);
    if (!r) return [];
    return Zxt(r);
  }
  var b = new Set([
    "command_substitution",
    "process_substitution",
    "expansion",
    "simple_expansion",
    "arithmetic_expansion",
  ]);
  function A(e: NativeBashSyntaxNode): boolean {
    if (b.has(e.type)) return !0;
    return e.children.some(A);
  }
  var re = new Set([
    "command_substitution",
    "process_substitution",
    "arithmetic_expansion",
    "subshell",
  ]);
  function H(e: NativeBashSyntaxNode): boolean {
    if (re.has(e.type)) return !0;
    return e.children.some(H);
  }
  var ne = new Set(["ansi_c_string", "translated_string"]);
  function O(e: NativeBashSyntaxNode): boolean {
    if (ne.has(e.type)) return !0;
    return e.children.some(O);
  }
  var Q = new Set([
    "<",
    ">",
    ">>",
    "<<",
    "<<-",
    "<<<",
    "<&",
    ">&",
    "&>",
    "&>>",
    ">|",
    ">&-",
    "<&-",
    "file_descriptor",
    "heredoc_start",
    "heredoc_body",
    "heredoc_content",
    "heredoc_end",
  ]);
  function w(e: NativeBashSyntaxNode): boolean {
    if (e.type.endsWith("_redirect")) {
      let t = e.children.filter((s) => !Q.has(s.type)),
        r = e.children.some((s) => s.type === ">&-" || s.type === "<&-"),
        n =
          !r &&
          e.children.some((s) => s.type === ">&" || s.type === "<&") &&
          t.some((s) => g(s).startsWith("-")),
        i = e.type === "heredoc_redirect" || r || n ? 0 : 1;
      if (t.length > i) return !0;
    }
    return e.children.some(w);
  }
  function T(e: NativeBashSyntaxNode): boolean {
    if (e.type === "heredoc_redirect") {
      let r = e.children.find((i) => i.type === "heredoc_start")?.text ?? "";
      if (
        !(
          r.length >= 2 &&
          ((r.startsWith("'") && r.endsWith("'")) ||
            (r.startsWith('"') && r.endsWith('"')))
        ) ||
        r.includes("\\")
      )
        return !0;
    }
    return e.children.some(T);
  }
  function XKs(e: string, t: (command: string) => boolean): boolean {
    if (!e) return !1;
    if (e.length > sC || I8n(e)) return !0;
    let r = V_().parse(e);
    if (!r || _At(r)) return !0;
    let n = (o: NativeBashSyntaxNode): boolean =>
        w(o) ||
        T(o) ||
        A(o) ||
        O(o) ||
        (o.type !== "heredoc_redirect" && C(o.text)) ||
        (o.type !== "heredoc_redirect" &&
          !o.children.every((u) => Q.has(u.type) || L(u, /\s/.test(u.text)))) ||
        (o.type !== "heredoc_redirect" &&
          o.children.some((u) => u.type === "word" && u.text.startsWith("="))),
      i = (o: NativeBashSyntaxNode): NativeBashSyntaxNode | undefined => {
        if (b.has(o.type)) return;
        if (o.type === "command") return o;
        let u;
        for (let l of o.children) {
          if (l.type.endsWith("_redirect")) continue;
          let f = i(l);
          if (f) u = f;
        }
        return u;
      },
      s = (o: NativeBashSyntaxNode): boolean => {
        if (b.has(o.type)) return !1;
        if (o.type === "redirected_statement") {
          let u = o.children.find((f) => f.type === "command") ?? i(o),
            l = u ? t(u.text) : !0;
          for (let f of o.children)
            if (f.type.endsWith("_redirect")) {
              if (l && n(f)) return !0;
            } else if (s(f)) return !0;
          return !1;
        }
        if (o.type === "command") {
          let u = t(o.text);
          for (let l of o.children)
            if (l.type.endsWith("_redirect")) {
              if (u && n(l)) return !0;
            } else if (s(l)) return !0;
          return !1;
        }
        if (o.type.endsWith("_redirect")) return n(o);
        return o.children.some(s);
      };
    return s(r);
  }
  var ie = new Set(["word", "string", "raw_string", "number"]),
    se = /(?:^|[^\\])(?:\\\\)*[;|&<>]/,
    oe = /(?:^|[^\\])(?:\\\\)*\\$/;
  function L(e: NativeBashSyntaxNode, t = false): boolean {
    if (e.type === "concatenation") return e.children.every((r) => L(r, t));
    if (e.type === "word") {
      if (L5r.test(e.text)) return !1;
      if (se.test(e.text) || oe.test(e.text)) return !1;
      if (t && DVo.test(e.text)) return !1;
      return !0;
    }
    if (e.type === "string" || e.type === "raw_string") {
      let r = e.type === "raw_string" ? "'" : '"';
      return e.text.length >= 2 && e.text.startsWith(r) && e.text.endsWith(r);
    }
    return ie.has(e.type);
  }
  function C(e: string): boolean {
    let t = null,
      r = !1,
      n = !1;
    for (let i = 0; i < e.length; i++) {
      let s = e[i];
      if (t === "'") {
        if (s === "'") t = null;
        continue;
      }
      if (t === '"') {
        if (
          s === "\\" &&
          i + 1 < e.length &&
          '$`"\\'.includes(required(e[i + 1]))
        ) {
          i++;
          continue;
        }
        if (s === "`") return !0;
        if (s === "$" && /[A-Za-z0-9_{(@*#?$!-]/.test(e[i + 1] ?? ""))
          return !0;
        if (s === '"') t = null;
        continue;
      }
      if (s === "\\") {
        i++;
        continue;
      }
      if (s === "`") return !0;
      if (s === "$" && (e[i + 1] === "'" || e[i + 1] === '"')) return !0;
      if (s === "$" && /[A-Za-z0-9_{(@*#?$!-]/.test(e[i + 1] ?? "")) return !0;
      if (s === "=" && e[i + 1] === "(") return !0;
      if (s === "*" || s === "?" || s === "[") return !0;
      if (s === "'" || s === '"') {
        t = s;
        continue;
      }
      if (
        s ===
        `
`
      )
        return !1;
      if (s === " " || s === "\t") {
        {
          r = !1;
          n = !1;
        }
        continue;
      }
      if (s === "{") {
        r = !0;
        continue;
      }
      if (r && (s === "," || (s === "." && e[i + 1] === "."))) {
        n = !0;
        continue;
      }
      if (s === "}" && r && n) return !0;
    }
    return t !== null;
  }
  function JKs(e: string): boolean {
    if (!e || e.length > sC) return !0;
    if (I8n(e)) return !0;
    if (C(e)) return !0;
    let t = V_().parse(e);
    if (!t || _At(t)) return !0;
    let r = t.children.filter((i) => i.type !== "comment");
    if (
      r.length !== 1 ||
      (required(r[0]).type !== "command" &&
        !(
          required(r[0]).type === "redirected_statement" &&
          required(r[0]).children.some((i) => i.type === "command")
        ))
    )
      return !0;
    if (A(t) || O(t) || w(t) || T(t)) return !0;
    let n = cLe(t, null);
    if (!n) return !0;
    for (let i of n.children) {
      if (i.type === "command_name" || i.type === "variable_assignment")
        continue;
      if (i.type.endsWith("_redirect")) continue;
      if (!L(i, /\s/.test(i.text))) return !0;
    }
    return !1;
  }
  function g(e: NativeBashSyntaxNode): string {
    switch (e.type) {
      case "raw_string":
        return e.text.slice(1, -1);
      case "string":
        return e.text
          .slice(1, -1)
          .replace(/\\([$`"\\\n])/g, (t: string, r: string) =>
            r ===
            `
`
              ? ""
              : r,
          );
      case "word":
        return e.text.replace(/\\([\s\S])/g, (t: string, r: string) =>
          r ===
          `
`
            ? ""
            : r,
        );
      default:
        return e.text;
    }
  }
  function KX(e: string, t?: number): NativeBashRedirectionProjection {
    let r: NativeBashRedirectionProjection = {
      commandWithoutRedirections: e,
      redirections: [],
      hasDangerousRedirection: !1,
      dangerousRedirectionReason: void 0,
    };
    if (!e || e.length > sC) return r;
    let n = V_().parse(e, t);
    if (!n) return r;
    let i: NativeBashRedirection[] = [],
      s = !1,
      o: NativeBashRedirectionProjection["dangerousRedirectionReason"],
      u = (a: NativeBashSyntaxNode): void => {
        if (a.type === "file_redirect") {
          let p: ">" | ">>" | null = null,
            m = !1,
            d = null,
            k = 0;
          for (let c of a.children)
            if (c.type === ">" || c.type === "&>" || c.type === ">|") p = ">";
            else if (c.type === ">>" || c.type === "&>>" || c.type === ">>|")
              p = ">>";
            else if (c.type === ">&") {
              p = ">";
              m = !0;
            } else if (c.type === "<&") {
              let y = a.children.filter(
                (h) => h !== c && h.type !== "file_descriptor",
              );
              if (y.length > 1 || y.some((h) => g(h).startsWith("-"))) {
                if (((s = !0), o !== "network_device")) o = "shell_expansion";
              }
              return;
            } else if (c.type === ">&-" || c.type === "<&-") {
              if (
                a.children.filter(
                  (h) => h !== c && h.type !== "file_descriptor",
                ).length > 0
              ) {
                if (((s = !0), o !== "network_device")) o = "shell_expansion";
              }
              return;
            } else if (c.type === "<") {
              let y = a.children.filter(
                (x) => x !== c && x.type !== "file_descriptor",
              );
              if (y.length > 1) {
                if (((s = !0), o !== "network_device")) o = "shell_expansion";
                return;
              }
              let h = y[0];
              if (h) {
                let x = g(h);
                if (/^\/dev\/(tcp|udp)\//.test(x)) {
                  s = !0;
                  o = "network_device";
                }
              }
              return;
            } else if (c.type !== "file_descriptor") {
              d = c;
              k++;
            }
          if (!p || !d) return;
          if (k > 1) {
            if (((s = !0), o !== "network_device")) o = "shell_expansion";
            return;
          }
          if (m && g(d).startsWith("-")) {
            if (((s = !0), o !== "network_device")) o = "shell_expansion";
            return;
          }
          if (d.type === "number" && d.children.length === 0 && m) return;
          if (!(
            (d.type === "word" && d.children.length === 0) ||
            (d.type === "number" && d.children.length === 0) ||
            d.type === "raw_string" ||
            (d.type === "string" &&
              !d.children.some(
                (c) => c.type !== "string_content" && c.type !== '"',
              ))
          )) {
            if (((s = !0), o !== "network_device")) o = "shell_expansion";
            return;
          }
          let _ = g(d);
          if (/^~|[*?[]/.test(_)) {
            if (((s = !0), o !== "network_device")) o = "shell_expansion";
            return;
          }
          if (_.startsWith("!") || _.startsWith("=")) {
            if (((s = !0), o !== "network_device")) o = "shell_expansion";
            return;
          }
          if (m && !/^[A-Za-z0-9./_-]+$/.test(_)) {
            if (((s = !0), o !== "network_device")) o = "shell_expansion";
            return;
          }
          if (/^\/dev\/(tcp|udp)\//.test(_)) {
            {
              s = !0;
              o = "network_device";
            }
            return;
          }
          i.push({ target: _, operator: p });
          return;
        }
        for (let p of a.children) u(p);
      };
    u(n);
    let l: string[] = [],
      f = (a: NativeBashSyntaxNode): void => {
        if (a.type === "comment") return;
        if (a.type === "redirected_statement") {
          for (let p of a.children) if (!p.type.endsWith("_redirect")) f(p);
          return;
        }
        if (R.has(a.type)) {
          for (let p of a.children) f(p);
          return;
        }
        l.push(a.text);
      };
    return (
      f(
        n.type === "ERROR" && n.children[0]?.type === "program"
          ? n.children[0]
          : n,
      ),
      {
        commandWithoutRedirections: l.length > 0 ? l.join(" ") : e,
        redirections: i,
        hasDangerousRedirection: s,
        dangerousRedirectionReason: o,
      }
    );
  }

  return {
    parser,
    containsParsingDifferences: I8n,
    containsUnsupportedSpelling: Y_n,
    hasErrorNode: _At,
    maxCommandCharacters: sC,
    splitCommands: Sy,
    hasUnparsedBodies: qKs,
    tailAfterAnd: KKs,
    nestedCommandTexts: yAt,
    nestedTextsFromTree: r2o,
    collectNestedTexts: ozr,
    readBodyAlternatives: o2o,
    alternateLines: YKs,
    hasErroredAlternatives: s2o,
    enqueueBodyAlternatives: i2o,
    extractInlineShellBody: a2o,
    flattenCommandTexts: M8n,
    strictLiteralCommandTexts: l2o,
    hasParenthesizedExpansion: d2o,
    staticArgv: iC,
    redirectsNeedReview: XKs,
    requiresComplexRead: JKs,
    redirections: KX,
    findStaticCommand: cLe,
    projectStaticArgv: Zxt,
    adjacentStatementRefusal: $5r,
  };
}
export type NativeBashCommandProjection = ReturnType<
  typeof createNativeBashCommandProjection
>;
