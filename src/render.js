// Markdown -> HTML tuned for two readers at once: the browser showing the page,
// and the rich-text editor the page will be pasted into. Everything here emits
// the plainest HTML that both understand; the client tidies it further at copy
// time (see public/app.js).

import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";

const ALERTS = {
  // GFM alert  -> panel type understood by Confluence's editor on paste,
  //               and a readable label everywhere else.
  NOTE: { panel: "info", label: "Note" },
  TIP: { panel: "success", label: "Tip" },
  IMPORTANT: { panel: "note", label: "Important" },
  WARNING: { panel: "warning", label: "Warning" },
  CAUTION: { panel: "error", label: "Caution" },
};

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:\n|$)/;
const TASK_RE = /^\[( |x|X)\]\s+/;

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ```mermaid blocks render client-side; everything else is a plain <pre> whose
// language travels in data-language, which is the attribute the Confluence
// editor reads back on paste.
function fence(tokens, idx, options, env, self) {
  const token = tokens[idx];
  const lang = (token.info || "").trim().split(/\s+/)[0] || "";
  const code = token.content;
  if (lang === "mermaid") {
    return (
      `<figure class="mermaid-block">` +
      `<pre class="mermaid">${escapeHtml(code)}</pre>` +
      `<pre class="mermaid-source" hidden>${escapeHtml(code)}</pre>` +
      `</figure>\n`
    );
  }
  const langAttr = lang ? ` data-language="${escapeHtml(lang)}"` : "";
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre${langAttr}><code${cls}>${escapeHtml(code)}</code></pre>\n`;
}

// > [!NOTE]  blocks become <div data-panel-type="info"> with a bold label.
function alerts(state) {
  const t = state.tokens;
  for (let i = 0; i < t.length; i++) {
    if (t[i].type !== "blockquote_open") continue;
    const p = t[i + 1];
    const inline = t[i + 2];
    if (!p || p.type !== "paragraph_open" || !inline || inline.type !== "inline") continue;
    const m = ALERT_RE.exec(inline.content);
    if (!m) continue;
    const kind = ALERTS[m[1]];

    // Find the matching close.
    let depth = 0;
    let close = -1;
    for (let j = i; j < t.length; j++) {
      if (t[j].type === "blockquote_open") depth++;
      if (t[j].type === "blockquote_close" && --depth === 0) { close = j; break; }
    }
    if (close < 0) continue;

    t[i].tag = "div";
    t[i].attrs = [
      ["class", `markdown-alert markdown-alert-${m[1].toLowerCase()}`],
      ["data-panel-type", kind.panel],
    ];
    t[close].tag = "div";

    // Strip the marker from the paragraph. children[0] is the marker text,
    // usually followed by a softbreak.
    inline.content = inline.content.slice(m[0].length);
    const kids = inline.children || [];
    if (kids.length && kids[0].type === "text") {
      kids[0].content = kids[0].content.replace(/^\[![A-Z]+\]\s*/, "");
      if (kids[0].content === "") {
        kids.shift();
        if (kids.length && kids[0].type === "softbreak") kids.shift();
      }
    }

    const title = new state.Token("html_block", "", 0);
    title.content = `<p class="markdown-alert-title"><strong>${kind.label}</strong></p>\n`;
    title.block = true;
    t.splice(i + 1, 0, title);

    // Marker-only paragraph (e.g. "> [!NOTE]" followed by a blank line): drop it.
    if (inline.content.trim() === "" && kids.length === 0) {
      t.splice(i + 2, 3); // paragraph_open, inline, paragraph_close
    }
  }
}

// - [ ] / - [x] list items become disabled checkboxes on the page; the client
// turns them into ☐ / ☑ text at copy time so they survive any paste target.
function taskLists(state) {
  const t = state.tokens;
  for (let i = 2; i < t.length; i++) {
    if (t[i].type !== "inline") continue;
    if (t[i - 1].type !== "paragraph_open" || t[i - 2].type !== "list_item_open") continue;
    const m = TASK_RE.exec(t[i].content);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    const li = t[i - 2];
    li.attrJoin("class", "task-list-item");
    t[i].content = t[i].content.slice(m[0].length);
    const kids = t[i].children;
    if (kids && kids.length && kids[0].type === "text") {
      kids[0].content = kids[0].content.replace(TASK_RE, "");
    }
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? " checked" : ""}> `;
    (t[i].children ||= []).unshift(box);
  }
}

export function createRenderer() {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
  md.use(footnote);
  md.renderer.rules.fence = fence;
  md.core.ruler.after("inline", "gfm_alerts", alerts);
  md.core.ruler.after("gfm_alerts", "gfm_tasks", taskLists);
  return md;
}

const shared = createRenderer();

export function render(markdown) {
  return shared.render(markdown);
}

// First H1, else null. Used for page titles and the index.
export function titleOf(markdown, fallback = "Untitled") {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return m ? m[1].trim() : fallback;
}
