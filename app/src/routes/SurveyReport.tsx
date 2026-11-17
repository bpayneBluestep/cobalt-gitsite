import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ApiError, getCsQueue, getSurveys, npsTone, quarterOf, recentQuarters, SURVEY_DIMENSIONS,
  type CsRow, type SurveyInvite, type SurveyList, type SurveyResponse,
} from '../api'
import ColumnChart from '../components/ColumnChart'
import TrendChart, { type TrendPoint, type TrendSeries } from '../components/TrendChart'
import { downloadCsv } from '../lib/csv'
import { useSession } from '../session'

/*
 * The Client Surveys report.
 *
 * Three questions, in the order they get asked: how are we doing, are we getting better,
 * and who is unhappy with us. Two fetches (every response and survey log, and the Client
 * Success queue for who owns each client); every control re-pivots in memory, so each
 * panel is summing the same filtered set and none of them can disagree with the headline.
 *
 * Every figure carries its n. A quarter with three answers still draws a point, and the
 * count beside it is what says how much weight that point can bear.
 */

type DimKey = typeof SURVEY_DIMENSIONS[number]['key']
type Question = DimKey | 'all'
type Metric = 'nps' | 'avg'
type Grain = 'month' | 'quarter'

const DIMS: DimKey[] = SURVEY_DIMENSIONS.map(d => d.key)
const DETRACTOR_MAX = 6
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

interface Meta { owner: string; intensity: string; health: string; name: string }

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function day(s: string | undefined | null): string { return (s || '').slice(0, 10) }

function scoresOf(r: SurveyResponse, q: Question): number[] {
  const keys = q === 'all' ? DIMS : [q]
  const out: number[] = []
  for (const k of keys) {
    const v = r[k]
    if (v !== null && v !== undefined) out.push(v)
  }
  return out
}

function nps(scores: number[]): number | null {
  if (!scores.length) return null
  let pro = 0
  let det = 0
  for (const s of scores) {
    if (s >= 9) pro++
    else if (s <= DETRACTOR_MAX) det++
  }
  return Math.round(((pro - det) / scores.length) * 100)
}

function avg(scores: number[]): number | null {
  if (!scores.length) return null
  return scores.reduce((n, s) => n + s, 0) / scores.length
}

function signed(n: number): string { return `${n > 0 ? '+' : ''}${n}` }
function one(n: number): string { return n.toFixed(1) }
function pctOf(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 100) : null
}

/** The window a period names, and the equal window just before it. Null means all time. */
function windowOf(p: string): { from: string; to: string; prior: { from: string; to: string } } | null {
  const q = /^(\d{4})-Q([1-4])$/.exec(p)
  if (q) {
    const y = Number(q[1])
    const n = Number(q[2])
    const start = new Date(y, (n - 1) * 3, 1)
    const end = new Date(y, n * 3, 0)
    return {
      from: iso(start), to: iso(end),
      prior: { from: iso(new Date(y, (n - 2) * 3, 1)), to: iso(new Date(y, (n - 1) * 3, 0)) },
    }
  }
  const m = /^(\d+)m$/.exec(p)
  if (m) {
    const months = Number(m[1])
    const today = new Date()
    const start = new Date(today.getFullYear(), today.getMonth() - months, today.getDate() + 1)
    const priorEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1)
    const priorStart = new Date(priorEnd.getFullYear(), priorEnd.getMonth() - months, priorEnd.getDate() + 1)
    return { from: iso(start), to: iso(today), prior: { from: iso(priorStart), to: iso(priorEnd) } }
  }
  return null
}

function within(d: string, w: { from: string; to: string } | null): boolean {
  if (!w) return true
  return !!d && d >= w.from && d <= w.to
}

function bucketOf(d: string, grain: Grain): string {
  const y = d.slice(0, 4)
  const m = Number(d.slice(5, 7))
  return grain === 'month' ? `${y}-${d.slice(5, 7)}` : `${y}-Q${Math.floor((m - 1) / 3) + 1}`
}

