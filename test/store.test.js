import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, safePath, BadPath } from "../src/store.js";

async function tmpStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "clipmark-"));
  const s = new Store(dir);
  await s.init();
  return { s, dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test("safePath accepts nested notes and rejects escapes", () => {
  assert.equal(safePath("team/design doc.md"), "team/design doc.md");
  assert.equal(safePath("/leading.md"), "leading.md");
  assert.equal(safePath("a//b.md"), "a/b.md");
  assert.equal(safePath("_probe/round-trip.md"), "_probe/round-trip.md");
  for (const bad of ["../x.md", "a/../b.md", ".hidden.md", "x.txt", "", "dir/.versions/x.md", "x.md/"]) {
    assert.throws(() => safePath(bad), BadPath, bad);
  }
});

test("writes are versioned and identical writes are no-ops", async () => {
  const { s, done } = await tmpStore();
  try {
    const a = await s.write("n.md", "# one\n");
    assert.equal(a.created, true);
    assert.equal(a.changed, true);
    const again = await s.write("n.md", "# one\n");
    assert.equal(again.changed, false);
    assert.equal(again.version, a.version);
    const b = await s.write("n.md", "# two\n");
    assert.equal(b.created, false);
    assert.notEqual(b.version, a.version);

    const vs = await s.versions("n.md");
    assert.equal(vs.length, 2);
    assert.equal(vs[0].id, b.version, "newest first");
    assert.equal(vs[0].n, 2);
    assert.equal((await s.readVersion("n.md", a.version)).markdown, "# one\n");
    assert.equal((await s.read("n.md")).markdown, "# two\n");

    await s.remove("n.md");
    assert.equal(await s.exists("n.md"), false);
    assert.equal((await s.versions("n.md")).length, 2, "history survives delete");
    assert.deepEqual(await s.list(), []);
  } finally { await done(); }
});

test("list skips the history directory and sorts newest first", async () => {
  const { s, done } = await tmpStore();
  try {
    await s.write("old.md", "a");
    await new Promise((r) => setTimeout(r, 10));
    await s.write("sub/new.md", "b");
    const l = await s.list();
    assert.deepEqual(l.map((n) => n.path), ["sub/new.md", "old.md"]);
  } finally { await done(); }
});

test("assetPath never leaves the notes directory", async () => {
  const { s, done } = await tmpStore();
  try {
    assert.ok(s.assetPath("img/a.png").startsWith(s.root));
    assert.throws(() => s.assetPath("../etc/passwd"), BadPath);
    assert.throws(() => s.assetPath(".versions/x.md"), BadPath);
  } finally { await done(); }
});

test("slugs: assigned once, kept across versions and delete, customisable", async () => {
  const { s, done } = await tmpStore();
  try {
    const a = await s.write("team/design.md", "# one\n");
    assert.match(a.slug, /^[a-z]+-[a-z]+-[a-z]+$/);
    const b = await s.write("team/design.md", "# two\n");
    assert.equal(b.slug, a.slug, "slug survives a new version");
    assert.equal(s.pathOf(a.slug), "team/design.md");
    assert.equal((await s.read("team/design.md")).slug, a.slug);
    assert.equal((await s.list())[0].slug, a.slug);

    await s.remove("team/design.md");
    const c = await s.write("team/design.md", "# three\n");
    assert.equal(c.slug, a.slug, "slug survives delete + re-publish");

    const d = await s.write("team/design.md", "# four\n", { slug: "retry-design" });
    assert.equal(d.slug, "retry-design");
    assert.equal(s.pathOf("retry-design"), "team/design.md");
    assert.equal(s.pathOf(a.slug), null, "old slug released");

    await s.write("other.md", "x");
    await assert.rejects(() => s.write("other.md", "y", { slug: "retry-design" }), /already points at team\/design.md/);
    await assert.rejects(() => s.write("other.md", "y", { slug: "api" }), /reserved/);
    await assert.rejects(() => s.write("other.md", "y", { slug: "Bad Slug" }), /slug must be/);

    // Persisted: a fresh Store over the same dir sees the same mapping.
    const s2 = new Store(s.root); await s2.init();
    assert.equal(s2.pathOf("retry-design"), "team/design.md");
  } finally { await done(); }
});
