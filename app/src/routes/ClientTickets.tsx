import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, getClientList, getTickets, type List, type Ticket } from '../api'
import TicketBoard from '../components/TicketBoard'
import RecordTabs from '../components/RecordTabs'

/*
 * A client's tickets, at /clients/<id>/tickets.
 *
 * The list is resolved through `clientList`, which returns the client's list or
 * creates it on first ask — so a client added before the list feature existed
 * still lands on a working board rather than an error.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; list: List; tickets: Ticket[]; created: boolean }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

export default function ClientTickets() {
  const { id = '' } = useParams()
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
  // re-resolving the list itself — nothing about the list changed. The id is passed
  // in so this doesn't close over a stale state.
  const reloadTickets = useCallback((listId: string) => {
    getTickets({ listId })
      .then(data => setState(s => (s.phase === 'ready' ? { ...s, tickets: data.rows } : s)))
      .catch(() => load())
  }, [load])

  // Every ticket write returns the whole ticket, re-read server-side — so an edit
  // swaps that one row in place instead of costing another round trip for the list.
  const patchTicket = useCallback((updated: Ticket) => {
    setState(s => (s.phase === 'ready'
      ? { ...s, tickets: s.tickets.map(t => (t.entryId === updated.entryId ? updated : t)) }
      : s))
  }, [])

  return (
    <section className="page">
      <nav className="crumb" aria-label="Breadcrumb">
        <Link to="/clients">Clients</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/clients/${id}`}>
          {state.phase === 'ready' ? state.list.clientName || state.list.listName : 'Client'}
        </Link>
        <span aria-hidden="true">/</span>
        <span>Tickets</span>
      </nav>

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
          <header className="page__head">
            <p className="eyebrow">{state.list.kind || 'List'}</p>
            <h1>{state.list.listName || 'Tickets'}</h1>
            <p className="page__sub-text">
              Work tracked against this client — the internal replacement for ClickUp.
              {state.created && ' This list was created just now.'}
            </p>
          </header>

          {/* The same strip as the record itself, so the other three sections are one
              click away rather than a trip back through the breadcrumb. */}
          <RecordTabs companyId={id} active="tickets" />

          <TicketBoard
            list={state.list}
            tickets={state.tickets}
            onChanged={() => reloadTickets(state.list.id)}
            onTicket={patchTicket}
          />
        </>
      )}
    </section>
  )
}