/** Every bucket from `first` to `last` inclusive, so a quiet month is a gap and not a jump. */
function bucketsBetween(first: string, last: string, grain: Grain): TrendPoint[] {
  const out: TrendPoint[] = []
  let y = Number(first.slice(0, 4))
  let m = Number(first.slice(5, 7))
  if (grain === 'quarter') m = Math.floor((m - 1) / 3) * 3 + 1
  const step = grain === 'month' ? 1 : 3
  const lastKey = bucketOf(last, grain)
  for (let guard = 0; guard < 240; guard++) {
    const key = bucketOf(`${y}-${String(m).padStart(2, '0')}-01`, grain)
    out.push(grain === 'month'
      ? { key, label: `${MONTHS[m - 1]} ${String(y).slice(2)}`, title: `${MONTHS[m - 1]} ${y}` }
      : { key, label: `Q${Math.floor((m - 1) / 3) + 1} ${String(y).slice(2)}`, title: `Q${Math.floor((m - 1) / 3) + 1} ${y}` })
    if (key === lastKey) break
    m += step
    if (m > 12) { m -= 12; y += 1 }
  }
  return out
}

function Score({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="muted">-</span>
  const tone = value >= 9 ? 'good' : value > DETRACTOR_MAX ? 'warn' : 'bad'
  return <span className="pill" data-tone={tone}>{value}</span>
}

function Kpi({ label, value, note, tone }: {
  label: string; value: string; note?: string; tone?: 'good' | 'warn' | 'bad'
}) {
  return (
    <div className="kpi" data-tone={tone}>
      <p className="kpi__k">{label}</p>
      <p className="kpi__v">{value}</p>
      {note && <p className="kpi__n">{note}</p>}
    </div>
  )
}

interface GroupRow {
  key: string
  clients: number
  sent: number
  answered: number
  scores: number[]
}

export default function SurveyReport() {
  const { can } = useSession()
  const [params, setParams] = useSearchParams()
  const [surveys, setSurveys] = useState<SurveyList | null>(null)
  const [queue, setQueue] = useState<CsRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [openRow, setOpenRow] = useState('')
  const [showAllClients, setShowAllClients] = useState(false)

  // Filters live in the URL, so a filtered view can be linked and survives a reload.
  const period = params.get('p') || 'all'
  const grain: Grain = params.get('by') === 'quarter' ? 'quarter' : 'month'
  const metric: Metric = params.get('m') === 'avg' ? 'avg' : 'nps'
  const qParam = params.get('q') || 'overall'
  const question: Question = qParam === 'all' || (DIMS as string[]).includes(qParam) ? qParam as Question : 'overall'
  const owner = params.get('owner') || ''
  const intensity = params.get('level') || ''
  const health = params.get('health') || ''
  const client = params.get('client') || ''
  const former = params.get('former') === '1'

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const load = () => {
    setLoading(true)
    setError(null)
    // The queue is what names each client's owner. If it fails the report still stands;
    // the owner, support level and health slicers just have nothing to offer.
    Promise.all([getSurveys(), getCsQueue().then(q => q.rows || []).catch(() => [] as CsRow[])])
      .then(([s, q]) => { setSurveys(s); setQueue(q) })
      .catch(err => setError(err instanceof ApiError ? err : new ApiError(String(err))))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const quarters = useMemo(() => recentQuarters(quarterOf(), 8), [])

  const meta = useMemo(() => {
    const m: Record<string, Meta> = {}
    for (const r of queue) {
      m[r.companyId] = {
        owner: r.owner || 'No owner', intensity: r.supportIntensity || 'Not set',
        health: r.health, name: r.companyName,
      }
    }
    return m
  }, [queue])

  const owners = useMemo(() => Array.from(new Set(Object.values(meta).map(m => m.owner))).sort(), [meta])
  const intensities = useMemo(() => Array.from(new Set(Object.values(meta).map(m => m.intensity))).sort(), [meta])

  const view = useMemo(() => {
    if (!surveys) return null
    const win = windowOf(period)

    // A company the queue does not know is not a current client: a former client, or a
    // test record. Left out unless asked for, and never matched by a slicer it has no
    // value for.
    const inScope = (companyId: string | undefined): boolean => {
      const id = companyId || ''
      if (client && id !== client) return false
      const m = meta[id]
      if (!m) return former && !owner && !intensity && !health
      if (owner && m.owner !== owner) return false
      if (intensity && m.intensity !== intensity) return false
      if (health && m.health !== health) return false
      return true
    }

    const scopedResponses = surveys.rows.filter(r => inScope(r.companyId))
    const scopedInvites = surveys.invites.filter(i => i.sentAt && inScope(i.companyId))
    const answeredIds = new Set(surveys.rows.map(r => r.inviteId).filter(Boolean))
    const isAnswered = (i: SurveyInvite) => answeredIds.has(i.entryId) || i.status === 'Completed'
    const isOpen = (i: SurveyInvite) => !isAnswered(i) && (i.status === 'Sent' || i.status === 'Reminded')

    const responses = scopedResponses.filter(r => within(day(r.submittedAt), win))
    const invites = scopedInvites.filter(i => within(day(i.sentAt), win))
    const prior = win ? scopedResponses.filter(r => within(day(r.submittedAt), win.prior)) : []

    const pool = (rows: SurveyResponse[], q: Question) => rows.flatMap(r => scoresOf(r, q))
    const scores = pool(responses, question)
    const priorScores = pool(prior, question)

    const sent = invites.length
    const answered = invites.filter(isAnswered).length
    const stillOpen = invites.filter(isOpen).length

    // Clients in scope, for "how many have we heard from".
    const scopeClients = Object.keys(meta).filter(id => inScope(id))
    const heardFrom = new Set(responses.map(r => r.companyId || ''))

    // Per question.
    const perDim = SURVEY_DIMENSIONS.map(d => {
      const s = pool(responses, d.key)
      return {
        key: d.key, label: d.label, n: s.length, nps: nps(s), avg: avg(s),
        promoters: s.filter(v => v >= 9).length,
        passives: s.filter(v => v > DETRACTOR_MAX && v < 9).length,
        detractors: s.filter(v => v <= DETRACTOR_MAX).length,
      }
    })

    const distribution = Array.from({ length: 11 }, (_, v) => scores.filter(s => s === v).length)

    // Over time.
    const today = iso(new Date())
    const dates = [...responses.map(r => day(r.submittedAt)), ...invites.map(i => day(i.sentAt))].filter(Boolean).sort()
    const first = win ? win.from : dates[0]
    const last = win ? (win.to < today ? win.to : today) : today
    const points = first ? bucketsBetween(first, last, grain) : []
    const byBucket = (rows: SurveyResponse[]) => {
      const m: Record<string, SurveyResponse[]> = {}
      for (const r of rows) (m[bucketOf(day(r.submittedAt), grain)] ||= []).push(r)
      return m
    }
    const rb = byBucket(responses)
    const scoreSeries: TrendSeries[] = SURVEY_DIMENSIONS.map(d => ({
      key: d.key, name: d.label, kind: 'line',
      values: points.map(p => {
        const s = pool(rb[p.key] || [], d.key)
        return metric === 'nps' ? nps(s) : avg(s)
      }),
    }))
    const ib: Record<string, SurveyInvite[]> = {}
    for (const i of invites) (ib[bucketOf(day(i.sentAt), grain)] ||= []).push(i)
    const count = (key: string, test: (i: SurveyInvite) => boolean) => (ib[key] || []).filter(test).length
    const sendSeries: TrendSeries[] = [
      { key: 'answered', name: 'Answered', kind: 'bar', color: 'var(--good, #5AA33C)', values: points.map(p => count(p.key, isAnswered)) },
      { key: 'open', name: 'Still open', kind: 'bar', color: '#7C89A6', values: points.map(p => count(p.key, isOpen)) },
      { key: 'none', name: 'No answer', kind: 'bar', color: '#ce4a5b', values: points.map(p => count(p.key, i => !isAnswered(i) && !isOpen(i))) },
      {
        key: 'rate', name: 'Response rate', kind: 'line', axis: 'right', color: '#3B72E8',
        values: points.map(p => {
          const all = ib[p.key] || []
          return all.length ? Math.round((all.filter(isAnswered).length / all.length) * 100) : null
        }),
      },
    ]

    // Per client: the latest answer in view, and the one before it at any time.
    const history: Record<string, SurveyResponse[]> = {}
    for (const r of scopedResponses) (history[r.companyId || ''] ||= []).push(r)
    for (const id in history) history[id].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))
    const latestIn: Record<string, SurveyResponse> = {}
    for (const r of responses) {
      const id = r.companyId || ''
      if (!latestIn[id] || r.submittedAt > latestIn[id].submittedAt) latestIn[id] = r
    }
    const clients = Object.keys(latestIn).map(id => {
      const r = latestIn[id]
      const all = scoresOf(r, 'all')
      const before = (history[id] || []).find(h => h.submittedAt < r.submittedAt)
      const a = avg(all)
      const b = before ? avg(scoresOf(before, 'all')) : null
      return {
        id, name: r.companyName || (meta[id] ? meta[id].name : 'Unknown'),
        owner: meta[id] ? meta[id].owner : '', response: r,
        lowest: all.length ? Math.min(...all) : null, average: a,
        change: a !== null && b !== null ? a - b : null,
        answers: (history[id] || []).length,
      }
    }).sort((x, y) =>
      (x.lowest ?? 11) - (y.lowest ?? 11) || (x.average ?? 11) - (y.average ?? 11) || (x.name < y.name ? -1 : 1))
    const detractors = clients.filter(c => c.lowest !== null && c.lowest <= DETRACTOR_MAX).length

    // Asked and never answered, in this view.
    const asked: Record<string, SurveyInvite[]> = {}
    for (const i of invites) (asked[i.companyId || ''] ||= []).push(i)
    const silent = Object.keys(asked)
      .filter(id => !asked[id].some(isAnswered))
      .map(id => {
        const list = asked[id].slice().sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))
        return {
          id, name: list[0].companyName || (meta[id] ? meta[id].name : 'Unknown'),
          owner: meta[id] ? meta[id].owner : '', times: list.length,
          lastSent: day(list[0].sentAt), waiting: isOpen(list[0]),
        }
      })
      .sort((a, b) => Number(a.waiting) - Number(b.waiting) || (a.lastSent < b.lastSent ? -1 : 1))

    // Slices by who owns the client and how much support they get.
    const groupBy = (pick: (m: Meta) => string): GroupRow[] => {
      const g: Record<string, GroupRow> = {}
      const row = (k: string) => (g[k] ||= { key: k, clients: 0, sent: 0, answered: 0, scores: [] })
      for (const id of scopeClients) row(pick(meta[id])).clients++
      for (const i of invites) {
        const m = meta[i.companyId || '']
        if (!m) continue
        const r = row(pick(m))
        r.sent++
        if (isAnswered(i)) r.answered++
      }
      for (const r of responses) {
        const m = meta[r.companyId || '']
        if (m) row(pick(m)).scores.push(...scoresOf(r, question))
      }
      return Object.values(g).sort((a, b) => (a.key < b.key ? -1 : 1))
    }

    return {
      win, responses, invites, scores, sent, answered, stillOpen,
      nps: nps(scores), avg: avg(scores), priorNps: nps(priorScores), priorAvg: avg(priorScores),
      priorN: priorScores.length, scopeClients: scopeClients.length, heardFrom: heardFrom.size,
      perDim, distribution, points, scoreSeries, sendSeries, clients, detractors, silent,
      byOwner: groupBy(m => m.owner), byIntensity: groupBy(m => m.intensity),
      hiddenFormer: surveys.rows.filter(r => !meta[r.companyId || '']).length,
    }
  }, [surveys, meta, period, grain, metric, question, owner, intensity, health, client, former])

  const questionLabel = question === 'all'
    ? 'All four questions'
    : SURVEY_DIMENSIONS.find(d => d.key === question)!.label
  const filtered = !!(owner || intensity || health || client)
  const clientName = client ? (meta[client] ? meta[client].name : 'one client') : ''

  const exportCsv = () => {
    if (!view) return
    const rows: (string | number)[][] = [[
      'Submitted', 'Client', 'Contact', 'Account owner', 'Support level',
      ...SURVEY_DIMENSIONS.map(d => d.label), 'Why', 'Comment',
    ]]
    for (const r of view.responses.slice().sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))) {
      const m = meta[r.companyId || '']
      rows.push([
        day(r.submittedAt), r.companyName || '', r.contactName || '', m ? m.owner : '', m ? m.intensity : '',
        ...DIMS.map(k => (r[k] === null || r[k] === undefined ? '' : r[k] as number)),
        r.reason || '', r.comment || '',
      ])
    }
    downloadCsv(`client-surveys-${iso(new Date())}.csv`, rows)
  }

  const delta = (now: number | null, before: number | null, fmt: (n: number) => string): string => {
    if (now === null || before === null) return ''
    const d = now - before
    if (Math.abs(d) < 0.05) return ' · level with the period before'
    return ` · ${d > 0 ? 'up' : 'down'} ${fmt(Math.abs(d))} on the period before`
  }

  const groupTable = (title: string, note: string, rows: GroupRow[], param: string, active: string) => (
    <section className="tcard">
      <h2 className="tcard__h">{title}</h2>
      <p className="note">{note}</p>
      <div className="tablewrap">
        <table className="fields compact">
          <thead>
            <tr>
              <th scope="col">{title.replace('By ', '')}</th>
              <th scope="col" className="num">Clients</th>
              <th scope="col" className="num">Sent</th>
              <th scope="col" className="num">Answered</th>
              <th scope="col" className="num">NPS</th>
              <th scope="col" className="num">Average</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(g => {
              const rate = pctOf(g.answered, g.sent)
              const n = nps(g.scores)
              const a = avg(g.scores)
              return (
                <tr key={g.key}>
                  <th scope="row">
                    <button type="button" className="linkbtn"
                      onClick={() => setParam(param, active === g.key ? '' : g.key)}>
                      {g.key}
                    </button>
                  </th>
                  <td className="num">{g.clients}</td>
                  <td className="num">{g.sent}</td>
                  <td className="num">{rate === null ? '-' : `${g.answered} (${rate}%)`}</td>
                  <td className="num">
                    {n === null ? <span className="muted">-</span>
                      : <span className="pill" data-tone={npsTone(n)}>{signed(n)}</span>}
                  </td>
                  <td className="num">{a === null ? '-' : one(a)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )

  const clientRows = view ? (showAllClients ? view.clients : view.clients.slice(0, 15)) : []

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <p className="crumb">
            {can('viewReports')
              ? <Link to="/reports">Reports</Link>
              : <Link to="/cs">Client Success</Link>}
          </p>
          <h1>Client Surveys</h1>
          <p className="page__sub">
            How clients rate us, whether it is getting better, and who is unhappy.
          </p>
        </div>
      </header>

      <div className="trep__filters">
        <div className="ef ef--narrow">
          <label htmlFor="sr-period">Period</label>
          <select id="sr-period" value={period} onChange={e => setParam('p', e.target.value === 'all' ? '' : e.target.value)}>
            <option value="all">All time</option>
            <option value="12m">Last 12 months</option>
            <option value="6m">Last 6 months</option>
            {quarters.map(q => <option key={q} value={q}>{q.replace('-', ' ')}</option>)}
          </select>
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="sr-q">Question</label>
          <select id="sr-q" value={question} onChange={e => setParam('q', e.target.value === 'overall' ? '' : e.target.value)}>
            {SURVEY_DIMENSIONS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
            <option value="all">All four questions</option>
          </select>
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="sr-owner">Account owner</label>
          <select id="sr-owner" value={owner} onChange={e => setParam('owner', e.target.value)}>
            <option value="">Everyone</option>
            {owners.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="sr-level">Support level</label>
          <select id="sr-level" value={intensity} onChange={e => setParam('level', e.target.value)}>
            <option value="">Any</option>
            {intensities.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="sr-health">Health today</label>
          <select id="sr-health" value={health} onChange={e => setParam('health', e.target.value)}>
            <option value="">Any</option>
            <option value="Green">Green</option>
            <option value="Yellow">Yellow</option>
            <option value="Red">Red</option>
          </select>
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="sr-client">Client</label>
          <select id="sr-client" value={client} onChange={e => setParam('client', e.target.value)}>
            <option value="">All clients</option>
            {queue.slice().sort((a, b) => (a.companyName < b.companyName ? -1 : 1)).map(c => (
              <option key={c.companyId} value={c.companyId}>{c.companyName}</option>
            ))}
          </select>
        </div>
        <span className="tpage__spacer" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={exportCsv}
          disabled={!view || view.responses.length === 0}>
          Export CSV
        </button>
      </div>

      {loading && <p className="muted">Reading the surveys…</p>}

      {error && (
        <div className="callout">
          <p className="callout__title">{error.needsLogin ? 'Sign in required' : 'Could not load the surveys'}</p>
          <p>{error.message}</p>
          <p className="callout__actions">
            {error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
          </p>
        </div>
      )}

      {view && !loading && (
        <>
          <div className="kpis">
            <Kpi
              label="Response rate"
              value={view.sent ? `${pctOf(view.answered, view.sent)}%` : '-'}
              note={view.sent
                ? `${view.answered} of ${view.sent} sent${view.stillOpen ? ` · ${view.stillOpen} still open` : ''}`
                : 'nothing sent in this view'}
            />
            <Kpi
              label={`NPS · ${questionLabel}`}
              value={view.nps === null ? '-' : signed(view.nps)}
              note={`n=${view.scores.length}${delta(view.nps, view.priorNps, n => String(Math.round(n)))}`}
              tone={npsTone(view.nps)}
            />
            <Kpi
              label="Average score"
              value={view.avg === null ? '-' : `${one(view.avg)} / 10`}
              note={`n=${view.scores.length}${delta(view.avg, view.priorAvg, one)}`}
            />
            <Kpi
              label="Clients heard from"
              value={view.scopeClients ? `${view.heardFrom} of ${view.scopeClients}` : String(view.heardFrom)}
              note={`${view.responses.length} response${view.responses.length === 1 ? '' : 's'}`}
            />
            <Kpi
              label="Unhappy clients"
              value={String(view.detractors)}
              note={`a ${DETRACTOR_MAX} or lower on any question, latest answer`}
              tone={view.detractors > 0 ? 'bad' : view.clients.length ? 'good' : undefined}
            />
          </div>

          {filtered && (
            <p className="trep__scope">
              Filtered to
              {owner && <> <strong>{owner}</strong></>}
              {intensity && <> <strong>{intensity}</strong></>}
              {health && <> <strong>{health}</strong></>}
              {client && <> <strong>{clientName}</strong></>}
              {' '}·{' '}
              <button type="button" className="linkbtn" onClick={() => {
                const next = new URLSearchParams(params)
                for (const k of ['owner', 'level', 'health', 'client']) next.delete(k)
                setParams(next, { replace: true })
              }}>Clear</button>
            </p>
          )}

          {view.responses.length === 0 && (
            <div className="callout callout--plain">
              <p className="callout__title">No answers in this view yet</p>
              <p>
                {view.sent > 0
                  ? <>{view.sent} survey{view.sent === 1 ? ' has' : 's have'} gone out and none
                      {view.sent === 1 ? ' has' : ' have'} come back yet. Scores fill in here as clients answer.</>
                  : <>No survey has gone out in this view. Cobalt sends two each weekday,
                      and each client is asked again every 90 days.</>}
              </p>
            </div>
          )}

          <section className="tcard">
            <h2 className="tcard__h">Scores over time</h2>
            <p className="note">
              One line per question, by the {grain} each answer came in. A {grain} with no
              answers is a gap in the line, not a zero.
            </p>
            <p className="note">
              <span className="seg" role="group" aria-label="Measure">
                <button type="button" data-on={metric === 'nps' ? '' : undefined} aria-pressed={metric === 'nps'}
                  onClick={() => setParam('m', '')}>NPS</button>
                <button type="button" data-on={metric === 'avg' ? '' : undefined} aria-pressed={metric === 'avg'}
                  onClick={() => setParam('m', 'avg')}>Average</button>
              </span>
              {' '}
              <span className="seg" role="group" aria-label="Group by">
                <button type="button" data-on={grain === 'month' ? '' : undefined} aria-pressed={grain === 'month'}
                  onClick={() => setParam('by', '')}>Month</button>
                <button type="button" data-on={grain === 'quarter' ? '' : undefined} aria-pressed={grain === 'quarter'}
                  onClick={() => setParam('by', 'quarter')}>Quarter</button>
              </span>
            </p>
            <TrendChart
              points={view.responses.length ? view.points : []}
              series={view.scoreSeries}
              format={metric === 'nps' ? n => signed(Math.round(n)) : n => one(n)}
              empty="No answers in this view to plot."
            />
          </section>

          <section className="tcard">
            <h2 className="tcard__h">Surveys sent and answered</h2>
            <p className="note">
              By the {grain} each survey was emailed. A survey stays open for 30 days, so
              the newest {grain}s keep filling in.
            </p>
            <TrendChart
              points={view.sent ? view.points : []}
              series={view.sendSeries}
              format={n => String(Math.round(n))}
              rightFormat={n => `${Math.round(n)}%`}
              empty="No surveys were sent in this view."
            />
          </section>

          <div className="trep__two">
            <section className="tcard">
              <h2 className="tcard__h">By question</h2>
              <p className="note">
                Promoters gave a 9 or 10, detractors a {DETRACTOR_MAX} or lower. NPS is the
                share of promoters minus the share of detractors.
              </p>
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Question</th>
                      <th scope="col" className="num">NPS</th>
                      <th scope="col" className="num">Average</th>
                      <th scope="col" className="num">Promoters</th>
                      <th scope="col" className="num">Passives</th>
                      <th scope="col" className="num">Detractors</th>
                      <th scope="col" className="num">n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.perDim.map(d => (
                      <tr key={d.key}>
                        <th scope="row">
                          <button type="button" className="linkbtn"
                            onClick={() => setParam('q', d.key === 'overall' ? '' : d.key)}>
                            {d.label}
                          </button>
                        </th>
                        <td className="num">
                          {d.nps === null ? <span className="muted">-</span>
                            : <span className="pill" data-tone={npsTone(d.nps)}>{signed(d.nps)}</span>}
                        </td>
                        <td className="num">{d.avg === null ? '-' : one(d.avg)}</td>
                        <td className="num">{d.promoters}</td>
                        <td className="num">{d.passives}</td>
                        <td className="num">{d.detractors}</td>
                        <td className="num">{d.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="tcard">
              <h2 className="tcard__h">How the scores spread</h2>
              <p className="note">{questionLabel}: how many answers landed on each score, 0 to 10.</p>
              <ColumnChart
                columns={view.scores.length ? view.distribution.map((n, v) => ({
                  key: `s${v}`, label: String(v),
                  title: `a score of ${v}`, value: n,
                })) : []}
                format={n => `${n} answer${n === 1 ? '' : 's'}`}
                empty="No answers in this view."
                height={140}
              />
            </section>
          </div>

          <section className="tcard">
            <h2 className="tcard__h">Client by client</h2>
            <p className="note">
              Each client's latest answer in this view, lowest scores first. Change is their
              average against the time before.
            </p>
            {view.clients.length === 0 ? (
              <p className="muted chart__empty">No client has answered in this view.</p>
            ) : (
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Client</th>
                      <th scope="col">Account owner</th>
                      <th scope="col">Answered</th>
                      {SURVEY_DIMENSIONS.map(d => <th scope="col" key={d.key}>{d.label}</th>)}
                      <th scope="col" className="num">Change</th>
                      <th scope="col">Said</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientRows.map(c => {
                      const r = c.response
                      const open = openRow === c.id
                      const said = [r.reason, r.comment].filter(Boolean).join(' ')
                      return (
                        <Fragment key={c.id}>
                          <tr className="rowlink">
                            <th scope="row">
                              <Link className="rowlink__a" to={`/clients/${c.id}/success`}>{c.name}</Link>
                              {r.contactName && <><br /><span className="muted">{r.contactName}</span></>}
                            </th>
                            <td>{c.owner || <span className="muted">-</span>}</td>
                            <td className="nowrap">
                              {day(r.submittedAt)}
                              {c.answers > 1 && <><br /><span className="muted">{c.answers} answers so far</span></>}
                            </td>
                            {DIMS.map(k => <td className="num" key={k}><Score value={r[k]} /></td>)}
                            <td className="num nowrap">
                              {c.change === null ? <span className="muted">first answer</span>
                                : Math.abs(c.change) < 0.05 ? <span className="muted">no change</span>
                                : <span className="pill" data-tone={c.change > 0 ? 'good' : 'bad'}>
                                    {c.change > 0 ? '▲' : '▼'} {one(Math.abs(c.change))}
                                  </span>}
                            </td>
                            <td>
                              {said ? (
                                <button type="button" className="subtoggle" aria-expanded={open}
                                  onClick={() => setOpenRow(open ? '' : c.id)}>
                                  <span className="subtoggle__caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                                  {open ? 'Hide' : 'Read'}
                                </button>
                              ) : <span className="muted">nothing written</span>}
                            </td>
                          </tr>
                          {open && (
                            <tr className="rowlink--sub">
                              <th scope="row"><span className="subtee" aria-hidden="true">↳</span>said</th>
                              <td colSpan={SURVEY_DIMENSIONS.length + 4} className="facts__wrap">
                                {r.reason && <p>{r.reason}</p>}
                                {r.comment && <p className="muted">{r.comment}</p>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {view.clients.length > 15 && (
              <button type="button" className="linkbtn" onClick={() => setShowAllClients(!showAllClients)}>
                {showAllClients ? 'Show the lowest 15' : `Show all ${view.clients.length}`}
              </button>
            )}
          </section>

          <section className="tcard">
            <h2 className="tcard__h">Asked, no answer</h2>
            <p className="note">
              Clients sent a survey in this view who have not answered one. "Waiting" means
              the link is still open.
            </p>
            {view.silent.length === 0 ? (
              <p className="muted chart__empty">
                {view.sent ? 'Everyone asked in this view has answered.' : 'No surveys were sent in this view.'}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Client</th>
                      <th scope="col">Account owner</th>
                      <th scope="col" className="num">Times asked</th>
                      <th scope="col">Last sent</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.silent.map(s => (
                      <tr key={s.id}>
                        <th scope="row">
                          <Link className="rowlink__a" to={`/clients/${s.id}/success`}>{s.name}</Link>
                        </th>
                        <td>{s.owner || <span className="muted">-</span>}</td>
                        <td className="num">{s.times}</td>
                        <td className="nowrap">{s.lastSent}</td>
                        <td>
                          {s.waiting
                            ? <span className="pill">Waiting</span>
                            : <span className="pill" data-tone="warn">Did not answer</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="trep__two">
            {groupTable('By account owner',
              `Scores are for ${questionLabel.toLowerCase()}. Pick a name to filter the whole report.`,
              view.byOwner, 'owner', owner)}
            {groupTable('By support level',
              `Scores are for ${questionLabel.toLowerCase()}. Pick a level to filter the whole report.`,
              view.byIntensity, 'level', intensity)}
          </div>

          <p className="note">
            <label className="checkline">
              <input type="checkbox" checked={former}
                onChange={e => setParam('former', e.target.checked ? '1' : '')} />
              <span>
                Include companies that are no longer clients
                {view.hiddenFormer > 0 && !former && ` (${view.hiddenFormer} answer${view.hiddenFormer === 1 ? '' : 's'} left out)`}
              </span>
            </label>
          </p>
        </>
      )}
    </section>
  )
}
