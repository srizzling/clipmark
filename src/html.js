// Page templates. Plain template strings: there are three pages and they
// share one header.

import { escapeHtml as h } from "./render.js";

export function layout({ title, siteTitle, body, head = "", bodyClass = "" }) {
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
  <nav>
    <a href="/">Notes</a>
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
  <h1>Notes</h1>
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
  return layout({ title: "Notes", siteTitle, body, bodyClass: "index" });
}

export function notePage({ siteTitle, note, html, versions, viewing, publicUrl, shortUrl }) {
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
    <a class="back" href="/" title="All notes">←</a>
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
    ${current ? `<a class="btn" href="/edit/${enc}">Edit</a>` : ""}
    <a class="btn" href="/raw/${enc}${viewing ? `?v=${encodeURIComponent(viewing)}` : ""}" title="${h(path)}">Raw</a>
    ${history}
  </div>
</div>
${banner}
<main>
  <article id="note" class="markdown-body" data-path="${h(path)}" data-version="${h(viewing || "")}">
${html}
  </article>
</main>
<script id="note-source" type="text/markdown">${note.markdown.replace(/<\/script/gi, "<\\/script")}</script>
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
