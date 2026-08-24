/*
 * The greeting at the top of Home.
 *
 * It used to say "Morning, Brandon" at four in the afternoon, which is the kind of
 * small wrongness that makes a whole page feel unattended. The hour is the easy half.
 * The other half is variety: one fixed sentence per part of the day reads like a
 * template after about a week, so each band holds several and the page picks one.
 *
 * The pick is DETERMINISTIC within an hour, seeded from the date and the hour. Random
 * on every render would reshuffle the heading while you were reading it, and random per
 * mount would change it every time you navigated back to Home. This way it is steady
 * while you are working and different when you next look up.
 *
 * Voice: plain and dry, the same as the rest of the app. No exclamation marks, nothing
 * that congratulates you for opening a CRM.
 */

interface Band {
  /** Hour this band starts at, local time. */
  from: number
  /** Each takes the first name, because some phrasings want it in the middle. */
  lines: ((who: string) => string)[]
}

const BANDS: Band[] = [
  {
    from: 0,
    lines: [
      who => `Still up, ${who}?`,
      who => `Late one, ${who}`,
      who => `Burning the midnight oil, ${who}`,
      who => `It is very late, ${who}`,
      () => 'The small hours',
    ],
  },
  {
    from: 5,
    lines: [
      who => `Early start, ${who}`,
      who => `Morning, ${who}`,
      who => `You are up early, ${who}`,
      () => 'First light',
      who => `Beat the sun, ${who}`,
    ],
  },
  {
    from: 8,
    lines: [
      who => `Morning, ${who}`,
      who => `Good morning, ${who}`,
      who => `Here is your morning, ${who}`,
      who => `Right then, ${who}`,
      who => `Where we are this morning, ${who}`,
      () => 'The state of play',
    ],
  },
  {
    from: 12,
    lines: [
      who => `Afternoon, ${who}`,
      who => `Middle of the day, ${who}`,
      who => `Half way, ${who}`,
      who => `Post lunch, ${who}`,
      () => 'Where the day stands',
    ],
  },
  {
    from: 14,
    lines: [
      who => `Afternoon, ${who}`,
      who => `Good afternoon, ${who}`,
      who => `Back at it, ${who}`,
      who => `Still plenty of day, ${who}`,
      who => `What is left today, ${who}`,
      () => 'The afternoon',
    ],
  },
  {
    from: 17,
    lines: [
      who => `Evening, ${who}`,
      who => `Winding down, ${who}`,
      who => `End of the day, ${who}`,
      who => `Last look, ${who}`,
      () => 'Before you close the laptop',
    ],
  },
  {
    from: 21,
    lines: [
      who => `Evening, ${who}`,
      who => `Late shift, ${who}`,
      who => `Still going, ${who}`,
      who => `One more look, ${who}`,
      () => 'After hours',
    ],
  },
]

/** The band a given hour falls in. Bands are in order, so the last match wins. */
function bandFor(hour: number): Band {
  let found = BANDS[0]
  for (const b of BANDS) if (hour >= b.from) found = b
  return found
}

/**
 * A greeting for `now`, or a neutral heading when there is no name to use.
 *
 * `now` is a parameter so this is testable and so the caller decides when "now" is,
 * rather than this reaching for the clock twice and straddling an hour boundary.
 */
export function greeting(firstName: string, now: Date = new Date()): string {
  const who = firstName.trim()
  if (!who) return 'Your day'

  const band = bandFor(now.getHours())
  // Seeded on the day and the hour: steady while you work, different when you look up.
  const seed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate() + now.getHours() * 7
  return band.lines[seed % band.lines.length](who)
}
