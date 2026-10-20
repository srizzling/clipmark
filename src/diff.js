// A review diff compares two versions of a note as rendered blocks, not as
// source lines: a reviewer cares that a paragraph or a table changed, and
// wants to read it as it will look. Each side is split into its top-level
// blocks (paragraph, list, table, code fence, ...), the blocks are aligned,
// and every row carries the rendered HTML of the old and the new block.

import { parse, render } from "./render.js";

// Largest middle section (after trimming what both sides share) that gets an
// exact alignment. Past it the section is shown as wholly replaced.
const MAX_CELLS = 4_000_000;

// The source of each top-level block, in order.
export function blocksOf(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  for (const t of parse(markdown)) {
    if (t.level !== 0 || !t.map || t.nesting === -1) continue;
    const src = lines.slice(t.map[0], t.map[1]).join("\n").trim();
    if (src) out.push(src);
  }
  return out;
}

// Longest common subsequence of two arrays of strings, as a list of
// ["same" | "del" | "add", index] steps.
function align(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length, hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }

  const steps = [];
  for (let i = 0; i < lo; i++) steps.push(["same", i, i]);

  const n = hiA - lo, m = hiB - lo;
  if (n * m > MAX_CELLS) {
    for (let i = lo; i < hiA; i++) steps.push(["del", i, -1]);
    for (let j = lo; j < hiB; j++) steps.push(["add", -1, j]);
  } else {
    // dp[i][j] = LCS length of a[lo+i..] and b[lo+j..]
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[lo + i] === b[lo + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[lo + i] === b[lo + j]) { steps.push(["same", lo + i, lo + j]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) steps.push(["del", lo + i++, -1]);
      else steps.push(["add", -1, lo + j++]);
    }
    while (i < n) steps.push(["del", lo + i++, -1]);
    while (j < m) steps.push(["add", -1, lo + j++]);
  }

  for (let k = 0; hiA + k < a.length; k++) steps.push(["same", hiA + k, hiB + k]);
  return steps;
}

const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

// Is `b` plausibly `a` rewritten? Blocks that share nothing are an unrelated
// removal and addition, and showing them as one edit would mislead.
function related(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return a === b;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= 0.2;
}

// Rows for the diff view. kind is "same", "changed" (a block rewritten in
// place), "removed" or "added". `old` and `new` are rendered HTML, or null.
// Each row also says which block of the new note it is (`at`), so a caller can
// find it on a page rendered from the same Markdown. `html: false` skips
// rendering when only the shape of the change is wanted.
export function diffNotes(oldMarkdown, newMarkdown, { html = true } = {}) {
  const a = blocksOf(oldMarkdown ?? ""), b = blocksOf(newMarkdown ?? "");
  const rows = [];
  const show = html ? render : () => null;
  let dels = [], adds = [];
  // Between two unchanged blocks, pair each removed block with the next added
  // block it resembles; whatever is left over is a plain removal or addition.
  const flush = () => {
    let next = 0;
    const added = (j) => rows.push({ kind: "added", old: null, new: show(b[j]), at: j });
    for (const i of dels) {
      const k = adds.findIndex((j, at) => at >= next && related(a[i], b[j]));
      if (k < 0) { rows.push({ kind: "removed", old: show(a[i]), new: null, at: null }); continue; }
      for (; next < k; next++) added(adds[next]);
      rows.push({ kind: "changed", old: show(a[i]), new: show(b[adds[k]]), at: adds[k] });
      next = k + 1;
    }
    for (; next < adds.length; next++) added(adds[next]);
    dels = []; adds = [];
  };
  for (const [kind, i, j] of align(a, b)) {
    if (kind === "del") dels.push(i);
    else if (kind === "add") adds.push(j);
    else {
      flush();
      const rendered = show(b[j]);
      rows.push({ kind: "same", old: rendered, new: rendered, at: j });
    }
  }
  flush();
  const count = (k) => rows.filter((r) => r.kind === k).length;
  return { rows, blocks: b.length, stats: { added: count("added"), removed: count("removed"), changed: count("changed"), same: count("same") } };
}
