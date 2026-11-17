import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { getArtifacts, createArtifact, ApiError, ARTIFACT_CATEGORIES, type ArtifactCard } from '../api'

/*
 * The Resources library. The landing is one big button per category; a category
 * opens to its artifacts as cards. Searching from the landing cuts across every
 * category, so a person who knows the name never has to guess the shelf.
 *
 * Filtering is client-side over the full card list — the same call Claude Code makes,
 * so what a person can find here and what an engineer's Claude can find are by
 * construction the same set.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: ArtifactCard[]; categories: string[] }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)


/* Read chosen files as {path, dataBase64} rows — the exact payload Claude sends. */
async function readFileRows(list: FileList | null): Promise<{ path: string; dataBase64: string }[]> {
  if (!list) return []
  const rows: { path: string; dataBase64: string }[] = []
  for (const f of Array.from(list)) {
    const buf = await f.arrayBuffer()
    let bin = ''
    const u8 = new Uint8Array(buf)
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
    rows.push({ path: (f as any).webkitRelativePath || f.name, dataBase64: btoa(bin) })
  }
  return rows
}

/*
 * The browser publish form. Second fiddle on purpose: Claude Code assembles better
 * bundles (it can pull component source and write the explainer with you), but a
 * form must exist so the library never depends on one tool being installed.
 */
function NewArtifact({ categories, onDone, onClose }: { categories: string[]; onDone: () => void; onClose: () => void }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [summary, setSummary] = useState('')
  const [explainer, setExplainer] = useState('')
  const [files, setFiles] = useState<FileList | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setFailure('')
    try {
      const rows = await readFileRows(files)
      const full = await createArtifact({
        title: title.trim(), category, summary: summary.trim(),
        explainer: explainer.trim(), files: rows,
      })
      onDone()
      navigate(`/resources/${full.artifact.slug || full.artifact.id}`)
    } catch (err) {
      setBusy(false)
      setFailure(err instanceof ApiError ? err.message : 'Could not publish the artifact.')
    }
  }

  return (
    <form className="editcard res-newform" onSubmit={submit}>
      <div className="editcard__head">
        <h2>New artifact</h2>
        <p className="note">
          Claude Code publishes richer bundles (it can pull component source and draft the
          explainer with you) — but everything works from here too.
        </p>
      </div>
      {failure && <p className="editcard__err" role="alert">{failure}</p>}
      <div className="ef"><label htmlFor="na-title">Title<span className="ef__req" aria-hidden="true">*</span></label>
        <input id="na-title" type="text" value={title} autoFocus autoComplete="off" onChange={e => setTitle(e.target.value)} /></div>
      <div className="ef"><label htmlFor="na-cat">Category<span className="ef__req" aria-hidden="true">*</span></label>
        <select id="na-cat" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">Choose one…</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select></div>
      <div className="ef"><label htmlFor="na-sum">Summary</label>
        <input id="na-sum" type="text" value={summary} autoComplete="off" placeholder="One sentence: what problem this solves" onChange={e => setSummary(e.target.value)} /></div>
      <div className="ef"><label htmlFor="na-ex">Explainer<span className="ef__req" aria-hidden="true">*</span></label>
        <textarea id="na-ex" rows={5} value={explainer}
          placeholder="What this is, how it works, and what the next engineer needs to know. Markdown welcome."
          onChange={e => setExplainer(e.target.value)} /></div>
      <div className="ef"><label htmlFor="na-files">Files<span className="ef__req" aria-hidden="true">*</span></label>
        <input id="na-files" type="file" multiple onChange={e => setFiles(e.target.files)} /></div>
      <div className="editcard__foot">
        <span className="editcard__status">{busy ? 'Publishing…' : 'Title, category, explainer and at least one file are required.'}</span>
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn" disabled={busy || !title.trim() || !category || !explainer.trim() || !files || files.length === 0}>Publish v1</button>
      </div>
    </form>
  )
}

/* What lives on each shelf, shown on its button. A category the endpoint adds later
 * simply gets a button without a blurb. */
const CATEGORY_BLURB: Record<string, string> = {
  'Claude Skills': 'Skills and mods for Claude Code',
  'Feature Concepts': 'Reference builds and ideas for the product',
  'Marketing/Branding': 'Brand kits, handouts and booth material',
  'Internal Processes': 'How we migrate, set up and run things',
  'Legal': 'Agreement templates',
}

