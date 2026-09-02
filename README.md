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
  has its own copy and download buttons.
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
| `POST` | `/api/render` | Markdown in, HTML fragment out. Nothing is saved |
| `GET` | `/<slug>` | rendered page at its short link. `?v=<id>` renders an old version |
| `GET` | `/n/<path>` | the same page at its long address |
| `GET` | `/raw/<path>` | the Markdown |
| `GET` | `/healthz` | `{ ok, version, notes, writable, renders }`. `503` when not ok |
| `GET` | `/llms.txt` | the API described in plain text for agents and tools, with this deployment's URL filled in |

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
