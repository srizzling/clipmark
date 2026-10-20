# Working in this repo

clipmark renders a folder of Markdown as a small site whose pages copy as rich
text (Confluence, Docs, Word, mail). Node 22, ESM, no framework. `README.md`
covers what it does; this file is about how to change and ship it.

Describe the tool generically in the README, the site and commit messages: it
renders Markdown and copies it as rich text. Do not describe any particular
person's setup or workflow.

## Developing

The environment is devenv via direnv (`direnv allow` on a clean checkout).

```sh
dev            # server on http://localhost:8102 with NOTES_DIR=.notes
npm test       # node --test, across test/*.test.js
```

`src/render.js` is the renderer (markdown-it + GFM extras), `src/store.js` the
notes/versions/slugs/comments store, `src/comments.js` the comment anchoring and digest, `src/server.js` the HTTP API and pages, `src/diff.js` the block-level diff, `src/search.js` the fuzzy matcher and snippets, `src/html.js`
the templates, `public/app.js` the clipboard and Mermaid code in the browser.

Every async helper called from a route must be `return await`ed, not returned.
A `BadPath` thrown from a returned-but-unawaited promise escaped the route's
try/catch and crashed the whole process on `GET /n/.versions/x.md` in v0.1.x.
`test/server.test.js` requests that path so this cannot come back silently.

## Contracts other things depend on

Changing any of these is a breaking change and needs coordination downstream.

- **`/healthz`** returns `{ ok, version, notes, writable, renders }`, 200 only when
  the notes dir is writable and a render smoke test passes. Monitors read `.ok`.
- **Rendered HTML markers**: a `<table>` for GFM tables, `data-panel-type="info"`
  on a `> [!NOTE]` panel, `type="checkbox"` on task items, `<pre class="mermaid">`
  for Mermaid fences, and the page must load `/vendor/mermaid.min.js`. An
  end-to-end monitor publishes a fixture through the API and greps the page for
  exactly these strings, so a renderer change that drops one turns that monitor
  red and can roll a deployment back.
- **Paths** are relative, end in `.md`, and segments may start with `_` or `-`
  but not `.`. A monitor publishes to `_probe/roundtrip.md`; forbidding leading
  underscores broke it once (v0.1.0 to v0.1.1).
- **Publish API**: `PUT /api/notes/<path>` with `Authorization: Bearer <token>`,
  optional `?slug=`; response has `url` (short link), `pathUrl`, `slug`,
  `version`, `changed`. `bin/clipmark` and `public/llms.txt` document it; keep all
  three in step when the API changes.
- **Review comments**: `GET/POST /api/notes/<path>/comments` and
  `PATCH/DELETE .../comments/<id>`, with `?format=md` for the digest, are
  read by agents and need no token. Highlights must stay a CSS Custom Highlight
  overlay: wrapping text in the article DOM would leak into "Copy for pasting".
  Keep `bin/clipmark` and `public/llms.txt` in step. `GET /api/slop` collects
  `kind: "slop"` comments across notes and must keep returning the original
  `quote`, `context` and `feedback` after the note is rewritten; they are what skills learn from.
- **Review queue**: `GET /api/review[?state=]`, `GET/PATCH /api/notes/<path>/review`
  (`action`: `reviewed`, `settle`, `reset`) and `POST /api/review/settle-before`
  need no token, like comments. State is derived (`reviewStateOf` in
  `src/store.js`): a content change after a review means `review` again, so
  nothing may write review state on publish. `/` is the queue and `/all` the
  archive; `all` and `diff` are reserved slugs. The diff compares rendered
  blocks and old cells are `data-nocopy` so comments only anchor to the new
  side. Keep `bin/clipmark` and `public/llms.txt` in step.
- **Search**: `GET /api/search?q=&limit=` needs no token and returns
  `{ query, total, results: [{ path, slug, title, state, changed, openComments,
  score, snippet, highlights, url, pathUrl }] }`; `/search` is the page.
  `search` is a reserved slug. The per-note index in `Store.searchIndex` is keyed
  by modified time and size, so anything that changes a note's text must change
  one of them. Keep `bin/clipmark` and `public/llms.txt` in step.
- **`version` in `/healthz` comes from `package.json`**, so the package version
  must match the release tag.

## Releasing

1. Bump `version` in `package.json` to match the tag. Commit.
2. `git tag vX.Y.Z && git push origin main --tags`.
3. CI runs the tests on every push and, on a `v*` tag, pushes
   `ghcr.io/srizzling/clipmark:<version>` and `:latest`. Wait for it to go green.

Consumers should pin a tag, never `main`: Compose can build straight from
`https://github.com/srizzling/clipmark.git#vX.Y.Z`, or pull the GHCR image.

## Deploying to the homelab

The homelab runs clipmark as the `notes` service and is configured entirely from
its own repo at `~/development/personal/homelab`, which has its own `CLAUDE.md`.
Nothing here deploys anything; a release only becomes live when that repo moves.

1. Release here first (above). The homelab builds from the git tag, so an untagged
   commit cannot be deployed.
2. In the homelab repo, change the tag in the `notes` service's `build.context`
   in `docker-compose.yml`, stage, commit with the fish helpers (they do not
   `git add`; subject 32 chars max), and `git push forgejo main`. A root timer
   builds and restarts the service within a couple of minutes and rolls back if
   more monitor checks fail afterwards than before.
3. Verify meaning, not liveness: `curl <site>/healthz` must report the new
   `version`; the homelab probe's `notes` check must be ok; open a note and copy
   it. If the deploy rolled back, `/var/log/homelab-deploy.log` on the host says
   why, and the probe check's `problems` field names the marker that went missing.

The publish token is `CLIPMARK_TOKEN` in the container, set from the homelab's
host `.env`. Local tooling reads its copy from `~/.config/clipmark/env`
(`CLIPMARK_URL`, `CLIPMARK_TOKEN`), which is also what the global
`notes-publish` Claude skill in `~/.claude/skills/notes-publish/` uses.

## Commits

Fish helpers (`gfeat`, `gfix`, `gdocs`, `gchore`), scope is the area
(`render`, `store`, `api`, `links`, `ci`). Stage first. Say why in the body.
