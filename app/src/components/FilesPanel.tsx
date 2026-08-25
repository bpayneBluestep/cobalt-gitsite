import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError, getFiles, addFile, updateFile, deleteFile,
  createFolder, renameFolder, deleteFolder, formatBytes,
  type FileCabinet,
} from '../api'

/*
 * The company's filing cabinet: eccrm's design, reused rather than reinvented.
 *
 * Folders are not objects. Each entry carries a "/"-separated `folder` path and the
 * tree is derived from every path in use, so there is no folder schema to keep in step
 * with the files. An empty folder survives as a MARKER entry (a folder with no file),
 * because otherwise there would be nothing to remember it by.
 *
 * One deliberate deviation from eccrm: moving a file uses an explicit folder picker
 * rather than drag-and-drop. Dragging is the part that breaks on touch and for anyone
 * using a keyboard, and a picker does the same job while saying where the file is going.
 */

function splitPath(p: string): string[] { return (p || '').split('/').filter(Boolean) }
function parentPath(p: string): string { const s = splitPath(p); s.pop(); return s.join('/') }
function lastSeg(p: string): string { const s = splitPath(p); return s.length ? s[s.length - 1] : '' }
function joinPath(parent: string, name: string): string { return parent ? parent + '/' + name : name }

/** Read a File as base64 without the data: prefix. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export default function FilesPanel({ companyId }: { companyId: string }) {
  const [data, setData] = useState<FileCabinet | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const [newFolder, setNewFolder] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [renaming, setRenaming] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [confirmFolder, setConfirmFolder] = useState('')
  const [confirmFile, setConfirmFile] = useState('')
  const [movingFile, setMovingFile] = useState('')

  const load = useCallback(() => {
    setLoading(true); setError('')
    // Dot-prefixed folders are system storage (Agreements/.sources holds an envelope's
    // original unsigned PDFs) — filtered once at load so the whole panel, counts and
    // pickers included, agrees they don't exist.
    const hidden = (p: string) => (p || '').split('/').some(seg => seg.charAt(0) === '.')
    getFiles(companyId)
      .then(d => {
        const rows = (d.rows || []).filter(r => !hidden(r.folder || ''))
        const real = rows.filter(r => !r.isMarker)
        setData({
          ...d,
          folders: (d.folders || []).filter(f => !hidden(f)),
          rows,
          total: real.length,
          totalBytes: real.reduce((n, r) => n + ((r.file && r.file.size) || 0), 0),
        })
      })
      .catch(err => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [companyId])

  useEffect(load, [load])

  const subfolders = useMemo(() => {
    if (!data) return []
    return data.folders.filter(f => parentPath(f) === path).sort((a, b) =>
      lastSeg(a).toLowerCase().localeCompare(lastSeg(b).toLowerCase()))
  }, [data, path])

  const filesHere = useMemo(() => {
    if (!data) return []
    return data.rows
      .filter(r => !r.isMarker && (r.folder || '') === path)
      .sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()))
  }, [data, path])

  /** Files plus subfolders beneath a folder: what a delete would take with it. */
  function countUnder(folder: string): { files: number; folders: number } {
    if (!data) return { files: 0, folders: 0 }
    const under = (p: string) => p === folder || p.indexOf(folder + '/') === 0
    return {
      files: data.rows.filter(r => !r.isMarker && under(r.folder || '')).length,
      folders: data.folders.filter(f => f !== folder && under(f)).length,
    }
  }

  function after(said: string) {
    setNotice(said); setFailure('')
    setShowNewFolder(false); setNewFolder('')
    setRenaming(''); setConfirmFolder(''); setConfirmFile(''); setMovingFile('')
    load()
  }

  function run(label: string, work: Promise<unknown>, said: string) {
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(() => after(said))
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function upload(files: FileList | null) {
    if (!files || !files.length || !data || busy) return
    const file = files[0]
    if (file.size > data.maxBytes) {
      setFailure(`${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(data.maxBytes)}.`)
      return
    }
    setBusy('upload'); setFailure(''); setNotice('')
    toBase64(file)
      .then(dataBase64 => addFile(companyId, {
        filename: file.name,
        name: file.name,
        folder: path,
        contentType: file.type || 'application/octet-stream',
        dataBase64,
      }))
      .then(() => after(`Uploaded ${file.name}.`))
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  const crumbs = splitPath(path)

  return (
    <section className="tsec">
      <div className="panel__head">
        <h2 className="tsec__h">
          Files
          {data && data.total > 0 && <span className="tsec__n">{data.total}</span>}
        </h2>
        {data && (
          <span className="panel__note">
            {data.total} file{data.total === 1 ? '' : 's'} · {formatBytes(data.totalBytes)}
          </span>
        )}
      </div>

      {loading && <p className="empty">Loading files…</p>}
      {error && <p className="editcard__err" role="alert">{error}</p>}

      {data && (
        <>
          <div className="cab__bar">
            <nav className="crumb cab__crumb" aria-label="Folder path">
              <button type="button" className="linkbtn" onClick={() => setPath('')}>
                {data.companyName || 'Files'}
              </button>
              {crumbs.map((seg, i) => {
                const to = crumbs.slice(0, i + 1).join('/')
                const isLast = i === crumbs.length - 1
                return (
                  <span key={to}>
                    <span aria-hidden="true"> / </span>
                    {isLast
                      ? <span>{seg}</span>
                      : <button type="button" className="linkbtn" onClick={() => setPath(to)}>{seg}</button>}
                  </span>
                )
              })}
            </nav>

            <div className="cab__actions">
              <button type="button" className="btn btn--ghost btn--sm"
                onClick={() => { setShowNewFolder(v => !v); setNewFolder('') }} disabled={!!busy}>
                New folder
              </button>
              <label className="btn btn--sm cab__upload">
                {busy === 'upload' ? 'Uploading…' : 'Upload file'}
                <input type="file" className="drop__input" disabled={!!busy}
                  onChange={e => { upload(e.target.files); e.target.value = '' }} />
              </label>
            </div>
          </div>

          {failure && <p className="editcard__err" role="alert">{failure}</p>}
          {notice && <p className="board2__notice" role="status">{notice}</p>}

          {showNewFolder && (
            <div className="cab__inline">
              <div className="ef">
                <label htmlFor="cab-new">
                  New folder{path ? ` in ${lastSeg(path) || path}` : ''}
                </label>
                <input id="cab-new" type="text" value={newFolder} autoFocus autoComplete="off"
                  placeholder="Signed agreements"
                  onChange={e => setNewFolder(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newFolder.trim()) {
                      run('folder', createFolder(companyId, joinPath(path, newFolder.trim())),
                        `Created ${newFolder.trim()}.`)
                    }
                  }} />
              </div>
              <button type="button" className="btn btn--ghost btn--sm"
                onClick={() => setShowNewFolder(false)} disabled={!!busy}>Cancel</button>
              <button type="button" className="btn btn--sm" disabled={!!busy || !newFolder.trim()}
                onClick={() => run('folder', createFolder(companyId, joinPath(path, newFolder.trim())),
                  `Created ${newFolder.trim()}.`)}>
                Create
              </button>
            </div>
          )}

          {subfolders.length === 0 && filesHere.length === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">This folder is empty</p>
              <p>Upload a file, or make a folder inside it.</p>
            </div>
          ) : (
            <>
              {subfolders.length > 0 && (
                <ul className="cab__folders">
                  {subfolders.map(f => {
                    const under = countUnder(f)
                    return (
                      <li className="cab__folder" key={f}>
                        {renaming === f ? (
                          <div className="cab__inline cab__inline--tight">
                            <input type="text" value={renameTo} autoFocus autoComplete="off"
                              onChange={e => setRenameTo(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && renameTo.trim()) {
                                  run('folder', renameFolder(companyId, f, joinPath(parentPath(f), renameTo.trim())),
                                    `Renamed to ${renameTo.trim()}.`)
                                }
                              }} />
                            <button type="button" className="linkbtn" onClick={() => setRenaming('')} disabled={!!busy}>
                              Cancel
                            </button>
                            <button type="button" className="linkbtn" disabled={!!busy || !renameTo.trim()}
                              onClick={() => run('folder',
                                renameFolder(companyId, f, joinPath(parentPath(f), renameTo.trim())),
                                `Renamed to ${renameTo.trim()}.`)}>
                              Rename
                            </button>
                          </div>
                        ) : confirmFolder === f ? (
                          <div className="cab__inline cab__inline--tight">
                            <span className="board2__confirm">
                              Delete {lastSeg(f)}
                              {under.files > 0 || under.folders > 0
                                ? ` and everything in it (${under.files} file${under.files === 1 ? '' : 's'}${under.folders ? `, ${under.folders} subfolder${under.folders === 1 ? '' : 's'}` : ''})?`
                                : '?'}
                            </span>
                            <button type="button" className="linkbtn" onClick={() => setConfirmFolder('')} disabled={!!busy}>
                              Keep
                            </button>
                            <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                              onClick={() => run('folder', deleteFolder(companyId, f), `Deleted ${lastSeg(f)}.`)}>
                              Delete
                            </button>
                          </div>
                        ) : (
                          <>
                            <button type="button" className="cab__open" onClick={() => setPath(f)}>
                              <span className="cab__icon" aria-hidden="true" />
                              <span className="cab__name">{lastSeg(f)}</span>
                              <span className="cab__count">
                                {under.files || under.folders
                                  ? `${under.files} file${under.files === 1 ? '' : 's'}`
                                  : 'empty'}
                              </span>
                            </button>
                            <span className="cab__folderact">
                              <button type="button" className="linkbtn" disabled={!!busy}
                                onClick={() => { setRenaming(f); setRenameTo(lastSeg(f)) }}>
                                Rename
                              </button>
                              <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                                onClick={() => setConfirmFolder(f)}>
                                Delete
                              </button>
                            </span>
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {filesHere.length > 0 && (
                <div className="tablewrap">
                  <table className="fields cab__files">
                    <thead>
                      <tr>
                        <th scope="col">File</th>
                        <th scope="col">Size</th>
                        <th scope="col">Uploaded</th>
                        <th scope="col">By</th>
                        <th scope="col"><span className="visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filesHere.map(f => (
                        <tr key={f.entryId}>
                          <th scope="row">
                            <span className="cab__filerow">
                              {f.file.thumbUrl
                                ? <img className="cab__thumb" src={f.file.thumbUrl} alt="" />
                                : <span className="cab__fileicon" aria-hidden="true" />}
                              <span>
                                <a className="inlink" href={f.file.url} target="_blank" rel="noopener noreferrer">
                                  {f.name || f.file.filename}
                                </a>
                                {f.file.filename !== f.name && (
                                  <span className="cab__realname">{f.file.filename}</span>
                                )}
                              </span>
                            </span>
                          </th>
                          <td className="nowrap">{formatBytes(f.file.size)}</td>
                          <td className="nowrap">{f.timestamp || <span className="muted">-</span>}</td>
                          <td>{f.uploadedBy || <span className="muted">-</span>}</td>
                          <td className="leads__act">
                            {movingFile === f.entryId ? (
                              <span className="cab__move">
                                <select
                                  aria-label={`Move ${f.name} to another folder`}
                                  defaultValue={f.folder}
                                  disabled={!!busy}
                                  onChange={e => run('move',
                                    updateFile(companyId, f.entryId, { folder: e.target.value }),
                                    `Moved to ${e.target.value || 'the top level'}.`)}
                                >
                                  <option value="">(top level)</option>
                                  {data.folders.map(p => <option key={p} value={p}>{p}</option>)}
                                </select>
                                <button type="button" className="linkbtn" onClick={() => setMovingFile('')} disabled={!!busy}>
                                  Cancel
                                </button>
                              </span>
                            ) : confirmFile === f.entryId ? (
                              <>
                                <span className="board2__confirm">Delete this file?</span>
                                <button type="button" className="linkbtn" onClick={() => setConfirmFile('')} disabled={!!busy}>
                                  Keep
                                </button>
                                <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                                  onClick={() => run('del', deleteFile(companyId, f.entryId), 'File deleted.')}>
                                  Delete
                                </button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="linkbtn" disabled={!!busy}
                                  onClick={() => setMovingFile(f.entryId)}>
                                  Move
                                </button>
                                <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                                  onClick={() => setConfirmFile(f.entryId)}>
                                  Delete
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <p className="panel__foot">
            Up to {formatBytes(data.maxBytes)} per file. Removing a file deletes the stored
            document, though anyone already holding its direct link may still be able to
            fetch it: the platform keeps serving that URL.
          </p>
        </>
      )}
    </section>
  )
}
