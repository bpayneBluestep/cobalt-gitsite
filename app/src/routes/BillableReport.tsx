import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ApiError, getTimeReport, setTimeBillable,
  type TimeReport as Report, type TimeEntryRow,
} from '../api'
import { useSession } from '../session'
import {
  addDays, mondayOf, todayIso, weeksBetween, weekLabel, shortDate,
  hoursLabel, hoursNumber,
} from '../lib/weeks'
import { downloadCsv } from '../lib/csv'

/*
 * The Billable Time report.
 *
 * Time Logging, next door, answers "where do the hours go" - it charts trends, people
 * and time of day, and billable is one split among several. This one answers a single
 * question a finance team asks every week: how many billable hours did each client get?
 * So it is a grid rather than a dashboard, it exports, and it is editable.
 *
 * Editable because of where the data came from. Cobalt's billable flag is ClickUp's
 * ENTRY flag as imported; in that workspace the real signal was a `billable` tag on the
 * TASK, which the import ignored. So a meaningful amount of genuinely billable work is
 * sitting here marked non-billable, and a report that could only display that would be
 * showing you a number you cannot trust and cannot fix. Every entry flips in one click.
 *
 * Both figures are shown for the same reason: you cannot correct what is hidden. The
 * non-billable column switches off for the moment you actually send the thing.
 */

const INTERNAL = '__internal__'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; report: Report }
  | { phase: 'error'; error: string; needsLogin?: boolean }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

const PRESETS: { label: string; weeks: number }[] = [
  { label: '4 weeks', weeks: 4 },
  { label: '8 weeks', weeks: 8 },
  { label: '13 weeks', weeks: 13 },
  { label: '26 weeks', weeks: 26 },
]

/** The window this report opens on: the last 4 whole weeks, ending today. */
function defaultRange(): { from: string; to: string } {
  const today = todayIso()
  return { from: addDays(mondayOf(today), -7 * 3), to: today }
}

/** One client's row: minutes per week, split by billable, plus its own totals. */
interface ClientRow {
  key: string
  name: string
  /** Keyed by the week's Monday. */
  weeks: Map<string, { billable: number; other: number }>
  billable: number
  other: number
  /** True for the one synthetic row that holds work with no client behind it. */
  internal: boolean
}

