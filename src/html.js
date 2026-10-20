// Page templates. Plain template strings: there are three pages and they
// share one header.

import { escapeHtml as h } from "./render.js";

export function layout({ title, siteTitle, body, head = "", bodyClass = "", q = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · ${h(siteTitle)}</title>
<link rel="stylesheet" href="/assets/style.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23345'/%3E%3Ctext x='8' y='12' font-size='10' text-anchor='middle' fill='white' font-family='sans-serif'%3EM%3C/text%3E%3C/svg%3E">
${head}
</head>
<body class="${h(bodyClass)}">
<header class="site">
  <a class="brand" href="/">${h(siteTitle)}</a>
  <form class="search" action="/search" method="get" role="search">
    <input type="search" name="q" value="${h(q)}" placeholder="Search notes" aria-label="Search notes" autocomplete="off">
  </form>
  <nav>
    <a href="/">Review</a>
    <a href="/all">All notes</a>
    <a href="/new">New</a>
    <a href="/api/notes">API</a>
  </nav>
</header>
${body}
<div id="toast" role="status" aria-live="polite"></div>
</body>
</html>`;
}

function when(iso) {
  return `<time datetime="${h(iso)}" title="${h(iso)}">${h(iso.replace("T", " ").slice(0, 16))}Z</time>`;
}

export function indexPage({ siteTitle, notes, publicUrl, hasToken }) {
  const rows = notes.length
    ? notes.map((n) => `
      <tr>
        <td class="pick"><input type="checkbox" name="path" value="${h(n.path)}" aria-label="Select ${h(n.title)}"></td>
        <td><a href="/${h(n.slug)}">${h(n.title)}</a><div class="muted mono">${h(n.path)}</div></td>
        <td><a class="mono slug" href="/${h(n.slug)}">/${h(n.slug)}</a></td>
        <td>${when(n.mtime)}</td>
        <td class="num">${n.versions}</td>
        <td class="actions">
          <a href="/n/${encodeURI(n.path)}">open</a>
          <a href="/edit/${encodeURI(n.path)}">edit</a>
          <a href="/raw/${encodeURI(n.path)}">raw</a>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="muted">No notes yet. Publish one with the API below, or <a href="/new">write one here</a>.</td></tr>`;

  // The table is a GET form: ticked boxes become ?path=... on /export, which
  // answers with a zip of the Markdown. Works without JS; app.js only adds
  // select-all and the count.
  const body = `
<main class="index">
  <h1>All notes</h1>
  <form id="export-form" method="get" action="/export">
  <table class="notes">
    <thead><tr>
      <th class="pick"><input type="checkbox" id="select-all" aria-label="Select all notes" title="Select all"></th>
      <th>Title</th><th>Link</th><th>Updated</th><th class="num">Versions</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${notes.length ? `
  <div class="bulk">
    <button type="submit" id="export-selected" class="primary" title="Download the selected notes' Markdown as a .zip (Mermaid blocks included)">Download selected as .zip</button>
    <span id="export-count" class="muted"></span>
    <a class="btn" href="/export" title="Every note's Markdown as a .zip">Download all</a>
  </div>` : ""}
  </form>

  <details class="api">
    <summary>Publishing from the command line</summary>
    <pre><code>curl -X PUT ${hasToken ? '-H "Authorization: Bearer $TOKEN" ' : ""}\\
     -H "Content-Type: text/markdown" \\
     --data-binary @doc.md \\
     ${h(publicUrl)}/api/notes/doc.md</code></pre>
    <p>Each note gets a short link like <code>/sleepy-wombat-hums</code> on first publish and keeps it.
    Choose your own with <code>?slug=my-name</code> on the <code>PUT</code>.</p>
    <p>Every change is kept: <code>GET /api/notes/doc.md/versions</code> lists them and
    <code>/n/doc.md?v=&lt;id&gt;</code> shows one. <code>DELETE /api/notes/doc.md</code> removes the
    current copy and keeps the history. <code>GET /healthz</code> for monitoring.
    The whole API in one page for tools and agents: <a href="/llms.txt">/llms.txt</a>.</p>
    <p>Tick notes and <em>Download selected</em> for a <code>.zip</code> of their Markdown, or
    <code>GET /export?path=a.md&amp;path=b.md</code>; <code>/export</code> alone is every note.</p>
  </details>
</main>
<script src="/assets/app.js"></script>`;
  return layout({ title: "All notes", siteTitle, body, bodyClass: "index" });
}

const STATE_LABEL = { review: "To review", refining: "Refining", settled: "Settled" };

// Wrap the matched ranges of a snippet in <mark>, escaping everything else.
function marked(text, ranges) {
  let out = "", at = 0;
  for (const [a, b] of ranges) { out += h(text.slice(at, a)) + `<mark>${h(text.slice(a, b))}</mark>`; at = b; }
  return out + h(text.slice(at));
}

export function searchPage({ siteTitle, q, total, results }) {
  const row = (n) => `
      <li>
        <div class="main">
          <a class="title" href="/${h(n.slug)}?q=${encodeURIComponent(q)}">${h(n.title)}</a>
          <span class="pill state-${h(n.state)}">${STATE_LABEL[n.state]}</span>
          ${n.openComments ? `<span class="pill open" title="Open comments and flags">${n.openComments} open comment${n.openComments === 1 ? "" : "s"}</span>` : ""}
          <div class="muted mono">${h(n.path)} · /${h(n.slug)}</div>
          <p class="snippet">${marked(n.snippet, n.highlights)}</p>
        </div>
        <div class="meta muted">updated ${when(n.mtime)}</div>
      </li>`;
  const summary = !q.trim() ? "" : total
    ? `<p class="muted">${total} note${total === 1 ? "" : "s"} match${total === 1 ? "es" : ""}${total > results.length ? `, showing the best ${results.length}` : ""}.</p>`
    : `<p class="muted">No note matches every word of <strong>${h(q)}</strong>. Spelling is forgiven for longer words; use fewer words or check for a typo.</p>`;
  const body = `
<main class="dash searchresults">
  <h1>Search</h1>
  <form class="bigsearch" action="/search" method="get" role="search">
    <input type="search" name="q" value="${h(q)}" placeholder="Search titles, text, paths and links" aria-label="Search notes" autocomplete="off"${q ? "" : " autofocus"}>
    <button type="submit" class="primary">Search</button>
  </form>
  ${summary}
  ${results.length ? `<ul class="queue results">${results.map(row).join("")}</ul>` : ""}
  ${q.trim() ? "" : `<p class="muted">Every word has to appear somewhere in the note, in any order. Put <code>"quotes"</code> around a phrase. Small typos are forgiven.</p>`}
</main>`;
  return layout({ title: q ? `Search: ${q}` : "Search", siteTitle, body, bodyClass: "search", q });
}

// The review queue. Three groups, derived from the notes' review state: what
// still needs the reviewer, what they have read and sent back for more work,
// and what is done.
export function dashboardPage({ siteTitle, notes }) {
  const by = (state) => notes.filter((n) => n.state === state);
  const row = (n) => `
      <li class="${n.changed ? "changed" : ""}">
        <div class="main">
          <a class="title" href="/${h(n.slug)}">${h(n.title)}</a>
          ${n.changed ? `<a class="pill changed" href="/diff/${encodeURI(n.path)}" title="This note was published again after you reviewed it. See what changed.">changed since you read it</a>` : ""}
          ${n.openComments ? `<span class="pill open" title="Open comments and flags">${n.openComments} open comment${n.openComments === 1 ? "" : "s"}</span>` : ""}
          <div class="muted mono">${h(n.path)}</div>
        </div>
        <div class="meta muted">
          ${n.state === "review" ? `updated ${when(n.mtime)}` : `reviewed ${when(n.reviewedAt)}`}
          ${n.versions > 1 ? ` · <a href="/diff/${encodeURI(n.path)}">diff</a>` : ""}
        </div>
      </li>`;
  const section = (state, empty) => {
    const list = by(state);
    return list.length ? `<ul class="queue">${list.map(row).join("")}</ul>` : `<p class="muted empty">${empty}</p>`;
  };
  const settled = by("settled");
  const body = `
<main class="dash">
  <h1>Review</h1>
  <section>
    <h2>To review <span class="pill">${by("review").length}</span></h2>
    ${section("review", "Nothing waiting on you.")}
    ${by("review").length ? `<div class="catchup">
      <button id="settle-old" type="button" title="Settle every note that has never been reviewed and was last changed before today. Notes changed today stay in the queue.">Settle everything older than today</button>
      <span class="muted">One-off catch-up for notes that existed before review did.</span>
    </div>` : ""}
  </section>
  <section>
    <h2>Refining <span class="pill">${by("refining").length}</span></h2>
    ${section("refining", "Nothing sent back for more work.")}
  </section>
  <details class="settled"${settled.length && !by("review").length && !by("refining").length ? " open" : ""}>
    <summary>Settled <span class="pill">${settled.length}</span></summary>
    ${section("settled", "Nothing settled yet.")}
  </details>
</main>
<script src="/assets/app.js"></script>`;
  return layout({ title: "Review", siteTitle, body, bodyClass: "dash" });
}

// The bar at the top of a note: where it stands, and the choices from there.
function reviewBar(note, review) {
  if (!review) return "";
  const enc = encodeURI(note.path);
  const btn = (action, label, title, cls = "") => `<button type="button" data-action="${action}"${cls ? ` class="${cls}"` : ""} title="${h(title)}">${label}</button>`;
  const choices = {
    review: btn("reviewed", "Keep refining", "I have read it and it needs more work. It leaves the queue until it is published again.", "primary") +
            btn("settle", "Settle", "I have read it and it is done."),
    refining: btn("settle", "Settle", "It is done.", "primary") + btn("reset", "Back to review", "Put it back in the To review queue."),
    settled: btn("reset", "Reopen", "Put it back in the To review queue."),
  }[review.state];
  const at = review.reviewedAt ? when(review.reviewedAt) : "";
  const note_ = {
    review: review.changed ? `Published again since you reviewed it. <a href="/diff/${enc}">See what changed</a>.` : "You have not reviewed this yet.",
    refining: `Reviewed ${at}. Waiting on edits. <a href="/diff/${enc}">Diff</a>.`,
    settled: `Settled ${at}. A new publish puts it back in the queue.`,
  }[review.state];
  return `<div class="reviewbar state-${review.state}" id="reviewbar" data-path="${h(note.path)}" data-nocopy>
  <span class="badge">${STATE_LABEL[review.state]}</span>
  <span class="muted">${note_}</span>
  <span class="spacer"></span>
  ${choices}
</div>`;
}

export function diffPage({ siteTitle, note, rows, stats, versions, from, to, review }) {
  const enc = encodeURI(note.path);
  const opt = (v, selected) => `<option value="${h(v.id)}"${selected ? " selected" : ""}>v${v.n} · ${h(v.id.replace("T", " ").slice(0, 16).replace(/-(\d\d)$/, ":$1"))}</option>`;
  const toId = to.id;
  const summary = [
    stats.changed && `${stats.changed} changed`, stats.added && `${stats.added} added`, stats.removed && `${stats.removed} removed`,
  ].filter(Boolean).join(", ") || "no differences";
  const cells = rows.map((r) => `
    <div class="drow ${r.kind}">
      <div class="old" data-nocopy>${r.old ?? ""}</div>
      <div class="new">${r.new ?? ""}</div>
    </div>`).join("");
  const body = `
<div class="toolbar" data-nocopy>
  <div class="left">
    <a class="back" href="/${h(note.slug)}" title="Back to the note">←</a>
    <span class="title">${h(note.title)}</span>
    <span class="muted">${h(summary)}</span>
  </div>
  <div class="right">
    <form class="compare" method="get" action="/diff/${enc}">
      <label>From <select name="from">${versions.map((v) => opt(v, v.id === from?.id)).join("")}</select></label>
      <label>To <select name="to">${versions.map((v) => opt(v, v.id === toId)).join("")}</select></label>
      <button type="submit">Compare</button>
    </form>
    <span class="seg" role="group" aria-label="Layout">
      <button type="button" data-layout="unified" title="Old above new">Unified</button>
      <button type="button" data-layout="split" title="Old on the left, new on the right">Side by side</button>
    </span>
    <label class="muted"><input type="checkbox" id="changes-only"> Changes only</label>
    <button id="toggle-comments" title="Review comments. Select text on the new side to add one.">Comments <span id="comment-count" class="pill" hidden></span></button>
  </div>
</div>
${reviewBar(note, review)}
<main class="diffmain">
  ${from ? "" : `<p class="muted">There is no earlier version to compare with, so everything shows as added.</p>`}
  <div class="legend muted" data-nocopy>Comments attach to the new side. Removed text is on the left (or struck through in unified).</div>
  <article id="note" class="markdown-body diff" data-path="${h(note.path)}" data-version="${h(to.current ? "" : toId)}">${cells}
  </article>
</main>
<script src="/vendor/mermaid.min.js"></script>
<script src="/assets/app.js"></script>`;
  return layout({ title: `Diff: ${note.title}`, siteTitle, body, bodyClass: "note diffpage" });
}

export function notePage({ siteTitle, note, html, versions, viewing, publicUrl, shortUrl, review, hits = [] }) {
  const path = note.path;
  const enc = encodeURI(path);
  const current = !viewing;
  const history = versions.length
    ? `<details class="history">
        <summary>History <span class="pill">${versions.length}</span></summary>
        <ol reversed>
          ${versions.map((v) => `<li${viewing === v.id ? ' class="current"' : ""}>
            <a href="/${h(note.slug)}?v=${encodeURIComponent(v.id)}">v${v.n}</a>
            <span class="muted mono">${h(v.id.replace("T", " ").slice(0, 19).replace(/-(\d\d)-(\d\d)$/, ":$1:$2"))}Z · ${v.size} B</span>
          </li>`).join("")}
        </ol>
      </details>`
    : "";

  const banner = viewing
    ? `<div class="banner">Viewing version <code>${h(viewing)}</code>. <a href="/${h(note.slug)}">Back to current</a>.</div>`
    : "";

  const body = `
<div class="toolbar" data-nocopy>
  <div class="left">
    <a class="back" href="/" title="Back to the review queue">←</a>
    <span class="title">${h(note.title)}</span>
    <button id="copy-link" class="link mono" data-url="${h(shortUrl)}" title="Copy this note's short link (${h(path)})">/${h(note.slug)}</button>
  </div>
  <div class="right">
    <label class="diagrams">Diagrams
      <select id="diagram-mode" title="How Mermaid diagrams are placed in the copied content">
        <option value="image">as image</option>
        <option value="code">as code</option>
        <option value="both">image + code</option>
      </select>
    </label>
    <button id="copy-rich" class="primary" title="Copy the rendered note as rich text, ready to paste into an editor">Copy for pasting</button>
    <button id="copy-md" title="Copy the Markdown source">Copy Markdown</button>
    <button id="toggle-comments" title="Review comments. Select text in the note to add one.">Comments <span id="comment-count" class="pill" hidden></span></button>
    ${current && versions.length > 1 ? `<a class="btn" href="/diff/${enc}" title="Compare with an earlier version">Diff</a>` : ""}
    ${current ? `<a class="btn" href="/edit/${enc}">Edit</a>` : ""}
    <a class="btn" href="/raw/${enc}${viewing ? `?v=${encodeURIComponent(viewing)}` : ""}" title="${h(path)}">Raw</a>
    ${history}
  </div>
</div>
${banner}
${current ? reviewBar(note, review) : ""}
<main>
  <article id="note" class="markdown-body" data-path="${h(path)}" data-version="${h(viewing || "")}"${hits.length ? ` data-hits="${h(JSON.stringify(hits))}"` : ""}>
${html}
  </article>
</main>
<script id="note-source" type="application/json">${JSON.stringify(note.markdown).replace(/</g, "\\u003c")}</script>
<script src="/vendor/mermaid.min.js"></script>
<script src="/assets/app.js"></script>`;
  return layout({ title: note.title, siteTitle, body, bodyClass: "note" });
}

export function editorPage({ siteTitle, path, markdown, hasToken }) {
  const body = `
<div class="toolbar editor-bar" data-nocopy>
  <div class="left">
    <a class="back" href="${path ? `/n/${encodeURI(path)}` : "/"}" title="Back">←</a>
    <input id="edit-path" class="mono" placeholder="folder/name.md" value="${h(path)}" ${path ? "readonly" : ""} spellcheck="false">
  </div>
  <div class="right">
    ${hasToken ? `<input id="edit-token" type="password" placeholder="publish token" autocomplete="off">` : ""}
    <button id="save" class="primary">Publish</button>
    <span id="save-status" class="muted"></span>
  </div>
</div>
<main class="editor">
  <textarea id="edit-md" spellcheck="false" placeholder="# Title&#10;&#10;Write GitHub-flavoured Markdown. \`\`\`mermaid blocks render as diagrams.">${h(markdown)}</textarea>
  <section id="preview" class="markdown-body"></section>
</main>
<script src="/vendor/mermaid.min.js"></script>
<script src="/assets/app.js"></script>`;
  return layout({ title: path ? `Edit ${path}` : "New note", siteTitle, body, bodyClass: "edit" });
}

export function errorPage({ siteTitle, status, message }) {
  return layout({
    title: `${status}`,
    siteTitle,
    body: `<main class="index"><h1>${status}</h1><p>${h(message)}</p><p><a href="/">Back to notes</a></p></main>`,
  });
}
