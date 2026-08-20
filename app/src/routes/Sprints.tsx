import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ApiError, getSprint, getTeam, createSprint, assignSprint,
  addEngineer, updateEngineer, deleteEngineer,
  formatHours, shiftSprint, sprintLabel, isSprintKey, nameKey,
  ENGINEER_DISCIPLINES,
  type SprintBoard, type Team, type Ticket, type EngineerFieldKey, type User,
} from '../api'
import { loadUsers } from '../components/UserPicker'
import { useSession } from '../session'

/*
 * The sprint board — beh's Sprint Organizer, ported.
 *
 * A column per engineer, each measuring the estimates committed to them against their
 * capacity, plus the unsprinted backlog to pull work from. The point of the layout is
 * that over-commitment is visible before the sprint starts rather than discovered
 * halfway through it.
 *
 * A sprint is a plain NUMBER — 1, 2, 3 — the way the team says it out loud, and the way
 * beh has always numbered them. It used to be an ISO week (2026-W33): that reads like a
 * date, sorts nicely, and nobody ever said it in a sentence.
 *
 * The roster is PER SPRINT. Capacity moves week to week and people take leave, so each
 * sprint owns its own roster and starting a new one copies the previous forward. Editing
 * next sprint therefore cannot reach back and rewrite the history of a sprint that has
 * already happened — which is exactly what a single shared roster did.
 *
 * Assignment writes `responsibleId`, a real user id. The roster stores names, so the
 * two are matched by name here; a roster entry with no matching user cannot be assigned
 * to, and says so rather than silently failing at the endpoint.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; board: SprintBoard }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

type EngDraft = Record<EngineerFieldKey, string>

const emptyEng = (sprint: string): EngDraft => ({
  name: '', email: '', role: 'Engineer', capacity: '32', active: 'true', sprint,
})

/** An engineer on the roster, paired with the user record their name resolves to. */
interface Assignable {
  name: string
  /** The user id to write. Empty when no user has that name. */
  userId: string
}

function CapacityBar({ est, capacity, over }: { est: number; capacity: number; over: boolean }) {
  const pct = capacity > 0 ? Math.min(100, (est / capacity) * 100) : 0
  return (
    <span className="meter" data-over={over ? '' : undefined}>
      <span className="meter__fill" style={{ width: `${Math.max(est > 0 ? 3 : 0, pct)}%` }} />
    </span>
  )
}

