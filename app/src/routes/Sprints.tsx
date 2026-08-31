import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ApiError, getSprint, getTeam, createSprint, assignSprint, carryForward,
  addEngineer, updateEngineer, deleteEngineer,
  formatHours, shiftSprint, sprintLabel, isSprintKey, nameKey,
  ENGINEER_DISCIPLINES, ENGINEER_READY_RULE, PRIORITY_RANK,
  type SprintBoard, type SprintColumn, type Team, type Ticket, type EngineerFieldKey,
  type User,
} from '../api'
import UserPicker, { loadUsers } from '../components/UserPicker'
import { ticketPath } from '../components/TicketBoard'
import { useSession } from '../session'

/*
 * The sprint board: beh's Sprint Organizer, ported.
 *
 * A column per engineer, each measuring the estimates committed to them against their
 * capacity, plus the unsprinted backlog to pull work from. The point of the layout is
 * that over-commitment is visible before the sprint starts rather than discovered
 * halfway through it.
 *
 * A sprint is a plain NUMBER, 1, 2, 3: the way the team says it out loud, and the way
 * beh has always numbered them. It used to be an ISO week (2026-W33): that reads like a
 * date, sorts nicely, and nobody ever said it in a sentence.
 *
 * The roster is PER SPRINT. Capacity moves week to week and people take leave, so each
 * sprint owns its own roster and starting a new one copies the previous forward. Editing
 * next sprint therefore cannot reach back and rewrite the history of a sprint that has
 * already happened, which is exactly what a single shared roster did.
 *
 * An engineer IS a platform user. The roster holds the user id, picked from the user
 * list, and the name shown is that user's own, so a ticket's `responsibleId` lands in
 * the right column with nothing to match on. Rows added before the roster held ids are
 * matched by name instead and cannot be given work until somebody re-picks them, which
 * this page says out loud rather than leaving the column mysteriously empty.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; board: SprintBoard }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/** The drop-target id for the backlog region. Not an engineer, so it cannot collide. */
const BACKLOG = '__backlog'
/** The drag key for the nobody-responsible column: in the sprint, on no engineer. */
const NOBODY = '__nobody'

/*
 * A ticket opens in its own tab, the same rule the tickets board follows.
 *
 * More so here: this page is a plan you are holding in your head. Following a link in
 * place costs the sprint you were looking at, the filters narrowing it and the scroll
 * position, and reading one description is not worth rebuilding all of that.
 *
 * `draggable={false}` on every one of these matters. A card and a backlog row are drag
 * handles, and an anchor is draggable by default, so without it the browser starts
 * dragging the LINK - planning by drag silently stops working on exactly the element
 * people grab.
 */
const NEW_TAB = { target: '_blank' as const, rel: 'noopener', draggable: false }

/*
 * How many backlog rows to pull.
 *
 * The server caps at 60 by default, and this page now filters and sorts in the browser,
 * where a truncated list quietly answers the wrong question. The Engineer-Ready gate
 * keeps the real backlog small - 24 today against thousands of open tickets - so asking
 * for 400 costs nothing and makes the controls honest. If it is ever still cut, the page
 * says so rather than pretending.
 */
const BACKLOG_LIMIT = 400

/** The terminal status. A card in it counts as done in a column's tally. */
const DONE = 'Complete'

/** Two decimal places: the same rounding `money()` applies on the server. */
const money = (n: number): number => Math.round(n * 100) / 100

/*
 * Recompute every derived figure on the board from the cards it currently holds.
 *
 * This exists so that planning a ticket does not have to refetch. `actionSprint` walks
 * all 84 lists to build a board, which is several seconds, and it was being run twice
 * (board + roster) after every single drag while the page showed "Loading the sprint" -
 * so moving four tickets meant four full rebuilds and four blank screens.
 *
 * It deliberately MIRRORS the server's arithmetic rather than approximating it: same
 * money() rounding, same `over` comparison, same integer utilisation, same priority
 * ordering inside a column. Anything else and the numbers would drift a little on every
 * move and only agree again after a reload, which is worse than not moving at all.
 */
