import { useCallback, useEffect, useState } from 'react'
import { getClients, ApiError, type Company } from '../api'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: Company[] }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

export default function Clients() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getClients()
      .then(data => setState({ phase: 'ready', rows: data.rows }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(load, [load])

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Companies</p>
        <h1>Clients</h1>
        <p className="page__sub-text">
          Every Company record in the <code>Client</code> category, served by the Maestro.
        </p>
      </header>

      {state.phase === 'loading' && <p className="empty">Loading clients…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load clients'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
          </p>
        </div>
      )}

      {state.phase === 'ready' && state.rows.length === 0 && (
        <div className="callout callout--plain">
          <p className="callout__title">No clients yet</p>
          <p>
            The Maestro answered, and the <code>Client</code> category is empty. Create a
            Company record and set its category to <code>Client</code> and it will appear here.
          </p>
        </div>
      )}

      {state.phase === 'ready' && state.rows.length > 0 && (
        <>
          <p className="page__count">
            {state.rows.length} client{state.rows.length === 1 ? '' : 's'}
          </p>
          <div className="tablewrap">
            <table className="fields">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Website</th>
                  <th scope="col">City</th>
                  <th scope="col">State</th>
                  <th scope="col">Postal</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map(row => (
                  <tr key={row.id}>
                    <th scope="row">{row.name || <span className="muted">(unnamed)</span>}</th>
                    <td>
                      {row.website
                        ? <a className="inlink" href={row.website} target="_blank" rel="noopener noreferrer">{row.website}</a>
                        : <span className="muted">—</span>}
                    </td>
                    <td>{row.city || <span className="muted">—</span>}</td>
                    <td>{row.state || <span className="muted">—</span>}</td>
                    <td>{row.postalCode || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
