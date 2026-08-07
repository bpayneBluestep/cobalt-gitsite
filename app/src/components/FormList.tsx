import { NavLink } from 'react-router-dom'
import CompositionBar from './CompositionBar'
import type { Form, Requirement } from '../schema'

export interface FormRow {
  form: Form
  requirement?: Requirement
}

export default function FormList({ rows, emptyMessage }: { rows: FormRow[]; emptyMessage: string }) {
  if (!rows.length) return <p className="empty">{emptyMessage}</p>

  return (
    <ul className="formlist">
      {rows.map(({ form, requirement }) => (
        <li key={form.topId}>
          <NavLink to={`/schema/form/${encodeURIComponent(form.topId)}`} className="formcard">
            <span className="formcard__head">
              <span className="formcard__name">{form.displayName}</span>
              {requirement && (
                <span className="tag" data-req={requirement}>{requirement}</span>
              )}
            </span>

            <CompositionBar fields={form.fields} />

            <span className="formcard__meta">
              <span>{form.fieldCount ?? form.fields.length} fields</span>
              <span className="dot" aria-hidden="true">·</span>
              <span>
                {form.singleEntry === null ? 'entry mode unknown'
                  : form.singleEntry ? 'single entry' : 'multi entry'}
              </span>
              {form.status === 'error' && (
                <>
                  <span className="dot" aria-hidden="true">·</span>
                  <span className="tag tag--warn">fields unavailable</span>
                </>
              )}
            </span>
          </NavLink>
        </li>
      ))}
    </ul>
  )
}