function recomputed(board: SprintBoard): SprintBoard {
  let totalEst = 0, totalLogged = 0, totalCapacity = 0, totalDone = 0, totalTickets = 0

  const columns = board.columns.map(c => {
    const capacity = c.capacity || 0
    const estHours = money(c.tickets.reduce((a, t) => a + (t.estHours || 0), 0))
    const loggedHours = money(c.tickets.reduce((a, t) => a + (t.loggedHours || 0), 0))
    const done = c.tickets.filter(t => t.status === DONE).length

    totalEst += estHours
    totalLogged += loggedHours
    totalCapacity += capacity
    totalDone += done
    totalTickets += c.tickets.length

    return {
      ...c, estHours, loggedHours, done,
      remaining: money(capacity - estHours),
      over: estHours > capacity,
      utilisation: capacity > 0 ? Math.round((estHours / capacity) * 100) : null,
    }
  })

  return {
    ...board,
    columns,
    totals: {
      ...board.totals,
      tickets: totalTickets,
      capacity: money(totalCapacity),
      estHours: money(totalEst),
      loggedHours: money(totalLogged),
      remaining: money(totalCapacity - totalEst),
      over: totalEst > totalCapacity,
      utilisation: totalCapacity > 0 ? Math.round((totalEst / totalCapacity) * 100) : null,
      done: totalDone,
      unassigned: board.unassigned.length,
    },
  }
}

/**
 * Move one card to `toKey` - a column's entryId/engineer, or BACKLOG - and settle the
 * board around it. `fresh` is the ticket the server handed back, which is authoritative
 * for the card itself; everything else here is derived.
 */
function moved(board: SprintBoard, ticket: Ticket, toKey: string, fresh?: Ticket): SprintBoard {
  const card = fresh || ticket
  const mine = (t: Ticket) => t.entryId !== ticket.entryId

  const columns = board.columns.map(c => {
    const key = c.entryId || c.engineer
    const without = c.tickets.filter(mine)
    const tickets = key === toKey ? without.concat([card]) : without
    // The server keeps a column in priority order; a card dropped at the end would
    // otherwise sit out of order until the next real load.
    tickets.sort((x, y) => (PRIORITY_RANK[y.priority] || 0) - (PRIORITY_RANK[x.priority] || 0))
    return { ...c, tickets }
  })

  // Leaving the unassigned column is just leaving it: the card is being claimed, and
  // `columns` above has already put it wherever it was dropped.
  const restOfBacklog = board.backlog.filter(mine)
  const cameFromBacklog = restOfBacklog.length !== board.backlog.length
  const goingToBacklog = toKey === BACKLOG

  return recomputed({
    ...board,
    columns,
    backlog: goingToBacklog ? [card].concat(restOfBacklog) : restOfBacklog,
    // Track the true total too, or the "showing N of M" note starts lying.
    backlogTotal: board.backlogTotal + (goingToBacklog ? 1 : cameFromBacklog ? -1 : 0),
    unassigned: board.unassigned.filter(mine),
  })
}

/**
 * The backlog's sortable columns.
 *
 * `est` descending is the default because it is the server's order and a deliberate one:
 * the backlog is a picking list, and the big items are the ones that decide whether a
 * sprint fits. Sorting is a way to ask a different question of it, not a correction.
 */
type SortKey = 'num' | 'title' | 'list' | 'accountable' | 'priority' | 'est'

const SORT_COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'num', label: '#', numeric: true },
  { key: 'title', label: 'Ticket' },
  { key: 'list', label: 'For' },
  { key: 'accountable', label: 'Accountable' },
  { key: 'priority', label: 'Priority', numeric: true },
  { key: 'est', label: 'Est', numeric: true },
]

/** What a row sorts by for a given column: a number where one is meaningful, else text. */
function sortValue(t: Ticket, key: SortKey): number | string {
  if (key === 'num') return t.ticketNumber === null ? -1 : t.ticketNumber
  if (key === 'est') return t.estHours === null ? -1 : t.estHours
  // Not alphabetical: Critical/High/Normal/Low is an order, and sorting it by name would
  // put Critical between Low and Normal. Unset ranks below Low rather than above it.
  if (key === 'priority') return PRIORITY_RANK[t.priority] || 0
  if (key === 'list') return (t.clientName || t.listName || '').toLowerCase()
  if (key === 'accountable') return (t.accountableName || '').toLowerCase()
  return (t.title || '').toLowerCase()
}

type EngDraft = Record<EngineerFieldKey, string>

