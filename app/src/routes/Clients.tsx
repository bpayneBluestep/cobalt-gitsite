import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  getClients, createClient, ApiError,
  COMPANY_FIELDS, type Company, type CompanyFieldKey,
} from '../api'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: Company[] }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

type Draft = Record<CompanyFieldKey, string>

const EMPTY = COMPANY_FIELDS.reduce((acc, f) => { acc[f.key] = ''; return acc }, {} as Draft)

export default function Clients() {
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ phase: 'loading' })

  // The create panel. Adding a client also creates its list, so this is the one
  // place in the app that writes two records at once.
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState('')

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

  function openPanel() {
    setDraft(EMPTY)
    setFailure('')
    setOpen(true)
  }

  function closePanel() {
    setOpen(false)
    setFailure('')
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.name.trim() || saving) return
    setSaving(true)
    setFailure('')

    // Send only what was filled in: an empty field is "not set", not "".
    const fields: Partial<Record<CompanyFieldKey, string>> = {}
    for (const f of COMPANY_FIELDS) {
      const v = draft[f.key].trim()
      if (v) fields[f.key] = v
    }

    createClient(fields)
      .then(result => {
        // Land on the new record so the next thing you do is fill it in. If the
        // list step failed the client still exists, so say so rather than
        // pretending the whole thing failed.
        navigate(`/clients/${result.company.id}`, {
          state: result.listError ? { warning: result.listError } : undefined,
        })
      })
      .catch(err => {
        setFailure(err instanceof ApiError ? err.message : String(err))
        setSaving(false)
      })
  }

  return (
    <section className="page">
      <header className="page__head">
        <div className="page__headrow">
          <div>
            <p className="eyebrow">Companies</p>
            <h1>Clients</h1>
          </div>
          {!open && (
            <button type="button" className="btn" onClick={openPanel}>
              <span aria-hidden="true">+</span> New client
            </button>
          )}
        </div>
        <p className="page__sub-text">
          Every Company record in the <code>Client</code> category, served by the Maestro.
          Open a name to view and edit its record.
        </p>
      </header>

      {open && (
        <form className="editcard newclient" onSubmit={submit}>
          <div className="editcard__head">
            <h2>New client</h2>
            <p className="note">
              Creates the company in the <code>Client</code> category and a matching
              list for its tickets.
            </p>
          </div>

          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          <div className="efgrid">
            {COMPANY_FIELDS.map(f => (
              <div className="ef" key={f.key}>
                <label htmlFor={`nc-${f.key}`}>
                  {f.label}
                  {'required' in f && f.required && <span className="ef__req" aria-hidden="true">*</span>}
                </label>
                <input
                  id={`nc-${f.key}`}
                  type="text"
                  value={draft[f.key]}
                  placeholder={'placeholder' in f ? f.placeholder : ''}
                  autoComplete="off"
                  autoFocus={f.key === 'name'}
                  onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <div className="editcard__foot">
            <span className="editcard__status">
              {saving ? 'Creating…' : 'A name is required. Records cannot be deleted, so check it before creating.'}
            </span>
            <button type="button" className="btn btn--ghost" onClick={closePanel} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!draft.name.trim() || saving}>
              Create client
            </button>
          </div>
        </form>
      )}

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
            The Maestro answered, and the <code>Client</code> category is empty.
            Use <strong>New client</strong> above to add the first one.
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
                  <th scope="col"><span className="visually-hidden">Their org</span></th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map(row => (
                  <tr key={row.id} className="rowlink">
                    <th scope="row">
                      {/* A real link, so the row is keyboard-reachable and opens in a
                          new tab on middle-click, not a div with an onClick. */}
                      <Link className="rowlink__a" to={`/clients/${row.id}`}>
                        {row.name || <span className="muted">(unnamed)</span>}
                      </Link>
                    </th>
                    <td>
                      {row.website
                        ? <a className="inlink" href={row.website} target="_blank" rel="noopener noreferrer">{row.website}</a>
                        : <span className="muted">-</span>}
                    </td>
                    <td>{row.city || <span className="muted">-</span>}</td>
                    <td>{row.state || <span className="muted">-</span>}</td>
                    <td>{row.postalCode || <span className="muted">-</span>}</td>
                    {/* Straight into the client's own BlueStep org. A new tab, always:
                        this leaves Cobalt for a different system entirely, and coming
                        "back" would mean losing whatever you had open here. */}
                    <td className="clients__org">
                      {row.ehrLink
                        ? (
                          <a className="btn btn--ghost btn--sm" href={row.ehrLink}
                            target="_blank" rel="noopener noreferrer"
                            title={`Open ${row.name || 'this client'} in a new tab`}>
                            Go to Org ↗
                          </a>
                        )
                        : <span className="muted">-</span>}
                    </td>
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
