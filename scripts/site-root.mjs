// Maintains the top level of the published site, which holds one directory
// per docs version (main, latest, 2.4.5, ...).
//
//   node scripts/site-root.mjs register <site> <version>
//     Records <version> in <site>/versions.json and prints "true" when the
//     `latest` directory must be rebuilt: <version> is the newest release, or
//     no release exists yet and <version> is main.
//
//   node scripts/site-root.mjs root <site>
//     Writes the files that live outside any version: site-root/*, the root
//     redirect to /latest/, the redirects from the pre-versioning page URLs,
//     and copies of the sitemap, llms.txt and 404 page of `latest`.

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
  // The script keeps the #fragment; the meta refresh covers clients without JS.
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
