import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError, getUsers, updateEmployee, setSupervisor, createUser,
  DEPARTMENTS, EMPLOYMENT_TYPES, STAFF_ROLES,
  type User, type UserList, type EmployeeFieldKey, type EmployeeWrite,
} from '../api'
import { Link } from 'react-router-dom'
import OutlookSettingsPanel from '../components/OutlookSettingsPanel'
import PhoneInput from '../components/PhoneInput'
import { isPhoneOk } from '../lib/phone'
import { useSession } from '../session'

/*
 * Settings → Users.
 *
 * A person here carries both the Staff and User categories, with employment details on the
 * Employee Info form. Supervisor is picked from the same list, which is why it can only
 * ever point at a real user: the endpoint resolves the name from that record rather than
 * trusting what the browser sends, so the stored name is always the real one.
 *
 * ROLES ARE PERMISSIONS. Ticking one puts that person into a dynamic security group on the
 * platform; unticking removes them. That is why the roles editor sits behind Edit rather
 * than being an inline toggle in the table: a permission change should take a deliberate
 * act, not a stray click on a row. Unticking "Currently employed" removes every role at
 * once, because each role's query also requires it.
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

/*
 * First and last name are two fields, because a person's name is two facts. The endpoint
 * can split a single string on the last space, but that guesses which words are the
 * surname - "Mary Anne van der Berg" has no rule worth trusting, so this form never asks
 * it to. Name is create-only; renaming afterwards is not offered here.
 */
type Draft = Record<EmployeeFieldKey | 'firstName' | 'lastName', string> & { roles: string[] }

const EMPTY: Draft = {
  firstName: '', lastName: '',
  jobTitle: '', department: '', dateOfHire: '', employmentType: 'Full-time',
  workEmail: '', workPhone: '', employed: 'true', notes: '', roles: [],
}

function draftOf(u: User): Draft {
  return {
    firstName: '', lastName: '',
    jobTitle: u.jobTitle || '', department: u.department || '',
    dateOfHire: u.dateOfHire || '', employmentType: u.employmentType || '',
    workEmail: u.workEmail || '', workPhone: u.workPhone || '',
    employed: u.employed ? 'true' : 'false', notes: u.notes || '',
    roles: u.roles ? [...u.roles] : [],
  }
}

