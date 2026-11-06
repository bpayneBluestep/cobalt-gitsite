import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { SERIES } from '../pigments'

/*
 * Several quantities over the same ordered axis - months, usually - drawn as lines,
 * stacked bars, or both, with an optional secondary axis for a ratio (margin %).
 *
 * The finance report needs what `ColumnChart` deliberately does not do: more than two
 * series, values below zero, and a percentage plotted against money. So this is a real
 * SVG plot with axes, where ColumnChart is a flex row of divs. The house rules carry
 * over unchanged: hand-built, a reserved readout slot instead of a floating tooltip,
 * zeros drawn, and every number reachable by keyboard and screen reader.
 *
 * Two distinctions this chart is built around:
 *  - `null` is NOT zero. A month with no file uploaded yet is a gap (the line breaks,
 *    the bar is absent); a month that genuinely booked $0 is a point on the baseline.
 *    Drawing the gap as zero would show a collapse in revenue that never happened.
 *  - Both axes include 0. A money axis that starts at $80k turns a 5% dip into a cliff,
 *    and the readers of this chart make decisions on the size of the dip.
 */

export interface TrendPoint {
  key: string
  /** Under the axis, kept short ('Aug 26'). */
  label: string
  /** The full description, for the readout and the accessible name ('Aug 2026'). */
  title: string
}

export interface TrendSeries {
  key: string
  /** Legend + readout. */
  name: string
  /** Aligned with `points`. `null` = no data (line breaks, bar omitted) - not zero. */
  values: (number | null)[]
  /** All bar series stack together per point: positives up from 0, negatives down. */
  kind: 'line' | 'bar'
  /** Any CSS colour, including `var(--good)`. Default: the next series pigment. */
  color?: string
  /** Line only. For a target, a forecast, a prior year: the "not actual" line. */
  dashed?: boolean
  /** `right` = the secondary axis (a percentage), formatted with `rightFormat`. */
  axis?: 'left' | 'right'
  /** Bar only: a colour per value, e.g. net green at >= 0 and red below. */
  colorBy?: (v: number) => string
}

interface Props {
  points: TrendPoint[]
  series: TrendSeries[]
  /** Left axis and readout formatter (money). */
  format: (n: number) => string
  /** Right axis and readout formatter for `axis: 'right'` series (percent). */
  rightFormat?: (n: number) => string
  /** Shown when there are no points. An empty chart must say why. */
  empty: string
  height?: number
  /** Draw every Nth x label. Default: as many as fit the measured width. */
  labelEvery?: number
  /** Default: true when the domain crosses 0. */
  zeroLine?: boolean
  /** A point key to mark with a faint band - the month the page is looking at. */
  highlight?: string
}

const PAD_TOP = 10
const PAD_BOTTOM = 22
/* Approximate advance of one tick-label character at the 10px axis size. Measuring real
   text would need a render pass; tick labels are short and numeric, so this is close
   enough to keep "$1.2M" from clipping without reserving space for nothing. */
const CHAR_W = 6
/* Below this many pixels per x label, labels start to collide ("Aug 26" is ~36px). */
const LABEL_MIN_PX = 46

/** 1, 2, 2.5 or 5 x a power of ten: the steps a person can add up in their head. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / mag
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return n * mag
}

interface Scale { lo: number; hi: number; step: number }

/*
 * Ticks for one axis, or for both at once. With a right axis the two are built on the
 * SAME number of steps below and above zero, so their zeros sit on one line and the
 * gridlines serve both. Two independent nice scales put "0%" a few pixels off "$0",
 * and a margin line that crosses the money zero line at +3% reads as a lie.
 */