export default function Sprints() {
  /*
   * Two different rights on one page, and conflating them would be wrong in both
   * directions:
   *
   *   planning  — putting a ticket into a sprint, or taking it out — is a Tickets write,
   *               so engineers and Client Success do it. That is the daily work.
   *   the roster — who is on the team, their capacity, starting a sprint — is an Engineers
   *               write, and belongs to Leadership. Capacity is a management decision.
   */
  const { can } = useSession()
  const mayPlan = can('editTickets')
  const mayRoster = can('editSprints')
  const [params, setParams] = useSearchParams()
  const urlSprint = params.get('sprint') || ''

  // '' means "not decided yet" — the first load picks the latest sprint that has a
  // roster, so landing on this page shows the sprint being worked rather than sprint 1.
  const [sprint, setSprintState] = useState(isSprintKey(urlSprint) ? urlSprint : '')
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [team, setTeam] = useState<Team | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [showRoster, setShowRoster] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [engEditing, setEngEditing] = useState<string | 'new' | null>(null)
  const [engDraft, setEngDraft] = useState<EngDraft>(emptyEng(''))

  /** Move to a sprint and put it in the URL, so the view can be linked to. */
  const setSprint = useCallback((key: string) => {
    setSprintState(key)
    setParams(key ? { sprint: key } : {}, { replace: true })
  }, [setParams])

  useEffect(() => { loadUsers().then(setUsers).catch(() => setUsers([])) }, [])

  // Decide which sprint to show, once, before the first board fetch — otherwise the
  // page loads sprint 1 and then jumps, which reads as a bug.
  useEffect(() => {
    if (sprint) return
    getTeam('', true)
      .then(t => {
        setTeam(t)
        setSprint(t.sprints.length ? t.sprints[t.sprints.length - 1] : '1')
      })
      .catch(() => setSprint('1'))
  }, [sprint, setSprint])

  const loadTeam = useCallback((key: string) => {
    getTeam(key, true).then(setTeam).catch(() => { /* the roster is secondary */ })
  }, [])

  const load = useCallback((key: string) => {
    if (!key) return
    setState({ phase: 'loading' })
    getSprint(key)
      .then(board => setState({ phase: 'ready', board }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(sprint); if (sprint) loadTeam(sprint) }, [load, loadTeam, sprint])

  const board = state.phase === 'ready' ? state.board : null

  function run(label: string, work: Promise<unknown>, said: string) {
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(() => {
        setNotice(said)
        load(sprint)
        loadTeam(sprint)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  /**
   * Who can be assigned this sprint: the roster, resolved to user ids.
   *
   * A roster name with no matching user is kept in the list but not selectable — the
   * fix is to correct the name or add the person, and hiding the row would just make
   * an engineer quietly disappear from the board with no clue why.
   */
  const assignable: Assignable[] = useMemo(() => {
    const byName = new Map<string, string>()
    for (const u of users) byName.set(nameKey(u.name), u.id)
    return (team?.rows || [])
      .filter(e => e.active)
      .map(e => ({ name: e.name, userId: byName.get(nameKey(e.name)) || '' }))
  }, [team, users])

  const unresolved = assignable.filter(a => !a.userId)

  /** Pull a backlog ticket into this sprint for someone, or move it between columns. */
  function plan(t: Ticket, userId: string, who: string) {
    if (!mayPlan) return
    if (!userId) {
      setFailure(`${who} is on the roster but has no matching user record, so work cannot be assigned to them.`)
      return
    }
    run('plan', assignSprint(t.listId, t.entryId, sprint, userId),
      `${t.ticketNumber !== null ? `#${t.ticketNumber}` : t.title} → ${who}.`)
  }

  function unplan(t: Ticket) {
    if (!mayPlan) return
    run('plan', assignSprint(t.listId, t.entryId, '', ''),
      `${t.ticketNumber !== null ? `#${t.ticketNumber}` : t.title} taken out of the sprint.`)
  }

  function saveEngineer() {
    if (busy || !mayRoster) return
    if (!engDraft.name.trim()) { setFailure('An engineer needs a name.'); return }
    const fields: Partial<Record<EngineerFieldKey, string>> = {
      name: engDraft.name.trim(), email: engDraft.email.trim(),
      role: engDraft.role, capacity: engDraft.capacity, active: engDraft.active,
      sprint: engDraft.sprint,
    }
    if (engEditing === 'new') {
      run('eng', addEngineer(fields).then(t => { setTeam(t); setEngEditing(null); return t }),
        `${fields.name} added to the roster.`)
      return
    }
    run('eng', updateEngineer(engEditing as string, fields).then(t => { setTeam(t); setEngEditing(null); return t }),
      'Roster updated.')
  }

  /** Start this sprint for real, by copying the previous roster forward. */
  function startSprint() {
    if (!mayRoster) return
    run('start', createSprint(sprint).then(t => { setTeam(t); return t }),
      `${sprintLabel(sprint)} started — the previous roster was copied forward.`)
  }

  const dash = <span className="muted">—</span>
  const templateRoster = !!board?.rosterIsTemplate

  /** A select of this sprint's engineers, used from three places. */
  function EngineerSelect({
    label, value, onPick,
  }: { label: string; value?: string; onPick: (userId: string, name: string) => void }) {
    return (
      <select
        className="minisel"
        aria-label={label}
        value={value ?? ''}
        disabled={!!busy}
        onChange={e => {
          const picked = assignable.find(a => a.name === e.target.value)
          if (picked) onPick(picked.userId, picked.name)
        }}
      >
        <option value="">Assign to…</option>
        {assignable.map(a => (
          <option key={a.name} value={a.name} disabled={!a.userId}>
            {a.name}{a.userId ? '' : ' (no user record)'}
          </option>
        ))}
      </select>
    )
  }

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Cobalt</p>
        <h1>Sprints</h1>
        <p className="page__sub-text">
          One sprint at a time. Each engineer's committed estimates against their capacity
          for that sprint, so an overloaded sprint shows before it starts.
        </p>
      </header>

      <div className="pipebar sprintbar">
        <div className="weekpick">
          <button type="button" className="btn btn--ghost btn--sm"
            onClick={() => setSprint(shiftSprint(sprint, -1))}
            disabled={!!busy || sprint === '1'}>
            ← Previous
          </button>
          <span className="weekpick__now">
            <strong>{sprintLabel(sprint)}</strong>
            {templateRoster && <span className="mark">not started</span>}
          </span>
          <button type="button" className="btn btn--ghost btn--sm"
            onClick={() => setSprint(shiftSprint(sprint, 1))} disabled={!!busy}>
            Next →
          </button>
          {board && board.sprints.length > 0 && sprint !== board.sprints[board.sprints.length - 1] && (
            <button type="button" className="linkbtn"
              onClick={() => setSprint(board.sprints[board.sprints.length - 1])}>
              Back to {sprintLabel(board.sprints[board.sprints.length - 1])}
            </button>
          )}
        </div>

        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowRoster(v => !v)}>
          {showRoster ? 'Hide roster' : `Roster (${team ? team.rows.filter(e => e.active).length : '…'})`}
        </button>
      </div>

      {notice && <p className="board2__notice" role="status">{notice}</p>}
      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      {/* A sprint nobody has started yet is showing the DEFAULT roster. Saying so
          matters: edit a row here and you are changing where every future sprint
          starts, not just this one. */}
      {templateRoster && (
        <div className="callout callout--warn">
          <p className="callout__title">{sprintLabel(sprint)} has not been started</p>
          <p>
            It is showing the default roster as a preview. Start it to copy the previous
            sprint's roster forward — after that, changing who is on it, or their hours,
            affects this sprint only.
          </p>
          <p className="callout__actions">
            {mayRoster ? (
              <button type="button" className="btn" onClick={startSprint} disabled={!!busy}>
                {busy === 'start' ? 'Starting…' : `Start ${sprintLabel(sprint)}`}
              </button>
            ) : (
              <span className="muted">Leadership starts a sprint.</span>
            )}
          </p>
        </div>
      )}

      {unresolved.length > 0 && (
        <div className="callout callout--warn">
          <p className="callout__title">
            {unresolved.length} roster name{unresolved.length === 1 ? '' : 's'} with no user record
          </p>
          <p>
            {unresolved.map(a => a.name).join(', ')} cannot be given work: a ticket stores
            the engineer as a user, and no user has that name. Correct the roster name so it
            matches, or add the person under Settings.
          </p>
        </div>
      )}

      {/* ---- the roster ---- */}
      {showRoster && (
        <section className="tsec">
          <div className="panel__head">
            <h2 className="tsec__h">
              Engineers
              {team && <span className="tsec__n">{team.rows.length}</span>}
            </h2>
            {team && (
              <span className="panel__note">
                {formatHours(team.weeklyCapacity)} across the active roster
                {team.isTemplate ? ' · the default roster' : ` · ${sprintLabel(sprint)} only`}
              </span>
            )}
            {mayRoster && (
              <button type="button" className="btn btn--sm"
                onClick={() => { setEngEditing('new'); setEngDraft(emptyEng(team?.isTemplate ? '' : sprint)) }}
                disabled={!!busy}>
                <span aria-hidden="true">+</span> Add engineer
              </button>
            )}
          </div>

          {engEditing && (
            <div className="editcard">
              <div className="editcard__head">
                <h2>{engEditing === 'new' ? 'New engineer' : 'Edit engineer'}</h2>
                <p className="note">
                  The name must match the person's user record — that is how a ticket's
                  responsible engineer finds their column.
                </p>
              </div>
              <div className="efgrid">
                <div className="ef">
                  <label htmlFor="en-name">Name</label>
                  <input id="en-name" type="text" value={engDraft.name} autoFocus autoComplete="off"
                    list="en-users"
                    onChange={e => setEngDraft(d => ({ ...d, name: e.target.value }))} />
                  {/* The user list as suggestions rather than a select: the roster can
                      legitimately name somebody who is not a Cobalt user yet. */}
                  <datalist id="en-users">
                    {users.map(u => <option key={u.id} value={u.name} />)}
                  </datalist>
                </div>
                <div className="ef">
                  <label htmlFor="en-email">Email</label>
                  <input id="en-email" type="email" value={engDraft.email} autoComplete="off"
                    onChange={e => setEngDraft(d => ({ ...d, email: e.target.value }))} />
                </div>
                <div className="ef">
                  <label htmlFor="en-role">Discipline</label>
                  <select id="en-role" value={engDraft.role}
                    onChange={e => setEngDraft(d => ({ ...d, role: e.target.value }))}>
                    {ENGINEER_DISCIPLINES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="ef">
                  <label htmlFor="en-cap">Capacity this sprint (hours)</label>
                  <input id="en-cap" type="number" min="0" max="80" step="1" value={engDraft.capacity}
                    onChange={e => setEngDraft(d => ({ ...d, capacity: e.target.value }))} />
                </div>
                <div className="ef">
                  <label htmlFor="en-active">On the board</label>
                  <label className="checkline">
                    <input id="en-active" type="checkbox" checked={engDraft.active === 'true'}
                      onChange={e => setEngDraft(d => ({ ...d, active: e.target.checked ? 'true' : 'false' }))} />
                    <span>Include in this sprint</span>
                  </label>
                </div>
                <div className="ef">
                  <label htmlFor="en-sprint">Applies to</label>
                  <select id="en-sprint" value={engDraft.sprint}
                    onChange={e => setEngDraft(d => ({ ...d, sprint: e.target.value }))}>
                    <option value={sprint}>{sprintLabel(sprint)} only</option>
                    <option value="">The default roster (every new sprint)</option>
                  </select>
                </div>
              </div>
              <div className="editcard__foot">
                <span className="editcard__status">{busy === 'eng' ? 'Saving…' : ''}</span>
                <button type="button" className="btn btn--ghost" onClick={() => setEngEditing(null)} disabled={!!busy}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={saveEngineer} disabled={!!busy}>
                  {engEditing === 'new' ? 'Add engineer' : 'Save'}
                </button>
              </div>
            </div>
          )}

          {team && team.rows.length > 0 && (
            <div className="tablewrap">
              <table className="fields compact">
                <thead>
                  <tr>
                    <th scope="col">Engineer</th>
                    <th scope="col">Discipline</th>
                    <th scope="col">Capacity</th>
                    <th scope="col">On the board</th>
                    <th scope="col"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {team.rows.map(e => (
                    <tr key={e.entryId} data-off={e.active ? undefined : ''}>
                      <th scope="row">
                        {e.name}
                        {e.email && <span className="contacts__title">{e.email}</span>}
                      </th>
                      <td>{e.role || dash}</td>
                      <td className="num">{formatHours(e.capacity)}</td>
                      <td>{e.active ? 'Yes' : <span className="muted">No</span>}</td>
                      <td className="leads__act">
                        {mayRoster ? (
                          <>
                            <button type="button" className="linkbtn" disabled={!!busy}
                              onClick={() => {
                                setEngEditing(e.entryId)
                                setEngDraft({
                                  name: e.name, email: e.email, role: e.role || 'Engineer',
                                  capacity: String(e.capacity), active: e.active ? 'true' : 'false',
                                  sprint: e.sprint || '',
                                })
                              }}>
                              Edit
                            </button>
                            <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                              onClick={() => run('eng', deleteEngineer(e.entryId).then(t => { setTeam(t); return t }),
                                `${e.name} removed from the roster.`)}>
                              Remove
                            </button>
                          </>
                        ) : dash}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {state.phase === 'loading' && <p className="empty">Loading the sprint…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load the sprint'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load(sprint)}>Try again</button>}
          </p>
        </div>
      )}

      {board && board.totals.engineers === 0 ? (
        <div className="callout callout--plain">
          <p className="callout__title">No engineers on the roster yet</p>
          <p>
            A sprint is engineers and their capacity, so that comes first.{' '}
            {mayRoster ? (
              <>
                <button type="button" className="linkbtn"
                  onClick={() => { setShowRoster(true); setEngEditing('new'); setEngDraft(emptyEng('')) }}>
                  Add the first one
                </button>.
              </>
            ) : 'Leadership sets the roster.'}
          </p>
        </div>
      ) : board && (
        <>
          <div className="kpis">
            <div className="kpi">
              <p className="kpi__k">Committed</p>
              <p className="kpi__v">{formatHours(board.totals.estHours)}</p>
              <p className="kpi__n">{board.totals.tickets} ticket{board.totals.tickets === 1 ? '' : 's'}</p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Capacity</p>
              <p className="kpi__v">{formatHours(board.totals.capacity)}</p>
              <p className="kpi__n">{board.totals.engineers} engineer{board.totals.engineers === 1 ? '' : 's'}</p>
            </div>
            <div className="kpi" data-tone={board.totals.over ? 'bad' : undefined}>
              <p className="kpi__k">{board.totals.over ? 'Over by' : 'Headroom'}</p>
              <p className="kpi__v">{formatHours(Math.abs(board.totals.remaining))}</p>
              <p className="kpi__n">
                {board.totals.utilisation === null ? 'no capacity set' : `${board.totals.utilisation}% committed`}
              </p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Logged so far</p>
              <p className="kpi__v">{formatHours(board.totals.loggedHours)}</p>
              <p className="kpi__n">{board.totals.done} complete</p>
            </div>
          </div>

          {board.unassigned.length > 0 && (
            <div className="callout callout--warn">
              <p className="callout__title">
                {board.unassigned.length} ticket{board.unassigned.length === 1 ? '' : 's'} in this sprint with nobody on it
              </p>
              <p>
                {board.unassigned.map(t => t.title).slice(0, 3).join(', ')}
                {board.unassigned.length > 3 ? '…' : ''}. Assign them below, or they count
                against nobody's capacity.
              </p>
              <ul className="cab__folders">
                {board.unassigned.map(t => (
                  <li className="cab__folder" key={t.entryId}>
                    <span className="cab__open">
                      <span className="cab__name">{t.title}</span>
                      <span className="cab__count">{formatHours(t.estHours)}</span>
                    </span>
                    <EngineerSelect
                      label={`Assign ${t.title}`}
                      onPick={(userId, name) => plan(t, userId, name)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="pipe sprint">
            {board.columns.map(col => (
              <section className="pipe__col" key={col.entryId || col.engineer} aria-label={col.engineer}>
                <header className="pipe__head">
                  <h2>{col.engineer}</h2>
                  <span className="pipe__n">{col.tickets.length}</span>
                </header>
                <p className="sprint__cap" data-over={col.over ? '' : undefined}>
                  {formatHours(col.estHours)}
                  <span className="muted"> of {formatHours(col.capacity)}</span>
                  {col.utilisation !== null && (
                    <span className="sprint__pct">{col.utilisation}%</span>
                  )}
                </p>
                <CapacityBar est={col.estHours} capacity={col.capacity} over={col.over} />
                {col.role && <p className="sprint__role">{col.role}</p>}

                {col.tickets.length === 0 && <p className="pipe__empty">Nothing planned</p>}

                {col.tickets.map(t => (
                  <article className="dcard scard" key={t.entryId} data-prio={t.priority}>
                    <p className="dcard__title">
                      {t.ticketNumber !== null && <span className="tnum">#{t.ticketNumber}</span>}
                      <span>{t.title}</span>
                    </p>
                    {/* A subtask in a sprint is a chunk of something bigger, and a card
                        reading "Backfill existing records" with no context is unplannable
                        on its own. The parent is what makes it mean anything. */}
                    {t.isSubtask && t.parentNumber !== null && (
                      <p className="dcard__parent muted">
                        part of{' '}
                        <Link className="inlink" to={`/tickets/${t.parentNumber}`}>#{t.parentNumber}</Link>
                        {t.parentTitle ? ` ${t.parentTitle}` : ''}
                      </p>
                    )}
                    <p className="dcard__meta">
                      <span className="pill" data-status={(t.status || 'Open').replace(/\s+/g, '')}>{t.status}</span>
                      <span>{formatHours(t.estHours)} est</span>
                      {t.loggedHours ? <span className="muted">{formatHours(t.loggedHours)} logged</span> : null}
                    </p>
                    <p className="dcard__co">
                      <Link className="inlink" to={`/clients/${t.clientId || ''}/tickets`}>
                        {t.clientName || t.listName}
                      </Link>
                    </p>
                    {t.accountableName && (
                      <p className="dcard__co muted">PM: {t.accountableName}</p>
                    )}
                    {t.roadblocked && (
                      <p className="dcard__next">Blocked: {t.roadblockReason}</p>
                    )}
                    <div className="dcard__move">
                      <EngineerSelect
                        label={`Move ${t.title} to another engineer`}
                        value={col.engineer}
                        onPick={(userId, name) => plan(t, userId, name)}
                      />
                      <button type="button" className="linkbtn" disabled={!!busy} onClick={() => unplan(t)}>
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>

          {/* ---- the backlog ---- */}
          <section className="tsec">
            <div className="panel__head">
              <h2 className="tsec__h">
                Backlog
                {board.backlogTotal > 0 && <span className="tsec__n">{board.backlogTotal}</span>}
              </h2>
              <span className="panel__note">
                Open work with no sprint yet, biggest first
                {board.backlogTotal > board.backlog.length && ` · showing ${board.backlog.length}`}
              </span>
            </div>

            {board.backlog.length === 0 ? (
              <p className="muted tsec__empty">
                Nothing unplanned — every open ticket already belongs to a sprint.
              </p>
            ) : (
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Ticket</th>
                      <th scope="col">For</th>
                      <th scope="col">Priority</th>
                      <th scope="col">Est</th>
                      <th scope="col">Plan into {sprintLabel(sprint)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.backlog.map(t => (
                      <tr key={t.entryId} data-prio={t.priority}>
                        <td className="tickets__num">
                          {t.ticketNumber === null
                            ? dash
                            : <span className="tnum">#{t.ticketNumber}</span>}
                        </td>
                        <th scope="row">
                          {t.isSubtask && t.parentNumber !== null && (
                            <span className="subcrumb">#{t.parentNumber} ›</span>
                          )}
                          {t.title}
                        </th>
                        <td>{t.clientName || t.listName}</td>
                        <td><span className="pill" data-prio={t.priority}>{t.priority}</span></td>
                        <td className="num">
                          {t.estHours === null
                            ? <span className="muted">no est</span>
                            : formatHours(t.estHours)}
                        </td>
                        <td>
                          <EngineerSelect
                            label={`Plan ${t.title}`}
                            onPick={(userId, name) => plan(t, userId, name)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="panel__foot">
            Walked {board.listsScanned} list{board.listsScanned === 1 ? '' : 's'} to build this.
            A ticket with no estimate counts as zero hours, so it plans in without moving
            the bar — set one on the ticket to make the sprint honest.
          </p>
        </>
      )}
    </section>
  )
}
