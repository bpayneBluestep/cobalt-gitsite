import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, getLeads, updateCompany, formatMoney,
  LEAD_STATUSES, type Lead, type LeadList, type CrmFieldKey,
} from '../api'
import CrmNav from '../components/CrmNav'
import DealEditor from '../components/DealEditor'
import OwnerScope, { ScopeNote, useScope } from '../components/OwnerScope'
import { useSession } from '../session'
import { htmlToText } from '../lib/html'
import { todayISO } from '../lib/time'

/*
 * Prospecting: the companies that are not in the pipeline yet.
 *
 * The list is derived, not stored: a company appears here because it has no OPEN
 * deal, so it can never disagree with the pipeline. Two very different jobs live
 * here and are labelled rather than mixed:
 *
 *   * never worked: no deal has ever been opened. A first conversation.
 *   * previously decided: won or lost before. A re-approach, which is a different
 *     call with different words.
 *
 * "Start a deal" is the one action that matters: it opens the company's first deal,
 * at which point the row leaves this page and appears on the board. That transition
 * is the page's whole purpose, so it is a button and not a menu item.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: LeadList }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/**
 * Only the lead fields this page edits inline.
 *
 * The owner is NOT among them any more. A company has no owner to set: ownership starts
 * when somebody opens a deal, which is the "Start a deal" action in the last column.
 */
type TouchKey = Extract<CrmFieldKey, 'leadStatus' | 'lastTouch' | 'nextFollowUp'>

