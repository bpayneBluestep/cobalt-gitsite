import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError, getTicketTemplates, saveTicketTemplate, setTicketTemplateStatus,
  deleteTicketTemplate,
  type TicketTemplate, type TicketTemplateList, type TemplateTask,
} from '../api'
import RichTextEditor from './RichTextEditor'

/*
 * Settings → Templates.
 *
 * A ticket template is a reusable tree: author the thirty onboarding steps once,
 * then apply them to a client's list from that board. This panel is the authoring
 * half; the applying half lives on the board.
 *
 * THE EDITOR WORKS ON A FLAT LIST, NOT A TREE. Every row carries a `depth` of 0 or
 * 1, and the nesting is reconstructed on save. Indent, outdent, move-up and
 * move-down over a flat array are a few lines each; the same four operations over a
 * nested structure mean splicing children between parents and re-deriving which
 * node is where on every click. The stored shape is still nested — `toNested` is
 * the one place the two representations meet.
 *
 * ONE LEVEL OF NESTING, because that is what a ticket can carry: Cobalt allows a
 * subtask but not a sub-subtask. The indent button disables itself rather than
 * letting someone build a tree the server will reject, and the server re-checks.
 *
 * Status is what gates a template: only Active ones are offered on a board, so
 * Draft is a genuine work-in-progress state rather than a label.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: TicketTemplateList }
  | { phase: 'error'; error: ApiError }

/** One editor row. `key` is local to this editing session; ids come back on save. */
interface Row {
  key: string
  title: string
  details: string
  estHours: string
  priority: string
  depth: 0 | 1
  /** Whether this row's rich-text body is expanded. Purely presentational. */
  open: boolean
}

interface Draft {
  entryId: string | null
  orgId: string
  name: string
  description: string
  category: string
  status: string
  rows: Row[]
}

let seq = 0
const newKey = () => 'r' + (++seq)

const emptyRow = (depth: 0 | 1 = 0): Row => ({
  key: newKey(), title: '', details: '', estHours: '', priority: '', depth, open: false,
})

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

/** Stored tree → flat rows. */
function toRows(tasks: TemplateTask[]): Row[] {
  const out: Row[] = []
  for (const t of tasks || []) {
    out.push({
      key: newKey(),
      title: t.title || '',
      details: t.details || '',
      estHours: t.estHours ? String(t.estHours) : '',
      priority: t.priority || '',
      depth: 0,
      open: false,
    })
    for (const c of t.children || []) {
      out.push({
        key: newKey(),
        title: c.title || '',
        details: c.details || '',
        estHours: c.estHours ? String(c.estHours) : '',
        priority: c.priority || '',
        depth: 1,
        open: false,
      })
    }
  }
  return out
}

/**
 * Flat rows → the stored tree.
 *
 * A depth-1 row with no group above it is promoted rather than dropped: losing a
 * task because of where it happened to sit is the worst possible outcome here.
 */
function toNested(rows: Row[]): TemplateTask[] {
  const out: TemplateTask[] = []
  for (const r of rows) {
    const leaf: TemplateTask = { id: '', title: r.title.trim() }
    if (r.details.trim()) leaf.details = r.details
    const est = Number(r.estHours)
    if (r.estHours !== '' && isFinite(est) && est > 0) leaf.estHours = est
    if (r.priority) leaf.priority = r.priority
    if (r.depth === 1 && out.length) {
      const parent = out[out.length - 1]
      if (!parent.children) parent.children = []
      parent.children.push(leaf)
    } else {
      out.push(leaf)
    }
  }
  return out
}

/** The block a row owns: a group carries its children, a leaf is just itself. */
function blockOf(rows: Row[], i: number): [number, number] {
  if (rows[i].depth === 1) return [i, i]
  let end = i
  while (end + 1 < rows.length && rows[end + 1].depth === 1) end += 1
  return [i, end]
}

/** How many tickets applying this would create, by the server's own rule. */
function countLeaves(rows: Row[]): number {
  let n = 0
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].depth === 1) { n += 1; continue }
    const [, end] = blockOf(rows, i)
    n += end > i ? 0 : 1 // a group contributes only its children
  }
  return n
}

