import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ApiError, getTimeReport, setTimeBillable,
  type TimeReport as Report, type TimeEntryRow,
} from '../api'
import { useSession } from '../session'
import {
  addDays, mondayOf, todayIso, weekLabel, shortDate,
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
 * ONE WEEK AT A TIME, defaulting to last week. Billing is a weekly errand - you sit
 * down on Monday and deal with the week that just finished - and a grid of thirteen
 * week columns made that errand harder rather than easier: the week you actually wanted
 * was one column among many, every figure had to be hunted for before it could be read,
 * and the ticket rows underneath spread their hours across columns that were empty for
 * them. With a single week the columns can say what they mean instead: billable, not
 * billable, total.
 *
 * Editable because of where the data came from. Cobalt's billable flag is ClickUp's
 * ENTRY flag as imported; in that workspace the real signal was a `billable` tag on the
 * TASK, which the import ignored. So a meaningful amount of genuinely billable work is
 * sitting here marked non-billable, and a report that could only display that would be
 * showing you a number you cannot trust and cannot fix. Every entry flips in one click.
 *
 * Three levels, expanded in place: client, the tickets worked for that client, and the
 * entries on each ticket. A client total is the figure you send and the ticket list is
 * the answer to the question that always follows it - "what was that time?" - so they
 * belong in one structure you can walk down.
 */

const INTERNAL = '__internal__'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; report: Report }
  | { phase: 'error'; error: string; needsLogin?: boolean }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/** How far back the picker offers. Two years is further back than anyone re-bills. */
const WEEKS_BACK = 104

/**
 * The week this report opens on: the last WHOLE week, not the one in progress.
 *
 * A week still running is a week whose figure will change, and the figure finance wants
 * on Monday morning is the one that has stopped moving.
 */
function lastWeek(): string {
  return addDays(mondayOf(todayIso()), -7)
}

