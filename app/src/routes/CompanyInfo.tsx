import { useEffect, useState } from 'react'
import { ApiError, updateCompany, COMPANY_FIELDS, type Company, type CompanyFieldKey } from '../api'
import { useSession } from '../session'
import AccountOwnerCard from '../components/AccountOwnerCard'
import UserPicker from '../components/UserPicker'
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

/**
 * Who is working this company, for the CRM's purposes.
 *
 * Separate from the Account Owner card below it, and the difference is real:
 *
 *   * CRM owner (this) — the rep whose book this company is in. Applies to a lead and a
 *     client alike, is what every "Mine" filter reads, and is a single current value.
 *   * Account owner — the dated record of who has been answerable for a live client
 *     system, with a handover history. Only means anything once there is a system.
 *
 * Setting the account owner mirrors into this one, so a client normally has both and
 * they agree. A lead only ever has this.
 *
 * Saved on change rather than behind a Save button: it is one value, the choice is
 * deliberate, and there is nothing to review before committing it.
 */
function CrmOwnerCard() {
  const { can } = useSession()
  const mayEdit = can('editClients')
  const { company, setCompany } = useRecord()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  function pick(userId: string) {
    setBusy(true)
    setFailure('')
    updateCompany(company.id, { ownerId: userId })
      .then(setCompany)
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="editcard">
      <div className="editcard__head">
        <h2>CRM owner</h2>
        <p className="note">
          Whose book this company is in. This is what “Mine” means on every CRM screen.
        </p>
      </div>

      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      <div className="efgrid">
        <div className="ef">
          <label htmlFor="co-owner">Owner</label>
          <UserPicker id="co-owner" value={company.ownerId || ''} placeholder="Nobody"
            disabled={!mayEdit || busy} onChange={pick} />
          {/*
            A company imported with an owner NAME and no matching staff record still has
            to show who it says owns it — otherwise the row reads as unowned when it is
            not, and nobody knows to fix it.
          */}
          {!company.ownerId && company.owner && (
            <p className="ef__hint">
              Currently “{company.owner}”, imported as a name with no matching staff
              record. Pick someone to make it filterable.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function CompanyInfo() {
  // Company Info is Editor for Leadership, Sales and Client Success; Reader for the
  // engineers and Accounting, who need the client's context but do not own the record.
  const { can } = useSession()
  const mayEdit = can('editClients')
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

  /*
   * Account ownership is the dated record of who is answerable for a live client system.
   * A lead has no system, so the card would be a handover history for something that has
   * not started — the CRM owner above is the field that covers a lead.
   */
  const clientish = company.categories.includes('Client') ||
    company.categories.includes('Former Client')

  return (
    <>
      <CrmOwnerCard />

      {clientish && <AccountOwnerCard companyId={company.id} onChanged={reload} />}

      <div className="editcard">
        <div className="editcard__head">
          <h2>Company Info</h2>
          <p className="note">The record's base form. Only the fields you change are written.</p>
        </div>

        {failure && <p className="editcard__err" role="alert">{failure}</p>}

        {!mayEdit && (
          <p className="callout callout--plain">
            Read-only — engineers and Accounting can see a client's details but not change
            them. Leadership, Sales and Client Success own this record.
          </p>
        )}

        {/* One fieldset, one `disabled` — see DealEditor for why this beats a flag on
            every input. */}
        <fieldset className="efgrid efgrid--fs" disabled={!mayEdit}>
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
        </fieldset>

        <div className="editcard__foot">
          <span className="editcard__status">
            {saving ? 'Saving…' : notice ? notice : dirty
              ? `${Object.keys(pending).length} unsaved change${Object.keys(pending).length === 1 ? '' : 's'}`
              : ''}
          </span>
          {mayEdit && (
            <>
              <button type="button" className="btn btn--ghost" disabled={!dirty || saving}
                onClick={() => { setDraft(draftOf(company)); setNotice(''); setFailure('') }}>
                Revert
              </button>
              <button type="button" className="btn" onClick={save} disabled={!dirty || saving}>
                Save changes
              </button>
            </>
          )}
        </div>
      </div>
    </>
  )
}
