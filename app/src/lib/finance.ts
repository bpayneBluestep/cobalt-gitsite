/*
 * The Finance report's numbers: QuickBooks revenue and expense exports in, every view
 * the report draws out.
 *
 * A port of the old BEH `/b/financeData` endpoint (U141648), kept line for line in
 * behaviour on purpose. Those numbers have been read by leadership for months; a port
 * that "tidied" a rounding step or a skip rule would make this month disagree with
 * last month's screenshot, and nobody could then tell a real change from a refactor.
 * `scripts/finance-parity.mjs` holds the two side by side.
 *
 * The output is the old `?dataset=all` JSON shape, so the report UI can follow the old
 * client's compute layer almost verbatim.
 *
 * What changed from the endpoint, and why:
 *  - Input is rows (from `readSheet`), not a BsJs CSV handle, so the same code reads
 *    an .xlsx or a .csv.
 *  - The header row is found by content (the first row with a "Transaction date"
 *    cell), not by skipping five rows: the .xlsx and .csv exports do not agree on how
 *    many metadata rows sit above it.
 *  - The header titles are checked at the positions the parser reads. Columns are
 *    positional, so a QuickBooks layout change would otherwise produce plausible,
 *    wrong totals instead of an error.
 *  - QuickBooks-name aliases come from Cobalt companies, not U141648 programs.
 *  - Dates may be Excel serial numbers as well as MM/DD/YYYY text.
 *
 * Revenue columns:  customer/code=0, date=1, stream ("Account Name")=6, amount=10.
 *   Streams: "Recurring" (MRR), "Professional Services Income", "Setup & Licensing".
 * Expense columns:  date=1, vendor ("Name")=4, category path ("Account Name")=6,
 *   amount=8. Column 0 is a category group header, blank on data rows. Category is
 *   the path before ':'. The platform fee (/PLATFORM Intracompany/) is its own series,
 *   counted once: in monthTotal, out of the category and vendor breakdowns. Payroll is
 *   in monthTotal.
 */

// ── Public types ─────────────────────────────────────────────────────────────

/** A Cobalt company and the QuickBooks customer names that bill as it. */
export interface CompanyAlias {
  id: string
  name: string
  quickbooksNames: string[]
}

export type RevenueStream = 'recurring' | 'ps' | 'setup'

/** Amount per month, keyed 'YYYY-MM'. */
export type MonthAmounts = { [ym: string]: number }

export interface MrrCustomer {
  name: string
  amount: number
}

export interface MrrMonth {
  /** Unrounded, as the endpoint returned it. */
  mrr: number
  /** Companies with recurring > 0 that month. */
  activeCustomers: number
  /** Largest first. */
  customers: MrrCustomer[]
}

export interface MrrView {
  months: string[]
  byMonth: { [ym: string]: MrrMonth }
  /** '' when there are no recurring months. */
  defaultMonth: string
  defaultMonthReason: string
}

export interface StreamsMonth {
  recurring: number
  professionalServices: number
  setup: number
}

export interface StreamsView {
  months: string[]
  byMonth: { [ym: string]: StreamsMonth }
}

export interface NewMrrLine {
  /** The company the QuickBooks code rolls up to (or the code itself). */
  program: string
  /** The raw QuickBooks customer/line, so an upsell under a new code stays visible. */
  code: string
  newMrr: number
}

export interface NewMrrMonth {
  total: number
  newLines: number
  /** Largest first. */
  lines: NewMrrLine[]
}

export interface NewMrrView {
  months: string[]
  byMonth: { [ym: string]: NewMrrMonth }
}

export interface NdrRow {
  program: string
  base: number
  current: number
  delta: number
}

export interface NdrMonth {
  /** Percent (98.5 = 98.5%); null when there is no prior-year month or no cohort. */
  ndr: number | null
  baseYm: string
  startMRR: number
  retainedMRR: number
  cohortSize: number
  /** Biggest loss first. */
  rows: NdrRow[]
}

export interface NdrView {
  months: string[]
  byMonth: { [ym: string]: NdrMonth }
}

export interface ClientCode {
  stream: RevenueStream
  byMonth: MonthAmounts
}

