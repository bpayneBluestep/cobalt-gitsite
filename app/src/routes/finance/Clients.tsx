import { Fragment, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import TrendChart from '../../components/TrendChart'
import { addMonthsYm, money, moneyShort, pct1, signedPct, ymLabel } from '../../lib/finance'
import {
  COHORT_TONE, STATUS_TONE, STREAMS, STREAM_TAG, cohortTag, sortClientRows, streamLabel,
  type ClientSortKey, type ProdLine, type StreamId,
} from './compute'
import type { TabProps } from './Overview'
import { STREAM_COLORS } from './Revenue'
import { Delta, Kpi, MoneyDelta, Panel, Pill, Spark, fmtMoney, toPoints } from './ui'

interface ClientsProps extends TabProps {
  client: string
  stream: StreamId
  setStream: (s: StreamId) => void
}

/*
 * Per-client revenue, switchable by stream: a comparison of every client, and a deep
 * dive into one. Which client is open lives in the URL (a deep dive is something you
 * link somebody to, and Back should close it); the sort and the search box do not.
 */
export default function Clients(props: ClientsProps) {
  const { m, client } = props
  if (!m.clientNames.length) {
    return (
      <div className="callout callout--plain">
        <p className="callout__title">No per-client revenue</p>
        <p>The revenue export has no customer rows to group.</p>
      </div>
    )
  }
  return client && m.byClient[client] ? <DeepDive {...props} /> : <Comparison {...props} />
}

function StreamSwitch({ stream, setStream }: { stream: StreamId; setStream: (s: StreamId) => void }) {
  return (
    <div className="seg frep__seg" role="group" aria-label="Revenue stream">
      {STREAMS.map(s => (
        <button key={s.id} type="button" data-on={s.id === stream ? '' : undefined}
          aria-pressed={s.id === stream} onClick={() => setStream(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  )
}

function DeltaCell({ pct, abs }: { pct: number | null; abs: number }) {
  if (pct === null && abs === 0) return <td className="num"><span className="muted">—</span></td>
  const tone = abs > 0 ? 'good' : abs < 0 ? 'bad' : undefined
  return (
    <td className="num">
      <span className="frep__d" data-tone={tone}>
        {pct !== null ? signedPct(pct) : (abs > 0 ? '+' : '') + money(abs)}
      </span>
    </td>
  )
}

function Products({ prods, ym, stream, total }: { prods: ProdLine[]; ym: string; stream: StreamId; total?: boolean }) {
  if (!prods.length) {
    return <p className="muted chart__empty">No itemized products in {ymLabel(ym)} for {streamLabel(stream)}.</p>
  }
  const sum = prods.reduce((s, p) => s + p.amount, 0)
  return (
    <table className="fields compact frep__sub">
      <thead>
        <tr>
          <th scope="col">Product / revenue code</th>
          <th scope="col">Stream</th>
          <th scope="col" className="num">{ymLabel(ym)}</th>
        </tr>
      </thead>
      <tbody>
        {prods.map(p => (
          <tr key={p.code}>
            <td>{p.code}</td>
            <td><span className="tag">{STREAM_TAG[p.stream]}</span></td>
            <td className="num">{money(p.amount)}</td>
          </tr>
        ))}
      </tbody>
      {total && prods.length > 1 && (
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>Total, {streamLabel(stream).toLowerCase()}</th>
            <td className="num"><strong>{money(sum)}</strong></td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}

const SORT_COLUMNS: { key: ClientSortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Client', numeric: false },
  { key: 'value', label: '', numeric: true },
  { key: 'share', label: '% of book', numeric: true },
  { key: 'momAbs', label: 'MoM', numeric: true },
  { key: 'yoyAbs', label: 'YoY', numeric: true },
]

function Comparison({ m, ym, href, stream, setStream }: ClientsProps) {
  const [sort, setSort] = useState<{ key: ClientSortKey; dir: 1 | -1 }>({ key: 'value', dir: -1 })
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  const rows = useMemo(() => m.clientRows(ym, stream), [m, ym, stream])
  const sorted = useMemo(() => sortClientRows(rows, sort.key, sort.dir), [rows, sort])
  const needle = query.trim().toLowerCase()
  const shown = needle ? sorted.filter(r => r.name.toLowerCase().includes(needle)) : sorted
  const { gainers, losers } = m.movers(ym, stream)

  const sortBy = (key: ClientSortKey) => setSort(s =>
    s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' || key === 'status' ? 1 : -1 })
  const toggle = (name: string) => setOpen(o => {
    const next = new Set(o)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })
  const sortTh = (key: ClientSortKey, label: string, numeric: boolean) => (
    <th key={key} scope="col" className={numeric ? 'num' : undefined}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sortbtn" onClick={() => sortBy(key)}>
        {label}
        <span className="sortbtn__i" aria-hidden="true">
          {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )

  return (
    <>
      <div className="frep__bar">
        <StreamSwitch stream={stream} setStream={setStream} />
        <span className="muted frep__hint">
          {streamLabel(stream)} · {ymLabel(ym)} · open a client for the deep dive
        </span>
      </div>

      <div className="trep__two">
        <Panel title={`Top gainers: ${ymLabel(ym)}`} note="Largest increase on the month before.">
          {gainers.length ? (
            <ul className="frep__movers">
              {gainers.map(o => (
                <li key={o.name}>
                  <Link className="inlink" to={{ search: href({ client: o.name }) }}>{o.name}</Link>
                  <MoneyDelta v={o.d} />
                </li>
              ))}
            </ul>
          ) : <p className="muted chart__empty">No gainers this month.</p>}
        </Panel>
        <Panel title={`Top decliners: ${ymLabel(ym)}`} note="Largest decrease on the month before.">
          {losers.length ? (
            <ul className="frep__movers">
              {losers.map(o => (
                <li key={o.name}>
                  <Link className="inlink" to={{ search: href({ client: o.name }) }}>{o.name}</Link>
                  <MoneyDelta v={o.d} />
                </li>
              ))}
            </ul>
          ) : <p className="muted chart__empty">No decliners this month.</p>}
        </Panel>
      </div>

      <Panel
        title={`All clients: ${ymLabel(ym)}`}
        aside={
          <div className="search frep__search">
            <label className="visually-hidden" htmlFor="frep-q">Search clients</label>
            <input id="frep-q" type="search" placeholder="Search clients" autoComplete="off"
              value={query} onChange={e => setQuery(e.target.value)} />
          </div>
        }
        note={`${rows.length} client${rows.length === 1 ? '' : 's'} with ${streamLabel(stream).toLowerCase()} on record. The caret lists a client's products this month; the name opens the deep dive. Trend is the last 12 months.`}
      >
        <div className="tablewrap frep__tall">
          <table className="fields compact frep__t frep__t--wide">
            <thead>
              <tr>
                {SORT_COLUMNS.map(c => sortTh(c.key, c.key === 'value' ? streamLabel(stream) : c.label, c.numeric))}
                <th scope="col">Trend</th>
                {sortTh('status', 'Status', false)}
              </tr>
            </thead>
            <tbody>
              {shown.length ? shown.map(r => {
                const isOpen = open.has(r.name)
                return (
                  <Fragment key={r.name}>
                    <tr>
                      <th scope="row">
                        <span className="frep__cname">
                          <button type="button" className="bexp frep__caret" disabled={!r.products.length}
                            aria-expanded={isOpen} onClick={() => toggle(r.name)}
                            title={r.products.length ? (isOpen ? 'Hide the products' : 'Show the products') : 'No itemized products this month'}>
                            <span className="bexp__caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                            <span className="visually-hidden">Products for {r.name}</span>
                          </button>
                          <Link className="inlink" to={{ search: href({ client: r.name }) }}>{r.name}</Link>
                          {r.products.length > 0 && <span className="bexp__n">{r.products.length} prod</span>}
                        </span>
                      </th>
                      <td className="num">{money(r.value)}</td>
                      <td className="num">{r.share !== null ? pct1(r.share) : '—'}</td>
                      <DeltaCell pct={r.momPct} abs={r.momAbs} />
                      <DeltaCell pct={r.yoyPct} abs={r.yoyAbs} />
                      <td><Spark values={r.spark} label={`${r.name}, last 12 months`} /></td>
                      <td><Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill></td>
                    </tr>
                    {isOpen && (
                      <tr className="frep__detail">
                        <td colSpan={7}><Products prods={r.products} ym={ym} stream={stream} /></td>
                      </tr>
                    )}
                  </Fragment>
                )
              }) : (
                <tr>
                  <td colSpan={7} className="muted">
                    {needle ? 'No clients match your search.' : `No clients with ${streamLabel(stream).toLowerCase()} this period.`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}

function DeepDive({ m, ym, href, client: p, stream, setStream }: ClientsProps) {
  const navigate = useNavigate()
  const s = m.clientSummary(p, ym, stream)
  const lines = m.clientNewLines(p)
  const ret = m.clientRetention(p, ym)
  const prods = m.clientProductsAt(p, ym, stream)
  const win = m.clientTrailing(ym, 24)
  const tenure = s.firstM && s.lastM ? `${ymLabel(s.firstM)} – ${ymLabel(s.lastM)}` : '—'
  const rank = s.rank > 0 ? `#${s.rank} of ${s.rankOf} by ${streamLabel(stream).toLowerCase()}` : 'not ranked this month'
  const streamKeys = stream === 'all' ? (['recurring', 'ps', 'setup'] as const) : [stream]
  const names = useMemo(() => m.clientNames.slice().sort((a, b) => a.localeCompare(b)), [m])

  return (
    <>
      <div className="frep__client">
        <div>
          <p className="crumb">
            <Link to={{ search: href({ client: null }) }}>← All clients</Link>
          </p>
          <h2 className="frep__cn">
            {p} <Pill tone={STATUS_TONE[s.status]}>{s.status}</Pill>
          </h2>
          <p className="muted frep__cm">{tenure} · {rank}</p>
        </div>
        <div className="ef ef--narrow">
          <label htmlFor="frep-client">Client</label>
          <select id="frep-client" value={p}
            onChange={e => navigate({ search: href({ client: e.target.value }) }, { replace: true })}>
            {names.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      <div className="frep__bar">
        <StreamSwitch stream={stream} setStream={setStream} />
      </div>

      <div className="kpis">
        <Kpi label="Recurring (MRR)" value={moneyShort(s.curMrr)}
          deltas={<Delta pct={s.mom.pct} upIsGood suffix="MoM" />} note={ymLabel(ym)} />
        <Kpi label="YoY change" value={s.yoy.pct !== null ? signedPct(s.yoy.pct) : '—'}
          note={s.yoy.prev > 0 ? `vs ${ymLabel(addMonthsYm(ym, -12))}` : 'no prior year'} />
        <Kpi label="Peak MRR" value={moneyShort(s.peak)} note="best recurring month" />
        <Kpi label="Lifetime recurring" value={moneyShort(s.lifetime)} note="total booked" />
        <Kpi label="Months active" value={String(s.monthsActive)} note="with recurring revenue" />
        <Kpi label="Share of book" value={s.share !== null ? pct1(s.share) : '—'} note={streamLabel(stream)} />
      </div>

      <Panel title={`${p}: revenue by stream, trailing 24 months`}>
        <TrendChart
          points={toPoints(win)}
          series={streamKeys.map(k => ({
            key: k, name: streamLabel(k), kind: 'bar' as const, color: STREAM_COLORS[k],
            values: win.map(x => m.streamVal(p, x, k)),
          }))}
          format={fmtMoney}
          empty="No months to draw."
          highlight={ym}
        />
      </Panel>

      <Panel
        title={<>Products: {ymLabel(ym)} {prods.length > 0 && <span className="subnav__n">{prods.length}</span>}</>}
        note="What each revenue code billed this month, in the selected stream."
      >
        <div className="tablewrap">
          <Products prods={prods} ym={ym} stream={stream} total />
        </div>
      </Panel>

      <div className="trep__two">
        <Panel title="New billing lines and upsells" note="The month each revenue code first billed recurring.">
          <div className="tablewrap">
            <table className="fields compact frep__t">
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Revenue code</th>
                  <th scope="col" className="num">New MRR</th>
                </tr>
              </thead>
              <tbody>
                {lines.length ? lines.map((l, i) => (
                  <tr key={`${l.ym}|${l.code}|${i}`}>
                    <td>{ymLabel(l.ym)}</td>
                    <td>{l.code}</td>
                    <td className="num">{money(l.newMrr)}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={3} className="muted">No new billing lines on record for this client.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title={`Year-over-year retention: ${ymLabel(ym)}`}>
          {ret ? (
            <div className="tablewrap">
              <table className="fields compact frep__t">
                <thead>
                  <tr>
                    <th scope="col" className="num">Base ({ymLabel(addMonthsYm(ym, -12))})</th>
                    <th scope="col" className="num">This month</th>
                    <th scope="col" className="num">Change</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="num">{money(ret.base)}</td>
                    <td className="num">{money(ret.current)}</td>
                    <td className="num"><MoneyDelta v={ret.delta} /></td>
                    <td><Pill tone={COHORT_TONE[cohortTag(ret)]}>{cohortTag(ret)}</Pill></td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : <p className="muted chart__empty">No prior-year cohort for this client in {ymLabel(ym)}.</p>}
        </Panel>
      </div>
    </>
  )
}
