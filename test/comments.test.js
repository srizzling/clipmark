import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { locate, digest } from "../src/comments.js";
import { createApp } from "../src/server.js";

const DOC = [
  "# Plan",
  "",
  "We will **ship the beta** on Friday.",
  "",
  "- first item with a [link](https://example.com/a_b)",
  "- [ ] second task",
  "",
  "| a | b |",
  "|---|---|",
  "| cell one | cell two |",
  "",
  "Ship it. Then ship it again.",
].join("\n");

test("locate finds rendered text through inline Markdown", () => {
  assert.deepEqual(locate(DOC, { quote: "ship the beta on Friday" }).lines, [3, 3]);
  assert.deepEqual(locate(DOC, { quote: "first item with a link" }).lines, [5, 5]);
  assert.deepEqual(locate(DOC, { quote: "second task" }).lines, [6, 6]);
});

test("locate spans blocks and table cells", () => {
  assert.deepEqual(locate(DOC, { quote: "first item with a link second task" }).lines, [5, 6]);
  assert.deepEqual(locate(DOC, { quote: "cell one cell two" }).lines, [10, 10]);
  assert.equal(locate(DOC, { quote: "Friday." }).source, "We will **ship the beta** on Friday.");
});

test("locate uses the surrounding text to pick between repeats", () => {
  const doc = "Alpha beta. Gamma.\n\nAlpha beta. Delta.";
  assert.equal(locate(doc, { quote: "Alpha beta" }).lines[0], 1, "no context: first occurrence");
  assert.equal(locate(doc, { quote: "Alpha beta", prefix: "Gamma. ", suffix: ". Delta." }).lines[0], 3, "context picks the second");
});

test("locate returns null when the text is gone", () => {
  assert.equal(locate(DOC, { quote: "never written" }), null);
  assert.equal(locate(DOC, { quote: "   " }), null);
});

