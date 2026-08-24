import { defineConfig } from 'vitepress'
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
    desc = t.replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
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

export default defineConfig({
  buildEnd(siteConfig) {
    buildLlmsTxt(siteConfig.srcDir, siteConfig.outDir)
  },
  title: 'Yarilo',
  description: 'Yarilo mail server documentation',
  srcDir: 'docs',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: '/icon.svg' }]],
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
      { text: 'Parity', link: '/PARITY' },
      { text: 'Admin', link: '/YARILO-ADMIN' }
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Installation', link: '/INSTALL' },
          { text: 'General Configuration', link: '/GENERAL' },
          { text: 'Deployment', link: '/DEPLOYMENT' },
          { text: 'Docker Compose', link: '/DOCKER-COMPOSE' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/ARCHITECTURE' },
          { text: 'Dovecot parity', link: '/PARITY' },
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
          { text: 'Full-Text Search', link: '/FTS' }
        ]
      },
      {
        text: 'Operations',
        items: [
          { text: 'Monitoring', link: '/MONITOR' },
          { text: 'yarilo-admin', link: '/YARILO-ADMIN' },
          { text: 'Testing', link: '/TESTING' },
          { text: 'Smoke Tests', link: '/SMOKE' }
        ]
      }
    ]
  }
})
