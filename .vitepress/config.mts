import { defineConfig, type DefaultTheme, type PageData } from 'vitepress'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sieve from './sieve.tmLanguage.json'
import { expandSettings, hasSettings } from './settings'
import { isFollowed } from './links.mjs'

const SITE = 'https://doc.yarilomail.org'

// Version prefix of this build: main, a release such as 2.4.5, or latest.
const VERSION = process.env.DOCS_VERSION || 'main'
const BASE = `/${VERSION}/`

// auth/oauth2.md -> https://doc.yarilomail.org/main/auth/oauth2.html
function pageUrl(base: string, relativePath: string): string {
  return `${SITE}${base}${relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html')}`
}

// Same as VitePress's heading slugify, so sidebar anchors match heading ids.
function slugify(str: string): string {
  return str.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '').replace(/^(\d)/, '_$1').toLowerCase()
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A page's H2 sections as collapsed sidebar children; ids repeat as -1, -2 like the build's.
function withSections(item: DefaultTheme.SidebarItem): DefaultTheme.SidebarItem {
  const link = item.link!
  const text = expandSettings(readFileSync(join('docs', link.endsWith('/') ? `${link}index.md` : `${link}.md`), 'utf8'), BASE)
  const seen = new Map<string, number>()
  const sections: DefaultTheme.SidebarItem[] = []
  for (const m of text.replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1/gm, '').matchAll(/^(#{1,6}) (.+?)(?: \{#([^}]+)\})?$/gm)) {
    const title = m[2].replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__/g, '')
    let id = m[3] ?? slugify(title)
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    if (n) id = `${id}-${n}`
    if (m[1] === '##') sections.push({ text: escapeHtml(title), link: `${link}#${id}` })
  }
  return sections.length < 2 ? item : { ...item, collapsed: true, items: sections }
}

function sidebar(groups: DefaultTheme.SidebarItem[]): DefaultTheme.SidebarItem[] {
  return groups.map(g => ({ ...g, collapsed: false, items: g.items!.map(withSections) }))
}

/* First H1 and first prose paragraph of a page, for the llms.txt index. */
function pageMeta(text: string): { title: string; desc: string } {
  const title = text.match(/^# (.+)$/m)?.[1] ?? ''
  let desc = ''
  for (const block of text.split(/\n{2,}/)) {
    const t = block.trim()
    if (!t || t.startsWith('#') || t.startsWith('```') || t.startsWith('|') ||
        t.startsWith(':::') || t.startsWith('---') || t.startsWith('<')) continue
    desc = t.replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`|\*\*|__/g, '')
    break
  }
  return { title, desc }
}

function buildLlmsTxt(srcDir: string, outDir: string) {
  const pages = (readdirSync(srcDir, { recursive: true }) as string[])
    .filter(f => f.endsWith('.md'))
    .map(f => f.split('\\').join('/'))
    .sort()
  const index: string[] = [
    '# Yarilo',
    '',
    '> Yarilo is a cloud-native mail server written in Go: IMAP, POP3, LMTP,',
    '> Submission, JMAP and Sieve, designed for Kubernetes.',
    '',
    `Full documentation as a single file: ${SITE}${BASE}llms-full.txt`,
    '',
    '## Documentation',
    '',
  ]
  const full: string[] = []
  for (const f of pages) {
    const text = expandSettings(readFileSync(join(srcDir, f), 'utf8'), BASE, true)
    const { title, desc } = pageMeta(text)
    const url = pageUrl(BASE, f)
    index.push(`- [${title || f || 'Home'}](${url})${desc ? ': ' + desc : ''}`)
    full.push(`<!-- source: ${url} -->\n\n${text.trim()}`)
  }
  writeFileSync(join(outDir, 'llms.txt'), index.join('\n') + '\n')
  writeFileSync(join(outDir, 'llms-full.txt'), full.join('\n\n---\n\n') + '\n')
}

/* Trim to a search-snippet length on a word boundary. */
function snippet(text: string, max = 155): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…'
}

/* Schema.org JSON-LD for a docs page: a TechArticle and its breadcrumb, or
   on the docs home the WebSite node instead of the breadcrumb. The publisher is the Organization that
   yarilomail.org defines, referenced by its @id, so both sites resolve to one
   project. */
const ORG_ID = 'https://yarilomail.org/#organization'

function jsonLd(pageData: PageData, url: string, title: string, description?: string) {
  const isHome = pageData.relativePath === 'index.md'
  const graph: object[] = [
    {
      '@type': 'TechArticle',
      '@id': `${url}#article`,
      mainEntityOfPage: url,
      headline: title,
      description,
      dateModified: pageData.lastUpdated
        ? new Date(pageData.lastUpdated).toISOString()
        : undefined,
      inLanguage: 'en',
      isPartOf: { '@id': `${SITE}/#website` },
      publisher: { '@id': ORG_ID },
    },
  ]
  if (!isHome) {
    // A one-item trail is not shown in results, so the docs home has none.
    const crumbs = [
      { name: 'Yarilo documentation', item: `${SITE}${BASE}` },
      { name: title, item: url },
    ]
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, ...c })),
    })
  } else {
    graph.push(
      {
        '@type': 'WebSite',
        '@id': `${SITE}/#website`,
        url: `${SITE}/`,
        name: 'Yarilo documentation',
        inLanguage: 'en',
        publisher: { '@id': ORG_ID },
      },
      {
        '@type': 'Organization',
        '@id': ORG_ID,
        name: 'YariloMail',
        alternateName: 'Yarilo',
        url: 'https://yarilomail.org/',
      },
    )
  }
  return { '@context': 'https://schema.org', '@graph': graph }
}

