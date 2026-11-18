# yarilo-docs - documentation conventions

Extends the workspace-level `/CLAUDE.md`. All global rules apply.

This repo (`yarilomail/documentation`) is the **source of truth for all public
Yarilo documentation**, published at https://doc.yarilomail.org from the
`gh-pages` branch by the cluster that also serves yarilomail.org (see README,
Serving; VitePress 1.6, `srcDir: docs`, images in `docs/public/`). Never edit
`docs/` in the yarilo repo - it no longer exists there.

All documentation is written in **English only**.

---

## Writing style - follow doc.dovecot.org

The style model is the Dovecot documentation (`dovecot/documentation` on
GitHub). Apply these conventions to every page:

- **One page = one task or one topic.** Prefer splitting a long page over
  growing a mega-page.
- **Topic-named headings**, noun or gerund phrases: "Creating the first
  user", "Listening ports", "Waiting for the certificate". A heading names one
  topic and nothing else:
  - no dash joining two names ("yarilo-locks - design", "`--all` - cross-replica
    view"): pick the topic ("Write locking", "Cross-replica view");
  - no issue or PR numbers ("(#753)", "PR #581");
  - no section numbers ("3.1", "7.1a", "Part A");
  - no config key glued to the topic ("Ring mTLS - `director_service.…`"): the
    key belongs in its settings card or in the text. A heading that *is* one
    name, such as a Sieve extension (`` `vnd.yarilo.pipe` ``), is fine.
- **No issue numbers in the text either.** Readers cannot open them. Say what
  the behaviour is, not which issue changed it; development history, phases
  and checklists do not belong in these pages.
  This covers links (`[yarilo#2162](…/issues/2162)`, `…/pull/…`), table
  cells, and comments inside the SVG diagrams. One exception:
  `operations/security.md` names the issue of a security fix that has no
  advisory of its own, because that issue is the fix's only public record.
- **Single H1** per page (the title), H2 for sections, H3 for variants/steps
  within a section.
- **Short paragraphs, 1–3 sentences, one idea each.** Imperative mood for
  instructions: "To persist data, mount the volume to…".
- **Every code block gets a one-line imperative lead-in** ending with a colon
  ("Seed a user:"). When a command's effect is not obvious, explain it
  *after* the block as a bullet list ("This sequence: …").
- **Callouts**: VitePress containers `::: tip`, `::: note`, `::: warning` -
  never blockquotes (`>`). A titled variant is fine: `::: tip Production`.
- **Bold sparingly** - only for things that carry meaning (component names in
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

## Search metadata

What a search engine, a link preview and an AI crawler read from a page. Two
fields are written by hand on every page; everything else is generated from
them and from the page, and is never written by hand.

### Written on every page: `title` and `description`

Every page starts with both in its frontmatter, in double quotes:

```yaml
---
title: "Deploying a mail server on Kubernetes"
description: "Deploy a mail server on Kubernetes with the yarilo Helm chart: components, write locking, standalone and co-located layouts, pod sizing, high availability."
---
```

**`title`** is the line a search result shows as its link.

- It names the subject the way a person would search for it: "Deploying a
  mail server on Kubernetes", "IMAP quota (RFC 9208): storage and messages",
  not "Deployment" or "Quota". A word or two is never enough.
- 25 to 47 characters. The site appends ` | YariloMail` (13 characters), and
  a result page shows about 60.
- Unique across the site.
- No brand in it: the suffix carries the brand once. Two exceptions: the docs
  home ("Yarilo mail server documentation"), and a page about a tool whose
  name is what people search for ("yarctl: the mail server administration
  CLI").
- No version numbers, no issue numbers, no "configuration" as the only
  noun: say what is configured.
- It is not the heading. The `# H1` on the page stays a topic-named heading
  for the reader (Writing style); the sidebar and the anchors come from the
  headings, so a title can change without breaking a link.

**`description`** is the text under that link.

- 120 to 160 characters: shorter wastes the line, longer is cut.
- It says what the page covers, subject first, then the things a reader will
  find, as a sentence or a sentence and a list: "LMTP delivery from an MTA
  such as Postfix into yarilo mailboxes: the proxy and the backend, settings,
  message size, recipient rate limits, ORCPT, Delivered-To."
- Unique across the site, and not a copy of the title.
- No call to action ("Learn how", "Read more"), no "This page describes":
  these are reference pages.
- No double quote inside it; the value is one YAML string.

### Choosing the words

A term goes into a title or a description only when the page is about it.

- Start from what people type, not from our names for things: "mail server on
  Kubernetes", "Helm chart", "self-hosted", "Docker Compose", "IMAP
  director", "JMAP server", "ManageSieve port", "mdbox", "IMAP quota",
  "OAuth2 for IMAP". Search suggestions for the page's subject show the
  wording; ask for them with the generic subject, never with the project's
  name.
- Use the category word the page belongs to once: mail server, IMAP, JMAP,
  Sieve, Kubernetes.
- One term once. Repeating a word to rank for it reads as spam to a search
  engine and to a person.
- The first paragraph of the page matters too: `llms.txt` lists every page by
  its H1 and its first prose paragraph, so that paragraph says in one or two
  sentences what the page is.

### Generated: never write these by hand

`.vitepress/config.mts` builds them for every page. Do not add a `head:` block
to a page's frontmatter for any of them.

| What | Built from |
|:---|:---|
| `<title>` | `title` + ` \| YariloMail` (`titleTemplate`) |
| `<meta name="description">` | `description` |
| `og:title`, `twitter:title` | `title`, without the suffix |
| `og:description`, `twitter:description` | `description` |
| `og:url` | the page's own URL in its version |
| `og:type`, `og:site_name`, `og:image`, `twitter:card`, `twitter:image` | the same for every page; one shared card image |
| `<link rel="canonical">` | the same page under `/latest/`, in every version |
| `<meta name="robots" content="noindex">` | on `/main/` only |
| JSON-LD | `TechArticle` (headline = `title`, `description`, last change) and a breadcrumb; the home page carries `WebSite` and `Organization` instead of the breadcrumb |
| `sitemap.xml` | the pages of `/latest/` only |
| `llms.txt`, `llms-full.txt` | every page: H1 and first paragraph, and the full text |
| `rel="nofollow"` on external links | every link outside our own sites (VitePress build gotchas) |

There is no `keywords` meta tag and none is to be added: search engines do
not use it.

The fallback for a page without a `description`, its first paragraph cut at
155 characters, exists so that a build never ships an empty tag. It is not a
way to skip writing one.

### Other things search reads

- One `# H1` per page, and headings in order (Writing style).
- Every image has alt text that says what it shows; `scripts/check-img-alt.mjs`
  fails without it.
- A page's URL is permanent (Structure): a renamed page loses what it earned.
- Internal links name their target in the link text ("See
  [Deployment](/installation/deployment)"), not "here".

### What is checked

`scripts/check-meta.mjs`, run on every PR against the built site, fails when a
page has no title or description of its own, a title longer than 60 characters
with the suffix or without the suffix, a description outside 120 to 160
characters, a title or a description that another page has too, or a
`keywords` tag.

### When a change reaches search

Search engines index `/latest/` only. A change to a title or a description is
visible under `/main/` at once and reaches `/latest/`, and so search, when the
next release's docs tag is pushed (Versions).

## VitePress build gotchas

- Placeholder tokens like `<tag>`, `<service>` in **prose** must be escaped
  (`\<tag>`) or backticked - the Vue compiler treats them as HTML elements.
  Inside code spans and fences they are safe, **except** when a line *starts*
  with `<token>`: CommonMark parses that as an HTML block even inside a
  multi-line code span. Rewrap the line instead of escaping.
- External links get `rel="nofollow"` at build time, except to seconddns.com,
  yarilomail.org and github.com/yarilomail (`.vitepress/links.mjs`). Write a
  plain Markdown link; `scripts/check-nofollow.mjs`, run on every PR, fails
  on an external link without it.
- Links to yarilo source code use full GitHub URLs
  (`https://github.com/yarilomail/yarilo/tree/main/...`) - repo-relative
  paths are dead links here and fail the build.
- `npm run docs:build` must pass before every commit; it fails on dead links
  and Vue parse errors.

## How changes reach the site

Every change goes through a pull request - direct pushes to `main` are
blocked by branch protection:

1. Branch from fresh `main` (`feat/...`, `docs/...`, `chore/...`).
2. Edit pages; run `npm run docs:build` locally - it must pass.
3. Push the branch and open a PR (title and description in English).
4. The user reviews and merges. Never merge yourself.
5. Merge to `main` triggers the `Deploy docs` GitHub Actions workflow, which
   rebuilds the `gh-pages` branch; the pods on the cluster pull it
   within a minute (see README, Serving) - no manual deploy step exists.

## Versions

Every version of the docs lives under its own prefix:

- `/main/` - built from `main`: the next, unreleased version. Kept out of
  search results (`noindex`), with its canonical on the same page in
  `/latest/`.
- `/2.4.5/` - built from the docs tag `v2.4.5`, pushed when Yarilo 2.4.5 is
  released. Prerelease tags (`v2.4.5-dev.4`) publish nothing.
- `/latest/` - the newest release, rebuilt when its tag is pushed. Until the
  first release tag exists it follows `main`. Releases link their canonical
  here, and only `latest` is in `sitemap.xml`.

The `gh-pages` branch is the published site: one directory per version, plus
the root files `scripts/site-root.mjs` writes - `versions.json` (read by the
version switcher), the redirect from `/` to `/latest/`, and the redirects
from the pre-versioning URLs (`/AUTH_OAUTH2` → `/latest/auth/oauth2.html`).
The deploy workflow rebuilds only its own version, then publishes the whole
branch. Never edit `gh-pages` by hand.

`npm run docs:dev` serves the site at `http://localhost:5173/main/`;
`DOCS_VERSION=<version>` builds under another prefix.

## Structure

- `docs/<section>/*.md` - the pages, one directory per sidebar group
  (`installation`, `architecture`, `protocols`, `auth`, `storage`,
  `features`, `operations`); file names are lowercase with underscores, and
  a section's overview is its `index.md`. Sidebar groups and nav live in
  `.vitepress/config.mts` (update it when adding/renaming a page). Each
  page's `##` headings become its collapsible sub-entries automatically;
  `scripts/check-anchors.mjs` (run on every PR) fails on any `#anchor` link,
  sidebar or in-page, that names no heading.
- Renaming or moving a published page breaks its URL in every release
  already out. Avoid it; when unavoidable, keep the old path working.
- `site-root/` - files served from the site root, outside any version
  (`robots.txt`, the IndexNow key, `legacy-pages.json`).
- `data/settings.yaml` - every documented `yarilo.yaml` setting, keyed by its
  full path (`general.ssl.ssl_min_protocol`). See "Settings" below.
- `docs/index.md` - landing page; keep it `layout: doc` style (sidebar
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
by spaces. Name full keys when another page documents other keys of the same
section. Each entry renders as a heading one level below the heading the
marker sits under, with the key's name and an anchor of its full path
(`#general.ssl.ssl_min_protocol`), a card, and the description. `docs/reference/settings.md` lists every entry through
`<!-- @settings-index -->`.

Fields of an entry:

| Field | Meaning |
|:---|:---|
| `type` | `string`, `boolean`, `integer`, `number`, `list` or `map` (required) |
| `unit` | e.g. `seconds`, shown beside the type |
| `default` | the binary's default; leave out or `""` for none |
| `default_text` | prose instead of `default`, when it is computed at start |
| `values` | the accepted values of an enumeration |
| `aliases` | other names the loader accepts: a bare name sits beside the key, a dotted one is a full key elsewhere |
| `helm` | the chart value that sets it |
| `see_also` | full keys of related settings |
| `added`, `changed` | version, and for `changed` a `text` |
| `advanced` | `true` marks it as not normally changed |
| `source` | `chart` for a Helm value that is not a `yarilo.yaml` key (`networkPolicy.enabled`); left out otherwise |
| `description` | Markdown (required) |

The build fails when an entry is placed on no page or on two, when a marker
names an unknown key or section, or when an entry has an unknown field or a
`see_also` to an unknown key.

Every PR also compares the data with the code: `scripts/check-settings.mjs`
reads `settings.json` from the `settings-export` branch, which yarilo's
develop CI rewrites after every gate (`hack/settingsexport`), and fails on a
key or alias the code lacks, another type, or another default. An entry with
`source: chart` is compared with `helm/values.yaml` of yarilo's develop
instead. An entry with `default_text` compares key and type only. Never edit `settings-export` by
hand. A release's export is also attached to its GitHub Release.

