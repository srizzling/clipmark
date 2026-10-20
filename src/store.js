// Notes are plain .md files under NOTES_DIR. Every publish that changes a note
// also drops a copy under NOTES_DIR/.versions/<note>/<timestamp>.md, so the
// history is just more files: readable with ls, restorable with cp, and it
// survives the app being replaced by something else.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomInt, createHash } from "node:crypto";
import { ADJECTIVES, ANIMALS, VERBS } from "./words.js";
import { locate, paragraphAround } from "./comments.js";
import { titleOf } from "./render.js";

const VERSIONS = ".versions";
const COMMENTS = ".comments";
const SLUGS = ".slugs.json";
const REVIEWS = ".review.json";
const VERSION_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}\.[0-9]{3}Z$/;
const LIMITS = { quote: 4000, body: 5000, context: 200, pattern: 60 };
export const KINDS = ["comment", "slop"];
// reviewed: "I have read it, it needs more work". settle: "done". reset: back to the queue.
export const REVIEW_ACTIONS = ["reviewed", "settle", "reset"];
export const REVIEW_STATES = ["review", "refining", "settled"];
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// First path segments the server owns; a slug may not shadow them.
export const RESERVED = new Set(["n", "raw", "edit", "new", "export", "api", "assets", "vendor", "healthz", "all", "diff", "llms.txt", "favicon.ico", "robots.txt"]);

export class BadSlug extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

export function validSlug(s) {
  if (typeof s !== "string" || s.length < 3 || s.length > 64 || !SLUG_RE.test(s)) {
    throw new BadSlug("slug must be 3-64 chars of a-z, 0-9 and single hyphens");
  }
  if (RESERVED.has(s)) throw new BadSlug(`"${s}" is reserved`);
  return s;
}

const pick = (arr) => arr[randomInt(arr.length)];
export const randomSlug = () => `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${pick(VERBS)}`;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._ -]*$/;

export class BadPath extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

export class BadReview extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export class BadComment extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const text = (v, name, max, required = true) => {
  if (v == null || v === "") {
    if (required) throw new BadComment(`${name} required`);
    return "";
  }
  if (typeof v !== "string") throw new BadComment(`${name} must be a string`);
  if (v.length > max) throw new BadComment(`${name} is longer than ${max} characters`);
  return v;
};

export function safePath(p) {
  if (typeof p !== "string" || !p) throw new BadPath("path required");
  let rel = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  try { rel = decodeURIComponent(rel); } catch { throw new BadPath("bad encoding"); }
  if (!rel.endsWith(".md")) throw new BadPath("notes must end in .md");
  const parts = rel.split("/");
  for (const seg of parts) {
    if (!SEGMENT.test(seg)) throw new BadPath(`invalid path segment: ${JSON.stringify(seg)}`);
    if (seg === "." || seg === "..") throw new BadPath("relative segments not allowed");
  }
  return parts.join("/");
}

const hashOf = (markdown) => createHash("sha256").update(markdown).digest("hex").slice(0, 16);

// Where a note is in review is worked out, not stored: the record only says
// what the reviewer last did and to which content. A new publish changes the
// content, so the note drops back to "review" without anyone telling us.
export function reviewStateOf(record, hash) {
  if (!record) return { state: "review", changed: false };
  if (record.hash !== hash) return { state: "review", changed: true };
  return { state: record.settled ? "settled" : "refining", changed: false };
}