export default function Settings() {
  /*
   * Everyone with a role can read the directory: the platform grants Reader on Employee
   * Info to all six, but only Leadership holds Editor, so only Leadership sees the
   * controls that write. Anyone else gets the same page without them, rather than buttons
   * that fail on click.
   */
  const { can } = useSession()
  const mayEdit = can('editStaff')
  const mayGrant = can('grantRoles')

  /*
    * Which section is showing. Outlook is Leadership-only in the same way the write
    * controls are: the endpoint refuses the read outright, so showing the tab to anyone
    * else would only offer them an error. Not a second permission, just the one already
    * being asked - the settings form's own ACL is Leadership too.
    */
  const [tab, setTab] = useState<'users' | 'outlook'>('users')

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

  // The server owns the role vocabulary; the local constant is only a pre-load fallback,
  // so a role added on the platform shows up here without a redeploy.
  const roleOptions = useMemo(
    () => (d?.staffRoles?.length ? d.staffRoles : [...STAFF_ROLES]),
    [d],
  )

  /*
   * `said` is what we expected to happen; a function gets to say what DID.
   *
   * Creating a person is the case that needs it: the endpoint returns a sentence listing
   * what it could not finish, and this screen used to throw that away and print a canned
   * success line instead.
   */
  function run(label: string, work: Promise<unknown>, said: string | ((result: any) => string)) {
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(result => {
        setNotice(typeof said === 'function' ? said(result) : said)
        setEditing(null)
        load(includeFormer)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function save() {
    if (busy) return
    const fields: EmployeeWrite = {
      jobTitle: draft.jobTitle.trim(), department: draft.department,
      dateOfHire: draft.dateOfHire, employmentType: draft.employmentType,
      workEmail: draft.workEmail.trim(), workPhone: draft.workPhone.trim(),
      employed: draft.employed, notes: draft.notes,
      // Always sent, so clearing the last role actually removes it.
      roles: draft.roles,
    }
    if (editing === 'new') {
      const first = draft.firstName.trim()
      const last = draft.lastName.trim()
      if (!first || !last) {
        setFailure('A new person needs both a first and a last name.')
        return
      }
      run('save', createUser({ ...fields, firstName: first, lastName: last }),
        // The endpoint's own account of what landed and what did not, not ours.
        made => `${first} ${last} added. ${made?.note || 'They still need a login.'}`)
      return
    }
    run('save', updateEmployee(editing as string, fields), 'Employee details saved.')
  }

  /** Roles are a set: tick to add, untick to remove. */
  function toggleRole(role: string) {
    setDraft(x => ({
      ...x,
      roles: x.roles.indexOf(role) < 0
        ? [...x.roles, role]
        : x.roles.filter(r => r !== role),
    }))
  }

  const dash = <span className="muted">-</span>

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
        <button type="button" className="subnav__btn"
          data-on={tab === 'users' ? '' : undefined}
          aria-current={tab === 'users' ? 'true' : undefined}
          onClick={() => setTab('users')}>
          Users
        </button>
        {mayEdit && (
          <button type="button" className="subnav__btn"
            data-on={tab === 'outlook' ? '' : undefined}
            aria-current={tab === 'outlook' ? 'true' : undefined}
            onClick={() => setTab('outlook')}>
            Outlook
          </button>
        )}
      </nav>

      {tab === 'outlook' && <OutlookSettingsPanel />}

      {tab === 'users' && (
        <>

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
              {mayEdit && (
                <button type="button" className="btn btn--sm" disabled={!!busy}
                  onClick={() => { setEditing('new'); setDraft(EMPTY) }}>
                  <span aria-hidden="true">+</span> Add person
                </button>
              )}
            </div>
          </div>

          {!mayEdit && (
            <p className="board2__notice" role="status">
              Read-only: the staff directory is visible to every role, but changing
              employment details or roles needs Leadership.
            </p>
          )}

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {editing && (
            <div className="editcard">
              <div className="editcard__head">
                <h2>{editing === 'new' ? 'New person' : 'Employee details'}</h2>
                <p className="note">
                  {editing === 'new'
                    ? 'This creates the person record only. A BlueStep login has to be issued from the platform’s account tooling: the scripting API cannot mint credentials.'
                    : 'Type a phone number as digits. It formats itself.'}
                </p>
              </div>
              <div className="efgrid">
                {editing === 'new' && (
                  <>
                    <div className="ef">
                      <label htmlFor="u-first">
                        First name<span className="ef__req" aria-hidden="true">*</span>
                      </label>
                      <input id="u-first" type="text" value={draft.firstName} autoFocus
                        autoComplete="off"
                        onChange={e => setDraft(x => ({ ...x, firstName: e.target.value }))} />
                    </div>
                    <div className="ef">
                      <label htmlFor="u-last">
                        Last name<span className="ef__req" aria-hidden="true">*</span>
                      </label>
                      <input id="u-last" type="text" value={draft.lastName} autoComplete="off"
                        onChange={e => setDraft(x => ({ ...x, lastName: e.target.value }))} />
                    </div>
                  </>
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
                    <option value="">-</option>
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
                    <option value="">-</option>
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
                {/* Granting a role IS granting access, so this is the one control gated
                    on its own capability rather than on editStaff. They coincide today
                    (both Leadership); naming them separately keeps it that way on purpose
                    rather than by accident. */}
                {mayGrant && (
                <fieldset className="ef ef--wide rolebox">
                  <legend className="rolebox__legend">Roles</legend>
                  <p className="rolebox__hint">
                    What this person may see. Any number of roles. Someone can be both a
                    Relate Engineer and Client Success. Each one grants access on the
                    platform, and unticking removes it.
                  </p>
                  <div className="rolebox__grid">
                    {roleOptions.map(role => (
                      <label className="checkline" key={role}>
                        <input type="checkbox" checked={draft.roles.indexOf(role) >= 0}
                          onChange={() => toggleRole(role)} />
                        <span>{role}</span>
                      </label>
                    ))}
                  </div>
                  {draft.employed !== 'true' && draft.roles.length > 0 && (
                    <p className="rolebox__warn">
                      Not currently employed. These roles are stored but grant nothing until
                      that box is ticked again.
                    </p>
                  )}
                </fieldset>
                )}
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
                  <th scope="col">Roles</th>
                  <th scope="col">Hired</th>
                  <th scope="col">Reports to</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(u => (
                  <tr key={u.id} data-off={u.hasEmployeeInfo && !u.employed ? '' : undefined}>
                    <th scope="row">
                      {/* The name opens the person's own record: the table is a directory,
                          and everything you might want to KNOW about someone lives there. */}
                      <Link className="inlink" to={`/staff/${u.id}`}>
                        {u.name || <span className="muted">(unnamed)</span>}
                      </Link>
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
                    {/*
                      * Roles read as chips rather than a comma list: six of them in a
                      * table cell need to stay scannable, and a dimmed chip is how
                      * "stored but granting nothing" shows without a second column.
                      */}
                    <td>
                      {u.roles?.length
                        ? (
                          <span className={'rolechips' + (u.employed ? '' : ' rolechips--inactive')}
                            title={u.employed
                              ? u.roles.join(', ')
                              : `Not currently employed, ${u.roles.join(', ')} grant nothing`}>
                            {u.roles.map(r => <span className="rolechip" key={r}>{r}</span>)}
                          </span>
                        )
                        : dash}
                    </td>
                    <td className="nowrap">{u.dateOfHire || dash}</td>
                    <td>
                      <select
                        className="minisel"
                        aria-label={`Supervisor for ${u.name}`}
                        value={u.supervisorId || ''}
                        disabled={!!busy || !mayEdit}
                        onChange={e => run('sup', setSupervisor(u.id, e.target.value),
                          e.target.value
                            ? `${u.name} now reports to ${rows.find(r => r.id === e.target.value)?.name || 'them'}.`
                            : `${u.name} no longer reports to anyone.`)}
                      >
                        <option value="">-</option>
                        {rows.filter(r => r.id !== u.id).map(r => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                      {u.supervisorMissing && (
                        <span className="tag tag--warn">missing: {u.supervisorName || u.supervisorId}</span>
                      )}
                    </td>
                    <td className="leads__act">
                      {mayEdit ? (
                        <>
                          <button type="button" className="linkbtn" disabled={!!busy}
                            onClick={() => { setEditing(u.id); setDraft(draftOf(u)) }}>
                            Edit
                          </button>
                          {/* Quick edits stay inline; Open is for the whole record. */}
                          <Link className="linkbtn" to={`/staff/${u.id}`}>Open</Link>
                        </>
                      ) : (
                        <Link className="linkbtn" to={`/staff/${u.id}`}>Open</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="panel__foot">
            A person here is both a Staff and a User record. Adding one creates the record,
            both categories, and its employment details: issuing the BlueStep login is a
            separate step in the platform’s account tooling, which no script can do.
            Roles take effect on the platform as soon as they are saved.
          </p>
        </>
      )}
        </>
      )}
    </section>
  )
}