test("digest is readable and flags a quote that has gone", () => {
  const md = digest({
    path: "a.md", latest: "v1",
    comments: [
      { id: "c1", status: "open", quote: "ship the beta", comment: "Which beta?", located: true, lines: [3, 3], source: "We will **ship the beta**" },
      { id: "c2", status: "open", quote: "old", comment: "gone", located: false },
    ],
  });
  assert.match(md, /## c1 · open · line 3/);
  assert.match(md, /> ship the beta\n\nWhich beta\?/);
  assert.match(md, /## c2 · open · quote not found in the latest version/);
});

let app, base, dir;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipmark-cm-"));
  app = createApp({ notesDir: dir, token: "s3cret", siteTitle: "T" });
  const addr = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${addr.port}`;
  await fetch(`${base}/api/notes/team/plan.md`, { method: "PUT", body: DOC, headers: { Authorization: "Bearer s3cret" } });
});
after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

const api = (suffix, init = {}) => fetch(`${base}/api/notes/team/plan.md/comments${suffix}`, init);
const send = (method, suffix, obj) => api(suffix, { method, body: JSON.stringify(obj), headers: { "Content-Type": "application/json" } });

test("comments need no token to write, read or resolve", async () => {
  const r = await send("POST", "", { quote: "ship the beta on Friday", prefix: "We will ", suffix: ".", body: "Which beta?" });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.id, "c1");
  assert.equal(c.status, "open");
  assert.equal(c.located, true);
  assert.equal(c.line, 3);
  assert.equal(c.comment, "Which beta?");
  assert.equal(c.stale, false);

  const list = await (await api("")).json();
  assert.equal(list.path, "team/plan.md");
  assert.deepEqual(list.comments.map((x) => x.id), ["c1"]);
});

test("the digest format and status filter", async () => {
  await send("POST", "", { quote: "cell one", body: "Rename this column" });
  const md = await api("?format=md");
  assert.match(md.headers.get("content-type"), /text\/markdown/);
  const text = await md.text();
  assert.match(text, /## c1 · open · line 3/);
  assert.match(text, /## c2 · open · line 10/);

  const done = await (await send("PATCH", "/c1", { status: "resolved", resolution: "Named the beta" })).json();
  assert.equal(done.status, "resolved");
  assert.equal(done.resolution, "Named the beta");
  assert.ok(done.resolved);
  assert.deepEqual((await (await api("")).json()).comments.map((x) => x.id), ["c2"]);
  assert.deepEqual((await (await api("?status=resolved")).json()).comments.map((x) => x.id), ["c1"]);
  assert.equal((await (await api("?status=all")).json()).comments.length, 2);
  assert.equal((await api("?status=bogus")).status, 400);

  const reopened = await (await send("PATCH", "/c1", { status: "open" })).json();
  assert.equal(reopened.resolution, null);
  assert.equal(reopened.resolved, null);
});

test("a republished note moves the line and drops what was rewritten", async () => {
  const v2 = DOC.replace("# Plan", "# Plan\n\nIntro paragraph.").replace("ship the beta", "ship release 1.0");
  const put = await fetch(`${base}/api/notes/team/plan.md`, { method: "PUT", body: v2, headers: { Authorization: "Bearer s3cret" } });
  assert.equal((await put.json()).changed, true);
  const { comments } = await (await api("?status=all")).json();
  const [c1, c2] = comments;
  assert.equal(c1.located, false, "c1 quote was rewritten");
  assert.equal(c1.line, null);
  assert.equal(c1.stale, true);
  assert.equal(c2.located, true);
  assert.equal(c2.line, 12, "c2 moved down two lines");
});

test("comments made on an old version keep that version", async () => {
  const vs = (await (await fetch(`${base}/api/notes/team/plan.md/versions`)).json()).versions;
  const old = vs[vs.length - 1].id;
  const c = await (await send("POST", "", { quote: "Friday", body: "which Friday", version: old })).json();
  assert.equal(c.version, old);
  assert.equal((await send("POST", "", { quote: "Friday", body: "x", version: "nope" })).status, 400);
});

test("bad input is a 400 or 404, not a crash", async () => {
  assert.equal((await send("POST", "", { quote: "x" })).status, 400);
  assert.equal((await send("POST", "", { body: "x" })).status, 400);
  assert.equal((await send("POST", "", { quote: 5, body: "x" })).status, 400);
  assert.equal((await api("", { method: "POST", body: "not json" })).status, 400);
  assert.equal((await send("POST", "", { quote: "x".repeat(5000), body: "x" })).status, 400);
  assert.equal((await send("PATCH", "/c99", { status: "resolved" })).status, 404);
  assert.equal((await send("PATCH", "/c1", {})).status, 400);
  assert.equal((await send("PATCH", "/c1", { status: "nope" })).status, 400);
  assert.equal((await api("/c1", { method: "GET" })).status, 405);
  const missing = await fetch(`${base}/api/notes/nope.md/comments`);
  assert.equal(missing.status, 404);
  assert.equal((await fetch(`${base}/api/notes/nope.md/comments`, { method: "POST", body: "{}" })).status, 404);
});

test("concurrent comments all land with distinct ids", async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => send("POST", "", { quote: "Friday", body: `c ${i}` })));
  assert.ok(rs.every((r) => r.status === 201));
  const ids = (await Promise.all(rs.map((r) => r.json()))).map((c) => c.id);
  assert.equal(new Set(ids).size, 12);
});

test("deleting a comment removes it", async () => {
  const r = await send("DELETE", "/c2");
  assert.equal(r.status, 200);
  const { comments } = await (await api("?status=all")).json();
  assert.ok(!comments.some((c) => c.id === "c2"));
  assert.equal((await send("DELETE", "/c2")).status, 404);
});

test("the note page carries the review controls, and comments stay off the note list", async () => {
  const html = await (await fetch(`${base}/n/team/plan.md`)).text();
  assert.match(html, /id="toggle-comments"/);
  assert.match(html, /<table>/);
  const list = await (await fetch(`${base}/api/notes`)).json();
  assert.deepEqual(list.notes.map((n) => n.path), ["team/plan.md"]);
  assert.ok((await readdir(dir)).includes(".comments"));
  assert.equal((await fetch(`${base}/n/.comments/team/plan.json`)).status, 400);
});

test("slop flags: a bare click is enough, patterns are tags, kinds are validated", async () => {
  const bare = await (await send("POST", "", { quote: "Ship it", kind: "slop" })).json();
  assert.equal(bare.kind, "slop");
  assert.equal(bare.comment, "");
  assert.equal(bare.pattern, null);
  const tagged = await (await send("POST", "", { quote: "Then ship it again", kind: "slop", pattern: " Fake-Profound-Kicker ", body: "cut the kicker" })).json();
  assert.equal(tagged.pattern, "fake-profound-kicker");
  assert.equal(tagged.comment, "cut the kicker");

  assert.equal((await send("POST", "", { quote: "Ship it", body: "" })).status, 400, "plain comments still need words");
  assert.equal((await send("POST", "", { quote: "Ship it", body: "x", pattern: "filler" })).status, 400, "pattern is for slop only");
  assert.equal((await send("POST", "", { quote: "Ship it", body: "x", kind: "nope" })).status, 400);
  assert.equal((await send("POST", "", { quote: "Ship it", kind: "slop", pattern: "x".repeat(61) })).status, 400);
});

test("the kind filter and the review digest separate slop from comments", async () => {
  const slop = (await (await api("?status=all&kind=slop")).json()).comments;
  assert.ok(slop.length >= 2 && slop.every((c) => c.kind === "slop"));
  const plain = (await (await api("?status=all&kind=comment")).json()).comments;
  assert.ok(plain.length >= 1 && plain.every((c) => c.kind === "comment"));
  assert.equal((await api("?kind=bogus")).status, 400);
  const md = await (await api("?format=md&kind=slop")).text();
  assert.match(md, /## c\d+ · slop · open · line 14/);
  assert.match(md, /· slop \(fake-profound-kicker\) · open/);
  assert.match(md, /sounds machine-written/);
});

test("/api/slop collects flags across notes and keeps the quote after a rewrite", async () => {
  const auth = { Authorization: "Bearer s3cret" };
  await fetch(`${base}/api/notes/other.md`, { method: "PUT", body: "# Other\n\nIt's not a tool. It's a mindset.", headers: auth });
  const other = await fetch(`${base}/api/notes/other.md/comments`, {
    method: "POST", body: JSON.stringify({ quote: "It's not a tool. It's a mindset.", kind: "slop", pattern: "binary-contrast", body: "just say it" }),
  });
  assert.equal(other.status, 201);
  const id = (await other.json()).id;

  // Rewrite the sentence away and resolve the flag: the example must survive.
  await fetch(`${base}/api/notes/other.md`, { method: "PUT", body: "# Other\n\nIt is a mindset.", headers: auth });
  await fetch(`${base}/api/notes/other.md/comments/${id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved", resolution: "Said it directly" }) });

  const { flags } = await (await fetch(`${base}/api/slop`)).json();
  assert.ok(flags.every((f) => f.quote && f.note));
  assert.deepEqual([...new Set(flags.map((f) => f.note))].sort(), ["other.md", "team/plan.md"]);
  const mine = flags.find((f) => f.note === "other.md");
  assert.equal(mine.quote, "It's not a tool. It's a mindset.");
  assert.equal(mine.feedback, "just say it");
  assert.equal(mine.pattern, "binary-contrast");
  assert.equal(mine.status, "resolved");
  assert.equal(mine.resolution, "Said it directly");

  const open = (await (await fetch(`${base}/api/slop?status=open`)).json()).flags;
  assert.ok(open.every((f) => f.status === "open") && !open.some((f) => f.note === "other.md"));
  assert.equal((await fetch(`${base}/api/slop?status=bogus`)).status, 400);

  const md = await (await fetch(`${base}/api/slop?format=md`)).text();
  assert.match(md, /## binary-contrast \(1\)/);
  assert.match(md, /## untagged \(\d+\)/);
  assert.match(md, /What changed: Said it directly/);
});

test("the page has the slop button and pattern picker", async () => {
  const js = await (await fetch(`${base}/assets/app.js`)).text();
  assert.match(js, /Flag this as AI-sounding writing/);
  assert.match(js, /fake-profound-kicker/);
});

test("slop flags carry the paragraph they sat in, from the version they were flagged on", async () => {
  const auth = { Authorization: "Bearer s3cret" };
  const v1 = "# Roadmap\n\nFirst paragraph.\n\nThe launch marks a pivotal moment for the team.\nIt is shipping on Tuesday.\n\nLast paragraph.";
  await fetch(`${base}/api/notes/ctx.md`, { method: "PUT", body: v1, headers: auth });
  const made = await fetch(`${base}/api/notes/ctx.md/comments`, {
    method: "POST", body: JSON.stringify({ quote: "marks a pivotal moment", kind: "slop", pattern: "importance-puffery", body: "says nothing" }),
  });
  const id = (await made.json()).id;
  await fetch(`${base}/api/notes/ctx.md`, { method: "PUT", body: "# Roadmap\n\nFirst paragraph.\n\nThe launch ships Tuesday.\n\nLast paragraph.", headers: auth });
  await fetch(`${base}/api/notes/ctx.md/comments/${id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved", resolution: "The launch ships Tuesday." }) });

  const f = (await (await fetch(`${base}/api/slop`)).json()).flags.find((x) => x.note === "ctx.md");
  assert.equal(f.title, "Roadmap");
  assert.equal(f.context, "The launch marks a pivotal moment for the team.\nIt is shipping on Tuesday.", "the original paragraph, not the rewrite");
  assert.equal(f.feedback, "says nothing");
  assert.equal(f.resolution, "The launch ships Tuesday.");

  const md = await (await fetch(`${base}/api/slop?format=md`)).text();
  assert.match(md, /Why: says nothing/);
  assert.match(md, /In context \(Roadmap\):\n  \| The launch marks a pivotal moment/);
  assert.match(md, /Why: \(no reason given\)/);
});
