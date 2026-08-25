import { useCallback, useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom'
import {
  ApiError, getCompany, setCategory, getUnits, setUnit,
  COMPANY_CATEGORIES, type Company, type RecordUnit,
} from '../api'
import RecordTabs from '../components/RecordTabs'
import { useSession } from '../session'

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
