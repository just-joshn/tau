import type { NativeBashSemantics } from "../native-bash-semantics.js";
import type { NativeBashSyntaxNode as Node } from "../native-bash-parser.js";
import { NativeBashSecurityUnsupported } from "./security-types.js";
interface Span {
  startIndex: number;
  endIndex: number;
}
interface CompoundStructure {
  hasCompoundOperators: boolean;
  hasPipeline: boolean;
  hasSubshell: boolean;
  hasCommandGroup: boolean;
  operators: string[];
  segments: string[];
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native shell-document invariant");
  return value;
}
export function createNativeBashSecurityShellDocument(
  semantic: NativeBashSemantics,
) {
  const features = semantic.parser.features;
  const FMt = () => features.keywordGuardOff();
  const I_i = () => features.dollarOperandGuardOff();
  const P_i = () => features.arithmeticGuardOff();
  const Ero = () => features.alternateArithmeticRead();
  const Hwn = (asked: number, input: string) =>
    semantic.parser.featureAnswers(asked, input);
  const iZo = <T>(run: () => T | Promise<T>) => features.observeMayDiffer(run);
  const TXt = <T>(off: boolean, run: () => T | Promise<T>) =>
    features.observeKeywordGuard(off, run);
  const nxn = () => features.markKeywordDesynchronization();
  const kro = () => features.markMayDiffer();
  const qAr = new Set([
    "program",
    "list",
    "pipeline",
    "redirected_statement",
    "negated_command",
    "declaration_command",
    "unset_command",
    "command",
    "file_redirect",
  ]);
  function hOe(e: Node, n: (node: Node) => void): void {
    n(e);
    for (let r of e.children) hOe(r, n);
  }

  function GAr(e: Node): [number, number][] {
    let n: [number, number][] = [];
    return (
      hOe(e, (r) => {
        if (r.type === "pipeline") {
          for (let a of r.children)
            if (a.type === "|" || a.type === "|&")
              n.push([a.startIndex, a.endIndex]);
        }
      }),
      n.sort((r, a) => r[0] - a[0])
    );
  }

  function zAr(e: Node): Span[] {
    let n: Span[] = [];
    return (
      hOe(e, (r) => {
        if (r.type === "file_redirect") {
          let a = r.children,
            h = a.findIndex((E) => E.type === ">" || E.type === ">>"),
            y = a[h],
            k = h >= 0 ? a[h + 1] : void 0;
          if (y && k)
            n.push({ startIndex: r.startIndex, endIndex: k.endIndex });
        }
      }),
      n
    );
  }

  function KAr(e: Node): Span[] {
    let n: Span[] = [];
    return (
      hOe(e, (r) => {
        if (qAr.has(r.type)) {
          let a = r.children.toSorted((h, y) => h.endIndex - y.endIndex);
          a.slice(1).forEach((h, y) => {
            n.push({
              startIndex: required(a[y]).endIndex,
              endIndex: h.startIndex,
            });
          });
        }
      }),
      n
    );
  }

  function W_n(e: Node, n: string): CompoundStructure {
    let r = e,
      a: string[] = [],
      h: string[] = [],
      y = !1,
      k = !1,
      E = !1,
      N = new Set([
        "if_statement",
        "while_statement",
        "for_statement",
        "c_style_for_statement",
        "case_statement",
        "function_definition",
        "do_group",
        "elif_clause",
        "else_clause",
      ]);
    function V(oe: Node): void {
      for (let re of oe.children) {
        if (!re) continue;
        if (re.type === "list")
          for (let _e of re.children) {
            if (!_e) continue;
            if (_e.type === "&&" || _e.type === "||") a.push(_e.type);
            else if (
              _e.type === "list" ||
              _e.type === "redirected_statement" ||
              _e.type === "pipeline" ||
              _e.type === "negated_command" ||
              N.has(_e.type)
            )
              V({ ...oe, children: [_e] });
            else if (_e.type === "subshell") {
              y = !0;
              h.push(_e.text);
            } else if (_e.type === "compound_statement") {
              k = !0;
              h.push(_e.text);
            } else h.push(_e.text);
          }
        else if (re.type === ";") a.push(";");
        else if (re.type === "pipeline") {
          E = !0;
          h.push(re.text);
          V(re);
        } else if (re.type === "subshell") {
          y = !0;
          h.push(re.text);
        } else if (re.type === "compound_statement") {
          k = !0;
          h.push(re.text);
        } else if (
          re.type === "command" ||
          re.type === "declaration_command" ||
          re.type === "variable_assignment"
        )
          h.push(re.text);
        else if (re.type === "redirected_statement") {
          let _e = !1;
          for (let ke of re.children) {
            if (!ke || ke.type === "file_redirect") continue;
            {
              _e = !0;
              V({ ...re, children: [ke] });
            }
          }
          if (!_e) h.push(re.text);
        } else if (re.type === "negated_command") {
          h.push(re.text);
          V(re);
        } else if (N.has(re.type)) {
          if (
            re.type !== "do_group" &&
            re.type !== "elif_clause" &&
            re.type !== "else_clause"
          )
            h.push(re.text);
          V(re);
        } else if (re.children.length > 0) V(re);
      }
    }
    if ((V(r), h.length === 0)) h.push(n);
    return {
      hasCompoundOperators: a.length > 0,
      hasPipeline: E,
      hasSubshell: y,
      hasCommandGroup: k,
      operators: a,
      segments: h,
    };
  }

  function q_n(e: Node): boolean {
    return e.children.some(
      (n) =>
        (e.type === "pipeline" && n.type.startsWith("variable_assignment")) ||
        q_n(n),
    );
  }

  function $de(e: string, n: Node): K_n {
    let r = GAr(n),
      a = zAr(n),
      h = W_n(n, e);
    return new K_n(e, r, a, KAr(n), h, q_n(n));
  }

  class K_n {
    originalCommand: string;
    commandBytes: Buffer;
    pipePositions: [number, number][];
    redirectionNodes: Span[];
    gaps: Span[];
    compoundStructure: CompoundStructure;
    hasAssignmentStage: boolean;
    constructor(
      e: string,
      n: [number, number][],
      r: Span[],
      a: Span[],
      h: CompoundStructure,
      y: boolean,
    ) {
      {
        this.originalCommand = e;
        this.commandBytes = Buffer.from(e, "utf8");
        this.pipePositions = n;
        this.redirectionNodes = r;
        this.gaps = a;
        this.compoundStructure = h;
        this.hasAssignmentStage = y;
      }
    }
    toString() {
      return this.originalCommand;
    }
    getPipeSegments() {
      if (this.pipePositions.length === 0) return [this.originalCommand];
      let e = [],
        n = 0;
      for (let [a, h] of this.pipePositions) {
        let y = this.commandBytes.subarray(n, a).toString("utf8").trim();
        if (y) e.push(y);
        n = h;
      }
      let r = this.commandBytes.subarray(n).toString("utf8").trim();
      if (r) e.push(r);
      return e;
    }
    withoutOutputRedirections() {
      if (this.redirectionNodes.length === 0) return this.originalCommand;
      let e = (k: number, E: number) =>
          this.commandBytes.subarray(k, E).toString("utf8"),
        n = [
          ...this.redirectionNodes.map((k) => ({ ...k, text: "" })),
          ...this.gaps
            .map((k) => ({ ...k, text: e(k.startIndex, k.endIndex) }))
            .filter(({ text: k }) => /^[ \t\n]+$/.test(k)),
        ].sort((k, E) => k.startIndex - E.startIndex),
        r = "",
        a = "",
        h = 0,
        y = (k: number) => {
          if (k > h) {
            r +=
              a.replace(/[ \t]+/g, " ").replace(
                / ?\n ?/g,
                `
`,
              ) + e(h, k);
            a = "";
          }
        };
      for (let { startIndex: k, endIndex: E, text: N } of n)
        if (k >= h) {
          y(k);
          a += N;
          h = E;
        }
      return (y(this.commandBytes.length), r.trim());
    }
  }

  async function G_n(e: string): Promise<K_n | null> {
    if (!e) return null;
    try {
      const r = await semantic.parseCommand(e);
      if (r) return $de(e, r.rootNode);
    } catch (error) {
      if (error instanceof NativeBashSecurityUnsupported) throw error;
    }
    return null;
  }
  class V_n {
    lastCommand: string | undefined;
    lastSwitches = 0;
    lastResult:
      | Promise<{
          result: { result: K_n | null; fired: boolean };
          mayDiffer: boolean;
        }>
      | undefined;
    async parse(e: string): Promise<K_n | null> {
      if (FMt() || I_i() || P_i() || Ero()) return G_n(e);
      let n = Hwn(-1, e);
      if (
        e !== this.lastCommand ||
        n !== this.lastSwitches ||
        this.lastResult === void 0
      ) {
        this.lastCommand = e;
        this.lastSwitches = n;
        void (this.lastResult = iZo(() => TXt(!1, () => G_n(e))));
      }
      let {
        result: { result: r, fired: a },
        mayDiffer: h,
      } = await this.lastResult;
      if (a) nxn();
      if (h) kro();
      return r;
    }
  }

  const owner = new V_n();
  return {
    parse: (input: string) => owner.parse(input),
    fromTree: $de,
    native: { GAr, zAr, KAr, W_n, q_n, hOe },
  };
}
