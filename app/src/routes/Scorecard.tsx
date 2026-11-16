import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError, getScorecard, type ScorecardData } from '../api'
import { addMonthsYm, money, pct1, signedPct, ymLabel } from '../lib/finance'
import { load as loadFinance } from './FinanceReport'
import { cohortTag, makeModel, type Model, type Tone } from './finance/compute'

/*
 * The Scorecard.
 *
 * beh's Behavioral Team Scorecard (U141648 `530024__GID_142`), ported: the measures
 * leadership reviews each week. Each one reports a single number, lands in a green,
 * yellow or red band, names its owner, and opens the rows behind it so the number can be
 * checked by hand.
 *
 * TWO sources, loaded side by side and failing on their own. The record-backed cards
 * (temperatures, demos, NPS) come from Maestro's `scorecard` action, already counted
 * with their rows. The finance cards are built here from the QuickBooks exports with the
 * Finance report's own loader and model, so the two reports cannot show different
 * figures for the same month.
 *
 * To add a measure: write one entry in `buildCards`. Banding, the card, the grouping by
 * category and the Verify panel are all generic. A measure Cobalt has no data for is a
 * `soon()` entry, said plainly rather than left off: the list is the agreed scorecard,
 * and a missing card reads as a forgotten one.
 *
 * The month and the open Verify panel live in the URL, like the other reports, so a
 * number under discussion can be linked to. Both replace history: stepping through
 * months or peeking at rows should not bury the page you came from.
 */

type Status = 'green' | 'yellow' | 'red' | 'unknown' | 'soon'

const STATUS_TONE: Record<Status, Tone> = {
  green: 'good', yellow: 'warn', red: 'bad', unknown: undefined, soon: undefined,
}
const STATUS_LABEL: Record<Status, string> = {
  green: 'Green', yellow: 'Yellow', red: 'Red', unknown: 'No data', soon: 'Coming soon',
}

interface Column { label: string; num?: boolean }
interface Verify {
  /** One sentence restating the number in terms of the rows below it. */
  summary: string
  columns: Column[]
  rows: { key: string; cells: ReactNode[] }[]
  empty: string
}
interface Bands { green: string; yellow: string; red: string }

interface Card {
  id: string
  category: string
  name: string
  owner: string
  status: Status
  value: string
  note?: string
  /** What the number means and how it is measured. */
  definition?: string
  bands?: Bands
  verify?: Verify
}

/** Bands as plain comparisons, checked top-down: the first that holds wins. */
const band = (v: number | null, green: (n: number) => boolean, yellow: (n: number) => boolean): Status =>
  v === null ? 'unknown' : green(v) ? 'green' : yellow(v) ? 'yellow' : 'red'

