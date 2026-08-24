import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { maestroGet, ApiError } from '../api'

/*
 * Tickets: the "ClickUp killer" board, scoped to a company record.
 *
 * Reads `action=tickets` from the Maestro. The Maestro is live, but this action is
 * not built yet, there is no ticket schema on the org, so the page shows an
 * honest failure state rather than pretending.
 *
 * `?demo=1` renders sample rows instead, so the layout and interactions can be
 * reviewed before the data path is live. The banner makes clear it is not real.
 */

export interface Ticket {
  id: string
  title: string
  company: string
  status: string
  priority: 'Urgent' | 'High' | 'Normal' | 'Low'
  assignee: string
  due: string | null
}

const COLUMNS = ['Open', 'In Progress', 'Blocked', 'Done']

const PRIORITY_ORDER: Record<Ticket['priority'], number> = { Urgent: 0, High: 1, Normal: 2, Low: 3 }

const SAMPLE: Ticket[] = [
  { id: 's1', title: 'Med pass report shows wrong time zone', company: 'Cedar Ridge Behavioral Health', status: 'Open', priority: 'Urgent', assignee: 'Brandon Payne', due: '2026-08-08' },
  { id: 's2', title: 'Add discharge summary to client packet', company: 'Northlake Adolescent Center', status: 'Open', priority: 'Normal', assignee: 'Unassigned', due: null },
  { id: 's3', title: 'Import historical assessments from BestNotes', company: 'Harbor Point Recovery', status: 'In Progress', priority: 'High', assignee: 'Brandon Payne', due: '2026-08-12' },
  { id: 's4', title: 'Family portal invite emails bouncing', company: 'Sagebrush Youth Services', status: 'In Progress', priority: 'Urgent', assignee: 'Brandon Payne', due: '2026-08-08' },
  { id: 's5', title: 'Waiting on state licensing numbers', company: 'Willow Creek Academy', status: 'Blocked', priority: 'Normal', assignee: 'Brandon Payne', due: null },
  { id: 's6', title: 'Nightly census job timing out', company: 'Cedar Ridge Behavioral Health', status: 'Done', priority: 'High', assignee: 'Brandon Payne', due: '2026-08-04' },
]

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: Ticket[]; demo: boolean }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

function PriorityDot({ priority }: { priority: Ticket['priority'] }) {
  return <span className="tk__pri" data-p={priority.toLowerCase()} title={`${priority} priority`} aria-label={`${priority} priority`} />
}

export default function Tickets() {
  const [params] = useSearchParams()
  const demo = params.get('demo') === '1'
  const [state, setState] = useState<State>({ phase: 'loading' })

  const load = useCallback(() => {
    if (demo) { setState({ phase: 'ready', rows: SAMPLE, demo: true }); return }
    setState({ phase: 'loading' })
    maestroGet('tickets')
      .then(data => setState({ phase: 'ready', rows: (data?.rows || []) as Ticket[], demo: false }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [demo])

  useEffect(load, [load])

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Engineering</p>
        <h1>Tickets</h1>
        <p className="page__sub-text">
          Work tracked against a company record: the internal replacement for ClickUp.
          Grouped by status, ordered by priority.
        </p>
      </header>

      {state.phase === 'loading' && <p className="empty">Loading tickets…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Ticket data is not live yet'}
          </p>
          <p>{state.error.message}</p>
          <p>
            The board itself is built. The Maestro is live. It just has no{' '}
            <code>tickets</code> action yet, because the ticket schema hasn't been
            created. Once both land, this fills in with no further work here.
          </p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
            {' '}
            <a className="btn btn--ghost" href="?demo=1">Preview with sample tickets</a>
          </p>
        </div>
      )}

      {state.phase === 'ready' && (
        <>
          {state.demo && (
            <div className="callout callout--demo">
              <p className="callout__title">Sample data</p>
              <p>
                These six tickets are invented, for reviewing the layout only. Nothing here
                is stored anywhere. <a className="inlink" href="./">Show real data</a>
              </p>
            </div>
          )}

          <div className="board">
            {COLUMNS.map(col => {
              const rows = state.rows
                .filter(t => t.status === col)
                .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
              return (
                <section className="board__col" key={col} aria-label={col}>
                  <header className="board__head">
                    <h2>{col}</h2>
                    <span className="board__n">{rows.length}</span>
                  </header>

                  {rows.length === 0 && <p className="board__empty">Nothing here</p>}

                  {rows.map(t => (
                    <article className="tk" key={t.id} data-status={col.toLowerCase().replace(' ', '-')}>
                      <p className="tk__title">
                        <PriorityDot priority={t.priority} />
                        {t.title}
                      </p>
                      <p className="tk__meta">
                        <span className="tk__company">{t.company}</span>
                      </p>
                      <p className="tk__meta">
                        <span>{t.assignee}</span>
                        {t.due && <><span className="dot" aria-hidden="true">·</span><span>due {t.due}</span></>}
                      </p>
                    </article>
                  ))}
                </section>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
