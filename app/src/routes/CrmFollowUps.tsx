import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, completeFollowUp, getFollowUps, setDealFollowUp, updateCompany, formatMoney,
  type FollowUp, type FollowUpQueue,
} from '../api'
import CrmNav from '../components/CrmNav'
import OwnerScope, { ScopeNote, useScope } from '../components/OwnerScope'
import { useSession } from '../session'

/*
 * What you owe somebody, soonest first.
 *
 * This is the page a business-development person should be able to open first thing and
 * work straight down. Everything else in the CRM answers "what is the state of things";
 * this answers "what am I doing today", which is a different question and was previously
 * unanswerable — follow-ups existed only as a date on a company, visible on one table
 * that by definition excluded everything in the pipeline.
 *
 * Deal and company follow-ups are one list. To the person doing the work they are the
 * same job — call somebody — and splitting them across two screens is exactly how one of
 * them stops getting read.
 *
 * Every row can be finished from here without opening anything. A queue you have to
 * leave in order to act on is a queue people stop using.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: FollowUpQueue }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/** Add days to a yyyy-mm-dd date, in local time — snooze arithmetic. */
function plusDays(iso: string, days: number): string {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date()
  base.setDate(base.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`
}

/**
 * Snooze from TODAY, not from the original due date.
 *
 * "Tomorrow" has to mean tomorrow. Adding a day to a date three weeks overdue produces
 * something still overdue, which looks like the button did nothing.
 */
function snoozeTo(days: number): string {
  return plusDays('', days)
}

const SNOOZES = [
  { label: 'Tomorrow', days: 1 },
  { label: '+3 days', days: 3 },
  { label: 'Next week', days: 7 },
]

const GROUPS: { key: FollowUp['state']; title: string; blurb: string }[] = [
  { key: 'overdue', title: 'Overdue', blurb: 'You said you would do these already.' },
  { key: 'today', title: 'Today', blurb: 'Due now.' },
  { key: 'scheduled', title: 'Coming up', blurb: 'Scheduled, nothing owed yet.' },
]

export default function CrmFollowUps() {
  const { can } = useSession()
  const mayEdit = can('editDeals')
  const mayEditClients = can('editClients')

  const [, , ownerId] = useScope()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  /** The row with its "what happened?" box open. */
  const [logging, setLogging] = useState('')
  const [logText, setLogText] = useState('')
  const [logKind, setLogKind] = useState('Call')

  const load = useCallback((who: string) => {
    setState({ phase: 'loading' })
    getFollowUps(who ? { ownerId: who } : {})
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(ownerId) }, [load, ownerId])

  const d = state.phase === 'ready' ? state.data : null

  const rows = useMemo(() => {
    if (!d) return []
    const q = search.trim().toLowerCase()
    if (!q) return d.rows
    return d.rows.filter(r =>
      [r.companyName, r.title, r.nextStep, r.contactName, r.owner]
        .some(v => String(v || '').toLowerCase().includes(q)))
  }, [d, search])

  const key = (r: FollowUp) => `${r.kind}:${r.companyId}:${r.entryId}`

  function after(message: string) {
    setNotice(message)
    setLogging('')
    setLogText('')
    load(ownerId)
  }

  function run(id: string, work: Promise<unknown>, message: string) {
    setBusy(id)
    setFailure('')
    setNotice('')
    work
      .then(() => after(message))
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function done(r: FollowUp) {
    const id = key(r)
    if (r.kind === 'deal') {
      run(id, completeFollowUp(r.companyId, r.entryId, {
        ...(logText.trim() ? { text: logText.trim(), kind: logKind } : {}),
      }), `${r.title} — done.`)
      return
    }
    /*
     * A company follow-up has no deal to log against, so "done" is the same pair of
     * writes the Prospecting page makes: touched today, and nothing scheduled next.
     * Clearing the date is what takes it out of this queue — without that it would be
     * marked done and still be sitting here tomorrow.
     */
    run(id, updateCompany(r.companyId, { lastTouch: snoozeTo(0), nextFollowUp: '' }),
      `${r.companyName} — marked touched.`)
  }

  function snooze(r: FollowUp, days: number) {
    const id = key(r)
    const when = snoozeTo(days)
    if (r.kind === 'deal') {
      run(id, setDealFollowUp(r.companyId, r.entryId, { nextFollowUp: when, nextStep: r.nextStep }),
        `${r.title} → ${when}.`)
      return
    }
    run(id, updateCompany(r.companyId, { nextFollowUp: when }), `${r.companyName} → ${when}.`)
  }

  const editable = (r: FollowUp) => (r.kind === 'deal' ? mayEdit : mayEditClients)

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">CRM</p>
        <h1>Follow-ups</h1>
        <p className="page__sub-text">
          Everything you owe somebody, soonest first — deals and prospects together,
          because they are the same job.
        </p>
      </header>

      <CrmNav counts={d ? { 'Follow-ups': d.overdue + d.dueToday } : undefined} />

      {state.phase === 'loading' && <p className="empty">Loading your follow-ups…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load your follow-ups'}
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
              <span className={d.overdue ? 'bad' : undefined}><strong>{d.overdue}</strong> overdue</span>
              <span><strong>{d.dueToday}</strong> today</span>
              <span className="muted"><strong>{d.upcoming}</strong> coming up</span>
            </div>
            <div className="pipebar__tools">
              <div className="ef ef--narrow">
                <label htmlFor="f-search">Search</label>
                <input id="f-search" type="search" value={search} autoComplete="off"
                  placeholder="Company, deal, next step…"
                  onChange={e => setSearch(e.target.value)} />
              </div>
              <OwnerScope />
            </div>
          </div>

          <ScopeNote ownerName={d.owner} />

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {rows.length === 0 && (
            <div className="callout callout--plain">
              <p className="callout__title">Nothing owed</p>
              <p>
                {search
                  ? <>Nothing matches “{search}”.{' '}
                      <button type="button" className="linkbtn" onClick={() => setSearch('')}>Clear the search</button>.</>
                  : <>No follow-ups are scheduled in this view. Set one from a deal’s history
                      or from <Link className="inlink" to="/crm/prospecting">Prospecting</Link>.</>}
              </p>
            </div>
          )}

          {GROUPS.map(group => {
            const mine = rows.filter(r => r.state === group.key)
            if (!mine.length) return null
            return (
              <section className="panel" key={group.key}>
                <header className="panel__head">
                  <h2>{group.title}</h2>
                  <span className="panel__n">{mine.length}</span>
                </header>
                <p className="panel__note">{group.blurb}</p>

                <ul className="fulist">
                  {mine.map(r => {
                    const id = key(r)
                    const working = busy === id
                    return (
                      <li className="fu" key={id} data-state={r.state}>
                        <div className="fu__main">
                          <p className="fu__title">
                            {r.kind === 'deal' ? (
                              <Link className="inlink" to={`/clients/${r.companyId}/deals`}>{r.title}</Link>
                            ) : (
                              <Link className="inlink" to={`/clients/${r.companyId}`}>{r.companyName}</Link>
                            )}
                            {r.kind === 'deal' && (
                              <span className="muted"> · {r.phase}</span>
                            )}
                            {r.kind === 'company' && (
                              <span className="pill pill--quiet">prospect</span>
                            )}
                            {/* Nobody has opened a deal here, so this callback is on
                                whoever picks it up. Said plainly rather than shown as
                                somebody's, which is how it would get quietly dropped. */}
                            {r.unassigned && (
                              <span className="flag flag--warn" title="No deal, so no owner — open one to take it">
                                unassigned
                              </span>
                            )}
                          </p>

                          <p className="fu__step">
                            {r.nextStep || <span className="muted">No action written down</span>}
                          </p>

                          <p className="fu__meta">
                            <span className="fu__due" data-state={r.state}>due {r.due}</span>
                            {r.kind === 'deal' && (
                              <>
                                <span className="dot" aria-hidden="true">·</span>
                                <Link className="inlink" to={`/clients/${r.companyId}`}>{r.companyName}</Link>
                              </>
                            )}
                            {r.contactName && (
                              <>
                                <span className="dot" aria-hidden="true">·</span>
                                <span>{r.contactName}</span>
                              </>
                            )}
                            {/* A queue you can act from needs the phone number in it, or
                                every row costs a detour through the record. */}
                            {r.contactPhone && (
                              <>
                                <span className="dot" aria-hidden="true">·</span>
                                <a className="inlink" href={`tel:${r.contactPhone}`}>{r.contactPhone}</a>
                              </>
                            )}
                            {r.contactEmail && (
                              <>
                                <span className="dot" aria-hidden="true">·</span>
                                <a className="inlink" href={`mailto:${r.contactEmail}`}>email</a>
                              </>
                            )}
                            {r.mrr !== null && r.mrr !== undefined && (
                              <>
                                <span className="dot" aria-hidden="true">·</span>
                                <span>{formatMoney(r.mrr)}/mo</span>
                              </>
                            )}
                            {r.lastTouch && (
                              <>
                                <span className="dot" aria-hidden="true">·</span>
                                <span className="muted">last touched {r.lastTouch}</span>
                              </>
                            )}
                          </p>
                        </div>

                        {editable(r) && (
                          <div className="fu__acts">
                            {logging === id ? (
                              <>
                                <select aria-label="What happened" value={logKind}
                                  onChange={e => setLogKind(e.target.value)}>
                                  {(d.activityKinds || []).map(k => <option key={k} value={k}>{k}</option>)}
                                </select>
                                <input
                                  type="text"
                                  className="fu__note"
                                  autoFocus
                                  value={logText}
                                  placeholder="What happened? (optional)"
                                  onChange={e => setLogText(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') done(r) }}
                                />
                                <button type="button" className="btn btn--sm" disabled={working}
                                  onClick={() => done(r)}>
                                  {working ? 'Saving…' : 'Save'}
                                </button>
                                <button type="button" className="btn btn--ghost btn--sm" disabled={working}
                                  onClick={() => { setLogging(''); setLogText('') }}>
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  disabled={working}
                                  onClick={() => {
                                    // A deal can carry a note; a prospect has nowhere to
                                    // put one, so it just gets marked.
                                    if (r.kind === 'deal') { setLogging(id); setLogText('') }
                                    else done(r)
                                  }}
                                >
                                  {working ? 'Saving…' : 'Did it'}
                                </button>
                                {SNOOZES.map(s => (
                                  <button key={s.days} type="button" className="btn btn--ghost btn--sm"
                                    disabled={working} onClick={() => snooze(r, s.days)}>
                                    {s.label}
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}

          <p className="panel__foot">
            Walked {d.companiesScanned} compan{d.companiesScanned === 1 ? 'y' : 'ies'} to build this.
            A company only appears in its own right when it has no open deal — otherwise the
            deal’s follow-up is the live one.
          </p>
        </>
      )}
    </section>
  )
}