export default defineConfig({
  buildEnd(siteConfig) {
    buildLlmsTxt(siteConfig.srcDir, siteConfig.outDir)
  },
  /* Per-page description (frontmatter, else first paragraph) and Open Graph
     tags; releases are canonical to latest, main is not indexed. */
  transformPageData(pageData, { siteConfig }) {
    const file = join(siteConfig.srcDir, pageData.filePath)
    // Settings are H3s; list them under their sections in the outline.
    if (hasSettings(readFileSync(file, 'utf8'))) pageData.frontmatter.outline ??= [2, 4]
    if (!pageData.frontmatter.description) {
      const { desc } = pageMeta(readFileSync(file, 'utf8'))
      if (desc) pageData.description = snippet(desc)
    }
    const url = pageUrl(BASE, pageData.relativePath)
    const title = pageData.frontmatter.title || pageData.title || 'Yarilo'
    const description = pageData.frontmatter.description || pageData.description
    pageData.frontmatter.head ??= []
    if (VERSION === 'main') {
      pageData.frontmatter.head.push(['meta', { name: 'robots', content: 'noindex' }])
    } else {
      pageData.frontmatter.head.push(['link', { rel: 'canonical', href: pageUrl('/latest/', pageData.relativePath) }])
    }
    pageData.frontmatter.head.push(
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { name: 'twitter:title', content: title }],
    )
    if (description) {
      pageData.frontmatter.head.push(
        ['meta', { property: 'og:description', content: description }],
        ['meta', { name: 'twitter:description', content: description }],
      )
    }
    pageData.frontmatter.head.push(
      ['script', { type: 'application/ld+json' }, JSON.stringify(jsonLd(pageData, url, title, description))],
    )
  },
  title: 'Yarilo',
  description: 'Yarilo mail server documentation',
  srcDir: 'docs',
  base: BASE,
  sitemap: { hostname: `${SITE}${BASE}` },
  lastUpdated: true,
  vite: {
    resolve: {
      alias: [{
        find: /^.*\/VPDocFooterLastUpdated\.vue$/,
        replacement: fileURLToPath(new URL('./theme/LastUpdated.vue', import.meta.url)),
      }],
    },
  },
  // Shiki ships no Sieve grammar.
  markdown: {
    languages: [sieve as any],
    // Break points after / . _ so a long identifier does not widen its table.
    config(md) {
      const parse = md.parse.bind(md)
      md.parse = (src, env) => parse(expandSettings(src, BASE), env)
      const code = md.renderer.rules.code_inline!
      md.renderer.rules.code_inline = (...args) => code(...args)
        .replace(/>([^<]*)<\/code>$/, (_, t: string) => `>${t.replace(/([/._])(?=.)/g, '$1<wbr>')}</code>`)
      // Runs after VitePress's own link rule, which sets rel="noreferrer".
      const link = md.renderer.rules.link_open!
      md.renderer.rules.link_open = (tokens, idx, ...rest) => {
        const html = link(tokens, idx, ...rest)
        return isFollowed(tokens[idx].attrGet('href') ?? '') ? html : html.replace(/ rel="([^"]*)"/, ' rel="$1 nofollow"')
      }
    },
  },
  head: [
    ['link', { rel: 'icon', href: `${BASE}icon.svg` }],
    ['meta', { property: 'og:type', content: 'article' }],
    ['meta', { property: 'og:site_name', content: 'Yarilo documentation' }],
    // Social preview, shared with yarilomail.org. Absolute URL is required:
    // crawlers do not resolve relative paths.
    ['meta', { property: 'og:image', content: `${SITE}${BASE}og.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE}${BASE}og.png` }],
  ],
  themeConfig: {
    logo: '/icon.svg',
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/yarilomail' }
    ],
    nav: [
      { text: 'Install', link: '/installation/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'Features', link: '/architecture/parity' },
      { text: 'Admin', link: '/operations/yarilo_admin' },
      { text: 'Security', link: '/operations/security' },
      { text: 'yarilomail.org', link: 'https://yarilomail.org' }
    ],
    sidebar: sidebar([
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Installation', link: '/installation/' },
          { text: 'DNS for a mail domain', link: '/installation/dns' },
          { text: 'Migration', link: '/installation/migration' },
          { text: 'General Configuration', link: '/installation/general' },
          { text: 'Deployment', link: '/installation/deployment' },
          { text: 'Docker Compose', link: '/installation/docker_compose' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture/' },
          { text: 'Feature coverage', link: '/architecture/parity' },
          { text: 'Services', link: '/architecture/services' },
          { text: 'Director', link: '/architecture/director' },
          { text: 'Director API', link: '/architecture/director_api' },
          { text: 'Backend API', link: '/architecture/backend_api' }
        ]
      },
      {
        text: 'Protocols',
        items: [
          { text: 'IMAP', link: '/protocols/imap' },
          { text: 'POP3', link: '/protocols/pop3' },
          { text: 'LMTP', link: '/protocols/lmtp' },
          { text: 'Submission', link: '/protocols/submission' },
          { text: 'JMAP', link: '/protocols/jmap' }
        ]
      },
      {
        text: 'Authentication',
        items: [
          { text: 'Overview', link: '/auth/' },
          { text: 'OAuth2', link: '/auth/oauth2' },
          { text: 'SCRAM', link: '/auth/scram' },
          { text: 'Auth Policy', link: '/auth/policy' },
          { text: 'wforce Integration', link: '/auth/wforce' },
          { text: 'Master Users', link: '/auth/master_users' },
          { text: 'Auth Penalty', link: '/auth/penalty' }
        ]
      },
      {
        text: 'Storage',
        items: [
          { text: 'Mailbox Storage', link: '/storage/' },
          { text: 'mdbox Alt Storage', link: '/storage/mdbox_alt' },
          { text: 'Namespaces', link: '/storage/namespace' },
          { text: "Other Users' Mailboxes", link: "/storage/owner_shared_ns" },
          { text: 'Quota', link: '/storage/quota' },
          { text: 'Dict', link: '/storage/dict' }
        ]
      },
      {
        text: 'Features',
        items: [
          { text: 'Sieve', link: '/features/sieve' },
          { text: 'Full-Text Search', link: '/features/fts' },
          { text: 'Virtual Mailboxes', link: '/features/virtual' }
        ]
      },
      {
        text: 'Operations',
        items: [
          { text: 'yarilo-admin', link: '/operations/yarilo_admin' },
          { text: 'Testing', link: '/operations/testing' },
          { text: 'Smoke Tests', link: '/operations/smoke' },
          { text: 'Security policy', link: '/operations/security' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'All settings', link: '/reference/settings' },
          { text: 'RFC support', link: '/reference/rfcs' }
        ]
      }
    ])
  }
})
