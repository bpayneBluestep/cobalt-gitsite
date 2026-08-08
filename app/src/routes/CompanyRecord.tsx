import { useCallback, useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom'
import {
  ApiError, getCompany, setCategory,
  COMPANY_CATEGORIES, type Company,
} from '../api'
import AccountOwnerCard from '../components/AccountOwnerCard'
import RecordTabs from '../components/RecordTabs'

/*
 * The company record — the shell every one of its sections renders inside.
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
  /** Re-read the record — for a child that changed something the header shows. */
  reload: () => void
  /** Replace the header's copy from a child's own fresh reply. */
  setCompany: (c: Company) => void
}

/** For a child route: the company this section belongs to. */
export const useRecord = () => useOutletContext<RecordContext>()

export default function CompanyRecord() {
  const { id = '' } = useParams()
  // Set when we arrive straight from "New client" and the list step failed — the
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
            <h1>{company.name || <span className="muted">Untitled</span>}</h1>
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
                    : <span className="muted">—</span>}
                </dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd>
                  {[company.street, company.city, company.state, company.postalCode]
                    .filter(Boolean).join(', ') || <span className="muted">—</span>}
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

          <RecordTabs companyId={company.id} />

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

/** The account owner belongs to the record, but only the Info tab has room for it. */
export function RecordOwnerCard() {
  const { company, reload } = useRecord()
  return <AccountOwnerCard companyId={company.id} onChanged={reload} />
}
