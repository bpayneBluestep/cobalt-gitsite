import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, getSprint, getTeam, assignSprint, addEngineer, updateEngineer, deleteEngineer,
  formatHours, weekKey, shiftWeek, weekRange,
  ENGINEER_DISCIPLINES, type SprintBoard, type Team, type Ticket, type EngineerFieldKey,
} from '../api'

/*
 * The weekly sprint board — beh's Sprint Organizer, ported.
 *
 * A column per engineer, each measuring the estimates assigned to them against their
 * capacity, plus the unsprinted backlog to pull work from. The point of the layout is
 * that over-commitment is visible before the week starts rather than discovered halfway
 * through it.
 *
 * Almost none of this needed new schema: a ticket already carries `sprint`, `assignee`
 * and `estHours`, so planning a week is writing two existing fields. The one addition
 * was the roster — who the engineers are and how many hours each has.
 *
 * The sprint key is an ISO week (2026-W33) computed here; the endpoint treats it as an
 * opaque string, so the browser and the platform never have to agree about when a week
 * begins — only about the characters in the key.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; board: SprintBoard }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

type EngDraft = Record<EngineerFieldKey, string>
const EMPTY_ENG: EngDraft = { name: '', email: '', role: 'Engineer', capacity: '32', active: 'true' }

function CapacityBar({ est, capacity, over }: { est: number; capacity: number; over: boolean }) {
  const pct = capacity > 0 ? Math.min(100, (est / capacity) * 100) : 0
  return (
    <span className="meter" data-over={over ? '' : undefined}>
      <span className="meter__fill" style={{ width: `${Math.max(est > 0 ? 3 : 0, pct)}%` }} />
    </span>
  )
}

export default function Sprints() {
  const thisWeek = useMemo(() => weekKey(new Date()), [])
  const [sprint, setSprint] = useState(thisWeek)
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [team, setTeam] = useState<Team | null>(null)
  const [showRoster, setShowRoster] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [engEditing, setEngEditing] = useState<string | 'new' | null>(null)
  const [engDraft, setEngDraft] = useState<EngDraft>(EMPTY_ENG)

  const load = useCallback((key: string) => {
    setState({ phase: 'loading' })
    getSprint(key)
      .then(board => setState({ phase: 'ready', board }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(sprint) }, [load, sprint])
  useEffect(() => { getTeam(true).then(setTeam).catch(() => setTeam(null)) }, [])

  const board = state.phase === 'ready' ? state.board : null

  function run(label: string, work: Promise<unknown>, said: string) {
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(() => {
        setNotice(said)

        load(sprint)
        getTeam(true).then(setTeam).catch(() => { /* roster is secondary */ })
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  /** Pull a backlog ticket into this sprint for someone, or move it between columns. */
  function plan(t: Ticket, engineer: string) {
    run('plan', assignSprint(t.listId, t.entryId, sprint, engineer),
      `${t.ticketNumber !== null ? `#${t.ticketNumber}` : t.title} → ${engineer}.`)
  }

  function unplan(t: Ticket) {
    run('plan', assignSprint(t.listId, t.entryId, '', ''),
      `${t.ticketNumber !== null ? `#${t.ticketNumber}` : t.title} taken out of the sprint.`)
  }

  function saveEngineer() {
    if (busy) return
    if (!engDraft.name.trim()) { setFailure('An engineer needs a name.'); return }
    const fields: Partial<Record<EngineerFieldKey, string>> = {
      name: engDraft.name.trim(), email: engDraft.email.trim(),
      role: engDraft.role, capacity: engDraft.capacity, active: engDraft.active,
    }
    if (engEditing === 'new') {
      run('eng', addEngineer(fields).then(t => { setTeam(t); setEngEditing(null); return t }),
        `${fields.name} added to the roster.`)
      return
    }
    run('eng', updateEngineer(engEditing as string, fields).then(t => { setTeam(t); setEngEditing(null); return t }),
      'Roster updated.')
  }

  const engineerNames = (team?.rows || []).filter(e => e.active).map(e => e.name)

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Cobalt</p>
        <h1>Sprints</h1>
        <p className="page__sub-text">
          One week at a time. Each engineer's committed estimates against their capacity,
          so an overloaded week shows before it starts.
        </p>
      </header>

      <div className="pipebar sprintbar">
        <div className="weekpick">
          <button type="button" className="btn btn--ghost btn--sm"
            onClick={() => setSprint(s => shiftWeek(s, -1))} disabled={!!busy}>
            ← Previous
          </button>
          <span className="weekpick__now">
            <strong>{sprint}</strong>
            <span className="muted"> {weekRange(sprint)}</span>
            {sprint === thisWeek && <span className="mark mark--timer">this week</span>}
          </span>
          <button type="button" className="btn btn--ghost btn--sm"
            onClick={() => setSprint(s => shiftWeek(s, 1))} disabled={!!busy}>
            Next →
          </button>
          {sprint !== thisWeek && (
            <button type="button" className="linkbtn" onClick={() => setSprint(thisWeek)}>
              Back to this week
            </button>
          )}
        </div>

        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowRoster(v => !v)}>
          {showRoster ? 'Hide roster' : `Roster (${team ? team.rows.filter(e => e.active).length : '…'})`}
        </button>
      </div>

      {notice && <p className="board2__notice" role="status">{notice}</p>}
      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      {/* ---- the roster ---- */}
      {showRoster && (
        <section className="tsec">
          <div className="panel__head">
            <h2 className="tsec__h">
              Engineers
              {team && <span className="tsec__n">{team.rows.length}</span>}
            </h2>
            {team && (
              <span className="panel__note">{formatHours(team.weeklyCapacity)} a week across the active roster</span>
            )}
            <button type="button" className="btn btn--sm"
              onClick={() => { setEngEditing('new'); setEngDraft(EMPTY_ENG) }} disabled={!!busy}>
              <span aria-hidden="true">+</span> Add engineer
            </button>
          </div>

          {engEditing && (
            <div className="editcard">
              <div className="editcard__head">
                <h2>{engEditing === 'new' ? 'New engineer' : 'Edit engineer'}</h2>
                <p className="note">
                  The name must match what goes in a ticket's Assignee field — that is how
                  work finds its column.
                </p>
              </div>
              <div className="efgrid">
                <div className="ef">
                  <label htmlFor="en-name">Name</label>
                  <input id="en-name" type="text" value={engDraft.name} autoFocus autoComplete="off"
                    onChange={e => setEngDraft(d => ({ ...d, name: e.target.value }))} />
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
                  <label htmlFor="en-cap">Weekly capacity (hours)</label>
                  <input id="en-cap" type="number" min="0" max="80" step="1" value={engDraft.capacity}
                    onChange={e => setEngDraft(d => ({ ...d, capacity: e.target.value }))} />
                </div>
                <div className="ef">
                  <label htmlFor="en-active">On the board</label>
                  <label className="checkline">
                    <input id="en-active" type="checkbox" checked={engDraft.active === 'true'}
                      onChange={e => setEngDraft(d => ({ ...d, active: e.target.checked ? 'true' : 'false' }))} />
                    <span>Include in sprints</span>
                  </label>
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
                      <td>{e.role || <span className="muted">—</span>}</td>
                      <td className="num">{formatHours(e.capacity)}</td>
                      <td>{e.active ? 'Yes' : <span className="muted">No</span>}</td>
                      <td className="leads__act">
                        <button type="button" className="linkbtn" disabled={!!busy}
                          onClick={() => {
                            setEngEditing(e.entryId)
                            setEngDraft({
                              name: e.name, email: e.email, role: e.role || 'Engineer',
                              capacity: String(e.capacity), active: e.active ? 'true' : 'false',
                            })
                          }}>
                          Edit
                        </button>
                        <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                          onClick={() => run('eng', deleteEngineer(e.entryId).then(t => { setTeam(t); return t }),
                            `${e.name} removed from the roster.`)}>
                          Remove
                        </button>
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
            <button type="button" className="linkbtn"
              onClick={() => { setShowRoster(true); setEngEditing('new'); setEngDraft(EMPTY_ENG) }}>
              Add the first one
            </button>.
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
                    <select className="minisel" aria-label={`Assign ${t.title}`} defaultValue=""
                      disabled={!!busy}
                      onChange={e => { if (e.target.value) plan(t, e.target.value) }}>
                      <option value="">Assign to…</option>
                      {engineerNames.map(nm => <option key={nm} value={nm}>{nm}</option>)}
                    </select>
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
                    {t.roadblocked && (
                      <p className="dcard__next">Blocked: {t.roadblockReason}</p>
                    )}
                    <div className="dcard__move">
                      <select
                        aria-label={`Move ${t.title} to another engineer`}
                        value={col.engineer}
                        disabled={!!busy}
                        onChange={e => plan(t, e.target.value)}
                      >
                        {engineerNames.map(nm => <option key={nm} value={nm}>{nm}</option>)}
                      </select>
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
                      <th scope="col">Plan into {sprint}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.backlog.map(t => (
                      <tr key={t.entryId} data-prio={t.priority}>
                        <td className="tickets__num">
                          {t.ticketNumber === null
                            ? <span className="muted">—</span>
                            : <span className="tnum">#{t.ticketNumber}</span>}
                        </td>
                        <th scope="row">{t.title}</th>
                        <td>{t.clientName || t.listName}</td>
                        <td><span className="pill" data-prio={t.priority}>{t.priority}</span></td>
                        <td className="num">
                          {t.estHours === null
                            ? <span className="muted">no est</span>
                            : formatHours(t.estHours)}
                        </td>
                        <td>
                          <select className="minisel" aria-label={`Plan ${t.title}`} defaultValue=""
                            disabled={!!busy}
                            onChange={e => { if (e.target.value) plan(t, e.target.value) }}>
                            <option value="">Assign to…</option>
                            {engineerNames.map(nm => <option key={nm} value={nm}>{nm}</option>)}
                          </select>
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
            the bar — set one on the ticket to make the week honest.
          </p>
        </>
      )}
    </section>
  )
}