/** `2026-11-03` as 11/3/2026; anything else is shown as it came. */
function day(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : iso || '—'
}
const ago = (days: number): string => (days <= 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`)
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`
const company = (id: string, name: string): ReactNode =>
  id ? <Link className="inlink" to={`/clients/${id}`}>{name || '(unnamed)'}</Link> : (name || '(unnamed)')

/** A measure that is on the scorecard but that Cobalt cannot yet count. */
const soon = (id: string, category: string, name: string, owner: string, why: string): Card => ({
  id, category, name, owner, status: 'soon', value: '—', note: why,
})

/** A card whose source did not load: the measure stays visible and says why it is blank. */
const blank = (base: Pick<Card, 'id' | 'category' | 'name' | 'owner' | 'definition' | 'bands'>, note: string): Card => ({
  ...base, status: 'unknown', value: '—', note,
})

function buildCards(sc: ScorecardData | null, scNote: string, m: Model | null, finNote: string, ym: string): Card[] {
  const cards: Card[] = []

  // ── Program Success ────────────────────────────────────────────────────────
  {
    const base = {
      id: 'temp-checks-due', category: 'Program Success', owner: 'Noel Miller',
      name: 'Programs Needing a Temperature Check',
      definition: 'How many current clients are due a check-in: the last contact is older than ' +
        "the account's cadence (set by its support intensity), or there has never been one. " +
        'The same count the Client Success queue shows. Lower is healthier.',
      bands: { green: '0–3', yellow: '4–8', red: '9+' },
    }
    if (!sc) cards.push(blank(base, scNote))
    else {
      const t = sc.tempChecks
      cards.push({
        ...base,
        status: band(t.due, n => n <= 3, n => n <= 8),
        value: String(t.due),
        note: `of ${plural(t.total, 'client')}`,
        verify: {
          summary: `${t.due} of ${plural(t.total, 'client')} ${t.due === 1 ? 'is' : 'are'} due a check-in.`,
          columns: [{ label: 'Client' }, { label: 'Last contact' }, { label: 'Age', num: true }, { label: 'Cadence', num: true }],
          rows: t.rows.map(r => ({
            key: r.companyId,
            cells: [
              company(r.companyId, r.companyName),
              r.lastContact ? day(r.lastContact) : 'None logged',
              r.contactAgeDays === null ? 'Never' : ago(r.contactAgeDays),
              `${r.cadenceDays} days`,
            ],
          })),
          empty: 'No client is due a check-in.',
        },
      })
    }
  }
  {
    const base = {
      id: 'green-temp-rate', category: 'Program Success', owner: 'Noel Miller',
      name: 'Green Temperature Rate',
      definition: 'Of all current clients, the share whose most recent temperature reading is ' +
        'green, whatever its age. A client with no reading counts against the rate. Higher is healthier.',
      bands: { green: '95%+', yellow: '85–95%', red: 'below 85%' },
    }
    if (!sc) cards.push(blank(base, scNote))
    else {
      const g = sc.greenRate
      cards.push({
        ...base,
        status: band(g.pct, n => n >= 95, n => n >= 85),
        value: g.pct === null ? '—' : `${g.pct}%`,
        note: g.pct === null ? 'no clients' : `${g.green} of ${g.total} green`,
        verify: {
          summary: g.pct === null
            ? 'No current clients found.'
            : `${g.green} of ${plural(g.total, 'client')} have a green most-recent temperature: ${g.pct}%.`,
          columns: [{ label: 'Client' }, { label: 'Most recent temperature' }, { label: 'Reading date' }, { label: 'Green?' }],
          rows: g.rows.map(r => ({
            key: r.companyId,
            cells: [
              company(r.companyId, r.companyName),
              r.temperature || 'No reading',
              r.temperatureDate ? day(r.temperatureDate) : '—',
              r.green ? 'Yes' : '—',
            ],
          })),
          empty: 'No current clients found.',
        },
      })
    }
  }
  cards.push(soon('ttv-variance', 'Program Success', 'Time To Value Variance', 'Noel Miller',
    'Cobalt does not record an onboarding’s start, expected end and completion dates.'))
  {
    const base = {
      id: 'net-dollar-retention', category: 'Program Success', owner: 'Noel Miller',
      name: 'Net Dollar Retention',
      definition: 'Of the programs billing recurring revenue 12 months before the selected ' +
        'month, how much recurring revenue they generate now: expansion, contraction and churn ' +
        'included, customers won since excluded. Above 100% means the existing base grew. Higher is healthier.',
      bands: { green: '100%+', yellow: '90–100%', red: 'below 90%' },
    }
    const cell = m?.D.ndr?.byMonth[ym]
    if (!m || !m.hasRevenue) cards.push(blank(base, finNote))
    else if (!cell || cell.ndr === null) {
      cards.push(blank(base, `no ${ymLabel(addMonthsYm(ym, -12))} cohort to compare`))
    } else {
      cards.push({
        ...base,
        status: band(cell.ndr, n => n >= 100, n => n >= 90),
        value: pct1(cell.ndr),
        note: `vs ${ymLabel(cell.baseYm)} · ${plural(cell.cohortSize, 'account')}`,
        verify: {
          summary: `The ${plural(cell.cohortSize, 'program')} billing recurring in ${ymLabel(cell.baseYm)} ` +
            `(${money(cell.startMRR)}) retained ${money(cell.retainedMRR)} in ${ymLabel(ym)}: ${pct1(cell.ndr)}.`,
          columns: [{ label: 'Program' }, { label: 'Base MRR', num: true }, { label: 'This month', num: true },
            { label: 'Change', num: true }, { label: 'Status' }],
          rows: cell.rows.map(r => ({
            key: r.program,
            cells: [r.program, money(r.base), money(r.current), (r.delta > 0 ? '+' : '') + money(r.delta), cohortTag(r)],
          })),
          empty: 'No cohort accounts for this month.',
        },
      })
    }
  }
  {
    const base = {
      id: 'nps', category: 'Program Success', owner: 'Noel Miller',
      name: 'Net Promoter Score',
      definition: 'Promoters (9–10) minus detractors (0–6) as a share of everyone who answered, ' +
        'from each company’s most recent “Overall Recommendation” survey score in the last ' +
        '12 months. One score per company. Higher is healthier.',
      bands: { green: '50+', yellow: '20–49', red: 'below 20' },
    }
    if (!sc) cards.push(blank(base, scNote))
    else {
      const n = sc.nps
      cards.push({
        ...base,
        status: band(n.nps, v => v >= 50, v => v >= 20),
        value: n.nps === null ? '—' : (n.nps > 0 ? '+' : '') + n.nps,
        note: n.nps === null ? 'no survey scores in the last 12 months' : `${plural(n.n, 'company', 'companies')} answered`,
        verify: {
          summary: n.nps === null
            ? 'No company has an Overall Recommendation score in the last 12 months.'
            : `${plural(n.promoters, 'promoter')}, ${plural(n.passives, 'passive')} and ` +
              `${plural(n.detractors, 'detractor')} across ${plural(n.n, 'company', 'companies')}: ` +
              `NPS ${(n.nps > 0 ? '+' : '') + n.nps}.`,
          columns: [{ label: 'Company' }, { label: 'Score', num: true }, { label: 'Answered' }, { label: 'Counts as' }],
          rows: n.rows.map(r => ({
            key: r.companyId,
            cells: [
              company(r.companyId, r.companyName),
              `${r.overall}/10`,
              day(r.date),
              r.overall >= 9 ? 'Promoter' : r.overall >= 7 ? 'Passive' : 'Detractor',
            ],
          })),
          empty: 'No survey scores in the last 12 months.',
        },
      })
    }
  }

  // ── Sales/Marketing ────────────────────────────────────────────────────────
  {
    const base = {
      id: 'demos-30d', category: 'Sales/Marketing', owner: 'Brandon Payne',
      name: 'Demos Given (Rolling 30 Days)',
      definition: 'Every deal, on prospects and current clients alike, whose Demo Date falls in ' +
        'the last 30 days. Counts demos, not companies. The team target is 8 a month. Higher is healthier.',
      bands: { green: '7+', yellow: '4–6', red: '0–3' },
    }
    if (!sc) cards.push(blank(base, scNote))
    else {
      const d = sc.demos
      cards.push({
        ...base,
        status: band(d.count, n => n >= 7, n => n >= 4),
        value: String(d.count),
        note: 'target 8 / month',
        verify: {
          summary: `${plural(d.count, 'demo')} with a Demo Date in the last ${d.windowDays} days.`,
          columns: [{ label: 'Company' }, { label: 'Deal' }, { label: 'Owner' }, { label: 'Demo date' }, { label: 'Age', num: true }],
          rows: d.rows.map(r => ({
            key: `${r.companyId}:${r.dealId}`,
            cells: [company(r.companyId, r.companyName), r.title || '(untitled deal)', r.owner || '—', day(r.demoDate), ago(r.daysAgo)],
          })),
          empty: `No deal has a Demo Date in the last ${d.windowDays} days.`,
        },
      })
    }
  }
  {
    const base = {
      id: 'new-mrr', category: 'Sales/Marketing', owner: 'Brandon Payne',
      name: 'New MRR',
      definition: 'New recurring revenue in the selected month, from actual billing rather than ' +
        'deal records: revenue codes whose first-ever recurring charge falls in that month, so ' +
        'both new customers and upsells. Higher is healthier.',
      bands: { green: '$2,000+', yellow: '$500–$2,000', red: 'below $500' },
    }
    if (!m || !m.hasRevenue) cards.push(blank(base, finNote))
    else {
      const cell = m.D.newMrr?.byMonth[ym] ?? { total: 0, newLines: 0, lines: [] }
      cards.push({
        ...base,
        status: band(cell.total, n => n >= 2000, n => n >= 500),
        value: money(cell.total),
        note: `${plural(cell.newLines, 'new line')} in ${ymLabel(ym)}`,
        verify: {
          summary: `${money(cell.total)} of new recurring revenue in ${ymLabel(ym)} from ` +
            `${plural(cell.newLines, 'new billing line')}.`,
          columns: [{ label: 'Program' }, { label: 'Revenue code' }, { label: 'New MRR', num: true }],
          rows: cell.lines.map(l => ({ key: `${l.program}:${l.code}`, cells: [l.program, l.code, money(l.newMrr)] })),
          empty: `No new billing lines in ${ymLabel(ym)}.`,
        },
      })
    }
  }
  cards.push(soon('eccrm-signups', 'Sales/Marketing', 'New ECs Signed Up for the ECCRM', 'Brandon Payne',
    'ECCRM sign-ups are not counted in Cobalt yet.'))
  cards.push(soon('directory-claims', 'Sales/Marketing', 'Program Directory Listings Claimed', 'Brandon Payne',
    'Claimed listings live in the Program Directory, which Cobalt does not read yet.'))

  // ── Finance ────────────────────────────────────────────────────────────────
  {
    const base = {
      id: 'mrr', category: 'Finance', owner: 'Brandon Payne',
      name: 'Monthly Recurring Revenue',
      definition: 'Recurring revenue booked in the selected month. The figure is the MRR; the ' +
        'colour is its growth against the same month last year.',
      bands: { green: '3%+ YoY', yellow: '0–3% YoY', red: 'negative YoY' },
    }
    const cell = m?.D.mrr?.byMonth[ym]
    if (!m || !m.hasRevenue || !cell) cards.push(blank(base, m && m.hasRevenue ? 'no data for this month' : finNote))
    else {
      const k = m.computeKpis(ym)
      const prevYm = addMonthsYm(ym, -12)
      cards.push({
        ...base,
        status: band(k.mrrYoY, n => n >= 3, n => n >= 0),
        value: money(cell.mrr),
        note: k.mrrYoY === null ? 'no prior-year month to compare' : `${signedPct(k.mrrYoY)} YoY vs ${ymLabel(prevYm)}`,
        verify: {
          summary: `Recurring revenue for ${ymLabel(ym)} is ${money(cell.mrr)} across ` +
            `${plural(cell.activeCustomers, 'customer')}` +
            (k.mrrYoY === null ? '.' : `, ${signedPct(k.mrrYoY)} against ${ymLabel(prevYm)}.`),
          columns: [{ label: 'Customer' }, { label: 'Recurring revenue', num: true }],
          rows: cell.customers.slice().sort((a, b) => b.amount - a.amount)
            .map(c => ({ key: c.name, cells: [c.name, money(c.amount)] })),
          empty: 'No recurring revenue this month.',
        },
      })
    }
  }
  {
    const base = {
      id: 'monthly-profitability', category: 'Finance', owner: 'Brandon Payne',
      name: 'Monthly Profitability',
      definition: 'Net profit for the selected month: all revenue (recurring, professional ' +
        'services and setup) minus all expenses, which include payroll and the platform fee.',
      bands: { green: '$5,000+', yellow: '-$5,000 to $5,000', red: 'below -$5,000' },
    }
    const cell = m?.D.profitability?.byMonth[ym]
    if (!m || !m.hasRevenue || !m.hasExpenses) cards.push(blank(base, finNote || 'needs both QuickBooks exports'))
    else if (!cell || !m.hasExpenseData(ym)) cards.push(blank(base, `no expenses recorded for ${ymLabel(ym)}`))
    else {
      const margin = cell.margin === null ? '' : ` · ${pct1(cell.margin)} margin`
      cards.push({
        ...base,
        status: band(cell.net, n => n >= 5000, n => n >= -5000),
        value: money(cell.net),
        note: `${money(cell.revenue.total)} rev − ${money(cell.expenses.total)} exp${margin}`,
        verify: {
          summary: `${ymLabel(ym)}: revenue ${money(cell.revenue.total)} minus expenses ` +
            `${money(cell.expenses.total)} is net ${money(cell.net)}.`,
          columns: [{ label: 'Line' }, { label: 'Amount', num: true }],
          rows: ([
            ['Recurring revenue', cell.revenue.recurring],
            ['Professional services', cell.revenue.ps],
            ['Setup and licensing', cell.revenue.setup],
            ['Total revenue', cell.revenue.total],
            ['Total expenses (incl. payroll and platform)', cell.expenses.total],
            ['Platform fee (part of expenses)', cell.expenses.platform],
            ['Net profit', cell.net],
          ] as [string, number][]).map(([label, v]) => ({ key: label, cells: [label, money(v)] })),
          empty: '',
        },
      })
    }
  }
  cards.push(soon('avg-contribution-margin', 'Finance', 'Average Contribution Margin', 'Brandon Payne',
    'Cobalt has revenue and hours per client, but no cost per client to set against them.'))

  // ── Engineering ────────────────────────────────────────────────────────────
  cards.push(soon('sprint-completion', 'Engineering', 'Sprint Completion Percentage', 'Brandon Payne',
    'A ticket keeps one sprint number, so what a sprint committed to at its start is not stored.'))
  cards.push(soon('updates-to-prod', 'Engineering', 'Updates Pushed to Production', 'Brandon Payne',
    'Nothing in Cobalt records a publish to production.'))

  return cards
}

type Load<T> =
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; error: string; needsLogin: boolean }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

