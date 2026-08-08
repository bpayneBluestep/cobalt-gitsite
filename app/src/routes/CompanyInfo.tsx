import { useEffect, useState } from 'react'
import { ApiError, updateCompany, COMPANY_FIELDS, type Company, type CompanyFieldKey } from '../api'
import AccountOwnerCard from '../components/AccountOwnerCard'
import { useRecord } from './CompanyRecord'

/*
 * The Info tab: the record's base form, 1:1 with Company Info on the platform.
 *
 * Follows the eccrm pattern — render the live values as inputs, send ONLY the fields
 * the user actually changed, and re-render from the record the server echoes back
 * rather than from what we hoped we sent.
 */

type Draft = Record<CompanyFieldKey, string>

function draftOf(c: Company): Draft {
  const d = {} as Draft
  for (const f of COMPANY_FIELDS) d[f.key] = (c[f.key] || '') as string
  return d
}

/** Only the keys whose value differs from the saved record. */
function changedKeys(draft: Draft, saved: Company): Partial<Record<CompanyFieldKey, string>> {
  const out: Partial<Record<CompanyFieldKey, string>> = {}
  for (const f of COMPANY_FIELDS) {
    const now = draft[f.key] ?? ''
    const was = (saved[f.key] || '') as string
    if (now !== was) out[f.key] = now
  }
  return out
}

export default function CompanyInfo() {
  const { company, reload, setCompany } = useRecord()
  const [draft, setDraft] = useState<Draft>(() => draftOf(company))
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  // A different record in the same shell is a different form.
  useEffect(() => { setDraft(draftOf(company)); setNotice(''); setFailure('') }, [company.id])

  const pending = changedKeys(draft, company)
  const dirty = Object.keys(pending).length > 0

  function edit(key: CompanyFieldKey, value: string) {
    setDraft(d => ({ ...d, [key]: value }))
    setNotice(''); setFailure('')
  }

  function save() {
    if (!dirty) return
    setSaving(true); setFailure(''); setNotice('')
    updateCompany(company.id, pending)
      .then(fresh => {
        setCompany(fresh)
        setDraft(draftOf(fresh))
        const n = Object.keys(pending).length
        setNotice(`Saved ${n} field${n === 1 ? '' : 's'}.`)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSaving(false))
  }

  return (
    <>
      <AccountOwnerCard companyId={company.id} onChanged={reload} />

      <div className="editcard">
        <div className="editcard__head">
          <h2>Company Info</h2>
          <p className="note">The record's base form. Only the fields you change are written.</p>
        </div>

        {failure && <p className="editcard__err" role="alert">{failure}</p>}

        <div className="efgrid">
          {COMPANY_FIELDS.map(f => (
            <div className="ef" key={f.key}>
              <label htmlFor={`ef-${f.key}`}>
                {f.label}
                {'required' in f && f.required && <span className="ef__req" aria-hidden="true">*</span>}
              </label>
              <input
                id={`ef-${f.key}`}
                type="text"
                value={draft[f.key]}
                placeholder={'placeholder' in f ? f.placeholder : ''}
                autoComplete="off"
                onChange={e => edit(f.key, e.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="editcard__foot">
          <span className="editcard__status">
            {saving ? 'Saving…' : notice ? notice : dirty
              ? `${Object.keys(pending).length} unsaved change${Object.keys(pending).length === 1 ? '' : 's'}`
              : ''}
          </span>
          <button type="button" className="btn btn--ghost" disabled={!dirty || saving}
            onClick={() => { setDraft(draftOf(company)); setNotice(''); setFailure('') }}>
            Revert
          </button>
          <button type="button" className="btn" onClick={save} disabled={!dirty || saving}>
            Save changes
          </button>
        </div>
      </div>
    </>
  )
}
