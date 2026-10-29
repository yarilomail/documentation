// Fails when a built page has no single canonical to the same page under /latest/.
// Usage: check-canonical.mjs <site dir>

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const bad = []
for (const f of readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.html') && f !== '404.html')) {
  const hrefs = [...readFileSync(join(dir, f), 'utf8').matchAll(/<link\s[^>]*rel="canonical"[^>]*>/g)]
    .map(([tag]) => tag.match(/\shref="([^"]*)"/)?.[1])
  const want = `https://doc.yarilomail.org/latest/${f.replace(/(^|\/)index\.html$/, '$1')}`
  if (hrefs.length !== 1 || hrefs[0] !== want) bad.push(`${f}: ${hrefs.join(', ') || 'no canonical'}`)
}
for (const b of bad) console.log(b)
if (bad.length) {
  console.error(`${bad.length} page(s) without a canonical to latest`)
  process.exit(1)
}
console.log('every page is canonical to latest')
