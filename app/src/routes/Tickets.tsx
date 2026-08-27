import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ApiError, getLists, getTickets, formatHours,
  type List, type Ticket,
} from '../api'
import TicketBoard from '../components/TicketBoard'

/*
 * Tickets: every board in one place, scoped by list.
 *
 * This page replaces a prototype that predated the ticket schema. It rendered six
 * hard-coded sample rows through columns that no longer existed - Open / In Progress /
 * Blocked / Done, against a real vocabulary of Open / Up Next / In Progress / In Review /
 * Complete - and its own comment said the data path was not built. Everything it claimed
 * has been true for a while, so it was not a placeholder any more, it was a wrong page.
 *
 * The reason it needed to become real: **not every list belongs to a client.** Cobalt has
 * `Product`, `Internal Dev`, `Platform Dev` and `Other` kinds, and `isClientList` is just
 * `!!clientId`. A client's board is reachable through its record, at
 * /clients/:id/tickets - an internal one had nowhere to be reached from at all. Behavioral
 * Template 2.0 alone is 311 open tickets that no navigation led to.
 *
 * So: one list selector over the same `TicketBoard` the company record uses. Not a second
 * ticket UI - the tabs, filters, subtask folding, quick status moves and permission
 * handling are that component's, and a parallel implementation would be two boards to keep
 * in agreement about what a ticket looks like.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; lists: List[]; tickets: Ticket[] }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

const ALL = 'all'

/**
 * The order kinds are offered in: what you are most likely to be looking for first.
 *
 * Client work is the bulk of it and the reason the system exists. The rest is grouped
 * rather than mixed in, because "our own work" and "a client's work" are different
 * questions and a single flat list of 84 makes you read all of them to tell which is which.
 */
const KIND_ORDER = ['Client', 'Product', 'Internal Dev', 'Platform Dev', 'Other']

function kindOf(l: List): string {
  return KIND_ORDER.indexOf(l.kind) >= 0 ? l.kind : 'Other'
}

export default function Tickets() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('list') || ALL
  const [state, setState] = useState<State>({ phase: 'loading' })

  /*
   * Both reads at once, and the tickets unfiltered.
   *
   * `tickets` with no listId returns every ticket across every list in one walk, which is
   * the same call the endpoint's own Home page makes. Filtering here rather than per
   * selection means switching lists is instant and costs nothing - the same trade
   * TicketBoard already makes for its tabs.
   */
  const load = useCallback(() => {
    setState({ phase: 'loading' })
    Promise.all([getLists(), getTickets()])
      .then(([lists, tickets]) => setState({
        phase: 'ready',
        // Archived lists are excluded deliberately: four of the five that exist are
        // duplicates of a live client list, and their tickets are not the current board.
        lists: (lists.rows || []).filter(l => !l.archived),
        tickets: tickets.rows || [],
      }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(load, [load])

  const lists = state.phase === 'ready' ? state.lists : []
  const tickets = state.phase === 'ready' ? state.tickets : []

  /** How many tickets sit on each list, so the selector can say before you pick. */
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const t of tickets) out[t.listId] = (out[t.listId] || 0) + 1
    return out
  }, [tickets])

  /*
   * Only lists that HOLD something, plus whatever is currently selected.
   *
   * 84 lists exist and 57 have tickets; offering the 27 empty ones makes the selector
   * long enough to need reading. The selected list stays regardless, so a link to an
   * empty board still resolves to itself rather than silently jumping to All.
   */
  const offered = useMemo(() => {
    const rows = lists.filter(l => counts[l.id] || l.id === selected)
    return rows.sort((a, b) => {
      const ka = KIND_ORDER.indexOf(kindOf(a))
      const kb = KIND_ORDER.indexOf(kindOf(b))
      if (ka !== kb) return ka - kb
      return (a.clientName || a.listName).localeCompare(b.clientName || b.listName)
    })
  }, [lists, counts, selected])

  const grouped = useMemo(() => {
    const out: { kind: string; rows: List[] }[] = []
    for (const l of offered) {
      const k = kindOf(l)
      const last = out[out.length - 1]
      if (last && last.kind === k) last.rows.push(l)
      else out.push({ kind: k, rows: [l] })
    }
    return out
  }, [offered])

  const spansLists = selected === ALL
  const shown = spansLists ? tickets : tickets.filter(t => t.listId === selected)
  const activeList = lists.find(l => l.id === selected) || null

  /*
   * The board needs a `list`. On All there isn't one, so it gets a synthetic record whose
   * only job is to be a label - and `spansLists` withdraws the create form, because a new
   * ticket needs one real target list and choosing it from a mixed board would be a guess.
   */
  const boardList: List = activeList || {
    id: '', listName: 'All lists', desc: '', clientId: '', clientName: '',
    kind: '', archived: false, isClientList: false,
  }

  const pick = (id: string) => {
    const next = new URLSearchParams(params)
    if (id === ALL) next.delete('list')
    else next.set('list', id)
    setParams(next, { replace: true })
  }

  const patchTicket = useCallback((updated: Ticket) => {
    setState(s => (s.phase === 'ready'
      ? { ...s, tickets: s.tickets.map(t => (t.entryId === updated.entryId ? updated : t)) }
      : s))
  }, [])

  const hours = useMemo(
    () => shown.reduce((a, t) => a + (Number(t.loggedHours) || 0), 0),
    [shown],
  )

  return (
    /* `page` is what supplies the page's own padding - a bare wrapper puts the table
       hard against the window edge. Same shell as Clients and Pipeline. */
    <section className="page">
      <header className="page__head">
        <div className="page__headrow">
          <div>
            <p className="eyebrow">Work</p>
            <h1>Tickets</h1>
          </div>
          <div className="page__head-tools">
            {state.phase === 'ready' && (
              <div className="ef ef--narrow">
                <label htmlFor="tk-list">List</label>
                <select id="tk-list" value={selected} onChange={e => pick(e.target.value)}>
                  <option value={ALL}>All lists ({tickets.length})</option>
                  {grouped.map(g => (
                    <optgroup key={g.kind} label={g.kind}>
                      {g.rows.map(l => (
                        <option key={l.id} value={l.id}>
                          {(l.clientName || l.listName)} ({counts[l.id] || 0})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
        <p className="page__sub-text">
          {state.phase === 'ready'
            ? spansLists
              ? `${tickets.length} tickets across ${offered.length} lists, ${formatHours(hours)} logged. `
                + 'Every board in one place, including the lists that are ours rather than a client’s.'
              : `${shown.length} tickets, ${formatHours(hours)} logged.`
            : 'Every board, client and internal.'}
        </p>
      </header>

      {state.phase === 'loading' && <p className="empty">Loading tickets…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load the boards'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
          </p>
        </div>
      )}

      {state.phase === 'ready' && (
        <>
          {/* Where to create, since this board deliberately cannot. Only worth saying on
              a client list, where the record is the place that owns the button. */}
          {activeList && activeList.clientId && (
            <p className="board2__notice">
              <Link to={`/clients/${activeList.clientId}/tickets`}>
                Open {activeList.clientName || activeList.listName}’s record
              </Link>{' '}
              to add a ticket or ask Wesley.
            </p>
          )}

          {shown.length === 0 ? (
            <p className="empty">
              {spansLists ? 'No tickets yet.' : 'This list has no tickets yet.'}
            </p>
          ) : (
            <TicketBoard
              list={boardList}
              tickets={shown}
              onChanged={load}
              onTicket={patchTicket}
              spansLists={spansLists}
            />
          )}
        </>
      )}
    </section>
  )
}