/** Every week the picker offers, newest first, floored at the endpoint's epoch. */
function weekChoices(epoch: string | undefined, selected: string): string[] {
  const floor = epoch ? mondayOf(epoch) : ''
  const out: string[] = []
  let cursor = mondayOf(todayIso())
  for (let i = 0; i < WEEKS_BACK; i++) {
    if (floor && cursor < floor) break
    out.push(cursor)
    cursor = addDays(cursor, -7)
  }
  // A week reached by an old link, or one before the epoch, still needs an option to
  // select - otherwise the dropdown silently names a week other than the one on screen.
  if (!out.includes(selected)) out.push(selected)
  return out.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

/** "7-13 Sep", carrying the year once it is no longer the current one. */
function weekOptionLabel(monday: string, today: string): string {
  const base = weekLabel(monday)
  return monday.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${monday.slice(0, 4)}`
}

/** One ticket under a client: its own totals, plus the entries behind them. */
interface TicketRow {
  /** The ticket's entry id. Also the expand key, since it is unique across the org. */
  id: string
  number: number | null
  title: string
  listId: string
  billable: number
  other: number
  entries: TimeEntryRow[]
}

/** One client's row for the week. */
interface ClientRow {
  key: string
  name: string
  billable: number
  other: number
  /** True for the one synthetic row that holds work with no client behind it. */
  internal: boolean
  /** Biggest biller first, same rule as the clients above them. */
  tickets: TicketRow[]
}

/**
 * One figure, at whatever level it is on.
 *
 * A component rather than a dozen copies: client, ticket, entry and total rows all
 * render hours the same way, and a dozen copies is how the ticket rows end up rounding
 * differently from the client row above them.
 */
function Hours({ v, strong }: { v: number; strong?: boolean }) {
  if (!v) return <td className="num"><span className="muted">·</span></td>
  return <td className="num">{strong ? <strong>{hoursNumber(v)}</strong> : hoursNumber(v)}</td>
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
   * Local rather than in the URL, unlike the week: a week is what you link somebody to,
   * while which rows you happened to unfold is a reading position, and putting a dozen
   * of them in the query string would make the link you send unshareable-looking for no
   * gain.
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
   * The week and the billable-only switch live in the URL.
   *
   * A week you are about to send to somebody is a week you want to be able to link to,
   * and "open the report and then set it to these dates" is not a link. `from` is still
   * honoured so links made while this report showed a date range land on a real week
   * rather than silently on today's.
   */
  const week = params.get('week') || mondayOf(params.get('from') || lastWeek())
  const from = week
  const to = addDays(week, 6)
  const billableOnly = params.get('only') === '1'
  const showOther = !billableOnly

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    setParams(next, { replace: true })
  }

  const setWeek = (monday: string) => {
    const next = new URLSearchParams(params)
    next.set('week', monday)
    // Left behind, these would win on the next read of an old link.
    next.delete('from'); next.delete('to')
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

  const today = todayIso()
  const thisWeek = mondayOf(today)
  const priorWeek = lastWeek()
  const choices = useMemo(() => weekChoices(report?.epoch, week), [report?.epoch, week])
  const earliest = report ? mondayOf(report.epoch) : ''
  const prevWeek = addDays(week, -7)
  const nextWeek = addDays(week, 7)

  /*
   * The pivot.
   *
   * Grouped by CLIENT, not by list: a client with two lists gets one invoice, and
   * finance does not care that the work was split across a Client list and a Platform
   * one. The ticket rows underneath still name every ticket, so nothing is lost.
   *
   * Work on a list with no client is not dropped. It is real time somebody spent, and
   * hiding it would make this report's grand total disagree with Time Logging's for the
   * same week - a disagreement nobody would notice for a month. It gets its own row, is
   * excluded from the client totals, and is never billable by definition.
   *
   * `billableOnly` filters here rather than at render, so the totals, the KPIs and the
   * export all agree with what is on screen. The point of that switch is the moment you
   * actually send the thing, and a total that quietly included work the table was not
   * showing would be worse than no switch at all.
   */
  const view = useMemo(() => {
    if (!report) return null
    // Read off the report, not off the URL: while a new week is loading those two
    // disagree for a beat, and the table would blank on every step.
    const monday = mondayOf(report.from)
    const byClient = new Map<string, ClientRow>()
    const ticketsById = new Map<string, TicketRow>()
    // What the endpoint knows about each ticket, joined on the id every row carries.
    const meta = new Map(report.tickets.map(t => [t.t, t]))
    let billable = 0
    let other = 0
    let internalMinutes = 0
    let ticketCount = 0

    for (const e of report.entries) {
      const list = report.lists[e.l]
      if (!list) continue
      // An entry outside the week on screen would land in a total that no column
      // accounts for, which is how a grid stops adding up.
      if (mondayOf(e.d) !== monday) continue

      // `b` is emitted only when FALSE, which is the endpoint's terseness, not a bug.
      const isBillable = e.b === undefined
      if (billableOnly && !isBillable) continue

      const internal = !list.clientId
      const key = internal ? INTERNAL : list.clientId
      let row = byClient.get(key)
      if (!row) {
        row = {
          key,
          name: internal ? 'Internal (no client)' : (list.clientName || list.name),
          billable: 0,
          other: 0,
          internal,
          tickets: [],
        }
        byClient.set(key, row)
      }

      if (isBillable) { row.billable += e.m; if (!internal) billable += e.m }
      else { row.other += e.m; if (!internal) other += e.m }
      if (internal) internalMinutes += e.m

      /*
       * The ticket level, keyed per client as well as per ticket: the same ticket under
       * two clients - which it cannot be today, but a list can be re-pointed - must not
       * merge two clients' hours into one row.
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
          billable: 0,
          other: 0,
          entries: [],
        }
        ticketsById.set(tkey, ticket)
        row.tickets.push(ticket)
        ticketCount++
      }
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

    return { monday, rows, billable, other, internalMinutes, ticketCount }
  }, [report, billableOnly])

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
    const head = ['Level', 'Client', 'Ticket', 'Title', 'Billable h']
    if (showOther) head.push('Non-billable h', 'Total h')

    const line = (
      level: string, client: string, ticket: string, title: string,
      billable: number, other: number,
    ): (string | number)[] => {
      const cells: (string | number)[] = [level, client, ticket, title, hoursNumber(billable)]
      if (showOther) cells.push(hoursNumber(other), hoursNumber(billable + other))
      return cells
    }

    const body: (string | number)[][] = []
    for (const r of view.rows) {
      body.push(line('Client', r.name, '', '', r.billable, r.other))
      for (const t of r.tickets) {
        body.push(line('Ticket', r.name, t.number === null ? '' : `#${t.number}`, t.title,
          t.billable, t.other))
      }
    }
    downloadCsv(`billable-hours-week-${week}.csv`, [head, ...body])
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
    downloadCsv(`billable-entries-week-${week}.csv`, [head, ...body])
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Billable Time</h1>
          <p className="page__sub">
            Billable hours per client, one week at a time. Built to be exported and sent,
            and editable because the flag it reports on came out of ClickUp imperfect.
          </p>
        </div>
        <Link className="btn btn--ghost btn--sm" to="/reports">All reports</Link>
      </header>

      <div className="trep__filters">
        {/* Step and pick, not a date range: the week is the unit here, so the controls
            are the ones you would use on a calendar. */}
        <div className="bweek" role="group" aria-label="Week">
          <button type="button" className="btn btn--ghost btn--sm bweek__step"
            disabled={!!earliest && prevWeek < earliest}
            onClick={() => setWeek(prevWeek)}
            title="The week before">‹</button>
          <label className="visually-hidden" htmlFor="br-week">Week</label>
          <select id="br-week" className="bweek__sel" value={week}
            onChange={e => setWeek(e.target.value)}>
            {choices.map(w => (
              <option key={w} value={w}>
                {weekOptionLabel(w, today)}
                {w === priorWeek ? ' — last week' : ''}
                {w === thisWeek ? ' — this week, still running' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--ghost btn--sm bweek__step"
            disabled={nextWeek > thisWeek}
            onClick={() => setWeek(nextWeek)}
            title="The week after">›</button>
        </div>
        {week !== priorWeek && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setWeek(priorWeek)}>
            Back to last week
          </button>
        )}
        <span className="tpage__spacer" />
        <button type="button" className="btn btn--ghost btn--sm"
          onClick={() => setParam('only', billableOnly ? '' : '1')}
          title={billableOnly
            ? 'Bring non-billable work back, so it can be corrected'
            : 'Drop non-billable work entirely — the view you send'}>
          {billableOnly ? 'Show non-billable too' : 'Billable only'}
        </button>
        {/* One control, two states: with a dozen clients, opening each by hand to read
            the week is the difference between using this and exporting it. */}
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
          Cobalt's billable figures start at {report.epoch}. ClickUp's billable flag was
          not in use before then, so a figure for an earlier week would be an artifact of
          the old system rather than a fact about the work.
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
                {weekLabel(view.monday)} · across{' '}
                {view.rows.filter(r => !r.internal).length} client
                {view.rows.filter(r => !r.internal).length === 1 ? '' : 's'}
              </p>
            </div>
            {showOther && (
              <div className="kpi">
                <p className="kpi__k">Not billable</p>
                <p className="kpi__v">{hoursLabel(view.other)}</p>
                <p className="kpi__n">
                  {view.billable + view.other > 0
                    ? `${Math.round((view.other / (view.billable + view.other)) * 100)}% of client work`
                    : 'nothing logged'}
                </p>
              </div>
            )}
            <div className="kpi">
              <p className="kpi__k">Tickets</p>
              <p className="kpi__v">{view.ticketCount}</p>
              <p className="kpi__n">worked this week</p>
            </div>
            {showOther && (
              <div className="kpi">
                <p className="kpi__k">Internal</p>
                <p className="kpi__v">{hoursLabel(view.internalMinutes)}</p>
                <p className="kpi__n">no client, never billed</p>
              </div>
            )}
          </div>

          {/* Said once, near the figures, because it explains why the numbers look low
              and why the flip control exists at all. */}
          <p className="trep__warn trep__warn--soft">
            Billability came across from ClickUp's per-entry flag. In that workspace the
            real signal was usually a tag on the task, which the import did not read, so
            some of what shows as non-billable here is billable work.{' '}
            {mayEdit
              ? 'Expand a client, then a ticket, to correct an entry.'
              : 'Correcting one needs the ticket-editing role.'}
          </p>

          {view.rows.length === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">Nothing to bill for this week</p>
              <p>
                {billableOnly
                  ? `No billable time was logged in the week of ${weekLabel(view.monday)}.`
                  : `Nothing was logged in the week of ${weekLabel(view.monday)}.`}
              </p>
            </div>
          ) : (
            <div className="tablewrap">
              <table className="fields compact bgrid bgrid--week">
                <thead>
                  <tr>
                    <th scope="col">Client · ticket · entry</th>
                    <th scope="col" className="num">Billable</th>
                    {showOther && <th scope="col" className="num">Not billable</th>}
                    {showOther && <th scope="col" className="num">Total</th>}
                    {mayEdit && (
                      <th scope="col"><span className="visually-hidden">Billability</span></th>
                    )}
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
                          <Hours v={r.billable} strong />
                          {showOther && <Hours v={r.other} />}
                          {showOther && <Hours v={r.billable + r.other} strong />}
                          {mayEdit && <td />}
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
                                <Hours v={t.billable} />
                                {showOther && <Hours v={t.other} />}
                                {showOther && <Hours v={t.billable + t.other} />}
                                {mayEdit && <td />}
                              </tr>

                              {ticketOpen && t.entries.map(e => {
                                const isBillable = e.b === undefined
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
                                    {/* Which column the hours sit in IS the flag, so a
                                        correction reads as the figure moving rather than
                                        as a label changing its wording. */}
                                    <Hours v={isBillable ? e.m : 0} />
                                    {showOther && <Hours v={isBillable ? 0 : e.m} />}
                                    {showOther && <Hours v={e.m} />}
                                    {mayEdit && (
                                      <td className="num">
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
                                      </td>
                                    )}
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
                    <Hours v={view.billable} strong />
                    {showOther && <Hours v={view.other} />}
                    {showOther && <Hours v={view.billable + view.other} strong />}
                    {mayEdit && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <p className="trep__foot muted">
            Week of {weekLabel(view.monday)} ({report.from} to {report.to}) ·
            {' '}generated {report.generatedAt} · weeks run Monday to Sunday.
          </p>
        </>
      )}
    </section>
  )
}
