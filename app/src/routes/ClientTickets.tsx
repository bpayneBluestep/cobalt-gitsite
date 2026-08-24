import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, getClientList, getTickets, type List, type Ticket } from '../api'
import TicketBoard from '../components/TicketBoard'
import { useRecord } from './CompanyRecord'

/*
 * The Tickets tab of a company record.
 *
 * A child route, so the company's name, facts and tab strip stay above it: the board is
 * a section of the record, not a place you go instead of it.
 *
 * The list is resolved through `clientList`, which returns the client's list or creates
 * it on first ask, so a client added before the list feature existed still lands on a
 * working board rather than an error.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; list: List; tickets: Ticket[]; created: boolean }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

export default function ClientTickets() {
  const { company } = useRecord()
  const id = company.id
  const [state, setState] = useState<State>({ phase: 'loading' })

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getClientList(id)
      .then(list => setState({
        phase: 'ready', list, tickets: list.tickets || [], created: !!list.created,
      }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [id])

  useEffect(load, [load])

  // After an add or delete, re-read just this list's tickets rather than
  // re-resolving the list itself. Nothing about the list changed. The id is passed
  // in so this doesn't close over a stale state.
  const reloadTickets = useCallback((listId: string) => {
    getTickets({ listId })
      .then(data => setState(s => (s.phase === 'ready' ? { ...s, tickets: data.rows } : s)))
      .catch(() => load())
  }, [load])

  // Every ticket write returns the whole ticket, re-read server-side, so an edit
  // swaps that one row in place instead of costing another round trip for the list.
  const patchTicket = useCallback((updated: Ticket) => {
    setState(s => (s.phase === 'ready'
      ? { ...s, tickets: s.tickets.map(t => (t.entryId === updated.entryId ? updated : t)) }
      : s))
  }, [])

  return (
    <>
      {state.phase === 'loading' && <p className="empty">Loading tickets…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not open this board'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
            {' '}
            <Link className="btn btn--ghost" to={`/clients/${id}`}>Back to the record</Link>
          </p>
        </div>
      )}

      {state.phase === 'ready' && (
        <>
          {state.created && (
            <p className="board2__notice" role="status">
              This client had no ticket list, so one was created just now.
            </p>
          )}

          <TicketBoard
            list={state.list}
            tickets={state.tickets}
            onChanged={() => reloadTickets(state.list.id)}
            onTicket={patchTicket}
          />
        </>
      )}
    </>
  )
}
