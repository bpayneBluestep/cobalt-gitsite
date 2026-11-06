import {
  addMonthsYm, money, pct1, signedPct, ymLabel,
  type ClientEntry, type FinanceData, type MrrCustomer, type NdrRow, type RevenueStream,
} from '../../lib/finance'

/*
 * The Finance report's compute layer: everything the tabs show that is not already a
 * field of `FinanceData`.
 *
 * A port of the old BEH dashboard client (U141648 `financeDashboard` static/script.ts),
 * kept rule for rule: the same thresholds, the same severities, the same "null before
 * the first expense month" rule. Those rules are what leadership learned to read; a
 * port that quietly moved the concentration flag from 15% to 20% would change what the
 * Action List says without anybody deciding it should. Only the markup moved.
 *
 * Pure functions over one `FinanceData`, closed over by `makeModel`, so the tab
 * components stay markup and a month change is a re-render, never a refetch.
 */

// ── Thresholds (unchanged from the old dashboard) ────────────────────────────

/** Single-customer share of MRR (%) that earns a flag. */
export const CONCENTRATION_FLAG = 15
/** An expense category jumping by more than this % MoM… */
export const ANOMALY_PCT = 50
/** …and by more than this many dollars, is an anomaly. */
export const ANOMALY_FLOOR = 500
/** Payroll as % of revenue worth a warning tone. */
export const PAYROLL_PCT_FLAG = 70
/** New MRR at or above this is a good month… */
export const NEW_MRR_GOOD = 2000
/** …below this is a red card and a Watch item. */
export const NEW_MRR_FLOOR = 500
/** Net profit band (±) that reads as neutral rather than good or bad. */
export const NET_BAND = 5000
/** A month's payroll below this (but above zero) looks like a partial export. */
export const PAYROLL_INCOMPLETE = 5000
/** Months the revenue export may lag today before the report says so. */
export const STALE_MONTHS = 2

/** The old green / yellow / red, in Cobalt's `data-tone` words. */
export type Tone = 'good' | 'warn' | 'bad' | undefined

export type Severity = 'red' | 'yellow' | 'info'
export interface Alert {
  area: Area
  severity: Severity
  title: string
  detail: string
  action: string
}
export const AREA_ORDER = ['Profitability', 'Retention', 'Revenue', 'Expenses', 'Data'] as const
export type Area = typeof AREA_ORDER[number]
const SEV_RANK: Record<Severity, number> = { red: 0, yellow: 1, info: 2 }
export const SEV_LABEL: Record<Severity, string> = { red: 'Critical', yellow: 'Watch', info: 'Note' }
export const SEV_TONE: Record<Severity, Tone> = { red: 'bad', yellow: 'warn', info: undefined }

export interface Kpis {
  mrr: number
  mrrMoM: number | null
  mrrYoY: number | null
  net: number
  netMoM: number | null
  margin: number | null
  ndr: number | null
  newMrr: number
  newLines: number
  activeCustomers: number
  expenses: number
  expMoM: number | null
  burn: number
}

export type StreamId = 'all' | RevenueStream
export const STREAMS: { id: StreamId; label: string }[] = [
  { id: 'all', label: 'All revenue' },
  { id: 'recurring', label: 'Recurring (MRR)' },
  { id: 'ps', label: 'Professional services' },
  { id: 'setup', label: 'Setup & licensing' },
]
export const STREAM_TAG: Record<RevenueStream, string> = { recurring: 'Recurring', ps: 'Prof svc', setup: 'Setup' }
export const streamLabel = (id: StreamId): string => STREAMS.find(s => s.id === id)?.label ?? id

export type ClientStatus = 'Growing' | 'Declining' | 'Churned' | 'Flat' | 'Inactive'
export const STATUS_TONE: Record<ClientStatus, Tone> = {
  Growing: 'good', Declining: 'warn', Churned: 'bad', Flat: undefined, Inactive: undefined,
}
export type CohortTag = 'Churned' | 'Contracted' | 'Expanded' | 'Flat'
export const COHORT_TONE: Record<CohortTag, Tone> = {
  Churned: 'bad', Contracted: 'warn', Expanded: 'good', Flat: undefined,
}

