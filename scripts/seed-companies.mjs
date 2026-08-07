#!/usr/bin/env node
/*
 * Seed sample Company records into Cobalt.
 *
 *   npm run seed-companies -- --dry     # print what it would create, touch nothing
 *   npm run seed-companies              # create them
 *
 * Ten obviously-fictional treatment-center style companies, spread across the
 * three Company categories so the Clients page and the category filter both have
 * something to show:
 *   4 Client · 3 Lead · 3 Former Client
 *
 * Two-step per record, because that is what the platform requires:
 *   1. record CREATE   -> the Entity, typed Company, with its category attached
 *   2. form_entry UPDATE -> the Company form row (single-entry forms create their
 *      row lazily on UPDATE, so CREATE is not the right action here)
 *
 * BLOCKED until the Company record type has a base form
 * ------------------------------------------------------
 * Right now step 1 fails with "Cannot set the record's type to a record
 * category" — the platform does not treat Company as a base record type until a
 * base form and display field are set on it in Relate admin. A genuine base type
 * (Organization) fails differently ("Cannot create an Entity w/o any form
 * entries"), which is how we know the type, not the tool, is the problem. Wire the
 * base form, then run this.
 *
 * Records, unlike schema objects, CAN be removed: `record DELETE` soft-deletes.
 * So a bad seed here is recoverable — see --undo.
 *
 * Credentials: never in this repo. Reads the global b6pt_ bearer from
 * $B6PT_TOKEN, or discovers it from ~/.claude.json.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import process from 'node:process'

const GATEWAY_HOST = 'gateway.bluestep.net'
const ORG = 'U142140'

const RECORD_TYPE_COMPANY = '1000003___141050'
const FORM_COMPANY = '1000001___2197271'
const CATEGORY = {
  Lead: '1000003___141070',
  Client: '1000003___141090',
  'Former Client': '1000003___141091',
}
const FIELD = {
  name: '1000101___3673689',
  website: '1000101___3673690',
  street: '1000101___3673691',
  city: '1000101___3673692',
  state: '1000101___3673693',
  postalCode: '1000101___3673694',
}

// Deliberately fictional — example.com domains, invented names — so nothing in
// here can be mistaken for a real customer record.
const COMPANIES = [
  { category: 'Client', name: 'Cedar Ridge Behavioral Health', website: 'https://example.com/cedar-ridge', street: '1420 Canyon Road', city: 'Provo', state: 'UT', postalCode: '84604' },
  { category: 'Client', name: 'Northlake Adolescent Center', website: 'https://example.com/northlake', street: '88 Lakeshore Drive', city: 'Boise', state: 'ID', postalCode: '83702' },
  { category: 'Client', name: 'Harbor Point Recovery', website: 'https://example.com/harbor-point', street: '2001 Harbor Boulevard', city: 'San Diego', state: 'CA', postalCode: '92101' },
  { category: 'Client', name: 'Sagebrush Youth Services', website: 'https://example.com/sagebrush', street: '515 High Desert Way', city: 'Reno', state: 'NV', postalCode: '89501' },

  { category: 'Lead', name: 'Willow Creek Academy', website: 'https://example.com/willow-creek', street: '77 Willow Creek Lane', city: 'Bozeman', state: 'MT', postalCode: '59715' },
  { category: 'Lead', name: 'Summit House Residential', website: 'https://example.com/summit-house', street: '3300 Summit Avenue', city: 'Denver', state: 'CO', postalCode: '80209' },
  { category: 'Lead', name: 'Bright Harbor Family Clinic', website: 'https://example.com/bright-harbor', street: '19 Bayfront Street', city: 'Portland', state: 'OR', postalCode: '97209' },

  { category: 'Former Client', name: 'Stonebridge Treatment Group', website: 'https://example.com/stonebridge', street: '640 Mill Street', city: 'Austin', state: 'TX', postalCode: '78704' },
  { category: 'Former Client', name: 'Aspen Grove Wellness', website: 'https://example.com/aspen-grove', street: '12 Aspen Grove Court', city: 'Fort Collins', state: 'CO', postalCode: '80521' },
  { category: 'Former Client', name: 'Meridian Care Partners', website: 'https://example.com/meridian-care', street: '450 Meridian Parkway', city: 'Nashville', state: 'TN', postalCode: '37203' },
]

// ---------------------------------------------------------------- auth + client
function findToken() {
  if (process.env.B6PT_TOKEN) return 'Bearer ' + process.env.B6PT_TOKEN.replace(/^Bearer\s+/, '')
  const cfgPath = path.join(os.homedir(), '.claude.json')
  if (!fs.existsSync(cfgPath)) throw new Error('Set $B6PT_TOKEN (no ~/.claude.json to read a token from)')
  const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const buckets = [j.mcpServers || {}, ...Object.values(j.projects || {}).map(p => (p && p.mcpServers) || {})]
  for (const b of buckets) {
    for (const n of Object.keys(b)) {
      const h = (b[n].headers || {}).Authorization || ''
      if (/^Bearer\s+b6pt_/.test(h)) return h
    }
  }
  throw new Error('No global b6pt_ token found. Set $B6PT_TOKEN.')
}

function client() {
  const token = findToken()
  let sessionId = null
  let nextId = 10
  const cookies = {}

  function rpc(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const cookieHeader = Object.keys(cookies).length
        ? { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } : {}
      const req = https.request({
        hostname: GATEWAY_HOST, path: '/mcp', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(data),
          Authorization: token,
          ...cookieHeader,
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
      }, res => {
        let buf = ''
        res.on('data', c => (buf += c))
        res.on('end', () => {
          for (const c of res.headers['set-cookie'] || []) {
            const m = /^([^=]+)=([^;]*)/.exec(c); if (m) cookies[m[1]] = m[2]
          }
          if (res.headers['mcp-session-id']) sessionId = res.headers['mcp-session-id']
          let payload = buf
          if (buf.includes('data:')) {
            payload = buf.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
          }
          let json = null
          try { json = payload ? JSON.parse(payload) : null } catch { /* non-JSON */ }
          resolve({ json, status: res.statusCode, raw: buf })
        })
      })
      req.on('error', reject)
      req.write(data); req.end()
    })
  }

  async function init() {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'seed-companies', version: '1' } } })
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  async function call(tool, args = {}) {
    const r = await rpc({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name: 'invoke_org_tool', arguments: { org: ORG, tool, arguments: args } } })
    if (r.json?.error) return { ok: false, error: r.json.error.message, data: null }
    const content = r.json?.result?.content
    const isError = !!r.json?.result?.isError
    const text = Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : ''
    let data = null
    try { data = JSON.parse(text) } catch { /* not JSON */ }
    const soft = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : null
    return { ok: !isError && !soft, error: soft || (isError ? text : null), data: data?.data ?? data, text }
  }

  return { init, call }
}

