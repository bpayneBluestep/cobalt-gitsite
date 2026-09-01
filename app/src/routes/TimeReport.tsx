import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ApiError, getTimeReport,
  type TimeReport as Report, type TimeEntryRow,
} from '../api'
import BarRows, { type BarRow } from '../components/BarRows'
import ColumnChart, { type Column } from '../components/ColumnChart'
import HeatGrid from '../components/HeatGrid'

/*
 * The Time Logging report.
 *
 * One fetch per date range; every other control re-pivots in memory. The endpoint
 * returns the flat entry set precisely so that is possible - and so that every panel
 * below sums the same array, which is what makes the per-person, per-client and
 * per-week totals unable to disagree with the headline.
 *
 * Six panels, in the order the questions get asked: how much, over time, by whom, on
 * what, when in the day, and then every row behind it.
 */

const DAY_MS = 86400000

/** Hours, the unit everyone here talks in. Minutes only for the small print. */
function hours(minutes: number): string {
  const h = minutes / 60
  if (h === 0) return '0h'
  if (h < 1) return `${Math.round(minutes)}m`
  if (h < 10) return `${h.toFixed(1)}h`
  return `${Math.round(h)}h`
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

/*
 * Date maths on plain yyyy-mm-dd strings, anchored to UTC noon.
 *
 * Noon, not midnight: `new Date('2026-08-14')` is parsed as UTC midnight, and in any
 * timezone west of Greenwich that is the 13th locally - so a week bucket built from it
 * lands a day early for half the world and the "weeks" quietly shift. Noon has twelve
 * hours of slack in both directions, which no real offset crosses.
 */
function asDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`)
}
function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
/** The Monday of the week containing `iso`. Weeks are whole calendar weeks, Monday to
 *  Sunday, not a rolling seven days - "last week" is a thing people say about a
 *  calendar, and a rolling window cannot be compared with the one before it. */
function mondayOf(iso: string): string {
  const d = asDate(iso)
  const dow = (d.getUTCDay() + 6) % 7
  return toIso(new Date(d.getTime() - dow * DAY_MS))
}
function addDays(iso: string, n: number): string {
  return toIso(new Date(asDate(iso).getTime() + n * DAY_MS))
}
/** "14 Aug" — short enough for an axis. */
function shortDate(iso: string): string {
  const d = asDate(iso)
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`
}

/** The window the report opens on: the last 12 whole weeks, ending with this one. */
function defaultRange(): { from: string; to: string } {
  const today = toIso(new Date())
  return { from: addDays(mondayOf(today), -7 * 11), to: today }
}

const PRESETS: { label: string; weeks: number }[] = [
  { label: '4 weeks', weeks: 4 },
  { label: '12 weeks', weeks: 12 },
  { label: '26 weeks', weeks: 26 },
  { label: '52 weeks', weeks: 52 },
]

