/*
 * Date arithmetic on plain yyyy-mm-dd strings, and the week the reports agree on.
 *
 * Lifted out of the Time Logging route when the Billable Time report needed the same
 * arithmetic. Two copies of "which Monday does this date belong to" is the kind of
 * duplication nobody notices until two reports quietly disagree about what a week is,
 * and then the disagreement is a fortnight old before anyone can prove it.
 *
 * Everything here works on strings rather than Date objects on purpose: the API speaks
 * yyyy-mm-dd, the URL carries yyyy-mm-dd, and a Date in the middle is one timezone away
 * from a bug at every hand-off.
 */

export const DAY_MS = 86400000

/*
 * Anchored to UTC NOON, not midnight.
 *
 * `new Date('2026-08-14')` parses as UTC midnight, and in any timezone west of
 * Greenwich that instant is the 13th locally - so a week bucket built from it lands a
 * day early for half the world and the weeks quietly shift by one. Noon leaves twelve
 * hours of slack in both directions, which no real offset crosses.
 */
export function asDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`)
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * The Monday of the week containing `iso`.
 *
 * Weeks are whole calendar weeks, Monday to Sunday, not a rolling seven days. "Last
 * week" is something people say about a calendar, and a rolling window cannot be
 * compared with the one before it.
 */
export function mondayOf(iso: string): string {
  const d = asDate(iso)
  const dow = (d.getUTCDay() + 6) % 7
  return toIso(new Date(d.getTime() - dow * DAY_MS))
}

export function addDays(iso: string, n: number): string {
  return toIso(new Date(asDate(iso).getTime() + n * DAY_MS))
}

/** "14 Aug" — short enough for an axis or a column head. */
export function shortDate(iso: string): string {
  const d = asDate(iso)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}

/** Today, as the reports mean it. */
export function todayIso(): string {
  return toIso(new Date())
}

/**
 * Every Monday from `from` to `to`, inclusive of the weeks those dates fall in.
 *
 * The columns of a week-by-something grid. Derived from the requested window rather
 * than from the data, so a week in which nobody logged anything is a visible zero
 * instead of a missing column - which on a billing report is the difference between
 * "we did no work" and "I forgot to check".
 */
export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = []
  let cursor = mondayOf(from)
  const last = mondayOf(to)
  // Bounded rather than while(true): a malformed date should render nothing, not hang
  // the page in a loop that never reaches its terminator.
  for (let i = 0; i < 520 && cursor <= last; i++) {
    out.push(cursor)
    cursor = addDays(cursor, 7)
  }
  return out
}

/** "11–17 Aug", the label for one week column. */
export function weekLabel(monday: string): string {
  return `${shortDate(monday)}–${shortDate(addDays(monday, 6))}`
}

/** Hours, the unit everyone here talks in. Minutes only for the small print. */
export function hoursLabel(minutes: number): string {
  const h = minutes / 60
  if (h === 0) return '0h'
  if (h < 1) return `${Math.round(minutes)}m`
  if (h < 10) return `${h.toFixed(1)}h`
  return `${Math.round(h)}h`
}

/** Hours as a bare decimal, for a spreadsheet cell that will be summed. */
export function hoursNumber(minutes: number): string {
  return (Math.round((minutes / 60) * 100) / 100).toFixed(2)
}
