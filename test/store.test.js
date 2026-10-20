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

test("review state is derived: new notes queue, a publish re-queues, settle sticks to the content", async () => {
  const { s, done } = await tmpStore();
  try {
    await s.write("n.md", "# one\n");
    assert.equal((await s.reviewOf("n.md")).state, "review");

    const read = await s.setReview("n.md", "reviewed");
    assert.equal(read.state, "refining");
    assert.ok(read.reviewedAt);
    assert.equal(read.reviewedVersion, (await s.versions("n.md"))[0].id);

    assert.equal((await s.setReview("n.md", "settle")).state, "settled");

    // An agent rewrites it: back in the queue, and it says it has changed.
    await s.write("n.md", "# two\n");
    const again = await s.reviewOf("n.md");
    assert.equal(again.state, "review");
    assert.equal(again.changed, true);
    assert.ok(again.reviewedVersion, "the reviewed version is kept for the diff");

    // Restoring the reviewed content puts the state back too.
    await s.write("n.md", "# one\n");
    assert.equal((await s.reviewOf("n.md")).state, "settled");

    assert.equal((await s.setReview("n.md", "reset")).state, "review");
    await assert.rejects(() => s.setReview("n.md", "nope"), /action must be/);
  } finally { await done(); }
});

test("review state survives a restart and listReview reports state and open comments", async () => {
  const { s, dir, done } = await tmpStore();
  try {
    await s.write("a.md", "# A\n\nsome text here\n");
    await s.write("b.md", "# B\n");
    await s.setReview("a.md", "reviewed");
    await s.addComment("a.md", { quote: "some text", body: "tighten" });

    const fresh = new Store(dir);
    await fresh.init();
    const all = await fresh.listReview();
    const a = all.find((n) => n.path === "a.md"), b = all.find((n) => n.path === "b.md");
    assert.equal(a.state, "refining");
    assert.equal(a.openComments, 1);
    assert.equal(b.state, "review");
    assert.equal(all.length, 2);
  } finally { await done(); }
});

test("settleBefore settles only never-reviewed notes older than the cutoff", async () => {
  const { s, done } = await tmpStore();
  try {
    await s.write("old.md", "# old\n");
    await s.write("reviewed.md", "# r\n");
    await s.setReview("reviewed.md", "reviewed");
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await s.write("today.md", "# today\n");

    assert.deepEqual(await s.settleBefore(cutoff), { settled: 1, kept: 1 });
    assert.equal((await s.reviewOf("old.md")).state, "settled");
    assert.equal((await s.reviewOf("today.md")).state, "review");
    assert.equal((await s.reviewOf("reviewed.md")).state, "refining", "an existing review is not overridden");
    assert.deepEqual(await s.settleBefore(cutoff), { settled: 0, kept: 1 });
    await assert.rejects(() => s.settleBefore("not a date"), /before must be a date/);
  } finally { await done(); }
});

test("commenting on the current text moves a waiting or settled note to refining", async () => {
  const { s, done } = await tmpStore();
  try {
    await s.write("n.md", "# N\n\nsome words to comment on\n");
    assert.equal((await s.reviewOf("n.md")).state, "review");
    await s.addComment("n.md", { quote: "some words", body: "unclear" });
    const first = await s.reviewOf("n.md");
    assert.equal(first.state, "refining");
    assert.equal(first.changed, false);

    // Already refining: a second comment leaves the record alone.
    await s.addComment("n.md", { quote: "to comment", body: "also this" });
    assert.equal((await s.reviewOf("n.md")).reviewedAt, first.reviewedAt);

    // Settled, then a comment: it is not done any more.
    await s.setReview("n.md", "settle");
    await s.addComment("n.md", { quote: "words", kind: "slop" });
    assert.equal((await s.reviewOf("n.md")).state, "refining");

    // Published again, then a comment: it counts as read at the current text.
    await s.write("n.md", "# N\n\nsome other words to comment on\n");
    assert.equal((await s.reviewOf("n.md")).state, "review");
    await s.addComment("n.md", { quote: "other words", body: "better" });
    const after = await s.reviewOf("n.md");
    assert.equal(after.state, "refining");
    assert.equal(after.changed, false);
  } finally { await done(); }
});

test("a comment on an old version, resolving, and system notes do not change review state", async () => {
  const { s, done } = await tmpStore();
  try {
    const v1 = await s.write("n.md", "# N\n\nfirst words here\n");
    await s.write("n.md", "# N\n\nsecond words here\n");
    await s.addComment("n.md", { quote: "first words", body: "old", version: v1.version });
    assert.equal((await s.reviewOf("n.md")).state, "review", "made on a version that is no longer current");

    const c = await s.addComment("n.md", { quote: "second words", body: "now" });
    assert.equal((await s.reviewOf("n.md")).state, "refining");
    await s.setReview("n.md", "settle");
    await s.updateComment("n.md", c.id, { status: "resolved" });
    assert.equal((await s.reviewOf("n.md")).state, "settled", "resolving is not a review decision");

    await s.write("_probe/roundtrip.md", "# p\n\nfixture words\n");
    await s.addComment("_probe/roundtrip.md", { quote: "fixture words", body: "x" });
    assert.equal((await s.reviewOf("_probe/roundtrip.md")).state, "review", "monitor fixtures stay out of review");
  } finally { await done(); }
});
