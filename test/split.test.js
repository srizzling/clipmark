import { test } from "node:test";
import assert from "node:assert/strict";
import { splitNote, units, partPath } from "../src/split.js";
import { render } from "../src/render.js";

const section = (name, lines = 40) => `## ${name}\n\n${"A line of text in this section.\n".repeat(lines)}\n`;

test("units join back into the document exactly", () => {
  const md = "\n# T\ntext\n## H\n\n```js\na\n\nb\n```\n\n| a |\n|---|\n| 1 |\n\n[^n]: note\n\n    more\n\n[r]: http://x\n";
  const all = [...units(md)];
  assert.equal(all.map((u) => md.slice(u.start, u.end)).join(""), md);
  const kinds = all.map((u) => u.kind);
  assert.deepEqual(kinds, ["text", "text", "text", "fence", "table", "footnote", "refs"]);
});

test("a document that fits is left whole", () => {
  const out = splitNote("a.md", "# A\n\nsmall\n", { max: 1000 });
  assert.deepEqual(out.parts, []);
  assert.equal(out.index, "# A\n\nsmall\n");
});

test("parts break at sections, keep the title on the contents note, and lose nothing", () => {
  const md = `# Guide\n\nIntro.\n\n${section("One")}${section("Two")}${section("Three")}`;
  const { index, parts } = splitNote("team/guide.md", md, { max: 1600 });
  // The short intro is packed in with the first section rather than left on its own.
  assert.deepEqual(parts.map((p) => p.path), ["team/guide.part-01.md", "team/guide.part-02.md", "team/guide.part-03.md"]);
  assert.deepEqual(parts.map((p) => p.title), ["One", "Two", "Three"]);
  assert.match(parts[0].markdown, /^Intro\.\n\n## One\n/);
  assert.equal(index, "# Guide\n\n1. [One](guide.part-01.md)\n2. [Two](guide.part-02.md)\n3. [Three](guide.part-03.md)\n");
  // Every line of the original is in exactly one part, in order.
  const joined = parts.map((p) => p.markdown).join("");
  assert.equal(joined.replace(/\s+/g, ""), md.replace(/^# Guide/, "").replace(/\s+/g, ""));
  for (const p of parts) assert.ok(Buffer.byteLength(p.markdown) <= 1600);
});

test("a heading is never left alone at the end of a part", () => {
  const md = `${section("Small", 2)}## Big\n\n\`\`\`\n${"x\n".repeat(300)}\`\`\`\n`;
  const { parts } = splitNote("a.md", md, { max: 400 });
  for (const p of parts) assert.doesNotMatch(p.markdown, /^## \w+\s*$/);
  assert.match(parts.find((p) => p.title === "Big").markdown, /^## Big\n\n```\nx\n/);
});

test("an oversized table repeats its header and an oversized fence is reopened", () => {
  const table = `| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(200)}`;
  const fence = "```sh\n" + "echo hi\n".repeat(200) + "```\n";
  const { parts } = splitNote("a.md", `## T\n\n${table}\n## F\n\n${fence}`, { max: 600 });
  const tables = parts.filter((p) => p.markdown.includes("| 1 | 2 |"));
  assert.ok(tables.length > 1);
  for (const p of tables) {
    assert.match(p.markdown, /\| a \| b \|\n\|---\|---\|\n/);
    assert.match(render(p.markdown), /<table>/);
  }
  const fences = parts.filter((p) => p.markdown.includes("echo hi"));
  assert.ok(fences.length > 1);
  for (const p of fences) {
    const html = render(p.markdown);
    assert.match(html, /<pre data-language="sh">/);
    assert.doesNotMatch(html, /<p>echo hi/);
  }
  assert.deepEqual(parts.slice(1).map((p) => p.title).filter((t) => t.includes("continued")).length > 0, true);
});

test("footnotes and link references follow the parts that use them", () => {
  const md = `## A\n\nSee [docs][D] and this[^n].\n\n${"filler line\n".repeat(30)}\n## B\n\nAlso [docs][d].\n\n${"filler line\n".repeat(30)}\n[^n]: The note.\n\n[d]: https://example.com/docs\n`;
  const { parts } = splitNote("a.md", md, { max: 500 });
  assert.equal(parts.length, 2);
  assert.match(parts[0].markdown, /\[\^n\]: The note\./);
  assert.doesNotMatch(parts[1].markdown, /\[\^n\]:/);
  for (const p of parts) assert.match(render(p.markdown), /href="https:\/\/example\.com\/docs"/);
});

test("anchor links to a heading in another part point at that part", () => {
  const md = `## Start\n\nJump to [the end](#the-end) or [stay](#start).\n\n${"filler\n".repeat(50)}\n## The end\n\nBack to [start](#start).\n`;
  const { parts } = splitNote("docs/g.md", md, { max: 420 });
  assert.equal(parts.length, 2);
  assert.match(parts[0].markdown, /\[the end\]\(g\.part-02\.md#the-end\)/);
  assert.match(parts[0].markdown, /\[stay\]\(#start\)/);
  assert.match(parts[1].markdown, /\[start\]\(g\.part-01\.md#start\)/);
  assert.match(render(parts[0].markdown, { path: parts[0].path }), /href="\/n\/docs\/g\.part-02\.md#the-end"/);
});

test("part names widen past 99 parts", () => {
  assert.equal(partPath("a b.md", 3, 12), "a b.part-03.md");
  assert.equal(partPath("x/y.md", 7, 150), "x/y.part-007.md");
});
