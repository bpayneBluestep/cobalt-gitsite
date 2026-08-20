import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, getCrmSummary, formatMoney, formatCompactMoney, formatMonth,
  type CrmSummary,
} from '../api'
import CrmNav from '../components/CrmNav'
import OwnerScope, { ScopeNote, useScope } from '../components/OwnerScope'

/*
 * The CRM dashboard — the sixty-second read.
 *
 * Modelled on beh's CRM Intelligence Dashboard, reduced to what actually gets
 * looked at on a Monday: what the pipeline is worth, what it is worth once
 * weighted, what is closing this month, and who is waiting on a call. beh's twelve
 * analytical pages are the eventual destination; those need months of history to say
 * anything, and there isn't any yet.
 *
 * The whole page is one `crmSummary` call. It all comes from the same single walk of
 * the companies server-side, so totalling it there beats shipping every deal and
 * summing it five times in the browser.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: CrmSummary }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/** A weighted figure is a forecast, not a total — the label has to say which. */
function Kpi({ label, value, note, tone }: {
  label: string; value: string; note?: string; tone?: 'good' | 'warn' | 'bad'
}) {
  return (
    <div className="kpi" data-tone={tone}>
      <p className="kpi__k">{label}</p>
      <p className="kpi__v">{value}</p>
      {note && <p className="kpi__n">{note}</p>}
    </div>
  )
}

