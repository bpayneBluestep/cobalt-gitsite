import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError, getFinanceData, type FinanceFile, type FinanceInputs } from '../api'
import { readSheet } from '../lib/xlsx'
import { buildFinanceData, ymLabel, type FinanceData, type SheetInput } from '../lib/finance'
import { STREAMS, makeModel, type Model, type StreamId } from './finance/compute'
import Overview from './finance/Overview'
import Revenue from './finance/Revenue'
import Retention from './finance/Retention'
import Clients from './finance/Clients'
import Expenses from './finance/Expenses'
import Profitability from './finance/Profitability'
import Actions from './finance/Actions'
import { Needs } from './finance/ui'

/*
 * The Finance report.
 *
 * A port of the old BEH Finance Dashboard (U141648 `/b/financeData` + its static SPA):
 * the same seven tabs, the same numbers, the same alert rules, drawn in Cobalt's own
 * cards, tables and charts. The numbers come from two QuickBooks exports attached to the
 * Behavioral record's Financial Data form; swapping either file is how the report
 * updates, and nothing else needs to change.
 *
 * ONE fetch, then everything in the browser. Maestro hands back the two files as bytes
 * (BsJs cannot read an .xlsx), `readSheet` turns them into rows, `buildFinanceData`
 * into the old endpoint's JSON, and `makeModel` into everything the tabs show. A month
 * or tab change re-renders; it never refetches, because the answer cannot have changed.
 *
 * The tab, month, client and stream live in the URL, like the other reports: a month
 * you are discussing is a month you want to link to, and Back should leave a client's
 * deep dive the way it leaves any page. Tab and client changes push history; the month
 * and stream replace it, so stepping through months does not bury the previous page.
 */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'retention', label: 'Retention' },
  { id: 'clients', label: 'Clients' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'profitability', label: 'Profitability' },
  { id: 'actions', label: 'Action List' },
] as const
type TabId = typeof TABS[number]['id']

type Source = 'revenue' | 'expenses'
/** A file that did not make it into the numbers, and why. */
interface Problem { source: Source; kind: 'missing' | 'unreadable'; message: string }

interface Loaded { inputs: FinanceInputs; data: FinanceData; problems: Problem[] }

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; loaded: Loaded }
  | { phase: 'error'; error: string; needsLogin?: boolean }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

const SOURCE_NAME: Record<Source, string> = { revenue: 'revenue', expenses: 'expense' }

function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Fetch, decode, parse, build. Each file fails on its own; the other still renders. */
async function load(): Promise<Loaded> {
  const inputs = await getFinanceData()
  const problems: Problem[] = []
  const read = async (source: Source, file: FinanceFile | null): Promise<SheetInput | null> => {
    if (!file) {
      problems.push({ source, kind: 'missing', message: '' })
      return null
    }
    try {
      return { rows: await readSheet(decode(file.base64), file.filename), filename: file.filename }
    } catch (e) {
      problems.push({ source, kind: 'unreadable', message: e instanceof Error ? e.message : String(e) })
      return null
    }
  }
  const [revenue, expenses] = await Promise.all([
    read('revenue', inputs.revenue),
    read('expenses', inputs.expenses),
  ])
  const data = buildFinanceData({ revenue, expenses, companies: inputs.companies })
  // The library's own complaints ("Expected 'Amount' in column 11"), for files that
  // were read but could not be understood. Missing and unreadable are already listed.
  for (const part of (data.error || '').split('; ').filter(Boolean)) {
    const source: Source = part.startsWith('expenses:') ? 'expenses' : 'revenue'
    if (problems.some(p => p.source === source)) continue
    problems.push({ source, kind: 'unreadable', message: part.replace(/^(revenue|expenses):\s*/, '') })
  }
  return { inputs, data, problems }
}

