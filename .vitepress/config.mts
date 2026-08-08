import { defineConfig } from 'vitepress'

export default defineConfig({
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
      { text: 'Admin', link: '/YARILO-ADMIN' }
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Installation', link: '/INSTALL' },
          { text: 'General Configuration', link: '/GENERAL' },
          { text: 'Deployment', link: '/DEPLOYMENT' },
          { text: 'Docker Compose', link: '/DOCKER-COMPOSE' },
          { text: 'Docker Hub Images', link: '/DOCKERHUB' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/ARCHITECTURE' },
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