export interface ClientRow {
  name: string
  value: number
  share: number | null
  momPct: number | null
  momAbs: number
  yoyPct: number | null
  yoyAbs: number
  status: ClientStatus
  spark: number[]
  products: ProdLine[]
}
export type ClientSortKey = 'name' | 'value' | 'share' | 'momAbs' | 'yoyAbs' | 'status'

export interface ProdLine { code: string; stream: RevenueStream; amount: number }

export interface WfStep { label: string; value: number; kind: 'total' | 'inc' | 'dec' }

// ── Status rules ─────────────────────────────────────────────────────────────

export const ndrTone = (n: number | null): Tone =>
  n === null ? undefined : n >= 100 ? 'good' : n >= 90 ? 'warn' : 'bad'
export const netTone = (n: number): Tone =>
  n > NET_BAND ? 'good' : n >= -NET_BAND ? 'warn' : 'bad'
export const newMrrTone = (n: number): Tone =>
  n >= NEW_MRR_GOOD ? 'good' : n >= NEW_MRR_FLOOR ? 'warn' : 'bad'

export const cohortTag = (r: NdrRow): CohortTag =>
  num(r.current) <= 0 ? 'Churned'
    : num(r.current) > num(r.base) ? 'Expanded'
      : num(r.current) < num(r.base) ? 'Contracted' : 'Flat'

const num = (v: unknown): number => (typeof v === 'number' && !isNaN(v) ? v : 0)
const pad2 = (n: number): string => (n < 10 ? '0' + n : '' + n)
export const ymOf = (d: Date): string => d.getFullYear() + '-' + pad2(d.getMonth() + 1)
/** Whole months from `a` to `b` ('YYYY-MM'); positive when b is later. */
export const monthsBetween = (a: string, b: string): number => {
  const [ay, am] = a.split('-').map(Number)
  const [by, bm] = b.split('-').map(Number)
  return (by * 12 + bm) - (ay * 12 + am)
}
/** 'Aug 26', for an axis. */
export const ymShort = (ym: string): string => {
  const l = ymLabel(ym)
  return l.length > 4 ? l.slice(0, 4) + l.slice(-2) : l
}

// ── The model ────────────────────────────────────────────────────────────────

export type Model = ReturnType<typeof makeModel>