export default function FinanceReport() {
  const [params, setParams] = useSearchParams()
  const [state, setState] = useState<State>({ phase: 'loading' })

  const run = useCallback(() => {
    let live = true
    setState({ phase: 'loading' })
    load()
      .then(loaded => { if (live) setState({ phase: 'ready', loaded }) })
      .catch(err => {
        if (!live) return
        setState({
          phase: 'error',
          error: err instanceof ApiError ? err.message : String(err),
          needsLogin: err instanceof ApiError && err.needsLogin,
        })
      })
    return () => { live = false }
  }, [])
  useEffect(() => run(), [run])

  const loaded = state.phase === 'ready' ? state.loaded : null
  // Built once per load. A month change reads the same model.
  const model = useMemo(() => (loaded ? makeModel(loaded.data, new Date()) : null), [loaded])

  const tabParam = params.get('tab') || ''
  const tab: TabId = (TABS.find(t => t.id === tabParam)?.id) ?? 'overview'
  const monthParam = params.get('month') || ''
  const ym = model ? (model.months.includes(monthParam) ? monthParam : model.defaultMonth) : ''
  const streamParam = params.get('stream') as StreamId | null
  const stream: StreamId = STREAMS.some(s => s.id === streamParam) ? streamParam! : 'all'
  const client = params.get('client') || ''

  /** A search string with some params changed and the rest kept. Defaults are dropped. */
  const href = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v); else next.delete(k)
    }
    if (next.get('tab') === 'overview') next.delete('tab')
    if (next.get('stream') === 'all') next.delete('stream')
    if (next.get('tab') !== 'clients') next.delete('client')
    const s = next.toString()
    return s ? `?${s}` : ''
  }, [params])

  const replace = (patch: Record<string, string | null>) =>
    setParams(new URLSearchParams(href(patch)), { replace: true })

  const newestFirst = useMemo(() => (model ? model.months.slice().reverse() : []), [model])
  const idx = newestFirst.indexOf(ym)
  const alertCount = model && ym ? model.evaluateAlerts(ym).length : 0

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Finance</h1>
          <p className="page__sub">
            Recurring revenue, retention, spending and profit, month by month, from the
            QuickBooks exports{loaded?.inputs.orgName ? ` on the ${loaded.inputs.orgName} record` : ''}.
          </p>
        </div>
        <Link className="btn btn--ghost btn--sm" to="/reports">All reports</Link>
      </header>

      {state.phase === 'loading' && <p className="muted">Reading the QuickBooks exports…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.needsLogin ? 'Your BlueStep session has ended' : "Couldn't load the finance report"}
          </p>
          <p>{state.error}</p>
          <p className="callout__actions">
            {state.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={run}>Try again</button>}
          </p>
        </div>
      )}

      {loaded && model && (
        <>
          <Problems problems={loaded.problems} org={loaded.inputs.orgName} />

          {model.revenueStale && model.revenueThrough && (
            <p className="trep__warn trep__warn--soft">
              The revenue export runs through {ymLabel(model.revenueThrough)}. Drop a fresh
              QuickBooks export on the {loaded.inputs.orgName || 'Behavioral'} record's Financial
              Data form to bring it up to date.
            </p>
          )}

          {model.months.length === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">No months to report</p>
              <p>Neither export produced a single month of figures.</p>
            </div>
          ) : (
            <>
              <div className="trep__filters frep__filters">
                <div className="ef ef--narrow">
                  <label htmlFor="frep-month">Month</label>
                  <div className="bweek">
                    <button type="button" className="btn btn--ghost btn--sm bweek__step"
                      disabled={idx < 0 || idx >= newestFirst.length - 1}
                      onClick={() => replace({ month: newestFirst[idx + 1] })}
                      title="The month before">‹</button>
                    <select id="frep-month" className="frep__month" value={ym}
                      onChange={e => replace({ month: e.target.value })}>
                      {newestFirst.map(m => (
                        <option key={m} value={m}>
                          {ymLabel(m)}{m === model.defaultMonth ? ' — default' : ''}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="btn btn--ghost btn--sm bweek__step"
                      disabled={idx <= 0}
                      onClick={() => replace({ month: newestFirst[idx - 1] })}
                      title="The month after">›</button>
                  </div>
                </div>
                {ym !== model.defaultMonth && (
                  <button type="button" className="btn btn--ghost btn--sm"
                    onClick={() => replace({ month: null })}>
                    Back to {ymLabel(model.defaultMonth)}
                  </button>
                )}
                <span className="tpage__spacer" />
                <p className="muted frep__hint">
                  Opens three months back, the latest month QuickBooks has settled.
                </p>
              </div>

              <nav className="subnav" aria-label="Finance sections">
                {TABS.map(t => (
                  <Link key={t.id} to={{ search: href({ tab: t.id, client: null }) }}
                    className={t.id === tab ? 'active' : undefined}
                    aria-current={t.id === tab ? 'page' : undefined}>
                    {t.label}
                    {t.id === 'actions' && model.hasRevenue && alertCount > 0 && (
                      <span className="subnav__n">{alertCount}</span>
                    )}
                  </Link>
                ))}
              </nav>

              <TabBody tab={tab} m={model} ym={ym} href={href} client={client} stream={stream}
                setStream={s => replace({ stream: s })} />
            </>
          )}

          <SourceNotes loaded={loaded} m={model} />
        </>
      )}
    </section>
  )
}

