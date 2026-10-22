# yarilo-docs — documentation conventions

Extends the workspace-level `/CLAUDE.md`. All global rules apply.

This repo (`yarilomail/documentation`) is the **source of truth for all public
Yarilo documentation**, published at https://doc.yarilomail.org via GitHub
Pages (VitePress 1.6, `srcDir: docs`, images in `docs/public/`). Never edit
`docs/` in the yarilo repo — it no longer exists there.

All documentation is written in **English only**.

---

## Writing style — follow doc.dovecot.org

The style model is the Dovecot documentation (`dovecot/documentation` on
GitHub). Apply these conventions to every page:

- **One page = one task or one topic.** Prefer splitting a long page over
  growing a mega-page.
- **Topic-named headings**, noun or gerund phrases: "Creating the first
  user", "Listening ports", "Waiting for the certificate". Never letter/number
  section labels ("Part A", "A.1", "B.4") — headings must produce readable
  anchors.
- **Single H1** per page (the title), H2 for sections, H3 for variants/steps
  within a section.
- **Short paragraphs, 1–3 sentences, one idea each.** Imperative mood for
  instructions: "To persist data, mount the volume to…".
- **Every code block gets a one-line imperative lead-in** ending with a colon
  ("Seed a user:"). When a command's effect is not obvious, explain it
  *after* the block as a bullet list ("This sequence: …").
- **Callouts**: VitePress containers `::: tip`, `::: note`, `::: warning` —
  never blockquotes (`>`). A titled variant is fine: `::: tip Production`.
- **Bold sparingly** — only for things that carry meaning (component names in
  a first mention, hard warnings). Not for decoration or whole phrases.
- **Tables** stay simple, few columns, left-aligned (`|:---|`). Explanations
  live in surrounding prose, not in cells.
- **Cross-link inline**: "See [Deployment](/installation/deployment) for the
  full rationale." Page links are root-absolute and extensionless
  (`/storage/quota`, `/auth/` for a section index); VitePress adds the
  version prefix and `.html`. Images are root-absolute too
  (`/yarilo_backend.svg`).
- **No development phase status in user-facing pages** (no "implemented ✅ /
  roadmap" tables in install/config guides). Status belongs in the relevant
  design page, if anywhere.

## VitePress build gotchas

- Placeholder tokens like `<tag>`, `<service>` in **prose** must be escaped
  (`\<tag>`) or backticked — the Vue compiler treats them as HTML elements.
  Inside code spans and fences they are safe, **except** when a line *starts*
  with `<token>`: CommonMark parses that as an HTML block even inside a
  multi-line code span. Rewrap the line instead of escaping.
- Links to yarilo source code use full GitHub URLs
  (`https://github.com/yarilomail/yarilo/tree/main/...`) — repo-relative
  paths are dead links here and fail the build.
- `npm run docs:build` must pass before every commit; it fails on dead links
  and Vue parse errors.

## How changes reach the site

Every change goes through a pull request — direct pushes to `main` are
blocked by branch protection:

1. Branch from fresh `main` (`feat/...`, `docs/...`, `chore/...`).
2. Edit pages; run `npm run docs:build` locally — it must pass.
3. Push the branch and open a PR (title and description in English).
4. The user reviews and merges. Never merge yourself.
5. Merge to `main` triggers the `Deploy docs` GitHub Actions workflow, which
   rebuilds https://doc.yarilomail.org/main/ — no manual deploy step exists.

## Versions

Every version of the docs lives under its own prefix:

- `/main/` — built from `main`: the next, unreleased version. Kept out of
  search results (`noindex`).
- `/2.4.5/` — built from the docs tag `v2.4.5`, pushed when Yarilo 2.4.5 is
  released. Prerelease tags (`v2.4.5-dev.4`) publish nothing.
- `/latest/` — the newest release, rebuilt when its tag is pushed. Until the
  first release tag exists it follows `main`. Releases link their canonical
  here, and only `latest` is in `sitemap.xml`.

The `gh-pages` branch is the published site: one directory per version, plus
the root files `scripts/site-root.mjs` writes — `versions.json` (read by the
version switcher), the redirect from `/` to `/latest/`, and the redirects
from the pre-versioning URLs (`/AUTH_OAUTH2` → `/latest/auth/oauth2.html`).
The deploy workflow rebuilds only its own version, then publishes the whole
branch. Never edit `gh-pages` by hand.

`npm run docs:dev` serves the site at `http://localhost:5173/main/`;
`DOCS_VERSION=<version>` builds under another prefix.

## Structure

- `docs/<section>/*.md` — the pages, one directory per sidebar group
  (`installation`, `architecture`, `protocols`, `auth`, `storage`,
  `features`, `operations`); file names are lowercase with underscores, and
  a section's overview is its `index.md`. Sidebar groups and nav live in
  `.vitepress/config.mts` (update it when adding/renaming a page). Each
  page's `##` headings become its collapsible sub-entries automatically;
  `scripts/check-anchors.mjs` (run on every PR) fails on any `#anchor` link,
  sidebar or in-page, that names no heading.
- Renaming or moving a published page breaks its URL in every release
  already out. Avoid it; when unavoidable, keep the old path working.
- `site-root/` — files served from the site root, outside any version
  (`CNAME`, `robots.txt`, the IndexNow key, `legacy-pages.json`).
- `data/settings.yaml` — every documented `yarilo.yaml` setting, keyed by its
  full path (`general.ssl.ssl_min_protocol`). See "Settings" below.
- `docs/index.md` — landing page; keep it `layout: doc` style (sidebar
  visible), not a hero page.

## Settings

Settings are not written as tables. Each one is an entry in
`data/settings.yaml`, and a page places entries where they belong:

```md
## `general.ssl`

Shared TLS certificate. Prose about the section stays in the page.

<!-- @settings general.ssl -->
```

A marker takes sections (every key in that section) or full keys, separated
by spaces. Each entry renders as an `###` heading with the key's name and an
anchor of its full path (`#general.ssl.ssl_min_protocol`), a card, and the
description. `docs/reference/settings.md` lists every entry through
`<!-- @settings-index -->`.

Fields of an entry:

| Field | Meaning |
|:---|:---|
| `type` | `string`, `boolean`, `integer`, `list` or `map` (required) |
| `unit` | e.g. `seconds`, shown beside the type |
| `default` | the binary's default; leave out or `""` for none |
| `default_text` | prose instead of `default`, when it is computed at start |
| `values` | the accepted values of an enumeration |
| `aliases` | other names the loader accepts |
| `helm` | the chart value that sets it |
| `see_also` | full keys of related settings |
| `added`, `changed` | version, and for `changed` a `text` |
| `advanced` | `true` marks it as not normally changed |
| `description` | Markdown (required) |

The build fails when an entry is placed on no page or on two, when a marker
names an unknown key or section, or when an entry has an unknown field or a
`see_also` to an unknown key.

Every PR also compares the data with the code: `scripts/check-settings.mjs`
reads the `settings` artifact that yarilo's develop CI exports
(`hack/settingsexport`) and fails on a key or alias the code lacks, another
type, or another default. An entry with `default_text` compares key and type
only. A release's export is attached to its GitHub Release as `settings.json`.

