import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
 *
 * Three levels, expanded in place rather than in a drawer: client, the tickets worked
 * for that client, and the entries on each ticket. A client total is the figure you send
 * and the ticket list is the answer to the question that always follows it - "what was
 * that time?" - so they belong in one structure you can walk down, keeping the week
 * columns aligned the whole way rather than jumping to a separate table that has lost
 * them.
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

/** Minutes in one cell, split the only way this report cares about. */
interface Cell { billable: number; other: number }

/** One ticket under a client: the same weekly shape, plus the entries behind it. */
interface TicketRow {
  /** The ticket's entry id. Also the expand key, since it is unique across the org. */
  id: string
  number: number | null
  title: string
  listId: string
  weeks: Map<string, Cell>
  billable: number
  other: number
  entries: TimeEntryRow[]
}

/** One client's row: minutes per week, split by billable, plus its own totals. */
interface ClientRow {
  key: string
  name: string
  /** Keyed by the week's Monday. */
  weeks: Map<string, Cell>
  billable: number
  other: number
  /** True for the one synthetic row that holds work with no client behind it. */
  internal: boolean
  /** Biggest biller first, same rule as the clients above them. */
  tickets: TicketRow[]
}

/**
 * One week cell, at whatever level it is on.
 *
 * A component rather than three copies: client, ticket and total rows all render the
 * same figure the same way, and three copies is how the ticket rows end up rounding
 * differently from the client row above them.
 */
function Figure({ cell, showOther }: { cell?: Cell; showOther: boolean }) {
  if (!cell || (!cell.billable && !cell.other)) {
    return <td className="num"><span className="muted">·</span></td>
  }
  return (
    <td className="num">
      <span className="bcell__b">{hoursNumber(cell.billable)}</span>
      {showOther && cell.other > 0 && (
        <span className="bcell__o">+{hoursNumber(cell.other)} nb</span>
      )}
    </td>
  )
}

