import { useState } from 'react'

/*
 * Vertical stacked columns: the form for a quantity along an ORDERED axis - weeks in
 * sequence, hours of the clock, days of the week.
 *
 * Columns rather than rows here for the opposite reason `BarRows` uses rows: time reads
 * left to right, and a reader comparing week to week is looking for a trend line in the
 * tops of the bars. That only works when the axis runs horizontally.
 *
 * A zero column is DRAWN, as a hairline on the baseline, never skipped. A week with
 * nothing logged is itself an answer, and a chart that quietly omits it turns a gap in
 * the work into a gap in the axis - which reads as continuous activity that never
 * happened.
 */

export interface Column {
  key: string
  /** Under the axis. Kept short; use `title` for the full thing. */
  label: string
  /** The full description, for the tooltip and the accessible name. */
  title: string
  value: number
  /** The billable part of `value`. Omit for an unsplit column. */
  split?: number
  /** Marked out - the current, incomplete week. */
  partial?: boolean
}

interface Props {
  columns: Column[]
  format: (n: number) => string
  empty: string
  splitLabels?: [string, string]
  /** Draw every Nth label when they would otherwise collide. */
  labelEvery?: number
  height?: number
}

export default function ColumnChart({
  columns, format, empty, splitLabels, labelEvery = 1, height = 150,
}: Props) {
  const [hover, setHover] = useState<string>('')

  if (!columns.length) return <p className="muted chart__empty">{empty}</p>

  const max = Math.max(...columns.map(c => c.value)) || 1
  const split = columns.some(c => c.split !== undefined)
  const active = columns.find(c => c.key === hover)

  return (
    <div className="cols">
      {split && splitLabels && (
        <p className="legend" role="list">
          <span className="legend__i" role="listitem">
            <span className="legend__sw legend__sw--a" aria-hidden="true" />{splitLabels[0]}
          </span>
          <span className="legend__i" role="listitem">
            <span className="legend__sw legend__sw--b" aria-hidden="true" />{splitLabels[1]}
          </span>
        </p>
      )}

      {/*
        One tooltip slot above the plot rather than a floating layer per column: the
        plot is short and the slot is always reserved, so nothing reflows on hover and
        the value never covers the bar it belongs to.
      */}
      <p className="cols__read" aria-live="polite">
        {active
          ? <>
              <strong>{format(active.value)}</strong>
              <span className="muted"> · {active.title}</span>
              {active.split !== undefined && (
                <span className="muted"> · {format(active.split)} billable</span>
              )}
            </>
          : <span className="muted">Hover a column for its detail.</span>}
      </p>

      <div className="cols__plot" style={{ height }} onMouseLeave={() => setHover('')}>
        {columns.map((c, i) => {
          const billable = c.split === undefined ? 0 : c.split
          const rest = c.value - billable
          // A real zero still gets a visible hairline, so the column exists on the axis.
          const pct = c.value > 0 ? Math.max((c.value / max) * 100, 1.5) : 0
          const label = c.split === undefined
            ? `${c.title}: ${format(c.value)}`
            : `${c.title}: ${format(c.value)} — ${format(billable)} billable, ${format(rest)} not`

          return (
            <div
              key={c.key}
              className="cols__c"
              data-hover={hover === c.key ? '' : undefined}
              onMouseEnter={() => setHover(c.key)}
              onFocus={() => setHover(c.key)}
              tabIndex={0}
              role="img"
              aria-label={label}
              title={label}
            >
              <div className="cols__stack">
                {c.value > 0 ? (
                  <div
                    className="cols__fill"
                    style={{ height: `${pct}%` }}
                    data-partial={c.partial ? '' : undefined}
                  >
                    {/*
                      A ternary, not three independent guards. With guards, an UNSPLIT
                      column (`split === undefined`, so `billable` is 0 and `rest` is the
                      whole value) satisfied both the `rest > 0` branch and the unsplit
                      branch, and rendered a full magenta bar with a blue sliver under
                      it - a single-series chart painted in the two-series colours.
                    */}
                    {c.split === undefined ? (
                      <span className="cols__seg cols__seg--a" style={{ flexGrow: 1 }} />
                    ) : (
                      <>
                        {rest > 0 && (
                          <span className="cols__seg cols__seg--b" style={{ flexGrow: rest }} />
                        )}
                        {billable > 0 && (
                          <span className="cols__seg cols__seg--a" style={{ flexGrow: billable }} />
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="cols__zero" aria-hidden="true" />
                )}
              </div>
              <span className="cols__lab">
                {i % labelEvery === 0 ? c.label : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
