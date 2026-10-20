# clipmark

Markdown notes, rendered and ready to paste.

clipmark serves a folder of Markdown files as a small website. Each page has a
**Copy for pasting** button that puts the rendered note on the clipboard as
rich text, so it lands in Confluence, Google Docs, Word, Outlook or any other
rich editor looking the way it looked on the page: headings, tables, code
blocks, lists, links and diagrams intact.

Publishing is one HTTP request, every change is kept, and there is no database.

- **GitHub-flavoured Markdown**: tables, task lists, strikethrough, autolinks,
  footnotes, fenced code, and `> [!NOTE]`-style alerts.
- **Mermaid diagrams** render in the page. On copy they go across as PNG
  images, as the Mermaid source in a code block, or both. Each diagram also
  has its own copy and download buttons, and a full-screen view with zoom
  and pan.
- **Alerts become panels.** `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
  `[!WARNING]` and `[!CAUTION]` are emitted as `<div data-panel-type=...>`,
  which the Confluence editor turns into its native info, success, note,
  warning and error panels on paste. Elsewhere they paste as a labelled block.
- **Code blocks keep their language** via `data-language`, which is what
  Confluence's code block reads back.
- **Short links.** Every note gets a memorable slug on first publish, like
  `/sleepy-wombat-hums`, and keeps it for life. Pick your own with
  `?slug=my-name` on the publish. The long `/n/<path>` form keeps working.
- **Versioned.** Every publish that changes a note keeps the previous copy.
  History is browsable in the UI and the API, and old versions render like
  any other page.
- **Bulk download.** Tick notes on the index and download their Markdown as
  one `.zip`, folders and Mermaid blocks intact. `GET /export` does the same
  for the API and the CLI.
- **Review comments.** Select text on a page and add a comment; it is
  highlighted in place and listed in a side panel. An agent reads the open
  comments back (`GET /api/notes/<path>/comments?format=md`, or
  `clipmark review`) with the source line each one points at, edits the note,
  and marks them resolved. Comments follow their text across versions.
  Highlights are painted over the page, not wrapped around the text, so copied
  content is unaffected.
- **Slop flags.** A second button next to **Comment** flags a passage as
  machine-sounding writing, with an optional pattern tag and a note. They
  show in red and are rewritten like any other comment, but `GET /api/slop`
  (or `clipmark slop`) also lists every flag across all notes, with the
  original text, its paragraph and the reviewer's reason kept after the
  rewrite, so the examples can be mined for what to stop writing.
- **Published copies.** Record where a note is published elsewhere, such as a
  Confluence page: paste the link in the toolbar and it becomes an **Open in
  Confluence** button, on the note, the review queue and `/all`. The site
  remembers which text was published, so when the note changes afterwards the
  link is marked **out of date** with a diff from the version that was
  published. Agents see the same thing in the publish response and from
  `GET /api/links?stale=1` (or `clipmark links stale`). It only notices the
  note changing here; edits made on the other side are not visible.
- **Search.** A box in every page header searches titles, text, paths and
  short links. Every word must appear, quoted phrases must match as written,
  and small typos in longer words are forgiven. Results show the matching text
  and the review state, and opening one highlights the matches. No index or
  database: notes are tokenized once and re-read only when they change.
  `GET /api/search?q=` (or `clipmark search`) does the same for agents.
- **Review queue.** The home page lists what is still **to review**, what
  you have read and sent back (**refining**) and what is **settled**. Open a
  note and choose **Keep refining** or **Settle**; opening alone changes
  nothing. Adding a comment to a note that is waiting or settled moves it to
  refining, since a comment means it needs more work. A new publish drops a reviewed or settled note back into the queue
  marked "changed since you read it", with a **diff** against the version you
  reviewed, as rendered blocks, unified or side by side. The note page itself
  shades what is new or rewritten, so you can read it whole. You can comment on the
  new side of the diff like on any page. State is one file, `.review.json`, in
  the notes directory. `GET /api/review` (or `clipmark queue`) gives agents
  the same view. The first time, **Settle everything older than today** clears
  notes that existed before review did and leaves today's in the queue.
- **Publish API** with an optional bearer token, plus a tiny `curl` wrapper.
- **No build step, no database, no external assets.** Node and two Markdown
  libraries; Mermaid is served from the container.

## Run it

```sh
docker run -d --name clipmark -p 8080:8080 \
  -v /path/to/notes:/notes \
  -e CLIPMARK_TOKEN=change-me \
  -e PUBLIC_URL=http://notes.example.lan:8080 \
  ghcr.io/srizzling/clipmark:latest
```

Or from a checkout: `npm ci && NOTES_DIR=./notes npm start`.

| Variable | Default | Purpose |
|---|---|---|
| `NOTES_DIR` | `/notes` (image) | where the `.md` files and `.versions/` live |
| `PORT` | `8080` | listen port |
| `CLIPMARK_TOKEN` | unset | if set, `PUT`/`DELETE` need `Authorization: Bearer <token>`. Unset means anyone who can reach the server can publish. |
| `PUBLIC_URL` | derived from `Host` | base URL used in API responses and the index page |
| `SITE_TITLE` | `Notes` | header text |

The container runs as `node` (uid 1000); the mounted notes directory has to be
writable by that user or `/healthz` will report `writable: false`.

## Publish

```sh
curl -X PUT -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: text/markdown" \
     --data-binary @design.md \
     http://notes.example.lan:8080/api/notes/team/design.md
