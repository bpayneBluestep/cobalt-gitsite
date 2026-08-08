import { Fragment, useMemo, useState } from 'react'
import {
  addTicket, updateTicket, deleteTicket, ApiError,
  TICKET_STATUSES, TICKET_PRIORITIES, TICKET_TABS, PRIORITY_RANK,
  type List, type Ticket, type TicketFieldKey,
} from '../api'

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
 */

type Draft = Record<TicketFieldKey, string>

const EMPTY_DRAFT: Draft = {
  title: '', status: 'Open', priority: 'Normal', assignee: '', dueDate: '', sprint: '', details: '',
}

function draftOf(t: Ticket): Draft {
  return {
    title: t.title || '', status: t.status || 'Open', priority: t.priority || 'Normal',
    assignee: t.assignee || '', dueDate: t.dueDate || '', sprint: t.sprint || '', details: t.details || '',
  }
}

function changed(draft: Draft, saved: Ticket): Partial<Record<TicketFieldKey, string>> {
  const out: Partial<Record<TicketFieldKey, string>> = {}
  for (const k of Object.keys(draft) as TicketFieldKey[]) {
    if (draft[k] !== ((saved[k] as string) || '')) out[k] = draft[k]
  }
  return out
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
  list, tickets, onChanged,
}: {
  list: List
  tickets: Ticket[]
  onChanged: () => void
}) {
  const [tab, setTab] = useState('open')
  const [search, setSearch] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fPriority, setFPriority] = useState('')
  const [fAssignee, setFAssignee] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  // The editor doubles as create and edit — same fields, one code path.
  const [editing, setEditing] = useState<Ticket | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

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
      return [t.title, t.assignee, t.sprint, t.details].some(v => (v || '').toLowerCase().includes(q))
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
    setEditing('new')
    setDraft({ ...EMPTY_DRAFT, status: TICKET_TABS.find(t => t.key === tab)?.statuses[0] || 'Open' })
    setFailure(''); setNotice(''); setConfirmDelete(false)
  }

  function openTicket(t: Ticket) {
    setEditing(t)
    setDraft(draftOf(t))
    setFailure(''); setNotice(''); setConfirmDelete(false)
  }

  function close() {
    setEditing(null); setFailure(''); setConfirmDelete(false)
  }

  function save() {
    if (!editing || busy) return
    if (!draft.title.trim()) { setFailure('A ticket needs a title.'); return }
    setBusy(true); setFailure('')

    if (editing === 'new') {
      const fields: Partial<Record<TicketFieldKey, string>> = {}
      for (const k of Object.keys(draft) as TicketFieldKey[]) if (draft[k].trim()) fields[k] = draft[k].trim()
      addTicket(list.id, fields)
        .then(() => { setEditing(null); setNotice('Ticket added.'); onChanged() })
        .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
        .finally(() => setBusy(false))
      return
    }

    const diff = changed(draft, editing)
    if (!Object.keys(diff).length) { setBusy(false); setNotice('No changes to save.'); return }
    updateTicket(list.id, editing.entryId, diff)
      .then(() => { setEditing(null); setNotice('Ticket saved.'); onChanged() })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  function remove() {
    if (!editing || editing === 'new' || busy) return
    setBusy(true); setFailure('')
    deleteTicket(list.id, editing.entryId)
      .then(() => { setEditing(null); setNotice('Ticket deleted.'); onChanged() })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => { setBusy(false); setConfirmDelete(false) })
  }

  /** Move a ticket's status straight from its row, without opening the editor. */
  function quickStatus(t: Ticket, status: string) {
    if (busy) return
    setBusy(true); setFailure(''); setNotice('')
    updateTicket(list.id, t.entryId, { status })
      .then(() => { setNotice(`Moved to ${status}.`); onChanged() })
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
              onClick={() => { setTab(t.key); close() }}
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

      {editing && (
        <div className="editcard newclient">
          <div className="editcard__head">
            <h2>{editing === 'new' ? 'New ticket' : 'Edit ticket'}</h2>
            {editing !== 'new' && (
              <p className="note">
                Added by {editing.createdBy || 'unknown'}
                {editing.createdAt ? ` on ${editing.createdAt}` : ''}
                {editing.completedAt ? ` · completed ${editing.completedAt}` : ''}
              </p>
            )}
          </div>

          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          <div className="efgrid">
            <div className="ef ef--wide">
              <label htmlFor="t-title">Title<span className="ef__req" aria-hidden="true">*</span></label>
              <input id="t-title" type="text" value={draft.title} autoFocus autoComplete="off"
                onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
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
            <div className="ef ef--wide">
              <label htmlFor="t-details">Details</label>
              <textarea id="t-details" rows={4} value={draft.details}
                onChange={e => setDraft(d => ({ ...d, details: e.target.value }))} />
            </div>
          </div>

          <div className="editcard__foot">
            <span className="editcard__status">
              {busy ? 'Saving…' : editing === 'new' ? 'A title is required.' : ''}
            </span>
            {editing !== 'new' && (
              confirmDelete ? (
                <>
                  <span className="board2__confirm">Delete this ticket?</span>
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep</button>
                  <button type="button" className="btn btn--danger" onClick={remove} disabled={busy}>Delete</button>
                </>
              ) : (
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  Delete
                </button>
              )
            )}
            {!confirmDelete && (
              <>
                <button type="button" className="btn btn--ghost" onClick={close} disabled={busy}>Cancel</button>
                <button type="button" className="btn" onClick={save} disabled={busy || !draft.title.trim()}>
                  {editing === 'new' ? 'Add ticket' : 'Save changes'}
                </button>
              </>
            )}
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
                <th scope="col">Title</th>
                <th scope="col">Priority</th>
                <th scope="col">Assignee</th>
                <th scope="col">Due</th>
                <th scope="col">Sprint</th>
                <th scope="col"><span className="visually-hidden">Move</span></th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <Fragment key={g.status || '_all'}>
                  {g.status && (
                    <tr className="grouprow">
                      <td colSpan={6}>
                        <span className="pill" data-status={g.status.replace(/\s+/g, '')}>{g.status}</span>
                        <span className="grouprow__n">{g.rows.length}</span>
                      </td>
                    </tr>
                  )}
                  {g.rows.map(t => (
                    <tr key={t.entryId} className="rowlink" data-prio={t.priority}>
                      <th scope="row">
                        <button type="button" className="rowlink__btn" onClick={() => openTicket(t)}>
                          {t.title || <span className="muted">(untitled)</span>}
                        </button>
                      </th>
                      <td><span className="pill" data-prio={t.priority}>{t.priority || 'Normal'}</span></td>
                      <td>{t.assignee || dash}</td>
                      <td>{t.dueDate || dash}</td>
                      <td>{t.sprint || dash}</td>
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
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