export interface ClientEntry {
  recurring: MonthAmounts
  ps: MonthAmounts
  setup: MonthAmounts
  /** Per raw QuickBooks code, so a company can be broken into its billing lines. */
  codes: { [code: string]: ClientCode }
}

export interface ClientsView {
  months: string[]
  byClient: { [company: string]: ClientEntry }
}

export interface ExpensesView {
  months: string[]
  /** Excludes the platform fee. */
  categoryMonth: { [category: string]: MonthAmounts }
  /** Excludes the platform fee. */
  vendorMonth: { [vendor: string]: MonthAmounts }
  /** Everything, platform fee and payroll included. */
  monthTotal: MonthAmounts
  platformMonth: MonthAmounts
}

export interface ProfitabilityMonth {
  revenue: { recurring: number; ps: number; setup: number; total: number }
  expenses: { total: number; platform: number }
  net: number
  /** Percent of total revenue; null when there was no revenue. */
  margin: number | null
}

export interface ProfitabilityView {
  months: string[]
  byMonth: { [ym: string]: ProfitabilityMonth }
}

export interface ExpenseMeta {
  /** The expense file's name (the endpoint's csvUrl). */
  source: string
  ok: boolean
  error: string
  totalRows: number
  countedRows: number
  skippedNoDate: number
  skippedNoAmount: number
  categories: number
  vendors: number
  monthCount: number
  earliest: string
  latest: string
  grandTotal: number
  platformTotal: number
}

/**
 * Parse diagnostics. Revenue fields sit flat at the top level and are present only
 * when the revenue file parsed; expense diagnostics nest under `expenses`.
 */
export interface FinanceMeta {
  /** The revenue file's name (the endpoint's csvUrl). */
  source?: string
  totalRows?: number
  recurringRows?: number
  psRows?: number
  setupRows?: number
  skippedNoDate?: number
  skippedNoAmount?: number
  skippedOther?: number
  monthCount?: number
  earliest?: string
  latest?: string
  aliasMapSize?: number
  expenses?: ExpenseMeta
}

/**
 * The old `/b/financeData?dataset=all` envelope. A view is absent when the source it
 * needs did not load; `error` then names the source. `ok` tracks revenue, the primary
 * source, so an expense failure alone still reports ok with the revenue views.
 */
export interface FinanceData {
  ok: boolean
  version: number
  /** YYYY-MM-DD, the `today` the views were built for. */
  generatedAt: string
  dataset: 'all'
  error?: string
  mrr?: MrrView
  streams?: StreamsView
  newMrr?: NewMrrView
  ndr?: NdrView
  clients?: ClientsView
  expenses?: ExpensesView
  profitability?: ProfitabilityView
  meta: FinanceMeta
}

export interface SheetInput {
  rows: string[][]
  filename: string
}

// ── Config ───────────────────────────────────────────────────────────────────

const VERSION = 1

const STREAM_RECURRING = 'Recurring'
const STREAM_PS = 'Professional Services Income'
const STREAM_SETUP = 'Setup & Licensing'

// Expense rows whose account path matches this are the platform team's booked
// intracompany fee: surfaced as their own series, counted exactly once.
const PLATFORM_FULLNAME_RE = /PLATFORM Intracompany/i

// The stream / category column was "Full name" in older QuickBooks exports and is
// "Account Name" now; same data, so either title is accepted.
const ACCOUNT_TITLES = ['Account Name', 'Full name']

const REVENUE_COLUMNS: [number, string[]][] = [
  [1, ['Transaction date']],
  [6, ACCOUNT_TITLES],
  [10, ['Amount']],
]
const EXPENSE_COLUMNS: [number, string[]][] = [
  [1, ['Transaction date']],
  [4, ['Name']],
  [6, ACCOUNT_TITLES],
  [8, ['Amount']],
]

// ── Helpers ──────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => (n < 10 ? '0' + n : '' + n)

/** Shift a 'YYYY-MM' key by a number of months (negative = earlier). */
export function addMonthsYm(ym: string, delta: number): string {
  const parts = ym.split('-')
  const idx = parseInt(parts[0], 10) * 12 + (parseInt(parts[1], 10) - 1) + delta
  return Math.floor(idx / 12) + '-' + pad2((idx % 12) + 1)
}

