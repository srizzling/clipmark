// Splits one large Markdown document into parts small enough to render.
//
// Rendering costs many times a note's size in memory, so a big document is
// published as a contents note plus parts beside it (`guide.md`,
// `guide.part-01.md`, ...). Each part is an ordinary note: it renders, copies,
// is reviewed and commented on by itself.
//
// This reads lines, never markdown-it tokens, because building tokens for the
// whole document is exactly the cost being avoided. For the same reason it
// keeps offsets into the original text rather than copies of it, and builds a
// part's text only when it is asked for: a 20 MB document must split in far
// less memory than rendering it would take.
//
// Parts break at headings where they can and between blocks otherwise; a
// table or code fence too big for one part is cut between rows or lines, with
// its header or fence repeated. Footnote and link reference definitions
// follow the parts that use them, and `#anchor` links whose heading lands in
// another part are pointed at that part.

import { anchorOf } from "./render.js";

// Sizes are in characters, which is bytes for ASCII.
export const PART_SIZE = 512 * 1024;
export const PART_RE = /^(.+)\.part-(\d+)\.md$/;

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:/;
const REF_DEF = /^ {0,3}\[([^\]^][^\]]*)\]:\s*\S/;

const blank = (line) => !line.trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Heading text roughly as the renderer sees it: markup gone, link text kept.
function headingText(raw) {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*`]/g, "")
    .replace(/(^|\W)_+|_+(?=\W|$)/g, "$1")
    .trim();
}

function headingOf(first, second) {
  const m = ATX.exec(first);
  if (m) return { level: m[1].length, text: headingText(m[2] ?? ""), lines: 1 };
  if (second !== undefined && SETEXT.test(second) && !first.includes("|")) {
    return { level: second.trim()[0] === "=" ? 1 : 2, text: headingText(first), lines: 2 };
  }
  return null;
}

// Each line of md[from, to) as [start, end of text, start of next line].
function* lines(md, from = 0, to = md.length) {
  for (let i = from; i < to;) {
    const j = md.indexOf("\n", i);
    const eol = j < 0 || j >= to ? to : j;
    const next = j < 0 || j >= to ? to : j + 1;
    yield [i, eol, next];
    i = next;
  }
}

// Top-level units, in order: runs of lines between blank lines, a fenced
// block whole, and a new unit at every ATX heading. A unit is a range of the
// document, { kind, start, end, heading, bare }, with the blank lines after it,
// so the units cover the document exactly. `bare` is a heading with nothing
// under it in the same unit.
export function* units(md) {
  let cur = null, pending = null;
  const classify = (u) => {
    u.heading = null;
    if (u.kind === "text" && u.first !== undefined) {
      u.heading = headingOf(u.first, u.second);
      u.bare = !!u.heading && u.count === u.heading.lines;
      if (FOOTNOTE_DEF.test(u.first)) u.kind = "footnote";
      else if (u.allRefs) u.kind = "refs";
      else if (u.second !== undefined && u.first.includes("|") && TABLE_DELIM.test(u.second)) u.kind = "table";
    }
    return u;
  };
  const open = function* (kind, start) {
    if (cur) {
      const u = classify(cur);
      // A footnote's indented continuation paragraphs belong to it.
      if (pending?.kind === "footnote" && u.kind === "text" && /^(?: {4}|\t)/.test(u.first ?? "")) pending.end = u.end;
      else { if (pending) yield pending; pending = u; }
    }
    cur = kind && { kind, start, end: start, count: 0, lastBlank: false, allRefs: true };
  };
  const it = lines(md);
  for (let r = it.next(); !r.done; r = it.next()) {
    const [s, e, next] = r.value;
    const line = md.slice(s, e);
    if (blank(line)) {
      if (!cur) yield* open("text", s);
      cur.end = next; cur.lastBlank = true;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      yield* open("fence", s);
      cur.first = line;
      cur.end = next;
      for (let q = it.next(); !q.done; q = it.next()) {
        const [s2, e2, n2] = q.value;
        cur.end = n2;
        const c = FENCE_CLOSE.exec(md.slice(s2, e2));
        if (c && c[1][0] === fence[1][0] && c[1].length >= fence[1].length) { cur.close = [s2, e2]; break; }
      }
      continue;
    }
    if (!cur || cur.kind === "fence" || cur.lastBlank || ATX.test(line)) yield* open("text", s);
    if (cur.count === 0) cur.first = line; else if (cur.count === 1) cur.second = line;
    cur.count++;
    if (cur.allRefs && !REF_DEF.test(line)) cur.allRefs = false;
    cur.end = next;
  }
  yield* open(null);
  if (pending) yield pending;
}

// A unit as pieces that each fit in a part, every piece a list of segments:
// a range of the document, or literal text for a repeated table header or
// fence line. `code` marks text that anchor rewriting must not touch.
function* pieces(md, u, max) {
  const code = u.kind === "fence";
  if (u.end - u.start <= max) {
    yield { segs: [{ s: u.start, e: u.end, code }], size: u.end - u.start, heading: u.heading, bare: u.bare };
    return;
  }
  let head = "", foot = "", from = u.start, to = u.end, tail = null;
  if (u.kind === "table") {
    const [, , n1] = lines(md, u.start).next().value;
    const [, , n2] = lines(md, n1).next().value;
    head = md.slice(u.start, n2); from = n2;
  } else if (u.kind === "fence") {
    const [, , n1] = lines(md, u.start).next().value;
    head = md.slice(u.start, n1); from = n1;
    if (u.close) { foot = md.slice(u.close[0], u.close[1]) + "\n"; to = u.close[0]; tail = { s: u.close[0], e: u.end, code }; }
    else foot = FENCE_OPEN.exec(u.first)[1] + "\n";
  }
  const room = Math.max(1, max - head.length - foot.length);
  let start = from, first = true;
  const piece = (end, last) => {
    const segs = [];
    if (head) segs.push(head);
    segs.push({ s: start, e: end, code });
    if (last && tail) segs.push(tail); else if (foot) segs.push(foot);
    const size = segs.reduce((n, g) => n + (typeof g === "string" ? g.length : g.e - g.s), 0);
    const p = { segs, size, heading: first ? u.heading : null, bare: false };
    first = false; start = end;
    return p;
  };
  for (const [s, , next] of lines(md, from, to)) {
    if (s > start && next - start > room) yield piece(s, false);
  }
  yield piece(to, true);
}

// The parts' file names, beside the note so relative links still resolve.
export const partPath = (rel, n, total) =>
  `${rel.replace(/\.md$/, "")}.part-${String(n).padStart(Math.max(2, String(total).length), "0")}.md`;

// { index, parts: [{ path, title, size, markdown }] }, with parts: [] when the
// document fits in one part. A part's `markdown` is built when read, so take
// it once per part.
export function splitNote(rel, md, { max = PART_SIZE } = {}) {
  if (md.length <= max) return { index: md, parts: [] };

  const groups = [];
  const footnotes = new Map(), refs = new Map();
  let title = null, seenContent = false, cur = null;

  const add = (p) => {
    const level = p.heading?.level;
    if (cur && cur.size && ((level && level <= 2 && cur.size >= max / 8) || (level && cur.size >= max / 2))) cur = null;
    else if (cur && cur.size && cur.size + p.size > max && !(cur.pieces === 1 && cur.lastBare)) {
      // A heading alone at the end of a part goes with what it introduces.
      const carry = cur.pieces > 1 && cur.lastBare;
      if (carry) {
        const seg = cur.segs.at(-1);
        if (seg.s === carry.segs[0].s) cur.segs.pop(); else seg.e = carry.segs[0].s;
        cur.size -= carry.size; cur.headings.pop();
      }
      cur = null;
      if (carry) add(carry);
    }
    if (!cur) { cur = { segs: [], size: 0, pieces: 0, headings: [], startsWithHeading: !!p.heading }; groups.push(cur); }
    for (const g of p.segs) {
      const last = cur.segs.at(-1);
      if (typeof g !== "string" && last && typeof last !== "string" && last.e === g.s && last.code === g.code) last.e = g.e;
      else cur.segs.push(typeof g === "string" ? g : { ...g });
    }
    cur.size += p.size; cur.pieces++;
    cur.lastBare = p.bare ? p : null;
    if (p.heading) cur.headings.push(p.heading.text);
  };

  for (const u of units(md)) {
    if (u.kind === "footnote") { footnotes.set(FOOTNOTE_DEF.exec(u.first)[1], md.slice(u.start, u.end).replace(/\s+$/, "")); continue; }
    if (u.kind === "refs") {
      for (const [s, e] of lines(md, u.start, u.end)) {
        const l = md.slice(s, e);
        if (!blank(l)) refs.set(REF_DEF.exec(l)[1].toLowerCase(), l);
      }
      continue;
    }
    // The document's H1 stays on the contents note, as its title.
    if (!seenContent && u.first !== undefined) {
      seenContent = true;
      if (u.kind === "text" && u.heading?.level === 1) {
        let after = u.start;
        for (let k = 0; k < u.heading.lines; k++) after = lines(md, after).next().value[2];
        title = md.slice(u.start, after).replace(/\s+$/, "");
        if (blank(md.slice(after, u.end))) continue;
        u.start = after; u.heading = null; u.bare = false;
      }
    }
    for (const p of pieces(md, u, max)) add(p);
  }

  const total = groups.length;
  const paths = groups.map((_, i) => partPath(rel, i + 1, total));
  const file = (i) => encodeURI(paths[i].split("/").pop());

  // Where every heading ends up: its id in the whole document, and its id in
  // the part, which restarts the "-1" counting.
  const where = new Map(), seen = new Map();
  groups.forEach((g, i) => {
    const local = new Map();
    for (const text of g.headings) {
      const a = anchorOf(text);
      if (!a) continue;
      const n = seen.get(a) ?? 0, m = local.get(a) ?? 0;
      seen.set(a, n + 1); local.set(a, m + 1);
      where.set(n ? `${a}-${n}` : a, { part: i, id: m ? `${a}-${m}` : a });
    }
  });
  const fix = (text, i) => text.replace(/(\]\(|href=")#([^)"\s]+)/g, (all, lead, id) => {
    let key = id;
    try { key = decodeURIComponent(id); } catch { /* leave it */ }
    const w = where.get(key);
    return w ? `${lead}${w.part === i ? "" : file(w.part)}#${w.id}` : all;
  });

  const textOf = (g, i) => {
    let text = g.segs.map((s) => (typeof s === "string" ? s : s.code ? md.slice(s.s, s.e) : fix(md.slice(s.s, s.e), i))).join("").replace(/\s+$/, "") + "\n";
    const extra = [];
    for (const [id, def] of footnotes) if (text.includes(`[^${id}]`)) extra.push(def);
    const used = [...refs].filter(([id]) => new RegExp(`\\[${escapeRe(id)}\\]`, "i").test(text)).map(([, l]) => l);
    if (used.length) extra.push(used.join("\n"));
    if (extra.length) text += "\n" + extra.join("\n\n") + "\n";
    return text;
  };

  // A part that starts mid-section is named after the section it continues.
  let last = null;
  const parts = groups.map((g, i) => {
    const name = g.startsWithHeading ? g.headings[0] : last ? `${last} (continued)` : g.headings[0] ?? `Part ${i + 1}`;
    if (g.headings.length) last = g.headings.at(-1);
    return { path: paths[i], title: name || `Part ${i + 1}`, size: g.size, get markdown() { return textOf(g, i); } };
  });

  const contents = parts.map((p, i) => `${i + 1}. [${p.title.replace(/[[\]]/g, "\\$&")}](${file(i)})`);
  return { index: `${title ? `${title}\n\n` : ""}${contents.join("\n")}\n`, parts };
}
