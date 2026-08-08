import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError, getCompany, updateCompany, setCategory,
  COMPANY_FIELDS, COMPANY_CATEGORIES, type Company, type CompanyFieldKey,
} from '../api'

/*
 * The company record — reached by clicking a row on the Clients table.
 *
 * One editable card, 1:1 with the real BlueStep form (Company Info), following
 * the eccrm pattern: render the live values as inputs, send ONLY the fields the
 * user actually changed, and re-render from the record the server echoes back
 * rather than from what we hoped we sent.
 *
 * The stage control moves the company between Lead / Client / Former Client.
 * Unlike eccrm's person stages, these are mutually exclusive — a company sits in
 * exactly one. Moving requires the platform's Category Editor permission; when
 * the caller lacks it the endpoint says so and the message lands inline.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; company: Company }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/** Values as edited in the form, keyed the same as the endpoint's field catalog. */
type Draft = Record<CompanyFieldKey, string>

function draftOf(c: Company): Draft {
  const d = {} as Draft
  for (const f of COMPANY_FIELDS) d[f.key] = (c[f.key] || '') as string
  return d
}

/** Only the keys whose value differs from the saved record. */
function changedKeys(draft: Draft, saved: Company): Partial<Record<CompanyFieldKey, string>> {
  const out: Partial<Record<CompanyFieldKey, string>> = {}
  for (const f of COMPANY_FIELDS) {
    const now = draft[f.key] ?? ''
    const was = (saved[f.key] || '') as string
    if (now !== was) out[f.key] = now
  }
  return out
}

export default function CompanyRecord() {
  const { id = '' } = useParams()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [moving, setMoving] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    setNotice('')
    setFailure('')
    getCompany(id)
      .then(company => { setState({ phase: 'ready', company }); setDraft(draftOf(company)) })
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [id])

  useEffect(load, [load])

  const company = state.phase === 'ready' ? state.company : null
  const pending = company && draft ? changedKeys(draft, company) : {}
  const dirty = Object.keys(pending).length > 0

  function edit(key: CompanyFieldKey, value: string) {
    setDraft(d => (d ? { ...d, [key]: value } : d))
    setNotice('')
    setFailure('')
  }

  function save() {
    if (!company || !dirty) return
    setSaving(true)
    setFailure('')
    setNotice('')
    updateCompany(company.id, pending)
      .then(fresh => {
        setState({ phase: 'ready', company: fresh })
        setDraft(draftOf(fresh))
        const n = Object.keys(pending).length
        setNotice(`Saved ${n} field${n === 1 ? '' : 's'}.`)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSaving(false))
  }

  function revert() {
    if (company) setDraft(draftOf(company))
    setNotice('')
    setFailure('')
  }

  function move(category: string) {
    if (!company) return
    setMoving(category)
    setFailure('')
    setNotice('')
    setCategory(company.id, category)
      .then(fresh => {
        setState({ phase: 'ready', company: fresh })
        setDraft(draftOf(fresh))
        setNotice(`Moved to ${category}.`)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setMoving(''))
  }

  return (
    <section className="page">
      <nav className="crumb" aria-label="Breadcrumb">
        <Link to="/">Clients</Link>
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
            <Link className="btn btn--ghost" to="/">Back to Clients</Link>
          </p>
        </div>
      )}

      {company && draft && (
        <>
          <header className="page__head">
            <p className="eyebrow">Company</p>
            <h1>{company.name || <span className="muted">Untitled</span>}</h1>
          </header>

          <div className="reccard">
            <dl className="facts">
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

          <div className="editcard">
            <div className="editcard__head">
              <h2>Company Info</h2>
              <p className="note">
                The record's base form. Only the fields you change are written.
              </p>
            </div>

            {failure && (
              <p className="editcard__err" role="alert">{failure}</p>
            )}

            <div className="efgrid">
              {COMPANY_FIELDS.map(f => (
                <div className="ef" key={f.key}>
                  <label htmlFor={`ef-${f.key}`}>
                    {f.label}
                    {'required' in f && f.required && <span className="ef__req" aria-hidden="true">*</span>}
                  </label>
                  <input
                    id={`ef-${f.key}`}
                    type="text"
                    value={draft[f.key]}
                    placeholder={'placeholder' in f ? f.placeholder : ''}
                    autoComplete="off"
                    onChange={e => edit(f.key, e.target.value)}
                  />
                </div>
              ))}
            </div>

            <div className="editcard__foot">
              <span className="editcard__status">
                {saving ? 'Saving…' : notice ? notice : dirty
                  ? `${Object.keys(pending).length} unsaved change${Object.keys(pending).length === 1 ? '' : 's'}`
                  : ''}
              </span>
              <button type="button" className="btn btn--ghost" onClick={revert} disabled={!dirty || saving}>
                Revert
              </button>
              <button type="button" className="btn" onClick={save} disabled={!dirty || saving}>
                Save changes
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
