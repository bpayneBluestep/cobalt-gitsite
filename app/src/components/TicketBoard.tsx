import { Fragment, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  addTicket, updateTicket, ApiError, formatHours,
  TICKET_STATUSES, TICKET_PRIORITIES, TICKET_TABS, PRIORITY_RANK,
  type List, type Ticket, type TicketFieldKey,
} from '../api'
import { htmlToText } from '../lib/html'

/** Where a ticket lives. The number is the shareable form; the entry id is the fallback. */
export const ticketPath = (t: Ticket): string =>
  `/tickets/${t.ticketNumber === null ? t.entryId : t.ticketNumber}`

/*
 * The ticket board for one list — the Cobalt port of beh's "Clickup Killer".
 *
 * Deliberately the same shape as that tool: Open / Ready / Current / Completed
 * tabs over the same status vocabulary, a table grouped by status (only when a
 * tab holds more than one), each group sorted by priority, and a search plus
 * filter row above it.
 *
 * One difference, and it's an improvement rather than a shortcut: beh fetches per
 * tab and asks the server for counts separately. A Cobalt list is small and comes
 * back in a single `tickets` call, so tabs, counts and filters are all computed
 * here — four round trips become one, and switching tabs is instant.
 *
 * The board owns the table and the create form. A ticket itself is a PAGE, at
 * /tickets/<number> — so it can be linked to and sent to someone. A row is a real
 * link, which also means middle-click and "open in new tab" work.
 */

/** Only the fields the create form collects; the rest are set from the drawer. */
type NewDraft = Pick<Record<TicketFieldKey, string>, 'title' | 'status' | 'priority' | 'assignee' | 'dueDate' | 'sprint'>

const EMPTY_DRAFT: NewDraft = {
  title: '', status: 'Open', priority: 'Normal', assignee: '', dueDate: '', sprint: '',
}

/** Which tab a status belongs to — beh's `tabOf`, unchanged. */
function tabOf(status: string): string {
  for (const t of TICKET_TABS) if ((t.statuses as readonly string[]).indexOf(status || 'Open') >= 0) return t.key
  return 'open'
}

function byPriority(a: Ticket, b: Ticket): number {
  return (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0)
}