export default function BillableReport() {
  const { can } = useSession()
  const mayEdit = can('editTickets')

  const [params, setParams] = useSearchParams()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busyId, setBusyId] = useState('')
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')

  /*
   * The window and the two view switches live in the URL.
   *
   * A week you are about to send to somebody is a week you want to be able to link to,
   * and "open the report and then set it to these dates" is not a link. Same reasoning
   * the CRM scope and Time Logging already follow.
   */
  const fallback = defaultRange()
  const from = params.get('from') || fallback.from
  const to = params.get('to') || fallback.to
  const billableOnly = params.get('only') === '1'
  const openCell = params.get('cell') || ''

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    setParams(next, { replace: true })
  }

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getTimeReport(from, to)
      .then(report => setState({ phase: 'ready', report }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err.message : String(err),
        needsLogin: err instanceof ApiError && err.needsLogin,
      }))
  }, [from, to])

  useEffect(() => { load() }, [load])

  const report = state.phase === 'ready' ? state.report : null

  const applyPreset = (weeks: number) => {
    const today = todayIso()
    const next = new URLSearchParams(params)
    next.set('from', addDays(mondayOf(today), -7 * (weeks - 1)))
    next.set('to', today)
    setParams(next, { replace: true })
  }

  /*
   * The pivot.
   *
   * Grouped by CLIENT, not by list: a client with two lists gets one invoice, and
   * finance does not care that the work was split across a Client list and a Platform
   * one. The entry drawer still names the ticket, so nothing is lost by rolling up.
   *
   * Work on a list with no client is not dropped. It is real time somebody spent, and
   * hiding it would make this report's grand total disagree with Time Logging's for the
   * same window - a disagreement nobody would notice for a month. It gets its own row,
   * is excluded from the client totals, and is never billable by definition.
   */
  const view = useMemo(() => {
    if (!report) return null
    const weeks = weeksBetween(report.from, report.to)
    const weekSet = new Set(weeks)
    const byClient = new Map<string, ClientRow>()
    let billable = 0
    let other = 0
    let internalMinutes = 0

    for (const e of report.entries) {
      const list = report.lists[e.l]
      if (!list) continue
      const monday = mondayOf(e.d)
      // An entry outside the rendered columns would be counted in a total that no column
      // accounts for, which is how a grid stops adding up.
      if (!weekSet.has(monday)) continue

      const internal = !list.clientId
      const key = internal ? INTERNAL : list.clientId
      let row = byClient.get(key)
      if (!row) {
        row = {
          key,
          name: internal ? 'Internal (no client)' : (list.clientName || list.name),
          weeks: new Map(),
          billable: 0,
          other: 0,
          internal,
        }
        byClient.set(key, row)
      }

      let cell = row.weeks.get(monday)
      if (!cell) { cell = { billable: 0, other: 0 }; row.weeks.set(monday, cell) }

      // `b` is emitted only when FALSE, which is the endpoint's terseness, not a bug.
      const isBillable = e.b === undefined
      if (isBillable) { cell.billable += e.m; row.billable += e.m; if (!internal) billable += e.m }
      else { cell.other += e.m; row.other += e.m; if (!internal) other += e.m }
      if (internal) internalMinutes += e.m
    }

    // Biggest biller first: the rows that matter to an invoice are at the top, and
    // Internal sinks to the bottom whatever it holds, because it is never billed.
    const rows = [...byClient.values()].sort((a, b) => {
      if (a.internal !== b.internal) return a.internal ? 1 : -1
      if (b.billable !== a.billable) return b.billable - a.billable
      return a.name.localeCompare(b.name)
    })

    const weekTotals = weeks.map(w => {
      let b = 0, o = 0
      for (const r of rows) {
        if (r.internal) continue
        const c = r.weeks.get(w)
        if (c) { b += c.billable; o += c.other }
      }
      return { week: w, billable: b, other: o }
    })

    return { weeks, rows, billable, other, internalMinutes, weekTotals }
  }, [report])

  /** The entries behind one cell, for the drawer. Recomputed so a flip re-reads it. */
  const cellEntries = useMemo((): { rows: TimeEntryRow[]; label: string } | null => {
    if (!report || !openCell) return null
    const [clientKey, monday] = openCell.split('|')
    if (!clientKey || !monday) return null
    const rows = report.entries.filter(e => {
      const list = report.lists[e.l]
      if (!list) return false
      const key = list.clientId || INTERNAL
      return key === clientKey && mondayOf(e.d) === monday
    })
    const name = clientKey === INTERNAL
      ? 'Internal (no client)'
      : (report.lists.find(l => l.clientId === clientKey)?.clientName || 'Client')
    return { rows: rows.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)), label: `${name}, ${weekLabel(monday)}` }
  }, [report, openCell])

  /*
   * Flip one entry, in place.
   *
   * The whole report is patched locally rather than refetched: `timeReport` walks every
   * list and every ticket's time log, which is seconds, and putting that between you and
   * the next correction would make fixing a run of mis-flagged entries unbearable. The
   * endpoint returns the re-read ticket, so a refusal is a refusal - this is optimistic
   * about latency, not about whether the write happened.
   */
  async function flip(row: TimeEntryRow, toBillable: boolean) {
    if (!report || !mayEdit || busyId) return
    const list = report.lists[row.l]
    if (!list) return
    setBusyId(row.i); setFailure(''); setNotice('')
    try {
      await setTimeBillable({ listId: list.id, entryId: row.t }, row.i, toBillable)
      setState(s => (s.phase === 'ready' ? {
        phase: 'ready',
        report: {
          ...s.report,
          entries: s.report.entries.map(e => {
            if (e.i !== row.i || e.t !== row.t) return e
            const next = { ...e }
            if (toBillable) delete next.b; else next.b = 0
            return next
          }),
        },
      } : s))
      setNotice(`#${row.tn ?? '—'} · ${hoursLabel(row.m)} is now ${toBillable ? 'billable' : 'not billable'}.`)
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusyId('')
    }
  }

  function exportGrid() {
    if (!view || !report) return
    const head = ['Client', ...view.weeks.map(w => `${w} (billable h)`)]
    if (!billableOnly) head.push(...view.weeks.map(w => `${w} (non-billable h)`))
    head.push('Total billable h')
    if (!billableOnly) head.push('Total non-billable h')

    const body = view.rows.map(r => {
      const cells: (string | number)[] = [r.name]
      for (const w of view.weeks) cells.push(hoursNumber(r.weeks.get(w)?.billable || 0))
      if (!billableOnly) for (const w of view.weeks) cells.push(hoursNumber(r.weeks.get(w)?.other || 0))
      cells.push(hoursNumber(r.billable))
      if (!billableOnly) cells.push(hoursNumber(r.other))
      return cells
    })
    downloadCsv(`billable-hours-${report.from}-to-${report.to}.csv`, [head, ...body])
  }

  function exportEntries() {
    if (!report) return
    const head = ['Date', 'Week starting', 'Client', 'List', 'Ticket', 'Title or note', 'Person', 'Hours', 'Billable']
    const body = report.entries
      .slice()
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
      .map(e => {
        const list = report.lists[e.l]
        const person = report.people[e.p]
        return [
          e.d,
          mondayOf(e.d),
          list?.clientName || '',
          list?.name || '',
          e.tn ? `#${e.tn}` : '',
          e.n || '',
          person?.name || '',
          hoursNumber(e.m),
          e.b === undefined ? 'yes' : 'no',
        ]
      })
    downloadCsv(`billable-entries-${report.from}-to-${report.to}.csv`, [head, ...body])
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Billable Time</h1>
          <p className="page__sub">
            Billable hours per client, week by week. Built to be exported and sent, and
            editable because the flag it reports on came out of ClickUp imperfect.
          </p>
        </div>
        <Link className="btn btn--ghost btn--sm" to="/reports">All reports</Link>
      </header>

      <div className="trep__filters">
        <div className="ef ef--narrow">
          <label htmlFor="br-from">From</label>
          <input id="br-from" type="date" value={from} min={report ? report.epoch : undefined}
            onChange={e => setParam('from', e.target.value)} />
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="br-to">To</label>
          <input id="br-to" type="date" value={to}
            onChange={e => setParam('to', e.target.value)} />
        </div>
        <div className="trep__presets" role="group" aria-label="Range presets">
          {PRESETS.map(p => (
            <button key={p.label} type="button" className="btn btn--ghost btn--sm"
              onClick={() => applyPreset(p.weeks)}>
              {p.label}
            </button>
          ))}
        </div>
        <span className="tpage__spacer" />
        <button type="button" className="btn btn--ghost btn--sm"
          onClick={() => setParam('only', billableOnly ? '' : '1')}>
          {billableOnly ? 'Show non-billable too' : 'Billable only'}
        </button>
        <button type="button" className="btn btn--sm" disabled={!view} onClick={exportGrid}>
          Export grid
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={!report} onClick={exportEntries}>
          Export entries
        </button>
      </div>

      {report && report.truncated && (
        <p className="trep__warn">
          Showing from {report.epoch}. Earlier hours are on the tickets, but ClickUp's
          billable flag was not in use before then, so billable figures reaching further
          back would be an artifact of the old system rather than a fact about the work.
        </p>
      )}

      {notice && <p className="board2__notice" role="status">{notice}</p>}
      {failure && (
        <p className="board2__failure" role="alert">
          {failure}
          <button type="button" className="board2__failure-x" onClick={() => setFailure('')}
            aria-label="Dismiss">×</button>
        </p>
      )}

      {state.phase === 'loading' && <p className="muted">Reading every ticket's time log…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.needsLogin ? 'Sign in required' : 'Could not load the report'}
          </p>
          <p>{state.error}</p>
          <p className="callout__actions">
            {state.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
          </p>
        </div>
      )}

      {report && view && (
        <>
          <div className="kpis">
            <div className="kpi">
              <p className="kpi__k">Billable</p>
              <p className="kpi__v">{hoursLabel(view.billable)}</p>
              <p className="kpi__n">
                across {view.rows.filter(r => !r.internal).length} client
                {view.rows.filter(r => !r.internal).length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Not billable</p>
              <p className="kpi__v">{hoursLabel(view.other)}</p>
              <p className="kpi__n">
                {view.billable + view.other > 0
                  ? `${Math.round((view.other / (view.billable + view.other)) * 100)}% of client work`
                  : 'nothing logged'}
              </p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Per week</p>
              <p className="kpi__v">
                {hoursLabel(view.weeks.length ? view.billable / view.weeks.length : 0)}
              </p>
              <p className="kpi__n">billable, over {view.weeks.length} weeks</p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Internal</p>
              <p className="kpi__v">{hoursLabel(view.internalMinutes)}</p>
              <p className="kpi__n">no client, never billed</p>
            </div>
          </div>

          {/* Said once, near the figures, because it explains why the numbers look low
              and why the flip control exists at all. */}
          <p className="trep__warn trep__warn--soft">
            Billability came across from ClickUp's per-entry flag. In that workspace the
            real signal was usually a tag on the task, which the import did not read, so
            some of what shows as non-billable here is billable work.{' '}
            {mayEdit
              ? 'Open a cell to correct an entry.'
              : 'Correcting one needs the ticket-editing role.'}
          </p>

          {view.rows.length === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">No time logged in this window</p>
              <p>Nothing was logged between {shortDate(report.from)} and {shortDate(report.to)}.</p>
            </div>
          ) : (
            <div className="tablewrap">
              <table className="fields compact bgrid">
                <thead>
                  <tr>
                    <th scope="col">Client</th>
                    {view.weeks.map(w => (
                      <th key={w} scope="col" className="num" title={`Week starting ${w}`}>
                        {weekLabel(w)}
                      </th>
                    ))}
                    <th scope="col" className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map(r => (
                    <tr key={r.key} data-internal={r.internal ? '' : undefined}>
                      <th scope="row">{r.name}</th>
                      {view.weeks.map(w => {
                        const c = r.weeks.get(w)
                        const id = `${r.key}|${w}`
                        const empty = !c || (!c.billable && !c.other)
                        return (
                          <td key={w} className="num">
                            {empty ? <span className="muted">·</span> : (
                              <button type="button" className="bcell"
                                data-open={openCell === id ? '' : undefined}
                                onClick={() => setParam('cell', openCell === id ? '' : id)}
                                title="Show the entries behind this figure">
                                <span className="bcell__b">{hoursNumber(c!.billable)}</span>
                                {!billableOnly && c!.other > 0 && (
                                  <span className="bcell__o">+{hoursNumber(c!.other)} nb</span>
                                )}
                              </button>
                            )}
                          </td>
                        )
                      })}
                      <td className="num">
                        <strong>{hoursNumber(r.billable)}</strong>
                        {!billableOnly && r.other > 0 && (
                          <span className="bcell__o">+{hoursNumber(r.other)} nb</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">All clients</th>
                    {view.weekTotals.map(t => (
                      <td key={t.week} className="num">
                        <strong>{hoursNumber(t.billable)}</strong>
                        {!billableOnly && t.other > 0 && (
                          <span className="bcell__o">+{hoursNumber(t.other)} nb</span>
                        )}
                      </td>
                    ))}
                    <td className="num">
                      <strong>{hoursNumber(view.billable)}</strong>
                      {!billableOnly && view.other > 0 && (
                        <span className="bcell__o">+{hoursNumber(view.other)} nb</span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {cellEntries && (
            <section className="tcard bdrawer">
              <div className="tcard__head">
                <h2>{cellEntries.label}</h2>
                <p className="note">
                  {cellEntries.rows.length} entr{cellEntries.rows.length === 1 ? 'y' : 'ies'}
                  {mayEdit ? ' · click Billable to change it' : ''}
                </p>
                <button type="button" className="linkbtn" onClick={() => setParam('cell', '')}>
                  Close
                </button>
              </div>
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Ticket</th>
                      <th scope="col">Person</th>
                      <th scope="col">Note</th>
                      <th scope="col" className="num">Hours</th>
                      <th scope="col">Billable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cellEntries.rows.map(e => {
                      const isBillable = e.b === undefined
                      return (
                        <tr key={`${e.t}-${e.i}`}>
                          <td>{shortDate(e.d)}</td>
                          <td>
                            {/* The number where there is one, the entry id otherwise:
                                the same two-way route the ticket page already answers on.
                                Not `ticketPath`, which wants a whole Ticket. */}
                            <Link className="tnum tnum--link" to={`/tickets/${e.tn ?? e.t}`}
                              target="_blank" rel="noopener">
                              {e.tn ? `#${e.tn}` : 'open'}
                            </Link>
                          </td>
                          <td>{report.people[e.p]?.name || <span className="muted">unattributed</span>}</td>
                          <td>{e.n || <span className="muted">no note</span>}</td>
                          <td className="num">{hoursNumber(e.m)}</td>
                          <td>
                            {mayEdit ? (
                              <button
                                type="button"
                                className="btoggle"
                                data-on={isBillable ? '' : undefined}
                                disabled={busyId === e.i}
                                onClick={() => flip(e, !isBillable)}
                                title={isBillable ? 'Mark this entry not billable' : 'Mark this entry billable'}
                              >
                                {busyId === e.i ? 'saving…' : isBillable ? 'billable' : 'not billable'}
                              </button>
                            ) : (
                              <span className={isBillable ? 'tag' : 'muted'}>
                                {isBillable ? 'billable' : 'not billable'}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="trep__foot muted">
            Generated {report.generatedAt} · {report.entries.length} entries read ·
            {' '}weeks run Monday to Sunday.
          </p>
        </>
      )}
    </section>
  )
}
