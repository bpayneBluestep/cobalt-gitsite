import { useCallback, useEffect, useState } from 'react'
import {
  ApiError, getContacts, addContact, updateContact, setPrimaryContact, deleteContact,
  CONTACT_ROLES, type Contact, type ContactList, type ContactFieldKey,
} from '../api'

/*
 * The people at one company.
 *
 * A multi-entry form rather than person records — these are individuals in the
 * context of this company, and a separate record per person would mean a second
 * identity to keep in step for no gain.
 *
 * Exactly one contact is primary, and that is the endpoint's guarantee rather than
 * this component's: "Make primary" sets one and clears the rest in a single commit.
 * The UI shows the flag but never writes it directly, which is why there is no
 * checkbox for it in the editor.
 */

type Draft = Record<ContactFieldKey, string>

const EMPTY: Draft = {
  firstName: '', lastName: '', title: '', role: '', email: '', phone: '', mobile: '', notes: '',
}

function draftOf(c: Contact): Draft {
  return {
    firstName: c.firstName || '', lastName: c.lastName || '', title: c.title || '',
    role: c.role || '', email: c.email || '', phone: c.phone || '', mobile: c.mobile || '',
    notes: c.notes || '',
  }
}

function changed(draft: Draft, saved: Contact): Partial<Record<ContactFieldKey, string>> {
  const out: Partial<Record<ContactFieldKey, string>> = {}
  const was = draftOf(saved)
  for (const k of Object.keys(draft) as ContactFieldKey[]) {
    if (draft[k] !== was[k]) out[k] = draft[k]
  }
  return out
}

