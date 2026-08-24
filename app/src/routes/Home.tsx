import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, completeFollowUp, getHome, stopTimer, updateCompany, formatMoney,
  type Home as HomeData, type HomeTicket, type OwedItem,
} from '../api'
import { useSession } from '../session'
import { greeting } from '../lib/greeting'
import { todayISO, whenLabel } from '../lib/time'

/*
 * Home: what today asks of you.
 *
 * An inbox, not a dashboard. The CRM already has a dashboard and Reports will be more of
 * one; if this page grows charts and company totals it becomes a worse copy of a page that
 * exists. So there are no charts here, no company-wide figures and no trends: every line
 * is something to act on, and most of them can be acted on without leaving.
 *
 * Three things this page does deliberately:
 *
 *   1. **It composes itself from what you have, not the role you hold.** Every block
 *      renders only when its list has something in it. An engineer owns no deals, so the
 *      deals block is absent; Accounting owns no tickets, so that one is. Six roles, one
 *      layout, no role checks, and it stays right for someone holding several.
 *
 *   2. **It can be empty, and empty reads as success.** "Nothing owed" is a real answer
 *      and the page is allowed to be short. A page that always looks busy gets ignored
 *      inside a week, and then the one day it matters nobody is looking.
 *
 *   3. **One column, not a grid.** A grid invites scanning; a column says work down this.
 *      Urgency at the top, decaying downward.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: HomeData }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/** "2h 15m": how long a timer has been running. */
function mins(total: number): string {
  const n = Math.max(0, Math.round(total))
  if (n < 60) return `${n}m`
  const h = Math.floor(n / 60)
  const m = n % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** Where a line of the urgency list goes when you click it. */
function owedHref(o: OwedItem): string {
  if (o.kind === 'ticket') return `/tickets/${o.entryId}`
  if (o.kind === 'deal') return `/clients/${o.companyId}/deals`
  return `/clients/${o.companyId}`
}

function TicketLine({ t }: { t: HomeTicket }) {
  const today = todayISO()
  const late = !!t.dueDate && t.dueDate < today
  return (
    <li className="hrow">
      <div className="hrow__main">
        <p className="hrow__title">
          <Link className="inlink" to={`/tickets/${t.entryId}`}>
            {t.ticketNumber ? <span className="hrow__num">#{t.ticketNumber}</span> : null}
            {t.title}
          </Link>
          {t.roadblocked && <span className="tag tag--warn">blocked</span>}
        </p>
        <p className="hrow__meta">
          {t.clientId
            ? <Link className="inlink" to={`/clients/${t.clientId}`}>{t.clientName}</Link>
            : <span className="muted">{t.clientName || 'No client'}</span>}
          {t.priority && <><span className="dot" aria-hidden="true">·</span><span>{t.priority}</span></>}
          {t.sprint && <><span className="dot" aria-hidden="true">·</span><span>sprint {t.sprint}</span></>}
          {t.dueDate && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span className={late ? 'bad' : undefined}>due {t.dueDate}</span>
            </>
          )}
          {t.subtaskCount > 0 && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span>{t.subtaskDone}/{t.subtaskCount} subtasks</span>
            </>
          )}
        </p>
      </div>
    </li>
  )
}

