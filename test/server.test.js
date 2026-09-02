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
  assert.match(html, /\/vendor\/mermaid\.min\.js/);

  const raw = await fetch(`${base}/raw/a.md`);
  assert.equal(await raw.text(), "# A\n\nhello v2");

  const vs = await (await fetch(`${base}/api/notes/a.md/versions`)).json();
  assert.equal(vs.versions.length, 2);
  const old = vs.versions[1].id;
  const oldPage = await (await fetch(`${base}/n/a.md?v=${old}`)).text();
  assert.match(oldPage, /Viewing version/);
  assert.match(oldPage, /<p>hello<\/p>/);
  assert.equal((await fetch(`${base}/raw/a.md?v=nope`)).status, 400);

  const list = await (await fetch(`${base}/api/notes`)).json();
  assert.deepEqual(list.notes.map((n) => n.title), ["A"]);
  const one = await (await fetch(`${base}/api/notes/a.md`)).json();
  assert.equal(one.markdown, "# A\n\nhello v2");
  assert.equal(one.versions.length, 2);
});

test("index lists notes and the mermaid bundle is served", async () => {
  const idx = await (await fetch(`${base}/`)).text();
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
  assert.match(await page.text(), /<h1>Linked<\/h1>/);

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
