import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError, getArtifact, getArtifactFile, getArtifactProposals, decideArtifactProposal,
  type ArtifactFull, type ArtifactProposal, type ManifestRow,
} from '../api'
import { useSession } from '../session'

/*
 * One artifact: the explainer, the files, the versions, the proposals, the history.
 *
 * This page is the reading room, not the workshop. Publishing and proposing are
 * Claude Code's job (the callout says the words to use); what the browser owns is
 * judgment — reading a proposal's explainer and diff, and the owner's approve/reject.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; full: ArtifactFull }
  | { phase: 'error'; error: ApiError }

/*
 * A tiny markdown renderer for explainers: headings, fenced code, inline code, bold,
 * links, lists, paragraphs. Deliberately no dependency and no HTML passthrough —
 * explainer text is data, and a library page must not execute what a bundle says.
 */
function md(text: string): JSX.Element[] {
  const out: JSX.Element[] = []
  const lines = String(text || '').split(/\r?\n/)
  let i = 0, key = 0
  const inline = (t: string): (string | JSX.Element)[] => {
    const parts: (string | JSX.Element)[] = []
    let rest = t
    const rx = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/
    while (rest) {
      const m = rx.exec(rest)
      if (!m) { parts.push(rest); break }
      if (m.index > 0) parts.push(rest.slice(0, m.index))
      const tok = m[0]
      if (tok.startsWith('`')) parts.push(<code key={++key}>{tok.slice(1, -1)}</code>)
      else if (tok.startsWith('**')) parts.push(<b key={++key}>{tok.slice(2, -2)}</b>)
      else {
        const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)
        if (mm) parts.push(<a key={++key} className="inlink" href={mm[2]} target="_blank" rel="noopener noreferrer">{mm[1]}</a>)
      }
      rest = rest.slice(m.index + tok.length)
    }
    return parts
  }
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const buf: string[] = []; i++
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      out.push(<pre key={++key} className="md-pre"><code>{buf.join('\n')}</code></pre>)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      out.push(level <= 2 ? <h3 key={++key}>{inline(h[2])}</h3> : <h4 key={++key}>{inline(h[2])}</h4>)
      i++; continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: JSX.Element[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(<li key={++key}>{inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>); i++
      }
      out.push(<ul key={++key}>{items}</ul>)
      continue
    }
    if (!line.trim()) { i++; continue }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^```|^\s*[-*]\s+/.test(lines[i])) { buf.push(lines[i]); i++ }
    out.push(<p key={++key}>{inline(buf.join(' '))}</p>)
  }
  return out
}

function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/* Browser download of one stored file, via the same base64 action Claude uses —
 * permUrls also work, but this keeps the page functional even if a permUrl rots. */
function useFileDownload() {
  const [busy, setBusy] = useState('')
  const download = (artifactId: string, row: ManifestRow) => {
    if (busy) return
    setBusy(row.fileEntryId)
    getArtifactFile(artifactId, row.fileEntryId)
      .then(f => {
        const bytes = atob(f.dataBase64)
        const arr = new Uint8Array(bytes.length)
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([arr]))
        const a = document.createElement('a')
        a.href = url; a.download = row.name || row.path
        a.click()
        URL.revokeObjectURL(url)
      })
      .finally(() => setBusy(''))
  }
  return { download, busy }
}

function ProposalPanel({ full, reload }: { full: ArtifactFull; reload: () => void }) {
  const { session } = useSession()
  const [rows, setRows] = useState<ArtifactProposal[] | null>(null)
  const [deciding, setDeciding] = useState('')
  const [comment, setComment] = useState('')
  const [rejecting, setRejecting] = useState('')
  const [failure, setFailure] = useState('')

  const isOwner = session && String(session.userId) === String(full.artifact.ownerId)

  useEffect(() => {
    getArtifactProposals(full.artifact.id).then(d => setRows(d.rows)).catch(() => setRows([]))
  }, [full.artifact.id])

  if (!rows || rows.length === 0) return null
  const open = rows.filter(r => r.status === 'Open')
  const decided = rows.filter(r => r.status !== 'Open')

  const decide = (entryId: string, approve: boolean) => {
    if (deciding) return
    setDeciding(entryId); setFailure('')
    decideArtifactProposal(full.artifact.id, entryId, approve, comment.trim())
      .then(() => { setRejecting(''); setComment(''); reload() })
      .catch((e: unknown) => setFailure(e instanceof ApiError ? e.message : 'Could not decide the proposal.'))
      .finally(() => setDeciding(''))
  }

  return (
    <section className="res-panel">
      <h2>Proposals</h2>
      {failure && <p className="editcard__err" role="alert">{failure}</p>}
      {open.map(pr => (
        <div key={pr.entryId} className="res-proposal">
          <div className="res-proposal__head">
            <b>{pr.proposerName}</b> proposes a new version
            <span className="muted"> · against v{pr.baseVersion} · {pr.createdAt}</span>
          </div>
          <div className="res-md">{md(pr.explainer)}</div>
          {pr.diff && (
            <p className="res-diff">
              {pr.diff.added.length > 0 && <span className="res-diff__add">+ {pr.diff.added.join(', ')}</span>}
              {pr.diff.changed.length > 0 && <span className="res-diff__chg">~ {pr.diff.changed.join(', ')}</span>}
              {pr.diff.removed.length > 0 && <span className="res-diff__del">− {pr.diff.removed.join(', ')}</span>}
              {pr.diff.added.length + pr.diff.changed.length + pr.diff.removed.length === 0 && <span className="muted">No file changes.</span>}
            </p>
          )}
          {isOwner && (
            <div className="res-proposal__acts">
              {rejecting === pr.entryId ? (
                <>
                  <input className="input" placeholder="Why not? (required — the proposer sees this)"
                    value={comment} onChange={e => setComment(e.target.value)} autoFocus />
                  <button type="button" className="btn btn--ghost" onClick={() => setRejecting('')}>Cancel</button>
                  <button type="button" className="btn btn--danger" disabled={!comment.trim() || !!deciding}
                    onClick={() => decide(pr.entryId, false)}>Reject</button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn--ghost btn--del"
                    onClick={() => { setRejecting(pr.entryId); setComment('') }}>Reject…</button>
                  <button type="button" className="btn" disabled={!!deciding}
                    onClick={() => decide(pr.entryId, true)}>
                    {deciding === pr.entryId ? 'Merging…' : `Approve as v${full.artifact.currentVersion + 1}`}
                  </button>
                </>
              )}
            </div>
          )}
          {!isOwner && <p className="muted">Only {full.artifact.ownerName} can decide this.</p>}
        </div>
      ))}
      {decided.length > 0 && (
        <details className="res-decided">
          <summary>{decided.length} decided proposal{decided.length === 1 ? '' : 's'}</summary>
          {decided.map(pr => (
            <div key={pr.entryId} className="res-proposal res-proposal--done">
              <div className="res-proposal__head">
                <b>{pr.proposerName}</b> · {pr.status}
                <span className="muted"> · {pr.decidedAt || pr.createdAt}</span>
              </div>
              {pr.decisionComment && <p className="muted">“{pr.decisionComment}”</p>}
            </div>
          ))}
        </details>
      )}
    </section>
  )
}

export default function ArtifactPage() {
  const { id } = useParams()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [version, setVersion] = useState(0)
  const dl = useFileDownload()

  const load = useCallback(() => {
    getArtifact(String(id), version || undefined)
      .then(full => setState({ phase: 'ready', full }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [id, version])

  useEffect(load, [load])

  if (state.phase === 'loading') return <div className="page"><p className="empty">Loading artifact…</p></div>
  if (state.phase === 'error') {
    return (
      <div className="page">
        <div className="callout">
          <p className="callout__title">Could not load this artifact</p>
          <p>{state.error.message}</p>
          <p className="callout__actions"><Link className="btn" to="/resources">Back to Resources</Link></p>
        </div>
      </div>
    )
  }

  const { full } = state
  const a = full.artifact
  const current = full.versions.filter(v => v.versionNumber === full.version)[0]

  return (
    <div className="page">
      <header className="page__head">
        <p className="eyebrow"><Link className="inlink" to="/resources">Resources</Link> / v{full.version}</p>
        <h1>{a.title}</h1>
        <p className="page__sub-text">
          {a.summary}
          {a.status === 'Archived' && <> · <b>Archived</b></>}
        </p>
        <div className="res-card__meta">
          {a.tags.map(t => <span key={t} className="res-tag">{t}</span>)}
          <span className="muted">owner {a.ownerName}</span>
          {a.parentArtifactId && (
            <Link className="inlink" to={`/resources/${a.parentArtifactId}`}>forked from another artifact</Link>
          )}
        </div>
      </header>

      <div className="callout callout--plain res-pull">
        <p className="callout__title">Pull with Claude Code</p>
        <p>
          In any BlueStep workspace: <code>pull the {a.slug} artifact from cobalt</code> —
          the files land in <code>./artifacts/{a.slug}/</code>, explainer included.
        </p>
      </div>

      {current && (
        <section className="res-panel">
          <h2>About v{full.version}
            {current.contributorName && <span className="muted"> · contributed by {current.contributorName}</span>}
          </h2>
          <div className="res-md">{md(current.explainer)}</div>
        </section>
      )}

      {a.runsLive.length > 0 && (
        <section className="res-panel">
          <h2>Where this runs live</h2>
          <ul>
            {a.runsLive.map((r, i) => (
              <li key={i}>
                {r.url
                  ? <a className="inlink" href={r.url} target="_blank" rel="noopener noreferrer">{r.label || r.url}</a>
                  : r.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="res-panel">
        <h2>Files</h2>
        <div className="tablewrap">
          <table className="fields">
            <thead><tr><th scope="col">Path</th><th scope="col">Size</th><th scope="col"></th></tr></thead>
            <tbody>
              {full.manifest.map(row => (
                <tr key={row.fileEntryId}>
                  <th scope="row"><code className="db">{row.path}</code></th>
                  <td>{fmtSize(row.size)}</td>
                  <td>
                    <button type="button" className="btn btn--ghost btn--sm"
                      disabled={dl.busy === row.fileEntryId}
                      onClick={() => dl.download(a.id, row)}>
                      {dl.busy === row.fileEntryId ? 'Fetching…' : 'Download'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ProposalPanel full={full} reload={load} />

      <section className="res-panel">
        <h2>Versions</h2>
        {full.versions.slice().reverse().map(v => (
          <div key={v.versionNumber} className="res-version">
            <div className="res-proposal__head">
              <button type="button" className="linkbtn"
                onClick={() => setVersion(v.versionNumber)}>
                <b>v{v.versionNumber}</b>
              </button>
              {' '}· {v.authorName}
              {v.contributorName && <> (contributed by {v.contributorName})</>}
              <span className="muted"> · {v.createdAt} · {v.fileCount} file{v.fileCount === 1 ? '' : 's'}</span>
              {v.versionNumber === full.version && <span className="res-card__v"> viewing</span>}
            </div>
            {v.versionNumber !== full.version && v.explainer && (
              <p className="muted res-version__ex">{v.explainer.split('\n')[0]}</p>
            )}
          </div>
        ))}
      </section>

      <section className="res-panel">
        <h2>Activity</h2>
        <ul className="res-history">
          {a.history.slice().reverse().map((h, i) => (
            <li key={i}>
              <span className="muted">{String(h.at).slice(0, 10)}</span> — {h.event}
              {h.version ? <> (v{String(h.version)})</> : null} · {h.by}
              {h.contributor ? <> · contributor {String(h.contributor)}</> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
