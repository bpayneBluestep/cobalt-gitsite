import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, getPipeline, updateDeal, formatMoney, formatCompactMoney, formatMonth,
  OPEN_PHASES, type Deal, type Pipeline, type PipelineColumn,
} from '../api'
import CrmNav from '../components/CrmNav'
import DealEditor from '../components/DealEditor'
import OwnerScope, { ScopeNote, useScope } from '../components/OwnerScope'
import { useSession } from '../session'

/*
 * The pipeline board — one column per open phase.
 *
 * Columns rather than a table because a phase is a position, and position is what a
 * board shows and a table hides. Each column carries its own count, MRR and weighted
 * MRR, so the shape of the pipeline is legible without adding anything up.
 *
 * Phase moves two ways, and both are deliberate. Dragging is what people reach for and
 * it makes the board feel like a board. The select stays because dragging is the part
 * that breaks: it does not work from a keyboard, it is awkward on a touch screen, and it
 * gives no help to a screen reader. Keeping both costs one small control per card and
 * means nobody is locked out of the primary action on the page.
 *
 * Closed deals are excluded: this is a forecast, and mixing history into it overstates
 * it. Won and lost have their own page.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: Pipeline }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/**
 * Recompute a column's totals from the rows it now holds.
 *
 * Correct rather than approximate, and cheap: every deal in a column shares that
 * column's probability, so the weighted figure is just the column's MRR times it — which
 * is exactly what the server would return. A redacted column (money hidden for this
 * role) stays entirely null; summing zeros there would invent a total of nothing.
 */
function recount(col: PipelineColumn): PipelineColumn {
  const redacted = col.mrr === null
  if (redacted) return { ...col, count: col.rows.length }

  let mrr = 0
  let annual = 0
  for (const d of col.rows) {
    mrr += d.mrr === null ? 0 : d.mrr
    annual += d.annualValue === null ? 0 : d.annualValue
  }
  return {
    ...col,
    count: col.rows.length,
    mrr,
    annualValue: annual,
    weightedMrr: mrr * col.probability,
  }
}

/**
 * Move a deal between columns without waiting for the server.
 *
 * The card has to land where it was dropped immediately or the drag feels broken. The
 * server is still the authority — the reply replaces this — but a board that visibly
 * snaps back and then forward again reads as a bug even when it worked.
 */
function moveLocally(data: Pipeline, deal: Deal, toPhase: string): Pipeline {
  const columns = data.columns.map(col => {
    if (col.phase === deal.phase) {
      return recount({ ...col, rows: col.rows.filter(d => d.entryId !== deal.entryId) })
    }
    if (col.phase === toPhase) {
      const moved: Deal = {
        ...deal,
        phase: toPhase,
        probability: col.probability,
        // Phase age restarts the moment it moves, which is the whole point of the field.
        phaseAgeDays: 0,
        phaseSinceEstimated: false,
        stuck: false,
        weightedMrr: deal.mrr === null ? null as unknown as number : deal.mrr * col.probability,
      }
      return recount({ ...col, rows: [...col.rows, moved] })
    }
    return col
  })
  return { ...data, columns }
}

