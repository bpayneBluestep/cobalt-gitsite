import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  addTicket, updateTicket, ApiError, formatHours, wesleyStatus,
  TICKET_STATUSES, TICKET_PRIORITIES, TICKET_TABS, TICKET_GROUP_ORDER, PRIORITY_RANK,
  type List, type Ticket, type TicketFieldKey,
} from '../api'
import { htmlToText } from '../lib/html'
import UserPicker from './UserPicker'
import { useSession } from '../session'

/** Where a ticket lives. The number is the shareable form; the entry id is the fallback. */
export const ticketPath = (t: Ticket): string =>
  `/tickets/${t.ticketNumber === null ? t.entryId : t.ticketNumber}`

/*
 * A ticket opens in its own tab.
 *
 * The board is a place you work FROM rather than a step on the way to one ticket: you are
 * triaging a list, and following a link in place costs the row you were reading plus the
 * tab, filter and search that surfaced it. Coming back then means rebuilding all of it.
 *
 * `rel="noopener"` because target="_blank" otherwise hands the new document a live
 * `window.opener` handle back into this one.
 */
const NEW_TAB = { target: '_blank', rel: 'noopener' } as const

/*
 * The ticket board for one list: the Cobalt port of beh's "Clickup Killer".
 *
 * Deliberately the same shape as that tool: Open / Ready / Current / Completed
 * tabs over the same status vocabulary, a table grouped by status (only when a
 * tab holds more than one), each group sorted by priority, and a search plus
 * filter row above it.
 *
 * One difference, and it's an improvement rather than a shortcut: beh fetches per
 * tab and asks the server for counts separately. A Cobalt list is small and comes
 * back in a single `tickets` call, so tabs, counts and filters are all computed
 * here: four round trips become one, and switching tabs is instant.
 *
 * The board owns the table and the create form. A ticket itself is a PAGE, at
 * /tickets/<number>, so it can be linked to and sent to someone. A row is a real
 * link, which also means middle-click and "open in new tab" work.
 */

/**
 * Only the fields the create form collects; the rest are set from the ticket page.
 *
 * Sprint is not among them any more. A sprint is planned on the sprint board, against
 * a roster and a capacity: typing one here was a way to put work into a week without
 * ever looking at whether the week had room for it.
 */
type NewDraft = Pick<Record<TicketFieldKey, string>, 'title' | 'status' | 'priority' | 'dueDate'>
  & { accountableId: string; responsibleId: string }

const EMPTY_DRAFT: NewDraft = {
  title: '', status: 'Open', priority: 'Normal', dueDate: '',
  accountableId: '', responsibleId: '',
}

/** Which tab a status belongs to: beh's `tabOf`, unchanged. */
function tabOf(status: string): string {
  for (const t of TICKET_TABS) if ((t.statuses as readonly string[]).indexOf(status || 'Open') >= 0) return t.key
  return 'open'
}

function byPriority(a: Ticket, b: Ticket): number {
  return (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0)
}

