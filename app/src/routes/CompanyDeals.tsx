import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError, getDeals, formatMoney, formatMonth,
  type Deal,
} from '../api'
import DealEditor from '../components/DealEditor'
import { useRecord } from './CompanyRecord'
import { useSession } from '../session'

/*
 * The Deals tab of a company record.
 *
 * On every company, lead and client alike. A lead's deals are the reason it is a lead;
 * a client's deals are upsells, which is where most revenue growth actually comes from
 * and which had nowhere to live — the only way to see a client's deals was to find them
 * on the pipeline board among everyone else's.
 *
 * Open deals first, then decided ones, because the open ones are the work. Both are
 * here rather than on separate tabs: on a single company there are a handful of each,
 * and the history is the context you want while looking at what is live.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: Deal[]; lossReasons: string[]; sources: string[] }
  | { phase: 'error'; error: ApiError }

/** One row. Compact, because a company usually has few and they are all in view. */
function DealRow({ deal, onOpen }: { deal: Deal; onOpen: () => void }) {
  return (
    <li className="cdeal" data-open={deal.isOpen ? '' : undefined}>
      <div className="cdeal__main">
        <p className="cdeal__title">
          <span className="dotc" data-c={deal.confidence} title={`${deal.confidence} confidence`} />
          <button type="button" className="rowlink__btn" onClick={onOpen}>{deal.title}</button>
        </p>
        <p className="cdeal__meta">
          {deal.isOpen ? (
            <span className="pill">{deal.phase}</span>
          ) : (
            <span className="pill" data-out={deal.isWon ? 'won' : 'lost'}>
              {deal.isWon ? 'Won' : 'Lost'}
              {deal.isLost && deal.phase !== 'Lost' ? ` at ${deal.phase}` : ''}
            </span>
          )}
          <span className="dot" aria-hidden="true">·</span>
          <span>{formatMoney(deal.mrr)}<span className="muted">/mo</span></span>
          {deal.firstBillingMonth && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span>bills {formatMonth(deal.firstBillingMonth)}</span>
            </>
          )}
          <span className="dot" aria-hidden="true">·</span>
          <span>{deal.owner || <span className="muted">unowned</span>}</span>
        </p>
      </div>

      <div className="cdeal__side">
        {deal.isOpen && deal.phaseAgeDays !== null && (
          <span className="dchip" data-stuck={deal.stuck ? '' : undefined}>
            {deal.phaseSinceEstimated ? '≥' : ''}{deal.phaseAgeDays}d here
          </span>
        )}
        {deal.isOpen && deal.followUpState === 'overdue' && (
          <span className="dchip dchip--bad">{Math.abs(deal.followUpInDays || 0)}d overdue</span>
        )}
        {deal.isOpen && deal.followUpState === 'today' && (
          <span className="dchip dchip--warn">due today</span>
        )}
        {deal.isOpen && deal.followUpState === 'none' && (
          <span className="dchip dchip--quiet">no next step</span>
        )}
        {!deal.isOpen && deal.closedAt && (
          <span className="dchip dchip--quiet">closed {deal.closedAt}</span>
        )}
        {deal.activityCount > 0 && (
          <span className="dchip dchip--quiet">{deal.activityCount} logged</span>
        )}
      </div>
    </li>
  )
}

export default function CompanyDeals() {
  const { company } = useRecord()
  const id = company.id
  const { can } = useSession()
  const mayEdit = can('editDeals')

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [openId, setOpenId] = useState('')
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getDeals({ companyId: id })
      .then(data => setState({
        phase: 'ready',
        rows: data.rows,
        lossReasons: data.lossReasons || [],
        sources: data.sources || [],
      }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [id])

  useEffect(load, [load])

  const rows = state.phase === 'ready' ? state.rows : []
  const open = useMemo(() => rows.filter(d => d.isOpen), [rows])
  const closed = useMemo(() => rows.filter(d => !d.isOpen), [rows])
  const selected = useMemo(() => rows.find(d => d.entryId === openId) || null, [rows, openId])

  return (
    <>
      {state.phase === 'loading' && <p className="empty">Loading deals…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load this company’s deals'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            <button type="button" className="btn" onClick={load}>Try again</button>
          </p>
        </div>
      )}

      {state.phase === 'ready' && (
        <>
          {notice && <p className="board2__notice" role="status">{notice}</p>}

          {creating && (
            <DealEditor
              companyId={id}
              companyName={company.name}
              deal={null}
              lossReasons={state.lossReasons}
              sources={state.sources}
              onSaved={() => { setNotice('Deal created.'); load() }}
              onDeleted={() => { setCreating(false); load() }}
              onClose={() => setCreating(false)}
            />
          )}

          {selected && (
            <DealEditor
              companyId={id}
              companyName={company.name}
              deal={selected}
              lossReasons={state.lossReasons}
              sources={state.sources}
              onSaved={load}
              onDeleted={() => { setOpenId(''); setNotice('Deal deleted.'); load() }}
              onClose={() => setOpenId('')}
            />
          )}

          <section className="panel">
            <header className="panel__head">
              <h2>Open</h2>
              <span className="panel__n">{open.length}</span>
              {mayEdit && !creating && (
                <button type="button" className="btn btn--sm" onClick={() => { setOpenId(''); setCreating(true) }}>
                  New deal
                </button>
              )}
            </header>

            {open.length === 0 ? (
              <p className="empty">
                Nothing open here.{' '}
                {mayEdit
                  ? 'An upsell to an existing client is a deal like any other — open one.'
                  : 'Only Leadership and Sales can open a deal.'}
              </p>
            ) : (
              <ul className="cdeals">
                {open.map(deal => (
                  <DealRow key={deal.entryId} deal={deal}
                    onOpen={() => { setCreating(false); setOpenId(deal.entryId) }} />
                ))}
              </ul>
            )}
          </section>

          {closed.length > 0 && (
            <section className="panel">
              <header className="panel__head">
                <h2>Decided</h2>
                <span className="panel__n">{closed.length}</span>
              </header>
              <ul className="cdeals">
                {closed.map(deal => (
                  <DealRow key={deal.entryId} deal={deal}
                    onOpen={() => { setCreating(false); setOpenId(deal.entryId) }} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  )
}