```

Or with the wrapper in `bin/`:

```sh
export CLIPMARK_URL=http://notes.example.lan:8080 CLIPMARK_TOKEN=...
clipmark publish design.md team/design.md            # short link assigned
clipmark publish design.md team/design.md retry-plan # short link /retry-plan
clipmark list
clipmark history team/design.md
clipmark export team/design.md team/rollout.md > design.zip   # no paths = every note
```

There is also a browser editor at `/new` and `/edit/<path>` with a live
preview, which publishes through the same API.

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/notes` | list notes with titles and URLs |
| `GET` | `/api/notes/<path>` | one note: markdown, mtime, versions. `?v=<id>` for an old version |
| `GET` | `/api/notes/<path>/versions` | version list, newest first |
| `PUT` | `/api/notes/<path>` | create or update. Body is the Markdown. `201` on create, `200` on update, `changed: false` when the content was identical. `?slug=my-name` sets the short link |
| `DELETE` | `/api/notes/<path>` | remove the current copy. History is kept |
| `GET` | `/api/notes/<path>/comments` | review comments. `?status=open` (default), `resolved` or `all`; `?format=md` for a Markdown digest an agent can work from |
| `POST` | `/api/notes/<path>/comments` | add one: JSON `{ quote, body, prefix?, suffix?, version?, kind?, pattern? }`. `kind: "slop"` flags AI-sounding text and may omit `body`. `?kind=slop` filters the list |
| `GET` | `/api/slop` | every slop flag across all notes, quote and feedback kept. `?status=`, `?format=md` groups by pattern |
| `PATCH` | `/api/notes/<path>/comments/<id>` | JSON `{ status: "resolved" \| "open", resolution? }` |
| `DELETE` | `/api/notes/<path>/comments/<id>` | remove a comment |
| `POST` | `/api/render` | Markdown in, HTML fragment out. Nothing is saved |
| `GET` | `/<slug>` | rendered page at its short link. `?v=<id>` renders an old version |
| `GET` | `/n/<path>` | the same page at its long address |
| `GET` | `/raw/<path>` | the Markdown |
| `GET` | `/export?path=a.md&path=b.md` | a `.zip` of the named notes' Markdown, folders kept. No `path` means every note |
| `GET` | `/healthz` | `{ ok, version, notes, writable, renders }`. `503` when not ok |
| `GET` | `/llms.txt` | the API described in plain text for agents and tools, with this deployment's URL filled in |

Comments need no token, like reading a note; only publishing and deleting a
note do. Keep the server on a trusted network.

Paths are relative, may contain folders, and must end in `.md`. Segments may
not start with a dot; `_drafts/x.md` is fine. Files that are
not Markdown (images referenced from a note) are served from the same folder
at `/n/<path>` and are inlined into the copied HTML.

## How the copy works

The page HTML is already close to what editors want. At copy time the client
clones the article and:

1. replaces each Mermaid figure with a PNG rendered from its SVG (2x scale,
   white background), the source as a `mermaid` code block, or both,
   depending on the **Diagrams** selector;
2. turns task checkboxes into ☐ / ☑ text, since most editors drop form
   controls;
3. makes links absolute and inlines same-origin images as data URLs;
4. strips page furniture (classes, ids, footnote back-links);
5. writes `text/html` and `text/plain` (the Markdown source) to the clipboard.

If the page is served over plain `http` from a non-localhost address, the
browser refuses `navigator.clipboard.write()`. Rich text still works through a
synthetic copy event; images cannot go that way, so **Copy PNG** shows the
rendered image for a native right-click → Copy image instead. Serve over https
(or via a reverse proxy that does) and all buttons work directly.

Confluence Cloud also converts pasted plain Markdown, and both Cloud and Data
Center accept Markdown under **Insert → Markup**. The `text/plain` half of the
clipboard is the raw Markdown for exactly that path; **Copy Markdown** gives
you only that.

## Layout on disk

```
notes/
  .slugs.json                          { "sleepy-wombat-hums": "team/design.md", ... }
  team/design.md                       current copy
  .versions/team/design/
    2026-09-02T09-41-12.318Z.md        every published state, newest last
  .comments/team/design.json           review comments and slop flags for the note
```

Plain files: `ls` is the history browser of last resort, and `cp` is restore.

## Development

The repository uses [devenv](https://devenv.sh); `direnv allow` gives you Node
and npm. `dev` runs the server with reload on `:8102`, `npm test` runs the
suite (node:test, no extra dependencies).

Releases are git tags `vX.Y.Z`; CI runs the tests on every push and publishes
`ghcr.io/srizzling/clipmark:<version>` and `:latest` on tags.

## Licence

MIT.
