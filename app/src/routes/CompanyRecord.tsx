import { useCallback, useEffect, useState } from 'react'
import {
  Link, Outlet, useLocation, useNavigate, useOutletContext, useParams,
} from 'react-router-dom'
import {
  ApiError, getCompany, setCategory, getUnits, setUnit, deleteCompany,
  COMPANY_CATEGORIES, type Company, type RecordUnit,
} from '../api'
import RecordTabs from '../components/RecordTabs'
import { useSession } from '../session'

/*
 * Deleting a company.
 *
 * Sits in the header beside the stage buttons because that is where the other
 * whole-record actions live, and styled with `btn--del` — danger on the text, not a red
 * fill, so it is findable without competing with the thing people actually came to do.
 *
 * Two brakes, because the record takes a lot with it:
 *
 *   1. The dialog LISTS what dies (deals, agreements, contacts, files, and the ticket
 *      list with its tickets) instead of asking a bare "are you sure?". Most people
 *      cannot name what hangs off a company from memory, and the tickets are the part
 *      that surprises.
 *   2. The person types YES. A yes/no prompt gets a reflex; typing costs a beat of
 *      reading. The same string goes to the server, which demands it independently — the
 *      dialog is a courtesy, the endpoint is the gate.
 *
 * Only rendered with `deleteCompanies` (Leadership). A hidden button is not security —
 * the endpoint refuses regardless — it just avoids offering a door that will not open.
 */