function buildScales(
  left: [number, number],
  right: [number, number] | null,
): { l: Scale; r: Scale | null } {
  const span = (d: [number, number]) => (d[1] - d[0]) || Math.abs(d[1]) || 1
  const up = (x: number) => Math.max(0, Math.ceil(x - 1e-9))
  let best: { l: Scale; r: Scale | null } | null = null
  // Aim for 4 steps; fall back to coarser ones when aligning the two axes pushes the
  // count past 6, which is where a short chart turns into a ruled notebook page.
  for (const target of [4, 3, 2]) {
    const sl = niceStep(span(left) / target)
    const sr = right ? niceStep(span(right) / target) : 0
    let below = up(-left[0] / sl)
    let above = up(left[1] / sl)
    if (right) {
      below = Math.max(below, up(-right[0] / sr))
      above = Math.max(above, up(right[1] / sr))
    }
    if (below + above === 0) above = 1
    best = {
      l: { lo: -below * sl, hi: above * sl, step: sl },
      r: right ? { lo: -below * sr, hi: above * sr, step: sr } : null,
    }
    if (below + above <= 6) break
  }
  return best!
}

function ticks(s: Scale): number[] {
  const out: number[] = []
  const n = Math.round((s.hi - s.lo) / s.step)
  for (let i = 0; i <= n; i++) out.push(s.lo + i * s.step)
  return out
}

