/* Client side: render Mermaid, copy the note as rich text, and review it with
 * highlighted comments.
 *
 * Two clipboard paths, because navigator.clipboard.write() only exists in a
 * secure context (https or localhost) and a LAN box over plain http is not
 * one. Rich text falls back to intercepting a synthetic copy event, which
 * works everywhere. Images cannot take that route, so in an insecure context
 * "Copy PNG" shows the image for a native right-click copy instead.
 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ""), 2500);
  }

  // ------------------------------------------------------------ clipboard
  const secure = window.isSecureContext && navigator.clipboard && window.ClipboardItem;

  async function copyRich(html, text) {
    if (secure) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
        return true;
      } catch (e) {
        console.warn("clipboard.write failed, falling back", e);
      }
    }
    return copyViaEvent(html, text);
  }

  function copyViaEvent(html, text) {
    const onCopy = (e) => {
      e.clipboardData.setData("text/html", html);
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
    };
    const span = document.createElement("span");
    span.textContent = "​";
    span.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.body.appendChild(span);
    const sel = window.getSelection();
    const saved = sel.rangeCount ? sel.getRangeAt(0) : null;
    const range = document.createRange();
    range.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(range);
    document.addEventListener("copy", onCopy, true);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.removeEventListener("copy", onCopy, true);
    sel.removeAllRanges();
    if (saved) sel.addRange(saved);
    span.remove();
    return ok;
  }

  async function copyText(text) {
    if (secure) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    return copyViaEvent(text.replace(/&/g, "&amp;").replace(/</g, "&lt;"), text);
  }

  async function copyPng(blob, dataUrl) {
    if (secure) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return true;
      } catch (e) {
        console.warn("image clipboard write failed", e);
      }
    }
    showImageDialog(dataUrl);
    return false;
  }

  function showImageDialog(dataUrl) {
    let dlg = $("#image-dialog");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "image-dialog";
      dlg.innerHTML =
        `<p>This page is served over plain http, so the browser will not let a script put an image on the clipboard. ` +
        `<strong>Right-click the image → Copy image</strong>, then paste.</p>` +
        `<img alt="diagram"><p style="text-align:right"><button id="image-dialog-close">Close</button></p>`;
      document.body.appendChild(dlg);
      $("#image-dialog-close", dlg).onclick = () => dlg.close();
    }
    $("img", dlg).src = dataUrl;
    dlg.showModal();
  }

  // -------------------------------------------------------------- mermaid
  const ready = { mermaid: null };

  async function renderMermaid(root = document) {
    if (!window.mermaid) return;
    if (!ready.mermaid) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        // Pure-SVG labels: <foreignObject> does not rasterise reliably, and the
        // PNG we hand to the clipboard is drawn through <canvas>.
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        sequence: { useMaxWidth: true },
      });
      ready.mermaid = true;
    }
    const nodes = $$("pre.mermaid:not([data-processed])", root);
    if (!nodes.length) return;
    try {
      await mermaid.run({ nodes });
    } catch (e) {
      console.warn("mermaid", e);
    }
    for (const fig of $$("figure.mermaid-block", root)) {
      if (!$("svg", fig)) fig.classList.add("error");
      if (!$(".diagram-tools", fig)) addDiagramTools(fig);
    }
  }

  function diagramSource(fig) {
    return $(".mermaid-source", fig)?.textContent ?? "";
  }

  function addDiagramTools(fig) {
    const bar = document.createElement("div");
    bar.className = "diagram-tools";
    bar.setAttribute("data-nocopy", "");
    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.title = title;
      b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message || String(e), true); } b.disabled = false; };
      bar.appendChild(b);
    };
    mk("Full screen", "View the diagram full screen (zoom and pan)", () => showDiagram(fig));
    mk("Copy PNG", "Copy the diagram as an image", async () => {
      const { blob, dataUrl } = await svgToPng($("svg", fig));
      if (await copyPng(blob, dataUrl)) toast("Diagram copied as image");
    });
    mk("Copy code", "Copy the Mermaid source", async () => {
      if (await copyText(diagramSource(fig))) toast("Mermaid source copied");
    });
    mk("PNG", "Download as PNG", async () => {
      const { blob } = await svgToPng($("svg", fig));
      download(blob, `${diagramName(fig)}.png`);
    });
    mk("SVG", "Download as SVG", () => {
      const svg = serialiseSvg($("svg", fig));
      download(new Blob([svg], { type: "image/svg+xml" }), `${diagramName(fig)}.svg`);
    });
    fig.appendChild(bar);
  }

  // ------------------------------------------------------ diagram viewer
  // A viewport-sized <dialog> holding a clone of the rendered SVG. The clone
  // is sized explicitly (Mermaid's own max-width is dropped) so it can be
  // zoomed; url(#id) references still resolve to the original's markers.
  const viewer = { dlg: null, stage: null, svg: null, base: null, zoom: 1 };
  const ZOOM_MIN = 0.1, ZOOM_MAX = 8;

  function diagramDialog() {
    if (viewer.dlg) return viewer.dlg;
    const dlg = document.createElement("dialog");
    dlg.id = "diagram-dialog";
    dlg.innerHTML =
      `<div class="bar" data-nocopy>` +
      `<span class="name"></span>` +
      `<span class="hint muted">Ctrl+scroll or pinch to zoom, drag to pan, Esc to close</span>` +
      `<span class="zoom-tools">` +
      `<button type="button" data-zoom="out" title="Zoom out (-)">−</button>` +
      `<span class="level mono">100%</span>` +
      `<button type="button" data-zoom="in" title="Zoom in (+)">+</button>` +
      `<button type="button" data-zoom="fit" title="Fit to screen (0)">Fit</button>` +
      `<button type="button" data-zoom="one" title="Actual size (1)">1:1</button>` +
      `<button type="button" data-close title="Close (Esc)">Close</button>` +
      `</span></div>` +
      `<div class="stage"></div>`;
    document.body.appendChild(dlg);
    const stage = $(".stage", dlg);
    viewer.dlg = dlg; viewer.stage = stage;

    dlg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-close")) return dlg.close();
      const r = stage.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      switch (b.dataset.zoom) {
        case "in": zoomAt(viewer.zoom * 1.25, cx, cy); break;
        case "out": zoomAt(viewer.zoom / 1.25, cx, cy); break;
        case "one": zoomAt(1, cx, cy); break;
        case "fit": fitDiagram(); break;
      }
    });
    dlg.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      const r = stage.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (e.key === "+" || e.key === "=") zoomAt(viewer.zoom * 1.25, cx, cy);
      else if (e.key === "-" || e.key === "_") zoomAt(viewer.zoom / 1.25, cx, cy);
      else if (e.key === "0") fitDiagram();
      else if (e.key === "1") zoomAt(1, cx, cy);
      else return;
      e.preventDefault();
    });
    // Plain scrolling pans; ctrl/cmd+wheel (which is also how trackpads report
    // a pinch) zooms around the pointer.
    stage.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomAt(viewer.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    // Drag to pan.
    let drag = null;
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("dragging");
      e.preventDefault();
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      stage.scrollLeft = drag.left - (e.clientX - drag.x);
      stage.scrollTop = drag.top - (e.clientY - drag.y);
    });
    const endDrag = () => { drag = null; stage.classList.remove("dragging"); };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    dlg.addEventListener("close", () => { stage.innerHTML = ""; viewer.svg = null; });
    window.addEventListener("resize", () => { if (dlg.open && viewer.fitted) fitDiagram(); });
    return dlg;
  }

  function showDiagram(fig) {
    const svg = $("svg", fig);
    if (!svg) throw new Error("diagram did not render");
    const dlg = diagramDialog();
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    const box = svg.getBoundingClientRect();
    viewer.base = { w: vb[2] || box.width || 800, h: vb[3] || box.height || 600 };
    const clone = svg.cloneNode(true);
    clone.removeAttribute("style");
    clone.removeAttribute("width");
    clone.removeAttribute("height");
    clone.setAttribute("preserveAspectRatio", "xMidYMid meet");
    viewer.stage.replaceChildren(clone);
    viewer.svg = clone;
    const all = $$("figure.mermaid-block");
    $(".name", dlg).textContent = all.length > 1 ? `Diagram ${all.indexOf(fig) + 1} of ${all.length}` : "Diagram";
    dlg.showModal();
    fitDiagram();
  }

  function setZoom(z) {
    viewer.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    viewer.svg.style.width = `${Math.round(viewer.base.w * viewer.zoom)}px`;
    viewer.svg.style.height = `${Math.round(viewer.base.h * viewer.zoom)}px`;
    $(".level", viewer.dlg).textContent = `${Math.round(viewer.zoom * 100)}%`;
  }

  // Zoom keeping the diagram point under (cx, cy) in place.
  function zoomAt(z, cx, cy) {
    if (!viewer.svg) return;
    viewer.fitted = false;
    const before = viewer.svg.getBoundingClientRect();
    const rx = (cx - before.left) / before.width, ry = (cy - before.top) / before.height;
    setZoom(z);
    const after = viewer.svg.getBoundingClientRect();
    viewer.stage.scrollLeft += after.left + rx * after.width - cx;
    viewer.stage.scrollTop += after.top + ry * after.height - cy;
  }

  function fitDiagram() {
    if (!viewer.svg) return;
    const pad = 32;
    const { clientWidth: sw, clientHeight: sh } = viewer.stage;
    setZoom(Math.min((sw - pad) / viewer.base.w, (sh - pad) / viewer.base.h));
    viewer.fitted = true;
    viewer.stage.scrollLeft = 0; viewer.stage.scrollTop = 0;
  }

  function diagramName(fig) {
    const all = $$("figure.mermaid-block");
    const path = ($("#note")?.dataset.path || "diagram").replace(/\.md$/, "").replace(/[^A-Za-z0-9_-]+/g, "-");
    return `${path}-diagram-${all.indexOf(fig) + 1}`;
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function serialiseSvg(svg) {
    const clone = svg.cloneNode(true);
    const box = svg.getBoundingClientRect();
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    const w = Math.ceil(box.width || vb[2] || 800);
    const hgt = Math.ceil(box.height || vb[3] || 600);
    clone.setAttribute("width", w);
    clone.setAttribute("height", hgt);
    clone.removeAttribute("style");
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    // Mermaid emits an internal <style>; pin a font stack that exists offline.
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = "svg{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff}";
    clone.insertBefore(style, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  async function svgToPng(svg, scale = 2) {
    if (!svg) throw new Error("diagram did not render");
    const xml = serialiseSvg(svg);
    const w = Number(svg.getBoundingClientRect().width) || 800;
    const h = Number(svg.getBoundingClientRect().height) || 600;
    const img = new Image();
    img.decoding = "sync";
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("could not rasterise diagram")); img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("could not encode PNG");
    return { blob, dataUrl: canvas.toDataURL("image/png"), width: Math.ceil(w), height: Math.ceil(h) };
  }

  // ---------------------------------------------------------- export html
  async function exportHtml(article, mode) {
    const clone = article.cloneNode(true);
    $$("[data-nocopy]", clone).forEach((n) => n.remove());

    // Diagrams: image, code, or both. The live <svg> in the article is what
    // gets rasterised; the clone only carries the result.
    const liveFigs = $$("figure.mermaid-block", article);
    const cloneFigs = $$("figure.mermaid-block", clone);
    for (let i = 0; i < cloneFigs.length; i++) {
      const src = diagramSource(cloneFigs[i]);
      const parts = [];
      if (mode !== "code") {
        const svg = $("svg", liveFigs[i]);
        if (svg) {
          const { dataUrl, width, height } = await svgToPng(svg);
          parts.push(`<p><img src="${dataUrl}" width="${width}" height="${height}" alt="diagram"></p>`);
        } else {
          parts.push(`<p><em>(diagram failed to render)</em></p>`);
        }
      }
      if (mode !== "image") {
        parts.push(`<pre data-language="mermaid"><code class="language-mermaid">${escapeHtml(src)}</code></pre>`);
      }
      const wrap = document.createElement("div");
      wrap.innerHTML = parts.join("\n");
      cloneFigs[i].replaceWith(...wrap.childNodes);
    }

    // Checkboxes -> text, so they survive editors that drop form controls.
    for (const box of $$("input[type=checkbox]", clone)) {
      box.replaceWith(document.createTextNode(box.checked ? "☑ " : "☐ "));
    }
    $$("li.task-list-item", clone).forEach((li) => li.removeAttribute("class"));

    // Absolute links; inline same-origin images so they travel with the text.
    for (const a of $$("a[href]", clone)) a.setAttribute("href", new URL(a.getAttribute("href"), location.href).href);
    for (const img of $$("img", clone)) {
      const abs = new URL(img.getAttribute("src"), location.href);
      if (abs.protocol === "data:") continue;
      img.setAttribute("src", abs.href);
      if (abs.origin === location.origin) {
        try {
          const b = await (await fetch(abs.href)).blob();
          img.setAttribute("src", await blobToDataUrl(b));
        } catch { /* leave the absolute URL */ }
      }
    }

    // Footnote back-links and other page furniture.
    $$("a.footnote-backref, .footnotes-sep", clone).forEach((n) => n.remove());
    for (const el of $$("[class]", clone)) if (!el.className.startsWith("language-")) el.removeAttribute("class");
    for (const el of $$("[id]", clone)) el.removeAttribute("id");
    clone.removeAttribute("data-path"); clone.removeAttribute("data-version");

    return `<!-- clipmark -->\n${clone.innerHTML.trim()}\n`;
  }

  const blobToDataUrl = (blob) => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
  });
  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // --------------------------------------------------------------- review
  // Select text, add a comment; an agent reads the comments back over the API.
  // A comment is anchored by its quote and the text around it, never by DOM
  // position, and highlights are painted with the CSS Custom Highlight API, so
  // the article's DOM is untouched and "Copy for pasting" stays clean.
  function initReview(article) {
    const toggle = $("#toggle-comments"), badge = $("#comment-count");
    const path = article.dataset.path, viewing = article.dataset.version;
    const api = `/api/notes/${encodeURI(path)}/comments`;
    const canPaint = typeof Highlight === "function" && window.CSS && CSS.highlights;
    const BLOCK = "p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,figure,div,tr";
    const ws = /\s/;
    let comments = [], ranges = new Map(), showResolved = false, pending = null, cache = null;

    // The article's text as the reader sees it: text nodes in order, minus page
    // furniture and hidden sources. `sq` is the same with whitespace removed,
    // which is what quotes are matched against.
    function model() {
      if (cache) return cache;
      const nodes = [], starts = [];
      let full = "";
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest("[data-nocopy],[hidden],script,style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n; (n = walker.nextNode());) { nodes.push(n); starts.push(full.length); full += n.data; }
      let sq = "";
      const sqMap = [];
      for (let i = 0; i < full.length; i++) if (!ws.test(full[i])) { sq += full[i]; sqMap.push(i); }
      return (cache = { nodes, starts, full, sq, sqMap });
    }

    // Quote and context for a selection range.
    function describe(range) {
      const m = model();
      let first = -1, last = -1, quote = "", prev = null;
      m.nodes.forEach((n, i) => {
        if (!range.intersectsNode(n)) return;
        const s = n === range.startContainer ? range.startOffset : 0;
        const e = n === range.endContainer ? range.endOffset : n.length;
        if (e <= s) return;
        if (first < 0) first = m.starts[i] + s;
        last = m.starts[i] + e;
        const piece = n.data.slice(s, e);
        // Text from different blocks has no whitespace between it in the DOM.
        if (prev && !ws.test(quote.slice(-1)) && !ws.test(piece[0]) &&
            prev.parentElement.closest(BLOCK) !== n.parentElement.closest(BLOCK)) quote += " ";
        quote += piece; prev = n;
      });
      if (first < 0) return null;
      return {
        quote: quote.replace(/\s+/g, " ").trim(),
        prefix: m.full.slice(Math.max(0, first - 40), first),
        suffix: m.full.slice(last, last + 40),
      };
    }

    const common = (a, b, fromEnd) => {
      let n = 0;
      while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
      return n;
    };

    function pointAt(m, off, isEnd) {
      for (let i = 0; i < m.nodes.length; i++) {
        const len = m.nodes[i].length, at = off - m.starts[i];
        if (isEnd ? at > 0 && at <= len : at >= 0 && at < len) return [m.nodes[i], at];
      }
      return null;
    }

    // Where a stored comment is in this page, or null if its text is not here.
    function rangeFor(c) {
      const m = model();
      const needle = c.quote.replace(/\s+/g, "");
      if (!needle) return null;
      const pre = (c.prefix || "").replace(/\s+/g, ""), suf = (c.suffix || "").replace(/\s+/g, "");
      let best = -1, bestScore = -1;
      for (let i = m.sq.indexOf(needle); i !== -1; i = m.sq.indexOf(needle, i + 1)) {
        const end = i + needle.length;
        const score = common(m.sq.slice(Math.max(0, i - pre.length), i), pre, true) + common(m.sq.slice(end, end + suf.length), suf, false);
        if (score > bestScore) { best = i; bestScore = score; }
      }
      if (best < 0) return null;
      const a = pointAt(m, m.sqMap[best], false), b = pointAt(m, m.sqMap[best + needle.length - 1] + 1, true);
      if (!a || !b) return null;
      const r = document.createRange();
      r.setStart(...a); r.setEnd(...b);
      return r;
    }

    function paint() {
      ranges = new Map();
      for (const c of comments) {
        if (c.status !== "open") continue;
        const r = rangeFor(c);
        if (r) ranges.set(c.id, r);
      }
      const painted = (slop) => comments.filter((c) => c.status === "open" && (c.kind === "slop") === slop && ranges.has(c.id)).map((c) => ranges.get(c.id));
      if (canPaint) {
        CSS.highlights.set("clipmark-comment", new Highlight(...painted(false)));
        CSS.highlights.set("clipmark-slop", new Highlight(...painted(true)));
      }
      const open = comments.filter((c) => c.status === "open").length;
      badge.hidden = !open; badge.textContent = open;
    }

    const flash = (range) => {
      if (!canPaint) return;
      CSS.highlights.set("clipmark-active", new Highlight(range));
      setTimeout(() => CSS.highlights.delete("clipmark-active"), 1800);
    };

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };

    // ------------------------------------------------------------ the panel
    const panel = el("aside", "comments-panel");
    panel.id = "comments-panel"; panel.hidden = true; panel.setAttribute("data-nocopy", "");
    const head = el("div", "head");
    const showBox = Object.assign(document.createElement("input"), { type: "checkbox" });
    const showLabel = el("label", "muted");
    showLabel.append(showBox, " resolved");
    const close = el("button", null, "Close");
    head.append(el("strong", null, "Comments"), showLabel, close);
    const list = el("ul", "comment-list");
    panel.append(head, list);
    document.body.append(panel);

    close.onclick = () => (panel.hidden = true);
    toggle.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) renderList(); };
    showBox.onchange = () => { showResolved = showBox.checked; renderList(); };

    async function call(method, suffix, body) {
      const r = await fetch(api + suffix, { method, body: body && JSON.stringify(body), headers: body ? { "Content-Type": "application/json" } : {} });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
      return out;
    }

    function renderList() {
      list.replaceChildren();
      const shown = comments.filter((c) => showResolved || c.status === "open");
      if (!shown.length) list.append(el("li", "muted empty", comments.length ? "No open comments." : "Select text in the note to add a comment."));
      for (const c of shown) {
        const li = el("li", [c.kind === "slop" ? "slop" : "", c.status === "open" ? "" : "done"].join(" ").trim());
        const q = c.quote.length > 160 ? `${c.quote.slice(0, 160)}…` : c.quote;
        if (c.kind === "slop") li.append(el("p", "tag", `slop${c.pattern ? ` · ${c.pattern}` : ""}`));
        li.append(el("blockquote", null, q));
        if (c.comment) li.append(el("p", "text", c.comment));
        if (c.resolution) li.append(el("p", "muted", `Resolved: ${c.resolution}`));
        if (c.status === "open" && !ranges.has(c.id)) li.append(el("p", "muted", "This text is not in the version you are viewing."));
        const bar = el("div", "actions");
        const act = (label, fn) => {
          const b = el("button", null, label);
          b.onclick = async (e) => {
            e.stopPropagation(); b.disabled = true;
            try { await fn(); } catch (err) { toast(err.message || String(err), true); }
            b.disabled = false;
          };
          bar.append(b);
        };
        if (c.status === "open") act("Resolve", async () => { await call("PATCH", `/${c.id}`, { status: "resolved" }); await load(); });
        else act("Reopen", async () => { await call("PATCH", `/${c.id}`, { status: "open" }); await load(); });
        act("Delete", async () => { if (confirm("Delete this comment?")) { await call("DELETE", `/${c.id}`); await load(); } });
        li.append(bar);
        li.onclick = () => {
          const r = ranges.get(c.id);
          if (!r) return;
          r.startContainer.parentElement.scrollIntoView({ block: "center", behavior: "smooth" });
          flash(r);
        };
        list.append(li);
      }
    }

    async function load() {
      try { comments = (await call("GET", "?status=all")).comments; } catch (e) { console.warn("comments", e); return; }
      paint();
      renderList();
    }

    // ------------------------------------------------------- adding a comment
    const addBar = el("div", "comment-add");
    addBar.hidden = true; addBar.setAttribute("data-nocopy", "");
    const addBtn = el("button", "primary", "Comment");
    const slopBtn = el("button", null, "Slop");
    slopBtn.title = "Flag this as AI-sounding writing";
    addBar.append(addBtn, slopBtn);
    const form = el("form", "comment-form");
    form.hidden = true; form.setAttribute("data-nocopy", "");
    const PATTERNS = ["throat-clearing", "faux-insight", "rhetorical-setup", "binary-contrast", "negative-listing", "colon-reveal",
      "superficial-analysis", "importance-puffery", "metadiscourse", "roadmap-sentence", "weasel-attribution", "fake-strong-verb",
      "synonym-cycling", "fragmentation", "robotic-rhythm", "fake-profound-kicker", "summary-recap", "closing-offer",
      "formatting-slop", "bullet-inflation", "em-dash", "banned-word", "filler"];
    const patternSel = el("select");
    patternSel.append(new Option("Which pattern? (optional)", ""), ...PATTERNS.map((p) => new Option(p, p)));
    const ta = el("textarea"); ta.rows = 3;
    let kind = "comment";
    const formBar = el("div", "actions");
    const submit = el("button", "primary", "Comment"); submit.type = "submit";
    const cancel = el("button", null, "Cancel"); cancel.type = "button";
    formBar.append(submit, cancel);
    form.append(patternSel, ta, formBar);
    document.body.append(addBar, form);

    function placeNear(node, range) {
      const rects = range.getClientRects();
      const r = rects[rects.length - 1] || range.getBoundingClientRect();
      node.style.top = `${r.bottom + window.scrollY + 6}px`;
      node.style.left = `${Math.max(8, Math.min(r.right + window.scrollX - 20, window.scrollX + document.documentElement.clientWidth - 300))}px`;
    }

    function hideAdd() { addBar.hidden = true; }
    function closeForm() { form.hidden = true; ta.value = ""; patternSel.value = ""; pending = null; CSS.highlights?.delete("clipmark-active"); }

    function onSelect() {
      if (!form.hidden) return;
      const sel = getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return hideAdd();
      const range = sel.getRangeAt(0);
      if (!article.contains(range.commonAncestorContainer)) return hideAdd();
      const info = describe(range);
      if (!info || !info.quote) return hideAdd();
      pending = { ...info, range: range.cloneRange() };
      placeNear(addBar, range);
      addBar.hidden = false;
    }
    document.addEventListener("mouseup", () => setTimeout(onSelect, 0));
    document.addEventListener("keyup", (e) => { if (e.shiftKey || e.key.startsWith("Arrow")) onSelect(); });
    document.addEventListener("mousedown", (e) => { if (!addBar.contains(e.target)) hideAdd(); });

    addBar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
    addBtn.onclick = () => openForm("comment");
    slopBtn.onclick = () => openForm("slop");
    function openForm(k) {
      if (!pending) return;
      kind = k;
      patternSel.hidden = k !== "slop";
      ta.placeholder = k === "slop" ? "Why does this read as AI? (optional, but the reason is the useful part)" : "What should change?";
      submit.textContent = k === "slop" ? "Flag as slop" : "Comment";
      hideAdd();
      placeNear(form, pending.range);
      form.hidden = false;
      if (canPaint) CSS.highlights.set("clipmark-active", new Highlight(pending.range));
      ta.focus();
    }
    cancel.onclick = closeForm;
    ta.onkeydown = (e) => {
      if (e.key === "Escape") closeForm();
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") form.requestSubmit();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!pending || (!body && kind === "comment")) return;
      submit.disabled = true;
      try {
        const { quote, prefix, suffix } = pending;
        await call("POST", "", { quote, prefix, suffix, body, kind, pattern: kind === "slop" ? patternSel.value || undefined : undefined, version: viewing || undefined });
        closeForm();
        getSelection().removeAllRanges();
        await load();
        const moved = await refreshReviewBars();
        toast((kind === "slop" ? "Flagged as slop" : "Comment added") + (moved ? ". Moved to Refining" : ""));
      } catch (err) { toast(err.message || String(err), true); }
      submit.disabled = false;
    };

    window.addEventListener("focus", load); // pick up resolutions made elsewhere
    return load();
  }

  // ------------------------------------------------------------ note page
  async function initNote() {
    const article = $("#note");
    await renderMermaid(article);
    const source = JSON.parse($("#note-source")?.textContent ?? '""');
    const modeSel = $("#diagram-mode");
    if (modeSel) {
      modeSel.value = localStorage.getItem("clipmark.diagramMode") || "image";
      modeSel.onchange = () => localStorage.setItem("clipmark.diagramMode", modeSel.value);
    }
    const copyRichBtn = $("#copy-rich");
    if (copyRichBtn) copyRichBtn.onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const html = await exportHtml(article, modeSel?.value || "image");
        if (await copyRich(html, source)) toast("Copied - paste into your editor");
        else toast("Copy failed", true);
      } catch (err) { toast(err.message || String(err), true); }
      b.disabled = false;
    };
    const copyLinkBtn = $("#copy-link");
    if (copyLinkBtn) copyLinkBtn.onclick = async (e) => {
      if (await copyText(e.currentTarget.dataset.url)) toast("Link copied");
      else toast("Copy failed", true);
    };
    const copyMdBtn = $("#copy-md");
    if (copyMdBtn) copyMdBtn.onclick = async () => {
      if (await copyText(source)) toast("Markdown copied");
      else toast("Copy failed", true);
    };
    initReviewBar();
    initLinkBox();
    initDiff();
    initSearchHits(article);
    initChanges(article);
    initReview(article);
  }

  // ------------------------------------------------------ search highlights
  // Opened from a search result: paint the words the search matched, with the
  // same overlay the comments use, so nothing is added to the article and
  // "Copy for pasting" is unaffected.
  function initSearchHits(article) {
    let hits = [];
    try { hits = JSON.parse(article.dataset.hits || "[]"); } catch { return; }
    if (!hits.length || !(typeof Highlight === "function" && window.CSS && CSS.highlights)) return;
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${hits.sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\p{L}\\p{N}])`, "giu");
    const ranges = [];
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest("[data-nocopy],[hidden],script,style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n; (n = walker.nextNode());) {
      for (const m of n.data.matchAll(re)) {
        const r = document.createRange();
        r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        ranges.push(r);
      }
    }
    if (!ranges.length) return;
    CSS.highlights.set("clipmark-search", new Highlight(...ranges));
    ranges[0].startContainer.parentElement.scrollIntoView({ block: "center" });
  }

  // ------------------------------------------------------- changed blocks
  // The page is rendered from the same Markdown the server split into blocks,
  // so block N of the diff is the Nth top-level element here. Painted with the
  // highlight overlay, so the article's DOM is untouched. If the counts do not
  // line up (raw HTML, footnotes), nothing is painted rather than the wrong thing.
  function initChanges(article) {
    let info = null;
    try { info = JSON.parse(article.dataset.changes || "null"); } catch { return; }
    if (!info || !(typeof Highlight === "function" && window.CSS && CSS.highlights)) return;
    const kids = Array.from(article.children);
    if (kids.length !== info.total) return;
    const box = $("#show-changes");
    const ranges = info.blocks.map((i) => { const r = document.createRange(); r.selectNodeContents(kids[i]); return r; });
    const apply = () => {
      if (!box || box.checked) CSS.highlights.set("clipmark-changed", new Highlight(...ranges));
      else CSS.highlights.delete("clipmark-changed");
      if (box) localStorage.setItem("clipmark.showChanges", box.checked ? "1" : "0");
    };
    if (box) { box.checked = localStorage.getItem("clipmark.showChanges") !== "0"; box.onchange = apply; }
    apply();
  }

  // Commenting can change a note's review state on the server. Take the bars
  // from a fresh copy of the page, so the wording and buttons stay the server's,
  // and report whether the note just became "refining".
  async function refreshReviewBars() {
    const bars = $$(".reviewbar");
    if (!bars.length) return false;
    try {
      const doc = new DOMParser().parseFromString(await (await fetch(location.href)).text(), "text/html");
      const fresh = $$(".reviewbar", doc);
      if (fresh.length !== bars.length) return false;
      const was = bars[0].classList.contains("state-refining");
      bars.forEach((old, i) => old.replaceWith(fresh[i]));
      if (!$("#show-changes") && window.CSS && CSS.highlights) CSS.highlights.delete("clipmark-changed");
      initReviewBar();
      return !was && fresh[0].classList.contains("state-refining");
    } catch { return false; }
  }

  // ----------------------------------------------------- published link
  // Record, change or remove where this note is published; the page reloads so
  // the button and the "out of date" marker come from the server.
  function initLinkBox() {
    const box = $(".linkbox");
    if (!box) return;
    const api = `/api/notes/${encodeURI(box.dataset.path)}/link`;
    const send = async (method, body) => {
      try {
        const r = await fetch(api, { method, body: body && JSON.stringify(body), headers: body ? { "Content-Type": "application/json" } : {} });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        location.reload();
      } catch (err) { toast(err.message || String(err), true); }
    };
    $(".linkform", box).onsubmit = (e) => { e.preventDefault(); send("PUT", { url: e.currentTarget.url.value.trim() }); };
    $("[data-link=refresh]", box)?.addEventListener("click", () => send("PUT", {}));
    $("[data-link=clear]", box)?.addEventListener("click", () => { if (confirm("Remove the link to the published copy?")) send("DELETE"); });
    document.addEventListener("mousedown", (e) => { if (box.open && !box.contains(e.target)) box.open = false; });
  }

  // ---------------------------------------------------------- review bar
  // Where the note stands in the queue. The choices are plain PATCHes; the
  // page reloads afterwards so the bar and the queue agree with the server.
  function initReviewBar() {
    const bars = $$(".reviewbar");
    if (!bars.length) return;
    const api = `/api/notes/${encodeURI(bars[0].dataset.path)}/review`;
    for (const b of bars.flatMap((bar) => $$("button[data-action]", bar))) {
      b.onclick = async () => {
        const open = Number($("#comment-count")?.textContent) || 0;
        if (b.dataset.action === "settle" && open &&
            !confirm(`${open} comment${open === 1 ? " is" : "s are"} still open. Settle anyway? They stay open.`)) return;
        b.disabled = true;
        try {
          const r = await fetch(api, { method: "PATCH", body: JSON.stringify({ action: b.dataset.action }) });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
          location.reload();
        } catch (err) { toast(err.message || String(err), true); b.disabled = false; }
      };
    }
  }

  // ----------------------------------------------------------- diff page
  // Unified or side by side is a class on the article, remembered per browser.
  function initDiff() {
    const article = $("#note.diff");
    if (!article) return;
    const set = (layout) => {
      article.classList.toggle("split", layout === "split");
      for (const b of $$("button[data-layout]")) b.classList.toggle("on", b.dataset.layout === layout);
      localStorage.setItem("clipmark.diffLayout", layout);
    };
    set(localStorage.getItem("clipmark.diffLayout") === "split" ? "split" : "unified");
    for (const b of $$("button[data-layout]")) b.onclick = () => set(b.dataset.layout);
    const only = $("#changes-only");
    if (only) {
      only.checked = localStorage.getItem("clipmark.diffChangesOnly") === "1";
      const apply = () => { article.classList.toggle("only-changes", only.checked); localStorage.setItem("clipmark.diffChangesOnly", only.checked ? "1" : "0"); };
      only.onchange = apply; apply();
    }
  }

  // ------------------------------------------------------- review dashboard
  function initDash() {
    const btn = $("#settle-old");
    if (!btn) return;
    btn.onclick = async () => {
      // "Today" is the reviewer's today, not the server's.
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      if (!confirm("Settle every note you have never reviewed that was last changed before today? Notes changed today stay in the queue.")) return;
      btn.disabled = true;
      try {
        const r = await fetch("/api/review/settle-before", { method: "POST", body: JSON.stringify({ before: midnight.toISOString() }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
        location.reload();
      } catch (err) { toast(err.message || String(err), true); btn.disabled = false; }
    };
  }

  // ---------------------------------------------------------- editor page
  function initEditor() {
    const ta = $("#edit-md"), preview = $("#preview"), pathIn = $("#edit-path");
    const tokenIn = $("#edit-token"), status = $("#save-status");
    if (tokenIn) {
      tokenIn.value = localStorage.getItem("clipmark.token") || "";
      tokenIn.onchange = () => localStorage.setItem("clipmark.token", tokenIn.value);
    }
    let timer;
    const refresh = async () => {
      const r = await fetch("/api/render", { method: "POST", body: ta.value, headers: { "Content-Type": "text/markdown" } });
      preview.innerHTML = await r.text();
      await renderMermaid(preview);
    };
    ta.oninput = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };
    refresh();
    ta.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); $("#save").click(); } };
    $("#save").onclick = async () => {
      let p = pathIn.value.trim();
      if (!p) { toast("Give the note a path, e.g. team/design.md", true); pathIn.focus(); return; }
      if (!p.endsWith(".md")) p += ".md";
      const headers = { "Content-Type": "text/markdown" };
      if (tokenIn?.value) headers.Authorization = `Bearer ${tokenIn.value}`;
      status.textContent = "publishing…";
      const r = await fetch(`/api/notes/${encodeURI(p)}`, { method: "PUT", body: ta.value, headers });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { status.textContent = ""; toast(body.error || `HTTP ${r.status}`, true); return; }
      status.textContent = body.changed ? `published v${body.version}` : "no changes";
      toast(body.changed ? "Published" : "Nothing changed");
      if (pathIn && !pathIn.readOnly) { pathIn.readOnly = true; history.replaceState(null, "", `/edit/${encodeURI(p)}`); }
    };
  }

  // ----------------------------------------------------------- index page
  // The form works without this; it only adds select-all and a live count.
  function initIndex() {
    const form = $("#export-form"), all = $("#select-all"), btn = $("#export-selected"), count = $("#export-count");
    if (!form || !btn) return;
    const boxes = () => $$("input[name=path]", form);
    const update = () => {
      const n = boxes().filter((b) => b.checked).length;
      btn.disabled = n === 0;
      count.textContent = n ? `${n} selected` : "";
      if (all) { all.checked = n > 0 && n === boxes().length; all.indeterminate = n > 0 && n < boxes().length; }
    };
    if (all) all.onchange = () => { boxes().forEach((b) => (b.checked = all.checked)); update(); };
    form.addEventListener("change", update);
    // Shift-click selects the range since the last box clicked.
    let last = null;
    form.addEventListener("click", (e) => {
      const box = e.target.closest("input[name=path]");
      if (!box) return;
      if (e.shiftKey && last && last !== box) {
        const list = boxes(), a = list.indexOf(last), b = list.indexOf(box);
        list.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => (x.checked = box.checked));
        update();
      }
      last = box;
    });
    update();
  }

  if (document.body.classList.contains("note")) initNote();
  else if (document.body.classList.contains("edit")) initEditor();
  else if (document.body.classList.contains("index")) initIndex();
  else if (document.body.classList.contains("dash")) initDash();
})();
