// Review comments. A reader selects text on the rendered page and says what is
// wrong with it; the comment keeps the quote plus a little text either side,
// not a DOM position, so it still finds its place after the note is re-rendered
// or republished. The agent that wrote the note reads the comments back and
// needs to know where in the *Markdown* each one points, which is what locate()
// works out.

// Characters that are Markdown syntax in the source but absent from the
// rendered text. Dropped from both sides before comparing.
const SYNTAX = new Set("*_`~#>|\\![]");
// What can precede the text on a line: block quotes, then a list or task marker.
const LINE_LEAD = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

export const strip = (s) => {
  let out = "";
  for (const ch of String(s)) if (!SYNTAX.has(ch) && !/\s/.test(ch)) out += ch;
  return out;
};

// The source with whitespace and syntax removed, and for every kept character
// the offset it came from. Link destinations ("](url)") are dropped whole,
// since they never appear in the rendered text.
function squash(md) {
  let text = "";
  const map = [];
  let lineStart = true;
  for (let i = 0; i < md.length; i++) {
    if (lineStart) {
      const eol = md.indexOf("\n", i);
      i += LINE_LEAD.exec(md.slice(i, eol === -1 ? md.length : eol))[0].length;
      lineStart = false;
      if (i >= md.length) break;
    }
    const ch = md[i];
    if (ch === "\n") { lineStart = true; continue; }
    if (ch === "]" && md[i + 1] === "(") {
      let depth = 0, j = i + 1;
      for (; j < md.length && md[j] !== "\n"; j++) {
        if (md[j] === "(") depth++;
        else if (md[j] === ")" && --depth === 0) break;
      }
      i = j;
      continue;
    }
    if (SYNTAX.has(ch) || /\s/.test(ch)) continue;
    text += ch;
    map.push(i);
  }
  return { text, map };
}

const tail = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
const head = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };

// Where in `markdown` does the quote sit? Returns null when it is not there any
// more. When the quote occurs several times, the surrounding text decides.
export function locate(markdown, { quote, prefix = "", suffix = "" }) {
  const needle = strip(quote);
  if (!needle) return null;
  const { text, map } = squash(markdown);
  const hits = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) hits.push(i);
  if (!hits.length) return null;
  const pre = strip(prefix), suf = strip(suffix);
  let best = hits[0], bestScore = -1;
  for (const i of hits) {
    const end = i + needle.length;
    const score = tail(text.slice(Math.max(0, i - pre.length), i), pre) + head(text.slice(end, end + suf.length), suf);
    if (score > bestScore) { best = i; bestScore = score; }
  }
  const start = map[best];
  const last = map[best + needle.length - 1];
  const lineOf = (off) => markdown.slice(0, off).split("\n").length;
  const lines = [lineOf(start), lineOf(last)];
  const all = markdown.split("\n");
  return { start, end: last + 1, lines, source: all.slice(lines[0] - 1, lines[1]).join("\n") };
}

// The paragraph (or list, or table) of Markdown the located text sits in.
export function paragraphAround(markdown, { start, end }, max = 1500) {
  const before = markdown.lastIndexOf("\n\n", start);
  const after = markdown.indexOf("\n\n", end);
  const text = markdown.slice(before === -1 ? 0 : before + 2, after === -1 ? markdown.length : after).trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// The reviewer's comments as one block of Markdown for an agent to work from.
export function digest({ path, latest, comments }) {
  const open = comments.filter((c) => c.status === "open").length;
  const out = [
    `# Review comments for ${path}`,
    "",
    `${comments.length} shown, ${open} open. Latest version: ${latest ?? "none"}.`,
    "Change the note to address each comment, publish it, then mark the comment resolved.",
    ...(comments.some((c) => c.kind === "slop")
      ? ["Entries marked slop flag writing that sounds machine-written. Cut or rewrite them plainly, keeping the fact underneath.", ""]
      : [""]),
  ];
  for (const c of comments) {
    const where = c.located ? (c.lines[0] === c.lines[1] ? `line ${c.lines[0]}` : `lines ${c.lines[0]}-${c.lines[1]}`) : "quote not found in the latest version";
    const label = c.kind === "slop" ? `slop${c.pattern ? ` (${c.pattern})` : ""}` : null;
    out.push(`## ${[c.id, label, c.status, where].filter(Boolean).join(" · ")}`, "");
    out.push(...c.quote.split("\n").map((l) => `> ${l}`), "");
    if (c.comment) out.push(c.comment, "");
    if (c.resolution) out.push(`Resolution: ${c.resolution}`, "");
    if (c.located) out.push("Source:", "", "~~~~markdown", c.source.length > 2000 ? `${c.source.slice(0, 2000)}…` : c.source, "~~~~", "");
  }
  return out.join("\n");
}

// Slop flags from every note, grouped by pattern, for reading in one go.
export function slopDigest(flags) {
  const out = ["# Slop flags", "", `${flags.length} flagged. Quotes are the original text, before any rewrite.`, ""];
  const groups = new Map();
  for (const f of flags) groups.set(f.pattern ?? "untagged", [...(groups.get(f.pattern ?? "untagged") ?? []), f]);
  for (const [pattern, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`## ${pattern} (${items.length})`, "");
    for (const f of items) {
      out.push(`- ${f.note} ${f.id} · ${f.status} · ${f.created.slice(0, 10)}`);
      out.push(...f.quote.split("\n").map((l) => `  > ${l}`));
      out.push(f.feedback ? `  Why: ${f.feedback}` : "  Why: (no reason given)");
      if (f.context) out.push(`  In context (${f.title}):`, ...f.context.split("\n").map((l) => `  | ${l}`));
      if (f.resolution) out.push(`  What changed: ${f.resolution}`);
      out.push("");
    }
  }
  return out.join("\n");
}
