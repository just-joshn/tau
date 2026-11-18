import assert from "node:assert/strict";
import { test } from "bun:test";
import { decodeEntities, htmlToMarkdown } from "../../src/web-markdown.js";

test("HTML becomes turndown-style markdown without removed elements", async () => {
  const html = `<!doctype html><html><head><title>T</title><style>p{}</style></head><body>
<h1>Fixture  Title</h1><h2>Second</h2><h2> </h2><h4>Deep</h4><h5></h5>
<p>Hello <b>bold</b> <strong></strong> <em>em</em> <i> </i> &amp; <a href="https://x.test/a" title="t">link</a> <a href="/n"> </a> <a>plain</a>. 2*3_x</p>
<script>alert(1)</script><noscript><p>gone</p></noscript><iframe src="x"></iframe>
<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
<ol start="3"><li>a</li><li>b</li></ol>
<pre><code>line1
  line2
</code></pre><p>use <code>x()</code> <code></code><br>next</p>
<blockquote><p>q1</p><p>q2</p></blockquote><img src="i.png" alt="pic"><img alt="none"><hr>
<table><tr><th>H</th><td>D</td></tr></table><div><span>unclosed<p>para</div>
</body></html>`;
  const markdown = await htmlToMarkdown(html, 1_000_000);
  assert.equal(
    markdown,
    [
      "Fixture Title",
      "=============",
      "",
      "Second",
      "------",
      "",
      "#### Deep",
      "",
      'Hello **bold** _em_ & [link](https://x.test/a "t") plain. 2\\*3\\_x',
      "",
      "*   one",
      "*   two",
      "",
      "    *   nested",
      "",
      "3.  a",
      "4.  b",
      "",
      "    line1",
      "      line2",
      "",
      "use `x()`  ",
      "next",
      "",
      "> q1",
      ">",
      "> q2",
      "",
      "![pic](i.png)",
      "",
      "* * *",
      "",
      "H D",
      "",
      "unclosed",
      "",
      "para",
    ].join("\n"),
  );
});

test("long input is cut before conversion and marked truncated", async () => {
  const markdown = await htmlToMarkdown(`<p>${"a".repeat(50)}</p>`, 10);
  assert.equal(markdown, "aaaaaaa\n\n[Content truncated due to length...]");
});

test("text that reads as markdown is escaped", async () => {
  const markdown = await htmlToMarkdown(
    "<pre>#keep</pre><p>[x] `y` ~~~ \\</p><div>- a</div><div>+ b</div><div>== c</div><div># d</div><div>> e</div><div>1. f</div><div>~~~g</div>",
    1000,
  );
  assert.equal(
    markdown,
    "    #keep\n\n\\[x\\] \\`y\\` ~~~ \\\\\n\n\\- a\n\n\\+ b\n\n\\== c\n\n\\# d\n\n\\> e\n\n1\\. f\n\n\\~~~g",
  );
});

test("entities decode named, decimal and hex references and keep unknown ones", () => {
  assert.equal(
    decodeEntities("&lt;&GT;&quot;&apos;&nbsp;&#65;&#x42;&#X43;&bogus;&#0;"),
    "<>\"'\u00a0ABC&bogus;&#0;",
  );
});