export default function CrmProspecting() {
  // Sales and Leadership move deals; Accounting and Client Success only watch. Reading
  // the pipeline without being able to nudge it is a legitimate position to be in.
  const { can } = useSession()
  const mayEdit = can('editDeals')
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [search, setSearch] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fSource, setFSource] = useState('')
  const [onlyNew, setOnlyNew] = useState(false)
  const [startFor, setStartFor] = useState<Lead | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  // Whose leads. Shared with every other CRM screen, and Mine by default. See
  // `lib/scope.ts` for why the default is not Everyone.
  const [, , ownerId] = useScope()

  const load = useCallback((who: string) => {
    setState({ phase: 'loading' })
    getLeads({ category: 'Lead', ...(who ? { ownerId: who } : {}) })
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(ownerId) }, [load, ownerId])

  const d = state.phase === 'ready' ? state.data : null
  const today = todayISO()

  const rows = useMemo(() => {
    if (!d) return []
    const q = search.toLowerCase().trim()
    return d.rows
      .filter(r => !r.hasOpenDeal)
      .filter(r => {
        if (onlyNew && !r.neverWorked) return false
        if (fStatus && r.leadStatus !== fStatus) return false
        if (fSource && r.leadSource !== fSource) return false
        if (!q) return true
        return [r.name, r.contactName, r.city, r.state, r.leadSource, htmlToText(r.crmNotes)]
          .some(v => (v || '').toLowerCase().includes(q))
      })
      // Soonest follow-up first; anything with no date sorts last rather than first,
      // because a blank is not urgent.
      .sort((a, b) => {
        const da = a.nextFollowUp || '9999-12-31'
        const db = b.nextFollowUp || '9999-12-31'
        if (da !== db) return da < db ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [d, search, fStatus, fSource, onlyNew])

  const activeFilters = [fStatus, fSource].filter(Boolean).length + (onlyNew ? 1 : 0)

  /** Write one field on a lead, straight from its row. */
  function touch(lead: Lead, key: TouchKey, value: string, said: string) {
    if (!mayEdit) return
    if (busy) return
    setBusy(lead.id); setFailure(''); setNotice('')
    updateCompany(lead.id, { [key]: value })
      .then(() => { setNotice(`${lead.name}: ${said}`); load(ownerId) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">CRM</p>
        <h1>Prospecting</h1>
        <p className="page__sub-text">
          Leads with no open deal. Start one and the company moves to the pipeline.
        </p>
      </header>

      {/* Only the Prospecting count: this page knows how many leads are in the
          pipeline, which is not the same number as how many open DEALS there are,
          a client can carry an upsell. A badge that means two things is worse than
          one that is absent. */}
      <CrmNav counts={d ? { Prospecting: d.prospecting } : undefined} />

      {state.phase === 'loading' && <p className="empty">Loading leads…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load leads'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load(ownerId)}>Try again</button>}
          </p>
        </div>
      )}

      {d && (
        <>
          <div className="pipebar">
            <div className="pipebar__totals">
              <span><strong>{d.prospecting}</strong> to work</span>
              <span className="muted"><strong>{d.neverWorked}</strong> never worked</span>
              <span className="muted"><strong>{d.decidedOnly}</strong> previously decided</span>
              <span className="muted"><strong>{d.inPipeline}</strong> already in the pipeline</span>
            </div>
          </div>

          <div className="board2__tools">
            <input
              type="text"
              className="board2__search"
              placeholder="Search leads…"
              value={search}
              autoComplete="off"
              onChange={e => setSearch(e.target.value)}
            />
            <label className="checkline">
              <input type="checkbox" checked={onlyNew} onChange={e => setOnlyNew(e.target.checked)} />
              <span>Never worked only</span>
            </label>
          </div>

          <div className="board2__filters">
            <div className="ef">
              <label htmlFor="l-status">Status</label>
              <select id="l-status" value={fStatus} onChange={e => setFStatus(e.target.value)}>
                <option value="">Any status</option>
                {LEAD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="ef">
              <label htmlFor="l-source">Source</label>
              <select id="l-source" value={fSource} onChange={e => setFSource(e.target.value)}>
                <option value="">Any source</option>
                {d.sources.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {activeFilters > 0 && (
              <div className="ef">
                <label>&nbsp;</label>
                <button type="button" className="btn btn--ghost"
                  onClick={() => { setFStatus(''); setFSource(''); setOnlyNew(false) }}>
                  Clear filters
                </button>
              </div>
            )}
            <OwnerScope />
          </div>

          <ScopeNote ownerName={d.filters?.owner ?? null} />

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {startFor && (
            <DealEditor
              companyId={startFor.id}
              companyName={startFor.name}
              deal={null}
              lossReasons={[]}
              sources={d.sources}
              onSaved={deal => {
                setStartFor(null)
                setNotice(`${deal.title} opened. It is on the pipeline board now.`)
                load(ownerId)
              }}
              onDeleted={() => setStartFor(null)}
              onClose={() => setStartFor(null)}
            />
          )}

          {rows.length === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">
                {d.prospecting === 0 ? 'Every lead has an open deal' : 'Nothing matches'}
              </p>
              <p>
                {d.prospecting === 0
                  ? 'Nothing left to prospect: the whole lead list is in the pipeline.'
                  : 'No leads match the current search or filters.'}
              </p>
            </div>
          ) : (
            <div className="tablewrap">
              <table className="fields leads">
                <thead>
                  <tr>
                    <th scope="col">Company</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Source</th>
                    <th scope="col">Status</th>
                    <th scope="col">Deal owner</th>
                    <th scope="col">Beds</th>
                    <th scope="col">Last touch</th>
                    <th scope="col">Follow-up</th>
                    <th scope="col"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const overdue = !!r.nextFollowUp && r.nextFollowUp < today
                    return (
                      <tr key={r.id} data-overdue={overdue ? '' : undefined}>
                        <th scope="row">
                          <Link className="rowlink__a" to={`/clients/${r.id}`}>{r.name}</Link>
                          <span className="rowmarks">
                            {r.city && <span className="muted">{r.city}{r.state ? `, ${r.state}` : ''}</span>}
                            {r.decidedOnly && (
                              <span className="mark" title="Has a decided deal. This is a re-approach">
                                {r.wonDealCount ? 'won before' : 'lost before'}
                              </span>
                            )}
                          </span>
                        </th>
                        <td>
                          {r.contactName ? (
                            <>
                              {r.contactName}
                              {r.contactTitle && <span className="muted"> · {r.contactTitle}</span>}
                              {r.contactEmail && (
                                <><br /><a className="inlink" href={`mailto:${r.contactEmail}`}>{r.contactEmail}</a></>
                              )}
                            </>
                          ) : <span className="muted">-</span>}
                        </td>
                        <td>{r.leadSource || <span className="muted">-</span>}</td>
                        <td>
                          <select
                            className="minisel"
                            aria-label={`Lead status for ${r.name}`}
                            value={r.leadStatus || ''}
                            disabled={busy === r.id || !mayEdit}
                            onChange={e => touch(r, 'leadStatus', e.target.value, `status → ${e.target.value}.`)}
                          >
                            <option value="">-</option>
                            {LEAD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td>
                          {/*
                            Read-only, and derived from the deals. Nobody is "assigned" a
                            lead here any more: you take one by opening a deal on it, and
                            that deal's owner is what this column reports. An unowned row
                            is not an oversight to be corrected in place. It is a company
                            nobody has started work on, which is what Prospecting is for.
                          */}
                          {r.dealOwners && r.dealOwners.length > 0
                            ? r.dealOwners.map((o, i) => (
                                <span key={o.ownerId || o.owner}>
                                  {i > 0 && <span className="dot" aria-hidden="true">·</span>}
                                  {o.owner}
                                </span>
                              ))
                            : <span className="muted" title="No deal has been opened, so nobody owns it">
                                unowned
                              </span>}
                        </td>
                        <td className="num">{r.beds === null ? <span className="muted">-</span> : r.beds}</td>
                        <td className="nowrap">{r.lastTouch || <span className="muted">-</span>}</td>
                        <td className="nowrap">
                          {r.nextFollowUp || <span className="muted">-</span>}
                          {overdue && <span className="tag tag--warn">overdue</span>}
                        </td>
                        <td className="leads__act">
                          {mayEdit ? (
                            <>
                              <button type="button" className="linkbtn" disabled={busy === r.id}
                                onClick={() => touch(r, 'lastTouch', today, 'marked touched today.')}>
                                Touched
                              </button>
                              <button type="button" className="linkbtn" disabled={busy === r.id}
                                onClick={() => setStartFor(r)}>
                                Start a deal
                              </button>
                            </>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {d.inPipeline > 0 && (
            <p className="panel__foot">
              {d.inPipeline} lead{d.inPipeline === 1 ? '' : 's'} already{' '}
              {d.inPipeline === 1 ? 'has' : 'have'} an open deal and{' '}
              {d.inPipeline === 1 ? 'is' : 'are'} on the{' '}
              <Link className="inlink" to="/crm/pipeline">pipeline board</Link>
              {' '}({formatMoney(d.rows.reduce((s, r) => s + (r.hasOpenDeal ? r.openMrr : 0), 0))} MRR).
            </p>
          )}
        </>
      )}
    </section>
  )
}
