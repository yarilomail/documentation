// Fails when a built page's search metadata breaks the rules in CLAUDE.md,
// "Search metadata": a title with the site suffix, at most 60 characters and
// unique; a description of 120 to 160 characters, unique; no keywords tag.
// Usage: check-meta.mjs <site dir>

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SUFFIX = ' | YariloMail'
const dir = process.argv[2]
const unescape = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const bad = []
const titles = new Map()
const descriptions = new Map()
for (const f of readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.html') && f !== '404.html')) {
  const html = readFileSync(join(dir, f), 'utf8')
  const title = unescape(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '')
  const desc = unescape(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '')
  if (!title.endsWith(SUFFIX)) bad.push(`${f}: title without "${SUFFIX}": ${title}`)
  else if (title.length > 60) bad.push(`${f}: title of ${title.length} characters: ${title}`)
  if (desc.length < 120 || desc.length > 160) bad.push(`${f}: description of ${desc.length} characters`)
  if (/<meta name="keywords"/i.test(html)) bad.push(`${f}: a keywords tag`)
  for (const [seen, value, what] of [[titles, title, 'title'], [descriptions, desc, 'description']]) {
    if (!value) continue
    if (seen.has(value)) bad.push(`${f}: the same ${what} as ${seen.get(value)}`)
    else seen.set(value, f)
  }
}
for (const b of bad) console.log(b)
if (bad.length) {
  console.error(`${bad.length} problem(s) with page titles and descriptions; see CLAUDE.md, Search metadata`)
  process.exit(1)
}
console.log(`${titles.size} pages: every title and description is its own and within its length`)
