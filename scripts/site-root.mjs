// Root of the published site, outside the version directories.
// Usage: register <site> <version> | root <site>

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SITE = 'https://doc.yarilomail.org'
const SRC_ROOT = new URL('../site-root/', import.meta.url).pathname

const [cmd, site, version] = process.argv.slice(2)

function semverCmp(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

function readVersions() {
  const file = join(site, 'versions.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { latest: null, releases: [] }
}

function redirectPage(target) {
  // The script keeps the #fragment; the meta refresh works without JS.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Redirecting…</title>
<link rel="canonical" href="${SITE}${target}">
<meta http-equiv="refresh" content="0; url=${target}">
<script>location.replace(${JSON.stringify(target)} + location.hash)</script>
</head>
<body><a href="${target}">${SITE}${target}</a></body>
</html>
`
}

// Records the version; prints true when latest must be rebuilt from it.
if (cmd === 'register') {
  const v = readVersions()
  if (version !== 'main' && !v.releases.includes(version)) {
    v.releases.push(version)
    v.releases.sort(semverCmp).reverse()
  }
  v.latest = v.releases[0] ?? null
  writeFileSync(join(site, 'versions.json'), JSON.stringify(v, null, 2) + '\n')
  console.log(String(version === v.latest || (v.latest === null && version === 'main')))
} else if (cmd === 'root') {
  for (const f of readdirSync(SRC_ROOT)) {
    if (f !== 'legacy-pages.json') copyFileSync(join(SRC_ROOT, f), join(site, f))
  }
  for (const f of ['404.html', 'sitemap.xml', 'llms.txt', 'llms-full.txt']) {
    copyFileSync(join(site, 'latest', f), join(site, f))
  }
  writeFileSync(join(site, 'index.html'), redirectPage('/latest/'))
  const legacy = JSON.parse(readFileSync(join(SRC_ROOT, 'legacy-pages.json'), 'utf8'))
  for (const [old, path] of Object.entries(legacy)) {
    const target = `/latest${path}${path.endsWith('/') ? '' : '.html'}`
    writeFileSync(join(site, `${old}.html`), redirectPage(target))
  }
} else {
  console.error('usage: site-root.mjs register <site> <version> | root <site>')
  process.exit(2)
}
