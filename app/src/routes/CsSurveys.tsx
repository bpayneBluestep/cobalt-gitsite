import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, getSurveys, npsTone, quarterOf, recentQuarters, SURVEY_DIMENSIONS,
  type SurveyList,
} from '../api'
import CsNav from '../components/CsNav'

/*
 * What clients actually said.
 *
 * Numbers and tables, no chart. At nine or twenty-three responses a trend line is
 * decoration — it draws a shape out of noise and invites a conclusion the data cannot
 * support. So every figure here carries its n, and an empty dimension renders as an em
 * dash rather than a reassuring zero.
 *
 * Responses are identified on purpose: anonymity and actionability are mutually
 * exclusive, and with a hundred high-touch accounts a name is worth more than a trend.
 * Which is why the words are behind `viewSurveys` — this whole page is.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: SurveyList }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

const ALL = 'all'

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

/** A score as a pill, bucketed the way NPS buckets: 9-10 promoter, 7-8 passive, else detractor. */
function Score({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="muted">—</span>
  const tone = value >= 9 ? 'good' : value >= 7 ? 'warn' : 'bad'
  return <span className="pill" data-tone={tone}>{value}</span>
}

export default function CsSurveys() {
  const [quarter, setQuarter] = useState(ALL)
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [openRow, setOpenRow] = useState('')

  const quarters = useMemo(() => recentQuarters(quarterOf(), 8), [])

  const load = useCallback((q: string) => {
    setState({ phase: 'loading' })
    getSurveys(q === ALL ? {} : { quarter: q })
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(quarter) }, [load, quarter])

  const d = state.phase === 'ready' ? state.data : null
  const rows = d ? d.rows : []

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Client Success</p>
        <h1>Surveys</h1>
        <p className="page__sub-text">
          Four questions, four times a year, answered with a name attached — so a 3/10 is
          a phone call tomorrow rather than a dot on a chart.
        </p>
      </header>

      <CsNav counts={d ? { Surveys: d.rows.length } : undefined} />

      <div className="pipebar">
        <div className="pipebar__totals">
          <span><strong>{d ? d.rows.length : 0}</strong> response{d && d.rows.length === 1 ? '' : 's'}</span>
          <span className="muted"><strong>{d ? d.invites.length : 0}</strong> invited</span>
        </div>
        <div className="pipebar__tools">
          <label className="scope__label" htmlFor="cs-quarter">Quarter</label>
          <select id="cs-quarter" className="minisel" value={quarter}
            onChange={e => setQuarter(e.target.value)}>
            <option value={ALL}>Everything so far</option>
            {quarters.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
        </div>
      </div>

      {state.phase === 'loading' && <p className="empty">Reading the responses…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load the responses'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load(quarter)}>Try again</button>}
          </p>
        </div>
      )}

      {d && (
        <>
          <div className="kpis">
            {SURVEY_DIMENSIONS.map(dim => {
              const agg = d.aggregate.perDimension[dim.key]
              const n = agg ? agg.n : 0
              const nps = agg ? agg.nps : null
              return (
                <Kpi
                  key={dim.key}
                  label={dim.label}
                  value={nps === null ? '—' : `NPS ${nps > 0 ? '+' : ''}${nps}`}
                  note={`n=${n}`}
                  tone={npsTone(nps)}
                />
              )
            })}
          </div>

          <p className="note">
            NPS is reported here and never as a headline number: at these volumes it is
            directional, which is why the n is next to every figure. The number leadership
            reads is good standing, on the <Link className="inlink" to="/cs">queue</Link>.
          </p>

          {/*
            The two empty answers are different questions. Nothing at all means no invite
            has ever been answered; nothing in this quarter means the filter is looking
            somewhere quiet.
          */}
          {rows.length === 0 && quarter === ALL && (
            <div className="callout callout--plain">
              <p className="callout__title">No responses yet</p>
              <p>
                {d.invites.length > 0
                  ? <>{d.invites.length} invite{d.invites.length === 1 ? ' has' : 's have'} gone
                      out and none have come back yet. Nothing is wrong until a quarter closes
                      with a response rate near zero.</>
                  : <>No invites have been sent. Copy one from the{' '}
                      <Link className="inlink" to="/cs">queue</Link> — Cobalt writes the email
                      and you send it.</>}
              </p>
            </div>
          )}

          {rows.length === 0 && quarter !== ALL && (
            <div className="callout callout--plain">
              <p className="callout__title">Nothing in {quarter}</p>
              <p>
                No response was submitted in that quarter.{' '}
                <button type="button" className="linkbtn" onClick={() => setQuarter(ALL)}>
                  Show everything
                </button>.
              </p>
            </div>
          )}

          {rows.length > 0 && (
            <section className="panel">
              <header className="panel__head">
                <h2>Responses</h2>
                <span className="panel__n">{rows.length}</span>
              </header>
              <p className="panel__note">Newest first. Open a row for what they wrote.</p>

              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Submitted</th>
                      <th scope="col">Company</th>
                      {SURVEY_DIMENSIONS.map(dim => (
                        <th scope="col" key={dim.key}>{dim.label}</th>
                      ))}
                      <th scope="col">Said</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const open = openRow === r.entryId
                      const said = [r.reason, r.comment].filter(Boolean).join(' ')
                      return (
                        <Fragment key={r.entryId}>
                          <tr className="rowlink">
                            <th scope="row" className="nowrap">
                              {(r.submittedAt || '').slice(0, 10) || '—'}
                            </th>
                            <td>
                              {r.companyId
                                ? <Link className="rowlink__a" to={`/clients/${r.companyId}/success`}>
                                    {r.companyName || 'Untitled'}
                                  </Link>
                                : <span className="muted">{r.companyName || 'unknown'}</span>}
                              {r.contactName && <><br /><span className="muted">{r.contactName}</span></>}
                            </td>
                            {SURVEY_DIMENSIONS.map(dim => (
                              <td className="num" key={dim.key}><Score value={r[dim.key]} /></td>
                            ))}
                            <td>
                              {said ? (
                                <button type="button" className="subtoggle"
                                  aria-expanded={open}
                                  onClick={() => setOpenRow(open ? '' : r.entryId)}>
                                  <span className="subtoggle__caret" aria-hidden="true">
                                    {open ? '▾' : '▸'}
                                  </span>
                                  {open ? 'Hide' : 'Read'}
                                </button>
                              ) : (
                                <span className="muted">nothing written</span>
                              )}
                            </td>
                          </tr>
                          {open && (
                            <tr className="rowlink--sub">
                              <th scope="row">
                                <span className="subtee" aria-hidden="true">↳</span>
                                said
                              </th>
                              <td colSpan={SURVEY_DIMENSIONS.length + 2} className="facts__wrap">
                                {r.reason && <p>{r.reason}</p>}
                                {r.comment && <p className="muted">{r.comment}</p>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {d.invites.length > 0 && (
            <section className="panel">
              <header className="panel__head">
                <h2>Invites sent</h2>
                <span className="panel__n">{d.invites.length}</span>
              </header>
              <p className="panel__note">
                Recorded when the invite was copied. An invite copied and never sent still
                counts — the response rate is what exposes that.
              </p>
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Sent</th>
                      <th scope="col">Company</th>
                      <th scope="col">To</th>
                      <th scope="col">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.invites.map(i => (
                      <tr key={i.entryId}>
                        <th scope="row" className="nowrap">{i.sentAt || '—'}</th>
                        <td>
                          {i.companyId
                            ? <Link className="rowlink__a" to={`/clients/${i.companyId}/success`}>
                                {i.companyName || 'Untitled'}
                              </Link>
                            : <span className="muted">{i.companyName || 'unknown'}</span>}
                        </td>
                        <td>
                          {i.contactName || <span className="muted">unnamed</span>}
                          {i.sentTo ? ` · ${i.sentTo}` : ''}
                        </td>
                        <td>{i.sentBy || <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="panel__foot">
            {d.aggregate.total} response{d.aggregate.total === 1 ? '' : 's'} in this view.
            Every NPS above is computed only over the responses that answered that
            dimension, which is why the n's differ.
          </p>
        </>
      )}
    </section>
  )
}
