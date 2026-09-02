// Notes are plain .md files under NOTES_DIR. Every publish that changes a note
// also drops a copy under NOTES_DIR/.versions/<note>/<timestamp>.md, so the
// history is just more files: readable with ls, restorable with cp, and it
// survives the app being replaced by something else.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { ADJECTIVES, ANIMALS, VERBS } from "./words.js";

const VERSIONS = ".versions";
const SLUGS = ".slugs.json";
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// First path segments the server owns; a slug may not shadow them.
export const RESERVED = new Set(["n", "raw", "edit", "new", "api", "assets", "vendor", "healthz", "llms.txt", "favicon.ico", "robots.txt"]);

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
  }

  async init() {
    await fs.mkdir(path.join(this.root, VERSIONS), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.slugsFile, "utf8"));
      for (const [slug, p] of Object.entries(raw)) { this.slugs.set(slug, p); this.bySlugPath.set(p, slug); }
    } catch { /* first run */ }
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
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}\.[0-9]{3}Z$/.test(id)) {
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

  // Any non-.md file under the notes dir (images referenced from notes).
  assetPath(rel) {
    const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    const abs = path.resolve(this.root, clean);
    if (!abs.startsWith(this.root + path.sep)) throw new BadPath("outside notes dir");
    if (clean.split("/").some((s) => s.startsWith(".") || s === "")) throw new BadPath("hidden path");
    return abs;
  }
}
