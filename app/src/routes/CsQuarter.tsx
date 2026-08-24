import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, getCsSummary, npsTone, quarterOf, recentQuarters, SURVEY_DIMENSIONS,
  type CsSummary,
} from '../api'
import CsNav from '../components/CsNav'
import { useSession } from '../session'

/*
 * The quarter, on one page you can hand to somebody.
 *
 * Health is reconstructible as of any date: every input is dated and nothing is
 * stored, so this can honestly answer "where were we in July" as well as "where are we
 * now", which is the only way the good-standing number means anything. Start against
 * end, with counts, is the whole argument.
 *
 * Printable rather than exportable: Ctrl-P is a button everybody already knows, the
 * page is already the document, and a PDF generator would be a dependency to keep alive
 * for a page read four times a year. The one new stylesheet rule in this whole feature
 * is the @media print block that hides the nav chrome.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: CsSummary }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

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

/** A percentage that might not exist. Null is not zero and never renders as it. */
const pct = (v: number | null) => (v === null || v === undefined ? '-' : `${v}%`)

export default function CsQuarter() {
  const { can } = useSession()
  const maySeeSurveys = can('viewSurveys')

  const [quarter, setQuarter] = useState(quarterOf())
  const [state, setState] = useState<State>({ phase: 'loading' })

  const quarters = useMemo(() => recentQuarters(quarterOf(), 8), [])

  const load = useCallback((q: string) => {
    setState({ phase: 'loading' })
    getCsSummary(q)
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(quarter) }, [load, quarter])

  const d = state.phase === 'ready' ? state.data : null
  const moved = d && d.headline.startPct !== null && d.headline.endPct !== null
    ? d.headline.endPct - d.headline.startPct
    : null

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Client Success</p>
        <h1>Quarter review{d ? `: ${d.quarter}` : ''}</h1>
        <p className="page__sub-text">
          Who is healthy, who is at risk and who owns them, what we did about every
          detractor and how fast, and whether the number moved.
        </p>
      </header>

      <CsNav />

      <div className="pipebar">
        <div className="pipebar__totals">
          {d && <span><strong>{d.counts.clients}</strong> client{d.counts.clients === 1 ? '' : 's'}</span>}
          {d && <span className="muted">{d.startDate} → {d.endDate}</span>}
        </div>
        <div className="pipebar__tools">
          <label className="scope__label" htmlFor="q-pick">Quarter</label>
          <select id="q-pick" className="minisel" value={quarter}
            onChange={e => setQuarter(e.target.value)}>
            {quarters.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
          <button type="button" className="btn btn--sm" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>

      {state.phase === 'loading' && <p className="empty">Reconstructing the quarter…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not build the quarter review'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load(quarter)}>Try again</button>}
          </p>
        </div>
      )}

      {d && d.counts.clients === 0 && (
        <div className="callout callout--plain">
          <p className="callout__title">No clients in {d.quarter}</p>
          <p>
            There were no companies in the Client category to measure. Move one over from{' '}
            <Link className="inlink" to="/clients">Clients</Link> and the next quarter has
            something to say.
          </p>
        </div>
      )}

      {d && d.counts.clients > 0 && (
        <>
          <div className="kpis">
            <Kpi
              label="Good standing, quarter start"
              value={pct(d.headline.startPct)}
              note={d.startDate}
              tone={d.headline.startPct === null ? undefined : d.headline.startTone}
            />
            <Kpi
              label="Good standing, now"
              value={pct(d.headline.endPct)}
              note={d.endDate}
              tone={d.headline.endPct === null ? undefined : d.headline.endTone}
            />
            <Kpi
              label="Movement"
              value={moved === null ? '-' : `${moved > 0 ? '+' : ''}${moved} pts`}
              note={moved === null
                ? 'not measurable across this quarter'
                : moved > 0 ? 'better than it started' : moved < 0 ? 'worse than it started' : 'flat'}
              tone={moved === null ? undefined : moved > 0 ? 'good' : moved < 0 ? 'bad' : 'warn'}
            />
            <Kpi
              label="Touchpoint coverage"
              value={pct(d.touchpoints.coveragePct)}
              note={`${d.touchpoints.logged} logged across ${d.touchpoints.companiesTouched} client${d.touchpoints.companiesTouched === 1 ? '' : 's'}`}
              tone={d.touchpoints.coveragePct === null
                ? undefined
                : d.touchpoints.coveragePct >= 90 ? 'good' : d.touchpoints.coveragePct >= 75 ? 'warn' : 'bad'}
            />
            <Kpi
              label="Survey response rate"
              value={pct(d.surveys.responseRatePct)}
              note={`${d.surveys.responses} of ${d.surveys.invitesSent} invite${d.surveys.invitesSent === 1 ? '' : 's'}`}
            />
          </div>

          <section className="panel">
            <header className="panel__head">
              <h2>Where the book stands</h2>
              <span className="panel__n">{d.counts.clients}</span>
            </header>
            <p className="panel__note">
              Counted at {d.endDate}. Good standing is a fresh Green reading inside the
              account's own cadence. Nothing else counts.
            </p>
            <dl className="stats">
              <div><dt>Green</dt><dd>{d.counts.green}</dd></div>
              <div><dt>Yellow</dt><dd>{d.counts.yellow}</dd></div>
              <div><dt>Red</dt><dd>{d.counts.red}</dd></div>
              <div><dt>Never contacted</dt><dd>{d.counts.neverTouched}</dd></div>
              <div><dt>Clients</dt><dd>{d.counts.clients}</dd></div>
            </dl>
          </section>

          <section className="panel">
            <header className="panel__head">
              <h2>What clients said</h2>
              <span className="panel__n">{d.surveys.responses}</span>
            </header>
            <p className="panel__note">
              NPS per dimension with its n, never as a headline: at these volumes it is
              directional. An unanswered dimension is an em dash, not a zero.
            </p>
            <div className="tablewrap">
              <table className="fields compact">
                <thead>
                  <tr>
                    <th scope="col">Dimension</th>
                    <th scope="col">NPS</th>
                    <th scope="col">n</th>
                  </tr>
                </thead>
                <tbody>
                  {SURVEY_DIMENSIONS.map(dim => {
                    const agg = d.surveys.perDimension[dim.key]
                    const n = agg ? agg.n : 0
                    const nps = agg ? agg.nps : null
                    return (
                      <tr key={dim.key}>
                        <th scope="row">{dim.label}</th>
                        <td className="num">
                          {nps === null
                            ? <span className="muted">-</span>
                            : <span className="pill" data-tone={npsTone(nps)}>
                                {nps > 0 ? `+${nps}` : nps}
                              </span>}
                        </td>
                        <td className="num">n={n}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <header className="panel__head">
              <h2>Detractors, and what we did</h2>
              <span className="panel__n">{d.surveys.detractors.length}</span>
            </header>
            <p className="panel__note">
              Days to acknowledgment, not who was scored what. Acknowledgment is a
              by-product of ringing them: logging the call answers the response.
            </p>

            {d.surveys.detractors.length === 0 ? (
              <p className="empty">
                {d.surveys.responses === 0
                  ? 'No responses came in this quarter, so there is nothing to have answered.'
                  : 'No response scored 6 or below. Nothing to chase.'}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Company</th>
                      <th scope="col">Dimension</th>
                      <th scope="col">Answered in</th>
                      {maySeeSurveys && <th scope="col">Said</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {d.surveys.detractors.map(x => (
                      <tr key={`${x.companyId}-${x.date}-${x.dimension}`}>
                        <th scope="row" className="nowrap">{x.date}</th>
                        <td>
                          <Link className="rowlink__a" to={`/clients/${x.companyId}/success`}>
                            {x.companyName || 'Untitled'}
                          </Link>
                        </td>
                        <td>{x.dimension} {x.score}/10</td>
                        <td className="num">
                          {x.acknowledgedInDays === null
                            ? <span className="bad">still open</span>
                            : `${x.acknowledgedInDays}d`}
                        </td>
                        {maySeeSurveys && (
                          <td className="facts__wrap">
                            {x.comment || <span className="muted">nothing written</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <header className="panel__head">
              <h2>Red accounts at quarter end</h2>
              <span className="panel__n">{d.redAccounts.length}</span>
            </header>
            <p className="panel__note">
              Each one with an owner, a next step and a date, because a Red with none of
              those is the failure this system exists to prevent.
            </p>

            {d.redAccounts.length === 0 ? (
              <p className="empty">Nothing red at {d.endDate}. That is the whole point.</p>
            ) : (
              <div className="tablewrap">
                <table className="fields compact">
                  <thead>
                    <tr>
                      <th scope="col">Company</th>
                      <th scope="col">Why</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Next step</th>
                      <th scope="col">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.redAccounts.map(a => (
                      <tr key={a.companyId}>
                        <th scope="row">
                          <Link className="rowlink__a" to={`/clients/${a.companyId}/success`}>
                            {a.companyName || 'Untitled'}
                          </Link>
                        </th>
                        <td className="facts__wrap">{a.reason}</td>
                        <td>{a.owner || <span className="muted">unowned</span>}</td>
                        <td className="facts__wrap">
                          {a.nextStep || <span className="bad">nothing written down</span>}
                        </td>
                        <td className="nowrap">
                          {a.nextFollowUp || <span className="bad">no date</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="panel__foot">
            Walked {d.companiesScanned} compan{d.companiesScanned === 1 ? 'y' : 'ies'} and
            recomputed every account's health twice: once as of {d.startDate}, once as of{' '}
            {d.endDate}. No health figure on this page was read from a stored field.
          </p>
        </>
      )}
    </section>
  )
}