export default function TimeReport() {
  const [params, setParams] = useSearchParams()
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Filters live in the URL, so a filtered view can be linked and survives a reload -
  // the same reasoning the CRM's owner/search scope already follows.
  const from = params.get('from') || defaultRange().from
  const to = params.get('to') || defaultRange().to
  const personKey = params.get('who') || ''
  const listId = params.get('list') || ''
  const query = params.get('q') || ''
  const includeLogged = params.get('logged') === '1'

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    setParams(next, { replace: true })
  }

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    getTimeReport(from, to)
      .then(r => { if (live) { setReport(r); setLoading(false) } })
      .catch((e: unknown) => {
        if (!live) return
        setError(e instanceof ApiError ? e.message : 'Could not load the time report.')
        setLoading(false)
      })
    return () => { live = false }
  }, [from, to])

  /*
   * Everything below is derived from the one entry array. Memoised on the filters
   * rather than recomputed per panel: a 3,400-row pass is nothing, but seven of them
   * per keystroke in the text filter is enough to feel.
   */
  const view = useMemo(() => {
    if (!report) return null

    const people = report.people
    const lists = report.lists
    const needle = query.trim().toLowerCase()

    const rows = report.entries.filter(e => {
      if (personKey && people[e.p] && people[e.p].key !== personKey) return false
      if (listId && lists[e.l] && lists[e.l].id !== listId) return false
      if (needle) {
        const who = people[e.p] ? people[e.p].name : ''
        const list = lists[e.l] ? lists[e.l].name : ''
        const hay = `${e.d} ${who} ${list} ${e.tn || ''} ${e.n || ''}`.toLowerCase()
        if (hay.indexOf(needle) < 0) return false
      }
      return true
    })

    let minutes = 0
    let billable = 0
    const byPerson = new Map<number, { m: number; b: number }>()
    const byList = new Map<number, { m: number; b: number }>()
    const byWeek = new Map<string, { m: number; b: number }>()
    const byWeekday = [0, 0, 0, 0, 0, 0, 0]
    const byHour = new Array(24).fill(0)
    const heat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0))
    const clients = new Set<string>()
    let stamped = 0
    let usable = 0

    for (const e of rows) {
      const b = e.b === undefined ? e.m : 0
      minutes += e.m
      billable += b

      const p = byPerson.get(e.p) || { m: 0, b: 0 }
      p.m += e.m; p.b += b; byPerson.set(e.p, p)

      const l = byList.get(e.l) || { m: 0, b: 0 }
      l.m += e.m; l.b += b; byList.set(e.l, l)
      if (lists[e.l] && lists[e.l].clientId) clients.add(lists[e.l].clientId)

      const wk = mondayOf(e.d)
      const w = byWeek.get(wk) || { m: 0, b: 0 }
      w.m += e.m; w.b += b; byWeek.set(wk, w)

      byWeekday[(asDate(e.d).getUTCDay() + 6) % 7] += e.m

      if (e.at) {
        stamped++
        /*
         * "logged" is when somebody TYPED the entry, not when they worked, so it is
         * excluded from the shape-of-the-day panels unless explicitly asked for. A
         * heatmap that mixes the two is a heatmap of paperwork o'clock.
         */
        if (e.ak !== 'logged' || includeLogged) {
          usable++
          /*
           * Minutes are SPREAD across the hours the entry actually spans, not dumped
           * in its start hour.
           *
           * This matters more than it sounds. Measured on the real data, start-hour
           * bucketing put 427h in the 5am column - because one person habitually
           * starts at 05:51 and logs five-hour sittings, and the whole sitting was
           * credited to 5am. Spread, the same hours describe a normal working day
           * peaking 9am-1pm. Same total either way; only one of them is true.
           */
          const day = (asDate(e.d).getUTCDay() + 6) % 7
          const startH = Number(e.at.slice(11, 13))
          const startM = Number(e.at.slice(14, 16))
          let remaining = e.m
          let cursor = startH * 60 + startM
          let guard = 0
          while (remaining > 0 && guard++ < 48) {
            const hour = Math.floor(cursor / 60) % 24
            const room = 60 - (cursor % 60)
            const take = Math.min(room, remaining)
            byHour[hour] += take
            // An entry running past midnight keeps accruing on the day it was booked
            // to. Attributing the tail to the next day would move hours between days
            // and stop the panel reconciling with the rest of the report.
            heat[day][hour] += take
            remaining -= take
            cursor += take
          }
        }
      }
    }

    // Every week in the range gets a column, including the ones with nothing in them.
    const weeks: Column[] = []
    const lastMonday = mondayOf(to)
    for (let wk = mondayOf(from); wk <= lastMonday; wk = addDays(wk, 7)) {
      const hit = byWeek.get(wk) || { m: 0, b: 0 }
      weeks.push({
        key: wk,
        label: shortDate(wk),
        title: `Week of ${shortDate(wk)}`,
        value: hit.m,
        split: hit.b,
        partial: wk === lastMonday,
      })
    }

    const personRows: BarRow[] = [...byPerson.entries()].map(([i, v]) => {
      const p = people[i]
      return {
        key: p ? p.key : `#${i}`,
        label: p ? p.name : 'Unattributed',
        value: v.m,
        split: v.b,
        meta: p && !p.staff ? 'not current staff' : undefined,
        faded: p ? !p.staff : true,
      }
    })

    const listRows: BarRow[] = [...byList.entries()].map(([i, v]) => {
      const l = lists[i]
      return {
        key: l ? l.id : `#${i}`,
        label: l ? l.name : 'Unknown list',
        value: v.m,
        split: v.b,
        meta: l ? (l.clientId ? undefined : l.kind) : undefined,
      }
    })

    return {
      rows, minutes, billable,
      weeks, personRows, listRows,
      byHour, byWeekday, heat,
      clients: clients.size,
      stamped, usable,
    }
  }, [report, personKey, listId, query, includeLogged, from, to])

  const applyPreset = (weeks: number) => {
    const today = toIso(new Date())
    const next = new URLSearchParams(params)
    next.set('from', addDays(mondayOf(today), -7 * (weeks - 1)))
    next.set('to', today)
    setParams(next, { replace: true })
  }

  const person = report && personKey
    ? report.people.find(p => p.key === personKey)
    : null
  const list = report && listId
    ? report.lists.find(l => l.id === listId)
    : null
  const filtered = !!(personKey || listId || query)

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <p className="crumb"><Link to="/reports">Reports</Link></p>
          <h1>Time Logging</h1>
          <p className="page__sub">
            Where the hours go, across every client and every list.
          </p>
        </div>
      </header>

      {/* Filters in one row above the charts, so changing the question never moves the
          answer out from under the cursor. */}
      <div className="trep__filters">
        <div className="ef ef--narrow">
          <label htmlFor="tr-from">From</label>
          <input id="tr-from" type="date" value={from} min={report ? report.epoch : undefined}
            onChange={e => setParam('from', e.target.value)} />
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="tr-to">To</label>
          <input id="tr-to" type="date" value={to}
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
        <div className="ef ef--narrow">
          <label htmlFor="tr-who">Person</label>
          <select id="tr-who" value={personKey} onChange={e => setParam('who', e.target.value)}>
            <option value="">Everyone</option>
            {(report ? report.people : []).map(p => (
              <option key={p.key} value={p.key}>{p.name}{p.staff ? '' : ' (past)'}</option>
            ))}
          </select>
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="tr-list">Client or list</label>
          <select id="tr-list" value={listId} onChange={e => setParam('list', e.target.value)}>
            <option value="">All lists</option>
            {(report ? report.lists : []).slice().sort((a, b) => (a.name < b.name ? -1 : 1)).map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
      </div>

      {report && report.truncated && (
        <p className="trep__warn">
          Showing from {report.epoch}. Earlier hours exist on the tickets, but ClickUp's
          billable flag was not in use before then, so a chart reaching further back
          would show a confident zero that is an artifact rather than a fact.
        </p>
      )}

      {error && <p className="tcard tcard--bad">{error}</p>}
      {loading && <p className="muted">Reading every ticket's time log…</p>}

      {report && view && !loading && (
        <>
          {/* 1. How much. A stat row, not a chart: five single figures have no shape to
                 plot, and a hero number is the right form for a headline. */}
          <div className="kpis">
            <div className="kpi">
              <p className="kpi__k">Hours logged</p>
              <p className="kpi__v">{hours(view.minutes)}</p>
              <p className="kpi__n">{view.rows.length} entries</p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Billable</p>
              <p className="kpi__v">{hours(view.billable)}</p>
              <p className="kpi__n">{pct(view.billable, view.minutes)} of the total</p>
            </div>
            <div className="kpi">
              <p className="kpi__k">People</p>
              <p className="kpi__v">{view.personRows.length}</p>
              <p className="kpi__n">
                {view.personRows.filter(p => p.faded).length} no longer staff
              </p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Clients</p>
              <p className="kpi__v">{view.clients}</p>
              <p className="kpi__n">{view.listRows.length} lists touched</p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Per week</p>
              <p className="kpi__v">
                {hours(view.weeks.length ? view.minutes / view.weeks.length : 0)}
              </p>
              <p className="kpi__n">over {view.weeks.length} weeks</p>
            </div>
          </div>

          {filtered && (
            <p className="trep__scope">
              Filtered to
              {person && <> <strong>{person.name}</strong></>}
              {list && <> <strong>{list.name}</strong></>}
              {query && <> matching “<strong>{query}</strong>”</>}
              {' '}·{' '}
              <button type="button" className="linkbtn" onClick={() => {
                const next = new URLSearchParams(params)
                next.delete('who'); next.delete('list'); next.delete('q')
                setParams(next, { replace: true })
              }}>Clear</button>
            </p>
          )}

          {/* 2. Over time. */}
          <section className="tcard">
            <h2 className="tcard__h">Week over week</h2>
            <p className="note">
              Whole calendar weeks, Monday to Sunday. A week with nothing logged is drawn
              as an empty column rather than skipped — it is itself an answer. The last
              column is the week in progress.
            </p>
            <ColumnChart
              columns={view.weeks}
              format={hours}
              empty="No hours logged in this range."
              splitLabels={['Billable', 'Not billable']}
              labelEvery={view.weeks.length > 16 ? 2 : 1}
              height={170}
            />
          </section>

          <div className="trep__two">
            {/* 3. By whom. */}
            <section className="tcard">
              <h2 className="tcard__h">Who logged it</h2>
              <p className="note">
                One row per person, not per spelling: “Scott, Dan” and “Dan Scott” are
                the same person and count once. Anyone with no Cobalt record is marked.
              </p>
              <BarRows
                rows={view.personRows}
                format={hours}
                empty="Nobody logged time in this range."
                splitLabels={['Billable', 'Not billable']}
                onPick={key => setParam('who', key === personKey ? '' : key)}
                activeKey={personKey}
              />
            </section>

            {/* 4. On what. */}
            <section className="tcard">
              <h2 className="tcard__h">Where it landed</h2>
              <p className="note">
                By list. A client list is that client; the rest are ours — Internal,
                Product, Platform.
              </p>
              <BarRows
                rows={view.listRows}
                format={hours}
                empty="No lists received time in this range."
                splitLabels={['Billable', 'Not billable']}
                onPick={key => setParam('list', key === listId ? '' : key)}
                activeKey={listId}
              />
            </section>
          </div>

          {/* 5. When in the day. */}
          <section className="tcard">
            <h2 className="tcard__h">When the work happens</h2>
            <p className="note">
              Drawn from <strong>{view.usable}</strong> of {view.rows.length} entries — the
              ones with a real clock time, from a timer or from the ClickUp history. Each
              entry's minutes are spread across the hours it actually spans, so a
              five-hour sitting starting at 05:51 is not credited entirely to 5am.
              {report.coverage.unstamped > 0 && (
                <> {report.coverage.unstamped} entries in this window have no clock time
                  and are not in these three panels.</>
              )}
            </p>
            <p className="note">
              <label className="checkline">
                <input type="checkbox" checked={includeLogged}
                  onChange={e => setParam('logged', e.target.checked ? '1' : '')} />
                <span>
                  Also count hand-logged entries, stamped when they were typed rather
                  than when the work was done
                </span>
              </label>
            </p>

            <HeatGrid
              minutes={view.heat}
              format={hours}
              empty="No entries in this range carry a clock time."
            />

            <div className="trep__two trep__two--tight">
              <div>
                <h3 className="tcard__sub">By hour of day</h3>
                <ColumnChart
                  columns={view.byHour.map((m, h) => ({
                    key: `h${h}`,
                    label: h % 3 === 0 ? String(h).padStart(2, '0') : '',
                    title: `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`,
                    value: m,
                  }))}
                  format={hours}
                  empty="No clock times in this range."
                  height={120}
                />
              </div>
              <div>
                <h3 className="tcard__sub">By day of week</h3>
                <ColumnChart
                  columns={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => ({
                    key: d,
                    label: d,
                    title: d,
                    value: view.byWeekday[i],
                  }))}
                  format={hours}
                  empty="No hours logged in this range."
                  height={120}
                />
              </div>
            </div>
            <p className="note">
              Day of week counts every entry — it needs only the date, not a clock time.
            </p>
          </section>

          {/* 6. The rows behind all of it. This is also the report's table view: every
                 figure above is reachable as text here. */}
          <EntryTable
            report={report}
            rows={view.rows}
            minutes={view.minutes}
            query={query}
            onQuery={q => setParam('q', q)}
          />

          <p className="trep__foot muted">
            {report.totals.entries} entries between {report.from} and {report.to}, read
            from {report.totals.lists} lists. Generated {report.generatedAt.slice(0, 16).replace('T', ' ')} UTC.
          </p>
        </>
      )}
    </section>
  )
}