export default function BillableReport() {
  const { can } = useSession()
  const mayEdit = can('editTickets')

  const [params, setParams] = useSearchParams()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busyId, setBusyId] = useState('')
  /*
   * What is open, as two sets of keys.
   *
   * Local rather than in the URL, unlike the date window: a window is what you link
   * somebody to, while which rows you happened to unfold is a reading position, and
   * putting a dozen of them in the query string would make the link you send
   * unshareable-looking for no gain.
   */
  const [openClients, setOpenClients] = useState<Set<string>>(() => new Set())
  const [openTickets, setOpenTickets] = useState<Set<string>>(() => new Set())

  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  }
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
    const ticketsById = new Map<string, TicketRow>()
    // What the endpoint knows about each ticket, joined on the entry id every row carries.
    const meta = new Map(report.tickets.map(t => [t.t, t]))
    let billable = 0
    let other = 0
    let internalMinutes = 0

    const add = (cells: Map<string, Cell>, monday: string, mins: number, isBillable: boolean) => {
      let cell = cells.get(monday)
      if (!cell) { cell = { billable: 0, other: 0 }; cells.set(monday, cell) }
      if (isBillable) cell.billable += mins; else cell.other += mins
    }

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
          tickets: [],
        }
        byClient.set(key, row)
      }

      // `b` is emitted only when FALSE, which is the endpoint's terseness, not a bug.
      const isBillable = e.b === undefined
      add(row.weeks, monday, e.m, isBillable)
      if (isBillable) { row.billable += e.m; if (!internal) billable += e.m }
      else { row.other += e.m; if (!internal) other += e.m }
      if (internal) internalMinutes += e.m

      /*
       * The ticket level. Keyed on the ticket's entry id and scoped per client, so the
       * same ticket appearing under two clients - which it cannot today, but a list can
       * be re-pointed - would not merge two clients' hours into one row.
       */
      const tkey = `${key}|${e.t}`
      let ticket = ticketsById.get(tkey)
      if (!ticket) {
        const m = meta.get(e.t)
        ticket = {
          id: e.t,
          number: m?.n ?? e.tn ?? null,
          // A ticket whose title the endpoint could not read still gets a row: dropping
          // it would lose real hours from a client's total.
          title: m?.ti || '(untitled ticket)',
          listId: list.id,
          weeks: new Map(),
          billable: 0,
          other: 0,
          entries: [],
        }
        ticketsById.set(tkey, ticket)
        row.tickets.push(ticket)
      }
      add(ticket.weeks, monday, e.m, isBillable)
      if (isBillable) ticket.billable += e.m; else ticket.other += e.m
      ticket.entries.push(e)
    }

    // Biggest biller first: the rows that matter to an invoice are at the top, and
    // Internal sinks to the bottom whatever it holds, because it is never billed.
    const rows = [...byClient.values()].sort((a, b) => {
      if (a.internal !== b.internal) return a.internal ? 1 : -1
      if (b.billable !== a.billable) return b.billable - a.billable
      return a.name.localeCompare(b.name)
    })

    // Same rule one level down, and entries oldest first: a ticket's entries are a
    // story of the work, and a story runs forwards.
    for (const r of rows) {
      r.tickets.sort((a, b) => {
        if (b.billable !== a.billable) return b.billable - a.billable
        if (b.other !== a.other) return b.other - a.other
        return (b.number || 0) - (a.number || 0)
      })
      for (const t of r.tickets) {
        t.entries.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
      }
    }

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

  /*
   * The grid, as a spreadsheet.
   *
   * Client rows AND ticket rows, with a Level column, rather than clients alone. A
   * finance team asking "what was that 20 hours?" is the next question after every
   * invoice, and answering it with a second file they have to line up by hand is worse
   * than one file they can filter. Level makes both readings possible: filter to Client
   * for the summary, to Ticket for the detail.
   */
  function exportGrid() {
    if (!view || !report) return
    const head = ['Level', 'Client', 'Ticket', 'Title', ...view.weeks.map(w => `${w} (billable h)`)]
    if (!billableOnly) head.push(...view.weeks.map(w => `${w} (non-billable h)`))
    head.push('Total billable h')
    if (!billableOnly) head.push('Total non-billable h')

    const line = (
      level: string, client: string, ticket: string, title: string,
      weeks: Map<string, Cell>, billable: number, other: number,
    ): (string | number)[] => {
      const cells: (string | number)[] = [level, client, ticket, title]
      for (const w of view.weeks) cells.push(hoursNumber(weeks.get(w)?.billable || 0))
      if (!billableOnly) for (const w of view.weeks) cells.push(hoursNumber(weeks.get(w)?.other || 0))
      cells.push(hoursNumber(billable))
      if (!billableOnly) cells.push(hoursNumber(other))
      return cells
    }

    const body: (string | number)[][] = []
    for (const r of view.rows) {
      body.push(line('Client', r.name, '', '', r.weeks, r.billable, r.other))
      for (const t of r.tickets) {
        body.push(line('Ticket', r.name, t.number === null ? '' : `#${t.number}`, t.title,
          t.weeks, t.billable, t.other))
      }
    }
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
        {/* One control, two states: with a dozen clients, opening each by hand to check
            a week is the difference between using this and exporting it. */}
        <button type="button" className="btn btn--ghost btn--sm" disabled={!view}
          onClick={() => {
            if (!view) return
            if (openClients.size) { setOpenClients(new Set()); setOpenTickets(new Set()); return }
            setOpenClients(new Set(view.rows.map(r => r.key)))
          }}>
          {openClients.size ? 'Collapse all' : 'Expand all'}
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
                  {view.rows.map(r => {
                    const clientOpen = openClients.has(r.key)
                    return (
                      <Fragment key={r.key}>
                        <tr data-internal={r.internal ? '' : undefined} data-level="client">
                          <th scope="row">
                            <button type="button" className="bexp"
                              aria-expanded={clientOpen}
                              onClick={() => setOpenClients(o => toggle(o, r.key))}
                              title={clientOpen ? 'Hide the tickets' : 'Show the tickets worked'}>
                              <span className="bexp__caret" aria-hidden="true">{clientOpen ? '▾' : '▸'}</span>
                              {r.name}
                              <span className="bexp__n">
                                {r.tickets.length} ticket{r.tickets.length === 1 ? '' : 's'}
                              </span>
                            </button>
                          </th>
                          {view.weeks.map(w => <Figure key={w} cell={r.weeks.get(w)} showOther={!billableOnly} />)}
                          <td className="num">
                            <strong>{hoursNumber(r.billable)}</strong>
                            {!billableOnly && r.other > 0 && (
                              <span className="bcell__o">+{hoursNumber(r.other)} nb</span>
                            )}
                          </td>
                        </tr>

                        {clientOpen && r.tickets.map(t => {
                          const tkey = `${r.key}|${t.id}`
                          const ticketOpen = openTickets.has(tkey)
                          return (
                            <Fragment key={tkey}>
                              <tr data-level="ticket">
                                <th scope="row">
                                  <button type="button" className="bexp bexp--sub"
                                    aria-expanded={ticketOpen}
                                    onClick={() => setOpenTickets(o => toggle(o, tkey))}
                                    title={ticketOpen ? 'Hide the time entries' : 'Show every time entry'}>
                                    <span className="bexp__caret" aria-hidden="true">{ticketOpen ? '▾' : '▸'}</span>
                                    {t.number !== null && <span className="tnum">#{t.number}</span>}
                                    <span className="bexp__t">{t.title}</span>
                                    <span className="bexp__n">
                                      {t.entries.length} entr{t.entries.length === 1 ? 'y' : 'ies'}
                                    </span>
                                  </button>
                                  {/* The link is its own target, not the whole row: the row
                                      expands, and one control cannot do both. */}
                                  <Link className="inlink bexp__go" to={`/tickets/${t.number ?? t.id}`}
                                    target="_blank" rel="noopener" title="Open the ticket">open</Link>
                                </th>
                                {view.weeks.map(w => <Figure key={w} cell={t.weeks.get(w)} showOther={!billableOnly} />)}
                                <td className="num">
                                  {hoursNumber(t.billable)}
                                  {!billableOnly && t.other > 0 && (
                                    <span className="bcell__o">+{hoursNumber(t.other)} nb</span>
                                  )}
                                </td>
                              </tr>

                              {ticketOpen && t.entries.map(e => {
                                const isBillable = e.b === undefined
                                const monday = mondayOf(e.d)
                                return (
                                  <tr key={`${e.t}-${e.i}`} data-level="entry">
                                    <th scope="row">
                                      <span className="bent">
                                        <span className="bent__d">{shortDate(e.d)}</span>
                                        <span className="bent__w">
                                          {report.people[e.p]?.name || 'unattributed'}
                                        </span>
                                        <span className="bent__n">{e.n || 'no note'}</span>
                                      </span>
                                    </th>
                                    {/* The hours sit in the week they belong to, so an
                                        entry lines up under the column it is part of and
                                        you can see which week a correction will move. */}
                                    {view.weeks.map(w => (
                                      <td key={w} className="num">
                                        {w === monday
                                          ? <span className={isBillable ? undefined : 'bcell__o'}>
                                              {hoursNumber(e.m)}
                                            </span>
                                          : null}
                                      </td>
                                    ))}
                                    <td className="num">
                                      {mayEdit ? (
                                        <button
                                          type="button"
                                          className="btoggle"
                                          data-on={isBillable ? '' : undefined}
                                          disabled={busyId === e.i}
                                          onClick={() => flip(e, !isBillable)}
                                          title={isBillable
                                            ? 'Mark this entry not billable'
                                            : 'Mark this entry billable'}
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
                            </Fragment>
                          )
                        })}
                      </Fragment>
                    )
                  })}
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

          <p className="trep__foot muted">
            Generated {report.generatedAt} · {report.entries.length} entries read ·
            {' '}weeks run Monday to Sunday.
          </p>
        </>
      )}
    </section>
  )
}
