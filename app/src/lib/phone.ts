/*
 * Phone numbers, in the one format the platform accepts.
 *
 * BlueStep enforces `(AAA) BBB-CCCC` with an optional `xNNN` extension, and both the
 * area code and the prefix must start 2–9 — a real North American rule, not a whim, so
 * the classic fake 555-01xx numbers are rejected. Rather than let someone find that out
 * from a failed save, typing digits produces the format as you go.
 *
 * What is deliberately NOT done: silently dropping a leading 0 or 1 from the area code
 * or prefix. Dropping a digit shifts every digit after it, so the field would quietly
 * hold a different number than the one typed. Those get formatted and flagged instead.
 */

/** The platform's own pattern, with the space fixed rather than optional. */
export const PHONE_RE = /^\([2-9]\d{2}\) [2-9]\d{2}-\d{4}(x\d+)?$/

export const PHONE_HINT =
  'Ten digits, with the area code and prefix starting 2–9 — like (555) 234-0101. ' +
  'Extensions go on the end as x123.'

const digitsOf = (v: string): string => v.replace(/\D+/g, '')

/**
 * Digits in, formatted number out — partial as you type, so the shape appears while
 * the number is still incomplete.
 */
export function formatDigits(raw: string): string {
  let d = raw
  // A leading 1 on an 11-digit string is the country code, not part of the number.
  if (d.length > 10 && d[0] === '1') d = d.slice(1)
  d = d.slice(0, 16)

  const local = d.slice(0, 10)
  const ext = d.slice(10)

  let out = ''
  if (local.length === 0) out = ''
  else if (local.length <= 3) out = `(${local}`
  else if (local.length <= 6) out = `(${local.slice(0, 3)}) ${local.slice(3)}`
  else out = `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`

  return ext ? `${out}x${ext}` : out
}

/** Format whatever was pasted or typed, ignoring how it was punctuated. */
export const formatPhone = (v: string): string => formatDigits(digitsOf(v))

/**
 * Format for a keystroke, given what the field held before.
 *
 * Backspacing over a `)` or `-` leaves the digits unchanged, so re-formatting would put
 * the character straight back and the field would feel stuck. When the text got shorter
 * but the digits did not, take a digit instead — which is what was meant.
 */
export function formatTyped(previous: string, next: string): string {
  const before = digitsOf(previous)
  const after = digitsOf(next)
  const d = next.length < previous.length && after === before ? before.slice(0, -1) : after
  return formatDigits(d)
}

/** Empty is fine — these fields are optional. Anything present must be complete. */
export const isPhoneOk = (v: string): boolean => v.trim() === '' || PHONE_RE.test(v.trim())
