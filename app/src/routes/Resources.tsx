import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getArtifacts, ApiError, type ArtifactCard } from '../api'

/*
 * The Resources library: every artifact as a card.
 *
 * Filtering is client-side over the full card list — the same call Claude Code makes,
 * so what a person can find here and what an engineer's Claude can find are by
 * construction the same set. Tags double as one-click filters because engineers
 * think in topics ("migration", "e-signature") before they remember titles.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: ArtifactCard[] }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

export default function Resources() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getArtifacts(showArchived ? { includeArchived: 'true' } : {})
      .then(d => setState({ phase: 'ready', rows: d.rows }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [showArchived])

  useEffect(load, [load])

  const rows = state.phase === 'ready' ? state.rows : []

  const allTags = useMemo(() => {
    const seen: Record<string, number> = {}
    for (const r of rows) for (const t of r.tags) seen[t] = (seen[t] || 0) + 1
    return Object.keys(seen).sort((a, b) => seen[b] - seen[a])
  }, [rows])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (tag && r.tags.indexOf(tag) < 0) return false
      if (!q) return true
      return [r.title, r.summary, r.slug, r.ownerName, r.tags.join(' ')]
        .some(v => String(v || '').toLowerCase().includes(q))
    })
  }, [rows, search, tag])

  return (
    <div className="page">
      <header className="page__head">
        <div className="page__head-row">
          <div>
            <p className="eyebrow">The library</p>
            <h1>Resources</h1>
          </div>
          <div className="page__head-tools">
            {rows.length > 0 && (
              <div className="ef ef--narrow">
                <label htmlFor="res-search">Search</label>
                <input
                  id="res-search"
                  type="search"
                  value={search}
                  autoComplete="off"
                  placeholder="Title, tag, owner…"
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
        <p className="page__sub-text">
          What we already solved, packaged so nobody solves it twice. Publishing and
          pulling happen through Claude Code — tell it{' '}
          <code>publish this as an artifact</code> or{' '}
          <code>pull the &lt;name&gt; artifact</code>.
        </p>
      </header>

      {state.phase === 'loading' && <p className="empty">Loading artifacts…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load artifacts'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
          </p>
        </div>
      )}

      {state.phase === 'ready' && rows.length === 0 && (
        <div className="callout callout--plain">
          <p className="callout__title">The shelf is empty</p>
          <p>
            No artifacts yet. Finish a piece of work, then tell Claude Code{' '}
            <code>publish this as an artifact</code> — it will interview you about what
            belongs in the bundle and write the explainer with you.
          </p>
        </div>
      )}

      {state.phase === 'ready' && rows.length > 0 && (
        <>
          {allTags.length > 0 && (
            <div className="stage" role="group" aria-label="Filter by tag">
              <button type="button" className="filter" data-on={tag === '' ? '' : undefined}
                onClick={() => setTag('')}>All</button>
              {allTags.slice(0, 12).map(t => (
                <button key={t} type="button" className="filter"
                  data-on={tag === t ? '' : undefined}
                  onClick={() => setTag(tag === t ? '' : t)}>{t}</button>
              ))}
              <label className="res-archived">
                <input type="checkbox" checked={showArchived}
                  onChange={e => setShowArchived(e.target.checked)} /> archived
              </label>
            </div>
          )}

          <p className="page__count">
            {search.trim() || tag
              ? `${shown.length} of ${rows.length} artifact${rows.length === 1 ? '' : 's'}`
              : `${rows.length} artifact${rows.length === 1 ? '' : 's'}`}
          </p>

          {shown.length === 0 && (
            <div className="callout callout--plain">
              <p className="callout__title">No match</p>
              <p>
                Nothing matches{search.trim() ? <> “{search.trim()}”</> : null}
                {tag ? <> tagged <code>{tag}</code></> : null}.{' '}
                <button type="button" className="linkbtn"
                  onClick={() => { setSearch(''); setTag('') }}>Clear filters</button>.
              </p>
            </div>
          )}

          <div className="res-grid">
            {shown.map(r => (
              <Link key={r.id} className="res-card" to={`/resources/${r.slug || r.id}`}>
                <div className="res-card__top">
                  <b>{r.title}</b>
                  <span className="res-card__v">v{r.currentVersion}</span>
                </div>
                {r.summary && <p className="res-card__sum">{r.summary}</p>}
                <div className="res-card__meta">
                  {r.tags.slice(0, 4).map(t => <span key={t} className="res-tag">{t}</span>)}
                </div>
                <div className="res-card__foot">
                  <span>{r.ownerName}</span>
                  <span className="muted">
                    {r.fileCount} file{r.fileCount === 1 ? '' : 's'}
                    {r.openProposals > 0 && <> · {r.openProposals} open proposal{r.openProposals === 1 ? '' : 's'}</>}
                    {r.status === 'Archived' && <> · archived</>}
                    {' · '}{r.updatedAt}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
