import type { NativeBashSecurityRule as Rule } from "./security-types.js";
export type NativeBashTextRule =
  | { type: "prefix"; prefix: string }
  | { type: "wildcard"; pattern: string }
  | { type: "exact"; command: string };
interface TextPart {
  text: string;
  atWordStart: boolean;
  atWordEnd: boolean;
}
/** Native deny/ask text-search fallback only; never creates an AST or an allow certificate. */
function DVe(e: string): string | null {
  return e.match(/^(.+):\*$/)?.[1] ?? null;
}

function wwi(e: string): boolean {
  if (e.endsWith(":*")) return !1;
  for (let n = 0; n < e.length; n++)
    if (e[n] === "*") {
      let r = 0,
        a = n - 1;
      while (a >= 0 && e[a] === "\\") {
        r++;
        a--;
      }
      if (r % 2 === 0) return !0;
    }
  return !1;
}

function mZe(e: string): NativeBashTextRule {
  let n = DVe(e);
  if (n !== null) return { type: "prefix", prefix: n };
  if (wwi(e)) return { type: "wildcard", pattern: e };
  return { type: "exact", command: e };
}

function xl(e: string): string {
  return e.replace(/['"\\]/g, "");
}

function jh(e: string): string {
  let n = e.indexOf("$'");
  if (n === -1) return e;
  return (
    e.slice(0, n) +
    e
      .slice(n)
      .replaceAll("$'", "'")
      .replace(
        /\\(?:x\{([0-9a-fA-F]+)\}?|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/g,
        (
          r: string,
          a: string | undefined,
          l: string | undefined,
          d: string | undefined,
          p: string | undefined,
          g: string | undefined,
        ) => {
          let f =
            g !== void 0
              ? parseInt(g, 8) & 255
              : parseInt(a?.slice(-2) ?? l ?? d ?? p ?? "", 16);
          return f <= 1114111 ? String.fromCodePoint(f) : r;
        },
      )
  );
}

function zh(e: NativeBashTextRule): TextPart[] {
  let n =
    e.type === "wildcard"
      ? (e.pattern.trim().match(/(?:\\[*\\]|[^*])+|\*/g) ?? [])
      : [e.type === "prefix" ? e.prefix : e.command];
  return n.flatMap((r, a) =>
    r === "*"
      ? []
      : {
          text: r.replace(/\\([*\\])/g, "$1").trim(),
          atWordStart: a === 0 || /^[ \t]/.test(r),
          atWordEnd: a === n.length - 1 || /[ \t]$/.test(r),
        },
  );
}

function Hh(e: TextPart[], n: string): boolean {
  let r = 0;
  for (let { text: a, atWordStart: l, atWordEnd: d } of e) {
    let p = n.indexOf(a, r);
    while (
      p !== -1 &&
      ((l &&
        /(?:\w|(?:^|[^& ]|(?:^|[^&]) )-)$/.test(
          n.slice(Math.max(0, p - 3), p),
        )) ||
        (d && /[\w-]/.test(n[p + a.length] ?? "")))
    )
      p = n.indexOf(a, p + 1);
    if (p === -1) return !1;
    r = p + a.length;
  }
  return e.length > 0;
}

function f9a(e: string): (rule: NativeBashTextRule) => boolean {
  let n = [(r: string) => r, xl, (r: string) => xl(jh(r))]
    .map((r) => (a: string) => r(a).replace(/[ \t]+/g, " "))
    .map((r) => ({ form: r, texts: [e, e.replaceAll("\\\n", "")].map(r) }));
  return (r) => {
    let a = zh(r);
    if (!a.some((l) => /[\p{L}\p{N}]/u.test(l.text))) return !1;
    return n.some(({ form: l, texts: d }) => {
      let p = a
        .map((g) => ({ ...g, text: l(g.text) }))
        .filter((g) => g.text !== "");
      return d.some((g) => Hh(p, g));
    });
  };
}

export const nativeBashTextRuleSearch = f9a;
export const classifyNativeBashTextRule = mZe;
export function findNativeBashTextRule(
  search: (rule: NativeBashTextRule) => boolean,
  rules: readonly Rule[],
): Rule | undefined {
  return rules.find(
    ({ ruleValue: { ruleContent } }) =>
      ruleContent !== undefined &&
      !ruleContent.startsWith("certified: ") &&
      search(mZe(ruleContent)),
  );
}
