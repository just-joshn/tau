/**
 * HTML to markdown for WebFetch, after the original's turndown defaults (setext h1/h2,
 * `*` bullets, indented code, `_`/`**` emphasis) with style/script/noscript/iframe removed.
 * Parsing uses Bun's HTMLRewriter; this is a reduced rule set, not turndown itself.
 */
interface Frame {
  tag: string;
  attributes: Map<string, string>;
  parts: string[];
}
const removed = new Set(["style", "script", "noscript", "iframe", "head"]);
const blocks = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "table",
  "tr",
  "form",
  "figure",
  "dl",
  "dt",
  "dd",
]);
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (match, name: string) => {
      const code =
        name[0] !== "#"
          ? undefined
          : name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
      if (code !== undefined)
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      return entities[name.toLowerCase()] ?? match;
    },
  );
}
/** Turndown's default escapes for text that would otherwise read as markdown. */
function escape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/^-/gm, "\\-")
    .replace(/^\+ /gm, "\\+ ")
    .replace(/^(=+)/gm, "\\$1")
    .replace(/^(#{1,6}) /gm, "\\$1 ")
    .replace(/`/g, "\\`")
    .replace(/^~~~/gm, "\\~~~")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/^>/gm, "\\>")
    .replace(/_/g, "\\_")
    .replace(/^(\d+)\. /gm, "$1\\. ");
}
const BREAK = "\ue000br\n";
const indent = (text: string, prefix: string) =>
  text.replace(/\n(?=.)/g, "\n" + prefix);

function render(frame: Frame, parent: Frame | undefined): string {
  const inner = frame.parts.join("");
  const attr = (name: string) => frame.attributes.get(name) ?? "";
  switch (frame.tag) {
    case "h1":
    case "h2": {
      const text = inner.trim();
      if (!text) return "";
      return `\n\n${text}\n${(frame.tag === "h1" ? "=" : "-").repeat(text.length)}\n\n`;
    }
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return inner.trim()
        ? `\n\n${"#".repeat(Number(frame.tag[1]))} ${inner.trim()}\n\n`
        : "";
    case "br":
      return BREAK;
    case "hr":
      return "\n\n* * *\n\n";
    case "img":
      return attr("src") ? `![${attr("alt")}](${attr("src")})` : "";
    case "a": {
      const href = attr("href");
      return href && inner.trim()
        ? `[${inner.trim()}](${href}${attr("title") ? ` "${attr("title")}"` : ""})`
        : inner;
    }
    case "strong":
    case "b":
      return inner.trim() ? `**${inner}**` : "";
    case "em":
    case "i":
      return inner.trim() ? `_${inner}_` : "";
    case "code":
      return parent?.tag === "pre" || !inner ? inner : `\`${inner}\``;
    case "pre":
      return `\n\n    ${inner.replace(/\n$/, "").replace(/\n/g, "\n    ")}\n\n`;
    case "blockquote":
      return `\n\n${inner
        .trim()
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^/gm, "> ")}\n\n`;
    case "ul":
    case "ol":
      return `\n\n${inner.replace(/^\n+|\n+$/g, "")}\n\n`;
    case "li": {
      const ordered = parent?.tag === "ol";
      const items = Number(parent?.attributes.get("tau-items") ?? 0);
      parent?.attributes.set("tau-items", String(items + 1));
      const index = Number(parent?.attributes.get("start") || 1) + items;
      const prefix = ordered ? `${index}.  ` : "*   ";
      const body = indent(
        inner.replace(/^\n+/, "").replace(/\n+$/, "\n"),
        "    ",
      );
      return `${prefix}${body}${body.endsWith("\n") ? "" : "\n"}`;
    }
    case "td":
    case "th":
      return `${inner.trim()} `;
    default:
      return blocks.has(frame.tag) ? `\n\n${inner}\n\n` : inner;
  }
}

export async function htmlToMarkdown(
  html: string,
  maxInput: number,
): Promise<string> {
  const root: Frame = { tag: "#root", attributes: new Map(), parts: [] };
  const stack: Frame[] = [root];
  let skip = 0;
  // Whitespace collapses across inline elements, as in turndown.
  let afterSpace = true;
  const top = () => stack.at(-1) ?? root;
  const inPre = () => stack.some((frame) => frame.tag === "pre");
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (skip > 0 || removed.has(tag)) {
          if (element.canHaveContent) {
            skip++;
            element.onEndTag(() => {
              skip--;
            });
          }
          return;
        }
        const frame: Frame = {
          tag,
          attributes: new Map(
            [...element.attributes].map(([key, value]) => [
              key,
              decodeEntities(value),
            ]),
          ),
          parts: [],
        };
        if (!element.canHaveContent) {
          top().parts.push(render(frame, top()));
          return;
        }
        stack.push(frame);
        element.onEndTag(() => {
          const index = stack.lastIndexOf(frame);
          if (index <= 0) return;
          // Unclosed descendants fold into this element first.
          while (stack.length - 1 > index) {
            const open = stack.pop() ?? root;
            top().parts.push(render(open, top()));
          }
          stack.pop();
          top().parts.push(render(frame, top()));
        });
      },
    })
    .onDocument({
      text(chunk) {
        if (skip > 0 || !chunk.text) return;
        const decoded = decodeEntities(chunk.text);
        if (inPre()) {
          top().parts.push(decoded);
          afterSpace = false;
          return;
        }
        let text = decoded.replace(/\s+/g, " ");
        if (afterSpace) text = text.replace(/^ /, "");
        if (!text) return;
        afterSpace = text.endsWith(" ");
        top().parts.push(escape(text));
      },
    });
  let markdown: string;
  try {
    await rewriter.transform(new Response(html.slice(0, maxInput))).text();
    while (stack.length > 1) {
      const open = stack.pop() ?? root;
      top().parts.push(render(open, top()));
    }
    markdown = root.parts
      .join("")
      .replace(/[ \t]+(?=\ue000br$|$)/gm, "")
      .replace(/^ (?=\S)/gm, "")
      .replaceAll(BREAK, "  \n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .trimEnd();
  } catch {
    return html;
  }
  return html.length > maxInput
    ? `${markdown}\n\n[Content truncated due to length...]`
    : markdown;
}