export default function TicketBoard({
  list, tickets, onChanged, onTicket,
}: {
  list: List
  tickets: Ticket[]
  onChanged: () => void
  /** Replace one ticket in the caller's copy, from an action's fresh reply. */
  onTicket: (t: Ticket) => void
}) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('open')
  const [search, setSearch] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fPriority, setFPriority] = useState('')
  const [fAssignee, setFAssignee] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<NewDraft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')

  const counts = useMemo(() => {
    const c: Record<string, number> = { open: 0, ready: 0, current: 0, completed: 0 }
    for (const t of tickets) c[tabOf(t.status)] = (c[tabOf(t.status)] || 0) + 1
    return c
  }, [tickets])

  const activeFilters = [fStatus, fPriority, fAssignee].filter(Boolean).length

  const visible = useMemo(() => {
    const q = search.toLowerCase().trim()
    return tickets.filter(t => {
      if (tabOf(t.status) !== tab) return false
      if (fStatus && t.status !== fStatus) return false
      if (fPriority && t.priority !== fPriority) return false
      if (fAssignee === '__none' && t.assignee) return false
      if (fAssignee && fAssignee !== '__none' && !t.assignee.toLowerCase().includes(fAssignee.toLowerCase())) return false
      if (!q) return true
      // Details is markup — search its text, so a query can't match a tag name.
      const haystack = [t.title, t.assignee, t.sprint, htmlToText(t.details), t.roadblockReason]
      if (t.ticketNumber !== null) haystack.push(`#${t.ticketNumber}`)
      return haystack.some(v => (v || '').toLowerCase().includes(q))
    })
  }, [tickets, tab, search, fStatus, fPriority, fAssignee])

  // Group by status only when the tab holds more than one — beh's rule exactly.
  const groups = useMemo(() => {
    const present = TICKET_STATUSES.filter(s => visible.some(t => (t.status || 'Open') === s))
    if (present.length <= 1) return [{ status: '', rows: visible.slice().sort(byPriority) }]
    return present.map(status => ({
      status,
      rows: visible.filter(t => (t.status || 'Open') === status).sort(byPriority),
    }))
  }, [visible])

  function openNew() {
    setCreating(true)
    setDraft({ ...EMPTY_DRAFT, status: TICKET_TABS.find(t => t.key === tab)?.statuses[0] || 'Open' })
    setFailure(''); setNotice('')
  }

  function create() {
    if (busy) return
    if (!draft.title.trim()) { setFailure('A ticket needs a title.'); return }
    setBusy(true); setFailure('')

    // Send only what was filled in, so a blank field never overwrites a default.
    const fields: Partial<Record<TicketFieldKey, string>> = {}
    for (const k of Object.keys(draft) as (keyof NewDraft)[]) {
      if (draft[k].trim()) fields[k] = draft[k].trim()
    }
    addTicket(list.id, fields)
      .then(created => {
        setCreating(false)
        onChanged()
        // Straight into the new ticket: the form collects only the essentials, and the
        // description is the reason you were adding it.
        navigate(ticketPath(created))
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  /** Move a ticket's status straight from its row, without opening it. */
  function quickStatus(t: Ticket, status: string) {
    if (busy) return
    setBusy(true); setFailure(''); setNotice('')
    updateTicket(list.id, t.entryId, { status })
      .then(fresh => { onTicket(fresh); setNotice(`Moved to ${status}.`) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const dash = <span className="muted">—</span>

  return (
    <section className="board2">
      <div className="board2__bar">
        <nav className="tabs" aria-label="Ticket status">
          {TICKET_TABS.map(t => (
            <button
              key={t.key}
              type="button"
              className="tab"
              data-on={t.key === tab ? '' : undefined}
              aria-current={t.key === tab ? 'true' : undefined}
              onClick={() => { setTab(t.key); setCreating(false); setFailure('') }}
            >
              {t.label}
              <span className="tab__n">{counts[t.key] || 0}</span>
            </button>
          ))}
        </nav>
        <button type="button" className="btn" onClick={openNew}>
          <span aria-hidden="true">+</span> New ticket
        </button>
      </div>

      <div className="board2__tools">
        <input
          type="text"
          className="board2__search"
          placeholder="Search tickets…"
          value={search}
          autoComplete="off"
          onChange={e => setSearch(e.target.value)}
        />
        <button
          type="button"
          className="filter"
          data-on={showFilters || activeFilters ? '' : undefined}
          onClick={() => setShowFilters(v => !v)}
          aria-expanded={showFilters}
        >
          Filters{activeFilters ? <span className="filter__n">{activeFilters}</span> : null}
        </button>
      </div>

      {showFilters && (
        <div className="board2__filters">
          <div className="ef">
            <label htmlFor="f-status">Status</label>
            <select id="f-status" value={fStatus} onChange={e => setFStatus(e.target.value)}>
              <option value="">Any status</option>
              {TICKET_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="ef">
            <label htmlFor="f-priority">Priority</label>
            <select id="f-priority" value={fPriority} onChange={e => setFPriority(e.target.value)}>
              <option value="">Any priority</option>
              {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="ef">
            <label htmlFor="f-assignee">Assignee</label>
            <input
              id="f-assignee"
              type="text"
              placeholder="Name contains…"
              value={fAssignee === '__none' ? '' : fAssignee}
              onChange={e => setFAssignee(e.target.value)}
            />
          </div>
          <div className="ef">
            <label htmlFor="f-unassigned">Unassigned only</label>
            <label className="checkline">
              <input
                id="f-unassigned"
                type="checkbox"
                checked={fAssignee === '__none'}
                onChange={e => setFAssignee(e.target.checked ? '__none' : '')}
              />
              <span>Hide tickets that have an assignee</span>
            </label>
          </div>
          {activeFilters > 0 && (
            <div className="ef">
              <label>&nbsp;</label>
              <button type="button" className="btn btn--ghost" onClick={() => { setFStatus(''); setFPriority(''); setFAssignee('') }}>
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      {notice && <p className="board2__notice" role="status">{notice}</p>}

      {/* Create collects only the essentials. Details, time, files and the roadblock all
          belong to a ticket that exists, so they live on the ticket's own page rather
          than making the first step longer than it needs to be. */}
      {creating && (
        <div className="editcard newclient">
          <div className="editcard__head">
            <h2>New ticket</h2>
            <p className="note">It gets the next number automatically. Open it afterwards to add detail.</p>
          </div>

          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          <div className="efgrid">
            <div className="ef ef--wide">
              <label htmlFor="t-title">Title<span className="ef__req" aria-hidden="true">*</span></label>
              <input id="t-title" type="text" value={draft.title} autoFocus autoComplete="off"
                onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter' && draft.title.trim()) create() }} />
            </div>
            <div className="ef">
              <label htmlFor="t-status">Status</label>
              <select id="t-status" value={draft.status} onChange={e => setDraft(d => ({ ...d, status: e.target.value }))}>
                {TICKET_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="ef">
              <label htmlFor="t-priority">Priority</label>
              <select id="t-priority" value={draft.priority} onChange={e => setDraft(d => ({ ...d, priority: e.target.value }))}>
                {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="ef">
              <label htmlFor="t-assignee">Assignee</label>
              <input id="t-assignee" type="text" value={draft.assignee} autoComplete="off"
                onChange={e => setDraft(d => ({ ...d, assignee: e.target.value }))} />
            </div>
            <div className="ef">
              <label htmlFor="t-due">Due date</label>
              <input id="t-due" type="date" value={draft.dueDate}
                onChange={e => setDraft(d => ({ ...d, dueDate: e.target.value }))} />
            </div>
            <div className="ef">
              <label htmlFor="t-sprint">Sprint</label>
              <input id="t-sprint" type="text" value={draft.sprint} placeholder="2026-W33" autoComplete="off"
                onChange={e => setDraft(d => ({ ...d, sprint: e.target.value }))} />
            </div>
          </div>

          <div className="editcard__foot">
            <span className="editcard__status">
              {busy ? 'Adding…' : 'It gets the next number, then opens.'}
            </span>
            <button type="button" className="btn btn--ghost" onClick={() => { setCreating(false); setFailure('') }} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={create} disabled={busy || !draft.title.trim()}>
              Add ticket
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="callout callout--plain">
          <p className="callout__title">
            {tickets.length === 0 ? 'No tickets on this list yet' : 'Nothing in this tab'}
          </p>
          <p>
            {tickets.length === 0
              ? 'Use New ticket to add the first one.'
              : search || activeFilters
                ? 'No tickets match the current search or filters.'
                : `Nothing is ${TICKET_TABS.find(t => t.key === tab)?.label.toLowerCase()} right now.`}
          </p>
        </div>
      ) : (
        <div className="tablewrap">
          <table className="fields tickets">
            <thead>
              <tr>
                <th scope="col" className="tickets__num">#</th>
                <th scope="col">Title</th>
                <th scope="col">Priority</th>
                <th scope="col">Assignee</th>
                <th scope="col">Time</th>
                <th scope="col">Due</th>
                <th scope="col"><span className="visually-hidden">Move</span></th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <Fragment key={g.status || '_all'}>
                  {g.status && (
                    <tr className="grouprow">
                      <td colSpan={7}>
                        <span className="pill" data-status={g.status.replace(/\s+/g, '')}>{g.status}</span>
                        <span className="grouprow__n">{g.rows.length}</span>
                      </td>
                    </tr>
                  )}
                  {g.rows.map(t => {
                    const est = t.estHours
                    const logged = t.loggedHours || 0
                    const over = est !== null && est > 0 && logged > est
                    return (
                      <tr
                        key={t.entryId}
                        className="rowlink"
                        data-prio={t.priority}
                        data-blocked={t.roadblocked ? '' : undefined}
                      >
                        <td className="tickets__num">
                          {t.ticketNumber === null
                            ? <span className="muted">—</span>
                            : <Link className="tnum tnum--link" to={ticketPath(t)}>#{t.ticketNumber}</Link>}
                        </td>
                        <th scope="row">
                          {/* A real link: shareable, middle-clickable, and the browser
                              shows where it goes. */}
                          <Link className="rowlink__a" to={ticketPath(t)}>
                            {t.title || <span className="muted">(untitled)</span>}
                          </Link>
                          <span className="rowmarks">
                            {t.roadblocked && (
                              <span className="mark mark--block" title={t.roadblockReason || 'Roadblocked'}>
                                blocked
                              </span>
                            )}
                            {t.timerRunning && (
                              <span className="mark mark--timer" title={`Timer running${t.timerBy ? ` for ${t.timerBy}` : ''}`}>
                                timing
                              </span>
                            )}
                            {t.attachments.length > 0 && (
                              <span className="mark" title={`${t.attachments.length} attachment${t.attachments.length === 1 ? '' : 's'}`}>
                                {t.attachments.length} file{t.attachments.length === 1 ? '' : 's'}
                              </span>
                            )}
                          </span>
                        </th>
                        <td><span className="pill" data-prio={t.priority}>{t.priority || 'Normal'}</span></td>
                        <td>{t.assignee || dash}</td>
                        <td className="tickets__time">
                          {logged || est !== null ? (
                            <span className="tvs" data-over={over ? '' : undefined}>
                              {logged ? formatHours(logged) : '0h'}
                              <span className="tvs__sep">/</span>
                              <span className="tvs__est">{est === null ? '—' : formatHours(est)}</span>
                            </span>
                          ) : dash}
                        </td>
                        <td>{t.dueDate || dash}</td>
                        <td className="tickets__move">
                          <select
                            aria-label={`Move "${t.title}" to another status`}
                            value={t.status || 'Open'}
                            disabled={busy}
                            onChange={e => quickStatus(t, e.target.value)}
                          >
                            {TICKET_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </section>
  )
}
