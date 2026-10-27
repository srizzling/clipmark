import { test } from "node:test";
import assert from "node:assert/strict";
import { render, titleOf } from "../src/render.js";

test("mermaid fences become client-rendered figures with the source kept", () => {
  const html = render("```mermaid\ngraph TD; A-->B\n```\n");
  assert.match(html, /<figure class="mermaid-block">/);
  assert.match(html, /<pre class="mermaid">graph TD; A--&gt;B\n<\/pre>/);
  assert.match(html, /<pre class="mermaid-source" hidden>/);
});

test("code fences carry data-language for paste targets", () => {
  const html = render("```python\nprint(1)\n```\n");
  assert.match(html, /<pre data-language="python"><code class="language-python">print\(1\)\n<\/code><\/pre>/);
  assert.match(render("```\nx\n```\n"), /<pre><code>x\n<\/code><\/pre>/);
});

test("GFM tables, strikethrough, autolinks and footnotes render", () => {
  const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~ https://example.com ref[^1]\n\n[^1]: note\n");
  assert.match(html, /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/);
  assert.match(html, /<s>gone<\/s>/);
  assert.match(html, /<a href="https:\/\/example.com">/);
  assert.match(html, /class="footnotes"/);
});

test("GFM alerts become panels with a label", () => {
  const html = render("> [!WARNING]\n> Mind the gap.\n");
  assert.match(html, /<div class="markdown-alert markdown-alert-warning" data-panel-type="warning">/);
  assert.match(html, /<p class="markdown-alert-title"><strong>Warning<\/strong><\/p>/);
  assert.match(html, /<p>Mind the gap.<\/p>/);
  assert.doesNotMatch(html, /\[!WARNING\]/);
  assert.doesNotMatch(html, /<blockquote>/);
  assert.equal(new Map(Object.entries({ NOTE: "info", TIP: "success", IMPORTANT: "note", CAUTION: "error" })).size, 4);
  for (const [k, v] of [["NOTE", "info"], ["TIP", "success"], ["IMPORTANT", "note"], ["CAUTION", "error"]]) {
    assert.match(render(`> [!${k}]\n> x\n`), new RegExp(`data-panel-type="${v}"`));
  }
});

test("plain blockquotes are untouched", () => {
  assert.match(render("> just a quote\n"), /<blockquote>\n<p>just a quote<\/p>\n<\/blockquote>/);
});

test("task lists become checkboxes", () => {
  const html = render("- [ ] todo\n- [x] done\n- plain\n");
  assert.match(html, /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> todo<\/li>/);
  assert.match(html, /<input type="checkbox" class="task-list-item-checkbox" disabled checked> done/);
  assert.match(html, /<li>plain<\/li>/);
});

test("titleOf takes the first H1", () => {
  assert.equal(titleOf("intro\n\n# Real title #\n\n## sub"), "Real title");
  assert.equal(titleOf("no heading", "fallback.md"), "fallback.md");
});

test("headings get GitHub-style ids so in-page links land", () => {
  const html = render("# Title\n\n[go](#setup-steps)\n\n## Setup steps\n\n## Setup steps\n\n### What's `new`?\n\n## Ünïcode ok\n");
  assert.match(html, /<h1 id="title">/);
  assert.match(html, /<h2 id="setup-steps">Setup steps<\/h2>/);
  assert.match(html, /<h2 id="setup-steps-1">/, "repeats are numbered like GitHub");
  assert.match(html, /<h3 id="whats-new">/);
  assert.match(html, /<h2 id="ünïcode-ok">/);
  assert.match(html, /<a href="#setup-steps">/);
});

test("relative links and images resolve from the note's folder, wherever the page is opened", () => {
  const md = "[a](other.md) [b](sub/x.md#part) [c](../up.md) [d](#here) [e](/all) [f](https://e.com/x.md) ![i](img/p.png)\n";
  const html = render(md, { path: "team/notes/a.md" });
  assert.match(html, /href="\/n\/team\/notes\/other.md"/);
  assert.match(html, /href="\/n\/team\/notes\/sub\/x.md#part"/);
  assert.match(html, /href="\/n\/team\/up.md"/);
  assert.match(html, /href="#here"/);
  assert.match(html, /href="\/all"/);
  assert.match(html, /href="https:\/\/e.com\/x.md"/);
  assert.match(html, /src="\/n\/team\/notes\/img\/p.png"/);
  assert.match(render(md), /href="other.md"/, "without a path nothing is rewritten");
});
