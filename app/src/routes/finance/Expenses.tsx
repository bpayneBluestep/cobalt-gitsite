import BarRows from '../../components/BarRows'
import TrendChart from '../../components/TrendChart'
import { SERIES } from '../../pigments'
import { money, moneyShort, pct1, signedPct, ymLabel } from '../../lib/finance'
import { ANOMALY_FLOOR, ANOMALY_PCT, PAYROLL_PCT_FLAG } from './compute'
import type { TabProps } from './Overview'
import { Delta, Kpi, MoneyDelta, Panel, Pill, fmtMoney, toPoints } from './ui'

export default function Expenses({ m, ym }: TabProps) {
  if (!m.hasExpenseData(ym)) {
    return (
      <div className="callout callout--plain">
        <p className="callout__title">No expense data for {ymLabel(ym)}</p>
        <p>
          The expense export starts {m.earliestExpMonth ? ymLabel(m.earliestExpMonth) : 'later'}. Pick a
          month from then on to see spending.
        </p>
      </div>
    )
  }

  const k = m.computeKpis(ym)
  const payroll = m.payrollOf(ym)
  const rev = m.revTotal(ym)
  const payrollPct = rev > 0 ? (payroll / rev) * 100 : null
  const anomalies = m.expenseAnomalies(ym)
  const mix = m.catsForMonth(ym).filter(c => c.amt > 0)
  const vendors = m.vendorsForMonth(ym).slice(0, 12)
  const win = m.expenseWindow(ym)
  const topCats = m.topCategoriesOverall(7)

  return (
    <>
      <div className="kpis">
        <Kpi label="Total expenses" value={moneyShort(k.expenses)}
          deltas={<Delta pct={k.expMoM} upIsGood={false} suffix="MoM" />}
          note="incl. payroll & platform" />
        <Kpi label="Payroll" value={moneyShort(payroll)}
          tone={payrollPct !== null && payrollPct >= PAYROLL_PCT_FLAG ? 'warn' : undefined}
          note={payrollPct !== null ? `${pct1(payrollPct)} of revenue` : undefined} />
        <Kpi label="Platform fee" value={moneyShort(m.platformOf(ym))} note="intracompany, counted once" />
        <Kpi label="Anomalies" value={String(anomalies.length)} tone={anomalies.length ? 'warn' : 'good'}
          note={`>${ANOMALY_PCT}% MoM and >${money(ANOMALY_FLOOR)}`} />
      </div>

      <Panel title="Total expenses by month">
        <TrendChart
          points={toPoints(win)}
          series={[{ key: 'exp', name: 'Expenses', kind: 'bar', color: 'var(--danger)', values: win.map(m.expenseMonthTotal) }]}
          format={fmtMoney}
          empty="No expense months to draw."
          height={180}
          highlight={ym}
        />
      </Panel>

      <Panel title="Expense categories by month" note="The seven largest categories over the export; the rest as Other.">
        <TrendChart
          points={toPoints(win)}
          series={[
            ...topCats.map((c, i) => ({
              key: c, name: c, kind: 'bar' as const, color: SERIES[i % SERIES.length],
              values: win.map(x => m.categoryAt(c, x)),
            })),
            {
              key: '__other', name: 'Other', kind: 'bar' as const, color: 'var(--line-strong)',
              values: win.map(x => m.categoryNames.filter(c => !topCats.includes(c)).reduce((s, c) => s + m.categoryAt(c, x), 0)),
            },
          ]}
          format={fmtMoney}
          empty="No expense months to draw."
          height={240}
          highlight={ym}
        />
      </Panel>

      <div className="trep__two">
        <Panel title={`Category mix: ${ymLabel(ym)}`} note="Every category with spend this month, with its share of the total.">
          <BarRows
            rows={mix.map(c => ({
              key: c.name, label: c.name, value: c.amt,
              meta: k.expenses > 0 ? `${pct1((c.amt / k.expenses) * 100)} of total` : undefined,
            }))}
            format={money}
            empty="No category spend this month."
            limit={8}
          />
        </Panel>

        <Panel title={`Top vendors: ${ymLabel(ym)}`}>
          <div className="tablewrap">
            <table className="fields compact frep__t">
              <thead>
                <tr>
                  <th scope="col">Vendor</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col" className="num">MoM</th>
                </tr>
              </thead>
              <tbody>
                {vendors.length ? vendors.map(v => (
                  <tr key={v.name}>
                    <th scope="row">{v.name}</th>
                    <td className="num">{money(v.amt)}</td>
                    <td className="num"><MoneyDelta v={v.delta} upIsGood={false} /></td>
                  </tr>
                )) : (
                  <tr><td colSpan={3} className="muted">No vendor detail.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel title={`Spend anomalies: ${ymLabel(ym)}`}>
        {anomalies.length ? (
          <ul className="frep__list">
            {anomalies.slice(0, 10).map(a => (
              <li key={a.name}>
                <Pill tone="warn">{a.kind}</Pill>
                <strong>{a.name}</strong>
                <span className="muted">
                  {money(a.prev)} → {money(a.cur)} {a.pct !== null ? `(${signedPct(a.pct)})` : '(new)'}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="muted chart__empty">No expense anomalies this month.</p>}
      </Panel>
    </>
  )
}