export default function TicketTemplatesPanel() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [confirmDelete, setConfirmDelete] = useState('')

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getTicketTemplates()
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load() }, [load])

  const d = state.phase === 'ready' ? state.data : null
  const rows = useMemo(() => d?.rows || [], [d])
  const categories = d?.categories || []
  const priorities = d?.priorities || []
  const statuses = d?.statuses || []
  const orgs = d?.orgs || []

  function startNew() {
    setFailure(''); setNotice('')
    setDraft({
      entryId: null,
      orgId: orgs[0]?.orgId || '',
      name: '',
      description: '',
      category: categories[0] || 'Onboarding',
      status: 'Draft',
      rows: [emptyRow()],
    })
  }

  function startEdit(t: TicketTemplate) {
    setFailure(''); setNotice('')
    setDraft({
      entryId: t.entryId,
      orgId: t.orgId,
      name: t.name,
      description: t.description,
      category: t.category || (categories[0] || 'Onboarding'),
      status: t.status || 'Draft',
      rows: toRows(t.tasks).length ? toRows(t.tasks) : [emptyRow()],
    })
  }

  const setRows = (fn: (rs: Row[]) => Row[]) =>
    setDraft(p => (p ? { ...p, rows: fn(p.rows) } : p))

  const patchRow = (key: string, patch: Partial<Row>) =>
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))

  function addRow(afterKey?: string) {
    setRows(rs => {
      if (!afterKey) return [...rs, emptyRow()]
      const i = rs.findIndex(r => r.key === afterKey)
      if (i < 0) return [...rs, emptyRow()]
      // A new row under a group member joins that group, which is what "add here" means.
      const next = [...rs]
      next.splice(i + 1, 0, emptyRow(rs[i].depth))
      return next
    })
  }

  function removeRow(key: string) {
    setRows(rs => {
      const i = rs.findIndex(r => r.key === key)
      if (i < 0) return rs
      const [start, end] = blockOf(rs, i)
      // Deleting a group takes its children: they cannot outlive their only heading.
      const next = [...rs]
      next.splice(start, end - start + 1)
      return next.length ? next : [emptyRow()]
    })
  }

  function indent(key: string) {
    setRows(rs => {
      const i = rs.findIndex(r => r.key === key)
      if (i <= 0 || rs[i].depth === 1) return rs
      const [, end] = blockOf(rs, i)
      // A group with children cannot become a child: that would be three levels.
      if (end > i) return rs
      return rs.map((r, n) => (n === i ? { ...r, depth: 1 as const } : r))
    })
  }

  function outdent(key: string) {
    setRows(rs => rs.map(r => (r.key === key && r.depth === 1 ? { ...r, depth: 0 as const } : r)))
  }

  /** Where the block containing row `i` begins. */
  function blockStartOf(rs: Row[], i: number): number {
    if (rs[i].depth === 0) return i
    let s = i
    while (s > 0 && rs[s].depth === 1) s -= 1
    return s
  }

  /**
   * Reorder, respecting the nesting.
   *
   * A step moves only WITHIN its group — sliding it past the group boundary would
   * silently re-parent it, which is a different edit from the one the arrow implies.
   * A heading moves as a whole block, stepping over the entire neighbouring block
   * rather than one row, for the same reason: a one-row step would drop it inside
   * the group next door.
   */
  function move(key: string, dir: -1 | 1) {
    setRows(rs => {
      const i = rs.findIndex(r => r.key === key)
      if (i < 0) return rs

      if (rs[i].depth === 1) {
        const j = dir === -1 ? i - 1 : i + 1
        if (j < 0 || j >= rs.length) return rs
        if (rs[j].depth !== 1) return rs // would leave the group
        const next = [...rs]
        next[i] = rs[j]
        next[j] = rs[i]
        return next
      }

      const [start, end] = blockOf(rs, i)
      const block = rs.slice(start, end + 1)

      if (dir === -1) {
        if (start === 0) return rs
        const prevStart = blockStartOf(rs, start - 1)
        const next = [...rs]
        next.splice(start, block.length)
        next.splice(prevStart, 0, ...block)
        return next
      }

      if (end === rs.length - 1) return rs
      const [, nextEnd] = blockOf(rs, end + 1)
      const next = [...rs]
      next.splice(start, block.length)
      // Indices past `start` have shifted down by the block we just lifted out.
      next.splice(nextEnd - block.length + 1, 0, ...block)
      return next
    })
  }

  async function save() {
    if (!draft) return
    setFailure(''); setNotice('')
    if (!draft.name.trim()) { setFailure('A template needs a name.'); return }
    const blank = draft.rows.findIndex(r => !r.title.trim())
    if (blank >= 0) { setFailure('Task ' + (blank + 1) + ' has no title.'); return }

    setBusy('save')
    try {
      const saved = await saveTicketTemplate({
        entryId: draft.entryId || undefined,
        orgId: draft.entryId ? undefined : (draft.orgId || undefined),
        name: draft.name.trim(),
        description: draft.description,
        category: draft.category,
        status: draft.status,
        tasks: toNested(draft.rows),
      })
      setNotice('Saved “' + saved.name + '” (v' + saved.version + ', ' + saved.taskCount + ' tasks).')
      setDraft(null)
      load()
    } catch (e) {
      setFailure(errMsg(e))
    } finally {
      setBusy('')
    }
  }

  async function flipStatus(t: TicketTemplate, status: string) {
    setFailure(''); setNotice('')
    setBusy(t.entryId)
    try {
      await setTicketTemplateStatus(t.entryId, status)
      setNotice('“' + t.name + '” is now ' + status + '.')
      load()
    } catch (e) { setFailure(errMsg(e)) } finally { setBusy('') }
  }

  async function remove(t: TicketTemplate) {
    setFailure(''); setNotice('')
    setBusy(t.entryId)
    try {
      await deleteTicketTemplate(t.entryId)
      setNotice('Deleted “' + t.name + '”. Tickets already made from it are untouched.')
      setConfirmDelete('')
      load()
    } catch (e) { setFailure(errMsg(e)) } finally { setBusy('') }
  }

  // ── the editor ─────────────────────────────────────────────────────────────
  if (draft) {
    const leaves = countLeaves(draft.rows)
    return (
      <section className="panel">
        <div className="editcard">
          <div className="editcard__head">
            <h2>{draft.entryId ? 'Edit template' : 'New template'}</h2>
            <span className="editcard__status muted">
              applying this creates 1 parent + {leaves} subtask{leaves === 1 ? '' : 's'}
            </span>
          </div>

          {failure && <p className="editcard__err">{failure}</p>}

          <div className="efgrid">
            <label className="ef ef--wide">
              <span>Name</span>
              <input value={draft.name} maxLength={120}
                onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="ef">
              <span>Category</span>
              <select value={draft.category}
                onChange={e => setDraft({ ...draft, category: e.target.value })}>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="ef">
              <span>Status</span>
              <select value={draft.status}
                onChange={e => setDraft({ ...draft, status: e.target.value })}>
                {statuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="ef__hint">Only Active templates are offered on a board.</span>
            </label>
            <label className="ef ef--wide">
              <span>Description</span>
              <input value={draft.description} maxLength={400}
                onChange={e => setDraft({ ...draft, description: e.target.value })} />
              <span className="ef__hint">
                Shown in the picker, and copied onto the parent ticket when applied.
              </span>
            </label>
          </div>

          <h3 className="tpl__h">Tasks</h3>
          <p className="note">
            Indent a task to make it a step inside the one above. On apply, an indented
            step becomes a subtask titled <code>Group: Step</code> — one level is all a
            ticket can carry. A heading’s own notes go onto the parent ticket.
          </p>

          <ol className="tpl__rows">
            {draft.rows.map((r, i) => {
              const [, end] = blockOf(draft.rows, i)
              const isGroup = r.depth === 0 && end > i
              const canIndent = i > 0 && r.depth === 0 && !isGroup
              return (
                <li key={r.key} className="tpl__row" data-depth={r.depth}>
                  <div className="tpl__main">
                    <span className="tpl__grip muted" aria-hidden="true">
                      {r.depth === 1 ? '↳' : isGroup ? '▾' : '•'}
                    </span>
                    <input className="tpl__title" value={r.title}
                      placeholder={r.depth === 1 ? 'Step title' : 'Task or heading title'}
                      aria-label={'Task ' + (i + 1) + ' title'}
                      onChange={e => patchRow(r.key, { title: e.target.value })} />
                    <input className="tpl__est" value={r.estHours} inputMode="decimal"
                      placeholder="hrs" aria-label={'Task ' + (i + 1) + ' estimate in hours'}
                      onChange={e => patchRow(r.key, { estHours: e.target.value })} />
                    <select className="tpl__pri" value={r.priority}
                      aria-label={'Task ' + (i + 1) + ' priority'}
                      onChange={e => patchRow(r.key, { priority: e.target.value })}>
                      <option value="">Priority…</option>
                      {priorities.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>

                  <div className="tpl__tools">
                    <button type="button" className="btn btn--sm btn--ghost" title="Move up"
                      onClick={() => move(r.key, -1)} disabled={i === 0}>↑</button>
                    <button type="button" className="btn btn--sm btn--ghost" title="Move down"
                      onClick={() => move(r.key, 1)}
                      disabled={end === draft.rows.length - 1}>↓</button>
                    <button type="button" className="btn btn--sm btn--ghost"
                      title={isGroup ? 'A heading with steps cannot itself be a step' : 'Make this a step of the task above'}
                      onClick={() => indent(r.key)} disabled={!canIndent}>→</button>
                    <button type="button" className="btn btn--sm btn--ghost" title="Promote to its own task"
                      onClick={() => outdent(r.key)} disabled={r.depth === 0}>←</button>
                    <button type="button" className="btn btn--sm btn--ghost"
                      aria-expanded={r.open}
                      onClick={() => patchRow(r.key, { open: !r.open })}>
                      {r.details.trim() ? 'Notes ✓' : 'Notes'}
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost" title="Add a task below"
                      onClick={() => addRow(r.key)}>+</button>
                    <button type="button" className="btn btn--sm btn--ghost"
                      title={isGroup ? 'Delete this heading and its steps' : 'Delete this task'}
                      onClick={() => removeRow(r.key)}>✕</button>
                  </div>

                  {r.open && (
                    <div className="tpl__notes">
                      <RichTextEditor
                        value={r.details}
                        docKey={draft.entryId + ':' + r.key}
                        ariaLabel={'Notes for task ' + (i + 1)}
                        placeholder={isGroup
                          ? 'Context for this whole group — goes onto the parent ticket.'
                          : 'What this step involves. Copied onto the subtask.'}
                        onChange={html => patchRow(r.key, { details: html })}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ol>

          <button type="button" className="btn btn--ghost" onClick={() => addRow()}>
            + Add task
          </button>

          <div className="editcard__foot">
            <button type="button" className="btn" onClick={save} disabled={busy === 'save'}>
              {busy === 'save' ? 'Saving…' : 'Save template'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setDraft(null)}
              disabled={busy === 'save'}>
              Cancel
            </button>
          </div>
        </div>
      </section>
    )
  }

  // ── the library ────────────────────────────────────────────────────────────
  return (
    <section className="panel">
      <p className="note">
        A template is a reusable set of tickets: author the steps once here, then apply
        them to any list from its board. Applying creates one parent ticket with a
        subtask per step, and never links back — editing a template leaves tickets
        already created from it exactly as they are.
      </p>

      {notice && <p className="callout"><span className="callout__title">{notice}</span></p>}
      {failure && <p className="editcard__err">{failure}</p>}

      {state.phase === 'loading' && <p className="empty">Loading templates…</p>}
      {state.phase === 'error' && (
        <p className="editcard__err">Could not load templates: {state.error.message}</p>
      )}

      {state.phase === 'ready' && (
        <>
          <button type="button" className="btn" onClick={startNew}>+ New template</button>

          {!rows.length && (
            <p className="empty">
              No templates yet. The obvious first one is new-client onboarding.
            </p>
          )}

          {!!rows.length && (
            <div className="tablewrap">
              <table className="fields">
                <thead>
                  <tr>
                    <th>Name</th><th>Category</th><th>Status</th>
                    <th>Creates</th><th>Last changed</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(t => (
                    <tr key={t.entryId}>
                      <td>
                        <button type="button" className="linkbtn" onClick={() => startEdit(t)}>
                          {t.name || '(untitled)'}
                        </button>
                        {t.description && <div className="muted">{t.description}</div>}
                        {t.bodyError && <div className="tag tag--warn">{t.bodyError}</div>}
                      </td>
                      <td>{t.category || '—'}</td>
                      <td>
                        <span className="tag" data-on={t.status === 'Active' ? '' : undefined}>
                          {t.status}
                        </span>
                      </td>
                      <td>
                        {t.taskCount} ticket{t.taskCount === 1 ? '' : 's'}
                        {t.groupCount ? <span className="muted"> · {t.groupCount} group{t.groupCount === 1 ? '' : 's'}</span> : null}
                      </td>
                      <td className="muted">
                        {t.updatedAt || t.createdAt || '—'}
                        {t.updatedBy ? ' · ' + t.updatedBy : ''}
                        {t.version ? ' · v' + t.version : ''}
                      </td>
                      <td>
                        <button type="button" className="btn btn--sm btn--ghost"
                          onClick={() => startEdit(t)}>Edit</button>
                        {t.status !== 'Active' && (
                          <button type="button" className="btn btn--sm btn--ghost"
                            disabled={busy === t.entryId}
                            onClick={() => flipStatus(t, 'Active')}>Activate</button>
                        )}
                        {t.status === 'Active' && (
                          <button type="button" className="btn btn--sm btn--ghost"
                            disabled={busy === t.entryId}
                            onClick={() => flipStatus(t, 'Archived')}>Archive</button>
                        )}
                        {confirmDelete === t.entryId ? (
                          <>
                            <button type="button" className="btn btn--sm"
                              disabled={busy === t.entryId}
                              onClick={() => remove(t)}>Really delete</button>
                            <button type="button" className="btn btn--sm btn--ghost"
                              onClick={() => setConfirmDelete('')}>No</button>
                          </>
                        ) : (
                          <button type="button" className="btn btn--sm btn--ghost"
                            onClick={() => setConfirmDelete(t.entryId)}>Delete</button>
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
    </section>
  )
}
