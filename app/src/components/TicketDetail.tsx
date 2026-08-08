import { useEffect, useState } from 'react'
import {
  ApiError, updateTicket, deleteTicket,
  logTime, editTime, deleteTime, startTimer, stopTimer,
  setRoadblock, uploadAttachment, deleteAttachment,
  formatHours, formatMinutes, formatBytes, MAX_ATTACHMENT_BYTES,
  TICKET_STATUSES, TICKET_PRIORITIES,
  type Ticket, type TicketFieldKey, type TimeEntry,
} from '../api'
import { sanitizeHtml } from '../lib/html'
import { parseDuration, elapsedSince, todayISO } from '../lib/time'
import RichTextEditor from './RichTextEditor'

/*
 * Everything about one ticket, in a panel beside the board.
 *
 * The board stays visible: the point of opening a ticket is usually to compare it
 * with the others, and a full-page route would lose that. On a narrow screen the
 * panel takes the width and the board scrolls behind it.
 *
 * Two kinds of write, and the difference matters:
 *
 *   * the FIELD form (title, status, priority, assignee, due, sprint, estimate,
 *     details) is a draft with an explicit Save, sending only what changed
 *   * time, the roadblock and attachments write IMMEDIATELY through their own
 *     actions, because each is a discrete act with a real-world moment attached —
 *     you stop a timer when you stop working, not when you get round to saving
 *
 * Every action returns the whole ticket, re-read server-side, so `onTicket` replaces
 * the caller's copy instead of patching it.
 */

type Draft = Record<TicketFieldKey, string>

function draftOf(t: Ticket): Draft {
  return {
    title: t.title || '',
    status: t.status || 'Open',
    priority: t.priority || 'Normal',
    assignee: t.assignee || '',
    dueDate: t.dueDate || '',
    sprint: t.sprint || '',
    details: t.details || '',
    estHours: t.estHours === null || t.estHours === undefined ? '' : String(t.estHours),
  }
}

function savedValue(t: Ticket, key: TicketFieldKey): string {
  if (key === 'estHours') return t.estHours === null || t.estHours === undefined ? '' : String(t.estHours)
  return (t[key] as string) || ''
}

function changedFields(draft: Draft, saved: Ticket): Partial<Record<TicketFieldKey, string>> {
  const out: Partial<Record<TicketFieldKey, string>> = {}
  for (const key of Object.keys(draft) as TicketFieldKey[]) {
    // Details is markup: compare sanitised, or a browser's own tidying of the
    // markup reads as an edit and every open-and-close looks dirty.
    const now = key === 'details' ? sanitizeHtml(draft[key]) : draft[key]
    const was = key === 'details' ? sanitizeHtml(savedValue(saved, key)) : savedValue(saved, key)
    if (now !== was) out[key] = now
  }
  return out
}

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

