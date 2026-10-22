// Fails when data/settings.yaml disagrees with yarilo's settings export.
// Usage: check-settings.mjs <settings.json>

import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const data = parse(readFileSync('data/settings.yaml', 'utf8'))
const code = new Map(JSON.parse(readFileSync(process.argv[2], 'utf8')).map(s => [s.key, s]))
const section = key => key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : ''

// A default left out, null, "" and an empty list all mean "nothing set".
const ZERO = { string: '', integer: 0, boolean: false, list: [], map: {} }
const norm = (v, type) => v === undefined || v === null ? ZERO[type] : v

const errors = []
for (const [key, s] of Object.entries(data)) {
  const c = code.get(key)
  if (!c) {
    errors.push(`${key}: not in the code`)
    continue
  }
  if (c.kind !== s.type) errors.push(`${key}: type ${s.type}, the code has ${c.kind} (${c.type})`)
  // default_text stands for a value computed at start; only the key and type are compared.
  if (s.default_text === undefined) {
    const want = JSON.stringify(norm(s.default, s.type))
    const got = JSON.stringify(norm(c.default, s.type))
    if (want !== got) errors.push(`${key}: default ${want}, the code has ${got}`)
  }
  for (const alias of s.aliases ?? []) {
    const full = section(key) ? `${section(key)}.${alias}` : alias
    if (!code.has(full)) errors.push(`${key}: alias ${alias} is not a key of the code (${full})`)
  }
}
for (const e of errors) console.log(e)
if (errors.length) {
  console.error(`${errors.length} difference(s) between data/settings.yaml and the code`)
  process.exit(1)
}
console.log(`${Object.keys(data).length} settings match the code`)
