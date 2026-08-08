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
