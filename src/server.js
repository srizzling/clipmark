// A small HTTP server: notes in, HTML out, plus a publish API. No framework -
// the routing fits on one screen and there is nothing to configure.

import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { timingSafeEqual } from "node:crypto";

import { render, titleOf } from "./render.js";
import { Store, BadPath, BadSlug, BadComment, BadReview, REVIEW_STATES, SLUG_RE, RESERVED } from "./store.js";
import { digest, slopDigest } from "./comments.js";
import { indexPage, dashboardPage, searchPage, diffPage, notePage, editorPage, errorPage } from "./html.js";
import { diffNotes } from "./diff.js";
import { zip } from "./zip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const PUBLIC_DIR = path.join(here, "..", "public");
const MERMAID = path.join(path.dirname(require.resolve("mermaid/package.json")), "dist", "mermaid.min.js");
const MAX_BODY = 5 * 1024 * 1024;

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
};

export function createApp(opts = {}) {
  const notesDir = opts.notesDir ?? process.env.NOTES_DIR ?? "./notes";
  const token = opts.token ?? process.env.CLIPMARK_TOKEN ?? process.env.NOTES_TOKEN ?? "";
  const siteTitle = opts.siteTitle ?? process.env.SITE_TITLE ?? "Notes";
  const publicUrlEnv = opts.publicUrl ?? process.env.PUBLIC_URL ?? "";
  const store = new Store(notesDir);

  const send = (res, status, body, type = "text/html; charset=utf-8", extra = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj, null, 2) + "\n", "application/json; charset=utf-8");
  const fail = (res, status, message, wantsJson) =>
    wantsJson ? json(res, status, { error: message }) : send(res, status, errorPage({ siteTitle, status, message }));

  const authorised = (req) => {
    if (!token) return true;
    const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(got), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  const publicUrl = (req) => publicUrlEnv || `http://${req.headers.host || "localhost"}`;
  const shortUrl = (req, slug) => `${publicUrl(req)}/${slug}`;
  const pathUrl = (req, rel) => `${publicUrl(req)}/n/${encodeURI(rel)}`;
  const withUrls = (req, n) => ({ ...n, url: shortUrl(req, n.slug), pathUrl: pathUrl(req, n.path) });

  async function renderNote(req, res, rel, v, q = "") {
    if (!(await store.exists(rel))) return fail(res, 404, `no note at ${rel}`);
    const note = v ? await store.readVersion(rel, v) : await store.read(rel);
    const versions = await store.versions(rel);
    const html = render(note.markdown);
    return send(res, 200, notePage({
      siteTitle, note: { ...note, title: titleOf(note.markdown, rel) }, html, versions, viewing: v,
      publicUrl: publicUrl(req), shortUrl: shortUrl(req, note.slug),
      review: v ? null : store.describeReview(rel, note.markdown),
      hits: v || !q ? [] : await store.searchWords(rel, q),
    }));
  }

  const serveFile = async (res, abs) => {
    let st;
    try { st = await fs.stat(abs); } catch { return fail(res, 404, "not found"); }
    if (!st.isFile()) return fail(res, 404, "not found");
    const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Cache-Control": "public, max-age=300" });
    createReadStream(abs).pipe(res);
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    const wantsJson = p.startsWith("/api/") || (req.headers.accept || "").includes("application/json");

    try {
      if (p === "/healthz") {
        const [notes, writable] = await Promise.all([store.list(), store.writable()]);
        // Render a fixture so "up" also means "still able to do the job".
        const smoke = render("# t\n\n| a |\n|---|\n| b |\n\n```mermaid\ngraph TD; A-->B\n```\n");
        const renders = smoke.includes("<table>") && smoke.includes('class="mermaid"');
        const ok = writable && renders;
        return json(res, ok ? 200 : 503, { ok, version: pkg.version, notes: notes.length, writable, renders, notesDir: store.root });
      }

      // The review queue is the home page; every note is under /all.
      if (p === "/" && req.method === "GET") {
        return send(res, 200, dashboardPage({ siteTitle, notes: await store.listReview() }));
      }

      if (p === "/search" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").slice(0, 200);
        const out = await store.search(q, { limit: 25 });
        return send(res, 200, searchPage({ siteTitle, q, total: out.total, results: out.results }));
      }

      if (p === "/all" && req.method === "GET") {
        const list = await store.list();
        const notes = [];
        for (const n of list) {
          const { markdown } = await store.read(n.path);
          const versions = await store.versions(n.path);
          notes.push({ ...n, title: titleOf(markdown, n.path), versions: versions.length });
        }
        return send(res, 200, indexPage({ siteTitle, notes, publicUrl: publicUrl(req), hasToken: !!token }));
      }

      if (p.startsWith("/assets/") && req.method === "GET") {
        const rel = p.slice("/assets/".length);
        if (rel.includes("..") || rel.includes("/")) return fail(res, 404, "not found");
        return await serveFile(res, path.join(PUBLIC_DIR, rel));
      }
      if (p === "/vendor/mermaid.min.js" && req.method === "GET") return await serveFile(res, MERMAID);

      // Machine-readable description of the API, with this deployment's URL.
      if (p === "/llms.txt" && req.method === "GET") {
        const txt = (await fs.readFile(path.join(PUBLIC_DIR, "llms.txt"), "utf8"))
          .replaceAll("{{PUBLIC_URL}}", publicUrl(req)).replaceAll("{{VERSION}}", pkg.version);
        return send(res, 200, txt, "text/plain; charset=utf-8");
      }

      if (p.startsWith("/n/") && req.method === "GET") {
        const rel = p.slice(3);
        if (!rel.endsWith(".md")) return await serveFile(res, store.assetPath(rel));
        return await renderNote(req, res, rel, url.searchParams.get("v"), url.searchParams.get("q") ?? "");
      }

      // A zip of the Markdown sources. ?path=a.md&path=b.md picks notes (the
      // index page's checkboxes submit exactly this); no ?path means all of
      // them. Folders are kept, so the archive unpacks to the same layout.
      if (p === "/export" && req.method === "GET") {
        const wanted = url.searchParams.getAll("path").filter(Boolean);
        const paths = wanted.length ? [...new Set(wanted)] : (await store.list()).map((n) => n.path);
        if (!paths.length) return fail(res, 404, "no notes to export", wantsJson);
        const files = [];
        for (const rel of paths) {
          if (!(await store.exists(rel))) return fail(res, 404, `no note at ${rel}`, wantsJson);
          const note = await store.read(rel);
          files.push({ name: note.path, data: note.markdown, mtime: new Date(note.mtime) });
        }
        const stem = files.length === 1 ? files[0].name.replace(/\.md$/, "").replace(/[^A-Za-z0-9_-]+/g, "-") : "notes";
        const name = `${stem}-${new Date().toISOString().slice(0, 10)}.zip`;
        return send(res, 200, zip(files), "application/zip", { "Content-Disposition": `attachment; filename="${name}"` });
      }

      // Short URLs: /sleepy-wombat-hums. Only one segment, only slug characters,
      // never a reserved prefix, so nothing else on the site can be shadowed.
      if (req.method === "GET") {
        const slug = p.slice(1);
        if (slug && !slug.includes("/") && SLUG_RE.test(slug) && !RESERVED.has(slug)) {
          const rel = store.pathOf(slug);
          if (rel) return await renderNote(req, res, rel, url.searchParams.get("v"), url.searchParams.get("q") ?? "");
          return fail(res, 404, `nothing at /${slug}`, wantsJson);
        }
      }

      if (p.startsWith("/raw/") && req.method === "GET") {
        const rel = p.slice(5);
        const v = url.searchParams.get("v");
        const note = v ? await store.readVersion(rel, v) : await store.read(rel);
        return send(res, 200, note.markdown, "text/markdown; charset=utf-8");
      }

      // What changed between two versions, as rendered blocks. By default the
      // version you last reviewed against the current one, else the one before.
      if (p.startsWith("/diff/") && req.method === "GET") {
        const rel = p.slice(6);
        if (!(await store.exists(rel))) return fail(res, 404, `no note at ${rel}`);
        const versions = await store.versions(rel);
        const toId = url.searchParams.get("to") || null;
        const to = toId ? await store.readVersion(rel, toId) : await store.read(rel);
        const toVersion = toId ?? versions[0]?.id ?? null;
        const review = await store.reviewOf(rel);
        const wanted = url.searchParams.get("from");
        const earlier = versions[versions.findIndex((v) => v.id === toVersion) + 1]?.id;
        const fromId = wanted || [review.reviewedVersion, earlier].find((id) => id && id !== toVersion && versions.some((v) => v.id === id)) || null;
        const from = fromId ? await store.readVersion(rel, fromId) : null;
        const { rows, stats } = diffNotes(from?.markdown ?? "", to.markdown);
        return send(res, 200, diffPage({
          siteTitle, note: { ...to, title: titleOf(to.markdown, rel) }, rows, stats, versions,
          from: from && { id: fromId }, to: { id: toVersion, current: !toId }, review: toId ? null : review,
        }));
      }

      if (p === "/new" && req.method === "GET") {
        return send(res, 200, editorPage({ siteTitle, path: "", markdown: "", hasToken: !!token }));
      }
      if (p.startsWith("/edit/") && req.method === "GET") {
        const rel = p.slice(6);
        const markdown = (await store.exists(rel)) ? (await store.read(rel)).markdown : "";
        return send(res, 200, editorPage({ siteTitle, path: store.file(rel) && rel, markdown, hasToken: !!token }));
      }

      if (p === "/api/render" && req.method === "POST") {
        const md = await readBody(req);
        return send(res, 200, render(md));
      }

      if (p === "/api/notes" && req.method === "GET") {
        const list = await store.list();
        const notes = [];
        for (const n of list) {
          const { markdown } = await store.read(n.path);
          notes.push(withUrls(req, { ...n, title: titleOf(markdown, n.path) }));
        }
        return json(res, 200, { notes });
      }

      // Search over titles, bodies, paths and slugs. Read-only, so no token.
      if (p === "/api/search" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        if (!q.trim()) return fail(res, 400, "q required", true);
        const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 25));
        const out = await store.search(q, { limit });
        return json(res, 200, { ...out, results: out.results.map((n) => withUrls(req, n)) });
      }

      // Review queue. Open to anyone who can reach the server, like comments:
      // it is the reviewer's own bookkeeping, not a publish.
      if (p === "/api/review" && req.method === "GET") {
        const state = url.searchParams.get("state") || "all";
        if (state !== "all" && !REVIEW_STATES.includes(state)) throw new BadReview(`state must be "all" or one of ${REVIEW_STATES.join(", ")}`);
        const all = await store.listReview();
        const counts = { review: 0, refining: 0, settled: 0 };
        for (const n of all) counts[n.state]++;
        return json(res, 200, { counts, notes: all.filter((n) => state === "all" || n.state === state).map((n) => withUrls(req, n)) });
      }
      if (p === "/api/review/settle-before" && req.method === "POST") {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { throw new BadReview("body must be JSON"); }
        return json(res, 200, await store.settleBefore(body?.before));
      }
      const rv = p.match(/^\/api\/notes\/(.+\.md)\/review$/);
      if (rv) {
        const rel = rv[1];
        if (!(await store.exists(rel))) return fail(res, 404, `no note at ${rel}`, true);
        if (req.method === "GET") return json(res, 200, await store.reviewOf(rel));
        if (req.method === "PATCH" || req.method === "POST") {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { throw new BadReview("body must be JSON"); }
          return json(res, 200, await store.setReview(rel, body?.action));
        }
        return fail(res, 405, "method not allowed", true);
      }

      // Every slop flag across all notes, to learn from. ?status= as for comments.
      if (p === "/api/slop" && req.method === "GET") {
        const flags = await store.listSlop(url.searchParams.get("status") || "all");
        if (url.searchParams.get("format") === "md") return send(res, 200, slopDigest(flags), "text/markdown; charset=utf-8");
        return json(res, 200, { flags });
      }

      // Review comments. Open to anyone who can reach the server, like reading
      // a note; only publishing and deleting a note need the token.
      const cm = p.match(/^\/api\/notes\/(.+\.md)\/comments(?:\/([A-Za-z0-9_-]+))?$/);
      if (cm) {
        const [, rel, id] = cm;
        if (!(await store.exists(rel))) return fail(res, 404, `no note at ${rel}`, true);
        const shown = async (cid) => (await store.listComments(rel, "all")).comments.find((c) => c.id === cid);
        const parse = async () => {
          try { return JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; throw new BadComment("body must be JSON"); }
        };
        if (!id && req.method === "GET") {
          const out = await store.listComments(rel, url.searchParams.get("status") || "open", url.searchParams.get("kind") || "all");
          if (url.searchParams.get("format") === "md") return send(res, 200, digest(out), "text/markdown; charset=utf-8");
          return json(res, 200, out);
        }
        if (!id && req.method === "POST") {
          const c = await store.addComment(rel, await parse());
          return json(res, 201, await shown(c.id));
        }
        if (id && req.method === "PATCH") {
          await store.updateComment(rel, id, await parse());
          return json(res, 200, await shown(id));
        }
        if (id && req.method === "DELETE") {
          await store.removeComment(rel, id);
          return json(res, 200, { id, deleted: true });
        }
        return fail(res, 405, "method not allowed", true);
      }

      if (p.startsWith("/api/notes/")) {
        let rel = p.slice("/api/notes/".length);
        const wantVersions = rel.endsWith("/versions");
        if (wantVersions) rel = rel.slice(0, -"/versions".length);

        if (req.method === "GET") {
          if (!(await store.exists(rel)) && !(await store.versions(rel)).length) return fail(res, 404, `no note at ${rel}`, true);
          const versions = await store.versions(rel);
          if (wantVersions) return json(res, 200, { path: rel, versions });
          const v = url.searchParams.get("v");
          const note = v ? await store.readVersion(rel, v) : await store.read(rel);
          return json(res, 200, withUrls(req, { ...note, title: titleOf(note.markdown, rel), versions }));
        }
        if (req.method === "PUT" || req.method === "POST") {
          if (!authorised(req)) return fail(res, 401, "publish token required", true);
          const markdown = await readBody(req);
          if (!markdown.trim()) return fail(res, 400, "empty note", true);
          // ?slug=my-name (or X-Slug header) picks the short URL; otherwise one
          // is assigned on first publish and kept.
          const slug = url.searchParams.get("slug") || req.headers["x-slug"] || null;
          const result = await store.write(rel, markdown, { slug });
          return json(res, result.created ? 201 : 200, withUrls(req, result));
        }
        if (req.method === "DELETE") {
          if (!authorised(req)) return fail(res, 401, "publish token required", true);
          if (!(await store.exists(rel))) return fail(res, 404, `no note at ${rel}`, true);
          await store.remove(rel);
          return json(res, 200, { path: rel, deleted: true, historyKept: true });
        }
      }

      return fail(res, 404, "not found", wantsJson);
    } catch (err) {
      if (err instanceof BadPath || err instanceof BadSlug || err instanceof BadComment || err instanceof BadReview || err.status) return fail(res, err.status || 400, err.message, wantsJson);
      if (err.code === "ENOENT") return fail(res, 404, "not found", wantsJson);
      console.error(err);
      return fail(res, 500, "internal error", wantsJson);
    }
  }

  const server = http.createServer(handle);
  return {
    server,
    store,
    async listen(port = Number(process.env.PORT || 8080), host = process.env.HOST || "0.0.0.0") {
      await store.init();
      await new Promise((r) => server.listen(port, host, r));
      return server.address();
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  app.listen().then((addr) => {
    console.log(`clipmark ${pkg.version} listening on ${addr.address}:${addr.port}, notes in ${app.store.root}`);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.close().then(() => process.exit(0)));
}
