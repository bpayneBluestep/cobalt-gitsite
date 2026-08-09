/*
 * Duration parsing and the live clock.
 *
 * Logging time is the thing people skip when it's fiddly, so the input takes what
 * anyone would actually type — `90`, `90m`, `1.5h`, `1h30m` — rather than making
 * them pick a unit from a dropdown first.
 */

/** Minutes from a typed duration, or null if it isn't one. */
export function parseDuration(input: string): number | null {
  const s = String(input || '').trim().toLowerCase()
  if (!s) return null

  // "1h30m" / "1h 30m" / "1h" / "30m"
  const combined = /^(\d+(?:\.\d+)?)\s*h(?:ours?)?(?:\s*(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?$/.exec(s)
  if (combined) {
    const hours = Number(combined[1])
    const mins = combined[2] ? Number(combined[2]) : 0
    const total = Math.round(hours * 60 + mins)
    return total > 0 ? total : null
  }

  // "45m"
  const minutesOnly = /^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/.exec(s)
  if (minutesOnly) {
    const total = Math.round(Number(minutesOnly[1]))
    return total > 0 ? total : null
  }

  // A bare number is minutes — the unit people mean when they don't say.
  const bare = /^(\d+(?:\.\d+)?)$/.exec(s)
  if (bare) {
    const total = Math.round(Number(bare[1]))
    return total > 0 ? total : null
  }

  return null
}

/**
 * Minutes elapsed since an ISO instant, computed client-side so a running timer
 * ticks without polling the server. The server remains the authority: it recomputes
 * from the same start when the timer stops.
 */
export function elapsedSince(iso: string): number {
  if (!iso) return 0
  const started = Date.parse(iso)
  if (!isFinite(started)) return 0
  const mins = Math.floor((Date.now() - started) / 60000)
  return mins > 0 ? mins : 0
}

/** Today as yyyy-mm-dd in the viewer's own timezone, for date inputs. */
export function todayISO(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * "just now" / "14 min ago" / "3 hours ago" / "9 Aug, 14:32" — how an activity line
 * is stamped.
 *
 * Relative for the recent past because that is how people talk about a ticket they are
 * working on today, and absolute past a day because "37 days ago" is arithmetic nobody
 * asked for. The full instant is always available as a title attribute.
 */
export function whenLabel(iso: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (!isFinite(then)) return iso

  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`

  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`

  const d = new Date(then)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const day = `${d.getDate()} ${months[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`
  return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The full instant, for a tooltip on a relative label. */
export function whenExact(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  return isFinite(t) ? new Date(t).toLocaleString() : iso
}
