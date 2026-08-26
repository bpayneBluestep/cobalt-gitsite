import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError, getStaff, updateEmployee, setSupervisor, outlookDisconnect,
  type Staff, type EmployeeWrite,
} from '../api'
import PhoneInput from '../components/PhoneInput'
import { isPhoneOk } from '../lib/phone'
import { useSession } from '../session'

/*
 * One person's record, the same shape a company gets.
 *
 * Settings is a directory: nine rows, a supervisor dropdown and an Edit link that opens
 * an editor above the table. That works for a list and stops working the moment you want
 * to KNOW someone: their reporting line, whether their mailbox is connected, which
 * account they sign in with. Those facts had nowhere to live.
 *
 * Sections rather than child routes, unlike a company. A company accumulates open-ended
 * collections - deals, tickets, files, agreements - and each earns a page. A person has
 * a fixed handful of forms, and splitting four short panels across four URLs would mean
 * three clicks to read what fits on one screen.
 *
 * Each panel saves independently. Employment and identity go through the same endpoint,
 * but they are different acts: correcting a surname should not make you re-confirm
 * someone's salary band, and one failing should not roll the other back on screen.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: Staff }
  | { phase: 'error'; error: ApiError }

const dash = '-'

/** A labelled fact. `children` so a value can be a link or a chip rather than text. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export default function StaffRecord() {
  const { id = '' } = useParams()
  const { can } = useSession()
  const mayEdit = can('editStaff')
  const mayGrant = can('grantRoles')

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  // Which panel is open for editing. Only one at a time: two open editors over the same
  // record is a merge conflict waiting to happen, since both save the whole payload.
  const [editing, setEditing] = useState<'' | 'identity' | 'employment' | 'roles'>('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [roleDraft, setRoleDraft] = useState<string[]>([])

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getStaff(id)
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [id])

  useEffect(() => { load() }, [load])

  const s = state.phase === 'ready' ? state.data : null

  function save(label: string, fields: EmployeeWrite, said: string) {
    if (busy) return
    setBusy(label); setNotice(''); setFailure('')
    updateEmployee(id, fields)
      .then(() => { setNotice(said); setEditing(''); load() })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function changeSupervisor(supervisorId: string) {
    if (busy || !s) return
    setBusy('sup'); setNotice(''); setFailure('')
    setSupervisor(id, supervisorId)
      .then(() => {
        setNotice(supervisorId
          ? `${s.name} now reports to ${s.people.find(p => p.id === supervisorId)?.name || 'them'}.`
          : `${s.name} no longer reports to anyone.`)
        load()
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function disconnectOutlook() {
    if (busy || !s) return
    if (!s.isSelf) return
    if (!window.confirm(
      'Forget your stored Outlook token?\n\n' +
      'Cobalt will stop sending mail as you. This does not withdraw the permission at ' +
      'Microsoft.',
    )) return
    setBusy('outlook'); setNotice(''); setFailure('')
    outlookDisconnect()
      .then(() => { setNotice('Outlook disconnected.'); load() })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  const set = (k: string, v: string) => setDraft(prev => ({ ...prev, [k]: v }))

  if (state.phase === 'loading') return <section className="page"><p className="empty">Loading…</p></section>

  if (state.phase === 'error') {
    return (
      <section className="page">
        <div className="callout">
          <p className="callout__title">Could not open this person</p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            <Link className="btn" to="/settings">Back to Settings</Link>
          </p>
        </div>
      </section>
    )
  }
  if (!s) return null

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">
          <Link className="inlink" to="/settings">Settings</Link> · Person
        </p>
        <h1>{s.name}</h1>
        <p className="page__sub-text">
          {s.jobTitle || 'No job title'}
          {s.department ? ` · ${s.department}` : ''}
          {!s.employed && <span className="tag tag--warn">no longer employed</span>}
          {!s.hasEmployeeInfo && <span className="tag">no employment details yet</span>}
        </p>

        <div className="reccard">
        <dl className="facts">
          <Fact label="Signs in as">
            {s.login.username
              ? <code className="db">{s.login.username}</code>
              : <span className="muted">{s.login.reachable ? 'no username' : 'not readable'}</span>}
          </Fact>
          <Fact label="Unit">{s.unit ? s.unit.name : <span className="muted">{dash}</span>}</Fact>
          <Fact label="Reports to">
            {mayEdit ? (
              <select
                className="minisel"
                aria-label="Supervisor"
                value={s.supervisorId || ''}
                disabled={!!busy}
                onChange={e => changeSupervisor(e.target.value)}
              >
                <option value="">{dash}</option>
                {s.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (s.supervisorName || <span className="muted">{dash}</span>)}
            {s.supervisorMissing && (
              <span className="tag tag--warn">missing: {s.supervisorName || s.supervisorId}</span>
            )}
          </Fact>
          <Fact label="Record id"><code className="db">{s.id}</code></Fact>
        </dl>
        </div>
      </header>

      {notice && <p className="board2__notice" role="status">{notice}</p>}
      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      {!mayEdit && (
        <p className="board2__notice" role="status">
          Read-only: changing employment details or roles needs Leadership.
        </p>
      )}

      {/* ── Identity ───────────────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel__head">
          <h2>Name and e-mail</h2>
          {mayEdit && editing !== 'identity' && (
            <button type="button" className="btn btn--sm" disabled={!!busy}
              onClick={() => {
                setEditing('identity')
                setDraft({
                  firstName: s.firstName || s.nameForm.firstName || '',
                  lastName: s.lastName || s.nameForm.lastName || '',
                  workEmail: s.workEmail || s.nameForm.email || '',
                  workPhone: s.workPhone || '',
                })
              }}>
              Edit
            </button>
          )}
        </div>

        {editing !== 'identity' ? (
          <dl className="facts">
            <Fact label="First name">{s.firstName || s.nameForm.firstName || <span className="muted">{dash}</span>}</Fact>
            <Fact label="Last name">{s.lastName || s.nameForm.lastName || <span className="muted">{dash}</span>}</Fact>
            <Fact label="Work e-mail">
              {s.workEmail
                ? <a className="inlink" href={`mailto:${s.workEmail}`}>{s.workEmail}</a>
                : <span className="muted">{dash}</span>}
            </Fact>
            <Fact label="Work phone">{s.workPhone || <span className="muted">{dash}</span>}</Fact>
            {s.nameForm.email && s.nameForm.email !== s.workEmail && (
              /* The platform's own e-mail, when it has drifted from the work one. Shown
                 only on disagreement: two identical rows would just be noise. */
              <Fact label="Platform e-mail">
                <span className="muted">{s.nameForm.email}</span>
              </Fact>
            )}
          </dl>
        ) : (
          <>
            <div className="efgrid">
              <div className="ef">
                <label htmlFor="s-first">First name</label>
                <input id="s-first" type="text" value={draft.firstName || ''} autoFocus
                  onChange={e => set('firstName', e.target.value)} />
              </div>
              <div className="ef">
                <label htmlFor="s-last">Last name</label>
                <input id="s-last" type="text" value={draft.lastName || ''}
                  onChange={e => set('lastName', e.target.value)} />
              </div>
              <div className="ef">
                <label htmlFor="s-email">Work e-mail</label>
                <input id="s-email" type="email" value={draft.workEmail || ''}
                  onChange={e => set('workEmail', e.target.value)} />
                <p className="ef__hint">
                  Saved to both Employee Info and the platform's Name and E-mail form.
                </p>
              </div>
              <div className="ef">
                <label htmlFor="s-phone">Work phone</label>
                <PhoneInput id="s-phone" value={draft.workPhone || ''}
                  onChange={v => set('workPhone', v)} />
              </div>
            </div>
            <div className="editcard__foot">
              <span className="editcard__status">{busy === 'identity' ? 'Saving…' : ''}</span>
              <button type="button" className="btn btn--ghost" disabled={!!busy}
                onClick={() => setEditing('')}>Cancel</button>
              <button type="button" className="btn"
                disabled={!!busy || !isPhoneOk(draft.workPhone || '')}
                onClick={() => save('identity', {
                  firstName: (draft.firstName || '').trim(),
                  lastName: (draft.lastName || '').trim(),
                  workEmail: (draft.workEmail || '').trim(),
                  workPhone: (draft.workPhone || '').trim(),
                }, 'Name and e-mail saved.')}>
                Save
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Employment ─────────────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel__head">
          <h2>Employment</h2>
          {mayEdit && editing !== 'employment' && (
            <button type="button" className="btn btn--sm" disabled={!!busy}
              onClick={() => {
                setEditing('employment')
                setDraft({
                  jobTitle: s.jobTitle || '', department: s.department || '',
                  dateOfHire: s.dateOfHire || '', employmentType: s.employmentType || '',
                  employed: s.employed ? 'true' : 'false', notes: s.notes || '',
                })
              }}>
              Edit
            </button>
          )}
        </div>

        {editing !== 'employment' ? (
          <dl className="facts">
            <Fact label="Job title">{s.jobTitle || <span className="muted">{dash}</span>}</Fact>
            <Fact label="Department">{s.department || <span className="muted">{dash}</span>}</Fact>
            <Fact label="Employment type">{s.employmentType || <span className="muted">{dash}</span>}</Fact>
            <Fact label="Hired">{s.dateOfHire || <span className="muted">{dash}</span>}</Fact>
            <Fact label="Currently employed">{s.employed ? 'Yes' : 'No'}</Fact>
            <Fact label="Direct reports">
              {s.directReports.length
                ? s.directReports.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && ', '}
                    <Link className="inlink" to={`/staff/${r.id}`}>{r.name}</Link>
                  </span>
                ))
                : <span className="muted">none</span>}
            </Fact>
            {s.notes && <Fact label="Notes">{s.notes}</Fact>}
          </dl>
        ) : (
          <>
            <div className="efgrid">
              <div className="ef">
                <label htmlFor="s-title">Job title</label>
                <input id="s-title" type="text" value={draft.jobTitle || ''} autoFocus
                  onChange={e => set('jobTitle', e.target.value)} />
              </div>
              <div className="ef">
                <label htmlFor="s-dept">Department</label>
                <select id="s-dept" value={draft.department || ''}
                  onChange={e => set('department', e.target.value)}>
                  <option value="">{dash}</option>
                  {s.departments.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div className="ef">
                <label htmlFor="s-type">Employment type</label>
                <select id="s-type" value={draft.employmentType || ''}
                  onChange={e => set('employmentType', e.target.value)}>
                  <option value="">{dash}</option>
                  {s.employmentTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="ef">
                <label htmlFor="s-hired">Date of hire</label>
                <input id="s-hired" type="date" value={draft.dateOfHire || ''}
                  onChange={e => set('dateOfHire', e.target.value)} />
              </div>
              <div className="ef ef--wide">
                <label className="checkline">
                  <input type="checkbox" checked={draft.employed === 'true'}
                    onChange={e => set('employed', e.target.checked ? 'true' : 'false')} />
                  <span>Currently employed</span>
                </label>
                <p className="ef__hint">
                  Unticking this removes every role: each role's query also requires it.
                </p>
              </div>
              <div className="ef ef--wide">
                <label htmlFor="s-notes">Notes</label>
                <textarea id="s-notes" rows={3} value={draft.notes || ''}
                  onChange={e => set('notes', e.target.value)} />
              </div>
            </div>
            <div className="editcard__foot">
              <span className="editcard__status">{busy === 'employment' ? 'Saving…' : ''}</span>
              <button type="button" className="btn btn--ghost" disabled={!!busy}
                onClick={() => setEditing('')}>Cancel</button>
              <button type="button" className="btn" disabled={!!busy}
                onClick={() => save('employment', {
                  jobTitle: (draft.jobTitle || '').trim(),
                  department: draft.department || '',
                  dateOfHire: draft.dateOfHire || '',
                  employmentType: draft.employmentType || '',
                  employed: draft.employed || 'false',
                  notes: draft.notes || '',
                }, 'Employment details saved.')}>
                Save
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Roles ──────────────────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel__head">
          <h2>Roles</h2>
          {mayGrant && editing !== 'roles' && (
            <button type="button" className="btn btn--sm" disabled={!!busy}
              onClick={() => { setEditing('roles'); setRoleDraft([...(s.roles || [])]) }}>
              Edit
            </button>
          )}
        </div>

        <p className="note">
          Roles are permissions, not labels. Ticking one puts this person into the matching
          dynamic security group on the platform, and it takes effect as soon as it is saved.
        </p>

        {editing !== 'roles' ? (
          s.roles?.length ? (
            <p className={'rolechips' + (s.employed ? '' : ' rolechips--inactive')}
              title={s.employed ? undefined : 'Not currently employed, so these grant nothing'}>
              {s.roles.map(r => <span className="rolechip" key={r}>{r}</span>)}
            </p>
          ) : <p className="muted">No roles.</p>
        ) : (
          <>
            <div className="efgrid">
              {s.staffRoles.map(role => (
                <label className="checkline" key={role}>
                  <input
                    type="checkbox"
                    checked={roleDraft.includes(role)}
                    onChange={e => setRoleDraft(prev =>
                      e.target.checked ? [...prev, role] : prev.filter(r => r !== role))}
                  />
                  <span>{role}</span>
                </label>
              ))}
            </div>
            <div className="editcard__foot">
              <span className="editcard__status">{busy === 'roles' ? 'Saving…' : ''}</span>
              <button type="button" className="btn btn--ghost" disabled={!!busy}
                onClick={() => setEditing('')}>Cancel</button>
              <button type="button" className="btn" disabled={!!busy}
                onClick={() => save('roles', { roles: roleDraft },
                  'Roles saved. They take effect on the platform now.')}>
                Save roles
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Account & Outlook ──────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel__head"><h2>Account</h2></div>

        <dl className="facts">
          <Fact label="Username">
            {s.login.username
              ? <code className="db">{s.login.username}</code>
              : <span className="muted">{s.login.reachable ? 'none set' : 'not readable'}</span>}
          </Fact>
          <Fact label="Outlook">
            {s.outlook.connected && s.outlook.hasRefreshToken
              ? <>Connected{s.outlook.mailbox ? ` as ${s.outlook.mailbox}` : ''}</>
              : s.outlook.connected
                ? <span className="tag tag--warn">half connected, no token</span>
                : <span className="muted">not connected</span>}
            {s.isSelf && s.outlook.hasRefreshToken && (
              <button type="button" className="linkbtn" disabled={!!busy}
                onClick={disconnectOutlook}>Disconnect</button>
            )}
          </Fact>
        </dl>

        {/*
          The one honest thing to say about credentials: this app cannot change them, and
          nobody can change somebody else's from here. Both halves matter - the first
          explains the missing button, the second is a boundary worth stating out loud.
        */}
        <p className="panel__foot">
          Passwords are not editable from Cobalt. They are platform system fields that no
          script can write, and only the account holder can change their own.
          {s.isSelf && s.accountToolingUrl && (
            <> <a className="inlink" href={s.accountToolingUrl} target="_blank"
              rel="noopener noreferrer">Change yours in My Account</a>.</>
          )}
          {!s.isSelf && ' To reset this one, use the platform’s own account tooling.'}
        </p>
      </div>
    </section>
  )
}
