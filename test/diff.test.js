import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksOf, diffNotes } from "../src/diff.js";

test("blocksOf splits a note into its top-level blocks", () => {
  const md = "# Title\n\nFirst para\nstill first.\n\n- a\n- b\n\n```js\nlet x = 1;\n\nlet y = 2;\n```\n\n| a |\n|---|\n| 1 |\n";
  assert.deepEqual(blocksOf(md), [
    "# Title",
    "First para\nstill first.",
    "- a\n- b",
    "```js\nlet x = 1;\n\nlet y = 2;\n```",
    "| a |\n|---|\n| 1 |",
  ]);
  assert.deepEqual(blocksOf(""), []);
});

test("unchanged notes diff to nothing but same rows", () => {
  const { rows, stats } = diffNotes("# A\n\nhello\n", "# A\n\nhello\n");
  assert.deepEqual(rows.map((r) => r.kind), ["same", "same"]);
  assert.deepEqual(stats, { added: 0, removed: 0, changed: 0, same: 2 });
});

test("an edited paragraph is one changed row; inserts and deletes are added and removed", () => {
  const before = "# A\n\none\n\ntwo\n\nthree\n";
  const after = "# A\n\none\n\nTWO changed\n\nthree\n\nfour\n";
  const { rows, stats } = diffNotes(before, after);
  assert.deepEqual(rows.map((r) => r.kind), ["same", "same", "changed", "same", "added"]);
  const changed = rows[2];
  assert.match(changed.old, /two/);
  assert.match(changed.new, /TWO changed/);
  assert.equal(rows[4].old, null);
  assert.match(rows[4].new, /four/);
  assert.deepEqual(stats, { added: 1, removed: 0, changed: 1, same: 3 });

  const gone = diffNotes("# A\n\nx\n\ny\n", "# A\n\ny\n");
  assert.deepEqual(gone.rows.map((r) => r.kind), ["same", "removed", "same"]);
  assert.equal(gone.rows[1].new, null);
});

test("a first version is all additions", () => {
  const { rows } = diffNotes(null, "# A\n\nbody\n");
  assert.deepEqual(rows.map((r) => r.kind), ["added", "added"]);
});

test("rendered blocks keep the markers monitors look for", () => {
  const { rows } = diffNotes("x\n", "x\n\n| a |\n|---|\n| 1 |\n\n```mermaid\ngraph TD; A-->B\n```\n");
  const html = rows.map((r) => r.new).join("");
  assert.match(html, /<table>/);
  assert.match(html, /class="mermaid"/);
});

test("unrelated blocks are a removal and an addition, not an edit", () => {
  const { rows } = diffNotes("# A\n\nOld paragraph about caching layers.\n", "# A\n\n| x | y |\n|---|---|\n| 1 | 2 |\n");
  assert.deepEqual(rows.map((r) => r.kind), ["same", "removed", "added"]);
  const reworded = diffNotes("Old paragraph about caching layers.\n", "New paragraph about caching layers, trimmed.\n");
  assert.deepEqual(reworded.rows.map((r) => r.kind), ["changed"]);
});

test("rows say which block of the new note they are, and html can be skipped", () => {
  const { rows, blocks } = diffNotes("# A\n\none\n\ntwo\n", "# A\n\none\n\nTWO changed\n\nthree\n", { html: false });
  assert.equal(blocks, 4);
  assert.deepEqual(rows.map((r) => [r.kind, r.at]), [["same", 0], ["same", 1], ["changed", 2], ["added", 3]]);
  assert.equal(rows[2].new, null);
  assert.equal(diffNotes("x\n\ny\n", "y\n", { html: false }).rows[0].at, null, "a removed block has no place in the new note");
});