/** The `?category=` value for artifacts with no category (old archived test rows). */
const NONE = 'none'

export default function Resources() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [pubOpen, setPubOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  /** The open category lives in the URL so Back returns to the buttons and a
   *  category can be linked to. '' = the landing. */
  const [params, setParams] = useSearchParams()
  const category = params.get('category') || ''
  const setCategory = (c: string) => setParams(c ? { category: c } : {})

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getArtifacts(showArchived ? { includeArchived: 'true' } : {})
      .then(d => setState({
        phase: 'ready', rows: d.rows,
        categories: d.categories && d.categories.length ? d.categories : ARTIFACT_CATEGORIES,
      }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [showArchived])

  useEffect(load, [load])

  const rows = state.phase === 'ready' ? state.rows : []
  const categories = state.phase === 'ready' ? state.categories : ARTIFACT_CATEGORIES
  const q = search.trim().toLowerCase()

  const inCategory = useCallback(
    (r: ArtifactCard, c: string) => c === NONE ? !r.category : r.category === c, [])

  const shown = useMemo(() => rows.filter(r => {
    if (category && !inCategory(r, category)) return false
    if (!q) return true
    return [r.title, r.summary, r.slug, r.ownerName, r.category]
      .some(v => String(v || '').toLowerCase().includes(q))
  }), [rows, category, q, inCategory])

  // Only archived test artifacts can lack a category; they get a button only if present.
  const uncategorised = rows.filter(r => !r.category).length
  const tiles = uncategorised > 0 ? [...categories, NONE] : categories
  const label = (c: string) => c === NONE ? 'Uncategorised' : c
  /** The landing: no category open and nothing typed in search. */
  const landing = !category && !q
  const plural = (n: number) => `${n} resource${n === 1 ? '' : 's'}`

  return (
    <div className="page">
      <header className="page__head">
        <div className="page__head-row">
          <div>
            <p className="eyebrow">The library</p>
            <h1>Resources</h1>
          </div>
          <div className="page__head-tools">
            {!pubOpen && (
              <button type="button" className="btn" onClick={() => setPubOpen(true)}>
                <span aria-hidden="true">+</span> New artifact
              </button>
            )}
            {rows.length > 0 && (
              <div className="ef ef--narrow">
                <label htmlFor="res-search">Search</label>
                <input
                  id="res-search"
                  type="search"
                  value={search}
                  autoComplete="off"
                  placeholder={category ? `Search ${label(category)}…` : 'Search everything…'}
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

      {pubOpen && <NewArtifact categories={categories} onDone={load} onClose={() => setPubOpen(false)} />}

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
          <div className="stage">
            {category ? (
              <div className="res-crumb">
                <button type="button" className="btn btn--ghost" onClick={() => { setSearch(''); setCategory('') }}>
                  <span aria-hidden="true">←</span> All categories
                </button>
                <h2 className="res-crumb__name">{label(category)}</h2>
              </div>
            ) : (
              <p className="page__count res-crumb__hint">
                {landing ? 'Pick a category to open it.' : 'Results from every category'}
              </p>
            )}
            <label className="res-archived">
              <input type="checkbox" checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)} /> archived
            </label>
          </div>

          {landing && (
            <div className="res-tiles">
              {tiles.map(c => {
                const n = rows.filter(r => inCategory(r, c)).length
                return (
                  <button key={c} type="button" className="res-tile" onClick={() => setCategory(c)}>
                    <span className="res-tile__name">{label(c)}</span>
                    {CATEGORY_BLURB[c] && <span className="res-tile__blurb">{CATEGORY_BLURB[c]}</span>}
                    <span className="res-tile__n">{plural(n)}</span>
                  </button>
                )
              })}
            </div>
          )}

          {!landing && (
            <>
              <p className="page__count">{plural(shown.length)}</p>

              {shown.length === 0 && (
                <div className="callout callout--plain">
                  <p className="callout__title">{q ? 'No match' : 'Nothing here yet'}</p>
                  <p>
                    {q
                      ? <>Nothing matches “{search.trim()}”{category ? <> in {label(category)}</> : null}.{' '}
                          <button type="button" className="linkbtn" onClick={() => setSearch('')}>Clear search</button>.</>
                      : <>No resources in {label(category)} yet.</>}
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
                    {!category && r.category && <span className="res-cat">{r.category}</span>}
                    {r.summary && <p className="res-card__sum">{r.summary}</p>}
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
        </>
      )}
    </div>
  )
}