const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-08' → 'Aug 2026'; '' → '—'. */
export function ymLabel(ym: string): string {
  if (!ym) return '—'
  const p = ym.split('-')
  return (MONTHS_ABBR[parseInt(p[1], 10) - 1] || '?') + ' ' + p[0]
}

/** Whole dollars with separators: '$12,345', '-$80'; '—' when there is no number. */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  const neg = n < 0
  const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-$' : '$') + s
}

/** Axis-sized dollars: '$1.2M', '$45.3K', '$120K', '$950'. */
export function moneyShort(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  const neg = n < 0
  const a = Math.abs(n)
  let s: string
  if (a >= 1000000) s = (a / 1000000).toFixed(a >= 10000000 ? 0 : 1) + 'M'
  else if (a >= 1000) s = (a / 1000).toFixed(a >= 100000 ? 0 : 1) + 'K'
  else s = String(Math.round(a))
  return (neg ? '-$' : '$') + s
}

/** 98.46 → '98.5%'. */
export function pct1(n: number): string {
  return Math.round(n * 10) / 10 + '%'
}

/** 4.26 → '+4.3%', -2 → '-2%'. */
export function signedPct(n: number): string {
  return (n > 0 ? '+' : '') + Math.round(n * 10) / 10 + '%'
}

const round2 = (n: number): number => Math.round(n * 100) / 100

const roundMap = (m: MonthAmounts): MonthAmounts => {
  const out: MonthAmounts = {}
  Object.keys(m).forEach(k => { out[k] = round2(m[k]) })
  return out
}
const roundMatrix = (m: { [k: string]: MonthAmounts }): { [k: string]: MonthAmounts } => {
  const out: { [k: string]: MonthAmounts } = {}
  Object.keys(m).forEach(k => { out[k] = roundMap(m[k]) })
  return out
}

/** '$1,234.50' → 1234.5; '(80.00)' → -80; blank → NaN. */
const parseAmount = (v: string | undefined): number => {
  if (v === null || v === undefined) return NaN
  let s = String(v).trim().replace(/[$,\s]/g, '')
  if (s === '') return NaN
  if (s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') s = '-' + s.slice(1, -1)
  return parseFloat(s)
}

/*
 * Excel stores a date cell as days since 1899-12-30 (the 1900 date system, with its
 * phantom 29 Feb 1900 already folded into that epoch for every date after it). The
 * accepted range, 1954 to 2119, keeps a stray small number in the date column (a
 * quantity, a row count) from being read as a date in 1900.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const SERIAL_MIN = 20000
const SERIAL_MAX = 80000

/** MM/DD/YYYY text or an Excel serial → {y, m, d}; anything else → null. */
const parseDate = (s: string | undefined): { y: number; m: number; d: number } | null => {
  const text = String(s ?? '').trim()
  const mt = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mt) return { y: +mt[3], m: +mt[1], d: +mt[2] }
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Math.floor(parseFloat(text))
    if (serial < SERIAL_MIN || serial > SERIAL_MAX) return null
    const dt = new Date(EXCEL_EPOCH_MS + serial * 86400000)
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
  }
  return null
}

const norm = (s: string | undefined): string => String(s ?? '').trim().toLowerCase()

const columnLetter = (i: number): string => {
  let n = i + 1
  let s = ''
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}

/**
 * The rows after the header, with the header checked against the columns the parser
 * reads. Throws with the file and column named, so a changed export is a loud error
 * rather than numbers read from the wrong column.
 */
function dataRows(sheet: SheetInput, expected: [number, string[]][]): string[][] {
  const headerIdx = sheet.rows.findIndex(r => r.some(c => norm(c) === 'transaction date'))
  if (headerIdx < 0) {
    throw new Error(`${sheet.filename}: no header row found (looked for a "Transaction date" column).`)
  }
  const header = sheet.rows[headerIdx]
  for (const [col, titles] of expected) {
    const found = (header[col] ?? '').trim()
    if (!titles.some(t => norm(t) === norm(found))) {
      throw new Error(
        `${sheet.filename}: expected "${titles.join('" or "')}" in column ${col + 1} (${columnLetter(col)}) ` +
          `but found "${found}". The QuickBooks export layout has changed.`,
      )
    }
  }
  return sheet.rows.slice(headerIdx + 1)
}

