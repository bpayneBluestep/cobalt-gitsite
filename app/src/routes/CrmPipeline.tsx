import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, getPipeline, updateDeal, formatMoney, formatCompactMoney,
  OPEN_PHASES, type Deal, type Pipeline,
} from '../api'
import CrmNav from '../components/CrmNav'
import DealEditor from '../components/DealEditor'

/*
 * The pipeline board — one column per open phase.
 *
 * Columns rather than a table because a phase is a position, and position is what a
 * board shows and a table hides. Each column carries its own count, MRR and weighted
 * MRR, so the shape of the pipeline is legible without adding anything up.
 *
 * Phase is moved by a select on the card, not by dragging. Dragging is nice and it
 * is also the part that breaks on touch, breaks for keyboard users, and needs a
 * library — a select does the same job, is reversible, and says out loud what it did.
 *
 * Closed deals are excluded: this is a forecast, and mixing history into it overstates
 * it. Won and lost live on the dashboard.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: Pipeline }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

export default function CrmPipeline() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [owner, setOwner] = useState('')
  const [openDeal, setOpenDeal] = useState<{ companyId: string; companyName: string; entryId: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback((who: string) => {
    setState({ phase: 'loading' })
    getPipeline(who || undefined)
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(owner) }, [load, owner])

  const d = state.phase === 'ready' ? state.data : null

  const owners = useMemo(() => {
    if (!d) return []
    const seen: Record<string, true> = {}
    for (const col of d.columns) for (const deal of col.rows) if (deal.owner) seen[deal.owner] = true
    return Object.keys(seen).sort()
  }, [d])

  const totals = useMemo(() => {
    if (!d) return { count: 0, mrr: 0, weighted: 0, annual: 0 }
    return d.columns.reduce((acc, c) => ({
      count: acc.count + c.count,
      mrr: acc.mrr + c.mrr,
      weighted: acc.weighted + c.weightedMrr,
      annual: acc.annual + c.annualValue,
    }), { count: 0, mrr: 0, weighted: 0, annual: 0 })
  }, [d])

  const selected: Deal | null = useMemo(() => {
    if (!d || !openDeal) return null
    for (const col of d.columns) {
      for (const deal of col.rows) if (deal.entryId === openDeal.entryId) return deal
    }
    return null
  }, [d, openDeal])

  /** Move a deal's phase straight from its card. */
  function movePhase(deal: Deal, phase: string) {
    if (busy) return
    setBusy(deal.entryId); setFailure(''); setNotice('')
    updateDeal(deal.companyId, deal.entryId, { phase })
      .then(() => {
        setNotice(`${deal.title} → ${phase}.`)
        // Reload rather than patch: moving a deal changes every column total, and a
        // board showing stale totals is worse than one that blinks.
        load(owner)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">CRM</p>
        <h1>Pipeline</h1>
        <p className="page__sub-text">
          Open deals by phase. Weighted figures are MRR × the phase's probability —
          a forecast, not a total.
        </p>
      </header>

      <CrmNav counts={d ? { Pipeline: d.openTotal } : undefined} />

      {state.phase === 'loading' && <p className="empty">Loading the pipeline…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load the pipeline'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load(owner)}>Try again</button>}
          </p>
        </div>
      )}

      {d && (
        <>
          <div className="pipebar">
            <div className="pipebar__totals">
              <span><strong>{totals.count}</strong> open</span>
              <span><strong>{formatCompactMoney(totals.mrr)}</strong> MRR</span>
              <span className="muted"><strong>{formatCompactMoney(totals.weighted)}</strong> weighted</span>
              <span className="muted"><strong>{formatCompactMoney(totals.annual)}</strong> first-year</span>
            </div>
            <div className="ef ef--narrow">
              <label htmlFor="p-owner">Owner</label>
              <select id="p-owner" value={owner} onChange={e => setOwner(e.target.value)}>
                <option value="">Everyone</option>
                {owners.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          </div>

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {selected && openDeal && (
            <DealEditor
              companyId={openDeal.companyId}
              companyName={openDeal.companyName}
              deal={selected}
              lossReasons={d.lossReasons}
              sources={d.sources}
              products={d.products}
              onSaved={() => load(owner)}
              onDeleted={() => { setOpenDeal(null); setNotice('Deal deleted.'); load(owner) }}
              onClose={() => setOpenDeal(null)}
            />
          )}

          {totals.count === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">No open deals</p>
              <p>
                {owner
                  ? `${owner} has nothing open. Clear the owner filter to see the whole pipeline.`
                  : 'Nothing is being worked right now.'}{' '}
                <Link className="inlink" to="/crm/prospecting">Start one from Prospecting</Link>.
              </p>
            </div>
          ) : (
            <div className="pipe">
              {d.columns.map(col => (
                <section className="pipe__col" key={col.phase} aria-label={col.phase}>
                  <header className="pipe__head">
                    <h2>{col.phase}</h2>
                    <span className="pipe__p">{Math.round(col.probability * 100)}%</span>
                    <span className="pipe__n">{col.count}</span>
                  </header>
                  <p className="pipe__sum">
                    {formatMoney(col.mrr)}
                    <span className="muted"> · {formatMoney(col.weightedMrr)} weighted</span>
                  </p>

                  {col.rows.length === 0 && <p className="pipe__empty">Nothing here</p>}

                  {col.rows.map(deal => (
                    <article
                      className="dcard"
                      key={deal.entryId}
                      data-on={openDeal && openDeal.entryId === deal.entryId ? '' : undefined}
                    >
                      <p className="dcard__title">
                        <span className="dotc" data-c={deal.confidence} title={`${deal.confidence} confidence`} />
                        <button type="button" className="rowlink__btn"
                          onClick={() => setOpenDeal({
                            companyId: deal.companyId, companyName: deal.companyName, entryId: deal.entryId,
                          })}>
                          {deal.title}
                        </button>
                      </p>
                      <p className="dcard__co">
                        <Link className="inlink" to={`/clients/${deal.companyId}`}>{deal.companyName}</Link>
                        {deal.companyState && <span className="muted"> · {deal.companyState}</span>}
                      </p>
                      <p className="dcard__money">
                        <strong>{formatMoney(deal.mrr)}</strong>
                        <span className="muted"> /mo</span>
                        {deal.fees ? <span className="muted"> + {formatMoney(deal.fees)} once</span> : null}
                      </p>
                      {deal.nextStep && <p className="dcard__next">{deal.nextStep}</p>}
                      <p className="dcard__meta">
                        {deal.anticipatedDate
                          ? <span>close {deal.anticipatedDate}</span>
                          : <span className="muted">no close date</span>}
                        {deal.owner && <span className="dot" aria-hidden="true">·</span>}
                        {deal.owner && <span>{deal.owner}</span>}
                      </p>
                      {deal.productList.length > 0 && (
                        <p className="dcard__prods">
                          {deal.productList.map(p => <span className="mark" key={p}>{p}</span>)}
                        </p>
                      )}
                      <div className="dcard__move">
                        <select
                          aria-label={`Move "${deal.title}" to another phase`}
                          value={deal.phase}
                          disabled={busy === deal.entryId}
                          onChange={e => movePhase(deal, e.target.value)}
                        >
                          {OPEN_PHASES.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </div>
                    </article>
                  ))}
                </section>
              ))}
            </div>
          )}

          <p className="panel__foot">
            Walked {d.companiesScanned} compan{d.companiesScanned === 1 ? 'y' : 'ies'} to build this —
            deals are form entries, so there is no global query over them.
          </p>
        </>
      )}
    </section>
  )
}