export default function CrmPipeline() {
  // Sales and Leadership move deals; Accounting and Client Success only watch. Reading
  // the pipeline without being able to nudge it is a legitimate position to be in.
  const { can } = useSession()
  const mayEdit = can('editDeals')
  // Revenue is stripped server-side for anyone without this, so every figure on the page
  // arrives null and renders as a dash. Say why once, rather than leaving a board of
  // dashes that reads like broken data.
  const maySeeMoney = can('viewMoney')

  const [, , ownerId] = useScope()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [search, setSearch] = useState('')
  const [openDeal, setOpenDeal] = useState<{ companyId: string; companyName: string; entryId: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  // Drag state: the deal being carried, and the column under the cursor.
  const [dragging, setDragging] = useState<Deal | null>(null)
  const [over, setOver] = useState('')

  const load = useCallback((who: string) => {
    setState({ phase: 'loading' })
    getPipeline(who ? { ownerId: who } : {})
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(ownerId) }, [load, ownerId])

  const d = state.phase === 'ready' ? state.data : null

  /*
   * Search filters what is already loaded rather than asking the server again.
   *
   * The open pipeline is tens of deals, not thousands — it all arrived in one call. A
   * round trip per keystroke would make typing feel worse and would re-walk every
   * company server-side to answer a question the browser can already answer instantly.
   */
  const shown: Pipeline | null = useMemo(() => {
    if (!d) return null
    const q = search.trim().toLowerCase()
    if (!q) return d
    const hit = (deal: Deal) =>
      [deal.title, deal.companyName, deal.owner, deal.nextStep]
        .some(v => String(v || '').toLowerCase().includes(q))
    return {
      ...d,
      columns: d.columns.map(col => recount({ ...col, rows: col.rows.filter(hit) })),
    }
  }, [d, search])

  const totals = useMemo(() => {
    if (!shown) return { count: 0, mrr: 0, weighted: 0, annual: 0 }
    return shown.columns.reduce((acc, c) => ({
      count: acc.count + c.count,
      mrr: acc.mrr + (c.mrr || 0),
      weighted: acc.weighted + (c.weightedMrr || 0),
      annual: acc.annual + (c.annualValue || 0),
    }), { count: 0, mrr: 0, weighted: 0, annual: 0 })
  }, [shown])

  const selected: Deal | null = useMemo(() => {
    if (!d || !openDeal) return null
    for (const col of d.columns) {
      for (const deal of col.rows) if (deal.entryId === openDeal.entryId) return deal
    }
    return null
  }, [d, openDeal])

  /** Move a deal's phase — from the select, or from a drop. */
  const movePhase = useCallback((deal: Deal, phase: string) => {
    if (busy || !mayEdit || phase === deal.phase) return
    setBusy(deal.entryId); setFailure(''); setNotice('')

    // Land it where it was put, then let the server's reply be the truth.
    setState(s => (s.phase === 'ready' ? { phase: 'ready', data: moveLocally(s.data, deal, phase) } : s))

    updateDeal(deal.companyId, deal.entryId, { phase })
      .then(() => {
        setNotice(`${deal.title} → ${phase}.`)
        // Re-read rather than trust the optimistic copy: the move also restarts the
        // deal's phase clock and may have cleared a follow-up, and the totals across
        // every column shift with it.
        load(ownerId)
      })
      .catch(err => {
        setFailure(err instanceof ApiError ? err.message : String(err))
        // Put the board back to what the server actually holds.
        load(ownerId)
      })
      .finally(() => setBusy(''))
  }, [busy, mayEdit, load, ownerId])

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">CRM</p>
        <h1>Pipeline</h1>
        <p className="page__sub-text">
          Open deals by phase. Weighted figures are MRR × the phase’s probability —
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
              : <button type="button" className="btn" onClick={() => load(ownerId)}>Try again</button>}
          </p>
        </div>
      )}

      {d && shown && (
        <>
          <div className="pipebar">
            <div className="pipebar__totals">
              <span><strong>{totals.count}</strong> open</span>
              <span><strong>{formatCompactMoney(maySeeMoney ? totals.mrr : null)}</strong> MRR</span>
              <span className="muted"><strong>{formatCompactMoney(maySeeMoney ? totals.weighted : null)}</strong> weighted</span>
              <span className="muted"><strong>{formatCompactMoney(maySeeMoney ? totals.annual : null)}</strong> first-year</span>
            </div>
            <div className="pipebar__tools">
              <div className="ef ef--narrow">
                <label htmlFor="p-search">Search</label>
                <input id="p-search" type="search" value={search} autoComplete="off"
                  placeholder="Company, deal, next step…"
                  onChange={e => setSearch(e.target.value)} />
              </div>
              <OwnerScope />
            </div>
          </div>

          <ScopeNote ownerName={d.owner} />

          {/* Hygiene, counted server-side over the whole scope rather than the search. */}
          {(d.overdueTotal > 0 || d.dueTodayTotal > 0 || d.stuckTotal > 0) && (
            <p className="pipebar__flags" role="status">
              {d.overdueTotal > 0 && <span className="flag flag--bad">{d.overdueTotal} overdue</span>}
              {d.dueTodayTotal > 0 && <span className="flag flag--warn">{d.dueTodayTotal} due today</span>}
              {d.stuckTotal > 0 && (
                <span className="flag">{d.stuckTotal} sat still {'>'}{d.stalePhaseDays}d</span>
              )}
              {d.neverTouchedTotal > 0 && (
                <span className="flag flag--quiet">{d.neverTouchedTotal} with nothing logged</span>
              )}
            </p>
          )}

          {/*
            Named rather than quietly excluded. These deals are not closed, so they are
            still in every forecast, and they are invisible on the board — the worst of
            both. Saying so is the only way anyone fixes them.
          */}
          {d.unplacedTotal > 0 && (
            <p className="board2__notice" role="status">
              {d.unplacedTotal} deal{d.unplacedTotal === 1 ? '' : 's'} sit{d.unplacedTotal === 1 ? 's' : ''} at{' '}
              {d.unplacedPhases.map(p => `${p.phase} (${p.count})`).join(', ')} without being
              marked closed, so {d.unplacedTotal === 1 ? 'it has' : 'they have'} no column here —
              and {d.unplacedTotal === 1 ? 'is' : 'are'} still counted in the forecast. Open{' '}
              {d.unplacedTotal === 1 ? 'it' : 'them'} from{' '}
              <Link className="inlink" to="/crm/closed">Won &amp; lost</Link> and tick the outcome.
            </p>
          )}

          {!maySeeMoney && (
            <p className="board2__notice" role="status">
              Deal values are hidden — showing revenue needs Sales or Accounting. Everything
              else on this board is what you would normally see.
            </p>
          )}

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {selected && openDeal && (
            <DealEditor
              companyId={openDeal.companyId}
              companyName={openDeal.companyName}
              deal={selected}
              lossReasons={d.lossReasons}
              sources={d.sources}
              onSaved={() => load(ownerId)}
              onDeleted={() => { setOpenDeal(null); setNotice('Deal deleted.'); load(ownerId) }}
              onClose={() => setOpenDeal(null)}
            />
          )}

          {totals.count === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">
                {search ? 'Nothing matches that' : 'No open deals'}
              </p>
              <p>
                {search
                  ? <>Nothing in this pipeline matches “{search}”.{' '}
                      <button type="button" className="linkbtn" onClick={() => setSearch('')}>Clear the search</button>.</>
                  : <>Nothing is being worked right now.{' '}
                      <Link className="inlink" to="/crm/prospecting">Start one from Prospecting</Link>.</>}
              </p>
            </div>
          ) : (
            <div className="pipe">
              {shown.columns.map(col => (
                <section
                  className="pipe__col"
                  key={col.phase}
                  aria-label={col.phase}
                  data-over={over === col.phase && dragging && dragging.phase !== col.phase ? '' : undefined}
                  onDragOver={e => {
                    if (!dragging || !mayEdit) return
                    // Without preventDefault the browser refuses the drop entirely.
                    e.preventDefault()
                    if (over !== col.phase) setOver(col.phase)
                  }}
                  onDragLeave={() => setOver(o => (o === col.phase ? '' : o))}
                  onDrop={e => {
                    e.preventDefault()
                    setOver('')
                    const carried = dragging
                    setDragging(null)
                    if (carried) movePhase(carried, col.phase)
                  }}
                >
                  <header className="pipe__head">
                    <h2>{col.phase}</h2>
                    <span className="pipe__p">{Math.round(col.probability * 100)}%</span>
                    <span className="pipe__n">{col.count}</span>
                  </header>
                  <p className="pipe__sum">
                    {formatMoney(col.mrr)}
                    <span className="muted"> · {formatMoney(col.weightedMrr)} weighted</span>
                  </p>

                  {col.rows.length === 0 && (
                    <p className="pipe__empty">
                      {dragging && dragging.phase !== col.phase ? 'Drop here' : 'Nothing here'}
                    </p>
                  )}

                  {col.rows.map(deal => (
                    <article
                      className="dcard"
                      key={deal.entryId}
                      draggable={mayEdit && !busy}
                      data-on={openDeal && openDeal.entryId === deal.entryId ? '' : undefined}
                      data-drag={dragging && dragging.entryId === deal.entryId ? '' : undefined}
                      data-busy={busy === deal.entryId ? '' : undefined}
                      onDragStart={e => {
                        if (!mayEdit) return
                        setDragging(deal)
                        // Some browsers cancel a drag with no payload attached.
                        e.dataTransfer.setData('text/plain', deal.entryId)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => { setDragging(null); setOver('') }}
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

                      {/*
                        Age on the card, because "is this moving" is the question a board
                        is for and the dates alone do not answer it. `≥` when the phase
                        entry date is the deal's open date — either it never moved or the
                        entry predates the field, and both are honestly "at least".
                      */}
                      <p className="dcard__age">
                        {deal.phaseAgeDays !== null && (
                          <span className="dchip" data-stuck={deal.stuck ? '' : undefined}
                            title={`In ${deal.phase} since ${deal.phaseSince || deal.createdAt || 'unknown'}`}>
                            {deal.phaseSinceEstimated ? '≥' : ''}{deal.phaseAgeDays}d here
                          </span>
                        )}
                        {deal.followUpState === 'overdue' && (
                          <span className="dchip dchip--bad" title={deal.nextStep || 'Follow-up overdue'}>
                            {Math.abs(deal.followUpInDays || 0)}d overdue
                          </span>
                        )}
                        {deal.followUpState === 'today' && (
                          <span className="dchip dchip--warn" title={deal.nextStep || 'Follow-up due today'}>
                            due today
                          </span>
                        )}
                        {deal.followUpState === 'scheduled' && (
                          <span className="dchip dchip--ok" title={deal.nextStep || 'Follow-up scheduled'}>
                            in {deal.followUpInDays}d
                          </span>
                        )}
                        {deal.followUpState === 'none' && (
                          <span className="dchip dchip--quiet" title="No follow-up scheduled">no next step</span>
                        )}
                        {deal.activityCount > 0 && (
                          <span className="dchip dchip--quiet" title="Logged calls, emails and notes">
                            {deal.activityCount} logged
                          </span>
                        )}
                      </p>

                      <p className="dcard__meta">
                        {deal.firstBillingMonth
                          ? <span>bills {formatMonth(deal.firstBillingMonth)}</span>
                          : <span className="muted">no billing month</span>}
                        {deal.owner && <span className="dot" aria-hidden="true">·</span>}
                        {deal.owner
                          ? <span>{deal.owner}</span>
                          : <span className="muted">unowned</span>}
                      </p>
                      <div className="dcard__move">
                        {/*
                          The accessible route to the same move as a drag. Not a fallback
                          for a broken feature — a keyboard user has no other way to do
                          the primary action on this page.
                        */}
                        <select
                          aria-label={`Move "${deal.title}" to another phase`}
                          value={deal.phase}
                          disabled={busy === deal.entryId || !mayEdit}
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
            {mayEdit && ' Drag a card between columns, or use the select on it.'}
          </p>
        </>
      )}
    </section>
  )
}
