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

  if (document.body.classList.contains("note")) initNote();
  else if (document.body.classList.contains("edit")) initEditor();
})();
