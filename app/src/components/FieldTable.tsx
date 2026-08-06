import { pigment } from '../pigments'
import CopyId from './CopyId'
import type { Field } from '../schema'

export default function FieldTable({ fields, highlight }: { fields: Field[]; highlight?: string }) {
  const q = (highlight || '').trim().toLowerCase()
  const matches = (f: Field) =>
    !!q && (
      f.label.toLowerCase().includes(q) ||
      f.columnName.toLowerCase().includes(q) ||
      (f.dbColumnName || '').toLowerCase().includes(q) ||
      f.fieldId.toLowerCase().includes(q) ||
      f.fieldType.toLowerCase().includes(q)
    )

  return (
    <div className="tablewrap">
      <table className="fields">
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Column name</th>
            <th scope="col">Type</th>
            <th scope="col">DB column</th>
            <th scope="col">Field id</th>
          </tr>
        </thead>
        <tbody>
          {fields.map(f => (
            <tr key={f.fieldId} data-match={matches(f) || undefined}>
              <th scope="row">
                <span className="fields__spine" style={{ background: pigment(f.fieldType) }} aria-hidden="true" />
                {f.label || <span className="muted">(no label)</span>}
              </th>
              <td>{f.columnName}</td>
              <td>
                <span className="chip" style={{ ['--chip' as string]: pigment(f.fieldType) }}>
                  {f.fieldType}
                </span>
              </td>
              <td>
                {f.dbColumnName
                  ? <code className="db">{f.dbColumnName}</code>
                  : <span className="muted" title="Headers store no data, so they have no column">—</span>}
              </td>
              <td><CopyId value={f.fieldId} label="field id" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
