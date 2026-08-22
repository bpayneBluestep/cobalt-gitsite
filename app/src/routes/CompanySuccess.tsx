import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, deleteTouchpoint, getSurveys, getTouchpoints, logTouchpoint,
  setSupportIntensity, npsTone, INTENSITY_DEFINITIONS, SURVEY_DIMENSIONS, TEMPERATURES,
  TOUCHPOINT_TYPES,
  type CsInfo, type SurveyList, type Touchpoint, type TouchpointList,
} from '../api'
import { useRecord } from './CompanyRecord'
import { useSession } from '../session'
import { todayISO } from '../lib/time'

/*
 * The Success tab of a company record — one account's whole CS history.
 *
 * The queue answers "who do I ring today"; this answers "what has happened with this
 * client", which is the question you have open while you are on the phone to them. So
 * the health card at the top repeats what the queue said, and everything under it is
 * the evidence: every contact logged, newest first, and every survey they answered.
 *
 * Two capabilities carve this page up. Without `viewSurveys` the survey block is not
 * rendered at all — the words a client typed are a narrower read than their score, and
 * that boundary is enforced in the endpoint, not here. Without `adminCs` there is no
 * delete: a touchpoint is an attestation, and correcting one means logging a newer one.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: TouchpointList }
  | { phase: 'error'; error: ApiError }

/** The health card at the top. Same sentence the queue shows, for the same reason. */
function HealthCard({ cs }: { cs: CsInfo }) {
  return (
    <div className="reccard">
      <dl className="facts">
        <div>
          <dt>Health</dt>
          <dd>
            <span className="dotc" data-c={cs.health} title={cs.health} />{' '}
            <span className="pill" data-tone={cs.health.toLowerCase()}>{cs.health}</span>
          </dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd className="facts__wrap">{cs.reason}</dd>
        </div>
        <div>
          <dt>Last contact</dt>
          <dd>
            {cs.neverTouched
              ? <span className="bad">never</span>
              : <>{cs.lastContact} · {cs.lastContactType || 'contact'} · {cs.contactAgeDays}d ago</>}
          </dd>
        </div>
        <div>
          <dt>Cadence</dt>
          <dd>
            {cs.supportIntensity || <span className="muted">intensity unset</span>}
            {` · every ${cs.cadenceDays}d`}
          </dd>
        </div>
        <div>
          <dt>Temperature</dt>
          <dd>
            {cs.temperature
              ? <>{cs.temperature} on {cs.temperatureDate}</>
              : <span className="muted">no reading yet</span>}
          </dd>
        </div>
        <div>
          <dt>Survey</dt>
          <dd>
            {cs.surveyDue
              ? <span className="flag flag--warn">due</span>
              : <>last invite {cs.lastInviteAt || <span className="muted">never</span>}</>}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export default function CompanySuccess() {
  const { company } = useRecord()
  const id = company.id
  const { can } = useSession()
  const mayEdit = can('editCs')
  const mayAdmin = can('adminCs')
  const maySeeSurveys = can('viewSurveys')

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [surveys, setSurveys] = useState<SurveyList | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [logging, setLogging] = useState(false)
  const [changing, setChanging] = useState(false)
  const [confirming, setConfirming] = useState('')

  // The touchpoint form's own fields, kept out of the row list's state.
  const [date, setDate] = useState(todayISO())
  const [type, setType] = useState<string>(TOUCHPOINT_TYPES[0])
  const [temperature, setTemperature] = useState('')
  const [notes, setNotes] = useState('')

  const [level, setLevel] = useState('')
  const [reason, setReason] = useState('')
  const [override, setOverride] = useState('')

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getTouchpoints(id)
      .then(data => {
        setState({ phase: 'ready', data })
        setLevel(data.cs.supportIntensity || 'Standard')
      })
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [id])

  useEffect(load, [load])

  useEffect(() => {
    if (!maySeeSurveys) return
    let live = true
    getSurveys({ companyId: id })
      .then(data => { if (live) setSurveys(data) })
      // The touchpoint history is the load-bearing half of this page; a failed survey
      // read leaves that intact rather than blanking the tab.
      .catch(() => {})
    return () => { live = false }
  }, [id, maySeeSurveys])

  const d = state.phase === 'ready' ? state.data : null

  function run(id2: string, work: Promise<unknown>, message: string, then?: () => void) {
    setBusy(id2)
    setFailure('')
    setNotice('')
    work
      .then(() => { setNotice(message); if (then) then(); load() })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  return (
    <>
      {state.phase === 'loading' && <p className="empty">Reading this client’s history…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load this client’s success record'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            <button type="button" className="btn" onClick={load}>Try again</button>
          </p>
        </div>
      )}

      {d && (
        <>
          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          <HealthCard cs={d.cs} />

          {d.company.category !== 'Client' && (
            <p className="note">
              This company is {d.company.category || 'uncategorised'}, not a Client, so it
              does not appear in the Client Success queue. Its history is kept either way.
            </p>
          )}

          <section className="panel">
            <header className="panel__head">
              <h2>Touchpoints</h2>
              <span className="panel__n">{d.rows.length}</span>
              {mayEdit && !logging && (
                <button type="button" className="btn btn--sm" onClick={() => setLogging(true)}>
                  Log touchpoint
                </button>
              )}
              {mayEdit && !changing && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setChanging(true)}>
                  Intensity
                </button>
              )}
            </header>
            <p className="panel__note">
              Every contact, newest first. There is no edit: a wrong reading is corrected by
              logging a newer one.
            </p>

            {logging && (
              <div className="editcard">
                <header className="editcard__head">
                  <h2>Log a touchpoint</h2>
                </header>
                <div className="efgrid">
                  <div className="ef">
                    <label htmlFor="cs-date">Date</label>
                    <input id="cs-date" type="date" value={date} max={todayISO()}
                      onChange={e => setDate(e.target.value)} />
                  </div>
                  <div className="ef">
                    <label htmlFor="cs-type">Type<span className="ef__req">*</span></label>
                    <select id="cs-type" value={type} onChange={e => setType(e.target.value)}>
                      {TOUCHPOINT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="ef">
                    <label>Temperature</label>
                    <div className="filters" role="group" aria-label="Temperature reading">
                      {TEMPERATURES.map(t => (
                        <button key={t} type="button" className="filter"
                          data-on={temperature === t ? '' : undefined}
                          aria-pressed={temperature === t}
                          onClick={() => setTemperature(temperature === t ? '' : t)}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="ef ef--wide">
                    <label htmlFor="cs-notes">Notes</label>
                    <textarea id="cs-notes" rows={3} value={notes}
                      onChange={e => setNotes(e.target.value)} />
                  </div>
                </div>
                <div className="editcard__foot">
                  <button type="button" className="btn" disabled={busy === 'log'}
                    onClick={() => run('log',
                      logTouchpoint(id, { date, type, temperature, notes }),
                      'Logged.',
                      () => { setLogging(false); setNotes(''); setTemperature('') })}>
                    {busy === 'log' ? 'Saving…' : 'Log it'}
                  </button>
                  <button type="button" className="btn btn--ghost" disabled={busy === 'log'}
                    onClick={() => setLogging(false)}>Cancel</button>
                  <span className="editcard__status">
                    {temperature === 'Red'
                      ? 'A Red reading also sets a follow-up on this company, two days out.'
                      : 'Resets this account’s cadence clock.'}
                  </span>
                </div>
              </div>
            )}

            {changing && (
              <div className="editcard">
                <header className="editcard__head">
                  <h2>Support intensity</h2>
                  <p className="note">
                    How much ongoing guidance this client needs — it sets how often the
                    queue asks about them.
                  </p>
                </header>
                <div className="efgrid">
                  <div className="ef">
                    <label htmlFor="cs-level">Level<span className="ef__req">*</span></label>
                    <select id="cs-level" value={level} onChange={e => setLevel(e.target.value)}>
                      {INTENSITY_DEFINITIONS.map(x => (
                        <option key={x.level} value={x.level}>{x.level}</option>
                      ))}
                    </select>
                  </div>
                  <div className="ef">
                    <label htmlFor="cs-over">Cadence override (days)</label>
                    <input id="cs-over" type="number" min={1} max={365} value={override}
                      placeholder="leave blank to use the level"
                      onChange={e => setOverride(e.target.value)} />
                  </div>
                  <div className="ef ef--wide">
                    <label htmlFor="cs-reason">Reason<span className="ef__req">*</span></label>
                    <textarea id="cs-reason" rows={2} value={reason}
                      onChange={e => setReason(e.target.value)} />
                    <p className="ef__hint">
                      Required — it is the audit trail, and it is logged as an Intensity
                      Change touchpoint that does not count as contact.
                    </p>
                  </div>
                </div>
                <ul className="callout__list">
                  {INTENSITY_DEFINITIONS.map(x => (
                    <li key={x.level}><strong>{x.level}</strong> — {x.what}</li>
                  ))}
                </ul>
                <div className="editcard__foot">
                  <button type="button" className="btn"
                    disabled={busy === 'intensity' || !reason.trim()}
                    onClick={() => run('intensity',
                      setSupportIntensity(id, {
                        level, reason: reason.trim(), cadenceOverrideDays: override.trim(),
                      }),
                      `Now ${level}.`,
                      () => { setChanging(false); setReason('') })}>
                    {busy === 'intensity' ? 'Saving…' : 'Set the intensity'}
                  </button>
                  <button type="button" className="btn btn--ghost" disabled={busy === 'intensity'}
                    onClick={() => setChanging(false)}>Cancel</button>
                </div>
              </div>
            )}

            {d.rows.length === 0 ? (
              <p className="empty">
                Nothing logged against this client yet, which is why it reads as never
                contacted.{' '}
                {mayEdit
                  ? 'Log the last call you had with them and the cadence starts from there.'
                  : 'Only Leadership, Sales and Client Success can log one.'}
              </p>
            ) : (
              <ul className="hlist">
                {d.rows.map(t => (
                  <TouchpointRow
                    key={t.entryId}
                    row={t}
                    mayAdmin={mayAdmin}
                    busy={busy === t.entryId}
                    confirming={confirming === t.entryId}
                    onAsk={() => { setConfirming(t.entryId); setFailure(''); setNotice('') }}
                    onCancel={() => setConfirming('')}
                    onDelete={() => run(t.entryId, deleteTouchpoint(id, t.entryId),
                      'Touchpoint deleted.', () => setConfirming(''))}
                  />
                ))}
              </ul>
            )}
          </section>

          {maySeeSurveys && (
            <section className="panel">
              <header className="panel__head">
                <h2>Surveys</h2>
                <span className="panel__n">{surveys ? surveys.rows.length : 0}</span>
              </header>
              <p className="panel__note">
                What this client told us, with their name on it. Verbatim answers are
                visible to Leadership, Sales and Client Success only.
              </p>

              {!surveys && <p className="empty">Reading the survey history…</p>}

              {surveys && surveys.rows.length === 0 && surveys.invites.length === 0 && (
                <p className="empty">
                  No invite has been sent to this client yet. Send one from the{' '}
                  <Link className="inlink" to="/cs">queue</Link> — it takes a copy and a paste.
                </p>
              )}

              {surveys && surveys.rows.length === 0 && surveys.invites.length > 0 && (
                <p className="empty">
                  {surveys.invites.length} invite{surveys.invites.length === 1 ? '' : 's'} sent,
                  no answer yet. Nothing here is overdue until the next quarter comes round.
                </p>
              )}

              {surveys && surveys.rows.length > 0 && (
                <div className="tablewrap">
                  <table className="fields compact">
                    <thead>
                      <tr>
                        <th scope="col">Submitted</th>
                        {SURVEY_DIMENSIONS.map(dim => (
                          <th scope="col" key={dim.key}>{dim.label}</th>
                        ))}
                        <th scope="col">Said</th>
                      </tr>
                    </thead>
                    <tbody>
                      {surveys.rows.map(r => (
                        <tr key={r.entryId}>
                          <th scope="row" className="nowrap">
                            {(r.submittedAt || '').slice(0, 10) || '—'}
                            {r.contactName && <><br /><span className="muted">{r.contactName}</span></>}
                          </th>
                          {SURVEY_DIMENSIONS.map(dim => {
                            const v = r[dim.key]
                            return (
                              <td className="num" key={dim.key}>
                                {v === null || v === undefined
                                  ? '—'
                                  : <span className="pill" data-tone={v >= 9 ? 'good' : v >= 7 ? 'warn' : 'bad'}>{v}</span>}
                              </td>
                            )
                          })}
                          <td className="facts__wrap">
                            {r.reason || r.comment
                              ? <>
                                  {r.reason && <p>{r.reason}</p>}
                                  {r.comment && <p className="muted">{r.comment}</p>}
                                </>
                              : <span className="muted">nothing written</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {surveys && surveys.rows.length > 0 && (
                <p className="panel__foot">
                  {SURVEY_DIMENSIONS.map(dim => {
                    const agg = surveys.aggregate.perDimension[dim.key]
                    const n = agg ? agg.n : 0
                    const nps = agg ? agg.nps : null
                    return (
                      <span key={dim.key} className="flag" data-tone={npsTone(nps)}>
                        {dim.label} {nps === null ? '—' : (nps > 0 ? `+${nps}` : nps)} · n={n}
                      </span>
                    )
                  })}
                </p>
              )}

              {surveys && surveys.invites.length > 0 && (
                <div className="tablewrap">
                  <table className="fields compact">
                    <thead>
                      <tr>
                        <th scope="col">Invite sent</th>
                        <th scope="col">To</th>
                        <th scope="col">By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {surveys.invites.map(i => (
                        <tr key={i.entryId}>
                          <th scope="row" className="nowrap">{i.sentAt || '—'}</th>
                          <td>{i.contactName || <span className="muted">unnamed</span>}{i.sentTo ? ` · ${i.sentTo}` : ''}</td>
                          <td>{i.sentBy || <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  )
}

/* ------------------------------------------------------------ one touchpoint */

function TouchpointRow({ row, mayAdmin, busy, confirming, onAsk, onCancel, onDelete }: {
  row: Touchpoint
  mayAdmin: boolean
  busy: boolean
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const bookkeeping = row.type === 'Intensity Change'

  return (
    <li className="hrow">
      <div className="hrow__main">
        <p className="hrow__title">
          <span className="hrow__num">{row.date || '—'}</span>
          <span className="pill">{row.type || 'contact'}</span>
          {row.temp && (
            <>
              <span className="dotc" data-c={row.temp} title={row.temp} />
              <span className="pill" data-tone={row.temp.toLowerCase()}>{row.temp}</span>
            </>
          )}
          {bookkeeping && <span className="pill pill--quiet">not contact</span>}
        </p>
        {row.notes && <p className="hrow__why">{row.notes}</p>}
        <p className="hrow__meta">
          <span>{row.loggedBy || 'unknown'}</span>
          {row.loggedAt && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span className="muted">recorded {row.loggedAt}</span>
            </>
          )}
        </p>
      </div>

      {mayAdmin && (
        <div className="hrow__act">
          {confirming ? (
            <>
              <span className="muted">Delete this record?</span>
              <button type="button" className="btn btn--danger btn--sm" disabled={busy}
                onClick={onDelete}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
                onClick={onCancel}>Keep</button>
            </>
          ) : (
            <button type="button" className="linkbtn linkbtn--danger" onClick={onAsk}>
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  )
}
