import { useState } from 'react'

/*
 * A labelled horizontal bar list: the form for magnitude-by-identity.
 *
 * Rows rather than columns because the labels are names - "Community House Mental
 * Health", "Gustavo Luz Oliveira Bispo" - and a vertical bar chart either truncates
 * those or rotates them 45 degrees, which is the single most common way a chart of
 * clients becomes unreadable. Sorted descending, so rank is the reading order.
 *
 * Each row can carry a split (billable / not). The two segments get a 2px surface gap
 * between them so they read as two quantities rather than one bar with a colour change,
 * and only the outer end is rounded - the fill is anchored to its baseline, which is
 * what makes the length comparable across rows.
 */

export interface BarRow {
  key: string
  label: string
  /** Total for the row; the bar length. */
  value: number
  /** The part of `value` that is billable. Omit for an unsplit bar. */
  split?: number
  /** Rendered after the label in muted ink - a client name, a role, "no longer staff". */
  meta?: string
  /** Where clicking the label goes, if anywhere. */
  to?: string
  /** Dimmed and marked: present in the data but not one of us. */
  faded?: boolean
}

interface Props {
  rows: BarRow[]
  /** Formats a value for display. Hours, usually. */
  format: (n: number) => string
  /** Shown when there is nothing to draw. An empty chart must say why. */
  empty: string
  /** Cap the rows drawn; the rest collapse behind a "show all". */
  limit?: number
  /** Labels for the two segments. Only used when any row carries a `split`. */
  splitLabels?: [string, string]
  onPick?: (key: string) => void
  activeKey?: string
}

export default function BarRows({
  rows, format, empty, limit = 12, splitLabels, onPick, activeKey,
}: Props) {
  const [showAll, setShowAll] = useState(false)

  if (!rows.length) return <p className="muted chart__empty">{empty}</p>

  const sorted = rows.slice().sort((a, b) => b.value - a.value)
  const shown = showAll ? sorted : sorted.slice(0, limit)
  const hidden = sorted.length - shown.length
  // Scaled to the largest row, not to the total: this compares rows with each other,
  // and scaling to the total would flatten every bar into the left margin as soon as
  // there are more than a handful.
  const max = sorted[0].value || 1
  const grandTotal = sorted.reduce((n, r) => n + r.value, 0) || 1
  const split = rows.some(r => r.split !== undefined)

  return (
    <div className="bars">
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

      <ul className="bars__l">
        {shown.map(r => {
          const billable = r.split === undefined ? 0 : r.split
          const rest = r.value - billable
          const pct = (r.value / max) * 100
          const share = (r.value / grandTotal) * 100
          const title = r.split === undefined
            ? `${r.label}: ${format(r.value)} (${share.toFixed(1)}% of the total)`
            : `${r.label}: ${format(r.value)} — ${format(billable)} billable, ` +
              `${format(rest)} not (${share.toFixed(1)}% of the total)`

          return (
            <li
              key={r.key}
              className="bars__r"
              data-faded={r.faded ? '' : undefined}
              data-active={activeKey === r.key ? '' : undefined}
            >
              <button
                type="button"
                className="bars__lab"
                onClick={onPick ? () => onPick(r.key) : undefined}
                disabled={!onPick}
                title={onPick ? `Filter to ${r.label}` : undefined}
              >
                <span className="bars__name">{r.label}</span>
                {r.meta && <span className="bars__meta">{r.meta}</span>}
              </button>

              {/* role="img" with the full sentence as its label: the bar is a picture of
                  a number, and a screen reader should get the number, not the geometry. */}
              <span className="bars__track" role="img" aria-label={title} title={title}>
                <span className="bars__fill" style={{ width: `${pct}%` }}>
                  {r.split === undefined ? (
                    <span className="bars__seg bars__seg--a" style={{ flexGrow: 1 }} />
                  ) : (
                    <>
                      {billable > 0 && (
                        <span className="bars__seg bars__seg--a" style={{ flexGrow: billable }} />
                      )}
                      {rest > 0 && (
                        <span className="bars__seg bars__seg--b" style={{ flexGrow: rest }} />
                      )}
                    </>
                  )}
                </span>
              </span>

              <span className="bars__v">{format(r.value)}</span>
            </li>
          )
        })}
      </ul>

      {hidden > 0 && (
        <button type="button" className="linkbtn bars__more" onClick={() => setShowAll(true)}>
          Show all {sorted.length}
        </button>
      )}
      {showAll && sorted.length > limit && (
        <button type="button" className="linkbtn bars__more" onClick={() => setShowAll(false)}>
          Show top {limit}
        </button>
      )}
    </div>
  )
}