export default function TicketBoard({
  list, tickets, onChanged, onTicket, spansLists = false,
}: {
  list: List
  tickets: Ticket[]
  onChanged: () => void
  /** Replace one ticket in the caller's copy, from an action's fresh reply. */
  onTicket: (t: Ticket) => void
  /*
   * True when `tickets` comes from more than one list, as on the all-lists board.
   *
   * Two things change. A List column appears, because "#1204 Med pass report" means
   * nothing without knowing whose it is. And creating is withdrawn: a new ticket needs
   * ONE target list, and picking it for you from a mixed board would be a guess about
   * whose backlog just grew.
   *
   * Writes to an EXISTING ticket still work, because a ticket carries its own `listId`.
   */
  spansLists?: boolean
}) {
  /*
   * Engineers, Client Success and Leadership work tickets. Sales and Accounting read them
   * Sales for context before a call, Accounting for the hours behind a bill, and must
   * not be able to move somebody else's work. The board is the same board either way; it
   * just loses the controls that write.
   */
  const { can } = useSession()
  const mayEdit = can('editTickets')
  const navigate = useNavigate()
  const [tab, setTab] = useState('open')
  const [search, setSearch] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fPriority, setFPriority] = useState('')
  const [fResponsible, setFResponsible] = useState('')
  const [fAccountable, setFAccountable] = useState('')
  const [fSprint, setFSprint] = useState('')
  const [fRoadblock, setFRoadblock] = useState('')
  const [fDue, setFDue] = useState('')
  const [fTime, setFTime] = useState('')
  /*
   * Open by default on the all-lists board, closed on one client's.
   *
   * Those are different jobs. Across 59 lists you arrived to narrow something down, so
   * hiding the controls behind a button costs a click every time. On one client's 23
   * tickets you can see the whole board, and eight selects above it would be the biggest
   * thing on the page.
   */
  const [showFilters, setShowFilters] = useState(spansLists)

  // Asked once per mount rather than assumed: an org with no integration key should
  // not be shown a door that opens onto an error.
  const [wesleyAvailable, setWesleyAvailable] = useState(false)
  useEffect(() => {
    let live = true
    wesleyStatus()
      .then(s => { if (live) setWesleyAvailable(!!s.available) })
      .catch(() => { if (live) setWesleyAvailable(false) })
    return () => { live = false }
  }, [])

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

  /*
   * Filter options come from the tickets ON THIS BOARD, not from a fixed list of staff.
   *
   * A roster would offer names with nothing behind them, so every empty result reads as a
   * possible bug rather than an answered question. Built from the data, a filter can only
   * ever narrow to something - and on the all-lists board that means the people who
   * actually appear across 5,939 tickets, not the 9 who have Cobalt user records.
   */
  const people = useMemo(() => {
    const acc = new Set<string>()
    const res = new Set<string>()
    for (const t of tickets) {
      if (t.accountableName) acc.add(t.accountableName)
      // The retired free-text owner counts as a responsible name here: on an imported
      // ticket it is the only record of who had it.
      const r = t.responsibleName || t.assignee
      if (r) res.add(r)
    }
    const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b))
    return { accountable: sort(acc), responsible: sort(res) }
  }, [tickets])

  /** Sprints present, highest first: the current one is the one you want at the top. */
  const sprints = useMemo(() => {
    const s = new Set<string>()
    for (const t of tickets) if (t.sprint) s.add(t.sprint)
    return [...s].sort((a, b) => Number(b) - Number(a))
  }, [tickets])

  const activeFilters = [
    fStatus, fPriority, fResponsible, fAccountable, fSprint, fRoadblock, fDue, fTime,
  ].filter(Boolean).length

  const clearFilters = () => {
    setFStatus(''); setFPriority(''); setFResponsible(''); setFAccountable('')
    setFSprint(''); setFRoadblock(''); setFDue(''); setFTime('')
  }

  /** Today as yyyy-mm-dd, to compare against a stored date string without parsing it. */
  const today = useMemo(() => {
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  }, [])

  const weekOut = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    const p2 = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  }, [])

  const visible = useMemo(() => {
    const q = search.toLowerCase().trim()
    return tickets.filter(t => {
      if (tabOf(t.status) !== tab) return false
      if (fStatus && t.status !== fStatus) return false
      if (fPriority && t.priority !== fPriority) return false

      const resp = t.responsibleName || t.assignee
      if (fResponsible === '__none' && resp) return false
      if (fResponsible && fResponsible !== '__none' && resp !== fResponsible) return false

      if (fAccountable === '__none' && t.accountableName) return false
      if (fAccountable && fAccountable !== '__none' && t.accountableName !== fAccountable) return false

      if (fSprint === '__none' && t.sprint) return false
      if (fSprint && fSprint !== '__none' && t.sprint !== fSprint) return false

      if (fRoadblock === 'yes' && !t.roadblocked) return false
      if (fRoadblock === 'no' && t.roadblocked) return false

      /*
       * Dates compare as strings, deliberately: they are stored yyyy-mm-dd, which sorts
       * lexicographically, so this needs no Date parsing and cannot pick up a timezone.
       */
      if (fDue === '__none' && t.dueDate) return false
      if (fDue === 'overdue' && !(t.dueDate && t.dueDate < today)) return false
      if (fDue === 'today' && t.dueDate !== today) return false
      if (fDue === 'week' && !(t.dueDate && t.dueDate >= today && t.dueDate <= weekOut)) return false

      const logged = Number(t.loggedHours) || 0
      const est = t.estHours === null ? null : Number(t.estHours)
      if (fTime === 'noest' && est !== null) return false
      if (fTime === 'logged' && logged <= 0) return false
      if (fTime === 'nologged' && logged > 0) return false
      // Over estimate only means something when there IS one to be over.
      if (fTime === 'over' && !(est !== null && est > 0 && logged > est)) return false
      if (!q) return true
      // Details is markup: search its text, so a query can't match a tag name. The
      // retired free-text assignee stays searchable so an old ticket still turns up
      // under the name it was originally filed against.
      const haystack = [
        t.title, t.responsibleName, t.accountableName, t.assignee,
        t.sprint && ('sprint ' + t.sprint), htmlToText(t.details), t.roadblockReason,
      ]
      if (t.ticketNumber !== null) haystack.push(`#${t.ticketNumber}`)
      return haystack.some(v => (v || '').toLowerCase().includes(q))
    })
  }, [
    tickets, tab, search, fStatus, fPriority, fResponsible, fAccountable,
    fSprint, fRoadblock, fDue, fTime, today, weekOut,
  ])

  // -- subtasks on the board ------------------------------------------------
  //
  // The board is a list of jobs, not a list of steps. A ticket broken into eight chunks
  // would otherwise push everything else off the screen and count itself nine times, so
  // children fold into their parent and the parent carries a 3/5 chip you can open.
  //
  // Folded only when the PARENT is also visible in this tab and filter. A subtask whose
  // parent is filtered away stands on its own with a crumb back: the alternative is
  // work vanishing from a board because of where its parent happens to sit, which is
  // exactly the bug this is meant to avoid.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Sourced from every ticket on the list, not from `visible`: expanding #42 should show
  // all five of its subtasks, including the two that are done and the one in another tab.
  const childrenOf = useMemo(() => {
    const map: Record<string, Ticket[]> = {}
    for (const t of tickets) {
      if (!t.isSubtask || !t.parentId) continue
      if (!map[t.parentId]) map[t.parentId] = []
      map[t.parentId].push(t)
    }
    for (const key of Object.keys(map)) map[key].sort(byPriority)
    return map
  }, [tickets])

  const visibleIds = useMemo(() => {
    const ids: Record<string, true> = {}
    for (const t of visible) ids[t.entryId] = true
    return ids
  }, [visible])

  const rows = useMemo(
    () => visible.filter(t => !(t.isSubtask && visibleIds[t.parentId])),
    [visible, visibleIds],
  )

  // Group by status only when the tab holds more than one: beh's rule exactly.
  const groups = useMemo(() => {
    const present = TICKET_GROUP_ORDER.filter(s => rows.some(t => (t.status || 'Open') === s))
    if (present.length <= 1) return [{ status: '', rows: rows.slice().sort(byPriority) }]
    return present.map(status => ({
      status,
      rows: rows.filter(t => (t.status || 'Open') === status).sort(byPriority),
    }))
  }, [rows])

  function openNew() {
    setCreating(true)
    setDraft({ ...EMPTY_DRAFT, status: TICKET_TABS.find(t => t.key === tab)?.statuses[0] || 'Open' })
    setFailure(''); setNotice('')
  }

  function create() {
    if (busy) return
    if (!draft.title.trim()) { setFailure('A ticket needs a title.'); return }
    setBusy(true); setFailure('')

    // Send only what was filled in, so a blank field never overwrites a default. The
    // two owners travel separately: the endpoint resolves them against the user list
    // rather than writing what the browser sent straight through.
    const { accountableId, responsibleId, ...rest } = draft
    const fields: Partial<Record<TicketFieldKey, string>> = {}
    for (const k of Object.keys(rest) as (keyof typeof rest)[]) {
      if (rest[k].trim()) fields[k] = rest[k].trim()
    }
    const people: { accountableId?: string; responsibleId?: string } = {}
    if (accountableId) people.accountableId = accountableId
    if (responsibleId) people.responsibleId = responsibleId

    addTicket(list.id, fields, people)
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

  /**
   * The list to write a ticket to: its OWN, not the board's.
   *
   * On a single-list board these are the same. On the all-lists board they are not, and
   * using the board's id would move a status on the wrong list - silently, since the
   * endpoint would simply not find that entry there.
   */
  const listIdOf = (t: Ticket): string => t.listId || list.id

  /** Move a ticket's status straight from its row, without opening it. */
  function quickStatus(t: Ticket, status: string) {
    if (busy || !mayEdit) return
    setBusy(true); setFailure(''); setNotice('')
    updateTicket(listIdOf(t), t.entryId, { status })
      .then(fresh => { onTicket(fresh); setNotice(`Moved to ${status}.`) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const dash = <span className="muted">-</span>

  /**
   * One row of the table: a top-level ticket, or one of its subtasks indented under it.
   *
   * The same renderer for both so a subtask is visibly the same KIND of thing as its
   * parent: same columns, same status control, its own link. That is the whole claim
   * being made about subtasks here, and a cut-down child row would quietly deny it.
   */
  function renderRow(t: Ticket, child: boolean, kids: Ticket[], open: boolean) {
    const est = t.estHours
    const logged = t.loggedHours || 0
    const over = est !== null && est > 0 && logged > est
    // A subtask rendered on its own, parent filtered out of this view: says whose it
    // is, so it never reads as an unrelated ticket that happens to be small.
    const strayFrom = !child && t.isSubtask && t.parentNumber !== null ? t.parentNumber : null

    return (
      <tr
        key={t.entryId}
        className={child ? 'rowlink rowlink--sub' : 'rowlink'}
        data-prio={t.priority}
        data-blocked={t.roadblocked ? '' : undefined}
      >
        <td className="tickets__num">
          {t.ticketNumber === null
            ? <span className="muted">-</span>
            : <Link className="tnum tnum--link" to={ticketPath(t)} {...NEW_TAB}>#{t.ticketNumber}</Link>}
        </td>
        <th scope="row">
          {child && <span className="subtee" aria-hidden="true">└</span>}
          {strayFrom !== null && (
            <Link className="subcrumb" to={`/tickets/${strayFrom}`} title="Its parent ticket" {...NEW_TAB}>
              #{strayFrom} ›
            </Link>
          )}
          {/* A real link: shareable, middle-clickable, and the browser
              shows where it goes. */}
          <Link className="rowlink__a" to={ticketPath(t)} {...NEW_TAB}>
            {t.title || <span className="muted">(untitled)</span>}
          </Link>

          {kids.length > 0 && (
            <button
              type="button"
              className="subtoggle"
              aria-expanded={open}
              title={open ? 'Hide subtasks' : 'Show subtasks'}
              onClick={() => setExpanded(e => ({ ...e, [t.entryId]: !e[t.entryId] }))}
            >
              <span className="subtoggle__caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
              {t.subtaskDone}/{t.subtaskCount}
              <span className="visually-hidden"> subtasks complete</span>
            </button>
          )}

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
        {/* Whose backlog this is. A client list links to the record; an internal one has
            no record to link to, so it reads as plain text rather than a dead link. */}
        {spansLists && (
          <td className="tickets__list" title={t.clientName || t.listName || ''}>
            {t.clientId
              ? <Link className="rowlink__a" to={`/clients/${t.clientId}/tickets`}>{t.clientName || t.listName}</Link>
              : <span className="muted">{t.listName || dash}</span>}
          </td>
        )}
        {/* No priority means NO PILL - an empty cell, not the word "Normal".
            4,034 of these came in from ClickUp with no priority set, and the old
            `|| 'Normal'` fallback labelled every one of them Normal while colouring
            them grey, because `data-prio=""` matches no rule. That read as two kinds
            of Normal. "Nobody triaged this" and "someone judged this routine" are
            different facts and the board should not blur them. */}
        <td>
          {t.priority
            ? <span className="pill" data-prio={t.priority}>{t.priority}</span>
            : null}
        </td>
        {/* Both owners, side by side. The PM answerable to the client and the engineer
            doing the work are different roles and frequently different people; showing
            only one meant guessing which question a blank was answering. */}
        <td className="tickets__who" title={t.accountableName || ''}>
          {t.accountableName || dash}
        </td>
        <td className="tickets__who" title={t.responsibleName || t.assignee || ''}>
          {t.responsibleName || t.assignee || dash}
        </td>
        <td className="tickets__time">
          {logged || est !== null ? (
            <span className="tvs" data-over={over ? '' : undefined}>
              {logged ? formatHours(logged) : '0h'}
              <span className="tvs__sep">/</span>
              <span className="tvs__est">{est === null ? '-' : formatHours(est)}</span>
            </span>
          ) : dash}
        </td>
        <td>{t.dueDate || dash}</td>
        <td className="tickets__move">
          <select
            aria-label={`Move "${t.title}" to another status`}
            value={t.status || 'Open'}
            disabled={busy || !mayEdit}
            onChange={e => quickStatus(t, e.target.value)}
          >
            {TICKET_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </td>
      </tr>
    )
  }

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
        {/* Both doors in ONE group, so the bar's space-between has exactly two children:
            tabs left, actions right. With three children the layout centres the middle
            one, which is how Ask Wesley ended up marooned in the middle of the screen.

            Two doors, and the guided one is deliberately the prominent one. Someone who
            knows exactly what they want types it; someone who would have written "the
            report is broken" gets interviewed into a request an engineer can act on.
            Hidden when Wesley has no key, so it never offers something that will fail. */}
        <div className="board2__acts">
          {wesleyAvailable && !spansLists && (
            <Link
              className="btn btn--iq"
              to={list.clientId ? `/clients/${list.clientId}/request` : `/request?listId=${list.id}`}
            >
              <span aria-hidden="true">✦</span> Ask Wesley
            </Link>
          )}
          {mayEdit && !spansLists && (
            <button type="button" className={wesleyAvailable ? 'btn btn--ghost' : 'btn'} onClick={openNew}>
              <span aria-hidden="true">+</span> New ticket
            </button>
          )}
        </div>
      </div>

      <div className="board2__tools">
        <input
          type="text"
          className="board2__search"
          placeholder="Search number, title, people, sprint, details…"
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

          {/* Two people, two filters. "Who owns the client relationship for this" and
              "who is building it" are different questions, and on an imported backlog
              they very often have different answers. */}
          <div className="ef">
            <label htmlFor="f-accountable">Accountable</label>
            <select id="f-accountable" value={fAccountable} onChange={e => setFAccountable(e.target.value)}>
              <option value="">Anyone</option>
              <option value="__none">— nobody accountable —</option>
              {people.accountable.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <div className="ef">
            <label htmlFor="f-responsible">Responsible</label>
            <select id="f-responsible" value={fResponsible} onChange={e => setFResponsible(e.target.value)}>
              <option value="">Anyone</option>
              <option value="__none">— unassigned —</option>
              {people.responsible.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          {sprints.length > 0 && (
            <div className="ef">
              <label htmlFor="f-sprint">Sprint</label>
              <select id="f-sprint" value={fSprint} onChange={e => setFSprint(e.target.value)}>
                <option value="">Any sprint</option>
                <option value="__none">— unplanned —</option>
                {sprints.map(s => <option key={s} value={s}>Sprint {s}</option>)}
              </select>
            </div>
          )}

          <div className="ef">
            <label htmlFor="f-roadblock">Roadblock</label>
            <select id="f-roadblock" value={fRoadblock} onChange={e => setFRoadblock(e.target.value)}>
              <option value="">Any</option>
              <option value="yes">Roadblocked only</option>
              <option value="no">Not roadblocked</option>
            </select>
          </div>

          <div className="ef">
            <label htmlFor="f-due">Due</label>
            <select id="f-due" value={fDue} onChange={e => setFDue(e.target.value)}>
              <option value="">Any date</option>
              <option value="overdue">Overdue</option>
              <option value="today">Due today</option>
              <option value="week">Due within 7 days</option>
              <option value="__none">— no due date —</option>
            </select>
          </div>

          <div className="ef">
            <label htmlFor="f-time">Time</label>
            <select id="f-time" value={fTime} onChange={e => setFTime(e.target.value)}>
              <option value="">Any</option>
              <option value="over">Over estimate</option>
              <option value="noest">No estimate</option>
              <option value="logged">Has hours logged</option>
              <option value="nologged">No hours logged</option>
            </select>
          </div>

          {activeFilters > 0 && (
            <div className="ef">
              <label>&nbsp;</label>
              <button type="button" className="btn btn--ghost" onClick={clearFilters}>
                Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
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
              <label htmlFor="t-responsible">Responsible</label>
              <UserPicker
                id="t-responsible"
                value={draft.responsibleId}
                placeholder="Nobody yet"
                onChange={v => setDraft(d => ({ ...d, responsibleId: v }))}
              />
            </div>
            <div className="ef">
              <label htmlFor="t-accountable">Accountable</label>
              <UserPicker
                id="t-accountable"
                value={draft.accountableId}
                placeholder="Nobody yet"
                onChange={v => setDraft(d => ({ ...d, accountableId: v }))}
              />
            </div>
            <div className="ef">
              <label htmlFor="t-due">Due date</label>
              <input id="t-due" type="date" value={draft.dueDate}
                onChange={e => setDraft(d => ({ ...d, dueDate: e.target.value }))} />
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
                {spansLists && <th scope="col">List</th>}
                <th scope="col">Priority</th>
                <th scope="col">Accountable</th>
                <th scope="col">Responsible</th>
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
                      {/* #, Title, (List), Priority, Accountable, Responsible, Time,
                          Due, Move. The List column only exists on the all-lists board,
                          and a group row that spans the wrong count leaves a visible
                          notch in the table. */}
                      <td colSpan={spansLists ? 9 : 8}>
                        <span className="pill" data-status={g.status.replace(/\s+/g, '')}>{g.status}</span>
                        <span className="grouprow__n">{g.rows.length}</span>
                      </td>
                    </tr>
                  )}
                  {g.rows.map(t => {
                    const kids = childrenOf[t.entryId] || []
                    const open = !!expanded[t.entryId]
                    return (
                      <Fragment key={t.entryId}>
                        {renderRow(t, false, kids, open)}
                        {open && kids.map(k => renderRow(k, true, [], false))}
                      </Fragment>
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