const clean = e => String(e || '').replace(/\s+/g, ' ').trim().slice(0, 200)

// ---------------------------------------------------------------- main
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const undo = args.includes('--undo')
const LEDGER = path.resolve(process.cwd(), 'seeded-companies.json')

if (dry) {
  console.log(`[seed] would create ${COMPANIES.length} Company records:\n`)
  for (const c of COMPANIES) console.log(`  ${c.category.padEnd(14)} ${c.name}  (${c.city}, ${c.state})`)
  console.log('\n[seed] nothing was created — drop --dry to run for real.')
  process.exit(0)
}

const gw = client()
await gw.init()

if (undo) {
  if (!fs.existsSync(LEDGER)) {
    console.error(`[seed] no ledger at ${LEDGER} — nothing to undo.`)
    process.exit(1)
  }
  const ids = JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
  for (const { id, name } of ids) {
    const r = await gw.call('record', { action: 'DELETE', recordId: id })
    console.log(`${r.ok ? 'deleted' : 'FAILED '} ${id}  ${name}${r.ok ? '' : '  ' + clean(r.error)}`)
  }
  process.exit(0)
}

const created = []
let failed = 0

for (const [i, c] of COMPANIES.entries()) {
  const rec = await gw.call('record', {
    action: 'CREATE',
    recordTypeId: RECORD_TYPE_COMPANY,
    categoryIds: [CATEGORY[c.category]],
  })
  if (!rec.ok) {
    failed++
    console.error(`[${i + 1}/10] ${c.name} — record CREATE failed: ${clean(rec.error)}`)
    if (/record category/i.test(String(rec.error))) {
      console.error(`\n[seed] STOPPING. The Company record type has no base form, so the platform`)
      console.error(`[seed] refuses to type a record as Company. Set a base form + display field on`)
      console.error(`[seed] the Company record type in Relate admin, then re-run.`)
      break
    }
    continue
  }
  const recordId = rec.data?.topId
  if (!recordId) { failed++; console.error(`[${i + 1}/10] ${c.name} — no record id returned`); continue }

  const entry = await gw.call('form_entry', {
    action: 'UPDATE',
    recordId,
    formId: FORM_COMPANY,
    fields: [
      { fieldId: FIELD.name, value: c.name },
      { fieldId: FIELD.website, value: c.website },
      { fieldId: FIELD.street, value: c.street },
      { fieldId: FIELD.city, value: c.city },
      { fieldId: FIELD.state, value: c.state },
      { fieldId: FIELD.postalCode, value: c.postalCode },
    ],
  })

  // A partial write still creates the row, so report per-field failures loudly
  // rather than leaving a half-populated record looking successful.
  const nFailed = entry.data?.failed ?? (entry.ok ? 0 : 'all')
  created.push({ id: recordId, name: c.name, category: c.category })
  console.log(`[${i + 1}/10] ${c.name.padEnd(32)} ${recordId}` +
    (nFailed ? `  ⚠ ${nFailed} field(s) failed: ${clean(entry.error || entry.text)}` : ''))
}

if (created.length) {
  fs.writeFileSync(LEDGER, JSON.stringify(created, null, 2) + '\n')
  console.log(`\n[seed] created ${created.length} record(s); ids written to ${path.basename(LEDGER)}`)
  console.log(`[seed] undo with: npm run seed-companies -- --undo`)
}
if (failed) console.log(`[seed] ${failed} record(s) failed`)