/**
 * Every entry in the window, as text.
 *
 * Windowed at 200 rows with an explicit "show more": mounting 3,400 table rows costs
 * about a second of layout for a list nobody scrolls to the end of, and the text filter
 * is the way people actually find a row.
 */
function EntryTable({
  report, rows, minutes, query, onQuery,
}: {
  report: Report
  rows: TimeEntryRow[]
  minutes: number
  query: string
  onQuery: (q: string) => void
}) {
  const [cap, setCap] = useState(200)
  const shown = rows.slice(0, cap)

  return (
    <section className="tcard">
      <h2 className="tcard__h">Every entry</h2>

      <div className="trep__tfilter">
        <div className="ef">
          <label htmlFor="tr-q">Filter</label>
          <input id="tr-q" type="search" value={query} placeholder="person, client, ticket number, note"
            onChange={e => onQuery(e.target.value)} />
        </div>
        <p className="trep__tsum">
          <strong>{hours(minutes)}</strong>
          <span className="muted"> across {rows.length} entries{query ? ' matching' : ''}</span>
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="muted tsec__empty">Nothing matches.</p>
      ) : (
        <>
          <div className="trep__scroll">
            <table className="fields trep__t">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Time</th>
                  <th scope="col">Person</th>
                  <th scope="col">Client / list</th>
                  <th scope="col">Ticket</th>
                  <th scope="col" className="trep__num">Hours</th>
                  <th scope="col">Billable</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => {
                  const p = report.people[e.p]
                  const l = report.lists[e.l]
                  return (
                    <tr key={`${e.t}-${e.d}-${i}`}>
                      <td>{e.d}</td>
                      <td className="trep__num">
                        {e.at
                          ? <span title={e.ak === 'logged'
                              ? 'When the entry was typed, not when the work was done'
                              : e.ak === 'timer' ? 'From a running timer' : 'From the ClickUp history'}>
                              {e.at.slice(11)}
                              {e.ak === 'logged' && <span className="muted">*</span>}
                            </span>
                          : <span className="muted">—</span>}
                      </td>
                      <td>{p ? p.name : 'Unattributed'}</td>
                      <td>{l ? l.name : '—'}</td>
                      <td>
                        {/* /tickets/<number> - the same canonical path `ticketPath`
                            builds, so a link from here is the link from anywhere. */}
                        {e.tn
                          ? <Link to={`/tickets/${e.tn}`}>#{e.tn}</Link>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="trep__num">{hours(e.m)}</td>
                      <td>{e.b === undefined
                        ? <span className="tag">billable</span>
                        : <span className="muted">no</span>}</td>
                      <td className="trep__note">{e.n || ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {rows.length > cap && (
            <button type="button" className="btn btn--ghost btn--sm trep__more"
              onClick={() => setCap(cap + 500)}>
              Show 500 more ({rows.length - cap} left)
            </button>
          )}
          <p className="note">
            A <span className="muted">*</span> on a clock time means the entry was
            hand-logged, so the time is when it was typed rather than when the work was
            done.
          </p>
        </>
      )}
    </section>
  )
}
