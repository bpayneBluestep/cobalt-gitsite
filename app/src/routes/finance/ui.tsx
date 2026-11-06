import type { ReactNode } from 'react'
import { money, moneyShort, signedPct, ymLabel } from '../../lib/finance'
import type { TrendPoint } from '../../components/TrendChart'
import { ymShort, type Tone, type WfStep } from './compute'

/*
 * The Finance report's small shared pieces. Every one of them is an existing Cobalt
 * class wearing finance data: `.kpi` cards, `.tcard` panels, `.pill` badges. The only
 * new marks are the floating waterfall and the table sparkline, which nothing else in
 * Cobalt draws.
 */

/** Axis/readout formatters for TrendChart. */
export const fmtMoney = (n: number) => moneyShort(n)
export const fmtPct = (n: number) => `${Math.round(n)}%`

/** Month keys as TrendChart points: 'Aug 26' under the axis, 'Aug 2026' in the readout. */
export const toPoints = (months: string[]): TrendPoint[] =>
  months.map(m => ({ key: m, label: ymShort(m), title: ymLabel(m) }))

/** A month-over-month (or year-over-year) change, coloured by whether up is good. */
export function Delta({ pct, upIsGood, suffix }: { pct: number | null; upIsGood: boolean; suffix: string }) {
  if (pct === null) return null
  const up = pct > 0
  const tone: Tone = pct === 0 ? undefined : (upIsGood ? up : !up) ? 'good' : 'bad'
  return (
    <span className="frep__d" data-tone={tone}>
      <span aria-hidden="true">{up ? '▲' : pct < 0 ? '▼' : ''}</span> {signedPct(pct)} {suffix}
    </span>
  )
}

export function Kpi({ label, value, deltas, note, tone }: {
  label: string
  value: string
  deltas?: ReactNode
  note?: string
  tone?: Tone
}) {
  return (
    <div className="kpi" data-tone={tone}>
      <p className="kpi__k">{label}</p>
      <p className="kpi__v">{value}</p>
      {deltas && <p className="frep__ds">{deltas}</p>}
      {note && <p className="kpi__n">{note}</p>}
    </div>
  )
}

/** One report panel: a heading, an optional note, the content. */
export function Panel({ title, note, aside, children }: {
  title: ReactNode
  note?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="tcard">
      <div className="frep__ph">
        <h2 className="tcard__h">{title}</h2>
        {aside}
      </div>
      {note && <p className="note">{note}</p>}
      {children}
    </section>
  )
}

export function Pill({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className="pill" data-tone={tone}>{children}</span>
}

/** A signed dollar change in a table cell: green up, red down. */
export function MoneyDelta({ v, upIsGood = true }: { v: number; upIsGood?: boolean }) {
  const tone: Tone = v === 0 ? undefined : (v > 0) === upIsGood ? 'good' : 'bad'
  return <span className="frep__d" data-tone={tone}>{(v > 0 ? '+' : '') + money(v)}</span>
}

/**
 * A floating waterfall, drawn horizontally.
 *
 * Totals run from zero; each movement floats from the running total by its signed
 * amount. Horizontal because the step names ("Contraction") are words, and five
 * vertical bars with word labels is a chart that fits a laptop and not a phone.
 */
export function Waterfall({ steps, label }: { steps: WfStep[]; label: string }) {
  let running = 0
  const spans = steps.map(s => {
    if (s.kind === 'total') { running = s.value; return { s, from: 0, to: s.value } }
    const from = running
    running += s.value
    return { s, from, to: running }
  })
  const lo = Math.min(0, ...spans.map(x => Math.min(x.from, x.to)))
  const hi = Math.max(0, ...spans.map(x => Math.max(x.from, x.to))) || 1
  const pos = (v: number) => ((v - lo) / (hi - lo)) * 100

  return (
    <ul className="frep__wf" aria-label={label}>
      {spans.map(({ s, from, to }) => {
        const left = pos(Math.min(from, to))
        const width = Math.max(pos(Math.max(from, to)) - left, s.value === 0 ? 0 : 0.6)
        const kind = s.kind === 'total' ? 'total' : s.value >= 0 ? 'inc' : 'dec'
        const text = (s.kind === 'total' ? '' : s.value > 0 ? '+' : '') + money(s.value)
        return (
          <li key={s.label} className="frep__wfr" data-kind={s.kind}>
            <span className="frep__wfl">{s.label}</span>
            <span className="frep__wft" role="img" aria-label={`${s.label}: ${text}`}>
              <span className="frep__wfb" data-kind={kind} style={{ left: `${left}%`, width: `${width}%` }} />
            </span>
            <span className="frep__wfv">{text}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** A 12-month line in a table cell. Green if it ends at or above where it started. */
export function Spark({ values, label }: { values: number[]; label: string }) {
  if (!values.length) return null
  const w = 64, h = 20
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const n = values.length
  const pts = values.map((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * (w - 2) + 1 : w / 2
    const y = h - 1 - ((v - min) / range) * (h - 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const up = values[n - 1] >= values[0]
  return (
    <svg className="frep__spark" data-tone={up ? 'good' : 'bad'} width={w} height={h}
      viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <polyline points={pts} />
    </svg>
  )
}

/** "Needs the revenue export" in place of a tab that cannot be drawn. */
export function Needs({ what }: { what: string }) {
  return (
    <div className="callout callout--plain">
      <p className="callout__title">Nothing to show here yet</p>
      <p>This tab needs {what}. The note above the tabs says what is missing.</p>
    </div>
  )
}
