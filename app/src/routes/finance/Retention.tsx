import TrendChart from '../../components/TrendChart'
import { money, pct1, ymLabel } from '../../lib/finance'
import { COHORT_TONE, cohortTag } from './compute'
import type { TabProps } from './Overview'
import { MoneyDelta, Panel, Pill, Waterfall, fmtPct, toPoints } from './ui'

export default function Retention({ m, ym }: TabProps) {
  const win = m.trailing(ym, 24)
  const wf = m.ndrWaterfall(ym)
  const rows = m.ndrAt(ym)?.rows ?? []
  const ndrOf = (x: string): number | null => {
    const v = m.ndrAt(x)?.ndr
    return v === null || v === undefined ? null : v
  }

  return (
    <>
      <Panel
        title="Net dollar retention: trailing 24 months"
        note="Recurring revenue this month from the accounts billing a year earlier, as a share of what they billed then. 100% is the target: the base holding its value."
      >
        <TrendChart
          points={toPoints(win)}
          series={[
            { key: 'ndr', name: 'NDR', kind: 'line', color: 'var(--cobalt)', values: win.map(ndrOf) },
            { key: 'target', name: 'Target', kind: 'line', color: 'var(--text-mute)', dashed: true, values: win.map(() => 100) },
          ]}
          format={fmtPct}
          empty="No months to draw."
          highlight={ym}
        />
      </Panel>

      <Panel
        title={`Retention waterfall: ${ymLabel(ym)}`}
        note={wf
          ? `Cohort from ${ymLabel(wf.baseYm)}: ${wf.cohortSize} accounts, retaining ${pct1(wf.ndr)}.`
          : undefined}
      >
        {wf
          ? <Waterfall steps={wf.steps} label={`Retention from ${ymLabel(wf.baseYm)} to ${ymLabel(ym)}`} />
          : <p className="muted chart__empty">No prior-year base cohort to compare for this month.</p>}
      </Panel>

      <Panel title={`Cohort accounts: base against ${ymLabel(ym)}`} note={`Worst first. ${rows.length} accounts.`}>
        <div className="tablewrap frep__tall">
          <table className="fields compact frep__t">
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col" className="num">Base MRR</th>
                <th scope="col" className="num">This month</th>
                <th scope="col" className="num">Change</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map(r => {
                const tag = cohortTag(r)
                return (
                  <tr key={r.program}>
                    <th scope="row">{r.program}</th>
                    <td className="num">{money(r.base)}</td>
                    <td className="num">{money(r.current)}</td>
                    <td className="num"><MoneyDelta v={r.delta} /></td>
                    <td><Pill tone={COHORT_TONE[tag]}>{tag}</Pill></td>
                  </tr>
                )
              }) : (
                <tr><td colSpan={5} className="muted">No prior-year cohort for this month.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}