function TabBody({ tab, m, ym, href, client, stream, setStream }: {
  tab: TabId
  m: Model
  ym: string
  href: (patch: Record<string, string | null>) => string
  client: string
  stream: StreamId
  setStream: (s: StreamId) => void
}) {
  const props = { m, ym, href }
  const rev = 'the revenue export'
  switch (tab) {
    case 'overview': return m.hasRevenue ? <Overview {...props} /> : <Needs what={rev} />
    case 'revenue': return m.hasRevenue ? <Revenue {...props} /> : <Needs what={rev} />
    case 'retention': return m.hasRevenue ? <Retention {...props} /> : <Needs what={rev} />
    case 'clients':
      return m.hasRevenue
        ? <Clients {...props} client={client} stream={stream} setStream={setStream} />
        : <Needs what={rev} />
    case 'expenses': return m.hasExpenses ? <Expenses {...props} /> : <Needs what="the expense export" />
    case 'profitability':
      return m.hasRevenue && m.hasExpenses ? <Profitability {...props} /> : <Needs what="both exports" />
    case 'actions': return m.hasRevenue ? <Actions {...props} /> : <Needs what={rev} />
  }
}

/** One named callout per file that is not in the numbers. */
function Problems({ problems, org }: { problems: Problem[]; org: string }) {
  if (!problems.length) return null
  const record = `the ${org || 'Behavioral'} record's Financial Data form`
  return (
    <>
      {problems.map(p => (
        <div key={p.source} className="callout">
          <p className="callout__title">
            {p.kind === 'missing'
              ? `${p.source === 'revenue' ? 'Revenue' : 'Expense'} file not attached`
              : `Couldn't read the ${SOURCE_NAME[p.source]} export`}
          </p>
          <p>
            {p.kind === 'missing'
              ? `Attach the QuickBooks ${SOURCE_NAME[p.source]} export to ${record}. `
              : `${p.message.replace(/\.$/, "")}. Re-export it from QuickBooks and replace the file on ${record}. `}
            {p.source === 'revenue'
              ? 'Until then only the Expenses tab can be drawn.'
              : 'Until then the Expenses and Profitability tabs are empty and profit figures leave out spending.'}
          </p>
        </div>
      ))}
    </>
  )
}

/** Which files the figures came from, how current they are, and what to read with care. */
function SourceNotes({ loaded, m }: { loaded: Loaded; m: Model }) {
  const meta = loaded.data.meta
  const em = meta.expenses
  const notes: string[] = []
  if (m.forwardMonths.length) {
    notes.push(`The revenue export has forward-dated rows through ${ymLabel(m.forwardMonths[m.forwardMonths.length - 1])}, likely annual prepays; read the most recent months with care.`)
  }
  if (m.earliestExpMonth && m.hasRevenue) {
    notes.push(`The expense export starts ${ymLabel(m.earliestExpMonth)}. Before then expenses, net and profit are blank rather than $0.`)
  }
  if (meta.skippedNoDate) notes.push(`${meta.skippedNoDate} revenue row${meta.skippedNoDate === 1 ? '' : 's'} had no date and ${meta.skippedNoDate === 1 ? 'is' : 'are'} not counted.`)
  if (em?.skippedNoDate) notes.push(`${em.skippedNoDate} expense rows had no date (QuickBooks group and total lines) and are not counted.`)
  notes.push('The platform intracompany fee is counted once: in total expenses, not in the category or vendor breakdowns.')

  return (
    <footer className="frep__foot">
      <h2 className="tcard__sub">Source</h2>
      <ul className="frep__src">
        {meta.source && meta.totalRows !== undefined && (
          <li>
            <strong>Revenue</strong> · {meta.source} · {meta.totalRows.toLocaleString()} rows ·{' '}
            {ymLabel(meta.earliest || '')} – {ymLabel(m.revenueThrough || meta.latest || '')}
          </li>
        )}
        {em && em.ok && (
          <li>
            <strong>Expenses</strong> · {em.source} · {em.totalRows.toLocaleString()} rows ·{' '}
            {ymLabel(em.earliest)} – {ymLabel(em.latest)}
          </li>
        )}
      </ul>
      <h2 className="tcard__sub">Data notes</h2>
      <ul className="frep__src">
        {notes.map(n => <li key={n}>{n}</li>)}
      </ul>
    </footer>
  )
}