/*
 * QuickBooks bills some companies under several customer names (Alpine has three), so
 * every place customers are counted goes through this map: a company's own name and
 * each of its QuickBooks names, case-insensitive, to the company name. A later company
 * wins a name two companies both claim, as the endpoint's program loop did.
 */
function buildAliasMap(companies: CompanyAlias[]): { [key: string]: string } {
  const nameMap: { [key: string]: string } = {}
  companies.forEach(c => {
    const name = (c.name || '').trim()
    if (!name) return
    const add = (alias: string): void => {
      const key = (alias || '').trim().toLowerCase()
      if (key) nameMap[key] = name
    }
    add(name)
    ;(c.quickbooksNames || []).forEach(add)
  })
  return nameMap
}

// ── Flattened revenue model ──────────────────────────────────────────────────

export interface RevenueData {
  ok: boolean
  error: string
  totalRows: number
  recurringRows: number
  psRows: number
  setupRows: number
  skippedNoDate: number
  skippedNoAmount: number
  skippedOther: number
  mrrByMonth: MonthAmounts
  custMrrByMonth: { [ym: string]: { [cust: string]: number } }
  activeCustByMonth: MonthAmounts
  psByMonth: MonthAmounts
  setupByMonth: MonthAmounts
  custPsByMonth: { [ym: string]: { [cust: string]: number } }
  custSetupByMonth: { [ym: string]: { [cust: string]: number } }
  // New MRR is tracked per RAW revenue code (the QuickBooks line), not the joined
  // company, so an upsell billed as a new line for an existing company still counts.
  codeFirstRecur: { [code: string]: string }
  codeMrrByMonth: { [code: string]: MonthAmounts }
  codeProgram: { [code: string]: string }
  codeStream: { [code: string]: { program: string; stream: RevenueStream; byMonth: MonthAmounts } }
  aliasMapSize: number
  months: string[]
  earliest: string
  latest: string
}

