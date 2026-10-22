// Fails when an internal link's #fragment names no id on its target page.
// Usage: check-anchors.mjs <dist> <base>, e.g. .vitepress/dist /main/

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [dist, base] = process.argv.slice(2)
const pages = readdirSync(dist, { recursive: true }).filter(f => f.endsWith('.html'))
const ids = new Map()
const idsOf = file => {
  if (!ids.has(file)) {
    const html = existsSync(file) ? readFileSync(file, 'utf8') : null
    ids.set(file, html && new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])))
  }
  return ids.get(file)
}

const missing = new Set()
for (const page of pages) {
  const html = readFileSync(join(dist, page), 'utf8')
  for (const [, path, hash] of html.matchAll(/href="([^"#]*)#([^"]+)"/g)) {
    if (path && !path.startsWith(base)) continue
    const target = path
      ? join(dist, path.slice(base.length) + (path.endsWith('/') ? 'index.html' : ''))
      : join(dist, page)
    const found = idsOf(target)
    if (!found?.has(decodeURIComponent(hash))) missing.add(`${page} -> ${path || '(same page)'}#${hash}`)
  }
}
for (const m of [...missing].sort()) console.log(m)
if (missing.size) {
  console.error(`${missing.size} link(s) point at a missing anchor`)
  process.exit(1)
}
