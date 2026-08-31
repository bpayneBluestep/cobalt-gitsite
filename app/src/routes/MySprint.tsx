import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError, getMySprint, updateTicket, formatHours, sprintLabel, isSprintKey,
  PRIORITY_RANK,
  type MySprintBoard, type Ticket,
} from '../api'
import { ticketPath } from '../components/TicketBoard'
import { useSession } from '../session'

/*
 * Your sprint, as a kanban.
 *
 * The team sprint board and this one answer different questions, so they have different
 * axes. There a column is a PERSON and the question is whether the week fits: capacity
 * against committed hours, everyone side by side. Here a column is a STATUS and the
 * question is what you personally are carrying and where it has got to. The same tickets,
 * and deliberately not the same page - one board trying to be both would be a grid.
 *
 * Complete is a real column, which the team board's backlog deliberately excludes. On a
 * personal board finishing something is the whole point, and you cannot drag into a
 * column that is not there.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; board: MySprintBoard }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

const NEW_TAB = { target: '_blank' as const, rel: 'noopener', draggable: false }

/** Two decimal places, the same rounding the server uses. */
const money = (n: number): number => Math.round(n * 100) / 100

export default function MySprint() {
  const { sprint = '' } = useParams()
  const navigate = useNavigate()
  const { can } = useSession()
  const mayEdit = can('editTickets')

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [dragging, setDragging] = useState<{ ticket: Ticket; from: string } | null>(null)
  const [over, setOver] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback((quiet = false) => {
    if (!quiet) setState({ phase: 'loading' })
    getMySprint(sprint)
      .then(board => setState({ phase: 'ready', board }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [sprint])

  useEffect(() => { if (isSprintKey(sprint)) load() }, [load, sprint])

  const board = state.phase === 'ready' ? state.board : null

  /*
   * Scroll while a card is in the air. Same reasoning as the team board: during a native
   * drag the wheel and the keyboard are both dead, so a tall page is otherwise
   * undraggable from one end to the other.
   */
  useEffect(() => {
    if (!dragging) return
    const EDGE = 120
    const MAX = 24
    let y = -1
    let frame = 0
    const track = (e: DragEvent) => { y = e.clientY }
    const tick = () => {
      const h = window.innerHeight
      let dy = 0
      if (y >= 0 && y < EDGE) dy = -Math.ceil(((EDGE - y) / EDGE) * MAX)
      else if (y > h - EDGE) dy = Math.ceil(((y - (h - EDGE)) / EDGE) * MAX)
      if (dy) window.scrollBy(0, dy)
      frame = requestAnimationFrame(tick)
    }
    window.addEventListener('dragover', track)
    frame = requestAnimationFrame(tick)
    return () => { window.removeEventListener('dragover', track); cancelAnimationFrame(frame) }
  }, [dragging])

  const totals = useMemo(() => {
    if (!board) return { total: 0, done: 0, est: 0, logged: 0 }
    let total = 0, done = 0, est = 0, logged = 0
    for (const c of board.columns) {
      for (const t of c.tickets) {
        total++
        if (c.status === 'Complete') done++
        est += t.estHours || 0
        logged += t.loggedHours || 0
      }
    }
    return { total, done, est: money(est), logged: money(logged) }
  }, [board])

  /**
   * Move a card to another status, locally first.
   *
   * The same trade the team board makes: `mySprint` walks every list to build this, so
   * refetching after each drop would put a rebuild between you and the next card. The
   * server's fresh ticket replaces the optimistic one when it lands; a refusal puts the
   * board back exactly as it was and reloads quietly.
   */
  function moveTo(t: Ticket, status: string) {
    if (!mayEdit || !board || t.status === status) return
    const before = board

    const next: MySprintBoard = {
      ...board,
      columns: board.columns.map(c => {
        const without = c.tickets.filter(x => x.entryId !== t.entryId)
        const tickets = c.status === status ? without.concat([{ ...t, status }]) : without
        tickets.sort((x, y) => (PRIORITY_RANK[y.priority] || 0) - (PRIORITY_RANK[x.priority] || 0))
        return {
          ...c,
          tickets,
          count: tickets.length,
          estHours: money(tickets.reduce((a, x) => a + (x.estHours || 0), 0)),
        }
      }),
    }
    setState({ phase: 'ready', board: next })
    setFailure('')
    setNotice((t.ticketNumber !== null ? '#' + t.ticketNumber : t.title) + ' → ' + status + '.')

    updateTicket(t.listId, t.entryId, { status })
      .then(fresh => setState(cur => (cur.phase === 'ready'
        ? {
          phase: 'ready',
          board: {
            ...cur.board,
            columns: cur.board.columns.map(c => ({
              ...c,
              tickets: c.tickets.map(x => (x.entryId === fresh.entryId ? fresh : x)),
            })),
          },
        }
        : cur)))
      .catch(err => {
        setState({ phase: 'ready', board: before })
        setNotice('')
        setFailure(err instanceof ApiError ? err.message : String(err))
        load(true)
      })
  }

  function startDrag(e: React.DragEvent, ticket: Ticket, from: string) {
    if (!mayEdit) return
    setDragging({ ticket, from })
    // Required: some browsers cancel a drag that carries no payload.
    e.dataTransfer.setData('text/plain', ticket.entryId)
    e.dataTransfer.effectAllowed = 'move'
  }
  const endDrag = () => { setDragging(null); setOver('') }

  if (!isSprintKey(sprint)) {
    return (
      <section className="page">
        <div className="callout">
          <p className="callout__title">Not a sprint</p>
          <p>A sprint is a plain number, like 18.</p>
          <p className="callout__actions">
            <Link className="btn" to="/">Back to Home</Link>
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="page">
      <header className="page__head">
        <div className="page__headrow">
          <div>
            <p className="eyebrow">
              <Link className="inlink" to="/">Home</Link> · Your work
            </p>
            <h1>{sprintLabel(sprint)}</h1>
          </div>
          <div className="page__head-tools">
            <button type="button" className="btn btn--ghost btn--sm"
              onClick={() => navigate('/sprints?sprint=' + sprint)}>
              See the whole board
            </button>
          </div>
        </div>
        <p className="page__sub-text">
          {state.phase === 'ready'
            ? totals.total === 0
              ? 'Nothing of yours is in ' + sprintLabel(sprint) + '.'
              : totals.total + ' ticket' + (totals.total === 1 ? '' : 's') + ', '
                + totals.done + ' complete · ' + formatHours(totals.est) + ' estimated, '
                + formatHours(totals.logged) + ' logged.'
            : 'Your tickets in this sprint, by status.'}
        </p>
      </header>

      {notice && <p className="board2__notice" role="status">{notice}</p>}
      {failure && (
        <p className="board2__failure" role="alert">
          {failure}
          <button type="button" className="board2__failure-x" onClick={() => setFailure('')}
            aria-label="Dismiss">×</button>
        </p>
      )}

      {state.phase === 'loading' && <p className="empty">Loading your sprint…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load your sprint'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load()}>Try again</button>}
          </p>
        </div>
      )}

      {board && (
        <div className="pipe kanban">
          {board.columns.map(col => (
            <section
              className="pipe__col"
              key={col.status}
              aria-label={col.status}
              data-over={over === col.status && dragging && dragging.from !== col.status ? '' : undefined}
              onDragOver={e => {
                if (!dragging || !mayEdit || dragging.from === col.status) return
                // Without preventDefault the browser refuses the drop entirely.
                e.preventDefault()
                if (over !== col.status) setOver(col.status)
              }}
              onDragLeave={() => setOver(o => (o === col.status ? '' : o))}
              onDrop={e => {
                e.preventDefault()
                const carried = dragging
                setOver(''); setDragging(null)
                if (carried && carried.from !== col.status) moveTo(carried.ticket, col.status)
              }}
            >
              <header className="pipe__head">
                <h2>
                  <span className="pill" data-status={col.status.replace(/\s+/g, '')}>{col.status}</span>
                </h2>
                <span className="pipe__n">{col.tickets.length}</span>
              </header>
              {col.tickets.length > 0 && (
                <p className="sprint__cap">
                  {formatHours(col.estHours)}
                  <span className="muted"> estimated</span>
                </p>
              )}

              {col.tickets.length === 0 && (
                <p className="pipe__empty">
                  {dragging && mayEdit && dragging.from !== col.status ? 'Drop here' : 'Nothing here'}
                </p>
              )}

              {col.tickets.map(t => (
                <article
                  className="dcard scard"
                  key={t.entryId}
                  data-prio={t.priority}
                  draggable={mayEdit}
                  data-drag={dragging && dragging.ticket.entryId === t.entryId ? '' : undefined}
                  onDragStart={e => startDrag(e, t, col.status)}
                  onDragEnd={endDrag}
                >
                  <p className="dcard__title">
                    {t.ticketNumber !== null && (
                      <Link className="tnum tnum--link" to={ticketPath(t)} {...NEW_TAB}>
                        #{t.ticketNumber}
                      </Link>
                    )}
                    <Link className="rowlink__a" to={ticketPath(t)} {...NEW_TAB}>{t.title}</Link>
                  </p>
                  {t.isSubtask && t.parentNumber !== null && (
                    <p className="dcard__parent muted">
                      part of{' '}
                      <Link className="inlink" to={'/tickets/' + t.parentNumber} {...NEW_TAB}>
                        #{t.parentNumber}
                      </Link>
                    </p>
                  )}
                  <p className="dcard__meta">
                    {t.priority && <span className="pill" data-prio={t.priority}>{t.priority}</span>}
                    <span>{t.estHours === null ? 'no est' : formatHours(t.estHours) + ' est'}</span>
                    {t.loggedHours ? <span className="muted">{formatHours(t.loggedHours)} logged</span> : null}
                  </p>
                  <p className="dcard__co">
                    <Link className="inlink" to={'/clients/' + (t.clientId || '') + '/tickets'}>
                      {t.clientName || t.listName}
                    </Link>
                  </p>
                  {t.roadblocked && (
                    <p className="dcard__next">Blocked: {t.roadblockReason}</p>
                  )}
                  {/* Drag fires on nothing but a mouse, so the select is the keyboard and
                      touch path rather than a redundant second control. */}
                  {mayEdit && (
                    <div className="dcard__move">
                      <select
                        aria-label={'Move "' + t.title + '" to another status'}
                        value={col.status}
                        onChange={e => moveTo(t, e.target.value)}
                      >
                        {board.statuses.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  )}
                </article>
              ))}
            </section>
          ))}
        </div>
      )}

      {board && (
        <p className="panel__foot">
          Walked {board.listsScanned} list{board.listsScanned === 1 ? '' : 's'} to build this.
          Drag a card into another column to change its status. Moving a ticket here never
          changes whose it is, or which sprint it is in.
        </p>
      )}
    </section>
  )
}