function DeleteCompany({ company }: { company: Company }) {
  const { can } = useSession()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  if (!can('deleteCompanies')) return null

  const armed = typed.trim().toUpperCase() === 'YES'

  const close = () => {
    if (busy) return
    setOpen(false); setTyped(''); setFailure('')
  }

  const run = () => {
    if (!armed || busy) return
    setBusy(true); setFailure('')
    // The typed value is what goes over the wire, not a literal: the server check has to
    // be testing the person's input or it is testing nothing.
    deleteCompany(company.id, typed.trim().toUpperCase())
      .then(() => { navigate('/clients', { replace: true }) })
      .catch((e: unknown) => {
        setBusy(false)
        setFailure(e instanceof ApiError ? e.message : 'Could not delete the company.')
      })
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost btn--del"
        onClick={() => setOpen(true)}
        title={`Delete ${company.name}`}
      >
        Delete
      </button>

      {open && (
        <div
          className="confirm-back"
          onMouseDown={e => { if (e.target === e.currentTarget) close() }}
        >
          <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="del-h">
            <h2 id="del-h">Delete this company?</h2>
            <p>
              <span className="confirm__name">{company.name}</span> and everything on it
              will be permanently removed:
            </p>
            <ul>
              <li>Deals, and their history</li>
              <li>Agreements, including signed documents</li>
              <li>Contacts, files, and Client Success touchpoints</li>
              <li>Its ticket list, and every ticket on it</li>
            </ul>
            <p>This cannot be undone.</p>

            <label className="confirm__label" htmlFor="del-yes">
              Type YES to confirm
            </label>
            <input
              id="del-yes"
              className="input"
              value={typed}
              autoFocus
              autoComplete="off"
              disabled={busy}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && armed) run() }}
            />

            <div className="confirm__foot">
              <span className="confirm__status">{failure}</span>
              <button type="button" className="btn btn--ghost" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={run}
                disabled={!armed || busy}
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/*
 * Which unit a record sits in, and a way to change it.
 *
 * It matters and nothing showed it: eight seeded companies sit in the top-level Cobalt
 * unit while every imported client sits in Behavioral, and the only way to tell was to
 * ask the database. The unit decides which queries see a record and which site serves
 * it, so it belongs in the header next to the record id.
 *
 * Reads as text until you click it, because this is a fact you look at far more often
 * than you change, and a select sitting open in a header invites an accident.
 */
function UnitPicker({ company, onMoved }: {
  company: Company
  onMoved: (c: Company) => void
}) {
  const { can } = useSession()
  const mayMove = can('editClients')
  const [editing, setEditing] = useState(false)
  const [units, setUnits] = useState<RecordUnit[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!editing) return
    getUnits()
      .then(d => setUnits(d.rows || []))
      .catch(() => setFailure('Could not read the unit list.'))
  }, [editing])

  const current = company.unit
  const label = current?.name || 'unknown'

  function move(unitId: string) {
    if (!unitId || unitId === current?.id) { setEditing(false); return }
    setBusy(true)
    setFailure('')
    setNote('')
    setUnit(company.id, unitId)
      .then(r => {
        onMoved(r.company)
        // The endpoint reads the move back. If it did not land, say so here rather
        // than showing the new name and letting the next reload contradict it.
        if (r.moved) setEditing(false)
        else setNote(r.note || 'The move did not take effect.')
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  if (!editing) {
    return (
      <>
        {mayMove ? (
          <button type="button" className="linkbtn" onClick={() => setEditing(true)}>
            {label}
          </button>
        ) : <span>{label}</span>}
        {!current && <span className="muted"> (could not be read)</span>}
      </>
    )
  }

  return (
    <>
      <select
        className="minisel"
        aria-label="Unit"
        defaultValue={current?.id || ''}
        disabled={busy}
        onChange={e => move(e.target.value)}
      >
        <option value="">{units.length ? 'Move to...' : 'Loading...'}</option>
        {units.map(u => (
          <option key={u.id} value={u.id}>{u.name}{u.id === current?.id ? ' (current)' : ''}</option>
        ))}
      </select>{' '}
      <button type="button" className="linkbtn" disabled={busy} onClick={() => setEditing(false)}>
        Cancel
      </button>
      {failure && <p className="editcard__err" role="alert">{failure}</p>}
      {note && <p className="note">{note}</p>}
      <p className="ef__hint">
        Only units already in use are listed. There is no API that enumerates them.
      </p>
    </>
  )
}

/*
 * The company record: the shell every one of its sections renders inside.
 *
 * The name, the facts, the stage control and the tab strip belong to the RECORD, not to
 * any one section, so they live here and each tab is a child route that fills in below.
 * Tickets used to be a route of its own and lost all of this, which made opening the
 * board feel like leaving the company rather than moving around inside it.
 *
 * Children read the loaded company (and a way to re-read it) from the outlet context
 * rather than fetching it again.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; company: Company }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

export interface RecordContext {
  company: Company
  /** Re-read the record, for a child that changed something the header shows. */
  reload: () => void
  /** Replace the header's copy from a child's own fresh reply. */
  setCompany: (c: Company) => void
}

/** For a child route: the company this section belongs to. */
export const useRecord = () => useOutletContext<RecordContext>()

export default function CompanyRecord() {
  const { id = '' } = useParams()
  // Set when we arrive straight from "New client" and the list step failed: the
  // client exists, so this is a warning about what's missing, not an error.
  const arrivalWarning = (useLocation().state as { warning?: string } | null)?.warning || ''
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [moving, setMoving] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    setNotice(''); setFailure('')
    getCompany(id)
      .then(company => setState({ phase: 'ready', company }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [id])

  useEffect(load, [load])

  const company = state.phase === 'ready' ? state.company : null

  function move(category: string) {
    if (!company) return
    setMoving(category)
    setFailure(''); setNotice('')
    setCategory(company.id, category)
      .then(fresh => { setState({ phase: 'ready', company: fresh }); setNotice(`Moved to ${category}.`) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setMoving(''))
  }

  return (
    <section className="page">
      <nav className="crumb" aria-label="Breadcrumb">
        <Link to="/clients">Clients</Link>
        <span aria-hidden="true">/</span>
        <span>{company ? company.name || 'Untitled' : id}</span>
      </nav>

      {state.phase === 'loading' && <p className="empty">Loading record…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load this record'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
            {' '}
            <Link className="btn btn--ghost" to="/clients">Back to Clients</Link>
          </p>
        </div>
      )}

      {company && (
        <>
          <header className="page__head">
            <p className="eyebrow">Company</p>
            <div className="page__headrow">
              <h1>{company.name || <span className="muted">Untitled</span>}</h1>
              {/* Only rendered when there is somewhere to go: a dead button that
                  explains itself on click is worse than no button. */}
              {company.ehrLink && (
                <a className="btn btn--ghost" href={company.ehrLink}
                  target="_blank" rel="noopener noreferrer"
                  title="Open this client's BlueStep org in a new tab">
                  Go to Org ↗
                </a>
              )}
            </div>
          </header>

          {arrivalWarning && (
            <div className="callout callout--warn">
              <p className="callout__title">Client created, but its list wasn't</p>
              <p>{arrivalWarning}</p>
              <p>
                The client itself is saved. Its ticket list can be created on the
                next ask, so nothing is lost.
              </p>
            </div>
          )}

          {failure && <p className="editcard__err" role="alert">{failure}</p>}
          {notice && <p className="board2__notice" role="status">{notice}</p>}

          <div className="reccard">
            <dl className="facts">
              <div>
                <dt>Primary contact</dt>
                <dd>
                  {company.contactName ? (
                    <>
                      {company.contactName}
                      {company.contactTitle && <span className="muted"> · {company.contactTitle}</span>}
                      {company.contactEmail && (
                        <><br /><a className="inlink" href={`mailto:${company.contactEmail}`}>{company.contactEmail}</a></>
                      )}
                    </>
                  ) : (
                    <Link className="linkbtn" to={`/clients/${company.id}/contacts`}>Add a contact</Link>
                  )}
                </dd>
              </div>
              <div>
                <dt>Website</dt>
                <dd>
                  {company.website
                    ? <a className="inlink" href={company.website} target="_blank" rel="noopener noreferrer">{company.website}</a>
                    : <span className="muted">-</span>}
                </dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd>
                  {[company.street, company.city, company.state, company.postalCode]
                    .filter(Boolean).join(', ') || <span className="muted">-</span>}
                </dd>
              </div>
              <div>
                <dt>Unit</dt>
                <dd>
                  <UnitPicker
                    company={company}
                    onMoved={c => setState({ phase: 'ready', company: c })}
                  />
                </dd>
              </div>
              <div>
                <dt>Record id</dt>
                <dd><code className="db">{company.id}</code></dd>
              </div>
            </dl>

            <div className="stage" role="group" aria-label="Pipeline stage">
              {COMPANY_CATEGORIES.map(cat => {
                const on = company.categories.indexOf(cat) >= 0
                return (
                  <button
                    key={cat}
                    type="button"
                    className="filter"
                    data-on={on ? '' : undefined}
                    aria-current={on ? 'true' : undefined}
                    disabled={on || moving !== ''}
                    onClick={() => move(cat)}
                    title={on ? 'Current stage' : `Move to ${cat}`}
                  >
                    {moving === cat ? 'Moving…' : cat}
                  </button>
                )
              })}
              <DeleteCompany company={company} />
            </div>
          </div>

          <RecordTabs companyId={company.id} categories={company.categories} />

          <Outlet context={{
            company,
            reload: load,
            setCompany: (c: Company) => setState({ phase: 'ready', company: c }),
          } as RecordContext} />
        </>
      )}
    </section>
  )
}
