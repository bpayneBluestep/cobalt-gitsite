import TrendChart from '../../components/TrendChart'
import { SERIES } from '../../pigments'
import { money, pct1, ymLabel } from '../../lib/finance'
import { CONCENTRATION_FLAG } from './compute'
import type { TabProps } from './Overview'
import { Panel, Pill, Waterfall, fmtMoney, toPoints } from './ui'

/** The three revenue streams in one fixed colour each, here and in the client deep dive. */
export const STREAM_COLORS = { recurring: SERIES[0], ps: SERIES[2], setup: SERIES[3] }

export default function Revenue({ m, ym }: TabProps) {
  const win = m.trailing(ym, 24)
  const wf = m.mrrWaterfall(ym)
  const conc = m.concentration(ym)
  const lines = m.newMrrAt(ym)?.lines ?? []

  return (
    <>
      <Panel title="Revenue by stream: trailing 24 months">
        <TrendChart
          points={toPoints(win)}
          series={[
            { key: 'rec', name: 'Recurring', kind: 'bar', color: STREAM_COLORS.recurring, values: win.map(x => m.streamsAt(x)?.recurring ?? 0) },
            { key: 'ps', name: 'Professional services', kind: 'bar', color: STREAM_COLORS.ps, values: win.map(x => m.streamsAt(x)?.professionalServices ?? 0) },
            { key: 'setup', name: 'Setup & licensing', kind: 'bar', color: STREAM_COLORS.setup, values: win.map(x => m.streamsAt(x)?.setup ?? 0) },
          ]}
          format={fmtMoney}
          empty="No revenue months to draw."
          highlight={ym}
        />
      </Panel>

      <div className="trep__two">
        <Panel
          title={`MRR movement: ${ymLabel(ym)}`}
          note={wf.hasPrev
            ? `Recurring revenue per customer, ${ymLabel(wf.prev)} against ${ymLabel(ym)}.`
            : `No recurring revenue on file for ${ymLabel(wf.prev)}, so everything this month counts as new.`}
        >
          <Waterfall steps={wf.steps} label={`MRR movement from ${ymLabel(wf.prev)} to ${ymLabel(ym)}`} />
        </Panel>

        <Panel
          title={`Customer concentration: ${ymLabel(ym)}`}
          aside={conc.flagged ? <Pill tone="warn">top account {pct1(conc.topShare)}</Pill> : undefined}
          note={`Top 12 by MRR. A single account at ${CONCENTRATION_FLAG}% or more of the book is flagged.`}
        >
          <div className="tablewrap">
            <table className="fields compact frep__t">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" className="num">MRR</th>
                  <th scope="col" className="num">% of total</th>
                </tr>
              </thead>
              <tbody>
                {conc.custs.length ? conc.custs.slice(0, 12).map(c => (
                  <tr key={c.name}>
                    <th scope="row">{c.name}</th>
                    <td className="num">{money(c.amount)}</td>
                    <td className="num">{conc.total > 0 ? pct1((c.amount / conc.total) * 100) : '—'}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={3} className="muted">No recurring revenue this month.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel title="New MRR by month" note="New customers plus upsells: billing lines whose first recurring month this is.">
        <TrendChart
          points={toPoints(win)}
          series={[{ key: 'new', name: 'New MRR', kind: 'bar', color: 'var(--good)', values: win.map(x => m.newMrrAt(x)?.total ?? 0) }]}
          format={fmtMoney}
          empty="No months to draw."
          height={180}
          highlight={ym}
        />
      </Panel>

      <Panel title={`New billing lines: ${ymLabel(ym)}`}>
        <div className="tablewrap">
          <table className="fields compact frep__t">
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col">Revenue code</th>
                <th scope="col" className="num">New MRR</th>
              </tr>
            </thead>
            <tbody>
              {lines.length ? lines.map((l, i) => (
                <tr key={`${l.program}|${l.code}|${i}`}>
                  <th scope="row">{l.program}</th>
                  <td>{l.code}</td>
                  <td className="num">{money(l.newMrr)}</td>
                </tr>
              )) : (
                <tr><td colSpan={3} className="muted">No new billing lines this month.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}