/** Revenue rows → the flattened model. Throws on a missing or changed header. */
export function parseRevenue(sheet: SheetInput, companies: CompanyAlias[]): RevenueData {
  const data: RevenueData = {
    ok: false, error: '',
    totalRows: 0, recurringRows: 0, psRows: 0, setupRows: 0,
    skippedNoDate: 0, skippedNoAmount: 0, skippedOther: 0,
    mrrByMonth: {}, custMrrByMonth: {}, activeCustByMonth: {},
    psByMonth: {}, setupByMonth: {},
    custPsByMonth: {}, custSetupByMonth: {},
    codeFirstRecur: {}, codeMrrByMonth: {}, codeProgram: {}, codeStream: {}, aliasMapSize: 0,
    months: [], earliest: '', latest: '',
  }
  const nameMap = buildAliasMap(companies)
  data.aliasMapSize = Object.keys(nameMap).length
  const canon = (raw: string): string => nameMap[raw.trim().toLowerCase()] || raw.trim()

  // Per raw code and stream, for the Clients view's breakdown of a company into its
  // billing lines. Carries the joined company for display.
  const addCode = (code: string, program: string, stream: RevenueStream, ym: string, amt: number): void => {
    if (!code) return
    let rec = data.codeStream[code]
    if (!rec) { rec = { program, stream, byMonth: {} }; data.codeStream[code] = rec }
    rec.program = program
    rec.stream = stream
    rec.byMonth[ym] = (rec.byMonth[ym] || 0) + amt
  }

  const activeSets: { [ym: string]: { [cust: string]: boolean } } = {}
  const monthSet: { [ym: string]: boolean } = {}
  dataRows(sheet, REVENUE_COLUMNS).forEach(cells => {
    data.totalRows += 1
    const rawCode = (cells[0] || '').replace(/^﻿/, '').trim()
    if (!rawCode || rawCode === 'TOTAL') return
    const d = parseDate(cells[1])
    if (!d) { data.skippedNoDate += 1; return }
    const full = (cells[6] || '').trim()
    const amt = parseAmount(cells[10])
    if (isNaN(amt)) { data.skippedNoAmount += 1; return }
    const ym = d.y + '-' + pad2(d.m)
    if (full === STREAM_RECURRING) {
      const program = canon(rawCode)
      data.recurringRows += 1
      monthSet[ym] = true
      data.mrrByMonth[ym] = (data.mrrByMonth[ym] || 0) + amt
      if (!data.custMrrByMonth[ym]) data.custMrrByMonth[ym] = {}
      data.custMrrByMonth[ym][program] = (data.custMrrByMonth[ym][program] || 0) + amt
      if (amt > 0) {
        if (!activeSets[ym]) activeSets[ym] = {}
        activeSets[ym][program] = true
      }
      const ds = d.y + '-' + pad2(d.m) + '-' + pad2(d.d)
      if (!data.codeFirstRecur[rawCode] || ds < data.codeFirstRecur[rawCode]) data.codeFirstRecur[rawCode] = ds
      if (!data.codeMrrByMonth[rawCode]) data.codeMrrByMonth[rawCode] = {}
      data.codeMrrByMonth[rawCode][ym] = (data.codeMrrByMonth[rawCode][ym] || 0) + amt
      data.codeProgram[rawCode] = program
      addCode(rawCode, program, 'recurring', ym, amt)
    } else if (full === STREAM_PS) {
      const program = canon(rawCode)
      data.psRows += 1
      monthSet[ym] = true
      data.psByMonth[ym] = (data.psByMonth[ym] || 0) + amt
      if (!data.custPsByMonth[ym]) data.custPsByMonth[ym] = {}
      data.custPsByMonth[ym][program] = (data.custPsByMonth[ym][program] || 0) + amt
      addCode(rawCode, program, 'ps', ym, amt)
    } else if (full === STREAM_SETUP) {
      const program = canon(rawCode)
      data.setupRows += 1
      monthSet[ym] = true
      data.setupByMonth[ym] = (data.setupByMonth[ym] || 0) + amt
      if (!data.custSetupByMonth[ym]) data.custSetupByMonth[ym] = {}
      data.custSetupByMonth[ym][program] = (data.custSetupByMonth[ym][program] || 0) + amt
      addCode(rawCode, program, 'setup', ym, amt)
    } else {
      data.skippedOther += 1
    }
  })
  data.months = Object.keys(monthSet).sort()
  data.earliest = data.months[0] || ''
  data.latest = data.months[data.months.length - 1] || ''
  data.months.forEach(ym => {
    data.activeCustByMonth[ym] = activeSets[ym] ? Object.keys(activeSets[ym]).length : 0
  })
  data.ok = data.months.length > 0
  if (!data.ok && !data.error) data.error = 'No revenue rows parsed.'
  return data
}

/**
 * The month the report opens on: three calendar months before `today` (books lag,
 * so that month is reliably closed), else the nearest earlier month in the data, else
 * the latest.
 */
export function computeDefaultMonth(rev: RevenueData, today: Date = new Date()): { ym: string; reason: string } {
  const mrrMonths = Object.keys(rev.mrrByMonth).sort()
  if (mrrMonths.length === 0) return { ym: '', reason: 'no months' }
  const targetYm = addMonthsYm(today.getFullYear() + '-' + pad2(today.getMonth() + 1), -3)
  if (rev.mrrByMonth[targetYm] !== undefined) {
    return { ym: targetYm, reason: '3 months before current month' }
  }
  const atOrBefore = mrrMonths.filter(ym => ym <= targetYm)
  if (atOrBefore.length > 0) {
    return { ym: atOrBefore[atOrBefore.length - 1], reason: '3-month lag (' + targetYm + ') not in data; using nearest earlier month' }
  }
  return { ym: mrrMonths[mrrMonths.length - 1], reason: '3-month lag (' + targetYm + ') predates data; using latest month' }
}

// ── Flattened expense model ──────────────────────────────────────────────────

export interface ExpenseData {
  ok: boolean
  error: string
  /** Rows after the header. */
  totalRows: number
  /** Rows with a valid date and amount. */
  countedRows: number
  /** Includes category-group-header and subtotal rows, which have no date. */
  skippedNoDate: number
  skippedNoAmount: number
  categoryMonth: { [cat: string]: MonthAmounts }
  vendorMonth: { [vendor: string]: MonthAmounts }
  monthTotal: MonthAmounts
  platformMonth: MonthAmounts
  months: string[]
  earliest: string
  latest: string
  grandTotal: number
  platformTotal: number
}

