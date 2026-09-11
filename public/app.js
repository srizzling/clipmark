/* Client side: render Mermaid, and copy the note as rich text.
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

  // ------------------------------------------------------------ note page
  async function initNote() {
    const article = $("#note");
    await renderMermaid(article);
    const source = $("#note-source")?.textContent ?? "";
    const modeSel = $("#diagram-mode");
    if (modeSel) {
      modeSel.value = localStorage.getItem("clipmark.diagramMode") || "image";
      modeSel.onchange = () => localStorage.setItem("clipmark.diagramMode", modeSel.value);
    }
    $("#copy-rich").onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const html = await exportHtml(article, modeSel?.value || "image");
        if (await copyRich(html, source)) toast("Copied - paste into your editor");
        else toast("Copy failed", true);
      } catch (err) { toast(err.message || String(err), true); }
      b.disabled = false;
    };
    $("#copy-link").onclick = async (e) => {
      if (await copyText(e.currentTarget.dataset.url)) toast("Link copied");
      else toast("Copy failed", true);
    };
    $("#copy-md").onclick = async () => {
      if (await copyText(source)) toast("Markdown copied");
      else toast("Copy failed", true);
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
})();
