/*
 * Field types are coloured from the cobalt pigment family: the mineral the org
 * is named after. Every hue here is a real pigment name, which keeps the legend
 * teachable ("DATE is cobalt teal") instead of arbitrary.
 *
 * HEADER is deliberately the one warm hue: it is the only "field" that stores no
 * data, so it should not read as blue like the rest.
 */
const PIGMENTS = {
  cobaltBlue: '#3B72E8',
  smalt: '#4A57CE',
  cerulean: '#1E9AC8',
  cobaltTeal: '#0FA79A',
  cobaltGreen: '#5AA33C',
  cobaltViolet: '#9457DC',
  cobaltMagenta: '#CE4A8B',
  aureolin: '#D6A521',
  slate: '#7C89A6',
} as const

const RAMP = [
  PIGMENTS.cobaltBlue,
  PIGMENTS.smalt,
  PIGMENTS.cerulean,
  PIGMENTS.cobaltTeal,
  PIGMENTS.cobaltGreen,
  PIGMENTS.cobaltViolet,
  PIGMENTS.cobaltMagenta,
]

const NAMED: Record<string, string> = {
  // Text-ish types stay in the blues; each step is a distinct pigment so a
  // stripe of TEXT + MEMO still reads as two bands.
  TEXT: PIGMENTS.cobaltBlue,
  MEMO: PIGMENTS.smalt,
  HTML: PIGMENTS.cerulean,
  PICKLIST: PIGMENTS.cerulean,
  SELECT: PIGMENTS.cerulean,
  RADIO: PIGMENTS.cerulean,
  CHECKBOX: PIGMENTS.cerulean,
  MULTISELECT: PIGMENTS.cerulean,
  DATE: PIGMENTS.cobaltTeal,
  DATETIME: PIGMENTS.cobaltTeal,
  TIME: PIGMENTS.cobaltTeal,
  BOOLEAN: PIGMENTS.cobaltGreen,
  PASSWORD: PIGMENTS.cobaltViolet,
  HEADER: PIGMENTS.aureolin,
  NUMBER: PIGMENTS.cobaltMagenta,
  INTEGER: PIGMENTS.cobaltMagenta,
  DECIMAL: PIGMENTS.cobaltMagenta,
  CURRENCY: PIGMENTS.cobaltMagenta,
  FORMULA: PIGMENTS.cobaltMagenta,
}

/** Deterministic colour for any field type, named where we know it. */
export function pigment(fieldType: string): string {
  const key = (fieldType || '').toUpperCase()
  if (NAMED[key]) return NAMED[key]
  if (!key) return PIGMENTS.slate
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return RAMP[h % RAMP.length]
}

/** Field types present, ordered by how many fields use them. */
export function typeTally(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}
