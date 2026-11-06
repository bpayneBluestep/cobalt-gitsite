import BarRows from '../../components/BarRows'
import TrendChart from '../../components/TrendChart'
import { money, moneyShort, pct1, ymLabel } from '../../lib/finance'
import { netTone } from './compute'
import type { TabProps } from './Overview'
import { Delta, Kpi, Panel, fmtMoney, fmtPct, toPoints } from './ui'

export default function Profitability({ m, ym }: TabProps) {
  if (!m.hasExpenseData(ym)) {
    return (
      <div className="callout callout--plain">
        <p className="callout__title">No profit figure for {ymLabel(ym)}</p>
        <p>
          The expense export starts {m.earliestExpMonth ? ymLabel(m.earliestExpMonth) : 'later'}, so
          there is nothing to subtract from this month's revenue.
        </p>
      </div>
    )
  }

  const k = m.computeKpis(ym)
  const be = m.breakEven(ym)
  const cm = m.contributionMarginExPayroll(ym)
  const burn3 = m.trailingBurn(ym, 3)
  const win = m.expenseWindow(ym)

  return (
    <>
      <div className="kpis">
        <Kpi label="Net profit" value={moneyShort(k.net)} tone={netTone(k.net)}
          deltas={<Delta pct={k.netMoM} upIsGood suffix="MoM" />} note={ymLabel(ym)} />
        <Kpi label="Net margin" value={k.margin !== null ? pct1(k.margin) : '—'}
          tone={k.margin !== null ? (k.margin >= 0 ? 'good' : 'bad') : undefined} note="net ÷ revenue" />
        <Kpi label="Contribution margin" value={cm !== null ? pct1(cm) : '—'} note="excluding payroll" />
        <Kpi label="Average burn, 3 months" value={burn3 > 0 ? moneyShort(burn3) : '$0'}
          tone={burn3 > 0 ? 'bad' : 'good'} note="average monthly net loss" />
        <Kpi label="Path to break-even" value={be.gap > 0 ? moneyShort(be.gap) : 'Profitable'}
          tone={be.gap > 0 ? 'warn' : 'good'}
          note={be.gap > 0 ? 'more revenue needed a month' : `${money(-be.gap)} above break-even`} />
      </div>

      <Panel title="Net profit and margin by month" note="Net as bars, margin as the line on the right-hand axis.">
        <TrendChart
          points={toPoints(win)}
          series={[
            {
              key: 'net', name: 'Net', kind: 'bar', values: win.map(m.netOf),
              colorBy: v => (v >= 0 ? 'var(--good)' : 'var(--danger)'),
            },
            { key: 'margin', name: 'Margin', kind: 'line', axis: 'right', color: 'var(--cobalt)', values: win.map(m.marginAt) },
          ]}
          format={fmtMoney}
          rightFormat={fmtPct}
          empty="No months with both revenue and expenses."
          highlight={ym}
        />
      </Panel>

      <Panel title={`Path to break-even: ${ymLabel(ym)}`}>
        <BarRows
          rows={[
            { key: 'rev', label: 'Revenue', value: be.revenue },
            { key: 'exp', label: 'Expenses', value: be.expenses },
          ]}
          format={money}
          empty="Nothing booked this month."
        />
        <p className="note frep__after">
          {be.gap > 0
            ? `Expenses exceed revenue by ${money(be.gap)}: revenue must rise (or expenses fall) by that much to break even.`
            : `Revenue covers expenses with ${money(-be.gap)} to spare.`}
        </p>
      </Panel>
    </>
  )
}