/** Expense rows → the flattened model. Throws on a missing or changed header. */
export function parseExpenses(sheet: SheetInput): ExpenseData {
  const data: ExpenseData = {
    ok: false, error: '',
    totalRows: 0, countedRows: 0, skippedNoDate: 0, skippedNoAmount: 0,
    categoryMonth: {}, vendorMonth: {}, monthTotal: {}, platformMonth: {},
    months: [], earliest: '', latest: '', grandTotal: 0, platformTotal: 0,
  }
  const monthSet: { [ym: string]: boolean } = {}
  dataRows(sheet, EXPENSE_COLUMNS).forEach(cells => {
    data.totalRows += 1
    const d = parseDate(cells[1])
    if (!d) { data.skippedNoDate += 1; return }
    const amt = parseAmount(cells[8])
    if (isNaN(amt)) { data.skippedNoAmount += 1; return }
    const vendor = (cells[4] || '').trim() || '(unspecified vendor)'
    const fullName = (cells[6] || '').trim()
    const category = (fullName.split(':')[0] || '').trim() || '(uncategorized)'
    const ym = d.y + '-' + pad2(d.m)
    data.countedRows += 1
    monthSet[ym] = true
    data.monthTotal[ym] = (data.monthTotal[ym] || 0) + amt
    data.grandTotal += amt
    if (PLATFORM_FULLNAME_RE.test(fullName)) {
      data.platformMonth[ym] = (data.platformMonth[ym] || 0) + amt
      data.platformTotal += amt
      return
    }
    if (!data.categoryMonth[category]) data.categoryMonth[category] = {}
    data.categoryMonth[category][ym] = (data.categoryMonth[category][ym] || 0) + amt
    if (!data.vendorMonth[vendor]) data.vendorMonth[vendor] = {}
    data.vendorMonth[vendor][ym] = (data.vendorMonth[vendor][ym] || 0) + amt
  })
  data.months = Object.keys(monthSet).sort()
  data.earliest = data.months[0] || ''
  data.latest = data.months[data.months.length - 1] || ''
  data.ok = data.months.length > 0
  if (!data.ok && !data.error) data.error = 'No expense rows parsed.'
  return data
}

// ── View builders ────────────────────────────────────────────────────────────

function buildMrrView(rev: RevenueData, today: Date): MrrView {
  const def = computeDefaultMonth(rev, today)
  const byMonth: { [ym: string]: MrrMonth } = {}
  rev.months.forEach(ym => {
    const custMap = rev.custMrrByMonth[ym] || {}
    const customers = Object.keys(custMap)
      .map(name => ({ name, amount: custMap[name] }))
      .sort((a, b) => b.amount - a.amount)
    byMonth[ym] = {
      mrr: rev.mrrByMonth[ym] || 0,
      activeCustomers: rev.activeCustByMonth[ym] || 0,
      customers,
    }
  })
  return { months: rev.months, byMonth, defaultMonth: def.ym, defaultMonthReason: def.reason }
}

function buildStreamsView(rev: RevenueData): StreamsView {
  const byMonth: { [ym: string]: StreamsMonth } = {}
  rev.months.forEach(ym => {
    byMonth[ym] = {
      recurring: rev.mrrByMonth[ym] || 0,
      professionalServices: rev.psByMonth[ym] || 0,
      setup: rev.setupByMonth[ym] || 0,
    }
  })
  return { months: rev.months, byMonth }
}

/*
 * Company-major (company → stream → month) so the Clients tab can draw one company's
 * series without scanning every month. All three streams go through the same alias
 * join, so a company's split billing names roll up to one entry.
 */
