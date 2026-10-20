// Search over notes: forgiving rather than exact. Every word of the query has
// to turn up somewhere in a note, in any order, and "quoted phrases" have to
// appear as typed. A word can match as itself, as the start of a longer word,
// inside one, or within a typo or two of one. Nothing here touches the disk;
// the store feeds it notes and keeps the indexes between searches.

const WORD = /[\p{L}\p{N}]+/gu;
const MAX_TERMS = 8, MAX_PHRASES = 3, MAX_QUERY = 200;
// What a match is worth, best first. Field weights are applied on top.
const TIER = { exact: 1, prefix: 0.8, inside: 0.5, typo: 0.35 };
const WEIGHT = { title: 10, path: 6, body: 1 };

// Lowercased words with where each one starts and ends, grouped by word.
export function vocabOf(text) {
  const vocab = new Map();
  for (const m of text.matchAll(WORD)) {
    const w = m[0].toLowerCase();
    if (!vocab.has(w)) vocab.set(w, []);
    vocab.get(w).push([m.index, m.index + m[0].length]);
  }
  return vocab;
}

// The text a reader sees, on one line: Markdown syntax dropped, link targets
// and fence markers gone. Offsets into this are what snippets are cut from.
export function plainText(markdown) {
  return markdown
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)?/gm, "")
    .replace(/^[ \t]*\|?[-: |]+\|?[ \t]*$/gm, "")
    .replace(/[*~`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function indexNote(markdown, title) {
  const plain = plainText(markdown);
  return { title, plain, lower: plain.toLowerCase(), vocab: vocabOf(plain), titleVocab: vocabOf(title), titleLower: title.toLowerCase() };
}

export function parseQuery(q) {
  const terms = [], phrases = [];
  for (const m of String(q ?? "").slice(0, MAX_QUERY).matchAll(/"([^"]+)"|(\S+)/g)) {
    if (m[1] !== undefined) {
      const p = m[1].toLowerCase().replace(/\s+/g, " ").trim();
      if (p && phrases.length < MAX_PHRASES && !phrases.includes(p)) phrases.push(p);
    } else {
      for (const w of m[2].toLowerCase().match(WORD) ?? []) if (terms.length < MAX_TERMS && !terms.includes(w)) terms.push(w);
    }
  }
  return { terms, phrases };
}

// Edit distance with swaps counting as one edit, giving up once it is over `max`.
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let before = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
      cur[j] = d;
      if (d < low) low = d;
    }
    if (low > max) return false;
    before = prev; prev = cur;
  }
  return prev[b.length] <= max;
}

// How well does `term` match the words in `vocab`? { score, words } where words
// are the vocabulary entries that matched, for finding them again.
function matchVocab(term, vocab) {
  let score = 0;
  const words = [];
  const take = (w, s) => { words.push(w); if (s > score) score = s; };
  for (const w of vocab.keys()) {
    if (w === term) take(w, TIER.exact);
    else if (w.startsWith(term)) take(w, TIER.prefix);
    else if (term.length >= 3 && w.includes(term)) take(w, TIER.inside);
  }
  // Typos only count when nothing matched properly, and only for longer words,
  // where one wrong letter is still plainly the same word.
  if (score < TIER.prefix && term.length >= 4) {
    const max = term.length >= 8 ? 2 : 1;
    for (const w of vocab.keys()) if (within(term, w, max)) take(w, TIER.typo);
  }
  return { score, words };
}

const clip = (text, from, to) => {
  while (from > 0 && from < text.length && text[from - 1] !== " ") from++;
  while (to < text.length && to > from && text[to] !== " ") to--;
  return [from, to];
};

// Cut about 200 characters around the spot where the most different query
// words are close together, and say where the matches sit inside it.
function snippetOf(plain, ranges) {
  if (!ranges.length) {
    const [, end] = clip(plain, 0, 160);
    return { snippet: plain.slice(0, end) + (end < plain.length ? "…" : ""), highlights: [] };
  }
  let anchor = ranges[0], best = -1;
  for (const r of ranges) {
    const near = new Set(ranges.filter((o) => Math.abs(o[0] - r[0]) <= 100).map((o) => o[2])).size;
    if (near > best) { best = near; anchor = r; }
  }
  const [from, to] = clip(plain, Math.max(0, anchor[0] - 60), Math.max(0, anchor[0] - 60) + 200);
  const lead = from > 0 ? 1 : 0;
  const highlights = ranges.filter((r) => r[0] >= from && r[1] <= to).map((r) => [r[0] - from + lead, r[1] - from + lead]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const h of highlights) {
    if (merged.length && h[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], h[1]);
    else merged.push([...h]);
  }
  return { snippet: (from > 0 ? "…" : "") + plain.slice(from, to) + (to < plain.length ? "…" : ""), highlights: merged };
}

// Score one indexed note against a parsed query, or null if it does not match.
// `meta` is { path, slug }; those are searched too, but are not part of the
// cached index because a slug can change without the file changing.
export function scoreNote(entry, query, meta) {
  const pathVocab = vocabOf(`${meta.path} ${meta.slug}`);
  const pathLower = `${meta.path} ${meta.slug}`.toLowerCase();
  const ranges = [], words = new Set();
  let score = 0;

  query.terms.forEach((term, ti) => {
    if (score < 0) return;
    const title = matchVocab(term, entry.titleVocab), path = matchVocab(term, pathVocab), body = matchVocab(term, entry.vocab);
    if (!title.score && !path.score && !body.score) { score = -1; return; }
    let occurrences = 0;
    for (const w of body.words) for (const r of entry.vocab.get(w)) { ranges.push([r[0], r[1], ti]); occurrences++; }
    for (const w of [...title.words, ...body.words]) words.add(w);
    // A few repeats count for something; a word said fifty times does not win.
    const bodyScore = body.score ? body.score + Math.min(0.5, 0.05 * (occurrences - 1)) : 0;
    score += Math.max(title.score * WEIGHT.title, path.score * WEIGHT.path, bodyScore * WEIGHT.body);
  });
  if (score < 0) return null;

  query.phrases.forEach((phrase, pi) => {
    if (score < 0) return;
    const inTitle = entry.titleLower.includes(phrase), inPath = pathLower.includes(phrase);
    let at = entry.lower.indexOf(phrase), found = 0;
    for (; at !== -1 && found < 5; at = entry.lower.indexOf(phrase, at + 1), found++) ranges.push([at, at + phrase.length, 100 + pi]);
    if (!inTitle && !inPath && !found) { score = -1; return; }
    words.add(phrase);
    score += inTitle ? 15 : found ? 5 : 3;
  });
  if (score < 0) return null;

  ranges.sort((a, b) => a[0] - b[0]);
  return { score: Math.round(score * 100) / 100, ...snippetOf(entry.plain, ranges), words: [...words] };
}
