import { ymLabel } from '../../lib/finance'
import { AREA_ORDER, SEV_LABEL, SEV_TONE, type Alert } from './compute'
import type { TabProps } from './Overview'
import { Panel, Pill } from './ui'

/** Every alert for the month, grouped by area, most severe first within each. */
export default function Actions({ m, ym }: TabProps) {
  const alerts = m.evaluateAlerts(ym)
  if (!alerts.length) {
    return (
      <div className="callout callout--plain">
        <p className="callout__title">All clear for {ymLabel(ym)}</p>
        <p>No metric is out of its band this month.</p>
      </div>
    )
  }
  const byArea = new Map<string, Alert[]>()
  for (const a of alerts) byArea.set(a.area, [...(byArea.get(a.area) ?? []), a])

  return (
    <>
      <p className="frep__intro">
        <strong>{alerts.length} item{alerts.length === 1 ? '' : 's'}</strong> need attention for {ymLabel(ym)}.
      </p>
      {AREA_ORDER.filter(area => byArea.has(area)).map(area => {
        const items = byArea.get(area)!
        return (
          <Panel key={area} title={<>{area} <span className="subnav__n">{items.length}</span></>}>
            <ul className="frep__acts">
              {items.map(a => (
                <li key={a.title} className="frep__act" data-tone={SEV_TONE[a.severity]}>
                  <p className="frep__act-t">
                    <Pill tone={SEV_TONE[a.severity]}>{SEV_LABEL[a.severity]}</Pill>
                    <strong>{a.title}</strong>
                  </p>
                  <p className="frep__act-d">{a.detail}</p>
                  <p className="frep__act-do">→ {a.action}</p>
                </li>
              ))}
            </ul>
          </Panel>
        )
      })}
    </>
  )
}
