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
- **Cross-link inline**: "See [Deployment](./DEPLOYMENT) for the full
  rationale." Page links are extensionless (`./STORAGE`, cleanUrls is on);
  images are root-absolute (`/yarilo_backend.svg`).
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
   builds the site and publishes it to GitHub Pages at
   https://doc.yarilomail.org — no manual deploy step exists.

## Structure

- `docs/*.md` — the pages; sidebar groups and nav live in
  `.vitepress/config.mts` (update it when adding/renaming a page).
- `docs/index.md` — landing page; keep it `layout: doc` style (sidebar
  visible), not a hero page.
- Deploy is automatic: merge to `main` → GitHub Actions → Pages at
  doc.yarilomail.org.