function buildClientsView(rev: RevenueData): ClientsView {
  const byClient: { [program: string]: ClientEntry } = {}
  const ensure = (program: string): ClientEntry => {
    if (!byClient[program]) byClient[program] = { recurring: {}, ps: {}, setup: {}, codes: {} }
    return byClient[program]
  }
  const fold = (matrix: { [ym: string]: { [cust: string]: number } }, stream: RevenueStream): void => {
    Object.keys(matrix).forEach(ym => {
      const custMap = matrix[ym]
      Object.keys(custMap).forEach(program => {
        const bucket = ensure(program)[stream]
        bucket[ym] = round2((bucket[ym] || 0) + custMap[program])
      })
    })
  }
  fold(rev.custMrrByMonth, 'recurring')
  fold(rev.custPsByMonth, 'ps')
  fold(rev.custSetupByMonth, 'setup')

  Object.keys(rev.codeStream).forEach(code => {
    const rec = rev.codeStream[code]
    const entry = ensure(rec.program)
    const byMonth: MonthAmounts = {}
    Object.keys(rec.byMonth).forEach(ym => { byMonth[ym] = round2(rec.byMonth[ym]) })
    entry.codes[code] = { stream: rec.stream, byMonth }
  })
  return { months: rev.months, byClient }
}

/*
 * New MRR for a month = recurring revenue from billing lines whose first-ever recurring
 * month is that month, valued at that month's recurring. Per raw code, so it counts
 * brand-new companies and upsells alike. Tied to actual billing, not deal records.
 */
function buildNewMrrView(rev: RevenueData): NewMrrView {
  const byMonth: { [ym: string]: NewMrrMonth } = {}
  Object.keys(rev.codeFirstRecur).forEach(code => {
    const firstYm = rev.codeFirstRecur[code].slice(0, 7)
    const mrr = (rev.codeMrrByMonth[code] && rev.codeMrrByMonth[code][firstYm]) || 0
    if (!byMonth[firstYm]) byMonth[firstYm] = { total: 0, newLines: 0, lines: [] }
    byMonth[firstYm].total += mrr
    byMonth[firstYm].newLines += 1
    byMonth[firstYm].lines.push({ program: rev.codeProgram[code] || code, code, newMrr: round2(mrr) })
  })
  const months = Object.keys(byMonth).sort()
  months.forEach(ym => {
    byMonth[ym].total = round2(byMonth[ym].total)
    byMonth[ym].lines.sort((a, b) => b.newMrr - a.newMrr)
  })
  return { months, byMonth }
}

/*
 * Net dollar retention, recurring only, year over year. Cohort = companies with
 * recurring > 0 in M−12; NDR = their recurring in M / their recurring in M−12. The
 * numerator folds in expansion, contraction and churn; companies won after M−12 are
 * excluded by construction.
 */
function buildNdrView(rev: RevenueData): NdrView {
  const months = Object.keys(rev.mrrByMonth).sort()
  const byMonth: { [ym: string]: NdrMonth } = {}
  months.forEach(ym => {
    const baseYm = addMonthsYm(ym, -12)
    const baseMap = rev.custMrrByMonth[baseYm]
    const curMap = rev.custMrrByMonth[ym] || {}
    if (!baseMap) {
      byMonth[ym] = { ndr: null, baseYm, startMRR: 0, retainedMRR: 0, cohortSize: 0, rows: [] }
      return
    }
    let startTotal = 0
    let retainedTotal = 0
    const rows: NdrRow[] = []
    Object.keys(baseMap).forEach(program => {
      const base = baseMap[program] || 0
      if (base <= 0) return
      const cur = curMap[program] || 0
      startTotal += base
      retainedTotal += cur
      rows.push({ program, base: round2(base), current: round2(cur), delta: round2(cur - base) })
    })
    rows.sort((a, b) => a.delta - b.delta)
    const ndr = startTotal > 0 ? round2((retainedTotal / startTotal) * 100) : null
    byMonth[ym] = {
      ndr,
      baseYm,
      startMRR: round2(startTotal),
      retainedMRR: round2(retainedTotal),
      cohortSize: rows.length,
      rows,
    }
  })
  return { months, byMonth }
}

function buildExpensesView(exp: ExpenseData): ExpensesView {
  return {
    months: exp.months,
    categoryMonth: roundMatrix(exp.categoryMonth),
    vendorMonth: roundMatrix(exp.vendorMonth),
    monthTotal: roundMap(exp.monthTotal),
    platformMonth: roundMap(exp.platformMonth),
  }
}