export default function ContactsPanel({ companyId, onMirror }: {
  companyId: string
  /** Called when the primary changes, so the record header can refresh its facts. */
  onMirror?: () => void
}) {
  const [data, setData] = useState<ContactList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [asPrimary, setAsPrimary] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState('')

  const load = useCallback(() => {
    setLoading(true); setError('')
    getContacts(companyId)
      .then(setData)
      .catch(err => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [companyId])

  useEffect(load, [load])

  /** Every write returns the whole list, so state is replaced rather than patched. */
  function run(label: string, work: Promise<ContactList>, said: string) {
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(fresh => {
        setData(fresh)
        setNotice(said)
        setEditing(null)
        if (onMirror) onMirror()
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => { setBusy(''); setConfirmDelete('') })
  }

  function openNew() {
    setEditing('new'); setDraft(EMPTY); setAsPrimary(false); setFailure(''); setNotice('')
  }

  function openEdit(c: Contact) {
    setEditing(c.entryId); setDraft(draftOf(c)); setFailure(''); setNotice('')
  }

  function save() {
    if (busy) return
    if (!draft.firstName.trim() && !draft.lastName.trim()) {
      setFailure('A contact needs a first or last name.')
      return
    }
    if (editing === 'new') {
      const fields: Partial<Record<ContactFieldKey, string>> = {}
      for (const k of Object.keys(draft) as ContactFieldKey[]) if (draft[k].trim()) fields[k] = draft[k].trim()
      run('save', addContact(companyId, fields, asPrimary), 'Contact added.')
      return
    }
    const saved = (data?.rows || []).find(r => r.entryId === editing)
    if (!saved) return
    const diff = changed(draft, saved)
    if (!Object.keys(diff).length) { setEditing(null); return }
    run('save', updateContact(companyId, saved.entryId, diff), 'Contact saved.')
  }

  const dash = <span className="muted">—</span>

  return (
    <section className="tsec">
      <div className="panel__head">
        <h2 className="tsec__h">
          Contacts
          {data && data.total > 0 && <span className="tsec__n">{data.total}</span>}
        </h2>
        <button type="button" className="btn btn--sm" onClick={openNew} disabled={!!busy || loading}>
          <span aria-hidden="true">+</span> Add contact
        </button>
      </div>

      {loading && <p className="empty">Loading contacts…</p>}
      {error && <p className="editcard__err" role="alert">{error}</p>}
      {failure && <p className="editcard__err" role="alert">{failure}</p>}
      {notice && <p className="board2__notice" role="status">{notice}</p>}

      {data && data.primaryConflict && (
        <div className="callout callout--warn">
          <p className="callout__title">More than one contact is flagged primary</p>
          <p>
            That can only happen if the box was ticked on the BlueStep form directly.
            Choosing a primary below will clear the others.
          </p>
        </div>
      )}

      {editing && (
        <div className="editcard">
          <div className="editcard__head">
            <h2>{editing === 'new' ? 'New contact' : 'Edit contact'}</h2>
            <p className="note">
              {editing === 'new' && data && data.total === 0
                ? 'The first contact at a company becomes the primary automatically.'
                : 'Phone numbers must look like (555) 234-0101.'}
            </p>
          </div>
          <div className="efgrid">
            <div className="ef">
              <label htmlFor="ct-first">First name</label>
              <input id="ct-first" type="text" value={draft.firstName} autoComplete="off" autoFocus
                onChange={e => setDraft(d => ({ ...d, firstName: e.target.value }))} />
            </div>
            <div className="ef">
              <label htmlFor="ct-last">Last name</label>
              <input id="ct-last" type="text" value={draft.lastName} autoComplete="off"
                onChange={e => setDraft(d => ({ ...d, lastName: e.target.value }))} />
            </div>
            <div className="ef">
              <label htmlFor="ct-title">Job title</label>
              <input id="ct-title" type="text" value={draft.title} autoComplete="off"
                onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
            </div>
            <div className="ef">
              <label htmlFor="ct-role">Deal role</label>
              <select id="ct-role" value={draft.role}
                onChange={e => setDraft(d => ({ ...d, role: e.target.value }))}>
                <option value="">—</option>
                {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="ef">
              <label htmlFor="ct-email">Email</label>
              <input id="ct-email" type="email" value={draft.email} autoComplete="off"
                onChange={e => setDraft(d => ({ ...d, email: e.target.value }))} />
            </div>
            <div className="ef">
              <label htmlFor="ct-phone">Phone</label>
              <input id="ct-phone" type="text" value={draft.phone} autoComplete="off"
                placeholder="(555) 234-0101"
                onChange={e => setDraft(d => ({ ...d, phone: e.target.value }))} />
            </div>
            <div className="ef">
              <label htmlFor="ct-mobile">Mobile</label>
              <input id="ct-mobile" type="text" value={draft.mobile} autoComplete="off"
                placeholder="(555) 234-0102"
                onChange={e => setDraft(d => ({ ...d, mobile: e.target.value }))} />
            </div>
            {editing === 'new' && data && data.total > 0 && (
              <div className="ef">
                <label htmlFor="ct-primary">Primary</label>
                <label className="checkline">
                  <input id="ct-primary" type="checkbox" checked={asPrimary}
                    onChange={e => setAsPrimary(e.target.checked)} />
                  <span>Make this the primary contact</span>
                </label>
              </div>
            )}
            <div className="ef ef--wide">
              <label htmlFor="ct-notes">Notes</label>
              <textarea id="ct-notes" rows={3} value={draft.notes}
                onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))} />
            </div>
          </div>
          <div className="editcard__foot">
            <span className="editcard__status">{busy === 'save' ? 'Saving…' : ''}</span>
            <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)} disabled={!!busy}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={save} disabled={!!busy}>
              {editing === 'new' ? 'Add contact' : 'Save changes'}
            </button>
          </div>
        </div>
      )}

      {data && data.rows.length === 0 && !editing && (
        <div className="callout callout--plain">
          <p className="callout__title">Nobody recorded here yet</p>
          <p>Add the person you actually speak to. The first one becomes the primary contact.</p>
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className="tablewrap">
          <table className="fields contacts">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Email</th>
                <th scope="col">Phone</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.slice().sort((a, b) => {
                if (a.primary !== b.primary) return a.primary ? -1 : 1
                return (a.fullName || '').localeCompare(b.fullName || '')
              }).map(c => (
                <tr key={c.entryId} data-on={c.primary ? '' : undefined}>
                  <th scope="row">
                    {c.fullName || <span className="muted">(unnamed)</span>}
                    {c.primary && <span className="mark mark--primary">primary</span>}
                    {c.title && <span className="contacts__title">{c.title}</span>}
                  </th>
                  <td>{c.role || dash}</td>
                  <td>
                    {c.email
                      ? <a className="inlink" href={`mailto:${c.email}`}>{c.email}</a>
                      : dash}
                  </td>
                  <td className="nowrap">
                    {c.phone ? <a className="inlink" href={`tel:${c.phone}`}>{c.phone}</a> : dash}
                    {c.mobile && <><br /><a className="inlink" href={`tel:${c.mobile}`}>{c.mobile}</a></>}
                  </td>
                  <td className="leads__act">
                    {confirmDelete === c.entryId ? (
                      <>
                        <span className="board2__confirm">Delete?</span>
                        <button type="button" className="linkbtn" onClick={() => setConfirmDelete('')} disabled={!!busy}>
                          Keep
                        </button>
                        <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                          onClick={() => run('del', deleteContact(companyId, c.entryId), 'Contact deleted.')}>
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        {!c.primary && (
                          <button type="button" className="linkbtn" disabled={!!busy}
                            onClick={() => run('primary', setPrimaryContact(companyId, c.entryId),
                              `${c.fullName || 'That contact'} is now the primary.`)}>
                            Make primary
                          </button>
                        )}
                        <button type="button" className="linkbtn" onClick={() => openEdit(c)} disabled={!!busy}>
                          Edit
                        </button>
                        <button type="button" className="linkbtn linkbtn--danger"
                          onClick={() => setConfirmDelete(c.entryId)} disabled={!!busy}>
                          Remove
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <p className="panel__foot">
          The primary is copied onto the company record, so the Clients table and the CRM
          read a real field rather than walking this list.
        </p>
      )}
    </section>
  )
}
