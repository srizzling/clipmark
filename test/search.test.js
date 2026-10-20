import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, indexNote, scoreNote, plainText } from "../src/search.js";

const note = (markdown, title = "Untitled", path = "n.md", slug = "calm-otter-naps") => {
  const entry = indexNote(markdown, title);
  return (q) => scoreNote(entry, parseQuery(q), { path, slug });
};

test("parseQuery splits words, keeps quoted phrases, drops punctuation and repeats", () => {
  assert.deepEqual(parseQuery('Foo-bar "Exact  Phrase" baz foo'), { terms: ["foo", "bar", "baz"], phrases: ["exact phrase"] });
  assert.deepEqual(parseQuery("   "), { terms: [], phrases: [] });
  assert.deepEqual(parseQuery(undefined), { terms: [], phrases: [] });
});

test("plainText drops syntax but keeps what a reader sees", () => {
  const md = "# Title\n\n- [ ] a **bold** [link](http://x.test/y) item\n\n```js\ncode here\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const t = plainText(md);
  assert.match(t, /Title a bold link item code here a b 1 2/);
  assert.doesNotMatch(t, /http|\*|```|---/);
});

test("exact, prefix, inside and typo matches all find the word; unrelated words do not", () => {
  const s = note("The dashboard shows what is waiting.");
  for (const q of ["dashboard", "dash", "board", "dashbord", "dashboard waiting"]) assert.ok(s(q), q);
  assert.equal(s("elephant"), null);
  assert.equal(s("dashboard elephant"), null, "every word must match");
});

test("typos are only forgiven in longer words", () => {
  const s = note("the cat sat");
  assert.equal(s("cta"), null);
  assert.ok(note("settlement")("setlement"), "one missing letter");
  assert.ok(note("settlement")("settlemnet"), "swapped letters");
  assert.ok(note("settlement")("sxxtlement"), "two wrong letters in a long word");
  assert.equal(note("settlement")("sxxxlement"), null, "three is too many");
});

test("phrases must appear as typed", () => {
  const s = note("The review queue is empty. Queue the review later.");
  assert.ok(s('"review queue"'));
  assert.equal(s('"queue review"'), null);
});

test("title and path outrank body, and snippets mark the match", () => {
  const body = note("A note about caching.", "Plain title", "misc/n.md")("caching");
  const title = note("Unrelated text.", "Caching strategy", "misc/n.md")("caching");
  const path = note("Unrelated text.", "Plain title", "caching/n.md")("caching");
  assert.ok(title.score > path.score && path.score > body.score, JSON.stringify([title.score, path.score, body.score]));
  assert.equal(body.snippet.slice(...body.highlights[0]), "caching");
  assert.deepEqual(title.highlights, [], "no body match, no marks");
});

test("slug words are searchable", () => {
  assert.ok(note("nothing relevant", "T", "n.md", "sleepy-wombat-hums")("wombat"));
});

test("snippets are cut around where the words sit together and marked", () => {
  const filler = "lorem ipsum dolor sit amet ".repeat(30);
  const r = note(`${filler} alpha beta ${filler} gamma ${filler}`)("alpha beta");
  assert.match(r.snippet, /^…/);
  assert.ok(r.snippet.length < 260);
  assert.deepEqual(r.highlights.map(([a, b]) => r.snippet.slice(a, b)), ["alpha", "beta"]);
});
