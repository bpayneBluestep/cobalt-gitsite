import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError, getUsers, updateEmployee, setSupervisor, createUser,
  DEPARTMENTS, EMPLOYMENT_TYPES,
  type User, type UserList, type EmployeeFieldKey,
} from '../api'
import PhoneInput from '../components/PhoneInput'
import { isPhoneOk } from '../lib/phone'

/*
 * Settings → Users.
 *
 * A person here is a Staff record with employment details on the Employee Info form.
 * Supervisor is picked from the same list, which is why it can only ever point at a real
 * user — the endpoint resolves the name from that record rather than trusting what the
 * browser sends, so the stored name is always the real one.
 *
 * One honest limit, stated on the page rather than buried: adding someone creates their
 * person record, NOT a BlueStep login. The scripting API cannot mint credentials, so an
 * account still has to be issued from the platform's own tooling. Saying so is better
 * than letting someone add a person and wonder why they cannot sign in.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: UserList }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

type Draft = Record<EmployeeFieldKey | 'name', string>

const EMPTY: Draft = {
  name: '', jobTitle: '', department: '', dateOfHire: '', employmentType: 'Full-time',
  workEmail: '', workPhone: '', employed: 'true', notes: '',
}

function draftOf(u: User): Draft {
  return {
    name: u.name || '',
    jobTitle: u.jobTitle || '', department: u.department || '',
    dateOfHire: u.dateOfHire || '', employmentType: u.employmentType || '',
    workEmail: u.workEmail || '', workPhone: u.workPhone || '',
    employed: u.employed ? 'true' : 'false', notes: u.notes || '',
  }
}

export default function Settings() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [includeFormer, setIncludeFormer] = useState(true)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback((withFormer: boolean) => {
    setState({ phase: 'loading' })
    getUsers(withFormer)
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(includeFormer) }, [load, includeFormer])

  const d = state.phase === 'ready' ? state.data : null
  const rows = useMemo(() => d?.rows || [], [d])

  function run(label: string, work: Promise<unknown>, said: string) {
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(() => { setNotice(said); setEditing(null); load(includeFormer) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function save() {
    if (busy) return
    const fields: Partial<Record<EmployeeFieldKey | 'name', string>> = {
      jobTitle: draft.jobTitle.trim(), department: draft.department,
      dateOfHire: draft.dateOfHire, employmentType: draft.employmentType,
      workEmail: draft.workEmail.trim(), workPhone: draft.workPhone.trim(),
      employed: draft.employed, notes: draft.notes,
    }
    if (editing === 'new') {
      if (!draft.name.trim()) { setFailure('A new person needs a name.'); return }
      run('save', createUser({ ...fields, name: draft.name.trim() }),
        `${draft.name.trim()} added — remember they still need a login.`)
      return
    }
    run('save', updateEmployee(editing as string, fields), 'Employee details saved.')
  }

  const dash = <span className="muted">—</span>

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Cobalt</p>
        <h1>Settings</h1>
        <p className="page__sub-text">
          Who works here, what they do, and who they report to.
        </p>
      </header>

      <nav className="subnav" aria-label="Settings sections">
        <button type="button" className="subnav__btn" data-on="" aria-current="true">Users</button>
      </nav>

      {state.phase === 'loading' && <p className="empty">Loading users…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load users'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load(includeFormer)}>Try again</button>}
          </p>
        </div>
      )}

      {d && (
        <>
          <div className="pipebar">
            <div className="pipebar__totals">
              <span><strong>{d.total}</strong> {d.total === 1 ? 'person' : 'people'}</span>
              <span className="muted"><strong>{d.withEmployeeInfo}</strong> with employment details</span>
            </div>
            <div className="cab__actions">
              <label className="checkline">
                <input type="checkbox" checked={includeFormer}
                  onChange={e => setIncludeFormer(e.target.checked)} />
                <span>Include people who have left</span>
              </label>
              <button type="button" className="btn btn--sm" disabled={!!busy}
                onClick={() => { setEditing('new'); setDraft(EMPTY) }}>
                <span aria-hidden="true">+</span> Add person
              </button>
            </div>
          </div>

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {editing && (
            <div className="editcard">
              <div className="editcard__head">
                <h2>{editing === 'new' ? 'New person' : 'Employee details'}</h2>
                <p className="note">
                  {editing === 'new'
                    ? 'This creates the person record only. A BlueStep login has to be issued from the platform’s account tooling — the scripting API cannot mint credentials.'
                    : 'Type a phone number as digits — it formats itself.'}
                </p>
              </div>
              <div className="efgrid">
                {editing === 'new' && (
                  <div className="ef ef--wide">
                    <label htmlFor="u-name">Name<span className="ef__req" aria-hidden="true">*</span></label>
                    <input id="u-name" type="text" value={draft.name} autoFocus autoComplete="off"
                      placeholder="Surname, First"
                      onChange={e => setDraft(x => ({ ...x, name: e.target.value }))} />
                  </div>
                )}
                <div className="ef">
                  <label htmlFor="u-title">Job title</label>
                  <input id="u-title" type="text" value={draft.jobTitle} autoComplete="off"
                    onChange={e => setDraft(x => ({ ...x, jobTitle: e.target.value }))} />
                </div>
                <div className="ef">
                  <label htmlFor="u-dept">Department</label>
                  <select id="u-dept" value={draft.department}
                    onChange={e => setDraft(x => ({ ...x, department: e.target.value }))}>
                    <option value="">—</option>
                    {DEPARTMENTS.map(x => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                <div className="ef">
                  <label htmlFor="u-hire">Date of hire</label>
                  <input id="u-hire" type="date" value={draft.dateOfHire}
                    onChange={e => setDraft(x => ({ ...x, dateOfHire: e.target.value }))} />
                </div>
                <div className="ef">
                  <label htmlFor="u-type">Employment type</label>
                  <select id="u-type" value={draft.employmentType}
                    onChange={e => setDraft(x => ({ ...x, employmentType: e.target.value }))}>
                    <option value="">—</option>
                    {EMPLOYMENT_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                <div className="ef">
                  <label htmlFor="u-email">Work email</label>
                  <input id="u-email" type="email" value={draft.workEmail} autoComplete="off"
                    onChange={e => setDraft(x => ({ ...x, workEmail: e.target.value }))} />
                </div>
                <div className="ef">
                  <label htmlFor="u-phone">Work phone</label>
                  <PhoneInput id="u-phone" value={draft.workPhone}
                    onChange={v => setDraft(x => ({ ...x, workPhone: v }))} />
                </div>
                <div className="ef">
                  <label htmlFor="u-employed">Employment</label>
                  <label className="checkline">
                    <input id="u-employed" type="checkbox" checked={draft.employed === 'true'}
                      onChange={e => setDraft(x => ({ ...x, employed: e.target.checked ? 'true' : 'false' }))} />
                    <span>Currently employed</span>
                  </label>
                </div>
              </div>
              <div className="editcard__foot">
                <span className="editcard__status">{busy === 'save' ? 'Saving…' : ''}</span>
                <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)} disabled={!!busy}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={save}
                  disabled={!!busy || !isPhoneOk(draft.workPhone)}>
                  {editing === 'new' ? 'Add person' : 'Save details'}
                </button>
              </div>
            </div>
          )}

          <div className="tablewrap">
            <table className="fields">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Title</th>
                  <th scope="col">Department</th>
                  <th scope="col">Hired</th>
                  <th scope="col">Reports to</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(u => (
                  <tr key={u.id} data-off={u.hasEmployeeInfo && !u.employed ? '' : undefined}>
                    <th scope="row">
                      {u.name || <span className="muted">(unnamed)</span>}
                      <span className="rowmarks">
                        {u.hasEmployeeInfo && !u.employed && <span className="mark">left</span>}
                        {!u.hasEmployeeInfo && <span className="mark">no details yet</span>}
                        {u.directReports > 0 && (
                          <span className="mark">{u.directReports} report{u.directReports === 1 ? '' : 's'}</span>
                        )}
                      </span>
                      {u.workEmail && (
                        <span className="contacts__title">
                          <a className="inlink" href={`mailto:${u.workEmail}`}>{u.workEmail}</a>
                        </span>
                      )}
                    </th>
                    <td>{u.jobTitle || dash}</td>
                    <td>{u.department || dash}</td>
                    <td className="nowrap">{u.dateOfHire || dash}</td>
                    <td>
                      <select
                        className="minisel"
                        aria-label={`Supervisor for ${u.name}`}
                        value={u.supervisorId || ''}
                        disabled={!!busy}
                        onChange={e => run('sup', setSupervisor(u.id, e.target.value),
                          e.target.value
                            ? `${u.name} now reports to ${rows.find(r => r.id === e.target.value)?.name || 'them'}.`
                            : `${u.name} no longer reports to anyone.`)}
                      >
                        <option value="">—</option>
                        {rows.filter(r => r.id !== u.id).map(r => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                      {u.supervisorMissing && (
                        <span className="tag tag--warn">missing: {u.supervisorName || u.supervisorId}</span>
                      )}
                    </td>
                    <td className="leads__act">
                      <button type="button" className="linkbtn" disabled={!!busy}
                        onClick={() => { setEditing(u.id); setDraft(draftOf(u)) }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="panel__foot">
            A person here is a Staff record. Adding one creates the record and its
            employment details — issuing the BlueStep login is a separate step in the
            platform’s account tooling, which no script can do.
          </p>
        </>
      )}
    </section>
  )
}