/** Revenue vs expenses over the union of both sources' months. */
function buildProfitabilityView(rev: RevenueData, exp: ExpenseData): ProfitabilityView {
  const set: { [ym: string]: boolean } = {}
  rev.months.forEach(m => { set[m] = true })
  exp.months.forEach(m => { set[m] = true })
  const months = Object.keys(set).sort()
  const byMonth: { [ym: string]: ProfitabilityMonth } = {}
  months.forEach(ym => {
    const recurring = rev.mrrByMonth[ym] || 0
    const ps = rev.psByMonth[ym] || 0
    const setup = rev.setupByMonth[ym] || 0
    const revTotal = recurring + ps + setup
    const expTotal = exp.monthTotal[ym] || 0
    const platform = exp.platformMonth[ym] || 0
    const net = revTotal - expTotal
    byMonth[ym] = {
      revenue: { recurring: round2(recurring), ps: round2(ps), setup: round2(setup), total: round2(revTotal) },
      expenses: { total: round2(expTotal), platform: round2(platform) },
      net: round2(net),
      margin: revTotal > 0 ? round2((net / revTotal) * 100) : null,
    }
  })
  return { months, byMonth }
}

function buildMetaView(
  rev: RevenueData | null,
  exp: ExpenseData | null,
  revSource: string,
  expSource: string,
): FinanceMeta {
  const m: FinanceMeta = {}
  if (rev) {
    m.source = revSource
    m.totalRows = rev.totalRows
    m.recurringRows = rev.recurringRows
    m.psRows = rev.psRows
    m.setupRows = rev.setupRows
    m.skippedNoDate = rev.skippedNoDate
    m.skippedNoAmount = rev.skippedNoAmount
    m.skippedOther = rev.skippedOther
    m.monthCount = rev.months.length
    m.earliest = rev.earliest
    m.latest = rev.latest
    m.aliasMapSize = rev.aliasMapSize
  }
  if (exp) {
    m.expenses = {
      source: expSource,
      ok: exp.ok,
      error: exp.error,
      totalRows: exp.totalRows,
      countedRows: exp.countedRows,
      skippedNoDate: exp.skippedNoDate,
      skippedNoAmount: exp.skippedNoAmount,
      categories: Object.keys(exp.categoryMonth).length,
      vendors: Object.keys(exp.vendorMonth).length,
      monthCount: exp.months.length,
      earliest: exp.earliest,
      latest: exp.latest,
      grandTotal: round2(exp.grandTotal),
      platformTotal: round2(exp.platformTotal),
    }
  }
  return m
}

// ── Entry point ──────────────────────────────────────────────────────────────

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Both files' rows → every view. Each source fails on its own: a missing or broken
 * revenue file drops the revenue views (and profitability) and is named in `error`,
 * while the expense views still build, and the other way round.
 */
export function buildFinanceData(input: {
  revenue: SheetInput | null
  expenses: SheetInput | null
  companies: CompanyAlias[]
  today?: Date
}): FinanceData {
  const today = input.today ?? new Date()
  const errors: string[] = []

  let rev: RevenueData | null = null
  if (!input.revenue) {
    errors.push('revenue: file not attached')
  } else {
    try {
      rev = parseRevenue(input.revenue, input.companies)
      if (!rev.ok) errors.push('revenue: ' + (rev.error || 'parse failed'))
    } catch (e) {
      errors.push('revenue: ' + messageOf(e))
    }
  }

  let exp: ExpenseData | null = null
  if (!input.expenses) {
    errors.push('expenses: file not attached')
  } else {
    try {
      exp = parseExpenses(input.expenses)
      if (!exp.ok) errors.push('expenses: ' + (exp.error || 'parse failed'))
    } catch (e) {
      errors.push('expenses: ' + messageOf(e))
    }
  }

  const generatedAt = today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate())
  const out: FinanceData = {
    ok: !!(rev && rev.ok),
    version: VERSION,
    generatedAt,
    dataset: 'all',
    meta: buildMetaView(rev, exp, input.revenue?.filename ?? '', input.expenses?.filename ?? ''),
  }
  if (errors.length) out.error = errors.join('; ')
  if (rev) {
    out.mrr = buildMrrView(rev, today)
    out.streams = buildStreamsView(rev)
    out.newMrr = buildNewMrrView(rev)
    out.ndr = buildNdrView(rev)
    out.clients = buildClientsView(rev)
  }
  if (exp) out.expenses = buildExpensesView(exp)
  if (rev && exp) out.profitability = buildProfitabilityView(rev, exp)
  return out
}
