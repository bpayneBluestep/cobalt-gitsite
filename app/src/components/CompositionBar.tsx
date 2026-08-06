import { pigment } from '../pigments'
import type { Field } from '../schema'

/** The signature element: a form's field types as a stacked pigment stripe, so
 *  you can read a form's makeup before opening it. A form that is all TEXT looks
 *  like one solid band; a mixed clinical form looks striped. */
export default function CompositionBar({ fields, height = 6 }: { fields: Field[]; height?: number }) {
  if (!fields.length) {
    return <div className="composition composition--empty" style={{ height }} aria-hidden="true" />
  }

  const counts = new Map<string, number>()
  for (const f of fields) counts.set(f.fieldType, (counts.get(f.fieldType) || 0) + 1)
  const segments = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const label = segments.map(([t, n]) => `${n} ${t}`).join(', ')

  return (
    <div className="composition" style={{ height }} role="img" aria-label={`Field types: ${label}`}>
      {segments.map(([type, n]) => (
        <span
          key={type}
          className="composition__seg"
          style={{ flexGrow: n, background: pigment(type) }}
          title={`${n} × ${type}`}
        />
      ))}
    </div>
  )
}
