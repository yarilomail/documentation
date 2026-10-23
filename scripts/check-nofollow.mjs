// Fails when a built page links outside the followed sites without rel="nofollow".
// Usage: check-nofollow.mjs <site dir>

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isFollowed } from '../.vitepress/links.mjs'

const dir = process.argv[2]
const bad = []
for (const f of readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.html'))) {
  for (const [tag] of readFileSync(join(dir, f), 'utf8').matchAll(/<a\s[^>]*>/g)) {
    const href = tag.match(/\shref="([^"]*)"/)?.[1]
    if (!href || isFollowed(href)) continue
    const rel = tag.match(/\srel="([^"]*)"/)?.[1] ?? ''
    if (!rel.split(/\s+/).includes('nofollow')) bad.push(`${f}: ${href}`)
  }
}
for (const b of bad) console.log(b)
if (bad.length) {
  console.error(`${bad.length} external link(s) without rel="nofollow"`)
  process.exit(1)
}
console.log('every external link outside the followed sites is nofollow')
