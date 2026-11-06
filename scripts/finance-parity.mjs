#!/usr/bin/env node
/*
 * Parity check: the Finance report's compute library against the old BEH endpoint.
 *
 *   node scripts/finance-parity.mjs [options]
 *
 * app/src/lib/finance.ts is a port of U141648's /b/financeData, and the point of a
 * port is that leadership's numbers do not move. This runs the new library on the
 * same QuickBooks CSVs the old endpoint reads and diffs the two month by month.
 *
 * Where each side comes from, best first:
 *   CSVs      the old endpoint's own downloads on beh.bluestep.net (bearer), else
 *             --rev / --exp (default: the copies in ~/Downloads).
 *   old JSON  live GET /b/financeData?dataset=all (bearer, then bearer + session
 *             cookies), else --old-json <file> (a saved response), else --old-src
 *             <app.ts>: the old endpoint's own source run in node against the same
 *             CSVs with a small BsJs shim. The shim reads the CSV with Python's csv
 *             module, not this repo's parser, so the CSV reader is checked too.
 *   aliases   --seed <file> ([{rec, prog, qb}], cached), else U141648 /gql
 *             (the program → QuickBooks name MEFR rows the old endpoint joined on).
 *
 * Options:  --rev <csv>  --exp <csv>  --old-json <file>  --old-src <app.ts>
 *           --seed <json>  --today YYYY-MM-DD (default: the old JSON's generatedAt)
 *
 * Needs B6PT_TOKEN for anything fetched. esbuild comes through npx (pinned, not a
 * dependency of this repo). Exits 1 on any mismatch beyond 0.01.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOST = 'https://beh.bluestep.net'
const REV_URL = `${HOST}/download/123321___742274/BEH%20Revenue%20all%20dates%20--%20Brandon.csv`
const EXP_URL = `${HOST}/download/123321___742294/BEH%20total%20expenses%20ytd%20-%20Brandon.csv`
const OLD_URL = `${HOST}/b/financeData?dataset=all`
const QB_FORM = '1000001___2174410'
const TOLERANCE = 0.01

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const token = process.env.B6PT_TOKEN || ''
const tmp = mkdtempSync(join(tmpdir(), 'finance-parity-'))
const log = (...a) => console.log(...a)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
  }
  return out
}

// ── auth ─────────────────────────────────────────────────────────────────────

let session = null
/* Bearer + the session cookies and CSRF token /csrf-token hands out. Fetched once. */
async function getSession() {
  if (session) return session
  const res = await fetch(`${HOST}/csrf-token`, { headers: { Authorization: `Bearer ${token}` } })
  const cookie = (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  const body = (await res.text()).trim()
  let csrf = body
  try { csrf = JSON.parse(body).token ?? body } catch { /* plain-text token */ }
  session = { cookie, csrf }
  return session
}

async function authedGet(url, withSession) {
  const headers = { Authorization: `Bearer ${token}` }
  if (withSession) {
    const s = await getSession()
    headers.Cookie = s.cookie
    headers['b6p-csrf-token'] = s.csrf
  }
  const res = await fetch(url, { headers, redirect: 'manual' })
  return { status: res.status, type: res.headers.get('content-type') || '', bytes: new Uint8Array(await res.arrayBuffer()) }
}

/* Plain bearer first, then bearer + session; null (with the reason logged) if neither works. */
async function fetchAuthed(url, label, looksRight) {
  if (!token) { log(`  ${label}: B6PT_TOKEN not set, not fetched`); return null }
  for (const withSession of [false, true]) {
    const r = await authedGet(url, withSession)
    const how = withSession ? 'bearer + session cookies' : 'bearer'
    if (r.status === 200 && looksRight(r)) { log(`  ${label}: fetched live (${how})`); return r.bytes }
    const head = new TextDecoder().decode(r.bytes.slice(0, 120)).replace(/\s+/g, ' ')
    const why = r.status === 303 || /login/i.test(head) ? 'redirected to the login page' : `HTTP ${r.status} ${head}`
    log(`  ${label}: ${how} → ${why}`)
  }
  return null
}

// ── inputs ───────────────────────────────────────────────────────────────────

async function loadCsv(url, label, fallback) {
  const live = await fetchAuthed(url, label, r => !/html/i.test(r.type))
  if (live) {
    const path = join(tmp, label + '.csv')
    writeFileSync(path, live)
    return { path, source: 'live download' }
  }
  if (!existsSync(fallback)) throw new Error(`${label}: not fetchable and no local file at ${fallback}`)
  log(`  ${label}: using local ${fallback}`)
  return { path: fallback, source: fallback }
}

async function loadCompanies() {
  let rows
  if (args.seed) {
    rows = JSON.parse(readFileSync(args.seed, 'utf8'))
    log(`  aliases: ${rows.length} program/QuickBooks rows from ${args.seed}`)
  } else {
    rows = await fetchQbRows()
    log(`  aliases: ${rows.length} program/QuickBooks rows from U141648 /gql`)
  }
  // Grouped by program, as the endpoint's allPrograms loop saw them.
  const byProg = new Map()
  for (const r of rows) {
    if (!byProg.has(r.prog)) byProg.set(r.prog, { id: r.rec, name: r.prog, quickbooksNames: [] })
    if (r.qb) byProg.get(r.prog).quickbooksNames.push(r.qb)
  }
  return [...byProg.values()]
}

async function fetchQbRows() {
  const s = await getSession()
  const out = []
  for (let start = 0; ; ) {
    const query = `{ formEntries(formId:"${QB_FORM}", start:${start}, count:100) { totalSize rows {
      record { id displayName } data { ... on RelateFieldDataInterface { valueAsString } } } } }`
    const res = await fetch(`${HOST}/gql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Cookie: s.cookie, 'b6p-csrf-token': s.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    const json = await res.json()
    if (json.errors) throw new Error('gql: ' + JSON.stringify(json.errors).slice(0, 300))
    const page = json.data.formEntries.rows
    for (const row of page) {
      const qb = (row.data || []).map(d => d?.valueAsString).find(v => v && v.trim()) || ''
      out.push({ rec: row.record.id, prog: row.record.displayName, qb })
    }
    start += page.length
    if (page.length === 0 || start >= json.data.formEntries.totalSize) break
  }
  return out
}

function esbuild(argv, input) {
  return execFileSync('npx', ['-y', 'esbuild@0.24.0', ...argv], { cwd: repo, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'] })
}

/* Python's csv module, deliberately not this repo's parseCsv, for the reference side. */
function pythonCsvRows(path) {
  const py = 'import csv,json,sys\nwith open(sys.argv[1], newline="", encoding="utf-8-sig") as f: json.dump(list(csv.reader(f)), sys.stdout)'
  return JSON.parse(execFileSync('python3', ['-I', '-c', py, path], { maxBuffer: 1 << 28 }).toString())
}

/*
 * The old endpoint's own source, run in node. Only the BsJs surface it touches is
 * shimmed: B.net.fetch/B.csv (rows by URL), LocalDate, the request and response, and
 * allPrograms (from the same alias rows the new library gets).
 */
function runOldSource(srcPath, csvByUrl, companies, today) {
  const js = esbuild(['--loader=ts', '--format=cjs'], readFileSync(srcPath)).toString()
  const rowsByPath = {}
  for (const [url, path] of Object.entries(csvByUrl)) rowsByPath[url] = pythonCsvRows(path)
  const localDate = (y, m) => ({
    getYear: () => y,
    getMonthValue: () => m,
    minusMonths: n => { const i = y * 12 + (m - 1) - n; return localDate(Math.floor(i / 12), (i % 12) + 1) },
    toString: () => today,
  })
  const [ty, tm] = today.split('-').map(Number)
  let body = ''
  const opt = v => ({ opt: () => ({ orElse: d => (v === undefined || v === null ? d : v) }) })
  const allPrograms = companies.map(c => ({
    forms: {
      programInfo: { fields: { name: opt(c.name) } },
      quickbooks: c.quickbooksNames.map(q => ({ fields: { name: opt(q) } })),
    },
  }))
  const B = {
    net: {
      fetch: url => url,
      request: { method: () => 'GET', parameter: k => (k === 'dataset' ? 'all' : null) },
      response: { status() {}, contentType() {}, out: s => { body += s } },
    },
    csv: url => {
      const rows = rowsByPath[url]
      if (!rows) throw new Error('shim: no CSV for ' + url)
      return { forEach: cb => rows.forEach((cells, i) => cb({ each: f => cells.forEach(f) }, i)) }
    },
    time: { LocalDate: { now: () => localDate(ty, tm) } },
  }
  new Function('B', 'allPrograms', js)(B, allPrograms)
  return JSON.parse(body)
}

// ── compare ──────────────────────────────────────────────────────────────────

function compare(oldD, newD) {
  const rows = []
  const check = (what, a, b) => {
    const na = typeof a === 'number', nb = typeof b === 'number'
    const same = na && nb ? Math.abs(a - b) <= TOLERANCE : (a ?? null) === (b ?? null)
    if (!same) rows.push([what, a, b])
  }
  const union = (...lists) => [...new Set(lists.flat().filter(Boolean))].sort()
  const months = union(oldD.mrr?.months, newD.mrr?.months, oldD.expenses?.months, newD.expenses?.months,
    oldD.newMrr?.months, newD.newMrr?.months)

  check('ok', oldD.ok, newD.ok)
  check('mrr.defaultMonth', oldD.mrr?.defaultMonth, newD.mrr?.defaultMonth)
  for (const m of months) {
    const o = k => k(oldD), n = k => k(newD)
    const pair = (label, get) => check(`${m} ${label}`, o(get), n(get))
    pair('mrr', d => d.mrr?.byMonth[m]?.mrr)
    pair('activeCustomers', d => d.mrr?.byMonth[m]?.activeCustomers)
    pair('streams.recurring', d => d.streams?.byMonth[m]?.recurring)
    pair('streams.ps', d => d.streams?.byMonth[m]?.professionalServices)
    pair('streams.setup', d => d.streams?.byMonth[m]?.setup)
    pair('newMrr.total', d => d.newMrr?.byMonth[m]?.total)
    pair('newMrr.newLines', d => d.newMrr?.byMonth[m]?.newLines)
    pair('ndr', d => d.ndr?.byMonth[m]?.ndr)
    pair('expenses.monthTotal', d => d.expenses?.monthTotal[m])
    pair('expenses.platformMonth', d => d.expenses?.platformMonth[m])
    pair('profit.net', d => d.profitability?.byMonth[m]?.net)
    pair('profit.margin', d => d.profitability?.byMonth[m]?.margin)
  }
  for (const k of ['totalRows', 'recurringRows', 'psRows', 'setupRows', 'skippedNoDate', 'skippedNoAmount',
    'skippedOther', 'monthCount', 'earliest', 'latest']) {
    check(`meta.${k}`, oldD.meta?.[k], newD.meta?.[k])
  }
  for (const k of ['ok', 'totalRows', 'countedRows', 'skippedNoDate', 'skippedNoAmount', 'categories', 'vendors',
    'monthCount', 'earliest', 'latest', 'grandTotal', 'platformTotal']) {
    check(`meta.expenses.${k}`, oldD.meta?.expenses?.[k], newD.meta?.expenses?.[k])
  }
  return { rows, months }
}

// ── main ─────────────────────────────────────────────────────────────────────

log('Inputs')
const dl = join(homedir(), 'Downloads')
const rev = await loadCsv(REV_URL, 'revenue', args.rev || join(dl, 'BEH Revenue all dates -- Brandon.csv'))
const exp = await loadCsv(EXP_URL, 'expenses', args.exp || join(dl, 'BEH total expenses ytd - Brandon.csv'))
const companies = await loadCompanies()

let oldD = null
let oldMode = ''
const liveOld = await fetchAuthed(OLD_URL, 'old endpoint', r => /json/i.test(r.type))
if (liveOld) {
  oldD = JSON.parse(new TextDecoder().decode(liveOld))
  oldMode = 'live /b/financeData'
} else if (args['old-json']) {
  oldD = JSON.parse(readFileSync(args['old-json'], 'utf8'))
  oldMode = `saved response ${args['old-json']}`
}
const today = args.today || oldD?.generatedAt || new Date().toISOString().slice(0, 10)
if (!oldD) {
  if (!args['old-src']) {
    log('\nThe old endpoint needs a browser session (the bearer is refused). Pass --old-json <saved response>')
    log('or --old-src <old financeData app.ts> to run its source locally against the same CSVs.')
    process.exit(2)
  }
  oldD = runOldSource(args['old-src'], { [REV_URL.slice(HOST.length)]: rev.path, [EXP_URL.slice(HOST.length)]: exp.path }, companies, today)
  oldMode = `old endpoint source run locally (${args['old-src']})`
}
log(`  old side: ${oldMode}`)
log(`  today: ${today}`)

esbuild(['app/src/lib/finance.ts', 'app/src/lib/xlsx.ts', '--bundle', '--format=esm', '--platform=node', `--outdir=${tmp}`, '--log-level=warning'])
const { buildFinanceData } = await import(pathToFileURL(join(tmp, 'finance.js')).href)
const { readSheet } = await import(pathToFileURL(join(tmp, 'xlsx.js')).href)
const sheet = async p => ({ rows: await readSheet(new Uint8Array(readFileSync(p)), p), filename: p.split('/').pop() })
const [y, m, d] = today.split('-').map(Number)
const newD = buildFinanceData({ revenue: await sheet(rev.path), expenses: await sheet(exp.path), companies, today: new Date(y, m - 1, d) })

const { rows, months } = compare(oldD, newD)
log(`\nCompared ${months.length} months, 12 values each, plus defaultMonth and meta counts.`)
log(`old: defaultMonth ${oldD.mrr?.defaultMonth}, ${oldD.meta?.monthCount} revenue months, aliasMapSize ${oldD.meta?.aliasMapSize}${oldD.error ? ', error: ' + oldD.error : ''}`)
log(`new: defaultMonth ${newD.mrr?.defaultMonth}, ${newD.meta?.monthCount} revenue months, aliasMapSize ${newD.meta?.aliasMapSize}${newD.error ? ', error: ' + newD.error : ''}`)
if (rows.length) {
  log('\nMismatches (what | old | new):')
  for (const [what, a, b] of rows.slice(0, 80)) log(`  ${what.padEnd(36)} ${String(a).padStart(14)} ${String(b).padStart(14)}`)
  if (rows.length > 80) log(`  … and ${rows.length - 80} more`)
}
// Not a failure: the old map also held every U141648 program name with no QuickBooks
// rows (a name that maps to itself, which canon() does anyway), and only alias rows
// are fed in here. Any effect it had would show up in the per-month numbers above.
if (oldD.meta?.aliasMapSize !== newD.meta?.aliasMapSize) {
  log(`\nNote: aliasMapSize ${oldD.meta?.aliasMapSize} (old) vs ${newD.meta?.aliasMapSize} (new). Expected: the old map also`)
  log('counted program names with no QuickBooks rows; only alias rows are fed to the new library.')
}
log(`\n${rows.length ? 'FAIL' : 'PASS'}: ${rows.length} mismatch(es) beyond ${TOLERANCE}`)
process.exit(rows.length ? 1 : 0)
