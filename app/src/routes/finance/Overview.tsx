import { Link } from 'react-router-dom'
import TrendChart from '../../components/TrendChart'
import { yearAgo, moneyShort, pct1, ymLabel } from '../../lib/finance'
import { SEV_TONE, grrTone, ndrTone, netTone, newMrrTone, type Model } from './compute'
import { Delta, Kpi, Panel, Pill, fmtMoney, toPoints } from './ui'

export interface TabProps {
  m: Model
  ym: string
  /** The search string for a link that changes some report params, keeping the rest. */
  href: (patch: Record<string, string | null>) => string
}

/** The four most urgent alerts, and the way into the rest. */
export function AlertStrip({ m, ym, href }: TabProps) {
  const alerts = m.evaluateAlerts(ym)
  if (!alerts.length) {
    return (
      <p className="frep__alerts">
        <Pill tone="good">All clear</Pill>
        <span className="muted">No active alerts for {ymLabel(ym)}.</span>
      </p>
    )
  }
  return (
    <p className="frep__alerts">
      {alerts.slice(0, 4).map(a => (
        <Pill key={a.title} tone={SEV_TONE[a.severity]}>{a.title}</Pill>
      ))}
      <Link className="inlink frep__more" to={{ search: href({ tab: 'actions', client: null }) }}>
        View all {alerts.length} →
      </Link>
    </p>
  )
}

export function KpiStrip({ m, ym }: { m: Model; ym: string }) {
  const k = m.computeKpis(ym)
  return (
    <div className="kpis">
      <Kpi label="Recurring revenue" value={moneyShort(k.mrr)}
        deltas={<><Delta pct={k.mrrYoY} upIsGood suffix="YoY" /><Delta pct={k.mrrMoM} upIsGood suffix={m.w.vs} /></>}
        note={`${k.activeCustomers} active customers`} />
      <Kpi label="Net profit" value={moneyShort(k.net)} tone={netTone(k.net, m.scale)}
        deltas={<Delta pct={k.netMoM} upIsGood suffix={m.w.vs} />}
        note={k.margin !== null ? `${pct1(k.margin)} margin` : undefined} />
      <Kpi label="Net dollar retention" value={k.ndr !== null ? pct1(k.ndr) : '—'} tone={ndrTone(k.ndr)}
        note={k.ndr !== null ? `vs ${ymLabel(yearAgo(ym))}, incl. expansion` : 'no prior-year cohort'} />
      <Kpi label="Gross retention" value={k.grr !== null ? pct1(k.grr) : '—'} tone={grrTone(k.grr)}
        note={k.logoRet !== null ? `${k.logoKept} of ${k.logoBase} accounts kept (${pct1(k.logoRet)})` : 'no prior-year cohort'} />
      <Kpi label={`New ${m.w.rr}`} value={moneyShort(k.newMrr)} tone={newMrrTone(k.newMrr, m.scale)}
        note={`${k.newLines} new line${k.newLines === 1 ? '' : 's'}`} />
      <Kpi label={`${m.w.ly} expenses`} value={moneyShort(k.expenses)}
        deltas={<Delta pct={k.expMoM} upIsGood={false} suffix={m.w.vs} />}
        note="incl. payroll & platform" />
      <Kpi label={`${m.w.ly} burn`} value={k.burn > 0 ? moneyShort(k.burn) : '$0'} tone={k.burn > 0 ? 'bad' : 'good'}
        note={k.burn > 0 ? 'net cash loss' : 'net positive'} />
    </div>
  )
}

export default function Overview(props: TabProps) {
  const { m, ym } = props
  const win = m.trailing(ym, 24)
  return (
    <>
      <AlertStrip {...props} />
      <KpiStrip m={m} ym={ym} />

      <section className="tcard frep__story">
        <h2 className="visually-hidden">In a sentence</h2>
        <p>{m.buildNarrative(ym).join(' ')}</p>
      </section>

      <Panel
        title={`Revenue, expenses and net: trailing ${m.spanLabel(24)}`}
        note={m.earliestExpMonth
          ? `The expense export starts ${ymLabel(m.earliestExpMonth)}, so expenses and net begin there rather than at $0.`
          : 'No expense export is attached, so only revenue is drawn.'}
      >
        <TrendChart
          points={toPoints(win)}
          series={[
            { key: 'rev', name: 'Revenue', kind: 'line', color: 'var(--good)', values: win.map(m.revTotal) },
            {
              key: 'exp', name: 'Expenses', kind: 'line', color: 'var(--danger)',
              values: win.map(x => (m.hasExpenseData(x) ? m.expTotal(x) : null)),
            },
            {
              key: 'net', name: 'Net', kind: 'line', color: 'var(--cobalt)', dashed: true,
              values: win.map(x => (m.hasExpenseData(x) ? m.netOf(x) : null)),
            },
          ]}
          format={fmtMoney}
          empty={`No ${m.w.unit}s to draw.`}
          highlight={ym}
        />
      </Panel>
    </>
  )
}