const failed = (err: unknown): Load<never> => ({
  phase: 'error',
  error: err instanceof ApiError ? err.message : String(err),
  needsLogin: err instanceof ApiError && err.needsLogin,
})

export default function Scorecard() {
  const [params, setParams] = useSearchParams()
  const [records, setRecords] = useState<Load<ScorecardData>>({ phase: 'loading' })
  const [finance, setFinance] = useState<Load<Model>>({ phase: 'loading' })

  const run = useCallback(() => {
    let live = true
    setRecords({ phase: 'loading' })
    setFinance({ phase: 'loading' })
    getScorecard()
      .then(value => { if (live) setRecords({ phase: 'ready', value }) })
      .catch(err => { if (live) setRecords(failed(err)) })
    loadFinance()
      .then(loaded => { if (live) setFinance({ phase: 'ready', value: makeModel(loaded.data, new Date()) }) })
      .catch(err => { if (live) setFinance(failed(err)) })
    return () => { live = false }
  }, [])
  useEffect(() => run(), [run])

  const sc = records.phase === 'ready' ? records.value : null
  const model = finance.phase === 'ready' ? finance.value : null

  const monthParam = params.get('month') || ''
  const ym = model ? (model.months.includes(monthParam) ? monthParam : model.defaultMonth) : ''
  const newestFirst = useMemo(() => (model ? model.months.slice().reverse() : []), [model])
  const idx = newestFirst.indexOf(ym)

  const scNote = records.phase === 'loading' ? 'loading…' : 'could not be read'
  const finNote = finance.phase === 'loading' ? 'loading…'
    : finance.phase === 'error' ? 'finance data could not be read'
      : 'needs the QuickBooks revenue export'

  const cards = useMemo(() => buildCards(sc, scNote, model, finNote, ym), [sc, scNote, model, finNote, ym])
  const categories = useMemo(() => {
    const order: string[] = []
    for (const c of cards) if (!order.includes(c.category)) order.push(c.category)
    return order
  }, [cards])

  const open = params.get('verify') || ''
  const patch = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v); else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  const needsLogin = (records.phase === 'error' && records.needsLogin) ||
    (finance.phase === 'error' && finance.needsLogin)
  const errors = [
    records.phase === 'error' ? { what: 'the client, demo and survey figures', error: records.error } : null,
    finance.phase === 'error' ? { what: 'the finance figures', error: finance.error } : null,
  ].filter((e): e is { what: string; error: string } => e !== null)

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Scorecard</h1>
          <p className="page__sub">
            The measures leadership reviews each week, each against its target, with the rows
            behind every number{sc ? `. As of ${day(sc.asOf)}.` : '.'}
          </p>
        </div>
        <Link className="btn btn--ghost btn--sm" to="/reports">All reports</Link>
      </header>

      {needsLogin ? (
        <div className="callout">
          <p className="callout__title">Your BlueStep session has ended</p>
          <p className="callout__actions"><a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a></p>
        </div>
      ) : errors.map(e => (
        <div key={e.what} className="callout">
          <p className="callout__title">Couldn’t load {e.what}</p>
          <p>{e.error}</p>
          <p className="callout__actions">
            <button type="button" className="btn" onClick={run}>Try again</button>
          </p>
        </div>
      ))}

      {model && model.months.length > 0 && (
        <div className="trep__filters frep__filters">
          <div className="ef ef--narrow">
            <label htmlFor="sc-month">Month</label>
            <div className="bweek">
              <button type="button" className="btn btn--ghost btn--sm bweek__step"
                disabled={idx < 0 || idx >= newestFirst.length - 1}
                onClick={() => patch({ month: newestFirst[idx + 1] })}
                title="The month before">‹</button>
              <select id="sc-month" className="frep__month" value={ym}
                onChange={e => patch({ month: e.target.value === model.defaultMonth ? null : e.target.value })}>
                {newestFirst.map(mo => (
                  <option key={mo} value={mo}>
                    {ymLabel(mo)}{mo === model.defaultMonth ? ' — default' : ''}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn--ghost btn--sm bweek__step"
                disabled={idx <= 0}
                onClick={() => patch({ month: newestFirst[idx - 1] })}
                title="The month after">›</button>
            </div>
          </div>
          <span className="tpage__spacer" />
          <p className="muted frep__hint">
            The month drives the revenue and profit cards. Everything else is as of today.
          </p>
        </div>
      )}

      {categories.map(cat => {
        const mine = cards.filter(c => c.category === cat)
        const shown = mine.find(c => c.id === open && c.verify)
        return (
          <section key={cat} className="sc__cat" aria-label={cat}>
            <h2 className="sc__cath">{cat}</h2>
            <div className="kpis sc__grid">
              {mine.map(c => (
                <CardView key={c.id} card={c} open={c.id === open}
                  onVerify={() => patch({ verify: c.id === open ? null : c.id })} />
              ))}
            </div>
            {shown && shown.verify && <VerifyPanel card={shown} verify={shown.verify} onClose={() => patch({ verify: null })} />}
          </section>
        )
      })}
    </section>
  )
}

function CardView({ card, open, onVerify }: { card: Card; open: boolean; onVerify: () => void }) {
  return (
    <div className="kpi sc__card" data-tone={STATUS_TONE[card.status]} data-status={card.status}>
      <p className="kpi__k">{card.name}</p>
      <p className="kpi__v">{card.value}</p>
      <p className="sc__badge"><span className="pill" data-tone={STATUS_TONE[card.status]}>{STATUS_LABEL[card.status]}</span></p>
      {card.note && <p className="kpi__n">{card.note}</p>}
      <p className="sc__foot">
        <span className="sc__owner">Owner: <strong>{card.owner}</strong></span>
        {card.verify && (
          <button type="button" className="btn btn--ghost btn--sm" aria-expanded={open}
            aria-controls={`sc-verify-${card.id}`} onClick={onVerify}>
            {open ? 'Hide' : 'Verify'}
          </button>
        )}
      </p>
    </div>
  )
}

function VerifyPanel({ card, verify, onClose }: { card: Card; verify: Verify; onClose: () => void }) {
  return (
    <section className="tcard sc__verify" id={`sc-verify-${card.id}`} aria-label={`Verify ${card.name}`}>
      <div className="frep__ph">
        <h3 className="tcard__h">{card.name}</h3>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>Close</button>
      </div>
      {card.definition && <p className="note sc__def">{card.definition}</p>}
      {card.bands && (
        <p className="sc__bands">
          <span className="pill" data-tone="good">Green {card.bands.green}</span>
          <span className="pill" data-tone="warn">Yellow {card.bands.yellow}</span>
          <span className="pill" data-tone="bad">Red {card.bands.red}</span>
        </p>
      )}
      <p className="sc__sum" data-tone={STATUS_TONE[card.status]}>{verify.summary}</p>
      {verify.rows.length === 0 ? (
        verify.empty ? <p className="muted">{verify.empty}</p> : null
      ) : (
        <div className="tablewrap frep__tall">
          <table className="fields compact frep__t">
            <thead>
              <tr>
                {verify.columns.map(col => (
                  <th key={col.label} scope="col" className={col.num ? 'num' : undefined}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {verify.rows.map(r => (
                <tr key={r.key}>
                  {r.cells.map((cell, i) => i === 0
                    ? <th key={i} scope="row">{cell}</th>
                    : <td key={i} className={verify.columns[i]?.num ? 'num' : undefined}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