export default function Home() {
  const { session, can } = useSession()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getHome()
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(load, [load])

  const d = state.phase === 'ready' ? state.data : null

  function run(id: string, work: Promise<unknown>, said: string) {
    setBusy(id); setFailure(''); setNotice('')
    work
      .then(() => { setNotice(said); load() })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  /*
   * Clearing a line without leaving the page. The follow-up queue proved this pattern
   * works: a list you have to navigate away from to act on is a list people stop
   * working, so Home inherits it.
   */
  function clear(o: OwedItem) {
    const id = `${o.kind}:${o.entryId || o.companyId}`
    if (o.kind === 'deal') {
      run(id, completeFollowUp(o.companyId!, o.entryId, {}), `${o.title}: done.`)
      return
    }
    if (o.kind === 'prospect') {
      // A prospect has no deal to log against, so "done" is the pair of writes
      // Prospecting makes: touched today, nothing scheduled next.
      run(id, updateCompany(o.companyId!, { lastTouch: todayISO(), nextFollowUp: '' }),
        `${o.title}: marked touched.`)
      return
    }
    // A ticket is not "done" from here. That is a status change with consequences, and
    // guessing at it from an inbox is exactly the sort of shortcut that loses work.
  }

  const firstName = (session?.fullName || '').split(/[,\s]+/).filter(Boolean)[0] || ''

  /*
   * Nothing pointed at this person at all: as opposed to nothing pointed at them TODAY.
   * The two need different words in both places they appear, or the headline reassures
   * while the panel below it says the opposite.
   */
  const nothingAssigned = !!d && d.counts.openTickets === 0 && d.counts.openDeals === 0
    && d.counts.quiet === 0 && d.counts.blocked === 0 && d.counts.owed === 0

  return (
    <section className="page home">
      <header className="page__head">
        <p className="eyebrow">Cobalt</p>
        <h1>{greeting(firstName)}</h1>
        {d && (
          <p
            className="home__headline"
            data-tone={d.counts.overdue ? 'bad' : d.counts.owed ? 'warn' : nothingAssigned ? 'none' : 'ok'}
          >
            {nothingAssigned ? 'Nothing assigned yet' : d.headline}
          </p>
        )}
      </header>

      {state.phase === 'loading' && <p className="empty">Working out what today looks like…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not build your day'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
          </p>
        </div>
      )}

      {d && (
        <>
          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {/* ── a running timer ─────────────────────────────────────────── */}
          {d.timer && (
            <section className="htimer" data-warn={d.timer.probablyForgotten ? '' : undefined}>
              <div className="htimer__main">
                <p className="htimer__label">
                  {d.timer.probablyForgotten ? 'Timer still running' : 'Timer running'}
                </p>
                <p className="htimer__title">
                  <Link className="inlink" to={`/tickets/${d.timer.entryId}`}>{d.timer.title}</Link>
                  {d.timer.clientName && <span className="muted"> · {d.timer.clientName}</span>}
                </p>
                {d.timer.probablyForgotten && (
                  <p className="htimer__note">
                    Started {whenLabel(d.timer.startedAt)}. If that is not right, stop it before
                    it lands in this week’s hours.
                  </p>
                )}
              </div>
              <div className="htimer__end">
                <span className="htimer__clock">{mins(d.timer.elapsedMinutes)}</span>
                {can('editTickets') && (
                  <button type="button" className="btn btn--sm" disabled={!!busy}
                    onClick={() => run('timer', stopTimer({ listId: d.timer!.listId, entryId: d.timer!.entryId }), 'Timer stopped.')}>
                    {busy === 'timer' ? 'Stopping…' : 'Stop'}
                  </button>
                )}
              </div>
            </section>
          )}

          {/* ── the merged urgency list ─────────────────────────────────── */}
          {d.owed.length > 0 ? (
            <section className="panel hpanel">
              <header className="panel__head">
                <h2>Owed</h2>
                <span className="panel__n">{d.owed.length}</span>
                <span className="panel__note">
                  Deals, prospects and tickets together, because what you want is what is late.
                </span>
              </header>
              <ul className="hlist">
                {d.owed.map(o => {
                  const id = `${o.kind}:${o.entryId || o.companyId}`
                  return (
                    <li className="hrow" key={id + o.due} data-late={o.overdue ? '' : undefined}>
                      <div className="hrow__main">
                        <p className="hrow__title">
                          <span className="pill pill--quiet">{o.kind}</span>
                          <Link className="inlink" to={owedHref(o)}>{o.title}</Link>
                          {/* On everybody's day until somebody opens a deal on it. */}
                          {o.unassigned && (
                            <span className="flag flag--warn" title="No deal, so nobody owns this callback">
                              unassigned
                            </span>
                          )}
                        </p>
                        <p className="hrow__meta">
                          <span className="hrow__due" data-late={o.overdue ? '' : undefined}>
                            {o.overdue
                              ? `${o.days}d overdue`
                              : 'due today'}
                          </span>
                          <span className="dot" aria-hidden="true">·</span>
                          <span>{o.context}</span>
                          {o.what && <><span className="dot" aria-hidden="true">·</span><span className="muted">{o.what}</span></>}
                        </p>
                      </div>
                      {o.kind !== 'ticket' && can('editDeals') && (
                        <div className="hrow__act">
                          <button type="button" className="btn btn--sm btn--ghost" disabled={!!busy}
                            onClick={() => clear(o)}>
                            {busy === id ? 'Saving…' : 'Did it'}
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="panel__foot">
                <Link className="inlink" to="/crm/follow-ups">Work the follow-up queue</Link>
                {'. It has the snooze options and the contact details.'}
              </p>
            </section>
          ) : (
            /*
             * Nothing owed: the state the page is built to be able to reach. Stated
             * plainly and not dressed up as a congratulation: it is a status, and its
             * value is that it is trustworthy.
             *
             * But "you have cleared your work" and "nothing has been assigned to you"
             * are opposite facts that look identical from here, and getting them
             * confused matters most for the person it happens to first. Someone new,
             * on their first sign-in, being told they are all caught up. So the two are
             * distinguished by whether the caller holds ANYTHING at all.
             */
            (nothingAssigned ? (
              <section className="hclear" data-new="">
                <p className="hclear__head">Nothing is assigned to you yet</p>
                <p>
                  This page fills in as work becomes yours: tickets where you are the
                  engineer or the one answerable, deals you own, and the follow-ups on
                  them. It is empty because there is nothing pointed at you, not because
                  you are finished.
                </p>
                <p className="hclear__where">
                  {can('viewDeals') && <Link className="inlink" to="/crm/prospecting">Pick up a lead</Link>}
                  {can('viewTickets') && <Link className="inlink" to="/tickets">Browse the ticket board</Link>}
                  {can('viewClients') && <Link className="inlink" to="/clients">See the clients</Link>}
                </p>
              </section>
            ) : (
              <section className="hclear">
                <p className="hclear__head">Nothing owed</p>
                <p>
                  No follow-up or ticket is due today or overdue.
                  {d.counts.openTickets > 0 && ` ${d.counts.openTickets} ticket${d.counts.openTickets === 1 ? '' : 's'} open.`}
                  {d.counts.openDeals > 0 && ` ${d.counts.openDeals} deal${d.counts.openDeals === 1 ? '' : 's'} in play.`}
                </p>
              </section>
            ))
          )}

          {/* ── blocked ─────────────────────────────────────────────────── */}
          {d.blocked.length > 0 && (
            <section className="panel hpanel">
              <header className="panel__head">
                <h2>Blocked</h2>
                <span className="panel__n">{d.blocked.length}</span>
                <span className="panel__note">Nothing is visibly wrong and nothing is moving.</span>
              </header>
              <ul className="hlist">
                {d.blocked.map(b => (
                  <li className="hrow" key={b.entryId}>
                    <div className="hrow__main">
                      <p className="hrow__title">
                        <Link className="inlink" to={`/tickets/${b.entryId}`}>
                          {b.ticketNumber ? <span className="hrow__num">#{b.ticketNumber}</span> : null}
                          {b.title}
                        </Link>
                      </p>
                      <p className="hrow__meta">
                        {b.days !== null && <span className="bad">{b.days}d blocked</span>}
                        {b.by && <><span className="dot" aria-hidden="true">·</span><span>flagged by {b.by}</span></>}
                        {b.clientName && <><span className="dot" aria-hidden="true">·</span><span>{b.clientName}</span></>}
                      </p>
                      {b.reason && <p className="hrow__why">{b.reason}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── my tickets ──────────────────────────────────────────────── */}
          {d.tickets.total > 0 && (
            <section className="panel hpanel">
              <header className="panel__head">
                <h2>Your tickets</h2>
                <span className="panel__n">{d.tickets.total}</span>
                <span className="panel__note">Where you are the engineer or the one answerable.</span>
              </header>
              {d.tickets.byStatus.map(group => (
                <div className="hgroup" key={group.status}>
                  <p className="hgroup__h">{group.status} <span className="muted">{group.count}</span></p>
                  <ul className="hlist">
                    {group.rows.map(t => <TicketLine key={t.entryId} t={t} />)}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {/* ── my deals ────────────────────────────────────────────────── */}
          {d.deals.length > 0 && (
            <section className="panel hpanel">
              <header className="panel__head">
                <h2>Your deals</h2>
                <span className="panel__n">{d.deals.length}</span>
                <span className="panel__note">Anything owing a follow-up first, then the stalest.</span>
              </header>
              <ul className="hlist">
                {d.deals.map(deal => (
                  <li className="hrow" key={deal.entryId}>
                    <div className="hrow__main">
                      <p className="hrow__title">
                        <span className="dotc" data-c={deal.confidence} title={`${deal.confidence} confidence`} />
                        <Link className="inlink" to={`/clients/${deal.companyId}/deals`}>{deal.title}</Link>
                      </p>
                      <p className="hrow__meta">
                        <span className="pill">{deal.phase}</span>
                        <span className="dot" aria-hidden="true">·</span>
                        <Link className="inlink" to={`/clients/${deal.companyId}`}>{deal.companyName}</Link>
                        <span className="dot" aria-hidden="true">·</span>
                        <span>{formatMoney(deal.mrr)}<span className="muted">/mo</span></span>
                        {deal.phaseAgeDays !== null && (
                          <>
                            <span className="dot" aria-hidden="true">·</span>
                            <span className={deal.stuck ? 'bad' : undefined}>
                              {deal.phaseSinceEstimated ? '≥' : ''}{deal.phaseAgeDays}d in phase
                            </span>
                          </>
                        )}
                      </p>
                      {/* The absence of a next step is the finding, so it is stated rather
                          than left as a blank line. */}
                      <p className="hrow__why">
                        {deal.nextStep
                          ? <>{deal.nextStep} <span className="muted">· {deal.nextFollowUp || 'no date'}</span></>
                          : <span className="muted">No next step written down</span>}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── this week ───────────────────────────────────────────────── */}
          {(d.week.minutes > 0 || d.week.capacityHours !== null) && (
            <section className="panel hpanel">
              <header className="panel__head">
                <h2>This week</h2>
                <span className="panel__note">Since {d.week.start}</span>
              </header>
              <p className="hweek">
                <strong>{d.week.hours}h</strong> logged
                {d.week.capacityHours !== null && (
                  <span className="muted"> of {d.week.capacityHours}h capacity</span>
                )}
                {d.week.billableHours !== d.week.hours && (
                  <span className="muted"> · {d.week.billableHours}h billable</span>
                )}
              </p>
            </section>
          )}

          {/* ── quiet accounts ──────────────────────────────────────────── */}
          {d.quiet.length > 0 && (
            <section className="panel hpanel">
              <header className="panel__head">
                <h2>Gone quiet</h2>
                <span className="panel__n">{d.quiet.length}</span>
                <span className="panel__note">
                  Clients you own with no touch in {d.quietAfterDays} days.
                </span>
              </header>
              <ul className="hlist">
                {d.quiet.map(q => (
                  <li className="hrow" key={q.companyId}>
                    <div className="hrow__main">
                      <p className="hrow__title">
                        <Link className="inlink" to={`/clients/${q.companyId}`}>{q.companyName}</Link>
                      </p>
                      <p className="hrow__meta">
                        {q.days === null
                          ? <span className="muted">no touch ever recorded</span>
                          : <span>{q.days}d since last touch</span>}
                        {q.contactName && <><span className="dot" aria-hidden="true">·</span><span>{q.contactName}</span></>}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="panel__foot">
            Built from {d.listsScanned} list{d.listsScanned === 1 ? '' : 's'} and{' '}
            {d.companiesScanned} compan{d.companiesScanned === 1 ? 'y' : 'ies'} in one pass,
            tickets and deals are form entries, so there is no global query over either.
          </p>
        </>
      )}
    </section>
  )
}