export function makeModel(D: FinanceData, today: Date) {
  const mrrBy = D.mrr?.byMonth ?? {}
  const streamsBy = D.streams?.byMonth ?? {}
  const newMrrBy = D.newMrr?.byMonth ?? {}
  const ndrBy = D.ndr?.byMonth ?? {}
  const profitBy = D.profitability?.byMonth ?? {}
  const byClient: { [name: string]: ClientEntry } = D.clients?.byClient ?? {}
  const expenses = D.expenses ?? { months: [], categoryMonth: {}, vendorMonth: {}, monthTotal: {}, platformMonth: {} }
  const catMonth = expenses.categoryMonth
  const vendorMonth = expenses.vendorMonth

  /*
   * Expenses are a year-to-date export with no history before its first month. Every
   * expense and net series is null before that, never $0: a $0 expense line under eight
   * years of revenue reads as eight years of pure profit.
   */
  const expMonthsSorted = expenses.months.slice().sort()
  const earliestExpMonth: string | null = expMonthsSorted.length ? expMonthsSorted[0] : null
  const hasExpenseData = (ym: string): boolean => earliestExpMonth !== null && ym >= earliestExpMonth

  /*
   * Selectable months are the recurring (MRR) months, as before. With no revenue file
   * the expense months stand in, so the Expenses tab still has something to select.
   */
  const months: string[] = (D.mrr?.months.length ? D.mrr.months : expMonthsSorted).slice()
  const defaultMonth: string =
    D.mrr?.defaultMonth && mrrBy[D.mrr.defaultMonth] ? D.mrr.defaultMonth : months[months.length - 1] ?? ''

  const nowYm = ymOf(today)

  // ── Revenue / expense / net per month ──
  const revTotal = (ym: string): number => (profitBy[ym] ? num(profitBy[ym].revenue.total) : 0)
  const expTotal = (ym: string): number =>
    profitBy[ym] ? num(profitBy[ym].expenses.total) : num(expenses.monthTotal[ym])
  const netOf = (ym: string): number => (profitBy[ym] ? num(profitBy[ym].net) : revTotal(ym) - expTotal(ym))

  const computeKpis = (ym: string): Kpis => {
    const prev = addMonthsYm(ym, -1)
    const prevY = addMonthsYm(ym, -12)
    const mrrNow = mrrBy[ym] ? num(mrrBy[ym].mrr) : 0
    const mrrPrev = mrrBy[prev] ? num(mrrBy[prev].mrr) : null
    const mrrPrevY = mrrBy[prevY] ? num(mrrBy[prevY].mrr) : null
    const net = netOf(ym)
    const netPrev = profitBy[prev] ? num(profitBy[prev].net) : null
    const exp = expTotal(ym)
    const expPrev = profitBy[prev] ? num(profitBy[prev].expenses.total)
      : expenses.monthTotal[prev] !== undefined ? num(expenses.monthTotal[prev]) : null
    const margin = profitBy[ym]?.margin
    const ndr = ndrBy[ym]?.ndr
    return {
      mrr: mrrNow,
      mrrMoM: mrrPrev && mrrPrev > 0 ? ((mrrNow - mrrPrev) / mrrPrev) * 100 : null,
      mrrYoY: mrrPrevY && mrrPrevY > 0 ? ((mrrNow - mrrPrevY) / mrrPrevY) * 100 : null,
      net,
      netMoM: netPrev !== null && netPrev !== 0 ? ((net - netPrev) / Math.abs(netPrev)) * 100 : null,
      margin: margin !== null && margin !== undefined ? num(margin) : null,
      ndr: ndr !== null && ndr !== undefined ? num(ndr) : null,
      newMrr: newMrrBy[ym] ? num(newMrrBy[ym].total) : 0,
      newLines: newMrrBy[ym] ? num(newMrrBy[ym].newLines) : 0,
      activeCustomers: mrrBy[ym] ? num(mrrBy[ym].activeCustomers) : 0,
      expenses: exp,
      expMoM: expPrev !== null && expPrev > 0 ? ((exp - expPrev) / expPrev) * 100 : null,
      burn: net < 0 ? -net : 0,
    }
  }

  const largestExpenseCategory = (ym: string): { name: string; amt: number } | null => {
    let best: { name: string; amt: number } | null = null
    for (const cat of Object.keys(catMonth)) {
      const amt = num(catMonth[cat][ym])
      if (amt > 0 && (!best || amt > best.amt)) best = { name: cat, amt }
    }
    return best
  }

  /** Year-over-year movement counts from the NDR cohort rows. */
  const retentionCounts = (ym: string) => {
    const out = { churned: 0, contracted: 0, expanded: 0 }
    for (const r of ndrBy[ym]?.rows ?? []) {
      if (num(r.current) <= 0) out.churned += 1
      else if (num(r.current) < num(r.base)) out.contracted += 1
      else if (num(r.current) > num(r.base)) out.expanded += 1
    }
    return out
  }

  const buildNarrative = (ym: string): string[] => {
    const k = computeKpis(ym)
    const parts: string[] = []
    let s = 'In ' + ymLabel(ym) + ', recurring revenue was ' + money(k.mrr)
    const tags: string[] = []
    if (k.mrrYoY !== null) tags.push(signedPct(k.mrrYoY) + ' YoY')
    if (k.mrrMoM !== null) tags.push(signedPct(k.mrrMoM) + ' MoM')
    if (tags.length) s += ' (' + tags.join(', ') + ')'
    parts.push(s + '.')

    const word = k.net >= 0 ? 'profit' : 'loss'
    let p2 = 'The month netted a ' + money(Math.abs(k.net)) + ' ' + word + ' — ' +
      money(k.expenses) + ' of expenses against ' + money(revTotal(ym)) + ' of total revenue'
    const lc = largestExpenseCategory(ym)
    if (lc) p2 += ', with ' + lc.name + ' (' + money(lc.amt) + ') the largest expense'
    parts.push(p2 + '.')

    if (k.ndr !== null) {
      const rc = retentionCounts(ym)
      parts.push('Net retention was ' + pct1(k.ndr) + ' — ' + rc.expanded + ' accounts expanded, ' +
        rc.contracted + ' contracted, ' + rc.churned + ' churned.')
    }
    return parts
  }

  /** The last `n` months up to `ym`, over the profitability months (else the MRR ones). */
  const trailing = (ym: string, n: number): string[] => {
    const all = D.profitability?.months.length ? D.profitability.months.slice() : months.slice()
    const upto = all.filter(m => m <= ym)
    return upto.slice(Math.max(0, upto.length - n))
  }

  // ── Revenue ──

  /** MoM MRR movement, decomposed from per-customer recurring (M vs M-1). */
  const mrrWaterfall = (ym: string) => {
    const prev = addMonthsYm(ym, -1)
    const prevMap: { [n: string]: number } = {}
    const curMap: { [n: string]: number } = {}
    for (const c of mrrBy[prev]?.customers ?? []) prevMap[c.name] = num(c.amount)
    for (const c of mrrBy[ym]?.customers ?? []) curMap[c.name] = num(c.amount)
    let start = 0, end = 0, nw = 0, exp = 0, con = 0, churn = 0
    for (const n of Object.keys(prevMap)) start += prevMap[n]
    for (const n of Object.keys(curMap)) end += curMap[n]
    const names = new Set([...Object.keys(prevMap), ...Object.keys(curMap)])
    for (const n of names) {
      const p = prevMap[n] || 0, c = curMap[n] || 0
      if (p <= 0 && c > 0) nw += c
      else if (p > 0 && c <= 0) churn += -p
      else if (c > p) exp += c - p
      else if (c < p) con += c - p
    }
    const steps: WfStep[] = [
      { label: ymLabel(prev), value: start, kind: 'total' },
      { label: 'New', value: nw, kind: 'inc' },
      { label: 'Expansion', value: exp, kind: 'inc' },
      { label: 'Contraction', value: con, kind: 'dec' },
      // `churn` is already negative. The old client negated it again, so its churn
      // bar rose (green) instead of falling and the steps did not add up to the total.
      { label: 'Churn', value: churn, kind: 'dec' },
      { label: ymLabel(ym), value: end, kind: 'total' },
    ]
    return { prev, start, end, nw, exp, con, churn, hasPrev: Object.keys(prevMap).length > 0, steps }
  }

  /** Year-over-year cohort movement from the NDR rows; null with no prior-year base. */
  const ndrWaterfall = (ym: string) => {
    const c = ndrBy[ym]
    if (!c || c.ndr === null || c.ndr === undefined) return null
    let exp = 0, con = 0, churn = 0
    for (const r of c.rows ?? []) {
      const b = num(r.base), cur = num(r.current)
      if (cur <= 0) churn += -b
      else if (cur > b) exp += cur - b
      else if (cur < b) con += cur - b
    }
    const steps: WfStep[] = [
      { label: ymLabel(c.baseYm), value: num(c.startMRR), kind: 'total' },
      { label: 'Expansion', value: exp, kind: 'inc' },
      { label: 'Contraction', value: con, kind: 'dec' },
      // `churn` is already negative. The old client negated it again, so its churn
      // bar rose (green) instead of falling and the steps did not add up to the total.
      { label: 'Churn', value: churn, kind: 'dec' },
      { label: ymLabel(ym), value: num(c.retainedMRR), kind: 'total' },
    ]
    return {
      start: num(c.startMRR), retained: num(c.retainedMRR), exp, con, churn,
      baseYm: c.baseYm, ndr: num(c.ndr), cohortSize: num(c.cohortSize), steps,
    }
  }

  /** Customers by MRR, largest first, with the top account's share. */
  const concentration = (ym: string) => {
    const custs: MrrCustomer[] = (mrrBy[ym]?.customers ?? []).slice().sort((a, b) => num(b.amount) - num(a.amount))
    const total = custs.reduce((s, c) => s + num(c.amount), 0)
    const topShare = total > 0 && custs.length ? (num(custs[0].amount) / total) * 100 : 0
    return { custs, total, topShare, flagged: topShare >= CONCENTRATION_FLAG }
  }

  const streamsAt = (ym: string) => streamsBy[ym]
  const newMrrAt = (ym: string) => newMrrBy[ym]
  const ndrAt = (ym: string) => ndrBy[ym]
  const marginAt = (ym: string): number | null => {
    const m = profitBy[ym]?.margin
    return m !== null && m !== undefined ? num(m) : null
  }

  // ── Expenses ──
  /*
   * The payroll category. The old client took the first name containing "payroll",
   * which in this chart of accounts is "Taxes (non-payroll)": Payroll read $0 and the
   * contribution margin equalled the net margin. A name that STARTS with Payroll wins.
   */
  const catKeys = Object.keys(catMonth)
  const payrollCat: string | null =
    catKeys.find(c => /^payroll/i.test(c)) ??
    catKeys.find(c => /payroll/i.test(c) && !/non-payroll/i.test(c)) ?? null
  const payrollOf = (ym: string): number => (payrollCat && catMonth[payrollCat] ? num(catMonth[payrollCat][ym]) : 0)
  const platformOf = (ym: string): number => num(expenses.platformMonth ? expenses.platformMonth[ym] : 0)

  const catsForMonth = (ym: string): { name: string; amt: number }[] =>
    Object.keys(catMonth).map(c => ({ name: c, amt: num(catMonth[c][ym]) }))
      .filter(o => o.amt !== 0).sort((a, b) => b.amt - a.amt)
  const vendorsForMonth = (ym: string): { name: string; amt: number; delta: number }[] => {
    const prev = addMonthsYm(ym, -1)
    return Object.keys(vendorMonth)
      .map(v => ({ name: v, amt: num(vendorMonth[v][ym]), delta: num(vendorMonth[v][ym]) - num(vendorMonth[v][prev]) }))
      .filter(o => o.amt !== 0).sort((a, b) => b.amt - a.amt)
  }
  const topCategoriesOverall = (n: number): string[] =>
    Object.keys(catMonth)
      .map(c => ({ name: c, total: expMonthsSorted.reduce((s, m) => s + num(catMonth[c][m]), 0) }))
      .sort((a, b) => b.total - a.total).slice(0, n).map(o => o.name)
  /** Categories whose spend jumped sharply MoM, or appeared new. */
  const expenseAnomalies = (ym: string) => {
    const prev = addMonthsYm(ym, -1)
    const out: { kind: string; name: string; prev: number; cur: number; pct: number | null }[] = []
    for (const name of Object.keys(catMonth)) {
      const cur = num(catMonth[name][ym])
      const pv = num(catMonth[name][prev])
      const delta = cur - pv
      if (delta > ANOMALY_FLOOR && (pv <= 0 || (delta / pv) * 100 > ANOMALY_PCT)) {
        out.push({ kind: 'Category', name, prev: pv, cur, pct: pv > 0 ? (delta / pv) * 100 : null })
      }
    }
    return out.sort((a, b) => (b.cur - b.prev) - (a.cur - a.prev))
  }
  /** Expense months up to `ym`, at most 24: the expense and profit charts' window. */
  const expenseWindow = (ym: string): string[] => expMonthsSorted.filter(m => m <= ym).slice(-24)
  const expenseMonthTotal = (ym: string): number => num(expenses.monthTotal[ym])
  const categoryAt = (cat: string, ym: string): number => num(catMonth[cat]?.[ym])
  const categoryNames = Object.keys(catMonth)

  // ── Profitability ──
  const breakEven = (ym: string) => {
    const rev = revTotal(ym), exp = expTotal(ym)
    return { revenue: rev, expenses: exp, gap: exp - rev }
  }
  const trailingBurn = (ym: string, n: number): number => {
    const ms = expMonthsSorted.filter(m => m <= ym).slice(-n)
    if (!ms.length) return 0
    let sumLoss = 0
    for (const m of ms) { const net = netOf(m); if (net < 0) sumLoss += -net }
    return sumLoss / ms.length
  }
  const contributionMarginExPayroll = (ym: string): number | null => {
    const rev = revTotal(ym)
    if (rev <= 0) return null
    return ((rev - (expTotal(ym) - payrollOf(ym))) / rev) * 100
  }

  // ── Alert engine ──
  /** Revenue months after today: annual prepays booked ahead. */
  const forwardMonths = (D.mrr?.months ?? []).filter(m => m > nowYm)

  const evaluateAlerts = (ym: string): Alert[] => {
    const a: Alert[] = []
    const k = computeKpis(ym)
    const hasExp = hasExpenseData(ym)

    if (hasExp && k.net < 0) {
      a.push({
        area: 'Profitability', severity: 'red', title: 'Net loss of ' + money(-k.net),
        detail: ymLabel(ym) + ': expenses ' + money(k.expenses) + ' vs revenue ' + money(revTotal(ym)),
        action: 'Close the gap toward break-even (Profitability).',
      })
    }
    if (k.ndr !== null) {
      if (k.ndr < 90) {
        a.push({
          area: 'Retention', severity: 'red', title: 'Net retention ' + pct1(k.ndr) + ' (below 90%)',
          detail: 'The existing base is eroding year-over-year.', action: 'Review contracting/churned accounts (Retention).',
        })
      } else if (k.ndr < 100) {
        a.push({
          area: 'Retention', severity: 'yellow', title: 'Net retention ' + pct1(k.ndr) + ' (below 100%)',
          detail: 'Base shrinking net of expansion.', action: 'Drive expansion / reduce churn (Retention).',
        })
      }
    }
    if (k.mrrMoM !== null && k.mrrMoM < 0) {
      a.push({
        area: 'Revenue', severity: 'yellow', title: 'Recurring revenue down ' + signedPct(k.mrrMoM) + ' MoM',
        detail: 'MRR ' + money(k.mrr) + '.', action: 'Check churn/contraction and new-line pace (Revenue).',
      })
    }
    if (k.newMrr < NEW_MRR_FLOOR) {
      a.push({
        area: 'Revenue', severity: 'yellow', title: 'New MRR only ' + money(k.newMrr) + ' this month',
        detail: 'Below the ' + money(NEW_MRR_FLOOR) + ' floor.', action: 'New-business / onboarding pace (Revenue).',
      })
    }
    const conc = concentration(ym)
    if (conc.custs.length && conc.total > 0 && conc.flagged) {
      a.push({
        area: 'Revenue', severity: 'yellow',
        title: 'Concentration: ' + conc.custs[0].name + ' is ' + pct1(conc.topShare) + ' of MRR',
        detail: 'Single-customer dependency.', action: 'Diversify the book (Revenue).',
      })
    }
    if (hasExp) {
      for (const an of expenseAnomalies(ym).slice(0, 5)) {
        a.push({
          area: 'Expenses', severity: 'yellow',
          title: an.name + ' spend ' + (an.pct !== null ? signedPct(an.pct) : 'new line'),
          detail: money(an.prev) + ' → ' + money(an.cur) + ' MoM.', action: 'Verify the increase (Expenses).',
        })
      }
    }
    if (hasExp && payrollOf(ym) > 0 && payrollOf(ym) < PAYROLL_INCOMPLETE) {
      a.push({
        area: 'Data', severity: 'yellow', title: 'Payroll looks incomplete (' + money(payrollOf(ym)) + ')',
        detail: 'Net figures may understate true cost.', action: 'Re-check the expense export.',
      })
    }
    if (forwardMonths.length) {
      a.push({
        area: 'Data', severity: 'info',
        title: 'Forward-dated revenue through ' + ymLabel(forwardMonths[forwardMonths.length - 1]),
        detail: 'Likely annual prepays in the export.', action: 'Interpret recent months with care.',
      })
    }
    a.sort((x, y) => (SEV_RANK[x.severity] - SEV_RANK[y.severity]) ||
      (AREA_ORDER.indexOf(x.area) - AREA_ORDER.indexOf(y.area)))
    return a
  }

  // ── Clients ──
  const clientNames = Object.keys(byClient)
  const clientMonthsAll = (D.clients?.months ?? []).slice().sort()

  /** A client's revenue in a month for one stream ('all' = the three summed). */
  const streamVal = (program: string, ym: string, stream: StreamId): number => {
    const c = byClient[program]
    if (!c) return 0
    if (stream === 'all') return num(c.recurring[ym]) + num(c.ps[ym]) + num(c.setup[ym])
    return num(c[stream] ? c[stream][ym] : 0)
  }
  const bookTotalAt = (ym: string, stream: StreamId): number =>
    clientNames.reduce((s, p) => s + streamVal(p, ym, stream), 0)
  /** Months with any nonzero revenue in any stream: tenure. */
  const clientActiveMonths = (program: string): string[] => {
    const c = byClient[program]
    if (!c) return []
    const set = new Set<string>()
    for (const s of ['recurring', 'ps', 'setup'] as const) {
      for (const m of Object.keys(c[s] || {})) if (num(c[s][m]) !== 0) set.add(m)
    }
    return [...set].sort()
  }
  const hasStream = (program: string, stream: StreamId): boolean => {
    const c = byClient[program]
    if (!c) return false
    const test = (m: { [k: string]: number } | undefined) => Object.keys(m || {}).some(k => num(m![k]) !== 0)
    if (stream === 'all') return test(c.recurring) || test(c.ps) || test(c.setup)
    return test(c[stream])
  }
  const clientsWithStream = (stream: StreamId): string[] => clientNames.filter(p => hasStream(p, stream))
  const clientDelta = (program: string, ym: string, stream: StreamId, back: number) => {
    const cur = streamVal(program, ym, stream)
    const prev = streamVal(program, addMonthsYm(ym, back), stream)
    return { cur, prev, abs: cur - prev, pct: prev > 0 ? ((cur - prev) / prev) * 100 : null }
  }
  /** From recurring (the durable signal) against the prior month. */
  const clientStatus = (program: string, ym: string): ClientStatus => {
    const c = byClient[program]
    if (!c) return 'Inactive'
    const cur = num(c.recurring[ym])
    const prev = num(c.recurring[addMonthsYm(ym, -1)])
    if (cur <= 0 && prev > 0) return 'Churned'
    if (cur <= 0 && prev <= 0) return 'Inactive'
    if (cur > prev) return 'Growing'
    if (cur < prev) return 'Declining'
    return 'Flat'
  }
  const clientNewLines = (program: string): { ym: string; code: string; newMrr: number }[] => {
    const out: { ym: string; code: string; newMrr: number }[] = []
    for (const ym of Object.keys(newMrrBy)) {
      for (const l of newMrrBy[ym]?.lines ?? []) {
        if (l.program === program) out.push({ ym, code: l.code, newMrr: num(l.newMrr) })
      }
    }
    out.sort((a, b) => (a.ym < b.ym ? 1 : a.ym > b.ym ? -1 : 0))
    return out
  }
  const clientRetention = (program: string, ym: string): NdrRow | null =>
    (ndrBy[ym]?.rows ?? []).find(r => r.program === program) ?? null
  const clientTrailing = (ym: string, n: number): string[] => {
    const upto = clientMonthsAll.filter(m => m <= ym)
    return upto.slice(Math.max(0, upto.length - n))
  }
  /** Per revenue code for one month, honouring the stream; largest first. */
  const clientProductsAt = (program: string, ym: string, stream: StreamId): ProdLine[] => {
    const c = byClient[program]
    if (!c || !c.codes) return []
    const out: ProdLine[] = []
    for (const code of Object.keys(c.codes)) {
      const rec = c.codes[code]
      if (!rec) continue
      if (stream !== 'all' && rec.stream !== stream) continue
      const amt = num(rec.byMonth ? rec.byMonth[ym] : 0)
      if (amt === 0) continue
      out.push({ code, stream: rec.stream, amount: amt })
    }
    return out.sort((a, b) => b.amount - a.amount)
  }

  /** The comparison table's rows, before sorting. */
  const clientRows = (ym: string, stream: StreamId): ClientRow[] => {
    const book = bookTotalAt(ym, stream)
    const window = clientTrailing(ym, 12)
    return clientsWithStream(stream).map(p => {
      const value = streamVal(p, ym, stream)
      const mom = clientDelta(p, ym, stream, -1)
      const yoy = clientDelta(p, ym, stream, -12)
      return {
        name: p,
        value,
        share: book > 0 ? (value / book) * 100 : null,
        momPct: mom.pct, momAbs: mom.abs,
        yoyPct: yoy.pct, yoyAbs: yoy.abs,
        status: clientStatus(p, ym),
        spark: window.map(m => streamVal(p, m, stream)),
        products: clientProductsAt(p, ym, stream),
      }
    })
  }

  /** Top three gainers and decliners MoM, for the selected stream. */
  const movers = (ym: string, stream: StreamId) => {
    const data = clientsWithStream(stream)
      .map(p => ({ name: p, d: clientDelta(p, ym, stream, -1).abs }))
      .filter(o => o.d !== 0)
    return {
      gainers: data.slice().sort((a, b) => b.d - a.d).filter(o => o.d > 0).slice(0, 3),
      losers: data.slice().sort((a, b) => a.d - b.d).filter(o => o.d < 0).slice(0, 3),
    }
  }

  /** Everything the single-client deep dive shows above its tables. */
  const clientSummary = (p: string, ym: string, stream: StreamId) => {
    const c = byClient[p]
    const recAt = (m: string) => num(c.recurring[m])
    const tenure = clientActiveMonths(p)
    const recKeys = Object.keys(c.recurring).filter(m => recAt(m) > 0)
    const book = bookTotalAt(ym, stream)
    const myVal = streamVal(p, ym, stream)
    const ranked = clientsWithStream(stream).filter(n => streamVal(n, ym, stream) > 0)
      .sort((a, b) => streamVal(b, ym, stream) - streamVal(a, ym, stream))
    return {
      curMrr: recAt(ym),
      mom: clientDelta(p, ym, 'recurring', -1),
      yoy: clientDelta(p, ym, 'recurring', -12),
      firstM: tenure.length ? tenure[0] : null,
      lastM: tenure.length ? tenure[tenure.length - 1] : null,
      peak: recKeys.reduce((mx, m) => Math.max(mx, recAt(m)), 0),
      lifetime: Object.keys(c.recurring).reduce((s, m) => s + recAt(m), 0),
      monthsActive: recKeys.length,
      status: clientStatus(p, ym),
      share: book > 0 ? (myVal / book) * 100 : null,
      rank: ranked.indexOf(p) + 1,
      rankOf: ranked.length,
    }
  }

  // ── Freshness ──
  /** The newest revenue month that is not forward-dated: how current the export is. */
  const revenueThrough: string | null = (D.mrr?.months ?? []).filter(m => m <= nowYm).slice(-1)[0] ?? null
  const revenueStale = revenueThrough !== null && monthsBetween(revenueThrough, nowYm) > STALE_MONTHS

  return {
    D, months, defaultMonth, nowYm,
    hasRevenue: !!D.mrr, hasExpenses: !!D.expenses,
    hasExpenseData, earliestExpMonth, expMonthsSorted,
    revTotal, expTotal, netOf, computeKpis, largestExpenseCategory, retentionCounts, buildNarrative, trailing,
    mrrWaterfall, ndrWaterfall, concentration, streamsAt, newMrrAt, ndrAt, marginAt,
    payrollOf, platformOf, catsForMonth, vendorsForMonth, topCategoriesOverall, expenseAnomalies,
    expenseWindow, expenseMonthTotal, categoryAt, categoryNames,
    breakEven, trailingBurn, contributionMarginExPayroll,
    evaluateAlerts, forwardMonths,
    byClient, clientNames, streamVal, clientsWithStream, clientStatus, clientNewLines, clientRetention,
    clientTrailing, clientProductsAt, clientRows, movers, clientSummary,
    revenueThrough, revenueStale,
  }
}

/** Sort the comparison table: numbers with missing values last, names A–Z. */
export function sortClientRows(rows: ClientRow[], key: ClientSortKey, dir: 1 | -1): ClientRow[] {
  const cmpNum = (a: number | null, b: number | null): number => {
    const av = a === null || a === undefined || isNaN(a) ? -Infinity : a
    const bv = b === null || b === undefined || isNaN(b) ? -Infinity : b
    return av === bv ? 0 : (av - bv) * dir
  }
  return rows.slice().sort((a, b) =>
    key === 'name' ? a.name.localeCompare(b.name) * dir
      : key === 'status' ? a.status.localeCompare(b.status) * dir
        : cmpNum(a[key], b[key]))
}
