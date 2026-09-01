import { useState } from 'react'

/*
 * Weekday x hour-of-day, as a single-hue intensity grid.
 *
 * Sequential, so ONE hue light-to-dark - never a rainbow. The steps are mixed from the
 * brand hue into the panel surface with `color-mix`, which makes the ramp monotonic in
 * lightness by construction and correct in both themes from one definition: in light
 * mode it runs pale-to-saturated on white, in dark mode surface-to-saturated on the
 * dark panel, with no second hardcoded ramp to keep in step.
 *
 * An empty cell is drawn as the surface itself rather than as the palest step, so
 * "nobody worked then" is visibly different from "somebody worked a little".
 */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface Props {
  /** minutes[day 0=Mon..6=Sun][hour 0..23] */
  minutes: number[][]
  format: (n: number) => string
  /** Hours outside this range collapse into an edge column, to keep 24 columns legible
   *  on a laptop without hiding the 2am session that is the interesting part. */
  empty: string
}

export default function HeatGrid({ minutes, format, empty }: Props) {
  const [cell, setCell] = useState<{ d: number; h: number } | null>(null)

  let max = 0
  let total = 0
  for (const row of minutes) for (const v of row) { if (v > max) max = v; total += v }
  if (!total) return <p className="muted chart__empty">{empty}</p>

  const active = cell ? minutes[cell.d][cell.h] : 0

  return (
    <div className="heat">
      <p className="heat__read" aria-live="polite">
        {cell && active > 0 ? (
          <>
            <strong>{format(active)}</strong>
            <span className="muted">
              {' '}· {DAYS[cell.d]} at {String(cell.h).padStart(2, '0')}:00
            </span>
          </>
        ) : cell ? (
          <span className="muted">
            Nothing logged {DAYS[cell.d]} at {String(cell.h).padStart(2, '0')}:00
          </span>
        ) : (
          <span className="muted">Hover a cell for its hours.</span>
        )}
      </p>

      <div className="heat__g" onMouseLeave={() => setCell(null)}>
        <span className="heat__corner" />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={`h${h}`} className="heat__h">
            {/* Every third hour, or 24 two-digit labels collide at laptop width. */}
            {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}

        {DAYS.map((day, d) => (
          <span key={day} className="heat__row" style={{ display: 'contents' }}>
            <span className="heat__d">{day}</span>
            {minutes[d].map((v, h) => {
              // Square-rooted, so a busy hour does not flatten every moderate one to
              // near-invisible. Intensity is a reading aid, and the tooltip carries the
              // number for anyone who needs the exact figure.
              const pct = v > 0 ? Math.round(Math.sqrt(v / max) * 88) + 12 : 0
              const label = v > 0
                ? `${day} ${String(h).padStart(2, '0')}:00 — ${format(v)}`
                : `${day} ${String(h).padStart(2, '0')}:00 — nothing`
              return (
                <span
                  key={`${d}-${h}`}
                  className="heat__c"
                  data-on={v > 0 ? '' : undefined}
                  data-hover={cell && cell.d === d && cell.h === h ? '' : undefined}
                  style={v > 0
                    ? { background: `color-mix(in srgb, var(--cobalt) ${pct}%, var(--bg-panel))` }
                    : undefined}
                  title={label}
                  aria-label={label}
                  role="img"
                  onMouseEnter={() => setCell({ d, h })}
                />
              )
            })}
          </span>
        ))}
      </div>

      <p className="heat__scale">
        <span className="muted">less</span>
        {[12, 34, 56, 78, 100].map(p => (
          <span
            key={p}
            className="heat__sw"
            style={{ background: `color-mix(in srgb, var(--cobalt) ${p}%, var(--bg-panel))` }}
            aria-hidden="true"
          />
        ))}
        <span className="muted">more · up to {format(max)} in one hour</span>
      </p>
    </div>
  )
}