export default function TicketDetail({
  ticket, onTicket, onDeleted, onClose,
}: {
  ticket: Ticket
  onTicket: (t: Ticket) => void
  onDeleted: () => void
  onClose: () => void
}) {
  const on = { listId: ticket.listId, entryId: ticket.entryId }

  const [draft, setDraft] = useState<Draft>(() => draftOf(ticket))
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Time entry form
  const [timeAmount, setTimeAmount] = useState('')
  const [timeDate, setTimeDate] = useState(todayISO())
  const [timeNote, setTimeNote] = useState('')
  const [timeBillable, setTimeBillable] = useState(true)
  const [editingTime, setEditingTime] = useState<string>('')

  // Roadblock form
  const [blockReason, setBlockReason] = useState('')
  const [showBlockForm, setShowBlockForm] = useState(false)

  // A locally ticking clock, so a running timer doesn't look frozen.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!ticket.timerRunning) return
    const id = window.setInterval(() => setTick(n => n + 1), 15000)
    return () => window.clearInterval(id)
  }, [ticket.timerRunning])

  // A different ticket in the same panel is a different document.
  useEffect(() => {
    setDraft(draftOf(ticket))
    setFailure(''); setNotice(''); setConfirmDelete(false)
    setEditingTime(''); setShowBlockForm(false); setBlockReason('')
  }, [ticket.entryId])

  const pending = changedFields(draft, ticket)
  const dirty = Object.keys(pending).length > 0

  function edit(key: TicketFieldKey, value: string) {
    setDraft(d => ({ ...d, [key]: value }))
    setNotice('')
  }

  /** Run an action, replace the ticket from its reply, and report failure inline. */
  function run<T extends Ticket>(label: string, work: Promise<T>, done?: (t: T) => void) {
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(fresh => { onTicket(fresh); if (done) done(fresh) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function save() {
    if (!dirty || busy) return
    if (!draft.title.trim()) { setFailure('A ticket needs a title.'); return }
    const n = Object.keys(pending).length
    run('save', updateTicket(on.listId, on.entryId, pending),
      () => setNotice(`Saved ${n} field${n === 1 ? '' : 's'}.`))
  }

  function remove() {
    if (busy) return
    setBusy('delete'); setFailure('')
    deleteTicket(on.listId, on.entryId)
      .then(() => onDeleted())
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => { setBusy(''); setConfirmDelete(false) })
  }

  // -- time -----------------------------------------------------------------

  function submitTime() {
    const minutes = parseDuration(timeAmount)
    if (minutes === null) {
      setFailure('Enter time as 90, 90m, 1.5h or 1h30m.')
      return
    }
    if (editingTime) {
      run('time', editTime(on, { timeId: editingTime, minutes, date: timeDate, note: timeNote, billable: timeBillable }),
        () => { setEditingTime(''); setTimeAmount(''); setTimeNote(''); setNotice('Time updated.') })
      return
    }
    run('time', logTime(on, { minutes, date: timeDate, note: timeNote, billable: timeBillable }),
      () => { setTimeAmount(''); setTimeNote(''); setNotice(`Logged ${formatMinutes(minutes)}.`) })
  }

  function startEditingTime(e: TimeEntry) {
    setEditingTime(e.id)
    setTimeAmount(String(e.minutes))
    setTimeDate(e.date || todayISO())
    setTimeNote(e.note || '')
    setTimeBillable(e.billable !== false)
    setFailure(''); setNotice('')
  }

  function cancelEditingTime() {
    setEditingTime(''); setTimeAmount(''); setTimeNote(''); setTimeBillable(true)
  }

  // The clock is authoritative on the server; this is only what to show meanwhile.
  const liveMinutes = ticket.timerRunning
    ? Math.max(elapsedSince(ticket.timerStartedAt), ticket.timerElapsedMinutes || 0)
    : 0

  const logged = ticket.loggedHours || 0
  const est = ticket.estHours
  const overBudget = est !== null && est > 0 && logged > est

  // -- attachments ----------------------------------------------------------

  function attach(files: FileList | null) {
    if (!files || !files.length || busy) return
    const file = files[0]
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setFailure(`${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`)
      return
    }
    setBusy('attach'); setFailure(''); setNotice('')
    toBase64(file)
      .then(dataBase64 => uploadAttachment(on, {
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      }))
      .then(fresh => { onTicket(fresh); setNotice(`Attached ${file.name}.`) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  const number = ticket.ticketNumber === null ? null : `#${ticket.ticketNumber}`

  return (
    <aside className="tdrawer" aria-label={`Ticket ${number || ticket.title}`}>
      <header className="tdrawer__head">
        <div className="tdrawer__id">
          {number
            ? <span className="tnum tnum--lg">{number}</span>
            : <span className="muted">unnumbered</span>}
          <span className="pill" data-status={(ticket.status || 'Open').replace(/\s+/g, '')}>
            {ticket.status || 'Open'}
          </span>
          <span className="pill" data-prio={ticket.priority}>{ticket.priority || 'Normal'}</span>
        </div>
        <button type="button" className="tdrawer__x" onClick={onClose} aria-label="Close ticket">×</button>
      </header>

      <div className="tdrawer__body">
        {failure && <p className="editcard__err" role="alert">{failure}</p>}
        {notice && <p className="board2__notice" role="status">{notice}</p>}

        {/* Roadblock is first: if a ticket is blocked, that is the most important
            thing about it, and it should not need scrolling to find. */}
        {ticket.roadblocked ? (
          <div className="block block--on">
            <div className="block__row">
              <span className="block__flag">Roadblocked</span>
              <button type="button" className="btn btn--ghost btn--sm"
                onClick={() => run('block', setRoadblock(on, false), () => setNotice('Roadblock cleared.'))}
                disabled={!!busy}>
                {busy === 'block' ? 'Clearing…' : 'Clear'}
              </button>
            </div>
            <p className="block__why">{ticket.roadblockReason}</p>
            <p className="block__meta">
              Flagged by {ticket.roadblockedBy || 'unknown'}
              {ticket.roadblockedAt ? ` on ${ticket.roadblockedAt}` : ''}
            </p>
          </div>
        ) : showBlockForm ? (
          <div className="block">
            <label htmlFor="rb-reason">What is this blocked on?</label>
            <input id="rb-reason" type="text" value={blockReason} autoFocus autoComplete="off"
              placeholder="Waiting on the client's SFTP credentials"
              onChange={e => setBlockReason(e.target.value)} />
            <div className="block__row">
              <button type="button" className="btn btn--ghost btn--sm"
                onClick={() => { setShowBlockForm(false); setBlockReason('') }} disabled={!!busy}>
                Cancel
              </button>
              <button type="button" className="btn btn--sm"
                disabled={!!busy || !blockReason.trim()}
                onClick={() => run('block', setRoadblock(on, true, blockReason.trim()),
                  () => { setShowBlockForm(false); setBlockReason(''); setNotice('Flagged as roadblocked.') })}>
                {busy === 'block' ? 'Flagging…' : 'Flag roadblock'}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn--ghost btn--sm block__add"
            onClick={() => setShowBlockForm(true)} disabled={!!busy}>
            Flag a roadblock
          </button>
        )}

        {/* ---- the field form ---- */}
        <section className="tsec">
          <div className="ef ef--wide">
            <label htmlFor="td-title">Title<span className="ef__req" aria-hidden="true">*</span></label>
            <input id="td-title" type="text" value={draft.title} autoComplete="off"
              onChange={e => edit('title', e.target.value)} />
          </div>

          <div className="efgrid">
            <div className="ef">
              <label htmlFor="td-status">Status</label>
              <select id="td-status" value={draft.status} onChange={e => edit('status', e.target.value)}>
                {TICKET_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="ef">
              <label htmlFor="td-priority">Priority</label>
              <select id="td-priority" value={draft.priority} onChange={e => edit('priority', e.target.value)}>
                {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="ef">
              <label htmlFor="td-assignee">Assignee</label>
              <input id="td-assignee" type="text" value={draft.assignee} autoComplete="off"
                onChange={e => edit('assignee', e.target.value)} />
            </div>
            <div className="ef">
              <label htmlFor="td-due">Due date</label>
              <input id="td-due" type="date" value={draft.dueDate}
                onChange={e => edit('dueDate', e.target.value)} />
            </div>
            <div className="ef">
              <label htmlFor="td-sprint">Sprint</label>
              <input id="td-sprint" type="text" value={draft.sprint} placeholder="2026-W33" autoComplete="off"
                onChange={e => edit('sprint', e.target.value)} />
            </div>
            <div className="ef">
              <label htmlFor="td-est">Estimate (hours)</label>
              <input id="td-est" type="number" min="0" step="0.25" value={draft.estHours}
                placeholder="—" onChange={e => edit('estHours', e.target.value)} />
            </div>
          </div>

          <div className="ef ef--wide">
            <label htmlFor="td-details">Details</label>
            <RichTextEditor
              value={ticket.details || ''}
              docKey={ticket.entryId}
              ariaLabel="Ticket details"
              placeholder="What needs doing, what you've found, what's left…"
              onChange={html => edit('details', html)}
            />
          </div>

          <div className="editcard__foot">
            <span className="editcard__status">
              {busy === 'save' ? 'Saving…' : dirty
                ? `${Object.keys(pending).length} unsaved change${Object.keys(pending).length === 1 ? '' : 's'}`
                : ''}
            </span>
            <button type="button" className="btn btn--ghost" disabled={!dirty || !!busy}
              onClick={() => { setDraft(draftOf(ticket)); setNotice('') }}>
              Revert
            </button>
            <button type="button" className="btn" onClick={save} disabled={!dirty || !!busy || !draft.title.trim()}>
              Save changes
            </button>
          </div>
        </section>

        {/* ---- time ---- */}
        <section className="tsec">
          <h3 className="tsec__h">Time</h3>

          <div className="timehead">
            <div className="timestat">
              <span className="timestat__k">Estimate</span>
              <span className="timestat__v">{formatHours(est)}</span>
            </div>
            <div className="timestat">
              <span className="timestat__k">Logged</span>
              <span className="timestat__v" data-over={overBudget ? '' : undefined}>
                {formatHours(ticket.loggedHours)}
              </span>
            </div>
            <div className="timestat timestat--grow">
              {est !== null && est > 0 && (
                <>
                  <span className="timestat__k">
                    {overBudget
                      ? `${formatHours(Math.round((logged - est) * 100) / 100)} over`
                      : `${formatHours(Math.round((est - logged) * 100) / 100)} left`}
                  </span>
                  <span className="meter" data-over={overBudget ? '' : undefined}>
                    <span className="meter__fill" style={{ width: `${Math.min(100, (logged / est) * 100)}%` }} />
                  </span>
                </>
              )}
            </div>
          </div>

          {ticket.timerRunning ? (
            <div className="timer timer--on">
              <span className="timer__dot" aria-hidden="true" />
              <span className="timer__t">{formatMinutes(liveMinutes)}</span>
              <span className="timer__who">
                running{ticket.timerBy ? ` for ${ticket.timerBy}` : ''}
              </span>
              <button type="button" className="btn btn--sm" disabled={!!busy}
                onClick={() => run('timer', stopTimer(on, timeNote), fresh => {
                  setTimeNote('')
                  setNotice(fresh.loggedMinutes > 0
                    ? `Stopped — logged ${formatMinutes(fresh.loggedMinutes)}.`
                    : 'Stopped. Under a minute, so nothing was logged.')
                })}>
                {busy === 'timer' ? 'Stopping…' : 'Stop timer'}
              </button>
            </div>
          ) : (
            <div className="timer">
              <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                onClick={() => run('timer', startTimer(on), () => setNotice('Timer started.'))}>
                {busy === 'timer' ? 'Starting…' : 'Start timer'}
              </button>
              <span className="timer__hint">or log time you've already spent</span>
            </div>
          )}

          <div className="timeform">
            <div className="ef ef--narrow">
              <label htmlFor="td-amount">{editingTime ? 'New amount' : 'Amount'}</label>
              <input id="td-amount" type="text" value={timeAmount} autoComplete="off"
                placeholder="1h30m"
                onChange={e => setTimeAmount(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitTime() }} />
            </div>
            <div className="ef ef--narrow">
              <label htmlFor="td-date">Date</label>
              <input id="td-date" type="date" value={timeDate} onChange={e => setTimeDate(e.target.value)} />
            </div>
            <div className="ef">
              <label htmlFor="td-note">Note</label>
              <input id="td-note" type="text" value={timeNote} autoComplete="off"
                placeholder="What you did" onChange={e => setTimeNote(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitTime() }} />
            </div>
            <div className="ef ef--narrow">
              <label htmlFor="td-billable">Billable</label>
              <label className="checkline">
                <input id="td-billable" type="checkbox" checked={timeBillable}
                  onChange={e => setTimeBillable(e.target.checked)} />
                <span>Yes</span>
              </label>
            </div>
            <div className="ef ef--narrow">
              <label>&nbsp;</label>
              <div className="timeform__go">
                {editingTime && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={cancelEditingTime} disabled={!!busy}>
                    Cancel
                  </button>
                )}
                <button type="button" className="btn btn--sm" onClick={submitTime}
                  disabled={!!busy || !timeAmount.trim()}>
                  {busy === 'time' ? 'Saving…' : editingTime ? 'Update' : 'Log time'}
                </button>
              </div>
            </div>
          </div>

          {ticket.time.length > 0 && (
            <div className="tablewrap">
              <table className="fields timelog">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Time</th>
                    <th scope="col">Who</th>
                    <th scope="col">Note</th>
                    <th scope="col"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {ticket.time.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).map(e => (
                    <tr key={e.id} data-editing={editingTime === e.id ? '' : undefined}>
                      <td>{e.date}</td>
                      <td>
                        {formatMinutes(e.minutes)}
                        {e.billable === false && <span className="tag">unbilled</span>}
                      </td>
                      <td>{e.who || <span className="muted">—</span>}</td>
                      <td>{e.note || <span className="muted">—</span>}</td>
                      <td className="timelog__act">
                        <button type="button" className="linkbtn" disabled={!!busy}
                          onClick={() => startEditingTime(e)}>Edit</button>
                        <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                          onClick={() => run('time', deleteTime(on, e.id), () => setNotice('Time entry removed.'))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---- attachments ---- */}
        <section className="tsec">
          <h3 className="tsec__h">
            Attachments
            {ticket.attachments.length > 0 && <span className="tsec__n">{ticket.attachments.length}</span>}
          </h3>

          <label className="drop">
            <input
              type="file"
              className="drop__input"
              disabled={!!busy}
              onChange={e => { attach(e.target.files); e.target.value = '' }}
            />
            <span className="drop__label">
              {busy === 'attach' ? 'Uploading…' : 'Choose a file'}
            </span>
            <span className="drop__hint">Up to {formatBytes(MAX_ATTACHMENT_BYTES)}</span>
          </label>

          {ticket.attachments.length === 0 ? (
            <p className="muted tsec__empty">Nothing attached yet.</p>
          ) : (
            <ul className="atts">
              {ticket.attachments.map(a => (
                <li key={a.id} className="att">
                  <a className="att__name" href={a.url} target="_blank" rel="noopener noreferrer">{a.name}</a>
                  <span className="att__meta">
                    {formatBytes(a.size)}
                    {a.by ? ` · ${a.by}` : ''}
                    {a.at ? ` · ${a.at}` : ''}
                  </span>
                  <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                    onClick={() => run('attach', deleteAttachment(on, a.id), () => setNotice(`Removed ${a.name}.`))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- footer ---- */}
        <footer className="tdrawer__foot">
          <p className="note">
            Added by {ticket.createdBy || 'unknown'}
            {ticket.createdAt ? ` on ${ticket.createdAt}` : ''}
            {ticket.completedAt ? ` · completed ${ticket.completedAt}` : ''}
          </p>
          {confirmDelete ? (
            <p className="callout__actions">
              <span className="board2__confirm">Delete this ticket for good?</span>
              <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)} disabled={!!busy}>
                Keep it
              </button>
              <button type="button" className="btn btn--danger" onClick={remove} disabled={!!busy}>
                {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </button>
            </p>
          ) : (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(true)} disabled={!!busy}>
              Delete ticket
            </button>
          )}
        </footer>
      </div>
    </aside>
  )
}
