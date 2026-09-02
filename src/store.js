// Notes are plain .md files under NOTES_DIR. Every publish that changes a note
// also drops a copy under NOTES_DIR/.versions/<note>/<timestamp>.md, so the
// history is just more files: readable with ls, restorable with cp, and it
// survives the app being replaced by something else.

import { promises as fs } from "node:fs";
import path from "node:path";

const VERSIONS = ".versions";
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
  }

  async init() {
    await fs.mkdir(path.join(this.root, VERSIONS), { recursive: true });
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
          out.push({ path: rel, mtime: st.mtime.toISOString(), size: st.size });
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
    return { path: safePath(rel), markdown, mtime: st.mtime.toISOString(), size: st.size };
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
    return { path: safePath(rel), version: id, markdown, mtime: st.mtime.toISOString(), size: st.size };
  }

  // Returns { path, changed, version, created }. Identical content is a no-op,
  // so re-publishing an unchanged file does not mint an empty revision.
  async write(rel, markdown) {
    const f = this.file(rel);
    let existing = null;
    try { existing = await fs.readFile(f, "utf8"); } catch { /* new note */ }
    if (existing === markdown) {
      const vs = await this.versions(rel);
      return { path: safePath(rel), changed: false, created: false, version: vs[0]?.id ?? null };
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
    return { path: safePath(rel), changed: true, created: existing === null, version: id };
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
