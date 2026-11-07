import { Link } from 'react-router-dom'
import TrendChart from '../../components/TrendChart'
import { money, moneyShort, pct1, ymLabel } from '../../lib/finance'
import { CHURN_LOSS_PCT, COHORT_TONE, MRR_CHURN_RED, cohortTag } from './compute'
import type { TabProps } from './Overview'
import { Kpi, MoneyDelta, Panel, Pill, Waterfall, fmtPct, toPoints } from './ui'

/** Who billed recurring last month and lost most of it this month. */
function MomChurn({ m, ym, href }: TabProps) {
  const ch = m.momChurn(ym)
  const prevL = ymLabel(ch.prev), curL = ymLabel(ym)
  return (
    <Panel
      title={`Month-over-month churn: ${prevL} → ${curL}`}
      note={`Accounts that billed recurring revenue in ${prevL} and lost ${CHURN_LOSS_PCT}% or more of it in ${curL}. Dropping to a cheap data-retention plan counts as churn.`}
    >
      {!ch.hasPrev ? (
        <p className="muted chart__empty">No recurring revenue in {prevL} to compare against.</p>
      ) : ch.partial ? (
        <div className="callout callout--plain">
          <p className="callout__title">{curL} isn't over yet</p>
          <p>Anyone not billed yet this month would show as churned, so churn is only counted for finished months. Pick an earlier month above.</p>
        </div>
      ) : (
        <>
          <div className="kpis">
            <Kpi label="Churned accounts" value={String(ch.rows.length)} tone={ch.rows.length ? 'bad' : 'good'}
              note={ch.logoRate !== null ? `${pct1(ch.logoRate)} of ${ch.startCount} billing in ${prevL}` : undefined} />
            <Kpi label="MRR lost to churn" value={moneyShort(ch.lostMrr)}
              tone={ch.mrrRate === null || ch.mrrRate === 0 ? 'good' : ch.mrrRate >= MRR_CHURN_RED ? 'bad' : 'warn'}
              note={ch.mrrRate !== null ? `${pct1(ch.mrrRate)} of ${moneyShort(ch.startMrr)} MRR` : undefined} />
            <Kpi label="Still on retention" value={String(ch.retainedCount)}
              note={ch.retainedCount ? `${money(ch.retainedMrr)}/mo left` : 'all fully gone'} />
          </div>
          <div className="tablewrap">
            <table className="fields compact frep__t">
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col" className="num">{prevL}</th>
                  <th scope="col" className="num">{curL}</th>
                  <th scope="col" className="num">Lost</th>
                  <th scope="col" className="num">% lost</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {ch.rows.length ? ch.rows.map(r => (
                  <tr key={r.name}>
                    <th scope="row">
                      <Link className="inlink" to={{ search: href({ tab: 'clients', client: r.name }) }}>{r.name}</Link>
                    </th>
                    <td className="num">{money(r.prev)}</td>
                    <td className="num">{money(r.cur)}</td>
                    <td className="num"><MoneyDelta v={-r.lost} /></td>
                    <td className="num">{pct1(r.lostPct)}</td>
                    <td>{r.cur > 0 ? <Pill tone="warn">Retention only</Pill> : <Pill tone="bad">Gone</Pill>}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={6} className="muted">Nobody churned in {curL}.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {ch.repeat.length > 0 && (
            <p className="note">
              Not counted again: {ch.repeat.map(r => `${r.name} (${money(r.prev)} → ${money(r.cur)})`).join(', ')}.
              They already churned earlier and their retention plan has now stopped.
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

export default function Retention(props: TabProps) {
  const { m, ym } = props
  const win = m.trailing(ym, 24)
  const wf = m.ndrWaterfall(ym)
  const rows = m.ndrAt(ym)?.rows ?? []
  const ndrOf = (x: string): number | null => {
    const v = m.ndrAt(x)?.ndr
    return v === null || v === undefined ? null : v
  }

  return (
    <>
      <MomChurn {...props} />

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
