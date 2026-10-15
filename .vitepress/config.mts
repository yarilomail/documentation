import { defineConfig, type PageData } from 'vitepress'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SITE = 'https://doc.yarilomail.org'

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
  const pages = readdirSync(srcDir).filter(f => f.endsWith('.md')).sort()
  const index: string[] = [
    '# Yarilo',
    '',
    '> Yarilo is a cloud-native mail server written in Go: IMAP, POP3, LMTP,',
    '> Submission, JMAP and Sieve, designed for Kubernetes.',
    '',
    `Full documentation as a single file: ${SITE}/llms-full.txt`,
    '',
    '## Documentation',
    '',
  ]
  const full: string[] = []
  for (const f of pages) {
    const text = readFileSync(join(srcDir, f), 'utf8')
    const { title, desc } = pageMeta(text)
    const slug = f === 'index.md' ? '' : f.replace(/\.md$/, '')
    index.push(`- [${title || slug || 'Home'}](${SITE}/${slug})${desc ? ': ' + desc : ''}`)
    full.push(`<!-- source: ${SITE}/${slug} -->\n\n${text.trim()}`)
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
      { name: 'Yarilo documentation', item: `${SITE}/` },
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
  /* Per-page meta description: frontmatter `description` wins; otherwise
     the page's first prose paragraph, so no page falls back to the
     site-wide one-liner. Also emits the canonical link (GitHub Pages
     serves /PAGE.html as a duplicate of /PAGE) and per-page Open Graph
     tags built from the same title and description. */
  transformPageData(pageData, { siteConfig }) {
    if (!pageData.frontmatter.description) {
      const file = join(siteConfig.srcDir, pageData.filePath)
      const { desc } = pageMeta(readFileSync(file, 'utf8'))
      if (desc) pageData.description = snippet(desc)
    }
    const url = `${SITE}/${pageData.relativePath}`
      .replace(/index\.md$/, '')
      .replace(/\.md$/, '')
    const title = pageData.frontmatter.title || pageData.title || 'Yarilo'
    const description = pageData.frontmatter.description || pageData.description
    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push(
      ['link', { rel: 'canonical', href: url }],
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
  cleanUrls: true,
  sitemap: { hostname: 'https://doc.yarilomail.org' },
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', href: '/icon.svg' }],
    ['meta', { property: 'og:type', content: 'article' }],
    ['meta', { property: 'og:site_name', content: 'Yarilo documentation' }],
    // Social preview, shared with yarilomail.org. Absolute URL is required:
    // crawlers do not resolve relative paths.
    ['meta', { property: 'og:image', content: `${SITE}/og.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE}/og.png` }],
  ],
  themeConfig: {
    logo: '/icon.svg',
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/yarilomail/documentation/edit/main/docs/:path',
      text: 'Edit this page'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/yarilomail' }
    ],
    nav: [
      { text: 'Install', link: '/INSTALL' },
      { text: 'Architecture', link: '/ARCHITECTURE' },
      { text: 'Features', link: '/PARITY' },
      { text: 'Admin', link: '/YARILO-ADMIN' },
      { text: 'Security', link: '/SECURITY' },
      { text: 'yarilomail.org', link: 'https://yarilomail.org' }
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Installation', link: '/INSTALL' },
          { text: 'DNS for a mail domain', link: '/DNS' },
          { text: 'Migration', link: '/MIGRATION' },
          { text: 'General Configuration', link: '/GENERAL' },
          { text: 'Deployment', link: '/DEPLOYMENT' },
          { text: 'Docker Compose', link: '/DOCKER-COMPOSE' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/ARCHITECTURE' },
          { text: 'Feature coverage', link: '/PARITY' },
          { text: 'Services', link: '/SERVICES' },
          { text: 'Director', link: '/DIRECTOR' },
          { text: 'Director API', link: '/DIRECTOR-API' },
          { text: 'Backend API', link: '/BACKEND-API' }
        ]
      },
      {
        text: 'Protocols',
        items: [
          { text: 'IMAP', link: '/IMAP' },
          { text: 'POP3', link: '/POP3' },
          { text: 'LMTP', link: '/LMTP' },
          { text: 'Submission', link: '/SUBMISSION' },
          { text: 'JMAP', link: '/JMAP' }
        ]
      },
      {
        text: 'Authentication',
        items: [
          { text: 'Overview', link: '/AUTH' },
          { text: 'OAuth2', link: '/AUTH_OAUTH2' },
          { text: 'SCRAM', link: '/AUTH_SCRAM' },
          { text: 'Auth Policy', link: '/AUTH_POLICY' },
          { text: 'Master Users', link: '/MASTER_USERS' },
          { text: 'Auth Penalty', link: '/AUTH_PENALTY' }
        ]
      },
      {
        text: 'Storage',
        items: [
          { text: 'Mailbox Storage', link: '/STORAGE' },
          { text: 'mdbox Alt Storage', link: '/MDBOX_ALT' },
          { text: 'Namespaces', link: '/NAMESPACE' },
          { text: 'Shared Namespaces', link: '/OWNER_SHARED_NS' },
          { text: 'Quota', link: '/QUOTA' },
          { text: 'Dict', link: '/DICT' }
        ]
      },
      {
        text: 'Features',
        items: [
          { text: 'Sieve', link: '/SIEVE' },
          { text: 'Full-Text Search', link: '/FTS' },
          { text: 'Virtual Mailboxes', link: '/VIRTUAL' }
        ]
      },
      {
        text: 'Operations',
        items: [
          { text: 'yarilo-admin', link: '/YARILO-ADMIN' },
          { text: 'Testing', link: '/TESTING' },
          { text: 'Smoke Tests', link: '/SMOKE' },
          { text: 'Security policy', link: '/SECURITY' }
        ]
      }
    ]
  }
})