/** Width of the container, so one SVG unit is one CSS pixel and text never scales. */
function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(initial)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const next = Math.round(entries[0].contentRect.width)
      if (next > 0) setW(next)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export default function TrendChart({
  points, series, format, rightFormat, empty, height = 220, labelEvery, zeroLine, highlight,
}: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const [wrapRef, width] = useWidth(640)
  const hitRefs = useRef<(SVGRectElement | null)[]>([])

  if (!points.length) return <p className="muted chart__empty">{empty}</p>

  const n = points.length
  const fmtR = rightFormat ?? format
  const colorOf = series.map((s, i) => s.color ?? SERIES[i % SERIES.length])
  const isRight = (s: TrendSeries) => s.axis === 'right'
  const hasRight = series.some(isRight)
  const hasLeft = series.some(s => !isRight(s))

  // Domains: every line value, plus each point's positive and negative bar stack per
  // axis (the stack total is what reaches the edge, not the individual segment).
  const dom = { left: [0, 0] as [number, number], right: [0, 0] as [number, number] }
  for (let i = 0; i < n; i++) {
    const stack = { left: [0, 0], right: [0, 0] }
    for (const s of series) {
      const v = s.values[i]
      if (v == null || !Number.isFinite(v)) continue
      const ax = isRight(s) ? 'right' : 'left'
      if (s.kind === 'bar') {
        if (v >= 0) stack[ax][1] += v
        else stack[ax][0] += v
      } else {
        dom[ax][0] = Math.min(dom[ax][0], v)
        dom[ax][1] = Math.max(dom[ax][1], v)
      }
    }
    for (const ax of ['left', 'right'] as const) {
      dom[ax][0] = Math.min(dom[ax][0], stack[ax][0])
      dom[ax][1] = Math.max(dom[ax][1], stack[ax][1])
    }
  }
  const { l: sl, r: sr } = buildScales(dom.left, hasRight ? dom.right : null)
  const lTicks = ticks(sl)
  const rTicks = sr ? ticks(sr) : []

  // Margins sized to the widest tick label actually drawn.
  const widest = (ts: number[], f: (x: number) => string) =>
    Math.max(0, ...ts.map(t => f(t).length)) * CHAR_W
  const padL = hasLeft ? widest(lTicks, format) + 12 : 8
  const padR = hasRight ? widest(rTicks, fmtR) + 12 : 8
  const plotW = Math.max(width - padL - padR, 40)
  const plotH = Math.max(height - PAD_TOP - PAD_BOTTOM, 40)
  const band = plotW / n
  const cx = (i: number) => padL + band * (i + 0.5)
  const yOf = (s: Scale) => (v: number) => PAD_TOP + plotH * (1 - (v - s.lo) / (s.hi - s.lo))
  const yL = yOf(sl)
  const yR = sr ? yOf(sr) : yL
  const yFor = (s: TrendSeries) => (isRight(s) ? yR : yL)

  const every = labelEvery ?? Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / LABEL_MIN_PX))))
  const crosses = sl.lo < 0 && sl.hi > 0
  const showZero = zeroLine ?? crosses
  const hiIdx = highlight ? points.findIndex(p => p.key === highlight) : -1
  // With nothing hovered, the readout shows the highlighted point (else the latest), so
  // the slot is never a prompt and the page's own month is readable without a mouse.
  const active = hover ?? (hiIdx >= 0 ? hiIdx : n - 1)
  const barW = Math.min(band * 0.62, 30)
  const bars = series.filter(s => s.kind === 'bar')
  const lines = series.filter(s => s.kind === 'line')
  const markers = n <= 36

  const valueText = (s: TrendSeries, v: number) => (isRight(s) ? fmtR(v) : format(v))
  const fillFor = (s: TrendSeries, v: number) =>
    s.colorBy ? s.colorBy(v) : colorOf[series.indexOf(s)]
  const readout = (i: number) =>
    series
      .map(s => ({ s, v: s.values[i] }))
      .filter((r): r is { s: TrendSeries; v: number } => r.v != null && Number.isFinite(r.v))
  const ariaFor = (i: number) => {
    const rows = readout(i)
    return rows.length
      ? `${points[i].title}: ${rows.map(r => `${r.s.name} ${valueText(r.s, r.v)}`).join(', ')}`
      : `${points[i].title}: no data`
  }

  // One tab stop for the whole chart, arrows to walk it: twenty-four tab stops per chart
  // on a page of six charts is a keyboard trap in all but name.
  const onKey = (e: KeyboardEvent, i: number) => {
    const next =
      e.key === 'ArrowRight' ? Math.min(i + 1, n - 1)
      : e.key === 'ArrowLeft' ? Math.max(i - 1, 0)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : null
    if (next === null) return
    e.preventDefault()
    setHover(next)
    hitRefs.current[next]?.focus()
  }

  const rows = readout(active)

  return (
    <div className="trend" ref={wrapRef}>
      {series.length > 1 && (
        <p className="legend" role="list">
          {series.map((s, si) => (
            <span key={s.key} className="legend__i" role="listitem">
              {s.kind === 'line' ? (
                <span
                  className="trend__swl"
                  data-dashed={s.dashed ? '' : undefined}
                  style={{ borderColor: colorOf[si] }}
                  aria-hidden="true"
                />
              ) : (
                <span
                  className="legend__sw"
                  // A colour-by-value series has no one colour: show both halves.
                  style={{
                    background: s.colorBy
                      ? `linear-gradient(135deg, ${s.colorBy(1)} 50%, ${s.colorBy(-1)} 50%)`
                      : colorOf[si],
                  }}
                  aria-hidden="true"
                />
              )}
              {s.name}
              {isRight(s) && <span className="muted"> (right)</span>}
            </span>
          ))}
        </p>
      )}

      <p className="trend__read" aria-live="polite">
        <strong>{points[active].title}</strong>
        {rows.length ? rows.map(({ s, v }) => (
          <span key={s.key} className="trend__rv">
            <span
              className="trend__dot"
              style={{ background: fillFor(s, v) }}
              aria-hidden="true"
            />
            <span className="muted">{s.name}</span> {valueText(s, v)}
          </span>
        )) : <span className="muted trend__rv">No data</span>}
      </p>

      <svg
        className="trend__svg"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        onMouseLeave={() => setHover(null)}
      >
        {hiIdx >= 0 && (
          <rect
            className="trend__band"
            x={padL + band * hiIdx}
            y={PAD_TOP}
            width={band}
            height={plotH}
          />
        )}

        {lTicks.map(t => (
          <g key={t}>
            <line
              className={Math.abs(t) < 1e-9 && showZero ? 'trend__zero' : 'trend__grid'}
              x1={padL} x2={padL + plotW} y1={yL(t)} y2={yL(t)}
            />
            {hasLeft && (
              <text className="trend__ax" x={padL - 6} y={yL(t)} textAnchor="end" dy="0.32em">
                {format(t)}
              </text>
            )}
          </g>
        ))}
        {sr && rTicks.map(t => (
          <text
            key={`r${t}`}
            className="trend__ax"
            x={padL + plotW + 6}
            y={yR(t)}
            textAnchor="start"
            dy="0.32em"
          >
            {fmtR(t)}
          </text>
        ))}
        {/* The baseline: the bottom edge of the plot, drawn even when 0 is above it. */}
        <line className="trend__base" x1={padL} x2={padL + plotW} y1={PAD_TOP + plotH} y2={PAD_TOP + plotH} />

        {points.map((p, i) => (
          i % every === 0 && (
            <text key={p.key} className="trend__ax" x={cx(i)} y={height - 6} textAnchor="middle">
              {p.label}
            </text>
          )
        ))}

        {/* Bars first, so lines always sit on top of them. */}
        {bars.length > 0 && points.map((p, i) => {
          const acc = { left: [0, 0], right: [0, 0] }
          let any = false
          const segs = bars.map(s => {
            const v = s.values[i]
            if (v == null || !Number.isFinite(v)) return null
            any = true
            if (v === 0) return null
            const ax = isRight(s) ? 'right' : 'left'
            const y = yFor(s)
            const side = v > 0 ? 1 : 0
            const from = acc[ax][side]
            const to = from + v
            acc[ax][side] = to
            return (
              <rect
                key={s.key}
                className="trend__bar"
                x={cx(i) - barW / 2}
                width={barW}
                y={Math.min(y(from), y(to))}
                height={Math.max(Math.abs(y(to) - y(from)), 1)}
                style={{ fill: fillFor(s, v) }}
              />
            )
          })
          const drawn = segs.some(Boolean)
          return (
            <g key={p.key} data-hover={hover === i ? '' : undefined} className="trend__stack">
              {segs}
              {/* A real zero, drawn as a hairline on the zero line: "booked nothing"
                  is an answer, and an empty slot would read as "no data". */}
              {any && !drawn && (
                <rect
                  className="trend__nil"
                  x={cx(i) - barW / 2}
                  width={barW}
                  y={yL(0) - 1}
                  height={2}
                />
              )}
            </g>
          )
        })}

        {lines.map(s => {
          const si = series.indexOf(s)
          const y = yFor(s)
          let d = ''
          let pen = false
          s.values.forEach((v, i) => {
            if (v == null || !Number.isFinite(v)) { pen = false; return }
            d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)} ${y(v).toFixed(1)}`
            pen = true
          })
          return (
            <g key={s.key} style={{ color: colorOf[si] }}>
              <path
                className="trend__line"
                d={d}
                strokeDasharray={s.dashed ? '5 4' : undefined}
              />
              {s.values.map((v, i) => {
                if (v == null || !Number.isFinite(v)) return null
                // An isolated point between two gaps has no segment, so it always gets a
                // marker: otherwise a lone month of data would be invisible.
                const lone = (i === 0 || s.values[i - 1] == null) && (i === n - 1 || s.values[i + 1] == null)
                if (!markers && !lone && hover !== i) return null
                return (
                  <circle
                    key={i}
                    className="trend__pt"
                    cx={cx(i)}
                    cy={y(v)}
                    r={hover === i ? 4.5 : 3}
                  />
                )
              })}
            </g>
          )
        })}

        {hover !== null && (
          <line className="trend__guide" x1={cx(hover)} x2={cx(hover)} y1={PAD_TOP} y2={PAD_TOP + plotH} />
        )}

        {/* Hit areas last, so they sit over everything and the whole column answers. */}
        {points.map((p, i) => (
          <rect
            key={p.key}
            ref={el => { hitRefs.current[i] = el }}
            className="trend__hit"
            x={padL + band * i}
            y={PAD_TOP}
            width={band}
            height={plotH}
            tabIndex={i === active ? 0 : -1}
            role="img"
            aria-label={ariaFor(i)}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onKeyDown={e => onKey(e, i)}
          >
            <title>{ariaFor(i)}</title>
          </rect>
        ))}
      </svg>
    </div>
  )
}
