// Fails when a built page has an <img> without a non-empty alt.
// Usage: check-img-alt.mjs <site dir>

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const bad = []
for (const f of readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.html'))) {
  for (const [tag] of readFileSync(join(dir, f), 'utf8').matchAll(/<img\s[^>]*>/g)) {
    if (!/\salt="[^"]+"/.test(tag)) bad.push(`${f}: ${tag.match(/\ssrc="([^"]*)"/)?.[1] ?? tag}`)
  }
}
for (const b of bad) console.log(b)
if (bad.length) {
  console.error(`${bad.length} image(s) without alt text`)
  process.exit(1)
}
console.log('every image has alt text')