function stamp(d = new Date()) {
  // 2026-09-02T10-15-00.123Z : sortable, filesystem-safe, human-readable.
  return d.toISOString().replace(/:/g, "-");
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.slugs = new Map();    // slug -> path
    this.bySlugPath = new Map(); // path -> slug
    this.slugsFile = path.join(this.root, SLUGS);
    this.saving = Promise.resolve();
    this.commenting = Promise.resolve();
    this.reviews = new Map();    // path -> { hash, version, reviewedAt, settled }
    this.reviewsFile = path.join(this.root, REVIEWS);
    this.reviewing = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.join(this.root, VERSIONS), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.slugsFile, "utf8"));
      for (const [slug, p] of Object.entries(raw)) { this.slugs.set(slug, p); this.bySlugPath.set(p, slug); }
    } catch { /* first run */ }
    try {
      for (const [p, rec] of Object.entries(JSON.parse(await fs.readFile(this.reviewsFile, "utf8")))) this.reviews.set(p, rec);
    } catch { /* nothing reviewed yet */ }
  }

  // Slugs live in one small JSON file. Writes go through a chain so two
  // publishes cannot interleave, and land via rename so a crash mid-write
  // leaves the previous file rather than half of a new one.
  saveSlugs() {
    this.saving = this.saving.then(async () => {
      const obj = Object.fromEntries([...this.slugs.entries()].sort());
      const tmp = `${this.slugsFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
      await fs.rename(tmp, this.slugsFile);
    });
    return this.saving;
  }

  slugOf(rel) { return this.bySlugPath.get(safePath(rel)) ?? null; }
  pathOf(slug) { return this.slugs.get(slug) ?? null; }

  // Every note has exactly one slug, assigned on first sight and kept for
  // life (across versions, and across a delete followed by a re-publish).
  // A custom slug replaces the current one; the old one stops resolving.
  async ensureSlug(rel, custom = null) {
    const p = safePath(rel);
    const current = this.bySlugPath.get(p);
    if (custom) {
      validSlug(custom);
      const owner = this.slugs.get(custom);
      if (owner && owner !== p) throw new BadSlug(`"${custom}" already points at ${owner}`);
      if (owner === p) return custom;
      if (current) this.slugs.delete(current);
      this.slugs.set(custom, p); this.bySlugPath.set(p, custom);
      await this.saveSlugs();
      return custom;
    }
    if (current) return current;
    let slug = randomSlug();
    while (this.slugs.has(slug) || RESERVED.has(slug)) slug = randomSlug();
    this.slugs.set(slug, p); this.bySlugPath.set(p, slug);
    await this.saveSlugs();
    return slug;
  }

  file(rel) { return path.join(this.root, safePath(rel)); }
  versionDir(rel) { return path.join(this.root, VERSIONS, safePath(rel).replace(/\.md$/, "")); }

  async writable() {
    try { await fs.access(this.root, fs.constants.W_OK); return true; } catch { return false; }
  }

  async list() {
    const out = [];
    const walk = async (dir, prefix) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
        else if (e.isFile() && e.name.endsWith(".md")) {
          const st = await fs.stat(path.join(dir, e.name));
          out.push({ path: rel, slug: await this.ensureSlug(rel), mtime: st.mtime.toISOString(), size: st.size });
        }
      }
    };
    await walk(this.root, "");
    out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return out;
  }

  async read(rel) {
    const f = this.file(rel);
    const [markdown, st] = await Promise.all([fs.readFile(f, "utf8"), fs.stat(f)]);
    return { path: safePath(rel), slug: await this.ensureSlug(rel), markdown, mtime: st.mtime.toISOString(), size: st.size };
  }

  async exists(rel) {
    const f = this.file(rel); // throws BadPath before touching the disk
    try { await fs.access(f); return true; } catch { return false; }
  }

  async versions(rel) {
    const dir = this.versionDir(rel);
    let names;
    try { names = await fs.readdir(dir); } catch { return []; }
    const vs = [];
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      const st = await fs.stat(path.join(dir, n));
      vs.push({ id: n.slice(0, -3), size: st.size });
    }
    vs.sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first
    return vs.map((v, i) => ({ ...v, n: vs.length - i }));
  }

  async readVersion(rel, id) {
    if (!VERSION_ID.test(id)) {
      throw new BadPath("bad version id");
    }
    const f = path.join(this.versionDir(rel), `${id}.md`);
    const [markdown, st] = await Promise.all([fs.readFile(f, "utf8"), fs.stat(f)]);
    return { path: safePath(rel), slug: await this.ensureSlug(rel), version: id, markdown, mtime: st.mtime.toISOString(), size: st.size };
  }

  // Returns { path, changed, version, created }. Identical content is a no-op,
  // so re-publishing an unchanged file does not mint an empty revision.
  async write(rel, markdown, { slug: customSlug = null } = {}) {
    const f = this.file(rel);
    const slug = await this.ensureSlug(rel, customSlug);
    let existing = null;
    try { existing = await fs.readFile(f, "utf8"); } catch { /* new note */ }
    if (existing === markdown) {
      const vs = await this.versions(rel);
      return { path: safePath(rel), slug, changed: false, created: false, version: vs[0]?.id ?? null };
    }
    await fs.mkdir(path.dirname(f), { recursive: true });
    const vdir = this.versionDir(rel);
    await fs.mkdir(vdir, { recursive: true });
    let id = stamp();
    // Two publishes inside one millisecond: nudge rather than overwrite.
    while (await this.exists_(path.join(vdir, `${id}.md`))) {
      id = stamp(new Date(Date.now() + 1));
    }
    await fs.writeFile(path.join(vdir, `${id}.md`), markdown);
    await fs.writeFile(f, markdown);
    return { path: safePath(rel), slug, changed: true, created: existing === null, version: id };
  }

  async exists_(abs) {
    try { await fs.access(abs); return true; } catch { return false; }
  }

  // Removes the current file; history is kept on purpose.
  async remove(rel) {
    await fs.unlink(this.file(rel));
  }

  // Review comments live beside the versions, one JSON file per note, so they
  // are as easy to read and back up as the notes themselves. A comment records
  // the version it was made on; where it points *now* is worked out on read.
  commentsFile(rel) { return path.join(this.root, COMMENTS, safePath(rel).replace(/\.md$/, "") + ".json"); }

  async loadComments(rel) {
    try {
      return JSON.parse(await fs.readFile(this.commentsFile(rel), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return { next: 1, comments: [] };
      throw e;
    }
  }

  // Read-modify-write behind a chain, so two comments posted together cannot
  // lose one another. Nothing is written if `fn` throws.
  editComments(rel, fn) {
    const run = this.commenting.then(async () => {
      const data = await this.loadComments(rel);
      const result = await fn(data);
      const f = this.commentsFile(rel);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
      await fs.rename(tmp, f);
      return result;
    });
    this.commenting = run.catch(() => {});
    return run;
  }

  async addComment(rel, input) {
    const quote = text(input.quote, "quote", LIMITS.quote).replace(/\s+/g, " ").trim();
    const kind = input.kind ?? "comment";
    if (!KINDS.includes(kind)) throw new BadComment(`kind must be one of ${KINDS.join(", ")}`);
    // Flagging text as slop can be a bare click; an ordinary comment needs words.
    const body = text(input.body, "comment", LIMITS.body, kind === "comment").trim();
    if (!quote) throw new BadComment("quote required");
    if (!body && kind === "comment") throw new BadComment("comment required");
    const pattern = text(input.pattern, "pattern", LIMITS.pattern, false).trim().toLowerCase();
    if (pattern && kind !== "slop") throw new BadComment("pattern only applies to kind slop");
    const prefix = text(input.prefix, "prefix", LIMITS.context, false);
    const suffix = text(input.suffix, "suffix", LIMITS.context, false);
    let version = input.version || null;
    if (version !== null && !VERSION_ID.test(version)) throw new BadComment("bad version id");
    if (!(await this.exists(rel))) throw new BadComment(`no note at ${rel}`, 404);
    version ??= (await this.versions(rel))[0]?.id ?? null;
    return this.editComments(rel, (data) => {
      const c = { id: `c${data.next++}`, kind, ...(pattern && { pattern }), quote, prefix, suffix, body, version, status: "open", created: new Date().toISOString() };
      data.comments.push(c);
      return c;
    });
  }

  // patch: { status: "open" | "resolved", resolution, body }. Resolving stamps
  // the time; reopening clears the stamp and the resolution.
  async updateComment(rel, id, patch) {
    const { status, resolution, body } = patch ?? {};
    if (status === undefined && resolution === undefined && body === undefined) throw new BadComment("nothing to change");
    if (status !== undefined && status !== "open" && status !== "resolved") throw new BadComment('status must be "open" or "resolved"');
    const note = text(resolution, "resolution", LIMITS.body, false).trim();
    const edited = body === undefined ? null : text(body, "comment", LIMITS.body).trim();
    if (edited === "") throw new BadComment("comment required");
    return this.editComments(rel, (data) => {
      const c = data.comments.find((x) => x.id === id);
      if (!c) throw new BadComment(`no comment ${id} on ${rel}`, 404);
      if (edited !== null) c.body = edited;
      if (status === "resolved") { c.status = "resolved"; c.resolved = new Date().toISOString(); }
      if (status === "open") { c.status = "open"; delete c.resolved; delete c.resolution; }
      if (note && c.status === "resolved") c.resolution = note;
      return c;
    });
  }

  async removeComment(rel, id) {
    return this.editComments(rel, (data) => {
      const i = data.comments.findIndex((x) => x.id === id);
      if (i === -1) throw new BadComment(`no comment ${id} on ${rel}`, 404);
      data.comments.splice(i, 1);
    });
  }

  // Comments with where each one points in the note as it is now. `located:
  // false` means the quoted text is gone from the latest version (edited away,
  // usually because the comment was acted on); the quote is still returned.
  async listComments(rel, status = "open", kind = "all") {
    if (!["open", "resolved", "all"].includes(status)) throw new BadComment('status must be "open", "resolved" or "all"');
    if (kind !== "all" && !KINDS.includes(kind)) throw new BadComment(`kind must be "all" or one of ${KINDS.join(", ")}`);
    const [note, latest, { comments }] = await Promise.all([
      this.read(rel), this.versions(rel).then((v) => v[0]?.id ?? null), this.loadComments(rel),
    ]);
    const shown = comments.filter((c) => (status === "all" || c.status === status) && (kind === "all" || (c.kind ?? "comment") === kind)).map((c) => {
      const at = locate(note.markdown, c);
      return {
        id: c.id, kind: c.kind ?? "comment", pattern: c.pattern ?? null, status: c.status, quote: c.quote, comment: c.body,
        resolution: c.resolution ?? null, version: c.version, stale: c.version !== latest,
        created: c.created, resolved: c.resolved ?? null,
        located: !!at, line: at ? at.lines[0] : null, lines: at?.lines ?? null, source: at?.source ?? null,
        prefix: c.prefix, suffix: c.suffix,
      };
    });
    return { path: note.path, latest, comments: shown };
  }

  // Every slop flag across all notes, for people (or agents) who want to learn
  // from them. Unlike listComments this does not look at the note's current
  // text: the quote is the point, and it outlives the rewrite that removed it.
  // `context` is the paragraph the quote sat in, taken from the version the
  // flag was made on, so it still shows the original wording after a fix.
  async listSlop(status = "all") {
    if (!["open", "resolved", "all"].includes(status)) throw new BadComment('status must be "open", "resolved" or "all"');
    const base = path.join(this.root, COMMENTS);
    const out = [];
    const sources = new Map();
    const sourceOf = (note, version) => {
      const key = `${note}@${version}`;
      if (!sources.has(key)) {
        sources.set(key, (async () => {
          for (const get of [() => version && this.readVersion(note, version), () => this.read(note)]) {
            try { const n = await get(); if (n) return n.markdown; } catch { /* try the next source */ }
          }
          return null;
        })());
      }
      return sources.get(key);
    };
    const walk = async (dir, prefix) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
        else if (e.isFile() && e.name.endsWith(".json")) {
          let data;
          try { data = JSON.parse(await fs.readFile(path.join(dir, e.name), "utf8")); } catch { continue; }
          for (const c of data.comments ?? []) {
            if (c.kind !== "slop" || (status !== "all" && c.status !== status)) continue;
            const note = rel.replace(/\.json$/, ".md");
            const md = await sourceOf(note, c.version);
            const at = md && locate(md, c);
            out.push({
              note, title: md ? titleOf(md, note) : note, id: c.id, pattern: c.pattern ?? null, quote: c.quote,
              context: at ? paragraphAround(md, at) : null, feedback: c.body, status: c.status, resolution: c.resolution ?? null,
              created: c.created, resolved: c.resolved ?? null, version: c.version,
            });
          }
        }
      }
    };
    await walk(base, "");
    out.sort((a, b) => (a.created < b.created ? 1 : -1));
    return out;
  }

  // Review state. One small JSON file, written like the slugs: through a chain
  // so two clicks cannot interleave, and by rename so a crash leaves the old
  // file. The record holds the hash of the content that was reviewed and the
  // version it was, so "what changed since I read it" can be shown as a diff.
  saveReviews() {
    this.reviewing = this.reviewing.then(async () => {
      const obj = Object.fromEntries([...this.reviews.entries()].sort());
      const tmp = `${this.reviewsFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
      await fs.rename(tmp, this.reviewsFile);
    });
    return this.reviewing;
  }

  describeReview(rel, markdown) {
    const rec = this.reviews.get(safePath(rel)) ?? null;
    const { state, changed } = reviewStateOf(rec, hashOf(markdown));
    return { state, changed, reviewedAt: rec?.reviewedAt ?? null, reviewedVersion: rec?.version ?? null };
  }

  async reviewOf(rel) {
    const { markdown } = await this.read(rel);
    return { path: safePath(rel), ...this.describeReview(rel, markdown) };
  }

  // reviewed: read it, still refining. settle: done. reset: back to the queue.
  async setReview(rel, action) {
    if (!REVIEW_ACTIONS.includes(action)) throw new BadReview(`action must be one of ${REVIEW_ACTIONS.join(", ")}`);
    const p = safePath(rel);
    const { markdown } = await this.read(p);
    if (action === "reset") this.reviews.delete(p);
    else {
      this.reviews.set(p, {
        hash: hashOf(markdown), version: (await this.versions(p))[0]?.id ?? null,
        reviewedAt: new Date().toISOString(), settled: action === "settle",
      });
    }
    await this.saveReviews();
    return this.reviewOf(p);
  }

  // Every note with where it stands, newest first. `openComments` counts open
  // comments and slop flags, so the dashboard can say what is still unaddressed.
  async listReview() {
    const out = [];
    for (const n of await this.list()) {
      const { markdown } = await this.read(n.path);
      const r = this.describeReview(n.path, markdown);
      const [versions, { comments }] = await Promise.all([this.versions(n.path), this.loadComments(n.path)]);
      out.push({
        ...n, title: titleOf(markdown, n.path), ...r, versions: versions.length,
        openComments: comments.filter((c) => c.status === "open").length,
      });
    }
    return out;
  }

  // One-off catch-up for notes that existed before review did: every note that
  // has never been reviewed and was last changed before `before` is settled.
  // Anything newer stays in the queue.
  async settleBefore(before) {
    const cutoff = new Date(before);
    if (Number.isNaN(cutoff.getTime())) throw new BadReview("before must be a date");
    let settled = 0, kept = 0;
    for (const n of await this.list()) {
      if (this.reviews.has(n.path)) continue;
      if (new Date(n.mtime) >= cutoff) { kept++; continue; }
      const { markdown } = await this.read(n.path);
      this.reviews.set(n.path, {
        hash: hashOf(markdown), version: (await this.versions(n.path))[0]?.id ?? null,
        reviewedAt: new Date().toISOString(), settled: true,
      });
      settled++;
    }
    if (settled) await this.saveReviews();
    return { settled, kept };
  }

  // Any non-.md file under the notes dir (images referenced from notes).
  assetPath(rel) {
    const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    const abs = path.resolve(this.root, clean);
    if (!abs.startsWith(this.root + path.sep)) throw new BadPath("outside notes dir");
    if (clean.split("/").some((s) => s.startsWith(".") || s === "")) throw new BadPath("hidden path");
    return abs;
  }
}