const emptyEng = (sprint: string): EngDraft => ({
  userId: '', name: '', email: '', role: 'Engineer', capacity: '32', active: 'true', sprint,
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
   *   planning, putting a ticket into a sprint, or taking it out: is a Tickets write,
   *               so engineers and Client Success do it. That is the daily work.
   *   the roster, who is on the team, their capacity, starting a sprint: is an Engineers
   *               write, and belongs to Leadership. Capacity is a management decision.
   */
  const { can } = useSession()
  const mayPlan = can('editTickets')
  const mayRoster = can('editSprints')
  const [params, setParams] = useSearchParams()
  const urlSprint = params.get('sprint') || ''

  // '' means "not decided yet": the first load picks the latest sprint that has a
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

  /*
   * Drag state, following CrmPipeline's shape so the app has one set of drag semantics
   * rather than two that drift.
   *
   * `dragging` carries the ticket AND the column it came from: the source is what makes
   * a drop onto its own column a no-op instead of a pointless round trip, and what tells
   * the backlog region whether a drop there means anything.
   */
  const [dragging, setDragging] = useState<{ ticket: Ticket; from: string } | null>(null)
  const [over, setOver] = useState('')

  /*
   * Backlog controls. Client-side, over the rows already loaded, for the same reason the
   * tickets board filters in the browser: the list is small, one fetch already has all of
   * it, and a round trip per filter change would make narrowing something you wait for.
   *
   * Deliberately NOT applied to the engineer columns. Those carry capacity arithmetic in
   * their headers - "18h of 25h, 72%" - computed server-side over every card in the
   * column. Hiding cards would leave those totals describing work you can no longer see,
   * and a capacity plan that does not add up is worse than one you have to read in full.
   */
  const [bAcct, setBAcct] = useState('')
  const [bList, setBList] = useState('')
  const [bPriority, setBPriority] = useState('')
  const [bSort, setBSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'est', dir: -1 })

  /** Move to a sprint and put it in the URL, so the view can be linked to. */
  const setSprint = useCallback((key: string) => {
    setSprintState(key)
    setParams(key ? { sprint: key } : {}, { replace: true })
  }, [setParams])

  useEffect(() => { loadUsers().then(setUsers).catch(() => setUsers([])) }, [])

  // Decide which sprint to show, once, before the first board fetch: otherwise the
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

  const load = useCallback((key: string, quiet = false) => {
    if (!key) return
    // Only the FIRST load of a sprint blanks the page. A reload after a failed write is
    // repairing something already on screen, and replacing it with "Loading the sprint"
    // throws away the reader's place to tell them what they can already see.
    if (!quiet) setState({ phase: 'loading' })
    getSprint(key, BACKLOG_LIMIT)
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
        // An empty `said` means the caller already reported what happened, in terms only
        // it knew - how many tickets moved, say - so do not overwrite it with nothing.
        if (said) setNotice(said)
        load(sprint)
        loadTeam(sprint)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  /**
   * Who can be assigned this sprint: the roster, which already holds user ids.
   *
   * A legacy row with no id falls back to matching its name against the user list, so an
   * old roster keeps working. It is kept in the list but not selectable: the fix is to
   * edit the row and pick the person, and hiding it would just make an engineer quietly
   * disappear from the board with no clue why.
   */
  const assignable: Assignable[] = useMemo(() => {
    const byName = new Map<string, string>()
    for (const u of users) byName.set(nameKey(u.name), u.id)
    return (team?.rows || [])
      .filter(e => e.active)
      .map(e => ({ name: e.name, userId: e.userId || byName.get(nameKey(e.name)) || '' }))
  }, [team, users])

  const unresolved = assignable.filter(a => !a.userId)

  /*
   * Apply a move immediately, then send it.
   *
   * Planning used to go through `run`, which refetched the whole board AND the roster on
   * success - two walks of 84 lists, behind a "Loading the sprint" screen, after every
   * drag. Planning a sprint is a dozen of these in a row, so the page spent most of its
   * time rebuilt rather than read.
   *
   * The card moves in local state first and the request follows. On success the server's
   * own copy of the ticket replaces the optimistic one, so the card is authoritative even
   * though nothing was refetched. On failure the board goes back to exactly what it was
   * and THEN reloads quietly, because a refused write means the local picture is already
   * wrong in some way this page cannot infer.
   */
  function move(t: Ticket, toKey: string, request: Promise<Ticket>, said: string) {
    if (!mayPlan || !board) return
    const before = board
    setState({ phase: 'ready', board: moved(before, t, toKey) })
    setFailure(''); setNotice(said)

    request
      .then(fresh => setState(cur => (cur.phase === 'ready'
        // Re-derive from the CURRENT board, not from `before`: another move may have
        // landed while this one was in flight, and rebuilding from the stale copy would
        // silently undo it.
        ? { phase: 'ready', board: moved(cur.board, t, toKey, fresh) }
        : cur)))
      .catch(err => {
        setState({ phase: 'ready', board: before })
        setNotice('')
        setFailure(err instanceof ApiError ? err.message : String(err))
        load(sprint, true)
      })
  }

  /** Pull a backlog ticket into this sprint for someone, or move it between columns. */
  function plan(t: Ticket, userId: string, who: string) {
    if (!mayPlan) return
    if (!userId) {
      setFailure(`${who} is on the roster but has no matching user record, so work cannot be assigned to them.`)
      return
    }
    const target = board?.columns.find(c => c.userId === userId)
    move(t, target ? (target.entryId || target.engineer) : BACKLOG,
      assignSprint(t.listId, t.entryId, sprint, userId),
      `${t.ticketNumber !== null ? `#${t.ticketNumber}` : t.title} → ${who}.`)
  }

  function unplan(t: Ticket) {
    if (!mayPlan) return
    move(t, BACKLOG, assignSprint(t.listId, t.entryId, '', ''),
      `${t.ticketNumber !== null ? `#${t.ticketNumber}` : t.title} taken out of the sprint.`)
  }

  /** Pick a card up. The payload is required: some browsers cancel a drag without one. */
  function startDrag(e: React.DragEvent, ticket: Ticket, from: string) {
    if (!mayPlan || busy) return
    setDragging({ ticket, from })
    e.dataTransfer.setData('text/plain', ticket.entryId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const endDrag = () => { setDragging(null); setOver('') }

  /*
   * Scroll the page while a card is in the air.
   *
   * The engineers are at the top and the backlog is below them, so on any real sprint the
   * two ends of a drag are not on screen together: you pick a card up at the bottom and
   * there is nowhere to put it. Browsers auto-scroll a scrollable CONTAINER near its
   * edge, but not the window, and during a native drag the wheel and the keyboard are
   * both unavailable - so without this the gesture is simply impossible and the fallback
   * is the "Plan into…" select.
   *
   * Speed ramps with depth into the hot zone rather than being a constant, so easing
   * toward the edge creeps and going right to it moves. Driven by requestAnimationFrame
   * and not by the dragover event: dragover fires at whatever rate the browser feels
   * like, including not at all while the pointer is held still, which is exactly when
   * the scrolling needs to continue.
   */
  useEffect(() => {
    if (!dragging) return
    const EDGE = 120      // how deep the hot zone reaches from each viewport edge
    const MAX = 24        // pixels per frame at the very edge
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

  /*
   * Can this column take the card currently in flight?
   *
   * A roster row with no user record cannot be given work - a ticket stores the engineer
   * as a user id, and there is none. Knowing that before the drop means the column can
   * be marked un-droppable while the card is still in the air, rather than accepting the
   * gesture and then explaining why it did nothing.
   */
  function canDrop(col: SprintColumn): boolean {
    if (!dragging || !mayPlan) return false
    if (dragging.from === (col.entryId || col.engineer)) return false
    return !!assignable.find(a => nameKey(a.name) === nameKey(col.engineer))?.userId
  }

  function dropOn(col: SprintColumn) {
    const carried = dragging
    setOver('')
    setDragging(null)
    if (!carried || carried.from === (col.entryId || col.engineer)) return
    const who = assignable.find(a => nameKey(a.name) === nameKey(col.engineer))
    plan(carried.ticket, who?.userId || col.userId, col.engineer)
  }

  function saveEngineer() {
    if (busy || !mayRoster) return
    if (!engDraft.userId) { setFailure('Pick the person from the list.'); return }
    /*
     * The name and email are NOT sent: the endpoint reads them from the chosen user's
     * record. Sending a copy would let this form's idea of somebody's name drift from
     * the platform's, which is the drift the picker exists to end.
     */
    const fields: Partial<Record<EngineerFieldKey, string>> = {
      userId: engDraft.userId,
      role: engDraft.role, capacity: engDraft.capacity, active: engDraft.active,
      sprint: engDraft.sprint,
    }
    const who = users.find(u => u.id === engDraft.userId)?.name || 'The engineer'
    if (engEditing === 'new') {
      run('eng', addEngineer(fields).then(t => { setTeam(t); setEngEditing(null); return t }),
        `${who} added to the roster.`)
      return
    }
    run('eng', updateEngineer(engEditing as string, fields).then(t => { setTeam(t); setEngEditing(null); return t }),
      'Roster updated.')
  }

  /*
   * Sweep unfinished work out of every earlier sprint into this one.
   *
   * `createSprint` does this too, so a sprint started from now on arrives already swept.
   * The button exists for the sprints that were started before the rule did - and it is
   * idempotent, so pressing it on a clean sprint reports nothing moved rather than
   * doing something.
   *
   * This one DOES reload the board, unlike a drag: it can move dozens of tickets across
   * dozens of lists, and there is no local arithmetic that could stand in for that.
   */
  function carryOver() {
    if (!mayRoster) return
    run('carry', carryForward(sprint).then(r => {
      setNotice(r.carried
        ? `${r.carried} unfinished ticket${r.carried === 1 ? '' : 's'} carried into ${sprintLabel(sprint)}.`
        : `Nothing to carry forward - every earlier sprint is finished or in review.`)
      return r
    }), '')
  }

  /** Start this sprint for real, by copying the previous roster forward. */
  function startSprint() {
    if (!mayRoster) return
    run('start', createSprint(sprint).then(t => { setTeam(t); return t }),
      `${sprintLabel(sprint)} started: the previous roster was copied forward.`)
  }

  const dash = <span className="muted">-</span>
  const templateRoster = !!board?.rosterIsTemplate

  const skips = board?.backlogSkipped
  const skipTotal = skips ? skips.wrongStatus + skips.noEstimate + skips.noAccountable : 0

  /*
   * Everything carrying this sprint's number that the board does not show: work the
   * Engineer-Ready gate excluded, plus work in the sprint with nobody responsible for it.
   *
   * Both are deliberately off this board - the sprint view has one strict definition of
   * what appears on it - but a number that is silently missing from a capacity plan is
   * the kind of thing you find out about late. So it is stated, with somewhere to go.
   */
  /*
   * Work carrying this sprint's number that the board still cannot show.
   *
   * No longer includes `unassigned` - that has its own column now. What is left is work
   * the Engineer-Ready gate excluded: it lost its estimate or its accountable owner
   * after being planned.
   */
  const offBoard = board?.hiddenInSprint || 0

  const backlogRaw = useMemo(() => board?.backlog || [], [board])

  /*
   * What the selects offer: only values actually present in the backlog, so a filter can
   * never produce an empty table. 13 clients out of 84 lists have something ready to
   * plan, and offering the other 71 would be 71 ways to ask a question with no answer.
   */
  const backlogOptions = useMemo(() => {
    const people = new Set<string>()
    const lists = new Set<string>()
    const prios = new Set<string>()
    for (const t of backlogRaw) {
      if (t.accountableName) people.add(t.accountableName)
      const forWhom = t.clientName || t.listName
      if (forWhom) lists.add(forWhom)
      if (t.priority) prios.add(t.priority)
    }
    const alpha = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b))
    return {
      people: alpha(people),
      lists: alpha(lists),
      // Ranked, not alphabetical, for the same reason the sort is.
      priorities: [...prios].sort((a, b) => (PRIORITY_RANK[b] || 0) - (PRIORITY_RANK[a] || 0)),
    }
  }, [backlogRaw])

  const backlogFilters = (bAcct ? 1 : 0) + (bList ? 1 : 0) + (bPriority ? 1 : 0)

  const backlogRows = useMemo(() => {
    const rows = backlogRaw.filter(t =>
      (!bAcct || t.accountableName === bAcct) &&
      (!bList || (t.clientName || t.listName) === bList) &&
      (!bPriority || t.priority === bPriority))

    return rows.slice().sort((a, b) => {
      const av = sortValue(a, bSort.key)
      const bv = sortValue(b, bSort.key)
      let cmp: number
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av).localeCompare(String(bv))
      // Ties fall back to the estimate, biggest first: within one client or one owner the
      // question is still which item is big enough to matter.
      if (cmp === 0) return (b.estHours || 0) - (a.estHours || 0)
      return cmp * bSort.dir
    })
  }, [backlogRaw, bAcct, bList, bPriority, bSort])

  /** Click a heading to sort by it; click the one already active to reverse it. */
  const sortBy = (key: SortKey) => setBSort(cur => (cur.key === key
    ? { key, dir: cur.dir === 1 ? -1 : 1 }
    : { key, dir: key === 'est' || key === 'priority' || key === 'num' ? -1 : 1 }))

  const clearBacklogFilters = () => { setBAcct(''); setBList(''); setBPriority('') }

  /* The one case where filtering in the browser would lie: the server cut the list. */
  const backlogTruncated = !!board && board.backlogTotal > board.backlog.length

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

        <div className="sprintbar__acts">
          {mayRoster && !templateRoster && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={carryOver}
              disabled={!!busy}
              title="Move every unfinished ticket from earlier sprints into this one. Complete and In Review stay where they are.">
              {busy === 'carry' ? 'Carrying…' : 'Carry work forward'}
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowRoster(v => !v)}>
            {showRoster ? 'Hide roster' : `Roster (${team ? team.rows.filter(e => e.active).length : '…'})`}
          </button>
        </div>
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
            sprint's roster forward, after that, changing who is on it, or their hours,
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
            the engineer as a user, and these rows hold a name with no user behind it.
            Edit each one and pick the person, or add them under Settings if they have no
            Cobalt login yet.
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
                  An engineer is somebody with a Cobalt login. Pick them and their name
                  and email come from their own record, which is how a ticket's
                  responsible engineer finds their column.
                </p>
              </div>
              <div className="efgrid">
                <div className="ef">
                  <label htmlFor="en-who">Person</label>
                  <UserPicker id="en-who" value={engDraft.userId} placeholder="Choose a person…"
                    disabled={!!busy}
                    onChange={id => setEngDraft(d => ({ ...d, userId: id }))} />
                  {/* A row that predates the picker: say whose it is, so re-picking is
                      obviously a correction rather than a new person. */}
                  {engEditing !== 'new' && !engDraft.userId && engDraft.name && (
                    <p className="ef__hint">
                      This row was added as the name “{engDraft.name}” with no user behind
                      it, so no work can be assigned to it. Pick the person to fix that.
                    </p>
                  )}
                  {engDraft.userId && (
                    <p className="ef__hint">
                      Not in the list? Add them under{' '}
                      <Link className="inlink" to="/settings">Settings</Link> first.
                    </p>
                  )}
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
                                  userId: e.userId || '',
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

          {/*
              Work in this sprint that the board does not show. Brandon's rule: the sprint
              view has strict entry conditions, and a ticket that fails them - not
              Engineer-Ready, or nobody responsible for it - is not shown here even though
              it carries the sprint number. It is still on the tickets board, which is
              where this points, because a silently missing ticket in a capacity plan is
              worse than a shorter list with a note under it.
          */}
          {offBoard > 0 && (
            <p className="board2__notice">
              {offBoard} ticket{offBoard === 1 ? '' : 's'} in {sprintLabel(sprint)}{' '}
              {offBoard === 1 ? 'is' : 'are'} not shown here - no longer ready to plan,
              so {offBoard === 1 ? 'it lost' : 'they lost'} an estimate or an accountable
              owner after being planned.{' '}
              <Link className="inlink" to="/tickets">Find them on the tickets board</Link>.
            </p>
          )}

          <div className="pipe sprint">
            {/*
                In the sprint, ready, nobody's name on it.
                
                First in the row rather than last, because it is the column you are meant
                to empty: everything in it is committed work that no engineer has picked
                up, and it is where carried-forward tickets land. It is a drag SOURCE
                only - dropping here would have to mean "unassign", and `assignSprint`
                reads an empty responsibleId as "leave who has it alone" rather than as a
                clear, so the gesture could not do what it looked like it did.
            */}
            {board.unassigned.length > 0 && (
              <section className="pipe__col pipe__col--nobody" aria-label="Nobody responsible">
                <header className="pipe__head">
                  <h2>Nobody yet</h2>
                  <span className="pipe__n">{board.unassigned.length}</span>
                </header>
                <p className="sprint__cap">
                  {formatHours(board.unassigned.reduce((a, t) => a + (t.estHours || 0), 0))}
                  <span className="muted"> committed, unclaimed</span>
                </p>
                <p className="sprint__role">Drag onto an engineer to claim</p>

                {board.unassigned.map(t => (
                  <article
                    className="dcard scard"
                    key={t.entryId}
                    data-prio={t.priority}
                    draggable={mayPlan && !busy}
                    data-drag={dragging && dragging.ticket.entryId === t.entryId ? '' : undefined}
                    onDragStart={e => startDrag(e, t, NOBODY)}
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
                    <p className="dcard__meta">
                      <span className="pill" data-status={(t.status || 'Open').replace(/s+/g, '')}>{t.status}</span>
                      <span>{formatHours(t.estHours)} est</span>
                    </p>
                    <p className="dcard__co">
                      <Link className="inlink" to={`/clients/${t.clientId || ''}/tickets`}>
                        {t.clientName || t.listName}
                      </Link>
                    </p>
                    {t.accountableName && (
                      <p className="dcard__co muted">PM: {t.accountableName}</p>
                    )}
                    <div className="dcard__move">
                      <EngineerSelect
                        label={`Give ${t.title} to an engineer`}
                        onPick={(userId, name) => plan(t, userId, name)}
                      />
                      <button type="button" className="linkbtn" disabled={!!busy} onClick={() => unplan(t)}>
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            )}

            {board.columns.map(col => (
              <section
                className="pipe__col"
                key={col.entryId || col.engineer}
                aria-label={col.engineer}
                data-over={over === (col.entryId || col.engineer) && canDrop(col) ? '' : undefined}
                data-nodrop={dragging && !canDrop(col) && dragging.from !== (col.entryId || col.engineer)
                  ? '' : undefined}
                onDragOver={e => {
                  if (!canDrop(col)) return
                  // Without preventDefault the browser refuses the drop entirely.
                  e.preventDefault()
                  const id = col.entryId || col.engineer
                  if (over !== id) setOver(id)
                }}
                onDragLeave={() => setOver(o => (o === (col.entryId || col.engineer) ? '' : o))}
                onDrop={e => { e.preventDefault(); dropOn(col) }}
              >
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

                {col.tickets.length === 0 && (
                  <p className="pipe__empty">
                    {canDrop(col) ? 'Drop here' : 'Nothing planned'}
                  </p>
                )}

                {col.tickets.map(t => (
                  <article
                    className="dcard scard"
                    key={t.entryId}
                    data-prio={t.priority}
                    draggable={mayPlan && !busy}
                    data-drag={dragging && dragging.ticket.entryId === t.entryId ? '' : undefined}
                    onDragStart={e => startDrag(e, t, col.entryId || col.engineer)}
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

          {/* ---- the backlog ----
              Also a drop target: dragging a card back here takes it out of the sprint,
              which is the gesture people try first and the reverse of planning it in. */}
          <section
            className="tsec sprint__backlog"
            data-over={over === BACKLOG && dragging && dragging.from !== BACKLOG ? '' : undefined}
            onDragOver={e => {
              if (!dragging || !mayPlan || dragging.from === BACKLOG) return
              e.preventDefault()
              if (over !== BACKLOG) setOver(BACKLOG)
            }}
            onDragLeave={() => setOver(o => (o === BACKLOG ? '' : o))}
            onDrop={e => {
              e.preventDefault()
              const carried = dragging
              setOver(''); setDragging(null)
              if (carried && carried.from !== BACKLOG) unplan(carried.ticket)
            }}
          >
            <div className="panel__head">
              <h2 className="tsec__h">
                Ready to plan
                {board.backlogTotal > 0 && <span className="tsec__n">{board.backlogTotal}</span>}
              </h2>
              <span className="panel__note">
                {ENGINEER_READY_RULE}
                {backlogFilters > 0
                  ? ` · ${backlogRows.length} of ${backlogRaw.length} shown`
                  : backlogTruncated ? ` · showing ${board.backlog.length}` : ''}
              </span>
              {backlogFilters > 0 && (
                <button type="button" className="linkbtn" onClick={clearBacklogFilters}>
                  Clear filters
                </button>
              )}
            </div>

            {/* Only offered once there is enough to be worth narrowing. Three selects
                above four rows is more control than content. */}
            {backlogRaw.length > 4 && (
              <div className="board2__filters">
                <div className="ef">
                  <label htmlFor="b-acct">Accountable</label>
                  <select id="b-acct" value={bAcct} onChange={e => setBAcct(e.target.value)}>
                    <option value="">Anyone</option>
                    {backlogOptions.people.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div className="ef">
                  <label htmlFor="b-list">Client or list</label>
                  <select id="b-list" value={bList} onChange={e => setBList(e.target.value)}>
                    <option value="">Anyone's</option>
                    {backlogOptions.lists.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div className="ef">
                  <label htmlFor="b-prio">Priority</label>
                  <select id="b-prio" value={bPriority} onChange={e => setBPriority(e.target.value)}>
                    <option value="">Any priority</option>
                    {backlogOptions.priorities.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* The filters act on what was loaded, and the server capped it. Saying so is
                the difference between a narrowed list and a wrong one. */}
            {backlogTruncated && (
              <p className="board2__notice">
                Showing the {board.backlog.length} biggest of {board.backlogTotal} ready to
                plan. Sorting and filtering apply to those, not to the rest.
              </p>
            )}

            {dragging && dragging.from !== BACKLOG && (
              <p className="pipe__empty">Drop here to take it out of the sprint</p>
            )}

            {backlogRaw.length > 0 && backlogRows.length === 0 ? (
              <div className="callout callout--plain">
                <p className="callout__title">Nothing matches those filters</p>
                <p>
                  {backlogRaw.length} item{backlogRaw.length === 1 ? ' is' : 's are'} ready
                  to plan, none of them matching all three.{' '}
                  <button type="button" className="linkbtn" onClick={clearBacklogFilters}>
                    Clear the filters
                  </button>.
                </p>
              </div>
            ) : board.backlog.length === 0 ? (
              <div className="callout callout--plain">
                <p className="callout__title">Nothing is ready to plan</p>
                <p>
                  The planner only shows work that is {ENGINEER_READY_RULE}. Right now
                  that leaves nothing{skipTotal > 0 ? ', because:' : '.'}
                </p>
                {skipTotal > 0 && (
                  <ul className="cab__folders">
                    {board.backlogSkipped.wrongStatus > 0 && (
                      <li className="cab__folder">
                        <span className="cab__name">
                          {board.backlogSkipped.wrongStatus} not Up Next or In Progress
                        </span>
                      </li>
                    )}
                    {board.backlogSkipped.noEstimate > 0 && (
                      <li className="cab__folder">
                        <span className="cab__name">
                          {board.backlogSkipped.noEstimate} with no time estimate
                        </span>
                      </li>
                    )}
                    {board.backlogSkipped.noAccountable > 0 && (
                      <li className="cab__folder">
                        <span className="cab__name">
                          {board.backlogSkipped.noAccountable} with nobody accountable
                        </span>
                      </li>
                    )}
                  </ul>
                )}
                <p>
                  <Link className="inlink" to="/tickets">Open the tickets board</Link> to
                  set an estimate or an owner, and it will appear here.
                </p>
              </div>
            ) : (
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      {SORT_COLUMNS.map(c => (
                        <th
                          key={c.key}
                          scope="col"
                          className={c.numeric && c.key === 'est' ? 'num' : undefined}
                          aria-sort={bSort.key === c.key
                            ? (bSort.dir === 1 ? 'ascending' : 'descending')
                            : 'none'}
                        >
                          <button type="button" className="sortbtn" onClick={() => sortBy(c.key)}>
                            {c.label}
                            <span className="sortbtn__i" aria-hidden="true">
                              {bSort.key === c.key ? (bSort.dir === 1 ? '▲' : '▼') : '↕'}
                            </span>
                          </button>
                        </th>
                      ))}
                      <th scope="col">Plan into {sprintLabel(sprint)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backlogRows.map(t => (
                      <tr
                        key={t.entryId}
                        data-prio={t.priority}
                        draggable={mayPlan && !busy}
                        data-drag={dragging && dragging.ticket.entryId === t.entryId ? '' : undefined}
                        onDragStart={e => startDrag(e, t, BACKLOG)}
                        onDragEnd={endDrag}
                      >
                        <td className="tickets__num">
                          {t.ticketNumber === null
                            ? dash
                            : (
                              <Link className="tnum tnum--link" to={ticketPath(t)} {...NEW_TAB}>
                                #{t.ticketNumber}
                              </Link>
                            )}
                        </td>
                        <th scope="row">
                          {t.isSubtask && t.parentNumber !== null && (
                            <span className="subcrumb">#{t.parentNumber} ›</span>
                          )}
                          <Link className="rowlink__a" to={ticketPath(t)} {...NEW_TAB}>
                            {t.title}
                          </Link>
                        </th>
                        <td>{t.clientName || t.listName}</td>
                        <td className="tickets__who" title={t.accountableName || ''}>
                          {t.accountableName || dash}
                        </td>
                        {/* Unset priority drew an empty bordered pill here - a blank
                            chip that looked like a rendering fault. Blank cell instead. */}
                        <td>
                          {t.priority
                            ? <span className="pill" data-prio={t.priority}>{t.priority}</span>
                            : null}
                        </td>
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
            Drag a card onto an engineer to plan it - they become its Responsible party,
            and whoever is Accountable stays put. Drag it back to Ready to plan to take it
            out of the sprint.
          </p>
        </>
      )}
    </section>
  )
}
