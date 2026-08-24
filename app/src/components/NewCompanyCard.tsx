import { useState } from 'react'
import {
  ApiError, createCompany, COMPANY_FIELDS,
  type CompanyFieldKey, type NewCompany,
} from '../api'

/*
 * Add a company in one named category.
 *
 * Prospecting needed this because there was no way to add a lead at all: the only
 * creation path in the app was "New client", which lands in the Client category and
 * mints a ticket list. Adding a lead therefore meant creating a client, opening the
 * record and demoting it, which left the ticket board behind and put a company in the
 * Clients table that was never a client.
 *
 * The category is a prop rather than a control. A form that asks "is this a lead or a
 * client?" pushes a decision onto the person that the page they are standing on has
 * already answered.
 */

type Draft = Record<CompanyFieldKey, string>

const EMPTY = (): Draft =>
  COMPANY_FIELDS.reduce((d, f) => ({ ...d, [f.key]: '' }), {} as Draft)

export default function NewCompanyCard({
  category, title, note, submitLabel, onCreated, onCancel,
}: {
  category: string
  title: string
  note: string
  submitLabel: string
  onCreated: (result: NewCompany) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.name.trim() || saving) return
    setSaving(true)
    setFailure('')

    // Send only what was filled in: an empty field is "not set", not "".
    const fields: Partial<Record<CompanyFieldKey, string>> = {}
    for (const f of COMPANY_FIELDS) {
      const v = draft[f.key].trim()
      if (v) fields[f.key] = v
    }

    createCompany(fields, category)
      .then(onCreated)
      .catch(err => {
        setFailure(err instanceof ApiError ? err.message : String(err))
        setSaving(false)
      })
  }

  return (
    <form className="editcard newclient" onSubmit={submit}>
      <div className="editcard__head">
        <h2>{title}</h2>
        <p className="note">{note}</p>
      </div>

      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      <div className="efgrid">
        {COMPANY_FIELDS.map(f => (
          <div className="ef" key={f.key}>
            <label htmlFor={`nl-${f.key}`}>
              {f.label}
              {'required' in f && f.required && <span className="ef__req" aria-hidden="true">*</span>}
            </label>
            <input
              id={`nl-${f.key}`}
              type="text"
              value={draft[f.key]}
              placeholder={'placeholder' in f ? f.placeholder : ''}
              autoComplete="off"
              autoFocus={f.key === 'name'}
              onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="editcard__foot">
        <span className="editcard__status">
          {saving ? 'Saving…' : 'Only the name is required.'}
        </span>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={saving || !draft.name.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
