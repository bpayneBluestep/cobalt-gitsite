import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, getClosedDeals, updateDeal, formatMoney, formatCompactMoney,
  type ClosedDeals, type Deal,
} from '../api'
import CrmNav from '../components/CrmNav'
import DealEditor from '../components/DealEditor'
import OwnerScope, { ScopeNote, useScope } from '../components/OwnerScope'
import { useSession } from '../session'

/*
 * Won and lost — the deals that are over.
 *
 * Off the pipeline board on purpose, and it is not just tidiness. The board is a
 * forecast, so a won deal sitting in it overstates what is still to come and a lost one
 * is pure noise. But they are also the only record of what actually happened, and a
 * pipeline that quietly swallows them means nobody ever reviews a loss.
 *
 * So: a log. Newest close first, with the win rate and the loss reasons counted over
 * exactly the rows on screen — filter to one rep and the breakdown follows, which is how
 * "why do my deals die" becomes a question you can answer without a separate report.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: ClosedDeals }
  | { phase: 'error'; error: ApiError }

type Tab = '' | 'Won' | 'Lost'

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

const TABS: { key: Tab; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'Won', label: 'Won' },
  { key: 'Lost', label: 'Lost' },
]

export default function CrmClosed() {
  const { can } = useSession()
  const maySeeMoney = can('viewMoney')

  const [, , ownerId] = useScope()
  const [tab, setTab] = useState<Tab>('')
  const [search, setSearch] = useState('')
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [openDeal, setOpenDeal] = useState<{ companyId: string; companyName: string; entryId: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState('')
  const mayEdit = can('editDeals')

  const load = useCallback((who: string, outcome: Tab) => {
    setState({ phase: 'loading' })
    getClosedDeals({
      ...(who ? { ownerId: who } : {}),
      ...(outcome ? { outcome } : {}),
    })
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(ownerId, tab) }, [load, ownerId, tab])

  const d = state.phase === 'ready' ? state.data : null

  /*
   * Filtered here rather than server-side, for the same reason as the pipeline: the whole
   * result set already arrived, and a round trip per keystroke would re-walk every
   * company to answer something the browser has in hand.
   */
  const rows = useMemo(() => {
    if (!d) return []
    const q = search.trim().toLowerCase()
    if (!q) return d.rows
    return d.rows.filter(deal =>
      [deal.title, deal.companyName, deal.owner, deal.lossReason]
        .some(v => String(v || '').toLowerCase().includes(q)))
  }, [d, search])

  const selected: Deal | null = useMemo(() => {
    if (!d || !openDeal) return null
    return d.rows.find(deal => deal.entryId === openDeal.entryId) || null
  }, [d, openDeal])

  /**
   * Tick the box the phase already implies.
   *
   * The phase is left exactly as it is — that is the whole point of keeping phase and
   * closed separate: a deal lost at Negotiating should still say Negotiating. All this
   * does is record that it is over, which stamps the close date and takes it out of the
   * forecast.
   */
  function markClosed(deal: Deal) {
    if (busy || !mayEdit) return
    setBusy(deal.entryId); setFailure(''); setNotice('')
    updateDeal(deal.companyId, deal.entryId, { closed: 'true' })
      .then(() => { setNotice(`${deal.title} marked closed.`); load(ownerId, tab) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">CRM</p>
        <h1>Won &amp; lost</h1>
        <p className="page__sub-text">
          Deals that are over, newest first. The win rate and the reasons below are counted
          over what is showing — narrow it to one person and they follow.
        </p>
      </header>

      <CrmNav counts={d ? { 'Won & lost': d.total } : undefined} />

      {state.phase === 'loading' && <p className="empty">Loading closed deals…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load closed deals'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load(ownerId, tab)}>Try again</button>}
          </p>
        </div>
      )}

      {d && (
        <>
          <div className="pipebar">
            <div className="pipebar__totals">
              <span><strong>{d.wonCount}</strong> won</span>
              <span><strong>{d.lostCount}</strong> lost</span>
              <span className="muted">
                <strong>{d.winRate === null ? '—' : `${d.winRate}%`}</strong> win rate
              </span>
              <span className="muted">
                <strong>{formatCompactMoney(maySeeMoney ? d.wonMrr : null)}</strong> won MRR
              </span>
            </div>
            <div className="pipebar__tools">
              <div className="ef ef--narrow">
                <label htmlFor="c-search">Search</label>
                <input id="c-search" type="search" value={search} autoComplete="off"
                  placeholder="Company, deal, reason…"
                  onChange={e => setSearch(e.target.value)} />
              </div>
              <OwnerScope />
            </div>
          </div>

          <ScopeNote ownerName={d.owner} />

          <div className="stage" role="group" aria-label="Outcome">
            {TABS.map(t => (
              <button
                key={t.key || 'all'}
                type="button"
                className="filter"
                data-on={tab === t.key ? '' : undefined}
                aria-pressed={tab === t.key}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                {t.key === 'Won' && <span className="filter__n">{d.wonCount}</span>}
                {t.key === 'Lost' && <span className="filter__n">{d.lostCount}</span>}
              </button>
            ))}
          </div>

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {/*
            The strays the pipeline sends people here to fix. Named at the top rather than
            left to be noticed row by row, because the reason they matter is collective:
            twenty deals that are over are still being forecast.
          */}
          {d.needsClosingCount > 0 && (
            <p className="board2__notice" role="status">
              {d.needsClosingCount} deal{d.needsClosingCount === 1 ? '' : 's'} below reached an
              outcome but {d.needsClosingCount === 1 ? 'was' : 'were'} never marked closed, so
              {d.needsClosingCount === 1 ? ' it is' : ' they are'} still counted in the pipeline
              forecast and {d.needsClosingCount === 1 ? 'does' : 'do'} not appear on the board.
              {mayEdit ? ' Tick the outcome to take them out.' : ''} They are left out of the win
              rate above, because a phase is not a recorded outcome.
              {mayEdit && (
                <>
                  {' '}
                  <strong>Note:</strong> that stamps the close date as today, which is right for
                  a deal closing now and wrong for one that was really won months ago — so it will
                  skew how long those look like they took. Set the date on the record itself if the
                  real one matters.
                </>
              )}
            </p>
          )}

          {selected && openDeal && (
            <DealEditor
              companyId={openDeal.companyId}
              companyName={openDeal.companyName}
              deal={selected}
              lossReasons={d.lossReasons}
              sources={[]}
              onSaved={() => load(ownerId, tab)}
              onDeleted={() => { setOpenDeal(null); setNotice('Deal deleted.'); load(ownerId, tab) }}
              onClose={() => setOpenDeal(null)}
            />
          )}

          {/* Why we lose, over the filtered set. Only when there is something to explain. */}
          {d.byReason.length > 0 && tab !== 'Won' && (
            <section className="panel">
              <header className="panel__head"><h2>Why they were lost</h2></header>
              <ul className="reasons">
                {d.byReason.map(r => (
                  <li key={r.reason}>
                    <span className="reasons__n">{r.count}</span>
                    <span>{r.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {rows.length === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">Nothing here</p>
              <p>
                {search
                  ? <>No closed deal matches “{search}”.{' '}
                      <button type="button" className="linkbtn" onClick={() => setSearch('')}>Clear the search</button>.</>
                  : 'No deal has been won or lost in this view yet.'}
              </p>
            </div>
          ) : (
            <div className="tablewrap">
              <table className="fields">
                <thead>
                  <tr>
                    <th scope="col">Deal</th>
                    <th scope="col">Company</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Closed</th>
                    <th scope="col">MRR</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Took</th>
                    {mayEdit && d.needsClosingCount > 0 && (
                      <th scope="col"><span className="visually-hidden">Fix</span></th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(deal => (
                    <tr key={deal.entryId}>
                      <th scope="row">
                        <button type="button" className="rowlink__btn"
                          onClick={() => setOpenDeal({
                            companyId: deal.companyId, companyName: deal.companyName, entryId: deal.entryId,
                          })}>
                          {deal.title}
                        </button>
                      </th>
                      <td>
                        <Link className="inlink" to={`/clients/${deal.companyId}`}>{deal.companyName}</Link>
                      </td>
                      <td>
                        <span className="pill"
                          data-out={(deal.isWon || deal.impliedOutcome === 'Won') ? 'won' : 'lost'}>
                          {deal.isWon ? 'Won' : deal.isLost ? 'Lost' : deal.impliedOutcome}
                        </span>
                        {deal.needsClosing && (
                          <span className="tag tag--warn">not marked closed</span>
                        )}
                        {/*
                          The phase a lost deal reached is the interesting part — losing at
                          Agreements is a very different story from losing at Contact Made,
                          and it is exactly what a single "Lost" status would erase.
                        */}
                        {deal.isLost && deal.phase !== 'Lost' && (
                          <span className="muted"> at {deal.phase}</span>
                        )}
                        {deal.isLost && deal.lossReason && (
                          <div className="muted">{deal.lossReason}</div>
                        )}
                      </td>
                      <td className="nowrap">{deal.closedAt || <span className="muted">—</span>}</td>
                      <td className="num">{formatMoney(deal.mrr)}</td>
                      <td>{deal.owner || <span className="muted">unowned</span>}</td>
                      <td className="nowrap">
                        {deal.ageDays === null
                          ? <span className="muted">—</span>
                          : `${deal.ageDays}d`}
                      </td>
                      {mayEdit && d.needsClosingCount > 0 && (
                        <td className="nowrap">
                          {deal.needsClosing && (
                            <button type="button" className="linkbtn" disabled={busy === deal.entryId}
                              onClick={() => markClosed(deal)}
                              title="Record that this deal is over. The phase it reached is left alone; the close date is stamped as today.">
                              {busy === deal.entryId ? 'Saving…' : 'Mark closed'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="panel__foot">
            Walked {d.companiesScanned} compan{d.companiesScanned === 1 ? 'y' : 'ies'} to build this.
            {rows.length !== d.total && ` Showing ${rows.length} of ${d.total}.`}
          </p>
        </>
      )}
    </section>
  )
}
