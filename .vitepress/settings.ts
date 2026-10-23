// Settings pages are built from data/settings.yaml: a page places settings with
// `<!-- @settings <section or key>... -->`, and `<!-- @settings-index -->` lists them all.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

interface Setting {
  type: 'string' | 'boolean' | 'integer' | 'number' | 'list' | 'map'
  unit?: string
  default?: unknown
  default_text?: string
  values?: string[]
  aliases?: string[]
  helm?: string
  see_also?: string[]
  added?: string
  changed?: { version: string; text: string }[]
  advanced?: boolean
  // chart: a Helm value, compared with values.yaml instead of the config export.
  source?: 'chart'
  description: string
}

const FIELDS = new Set(['type', 'unit', 'default', 'default_text', 'values', 'aliases', 'helm',
  'see_also', 'added', 'changed', 'advanced', 'source', 'description'])
const TYPES = new Set(['string', 'boolean', 'integer', 'number', 'list', 'map'])
const PLACE = /^<!-- @settings ([^>]+?) -->$/gm
const INDEX = /^<!-- @settings-index -->$/m

const settings: Record<string, Setting> = parse(readFileSync('data/settings.yaml', 'utf8'))
const sectionOf = (key: string) => key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : ''
const nameOf = (key: string) => key.slice(key.lastIndexOf('.') + 1)

for (const [key, s] of Object.entries(settings)) {
  const unknown = Object.keys(s).filter(f => !FIELDS.has(f))
  if (unknown.length) throw new Error(`data/settings.yaml: ${key}: unknown field ${unknown.join(', ')}`)
  if (s.source !== undefined && s.source !== 'chart') throw new Error(`data/settings.yaml: ${key}: source must be chart or left out`)
  if (s.source === 'chart' && (s.helm || s.aliases)) throw new Error(`data/settings.yaml: ${key}: a chart value takes no helm or aliases`)
  if (!TYPES.has(s.type) || !s.description) {
    throw new Error(`data/settings.yaml: ${key}: needs a description and a type of ${[...TYPES].join(', ')}`)
  }
  for (const k of s.see_also ?? []) {
    if (!settings[k]) throw new Error(`data/settings.yaml: ${key}: see_also names unknown ${k}`)
  }
}

// A marker token is a full key, or a section that takes every key in it.
function resolve(token: string, where: string): string[] {
  if (settings[token]) return [token]
  const keys = Object.keys(settings).filter(k => sectionOf(k) === token)
  if (!keys.length) throw new Error(`${where}: @settings names no key or section "${token}"`)
  return keys
}

// Page link of every placed key; a key placed twice or nowhere fails the build.
const pageOf = new Map<string, string>()
for (const f of (readdirSync('docs', { recursive: true }) as string[]).filter(f => f.endsWith('.md'))) {
  const page = '/' + f.split('\\').join('/').replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')
  for (const m of readFileSync(join('docs', f), 'utf8').matchAll(PLACE)) {
    for (const key of m[1].trim().split(/\s+/).flatMap(t => resolve(t, f))) {
      if (pageOf.has(key)) throw new Error(`${f}: ${key} is already placed on ${pageOf.get(key)}`)
      pageOf.set(key, page)
    }
  }
}
const unplaced = Object.keys(settings).filter(k => !pageOf.has(k))
if (unplaced.length) throw new Error(`data/settings.yaml: not placed on any page: ${unplaced.join(', ')}`)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const code = (s: string) => `<code>${esc(s)}</code>`
// Inline `code` inside card text, which is raw HTML and not markdown.
const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')

function defaultHtml(s: Setting): string {
  if (s.default_text) return inline(s.default_text)
  if (s.default === undefined || s.default === '') return 'none'
  if (Array.isArray(s.default)) return code(s.default.length ? s.default.join(', ') : '[]')
  return code(String(s.default))
}

function card(key: string, s: Setting, base: string, plain: boolean): string {
  const link = (k: string) => {
    const page = pageOf.get(k)!
    return `<a href="${base}${page.slice(1)}${page.endsWith('/') ? '' : '.html'}#${k}">${code(nameOf(k))}</a>`
  }
  const rows: [string, string][] = [
    ...(s.source === 'chart' ? [['Set in', 'Helm values'] as [string, string]] : []),
    ['Default', defaultHtml(s)],
    ['Type', s.type + (s.unit ? `, ${esc(s.unit)}` : '')],
  ]
  if (s.values) rows.push(['Values', s.values.map(code).join(' ')])
  if (s.aliases) rows.push(['Also accepted as', s.aliases.map(code).join(' ')])
  if (s.helm) rows.push(['Helm', code(s.helm)])
  if (s.see_also) rows.push(['See also', s.see_also.map(link).join(' ')])
  if (s.added) rows.push(['Added', esc(s.added)])
  for (const c of s.changed ?? []) rows.push([`Changed ${esc(c.version)}`, inline(c.text)])
  if (plain) {
    const text = (h: string) => h.replace(/<code>|<\/code>/g, '`').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    return rows.map(([t, d]) => `- ${t}: ${text(d)}`).join('\n') + (s.advanced ? '\n- Advanced' : '')
  }
  const body = rows.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')
  const advanced = s.advanced ? '<p class="setting-advanced">Advanced: this should not normally be changed.</p>' : ''
  return `<div class="setting-card"><dl>${body}</dl>${advanced}</div>`
}

function block(key: string, base: string, plain: boolean, level: number): string {
  const s = settings[key]
  const id = plain ? '' : ` {#${key}}`
  return `${'#'.repeat(level)} \`${nameOf(key)}\`${id}\n\n${card(key, s, base, plain)}\n\n${s.description.trim()}\n`
}

function index(): string {
  const bySection = new Map<string, string[]>()
  for (const key of Object.keys(settings)) {
    const section = (settings[key].source === 'chart' ? 'chart:' : '') + sectionOf(key)
    bySection.set(section, [...(bySection.get(section) ?? []), key])
  }
  const title = (s: string) => s.startsWith('chart:') ? `Helm values: \`${s.slice(6)}\`` : s ? `\`${s}\`` : 'Top level'
  const order = [...bySection].sort(([a], [b]) => Number(a.startsWith('chart:')) - Number(b.startsWith('chart:')))
  return order.map(([section, keys]) =>
    `## ${title(section)}\n\n` + keys.map(k => {
      const s = settings[k]
      const dflt = s.default_text ? '' : s.default === undefined || s.default === '' ? '' :
        `, default \`${Array.isArray(s.default) ? (s.default.join(', ') || '[]') : s.default}\``
      return `- [\`${nameOf(k)}\`](${pageOf.get(k)}#${k}): ${s.type}${dflt}`
    }).join('\n') + '\n').join('\n')
}

export const hasSettings = (src: string) => new RegExp(PLACE.source, 'm').test(src)

// plain: Markdown cards and no heading ids, for llms-full.txt.
export function expandSettings(src: string, base: string, plain = false): string {
  // A setting's heading sits one level below the heading the marker is under.
  let level = 2, fence = false
  const out = src.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) return line
    const h = line.match(/^(#{1,6}) /)
    if (h) level = h[1].length
    const m = line.match(/^<!-- @settings ([^>]+?) -->$/)
    if (!m) return line
    return m[1].trim().split(/\s+/).flatMap(t => resolve(t, 'page'))
      .map(k => block(k, base, plain, Math.min(level + 1, 6))).join('\n')
  }).join('\n')
  return out.replace(INDEX, index)
}
