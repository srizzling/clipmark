import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";

let app, base, dir;
const TOKEN = "s3cret";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipmark-srv-"));
  app = createApp({ notesDir: dir, token: TOKEN, siteTitle: "T" });
  const addr = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

const put = (p, body, token = TOKEN) =>
  fetch(`${base}/api/notes/${p}`, { method: "PUT", body, headers: token ? { Authorization: `Bearer ${token}` } : {} });

test("healthz reports version, writability and a render smoke test", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.writable, true);
  assert.equal(j.renders, true);
  assert.match(j.version, /^\d+\.\d+\.\d+/);
});

test("publishing needs the token", async () => {
  assert.equal((await put("a.md", "# A", null)).status, 401);
  assert.equal((await put("a.md", "# A", "wrong")).status, 401);
  const r = await put("a.md", "# A\n\nhello");
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.created, true);
  assert.match(j.pathUrl, /\/n\/a\.md$/);
  assert.equal(j.url, `${base}/${j.slug}`);
  assert.equal((await put("a.md", "# A\n\nhello v2")).status, 200);
});

test("oversized bodies get a readable 413, not a reset", async () => {
  const own = await mkdtemp(path.join(tmpdir(), "clipmark-big-"));
  const small = createApp({ notesDir: own, token: TOKEN, maxBody: 64 });
  const { port } = await small.listen(0, "127.0.0.1");
  try {
    const url = `http://127.0.0.1:${port}/api/notes/big.md`;
    const headers = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };
    const r = await fetch(url, { method: "PUT", body: "x".repeat(1000), headers });
    assert.equal(r.status, 413);
    assert.match((await r.json()).error, /limit is/);
    // A chunked body has no Content-Length, so the limit trips mid-stream.
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("y".repeat(100))); c.close(); } });
    const s = await fetch(url, { method: "PUT", body: stream, duplex: "half", headers });
    assert.equal(s.status, 413);
    assert.equal((await fetch(url, { method: "PUT", body: "# ok", headers })).status, 201);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/llms.txt`)).text(), /capped at [\d.]+ MB/);
  } finally { await small.close(); await rm(own, { recursive: true, force: true }); }
});

test("?split=1 publishes a big document as a contents note plus parts", async () => {
  const section = (n) => `## Section ${n}\n\n${"Words in a long section of a big document.\n".repeat(5000)}\n`;
  const doc = `# Big guide\n\n${[1, 2, 3, 4].map(section).join("")}`; // ~860 KB
  let r = await put("big/guide.md?split=1", doc);
  assert.equal(r.status, 201);
  let j = await r.json();
  assert.match(j.url, new RegExp(`/${j.slug}$`));
  assert.deepEqual(j.parts.map((p) => p.path), ["big/guide.part-01.md", "big/guide.part-02.md", "big/guide.part-03.md", "big/guide.part-04.md"]);
  assert.deepEqual(j.parts.map((p) => p.title), ["Section 1", "Section 2", "Section 3", "Section 4"]);
  for (const p of j.parts) assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-z-]+$/);

  const index = await (await fetch(`${base}/raw/big/guide.md`)).text();
  assert.match(index, /^# Big guide\n\n1\. \[Section 1\]\(guide\.part-01\.md\)/);

  // A part links back and on, outside the article; the contents note offers every part at once.
  const part = await (await fetch(`${base}/n/big/guide.part-02.md`)).text();
  assert.match(part, /<title>Section 2 · T<\/title>/);
  assert.match(part, /Part 2 of 4 of <a href="\/n\/big\/guide\.md">Big guide<\/a>/);
  assert.match(part, /href="\/n\/big\/guide\.part-01\.md">← Previous/);
  assert.match(part, /href="\/n\/big\/guide\.part-03\.md">Next →/);
  assert.ok(part.indexOf('class="parts"') < part.indexOf('id="note"'));
  const contents = await (await fetch(`${base}/${j.slug}`)).text();
  assert.match(contents, new RegExp(`href="/${j.slug}\\?all=1"`));
  const whole = await (await fetch(`${base}/${j.slug}?all=1`)).text();
  assert.match(whole, /data-parts="\[&quot;big\/guide\.part-01\.md&quot;/);
  assert.match(whole, /<h1 id="big-guide">Big guide<\/h1>/);
  assert.doesNotMatch(whole, /Words in a long section/);

  // Unchanged parts stay unchanged; parts the new text does not need go, history kept.
  r = await put("big/guide.md?split=1", `# Big guide\n\n${[1, 2, 3].map(section).join("")}`);
  j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j.parts.map((p) => p.changed), [false, false, false]);
  assert.deepEqual(j.removed, ["big/guide.part-04.md"]);
  assert.equal((await fetch(`${base}/n/big/guide.part-04.md`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/notes/big/guide.part-04.md/versions`)).json()).versions.length, 1);

  // Small enough again: one note, and the parts are retired.
  j = await (await put("big/guide.md?split=1", "# Big guide\n\nShort now.\n")).json();
  assert.deepEqual(j.parts, []);
  assert.deepEqual(j.removed, ["big/guide.part-01.md", "big/guide.part-02.md", "big/guide.part-03.md"]);
  assert.doesNotMatch(await (await fetch(`${base}/n/big/guide.md`)).text(), /class="parts"/);
  await fetch(`${base}/api/notes/big/guide.md`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
});

test("a note too big to render whole is refused with a pointer to ?split=1", async () => {
  const own = await mkdtemp(path.join(tmpdir(), "clipmark-note-"));
  const small = createApp({ notesDir: own, token: TOKEN, maxNote: 1024 });
  const { port } = await small.listen(0, "127.0.0.1");
  try {
    const url = `http://127.0.0.1:${port}/api/notes/x.md`;
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const body = `## A\n\n${"text\n".repeat(400)}`;
    const r = await fetch(url, { method: "PUT", body, headers });
    assert.equal(r.status, 413);
    assert.match((await r.json()).error, /\?split=1/);
    assert.equal((await fetch(`${url}?split=1`, { method: "PUT", body, headers })).status, 201);
  } finally { await small.close(); await rm(own, { recursive: true, force: true }); }
});

test("bad paths are rejected", async () => {
  assert.equal((await put("..%2Fx.md", "x")).status, 400);
  assert.equal((await put("x.txt", "x")).status, 400);
  assert.equal((await put("empty.md", "  \n")).status, 400);
});

test("rendered page, raw, versions and JSON all agree", async () => {
  const page = await fetch(`${base}/n/a.md`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<article id="note"/);
  assert.match(html, /hello v2/);
  assert.match(html, /id="copy-rich"/);
  assert.match(html, /id="export-pdf"/);
  assert.match(html, /\/vendor\/mermaid\.min\.js/);

  const raw = await fetch(`${base}/raw/a.md`);
  assert.equal(await raw.text(), "# A\n\nhello v2");

  const vs = await (await fetch(`${base}/api/notes/a.md/versions`)).json();
  assert.equal(vs.versions.length, 2);
  const old = vs.versions[1].id;
  const oldPage = await (await fetch(`${base}/n/a.md?v=${old}`)).text();
  assert.match(oldPage, /Viewing version/);
  assert.match(oldPage, /<p>hello<\/p>/);
  // The page records the version it was rendered from, so an open tab can tell
  // when the note is republished. Only the current view watches for that.
  assert.match(html, new RegExp(`data-latest="${vs.versions[0].id}"`));
  assert.doesNotMatch(oldPage, /data-latest/);
  assert.equal((await fetch(`${base}/raw/a.md?v=nope`)).status, 400);

  const list = await (await fetch(`${base}/api/notes`)).json();
  assert.deepEqual(list.notes.map((n) => n.title), ["A"]);
  const one = await (await fetch(`${base}/api/notes/a.md`)).json();
  assert.equal(one.markdown, "# A\n\nhello v2");
  assert.equal(one.versions.length, 2);
});

test("index lists notes and the mermaid bundle is served", async () => {
  const idx = await (await fetch(`${base}/all`)).text();
  assert.match(idx, /href="\/n\/a\.md"/);
  const mm = await fetch(`${base}/vendor/mermaid.min.js`);
  assert.equal(mm.status, 200);
  assert.match(mm.headers.get("content-type"), /javascript/);
});

test("llms.txt describes the API with this deployment's URL", async () => {
  const r = await fetch(`${base}/llms.txt`);
  assert.equal(r.status, 200);
  const txt = await r.text();
  assert.match(txt, new RegExp(`PUT ${base.replaceAll(".", "\\.")}/api/notes/<path>`));
  assert.doesNotMatch(txt, /\{\{/);
  assert.match(txt, /Version: \d+\.\d+\.\d+/);
});

test("render endpoint previews without saving", async () => {
  const r = await fetch(`${base}/api/render`, { method: "POST", body: "> [!TIP]\n> yes\n" });
  assert.match(await r.text(), /data-panel-type="success"/);
});

test("delete keeps history", async () => {
  assert.equal((await fetch(`${base}/api/notes/a.md`, { method: "DELETE" })).status, 401);
  const r = await fetch(`${base}/api/notes/a.md`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${base}/n/a.md`)).status, 404);
  const vs = await (await fetch(`${base}/api/notes/a.md/versions`)).json();
  assert.equal(vs.versions.length, 2);
});

test("assets outside the notes dir are unreachable", async () => {
  assert.equal((await fetch(`${base}/n/..%2F..%2Fetc%2Fpasswd`)).status, 400);
  assert.equal((await fetch(`${base}/n/.versions/a/x.md`)).status, 400);
  assert.equal((await fetch(`${base}/assets/../package.json`)).status, 404);
});

test("short links resolve, can be chosen, and never shadow routes", async () => {
  const r = await put("links/a.md", "# Linked\n\nbody");
  const j = await r.json();
  assert.match(j.slug, /^[a-z]+-[a-z]+-[a-z]+$/);
  assert.equal(j.url, `${base}/${j.slug}`);
  assert.equal(j.pathUrl, `${base}/n/links/a.md`);

  const page = await fetch(`${base}/${j.slug}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1 id="linked">Linked<\/h1>/);

  const custom = await (await put("links/a.md?slug=my-doc", "# Linked\n\nbody v2")).json();
  assert.equal(custom.slug, "my-doc");
  assert.equal((await fetch(`${base}/my-doc`)).status, 200);
  assert.equal((await fetch(`${base}/${j.slug}`)).status, 404, "old slug released");
  assert.equal((await put("links/b.md?slug=my-doc", "x")).status, 400, "taken");
  assert.equal((await put("links/b.md?slug=api", "x")).status, 400, "reserved");

  assert.equal((await fetch(`${base}/nope-nope-nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/notes`)).status, 200, "api still routes");
  const list = await (await fetch(`${base}/api/notes`)).json();
  assert.ok(list.notes.every((n) => n.slug && n.url.endsWith(`/${n.slug}`)));
});

test("export zips the selected notes, or all of them, with folders kept", async () => {
  const { entries } = await import("./zip.test.js");
  const mermaid = "# Flow\n\n```mermaid\ngraph TD; A-->B\n```\n";
  assert.equal((await put("zip/one.md", "# One\n")).status, 201);
  assert.equal((await put("zip/deep/flow.md", mermaid)).status, 201);

  const r = await fetch(`${base}/export?path=zip/one.md&path=zip/deep/flow.md`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip");
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="notes-\d{4}-\d{2}-\d{2}\.zip"$/);
  const got = entries(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(got.map((e) => e.name), ["zip/one.md", "zip/deep/flow.md"]);
  assert.equal(got[1].data, mermaid, "Mermaid source travels as written");

  const one = await fetch(`${base}/export?path=zip/deep/flow.md`);
  assert.match(one.headers.get("content-disposition"), /filename="zip-deep-flow-/);

  const all = entries(Buffer.from(await (await fetch(`${base}/export`)).arrayBuffer()));
  const listed = (await (await fetch(`${base}/api/notes`)).json()).notes.map((n) => n.path).sort();
  assert.deepEqual(all.map((e) => e.name).sort(), listed, "no ?path means every note");

  assert.equal((await fetch(`${base}/export?path=zip/one.md&path=zip/missing.md`)).status, 404);
  assert.equal((await fetch(`${base}/export?path=..%2Fx.md`)).status, 400);
  assert.equal((await put("zip/x.md?slug=export", "x")).status, 400, "export is a reserved slug");

  const idx = await (await fetch(`${base}/all`)).text();
  assert.match(idx, /<form id="export-form" method="get" action="\/export">/);
  assert.match(idx, /<input type="checkbox" name="path" value="zip\/deep\/flow\.md"/);
  assert.match(idx, /id="export-selected"/);
});

test("note page embeds the Markdown source intact, even around </script", async () => {
  const md = "# Edge\n\n```html\n<!-- c -->\n<script>x</script>\n```\n";
  assert.equal((await put("edge.md", md)).status, 201);
  const page = await (await fetch(`${base}/n/edge.md`)).text();
  const m = page.match(/<script id="note-source" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, "source block present and not cut short");
  assert.equal(JSON.parse(m[1]), md);
});

test("home is the review queue; every note stays listed under /all", async () => {
  await put("queue/one.md", "# Queue one\n\nfirst draft\n");
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /<body class="dash">/);
  assert.match(home, /To review/);
  assert.match(home, /Queue one/);
  const all = await (await fetch(`${base}/all`)).text();
  assert.match(all, /id="export-form"/);
  assert.match(all, /Queue one/);
});

test("reviewing a note moves it through the queue and a new publish brings it back", async () => {
  const patch = (action) => fetch(`${base}/api/notes/queue/one.md/review`, { method: "PATCH", body: JSON.stringify({ action }) });
  const state = async () => (await (await fetch(`${base}/api/notes/queue/one.md/review`)).json());

  assert.equal((await state()).state, "review");
  let page = await (await fetch(`${base}/n/queue/one.md`)).text();
  assert.match(page, /id="reviewbar"/);
  assert.match(page, /data-action="reviewed"/);
  assert.equal(page.match(/data-action="settle"/g).length, 2, "choices at the top and again after the note");
  assert.match(page, /<div class="stickyhead">\s*<div class="toolbar"[\s\S]*id="reviewbar"[\s\S]*?<\/div>\s*<\/div>\s*<main>/, "the review bar travels with the toolbar");
  assert.ok(page.indexOf("reviewfoot") > page.indexOf("</article>"), "and the last copy sits after the article, outside it");

  // No token needed: it is the reviewer's own bookkeeping, like comments.
  const r = await patch("reviewed");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state, "refining");
  let queue = await (await fetch(`${base}/api/review`)).json();
  assert.equal(queue.counts.refining, 1);
  assert.deepEqual((await (await fetch(`${base}/api/review?state=refining`)).json()).notes.map((n) => n.path), ["queue/one.md"]);

  assert.equal((await (await patch("settle")).json()).state, "settled");
  page = await (await fetch(`${base}/n/queue/one.md`)).text();
  assert.match(page, /state-settled/);

  assert.equal((await put("queue/one.md", "# Queue one\n\nsecond draft\n")).status, 200);
  const back = await state();
  assert.equal(back.state, "review");
  assert.equal(back.changed, true);
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /changed since you read it/);

  assert.equal((await patch("nope")).status, 400);
  assert.equal((await fetch(`${base}/api/review?state=bogus`)).status, 400);
  assert.equal((await fetch(`${base}/api/notes/missing.md/review`)).status, 404);
});

test("the diff page shows what changed since the version you reviewed, with comments on the new side", async () => {
  const review = (action) => fetch(`${base}/api/notes/diff/d.md/review`, { method: "PATCH", body: JSON.stringify({ action }) });
  await put("diff/d.md", "# D\n\nkeep this\n\nremove this\n");
  await review("reviewed");
  await put("diff/d.md", "# D\n\nkeep this\n\nadded this\n");

  const page = await fetch(`${base}/diff/diff/d.md`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /class="drow changed"/);
  assert.match(html, /remove this/);
  assert.match(html, /added this/);
  assert.match(html, /<article id="note"/);
  assert.match(html, /id="toggle-comments"/);
  assert.match(html, /data-layout="split"/);
  assert.match(html, /<a class="btn" href="\/[^"?]+" title="Leave the diff/, "a way out of the diff to the plain page");

  const vs = (await (await fetch(`${base}/api/notes/diff/d.md/versions`)).json()).versions;
  const explicit = await (await fetch(`${base}/diff/diff/d.md?from=${vs[1].id}&to=${vs[0].id}`)).text();
  assert.match(explicit, /class="drow changed"/);
  const old = await (await fetch(`${base}/diff/diff/d.md?from=${vs[0].id}&to=${vs[1].id}`)).text();
  assert.match(old, new RegExp(`data-version="${vs[1].id}"`), "comments on an old target are made against that version");
  assert.match(old, new RegExp(`href="/[^"?]+\\?v=${vs[1].id}" title="Leave the diff`), "View page opens the version being compared");

  assert.equal((await fetch(`${base}/diff/missing.md`)).status, 404);
  // Same trap as /n/.versions/x.md: a bad path must be a 400, not a crash.
  assert.equal((await fetch(`${base}/diff/.versions/x.md`)).status, 400);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("settle-before settles old unreviewed notes and keeps today's", async () => {
  const before = new Date(Date.now() + 60_000).toISOString();
  const r = await fetch(`${base}/api/review/settle-before`, { method: "POST", body: JSON.stringify({ before }) });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.ok(out.settled >= 1);
  assert.equal((await fetch(`${base}/api/review/settle-before`, { method: "POST", body: "{}" })).status, 400);
  assert.equal((await fetch(`${base}/api/review/settle-before`, { method: "POST", body: "nope" })).status, 400);
});

test("bulk settles several notes at once, or none if one is missing", async () => {
  await put("bulk/a.md", "# Bulk a\n\nzorbleplex\n");
  await put("bulk/b.md", "# Bulk b\n\nzorbleplex\n");
  await put("bulk/c.md", "# Bulk c\n\nzorbleplex\n");
  const bulk = (body) => fetch(`${base}/api/review/bulk`, { method: "POST", body: JSON.stringify(body) });
  const state = async (p) => (await (await fetch(`${base}/api/notes/${p}/review`)).json()).state;

  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /<input type="checkbox" class="pick" name="path" value="bulk\/a.md"/);
  assert.match(home, /id="bulkbar"/);

  // One bad path and nothing changes.
  assert.equal((await bulk({ action: "settle", paths: ["bulk/a.md", "bulk/missing.md"] })).status, 404);
  assert.equal(await state("bulk/a.md"), "review");

  const r = await bulk({ action: "settle", paths: ["bulk/a.md", "bulk/b.md", "bulk/a.md"] });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out.notes.map((n) => [n.path, n.state]), [["bulk/a.md", "settled"], ["bulk/b.md", "settled"]]);
  assert.equal(await state("bulk/c.md"), "review");

  assert.equal((await bulk({ action: "nope", paths: ["bulk/c.md"] })).status, 400);
  assert.equal((await bulk({ action: "settle", paths: [] })).status, 400);
  assert.equal((await bulk({ action: "settle" })).status, 400);
  assert.equal((await fetch(`${base}/api/review/bulk`, { method: "POST", body: "nope" })).status, 400);
});

test("the queue can be filtered by search words, keeping its groups", async () => {
  await put("filter/plum.md", "# Quillfeather plan\n\nabout vexmorrow\n");
  await put("filter/pear.md", "# Pear notes\n\nnothing to see\n");
  await fetch(`${base}/api/review/bulk`, { method: "POST", body: JSON.stringify({ action: "reset", paths: ["filter/plum.md", "filter/pear.md"] }) });

  const page = await (await fetch(`${base}/?q=vexmorow`)).text();
  assert.match(page, /Quillfeather plan/, "typos forgiven, as in search");
  assert.doesNotMatch(page, /Pear notes/);
  assert.match(page, /1 note in the queue matches/);
  assert.match(page, /<mark>vexmorrow<\/mark>/);
  assert.match(page, /href="\/[^"?]+\?q=vexmorow"/, "opening a match carries the words for highlighting");
  assert.doesNotMatch(page, /id="settle-old"/, "the catch-up button acts on everything, so it hides under a filter");

  const none = await (await fetch(`${base}/?q=qqqzzzxxx`)).text();
  assert.match(none, /Nothing in the queue matches/);
  assert.match(await (await fetch(`${base}/`)).text(), /Pear notes/);
});

test("review routes cannot be shadowed by a custom slug", async () => {
  for (const slug of ["all", "diff", "search"]) {
    const r = await put(`slug-${slug}.md?slug=${slug}`, "# x\n");
    assert.equal(r.status, 400, slug);
  }
});

// Slugs are searchable and random, so words from the slug lists (animals,
// verbs) can match other notes. These tests use invented words to stay out of that.
test("search finds notes by words, typos, paths and slugs, and the API says where", async () => {
  await put("search/caching.md", "# Caching strategy\n\nWe keep a warm cache in front of the database so that dashboards load quickly.\n");
  await put("search/other.md", "# Unrelated\n\nNothing to see here, only gardening.\n");

  const api = async (q, extra = "") => (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}${extra}`)).json();
  const hit = await api("dashbords database");
  assert.equal(hit.total, 1);
  const r = hit.results[0];
  assert.equal(r.path, "search/caching.md");
  assert.equal(r.title, "Caching strategy");
  assert.match(r.snippet, /dashboards/);
  assert.ok(r.highlights.length >= 1);
  assert.equal(r.snippet.slice(...r.highlights[0]).length > 0, true);
  assert.equal(r.state, "review");
  assert.match(r.url, new RegExp(`/${r.slug}$`));

  assert.equal((await api("caching")).results[0].path, "search/caching.md", "title match");
  assert.equal((await api("search")).total >= 2, true, "path match");
  assert.equal((await api(r.slug)).results[0].path, "search/caching.md", "slug match");
  assert.equal((await api('"warm cache"')).total, 1);
  assert.equal((await api('"cache warm"')).total, 0);
  assert.equal((await api("qzxvwk")).total, 0);
  assert.equal((await api("a", "&limit=1")).results.length <= 1, true);

  assert.equal((await fetch(`${base}/api/search`)).status, 400);
  assert.equal((await fetch(`${base}/api/search?q=%20`)).status, 400);
});

test("search results page, the header box, and highlights carried into the note", async () => {
  const page = await (await fetch(`${base}/search?q=${encodeURIComponent("warm <cache>")}`)).text();
  assert.match(page, /<body class="search">/);
  assert.match(page, /name="q" value="warm &lt;cache&gt;"/, "the query is escaped");
  const results = await (await fetch(`${base}/search?q=warm+cache`)).text();
  assert.match(results, /<mark>warm<\/mark> <mark>cache<\/mark>/);
  assert.match(results, /Caching strategy/);
  assert.match(await (await fetch(`${base}/search`)).text(), /Every word has to appear/);
  assert.match(await (await fetch(`${base}/all`)).text(), /<form class="search" action="\/search"/);

  const slug = (await (await fetch(`${base}/api/search?q=database`)).json()).results[0].slug;
  const note = await (await fetch(`${base}/${slug}?q=warm+cashe`)).text();
  assert.match(note, /data-hits="\[[^"]*warm/);
  assert.doesNotMatch(await (await fetch(`${base}/${slug}`)).text(), /data-hits/);
});

test("search ignores deleted notes and notices edits", async () => {
  const find = async (q) => (await (await fetch(`${base}/api/search?q=${q}`)).json()).total;
  await put("search/temp.md", "# Temp\n\nfrobnicate habitat\n");
  assert.equal(await find("frobnicate"), 1);
  await put("search/temp.md", "# Temp\n\nquuxify habitat\n");
  assert.equal(await find("frobnicate"), 0);
  assert.equal(await find("quuxify"), 1);
  await fetch(`${base}/api/notes/search/temp.md`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(await find("quuxify"), 0);
});

test("monitor probe notes stay out of the review queue and search", async () => {
  assert.equal((await put("_probe/roundtrip.md", "# probe\n\nfixture zzprobeword\n")).status < 300, true);
  assert.equal((await put("_probe/roundtrip.md", "# probe\n\nfixture zzprobeword two\n")).status, 200);
  const queue = await (await fetch(`${base}/api/review`)).json();
  assert.equal(queue.notes.some((n) => n.path.startsWith("_probe/")), false);
  assert.match(await (await fetch(`${base}/all`)).text(), /_probe\/roundtrip\.md/, "still in the archive");
  assert.equal((await (await fetch(`${base}/api/search?q=zzprobeword`)).json()).total, 0);
  const page = await (await fetch(`${base}/n/_probe/roundtrip.md`)).text();
  assert.doesNotMatch(page, /id="reviewbar"/);
  assert.match(page, /<article id="note"/, "the page itself still renders");
});

test("a note published again after review lists its changed blocks for the page to mark", async () => {
  await put("marks/m.md", "# M\n\nkeep\n\nold text here\n");
  await fetch(`${base}/api/notes/marks/m.md/review`, { method: "PATCH", body: JSON.stringify({ action: "reviewed" }) });
  const unchanged = await (await fetch(`${base}/n/marks/m.md`)).text();
  assert.doesNotMatch(unchanged, /data-changes/);

  await put("marks/m.md", "# M\n\nkeep\n\nnew text here\n\nbrand new block\n");
  const page = await (await fetch(`${base}/n/marks/m.md`)).text();
  const m = /data-changes="([^"]*)"/.exec(page);
  assert.ok(m, "changes are listed");
  assert.deepEqual(JSON.parse(m[1].replaceAll("&quot;", '"')), { total: 4, blocks: [2, 3] });
  assert.match(page, /id="show-changes"/);
  const old = await (await fetch(`${base}/n/marks/m.md?v=${(await (await fetch(`${base}/api/notes/marks/m.md/versions`)).json()).versions[1].id}`)).text();
  assert.doesNotMatch(old, /data-changes/, "an old version has nothing to mark");
});

test("posting a comment over the API moves the note to refining and the page shows it", async () => {
  await put("rc/n.md", "# RC\n\nplease reword this sentence\n");
  const state = async () => (await (await fetch(`${base}/api/notes/rc/n.md/review`)).json()).state;
  assert.equal(await state(), "review");
  const r = await fetch(`${base}/api/notes/rc/n.md/comments`, { method: "POST", body: JSON.stringify({ quote: "reword this", body: "too stiff" }) });
  assert.equal(r.status, 201);
  assert.equal(await state(), "refining");
  const page = await (await fetch(`${base}/n/rc/n.md`)).text();
  assert.match(page, /state-refining/);
  assert.doesNotMatch(page, /data-action="reviewed"/);
});

test("a published-copy link is recorded, shown, and flagged to whoever publishes next", async () => {
  const url = "https://example.atlassian.net/wiki/spaces/T/pages/42/Doc";
  await put("links/doc.md", "# Doc\n\nfirst draft\n");
  const link = (method, body) => fetch(`${base}/api/notes/links/doc.md/link`, { method, body: body && JSON.stringify(body) });

  assert.equal((await (await link("GET")).json()).link, null);
  assert.equal((await link("PUT", { url: "javascript:alert(1)" })).status, 400);
  assert.equal((await link("PUT", {})).status, 400, "nothing to keep yet");
  const set = await (await link("PUT", { url })).json();
  assert.equal(set.link.label, "Confluence");
  assert.equal(set.link.stale, false);

  const page = await (await fetch(`${base}/n/links/doc.md`)).text();
  assert.match(page, /Open in Confluence/);
  assert.doesNotMatch(page, /out of date/);
  assert.match(await (await fetch(`${base}/all`)).text(), /↗ Confluence/);

  // The agent that publishes next is told the published copy is behind.
  const again = await (await put("links/doc.md", "# Doc\n\nsecond draft\n")).json();
  assert.equal(again.link.stale, true);
  assert.equal(again.link.url, url);
  assert.equal((await (await fetch(`${base}/api/links?stale=1`)).json()).links.some((l) => l.path === "links/doc.md"), true);
  const row = (await (await fetch(`${base}/api/review`)).json()).notes.find((n) => n.path === "links/doc.md");
  assert.equal(row.link.stale, true);
  assert.equal((await (await fetch(`${base}/api/notes/links/doc.md`)).json()).link.stale, true);
  const stalePage = await (await fetch(`${base}/n/links/doc.md`)).text();
  assert.match(stalePage, /out of date/);
  assert.match(stalePage, new RegExp(`/diff/links/doc\\.md\\?from=`));
  assert.match(await (await fetch(`${base}/`)).text(), /Confluence out of date/);

  assert.equal((await (await link("PUT", {})).json()).link.stale, false);
  assert.equal((await (await fetch(`${base}/api/links?stale=1`)).json()).links.some((l) => l.path === "links/doc.md"), false);
  assert.equal((await (await link("DELETE")).json()).link, null);
  assert.equal((await fetch(`${base}/api/notes/links/missing.md/link`)).status, 404);
  assert.equal((await put("links/new.md", "# New\n")).status, 201);
});