export default function CrmDashboard() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  // Mine by default, like every other CRM screen. A dashboard that opens on the whole
  // company is right for exactly one person and wrong for everyone who has to find their
  // own numbers inside it first.
  const [, , ownerId] = useScope()

  const load = useCallback((who: string) => {
    setState({ phase: 'loading' })
    getCrmSummary(who ? { ownerId: who } : {})
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(ownerId) }, [load, ownerId])

  const d = state.phase === 'ready' ? state.data : null
  // The widest open-phase bar sets the scale, so the funnel is readable whatever
  // the absolute numbers are.
  const maxPhaseMrr = d
    ? Math.max(1, ...d.byPhase.filter(p => p.phase !== 'Won' && p.phase !== 'Lost').map(p => p.mrr))
    : 1

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Cobalt</p>
        <h1>CRM</h1>
        <p className="page__sub-text">
          Who we are talking to, what stage they are at, and what happens next.
        </p>
      </header>

      <CrmNav counts={d ? { Pipeline: d.counts.openDeals, Prospecting: d.counts.prospecting } : undefined} />

      {state.phase === 'loading' && <p className="empty">Loading the pipeline…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load the CRM'}
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
              <span><strong>{d.counts.openDeals}</strong> open</span>
              <span><strong>{d.counts.clients}</strong> clients</span>
              <span className="muted"><strong>{d.counts.leads}</strong> leads</span>
            </div>
            <div className="pipebar__tools">
              <OwnerScope />
            </div>
          </div>

          <ScopeNote ownerName={d.owner} />

          <div className="kpis">
            <Kpi
              label="Open pipeline"
              value={formatCompactMoney(d.value.openMrr)}
              note={`${d.counts.openDeals} deal${d.counts.openDeals === 1 ? '' : 's'} · MRR`}
            />
            <Kpi
              label="Weighted forecast"
              value={formatCompactMoney(d.value.weightedMrr)}
              note="MRR × phase probability"
            />
            <Kpi
              label="Billing starts this month"
              value={formatCompactMoney(d.value.billingThisMonthMrr)}
              note={`${d.value.billingThisMonthCount} open deal${d.value.billingThisMonthCount === 1 ? '' : 's'} expected to start billing`}
              tone={d.value.billingThisMonthCount ? 'good' : undefined}
            />
            <Kpi
              label="Win rate"
              value={d.winRate === null ? '—' : `${d.winRate}%`}
              note={d.winRate === null
                ? 'nothing decided yet'
                : `${d.counts.wonDeals} won · ${d.counts.lostDeals} lost`}
            />
            <Kpi
              label="First-year value"
              value={formatCompactMoney(d.value.openAnnualValue)}
              note="open MRR × 12 + one-time fees"
            />
            <Kpi
              label="To prospect"
              value={String(d.counts.prospecting)}
              note={`${d.counts.neverWorked} never worked`}
              tone={d.counts.prospecting ? 'warn' : undefined}
            />
            {/*
              The only figure here about what to DO rather than what things are worth,
              which is why it earns a slot next to the money. Overdue leads the note
              because a follow-up you are already late on is the more urgent fact.
            */}
            <Kpi
              label="Owed today"
              value={String(d.counts.dueToday + d.overdueFollowUps)}
              note={d.overdueFollowUps
                ? `${d.overdueFollowUps} overdue · ${d.counts.dueToday} due today`
                : `${d.counts.dueToday} due today`}
              tone={d.overdueFollowUps ? 'bad' : d.counts.dueToday ? 'warn' : undefined}
            />
          </div>

          {/*
            Pipeline hygiene, separate from the KPIs on purpose: these are not
            achievements or forecasts, they are things that need a person. Hidden entirely
            when there is nothing to say, rather than showing a row of reassuring zeroes.
          */}
          {(d.counts.stuckDeals > 0 || d.counts.staleDeals > 0 || d.counts.neverTouchedDeals > 0) && (
            <p className="pipebar__flags" role="status">
              {d.counts.stuckDeals > 0 && (
                <Link className="flag" to="/crm/pipeline">
                  {d.counts.stuckDeals} sat still {'>'}{d.vocabularies.stalePhaseDays}d
                </Link>
              )}
              {d.counts.staleDeals > 0 && (
                <Link className="flag flag--warn" to="/crm/pipeline">
                  {d.counts.staleDeals} untouched {'>'}{d.vocabularies.staleTouchDays}d
                </Link>
              )}
              {d.counts.neverTouchedDeals > 0 && (
                <Link className="flag flag--quiet" to="/crm/pipeline">
                  {d.counts.neverTouchedDeals} with nothing logged
                </Link>
              )}
            </p>
          )}

          <div className="crmgrid">
            <section className="panel">
              <header className="panel__head">
                <h2>Pipeline by phase</h2>
                <Link className="linkbtn" to="/crm/pipeline">Open the board</Link>
              </header>
              <ul className="funnel">
                {d.byPhase.filter(p => p.phase !== 'Won' && p.phase !== 'Lost').map(p => (
                  <li key={p.phase} className="funnel__row">
                    <span className="funnel__label">
                      {p.phase}
                      <span className="funnel__p">{Math.round(p.probability * 100)}%</span>
                    </span>
                    <span className="funnel__bar">
                      <span
                        className="funnel__fill"
                        style={{ width: `${Math.max(2, (p.mrr / maxPhaseMrr) * 100)}%` }}
                      />
                    </span>
                    <span className="funnel__n">{p.count}</span>
                    <span className="funnel__v">{formatMoney(p.mrr)}</span>
                  </li>
                ))}
              </ul>
              {d.counts.wonDeals + d.counts.lostDeals > 0 && (
                <p className="panel__foot">
                  Decided: {d.counts.wonDeals} won ({formatMoney(d.value.wonMrr)} MRR)
                  {' · '}{d.counts.lostDeals} lost
                </p>
              )}
            </section>

            <section className="panel">
              <header className="panel__head">
                <h2>Follow-ups</h2>
                {d.overdueFollowUps > 0 && (
                  <span className="mark mark--block">{d.overdueFollowUps} overdue</span>
                )}
              </header>
              {d.followUps.length === 0 ? (
                <p className="muted tsec__empty">Nothing scheduled.</p>
              ) : (
                <div className="tablewrap">
                  <table className="fields compact">
                    <thead>
                      <tr>
                        <th scope="col">Due</th>
                        <th scope="col">What</th>
                        <th scope="col">Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/*
                        Keyed on kind + company + entry, not company alone: one company can
                        now raise several follow-ups (a deal each) and a duplicate React key
                        drops all but the first, which reads as missing data.
                      */}
                      {d.followUps.slice(0, 8).map(f => (
                        <tr key={`${f.kind}:${f.companyId}:${f.entryId}`}
                          data-overdue={f.overdue ? '' : undefined}>
                          <td className="nowrap">
                            {f.nextFollowUp}
                            {f.overdue && <span className="tag tag--warn">overdue</span>}
                          </td>
                          <th scope="row">
                            <Link className="inlink"
                              to={f.kind === 'deal' ? `/clients/${f.companyId}/deals` : `/clients/${f.companyId}`}>
                              {f.kind === 'deal' ? f.title : f.companyName}
                            </Link>
                            {f.kind === 'deal'
                              ? <div className="muted">{f.nextStep || f.companyName}</div>
                              : <span className="mark">no deal</span>}
                          </th>
                          <td>{f.owner || <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="panel__foot">
                {d.followUps.length > 8 && <>{d.followUps.length - 8} more scheduled. </>}
                <Link className="inlink" to="/crm/follow-ups">Work the whole queue</Link>
              </p>
            </section>

            <section className="panel panel--wide">
              <header className="panel__head">
                <h2>Closest to closing</h2>
                <span className="panel__note">Open deals, by phase probability then size</span>
              </header>
              {d.hot.length === 0 ? (
                <p className="muted tsec__empty">No open deals.</p>
              ) : (
                <div className="tablewrap">
                  <table className="fields compact">
                    <thead>
                      <tr>
                        <th scope="col">Deal</th>
                        <th scope="col">Company</th>
                        <th scope="col">Phase</th>
                        <th scope="col">MRR</th>
                        <th scope="col">Weighted</th>
                        <th scope="col">Billing</th>
                        <th scope="col">Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.hot.map(deal => (
                        <tr key={deal.entryId}>
                          <th scope="row">
                            <Link className="inlink" to="/crm/pipeline">{deal.title}</Link>
                            <span className="dotc" data-c={deal.confidence} title={`${deal.confidence} confidence`} />
                          </th>
                          <td>{deal.companyName}</td>
                          <td><span className="pill" data-phase={deal.phase.replace(/\s+/g, '')}>{deal.phase}</span></td>
                          <td className="num">{formatMoney(deal.mrr)}</td>
                          <td className="num muted">{formatMoney(deal.weightedMrr)}</td>
                          <td className="nowrap">{formatMonth(deal.firstBillingMonth)}</td>
                          <td>{deal.owner || <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="panel">
              <header className="panel__head"><h2>By owner</h2></header>
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Owner</th>
                      <th scope="col">Open</th>
                      <th scope="col">MRR</th>
                      <th scope="col">Weighted</th>
                      <th scope="col">Won</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.byOwner.map(o => (
                      <tr key={o.owner}>
                        <th scope="row">{o.owner}</th>
                        <td className="num">{o.openDeals}</td>
                        <td className="num">{formatMoney(o.mrr)}</td>
                        <td className="num muted">{formatMoney(o.weightedMrr)}</td>
                        <td className="num">{o.won}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <header className="panel__head">
                <h2>Where they come from</h2>
                <span className="panel__note">All deals, by source</span>
              </header>
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Source</th>
                      <th scope="col">Deals</th>
                      <th scope="col">MRR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.bySource.map(s => (
                      <tr key={s.source}>
                        <th scope="row">{s.source}</th>
                        <td className="num">{s.count}</td>
                        <td className="num">{formatMoney(s.mrr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {d.losses.length > 0 && (
              <section className="panel panel--wide">
                <header className="panel__head">
                  <h2>Why we lose</h2>
                  <span className="panel__note">Closed-lost deals, by reason</span>
                </header>
                <ul className="reasons">
                  {d.losses.map(l => (
                    <li key={l.reason}>
                      <span className="reasons__n">{l.count}</span>
                      <span>{l.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </>
      )}
    </section>
  )
}
