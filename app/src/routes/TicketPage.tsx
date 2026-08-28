import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError, getTicket, updateTicket, deleteTicket, getCompany,
  logTime, editTime, deleteTime, startTimer, stopTimer,
  setRoadblock, uploadAttachment, deleteAttachment,
  setTicketPeople, addComponent, updateComponent, deleteComponent,
  addSubtask, setParent, addComment, deleteComment,
  formatHours, formatMinutes, formatBytes, MAX_ATTACHMENT_BYTES, ceilingFor,
  TICKET_STATUSES, TICKET_PRIORITIES, COMPONENT_KINDS, COMPONENT_CHANGES,
  sprintLabel,
  type Ticket, type TicketFieldKey, type TimeEntry, type ComponentRef, type ActivityItem,
} from '../api'
import { sanitizeHtml, htmlToText } from '../lib/html'
import { openInClaudeCode } from '../lib/claudeCode'
import { parseDuration, elapsedSince, todayISO, whenLabel, whenExact } from '../lib/time'
import RichTextEditor from '../components/RichTextEditor'
import UserPicker from '../components/UserPicker'

/*
 * One ticket, as a page of its own at /tickets/<number>.
 *
 * A page rather than a drawer, for one reason that outweighs keeping the board in
 * view: a ticket is the unit of work people talk about, and talking about it means
 * sending someone the link. `/tickets/8` is short enough to paste into Teams, survives
 * a forward, and opens the same thing for whoever clicks it: a drawer has no address.
 * Ticket numbers are org-wide, so the number alone resolves; an entry id works too, so
 * an unnumbered ticket is still reachable.
 *
 * The layout gives the description the room it always needed: a wide column for the
 * things you read (description, attachments, time), and a properties rail for the
 * things you set. The rail is where a drawer used to put everything in one column.
 *
 * Two kinds of write, and the difference is deliberate:
 *   * the FIELD form (title, status, priority, due, estimate, description) is a draft
 *     with an explicit Save, sending only what changed
 *   * the two owners, time, the roadblock, attachments and components write IMMEDIATELY
 *     through their own actions, because each is a discrete act with a real-world moment
 *     attached. You stop a timer when you stop working, not when you get round to saving
 *
 * Sprint is READ-ONLY here. It is planned on the sprint board, where the roster and the
 * week's capacity are in front of you; typing it on the ticket was a way to fill a week
 * without ever seeing whether it had room.
 *
 * Every action returns the whole ticket, re-read server-side, so the reply replaces
 * what is on screen rather than patching it.
 */

type Draft = Record<TicketFieldKey, string>

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; ticket: Ticket }
  | { phase: 'gone' }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

function draftOf(t: Ticket): Draft {
  return {
    title: t.title || '',
    status: t.status || 'Open',
    // Deliberately NOT defaulting to Normal: an unset priority stays unset, so
    // saving a title or a due date cannot silently triage the ticket for you.
    priority: t.priority || '',
    dueDate: t.dueDate || '',
    details: t.details || '',
    estHours: t.estHours === null || t.estHours === undefined ? '' : String(t.estHours),
  }
}

/** A blank row for the "add a component" form. */
const EMPTY_COMPONENT = { name: '', kind: 'Endpoint', change: 'Edit', url: '' }

const dash = <span className="muted">-</span>

function savedValue(t: Ticket, key: TicketFieldKey): string {
  if (key === 'estHours') return t.estHours === null || t.estHours === undefined ? '' : String(t.estHours)
  return (t[key] as string) || ''
}

function changedFields(draft: Draft, saved: Ticket): Partial<Record<TicketFieldKey, string>> {
  const out: Partial<Record<TicketFieldKey, string>> = {}
  for (const key of Object.keys(draft) as TicketFieldKey[]) {
    // Details is markup: compare sanitised, or a browser's own tidying of the markup
    // reads as an edit and every open-and-close looks dirty.
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

/*
 * The ticket, as a prompt for Claude Code.
 *
 * Deliberately a briefing and not a dump. Claude Code opens with this org's MCP tools
 * and `b6p` already available, so it can read anything it needs from the platform
 * itself: what it cannot do is know WHICH ticket you were looking at. So this sends
 * the identifying facts, the description, and the components already touched, and
 * leaves the fetching to the session. That also keeps it far inside Claude Desktop's
 * ~14,000-character ceiling for every ticket we have.
 *
 * The ticket's own URL goes last so the session can point a human back at it.
 */
function claudePrompt(t: Ticket, ehrLink: string): string {
  const number = t.ticketNumber === null ? t.entryId : `#${t.ticketNumber}`
  const lines = [
    `I'm working on Cobalt ticket ${number}: ${t.title || 'untitled'}.`,
    '',
    `Client: ${t.clientName || t.listName || 'internal'}`,
  ]

  // The client's own BlueStep org: the single most useful thing in here, because it
  // tells the session WHERE the work actually lands. Omitted rather than sent empty:
  // a ticket on an internal list has no client, and a handful of clients have no org
  // recorded in beh, and a blank label reads as a broken lookup.
  if (ehrLink) lines.push(`Client's BlueStep org: ${ehrLink}`)

  lines.push(
    `Status: ${t.status || 'Open'} · Priority: ${t.priority || 'none set'}` +
      (t.sprint ? ` · Sprint ${t.sprint}` : ' · unplanned'),
    `Accountable: ${t.accountableName || '-'} · Responsible: ${t.responsibleName || '-'}`,
  )

  if (t.dueDate) lines.push(`Due: ${t.dueDate}`)
  if (t.estHours !== null) lines.push(`Estimate: ${t.estHours}h · Logged: ${t.loggedHours || 0}h`)
  if (t.roadblocked) lines.push(`ROADBLOCKED: ${t.roadblockReason || 'no reason given'}`)
  if (t.parentNumber !== null) lines.push(`Subtask of #${t.parentNumber}: ${t.parentTitle}`)

  const details = htmlToText(t.details)
  if (details) lines.push('', 'Description:', details)

  if (t.components.length) {
    lines.push('', 'Components already touched:')
    for (const c of t.components) lines.push(`- ${c.kind} · ${c.change} · ${c.name}: ${c.url}`)
  }

  lines.push(
    '',
    'Read whatever you need from the platform, then help me work this ticket.',
    `Ticket: ${window.location.href}`,
  )
  return lines.join('\n')
}

export default function TicketPage() {
  const { key = '' } = useParams()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copied, setCopied] = useState(false)
  // Set on an "Open in Claude Code" click. The handler gives us no success signal,
  // an uninstalled scheme is indistinguishable from a working one, so the label says
  // what we actually know: the prompt is on the clipboard either way.
  const [handedOff, setHandedOff] = useState(false)

  // Time entry form
  const [timeAmount, setTimeAmount] = useState('')
  const [timeDate, setTimeDate] = useState(todayISO())
  const [timeNote, setTimeNote] = useState('')
  const [timeBillable, setTimeBillable] = useState(true)
  const [editingTime, setEditingTime] = useState('')

  // Roadblock form
  const [blockReason, setBlockReason] = useState('')
  const [showBlockForm, setShowBlockForm] = useState(false)

  // Components form. `editingComponent` doubles as the mode: '' is adding.
  const [comp, setComp] = useState({ ...EMPTY_COMPONENT })
  const [editingComponent, setEditingComponent] = useState('')
  const [showCompForm, setShowCompForm] = useState(false)

  // Subtask form. Deliberately three fields: breaking work up is something you do in
  // one sitting, and a form that asks for six things per chunk stops you at chunk two.
  const [sub, setSub] = useState({ title: '', responsibleId: '', estHours: '' })
  const [showSubForm, setShowSubForm] = useState(false)

  // Comment box, and whether the automated events are shown alongside them.
  const [comment, setComment] = useState('')
  const [showEvents, setShowEvents] = useState(true)

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    setFailure(''); setNotice('')
    getTicket(key)
      .then(({ ticket }) => { setState({ phase: 'ready', ticket }); setDraft(draftOf(ticket)) })
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [key])

  useEffect(load, [load])

  const ticket = state.phase === 'ready' ? state.ticket : null

  // A locally ticking clock, so a running timer doesn't look frozen.
  const [, setTick] = useState(0)
  const running = !!ticket?.timerRunning
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setTick(n => n + 1), 15000)
    return () => window.clearInterval(id)
  }, [running])

  // The rail's Save button lives at the bottom of a long page; keep the count visible.
  const pending = ticket && draft ? changedFields(draft, ticket) : {}
  const dirty = Object.keys(pending).length > 0

  const titleRef = useRef<HTMLInputElement | null>(null)

  function edit(field: TicketFieldKey, value: string) {
    setDraft(d => (d ? { ...d, [field]: value } : d))
    setNotice('')
  }

  /** Run an action, replace the ticket from its reply, and report failure inline. */
  function run<T extends Ticket>(label: string, work: Promise<T>, done?: (t: T) => void) {
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(fresh => {
        setState({ phase: 'ready', ticket: fresh })
        // Only reset the draft for fields the action itself owns, so an unsaved title
        // is not thrown away by starting a timer.
        setDraft(d => (d ? { ...d, status: fresh.status || d.status } : draftOf(fresh)))
        if (done) done(fresh)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function save() {
    if (!ticket || !dirty || busy) return
    if (!draft || !draft.title.trim()) { setFailure('A ticket needs a title.'); return }
    const n = Object.keys(pending).length
    setBusy('save'); setFailure(''); setNotice('')
    updateTicket(ticket.listId, ticket.entryId, pending)
      .then(fresh => {
        setState({ phase: 'ready', ticket: fresh })
        setDraft(draftOf(fresh))
        setNotice(`Saved ${n} field${n === 1 ? '' : 's'}.`)
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function remove() {
    if (!ticket || busy) return
    // Cascade only because the confirmation names the subtasks it is about to take,
    // the endpoint refuses a silent one, and this is the screen that earns the right.
    const cascade = ticket.subtaskCount > 0
    setBusy('delete'); setFailure('')
    deleteTicket(ticket.listId, ticket.entryId, cascade)
      .then(() => setState({ phase: 'gone' }))
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => { setBusy(''); setConfirmDelete(false) })
  }

  // -- subtasks -------------------------------------------------------------
  //
  // A subtask action changes a DIFFERENT ticket, so the reply is that ticket, not this
  // one - `run` would swap the page out from under you. These re-read the ticket being
  // looked at instead, by entry id so the endpoint skips its cross-list scan.

  function runOnFamily(label: string, work: Promise<unknown>, message: string, after?: () => void) {
    if (!ticket) return
    const { listId, entryId } = ticket
    setBusy(label); setFailure(''); setNotice('')
    work
      .then(() => getTicket(entryId, listId))
      .then(({ ticket: fresh }) => {
        setState({ phase: 'ready', ticket: fresh })
        setDraft(d => (d ? { ...d, status: fresh.status || d.status } : draftOf(fresh)))
        setNotice(message)
        if (after) after()
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function submitComment() {
    if (!ticket || !comment.trim() || busy) return
    const text = comment.trim()
    // Cleared on success only: a failed post must not eat what someone just wrote.
    run('comment', addComment(on, text), () => { setComment(''); setNotice('Comment added.') })
  }

  function submitSubtask() {
    if (!ticket || !sub.title.trim() || busy) return
    const title = sub.title.trim()
    const fields: Partial<Record<TicketFieldKey, string>> = { title }
    if (sub.estHours.trim()) fields.estHours = sub.estHours.trim()
    // The form is cleared on SUCCESS only. Clearing it on submit would look quicker and
    // would eat the typing every time the endpoint said no.
    runOnFamily(
      'sub',
      addSubtask(ticket.listId, ticket.entryId, fields,
        sub.responsibleId ? { responsibleId: sub.responsibleId } : {}),
      `Added "${title}".`,
      () => setSub({ title: '', responsibleId: '', estHours: '' }),
    )
  }

  function copyLink() {
    const url = window.location.href
    const done = () => { setCopied(true); window.setTimeout(() => setCopied(false), 2500) }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => setFailure('Could not reach the clipboard. The link is ' + url))
      return
    }
    setFailure('Copying is not available here. The link is ' + url)
  }

  /*
   * The org link lives on the COMPANY, not the ticket, so it takes a second read,
   * done here on click rather than with the ticket, because most people who open a
   * ticket never press this and every page view would pay for it.
   *
   * Awaiting before following the link is safe: a browser only lets an external
   * scheme launch while the click's user activation is still live, and that lasts
   * seconds: far longer than one API call. A failed or missing lookup is not worth
   * blocking on, so the prompt simply goes without the line.
   */
  async function openInClaude() {
    if (!ticket) return

    let ehrLink = ''
    if (ticket.clientId) {
      try {
        ehrLink = (await getCompany(ticket.clientId)).ehrLink || ''
      } catch {
        // Leave it out. The briefing is still worth sending without it.
      }
    }

    const shortened = openInClaudeCode(claudePrompt(ticket, ehrLink))
    setHandedOff(true)
    window.setTimeout(() => setHandedOff(false), 4000)
    if (shortened) {
      setNotice('This ticket is long, so the prompt was shortened to fit Claude’s limit.')
    }
  }

  // -- time -----------------------------------------------------------------

  function submitTime() {
    if (!ticket) return
    const on = { listId: ticket.listId, entryId: ticket.entryId }
    const minutes = parseDuration(timeAmount)
    if (minutes === null) { setFailure('Enter time as 90, 90m, 1.5h or 1h30m.'); return }
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

  // -- attachments ----------------------------------------------------------

  function attach(files: FileList | null) {
    if (!ticket || !files || !files.length || busy) return
    const on = { listId: ticket.listId, entryId: ticket.entryId }
    const file = files[0]
    // Video gets the bigger ceiling, matching the endpoint: a screen recording dropped
    // on a ticket is the same proposition as one Wesley captured.
    const ceiling = ceilingFor(file.type)
    if (file.size > ceiling) {
      setFailure(`${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(ceiling)}.`)
      return
    }
    setBusy('attach'); setFailure(''); setNotice('')
    toBase64(file)
      .then(dataBase64 => uploadAttachment(on, {
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      }))
      .then(fresh => { setState({ phase: 'ready', ticket: fresh }); setNotice(`Attached ${file.name}.`) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  // -- render ---------------------------------------------------------------

  if (state.phase === 'loading') {
    return <section className="page"><p className="empty">Loading ticket…</p></section>
  }

  if (state.phase === 'gone') {
    return (
      <section className="page">
        <div className="callout">
          <p className="callout__title">Ticket deleted</p>
          <p>It is gone from the board. Nothing else was changed.</p>
          <p className="callout__actions">
            <Link className="btn" to="/clients">Back to Clients</Link>
          </p>
        </div>
      </section>
    )
  }

  if (state.phase === 'error') {
    return (
      <section className="page">
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not open this ticket'}
          </p>
          <p>{state.error.message}</p>
          {/* A shared link is the most likely way to land here signed out, so the
              sign-in comes back to this exact ticket. */}
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
            {' '}
            <Link className="btn btn--ghost" to="/clients">Back to Clients</Link>
          </p>
        </div>
      </section>
    )
  }

  if (!ticket || !draft) return null

  const on = { listId: ticket.listId, entryId: ticket.entryId }
  const number = ticket.ticketNumber === null ? null : `#${ticket.ticketNumber}`
  const boardPath = ticket.clientId ? `/clients/${ticket.clientId}/tickets` : '/clients'
  const est = ticket.estHours
  const logged = ticket.loggedHours || 0
  const overBudget = est !== null && est > 0 && logged > est
  const liveMinutes = ticket.timerRunning
    ? Math.max(elapsedSince(ticket.timerStartedAt), ticket.timerElapsedMinutes || 0)
    : 0

  return (
    <section className="page tpage">
      <nav className="crumb" aria-label="Breadcrumb">
        <Link to="/clients">Clients</Link>
        <span aria-hidden="true">/</span>
        {ticket.clientId
          ? <Link to={`/clients/${ticket.clientId}`}>{ticket.clientName || 'Client'}</Link>
          : <span>{ticket.listName || 'List'}</span>}
        <span aria-hidden="true">/</span>
        <Link to={boardPath}>Tickets</Link>
        <span aria-hidden="true">/</span>
        <span>{number || 'ticket'}</span>
      </nav>

      <header className="tpage__head">
        <div className="tpage__idrow">
          {number
            ? <span className="tnum tnum--lg">{number}</span>
            : <span className="muted">unnumbered</span>}
          <span className="pill" data-status={(ticket.status || 'Open').replace(/\s+/g, '')}>
            {ticket.status || 'Open'}
          </span>
          {/* Same rule as the board: unset priority shows nothing rather than
              claiming Normal. The editor below is where you set one. */}
          {ticket.priority && (
            <span className="pill" data-prio={ticket.priority}>{ticket.priority}</span>
          )}
          {ticket.roadblocked && <span className="pill pill--block">Roadblocked</span>}
          {ticket.timerRunning && (
            <span className="pill pill--timer">
              <span className="timer__dot" aria-hidden="true" /> {formatMinutes(liveMinutes)}
            </span>
          )}
          <span className="tpage__spacer" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={copyLink}>
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          {/* Hands this ticket to Claude Desktop on the machine you clicked from. The
              title carries the fallback, because a missing handler fails silently. */}
          <button type="button" className="btn btn--ghost btn--sm" onClick={openInClaude}
            title="Opens Claude Desktop's Code area with this ticket as the prompt. The prompt is also copied, so you can paste it if Claude Desktop isn't installed.">
            {handedOff ? 'Sent to Claude' : 'Open in Claude Code'}
          </button>
          <Link className="btn btn--ghost btn--sm" to={boardPath}>Back to board</Link>
          {/* Roadblock and delete are actions, not sections: a button each, next to
              the others, with their one question asked inline underneath. */}
          {ticket.roadblocked ? (
            <button type="button" className="linkbtn" disabled={!!busy}
              onClick={() => run('block', setRoadblock(on, false), () => setNotice('Roadblock cleared.'))}>
              {busy === 'block' ? 'Clearing…' : 'Clear roadblock'}
            </button>
          ) : (
            <button type="button" className="linkbtn" disabled={!!busy}
              onClick={() => { setConfirmDelete(false); setShowBlockForm(true) }}>
              Flag roadblock
            </button>
          )}
          <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
            onClick={() => { setShowBlockForm(false); setConfirmDelete(true) }}>
            Delete
          </button>
        </div>

        {showBlockForm && !ticket.roadblocked && (
          <div className="tpage__ask">
            <input type="text" value={blockReason} autoFocus autoComplete="off"
              aria-label="What is this blocked on?"
              placeholder="What is this blocked on? e.g. waiting on the client's SFTP credentials"
              onChange={e => setBlockReason(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setShowBlockForm(false); setBlockReason('') }
                if (e.key === 'Enter' && blockReason.trim()) {
                  run('block', setRoadblock(on, true, blockReason.trim()),
                    () => { setShowBlockForm(false); setBlockReason(''); setNotice('Flagged as roadblocked.') })
                }
              }} />
            <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
              onClick={() => { setShowBlockForm(false); setBlockReason('') }}>
              Cancel
            </button>
            <button type="button" className="btn btn--sm" disabled={!!busy || !blockReason.trim()}
              onClick={() => run('block', setRoadblock(on, true, blockReason.trim()),
                () => { setShowBlockForm(false); setBlockReason(''); setNotice('Flagged as roadblocked.') })}>
              {busy === 'block' ? 'Flagging…' : 'Flag it'}
            </button>
          </div>
        )}

        {confirmDelete && (
          <div className="tpage__ask tpage__ask--danger">
            {/* Deleting a parent takes its subtasks with it, so the question says how
                many and the button says the number out loud. */}
            <span className="tpage__askq">
              {ticket.subtaskCount > 0
                ? `Delete this ticket and its ${ticket.subtaskCount} subtask${ticket.subtaskCount === 1 ? '' : 's'} for good? Every time log goes with them.`
                : 'Delete this ticket for good? Its time log goes with it.'}
            </span>
            <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
              onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={remove} disabled={!!busy}>
              {busy === 'delete'
                ? 'Deleting…'
                : ticket.subtaskCount > 0 ? `Delete all ${ticket.subtaskCount + 1}` : 'Delete ticket'}
            </button>
          </div>
        )}

        {/* The title IS the heading. Editing it in place beats a labelled box on a
            page whose whole subject is this one ticket. */}
        <input
          ref={titleRef}
          className="tpage__title"
          type="text"
          value={draft.title}
          aria-label="Ticket title"
          placeholder="Untitled ticket"
          autoComplete="off"
          onChange={e => edit('title', e.target.value)}
        />

        {/* A subtask says what it is part of, right under its own title, and offers the
            one structural move that belongs to it: getting out. */}
        {ticket.parent && (
          <p className="tpage__parent">
            <span className="tpage__parentlab">Subtask of</span>
            <Link className="inlink" to={`/tickets/${ticket.parent.ticketNumber ?? ticket.parent.entryId}`}>
              {ticket.parent.ticketNumber !== null && <span className="tnum">#{ticket.parent.ticketNumber}</span>}
              {' '}{ticket.parent.title || 'Untitled ticket'}
            </Link>
            <span className="muted">
              {ticket.parent.subtaskDone}/{ticket.parent.subtaskCount} done
            </span>
            <button type="button" className="linkbtn" disabled={!!busy}
              onClick={() => runOnFamily('parent', setParent(on, ''), 'Promoted to a top-level ticket.')}>
              {busy === 'parent' ? 'Promoting…' : 'Promote to top-level'}
            </button>
          </p>
        )}

        {ticket.orphaned && (
          <p className="tpage__parent tpage__parent--orphan">
            <span className="tpage__parentlab">Was a subtask</span>
            <span className="muted">
              Its parent {ticket.parentNumber ? `(#${ticket.parentNumber}) ` : ''}
              was deleted, so this is a top-level ticket now.
            </span>
          </p>
        )}

        <p className="tpage__sub">
          on <Link className="inlink" to={boardPath}>{ticket.listName || 'this list'}</Link>
          {ticket.createdBy ? ` · added by ${ticket.createdBy}` : ''}
          {ticket.createdAt ? ` on ${ticket.createdAt}` : ''}
          {ticket.completedAt ? ` · completed ${ticket.completedAt}` : ''}
        </p>
      </header>

      {failure && <p className="editcard__err" role="alert">{failure}</p>}
      {notice && <p className="board2__notice" role="status">{notice}</p>}

      {/* Blocked is the most important thing about a blocked ticket, so it sits above
          the two columns rather than inside either. */}
      {/* The reason is worth a banner; clearing it is the header's button, not a
          second copy down here. */}
      {ticket.roadblocked && (
        <div className="block block--on tpage__block">
          <span className="block__flag">Roadblocked</span>
          <p className="block__why">{ticket.roadblockReason}</p>
          <p className="block__meta">
            Flagged by {ticket.roadblockedBy || 'unknown'}
            {ticket.roadblockedAt ? ` on ${ticket.roadblockedAt}` : ''}
          </p>
        </div>
      )}

      <div className="tpage__cols">
        <div className="tpage__main">
          <section className="tcard">
            <div className="tcard__head">
              <h2>Description</h2>
              <p className="note">What needs doing, what you have found, what is left.</p>
            </div>
            <RichTextEditor
              value={ticket.details || ''}
              docKey={ticket.entryId}
              ariaLabel="Ticket description"
              placeholder="Write the detail here. Bold, lists and headings are available."
              tall
              onChange={html => edit('details', html)}
            />
          </section>

          {/* Subtasks.
              Only on a top-level ticket: one level deep is the rule, and a page that
              offered to nest further would be promising something the endpoint refuses.

              Each row is a real ticket with its own page; what is inline here is the one
              thing you do from the parent, which is move a chunk along. Everything else
              time, attachments, the description: is a click away on its own page. */}
          {!ticket.isSubtask && (
            <section className="tcard">
              <div className="tcard__head">
                <h2>
                  Subtasks
                  {ticket.subtaskCount > 0 && (
                    <span className="tsec__n">{ticket.subtaskDone}/{ticket.subtaskCount}</span>
                  )}
                </h2>
                <p className="note">Break a big job into pieces that can be given out and planned separately.</p>
              </div>

              {ticket.subtaskCount > 0 && (
                <div className="subprog" role="img"
                  aria-label={`${ticket.subtaskDone} of ${ticket.subtaskCount} subtasks complete`}>
                  <span className="subprog__fill"
                    style={{ width: `${Math.round((ticket.subtaskDone / ticket.subtaskCount) * 100)}%` }} />
                </div>
              )}

              {!ticket.subtasks || ticket.subtasks.length === 0 ? (
                <p className="muted tsec__empty">No subtasks. This ticket stands on its own.</p>
              ) : (
                <ul className="subs">
                  {ticket.subtasks.map(s => (
                    <li key={s.entryId} className="sub" data-done={s.status === 'Complete' ? 'yes' : 'no'}>
                      <Link className="sub__name" to={`/tickets/${s.ticketNumber ?? s.entryId}`}>
                        {s.ticketNumber !== null && <span className="tnum">#{s.ticketNumber}</span>}
                        <span className="sub__title">{s.title || 'Untitled'}</span>
                      </Link>

                      <select className="sub__status" value={s.status || 'Open'}
                        aria-label={`Status of ${s.title || 'subtask'}`}
                        disabled={!!busy}
                        onChange={e => runOnFamily('sub',
                          updateTicket(s.listId, s.entryId, { status: e.target.value }),
                          `${s.title || 'Subtask'} → ${e.target.value}.`)}>
                        {TICKET_STATUSES.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>

                      <span className="sub__who">{s.responsibleName || dash}</span>
                      <span className="sub__hrs muted">
                        {s.estHours !== null ? formatHours(s.estHours) : dash}
                        {s.loggedHours ? ` · ${formatHours(s.loggedHours)} logged` : ''}
                      </span>
                      {s.sprint && <span className="pill pill--sprint">{sprintLabel(s.sprint)}</span>}
                      {s.roadblocked && <span className="pill pill--block">Blocked</span>}

                      <button type="button" className="linkbtn" disabled={!!busy}
                        onClick={() => runOnFamily('sub',
                          setParent({ listId: s.listId, entryId: s.entryId }, ''),
                          `${s.title || 'Subtask'} is a top-level ticket now.`)}>
                        Detach
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {ticket.subtaskCount > 0 && (
                <p className="subs__roll muted">
                  {formatHours(ticket.subtaskEstHours)} estimated across the subtasks
                  {ticket.subtaskLoggedHours > 0 && `, ${formatHours(ticket.subtaskLoggedHours)} logged`}
                  {'-'}separate from this ticket&rsquo;s own {formatHours(est || 0)}.
                </p>
              )}

              {!showSubForm ? (
                <p className="tsec__add">
                  <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                    onClick={() => { setShowSubForm(true); setFailure(''); setNotice('') }}>
                    Add a subtask
                  </button>
                </p>
              ) : (
                <div className="efgrid efgrid--inset">
                  <div className="ef ef--wide">
                    <label htmlFor="s-title">What is the chunk?<span className="ef__req" aria-hidden="true">*</span></label>
                    <input id="s-title" type="text" value={sub.title} autoComplete="off" autoFocus
                      placeholder="Map the RTC fields onto the foster model"
                      onChange={e => setSub(s => ({ ...s, title: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); submitSubtask() }
                        if (e.key === 'Escape') setShowSubForm(false)
                      }} />
                    <p className="ef__hint">Enter adds it and keeps the form open for the next one.</p>
                  </div>
                  <div className="ef">
                    <label htmlFor="s-who">Who does it</label>
                    <UserPicker id="s-who" value={sub.responsibleId} placeholder="Nobody yet"
                      onChange={id => setSub(s => ({ ...s, responsibleId: id }))} />
                  </div>
                  <div className="ef">
                    <label htmlFor="s-est">Estimate (hours)</label>
                    <input id="s-est" type="number" min="0" step="0.25" value={sub.estHours}
                      autoComplete="off" placeholder="4"
                      onChange={e => setSub(s => ({ ...s, estHours: e.target.value }))} />
                  </div>
                  <div className="ef ef--wide tsec__formfoot">
                    <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                      onClick={() => { setShowSubForm(false); setFailure('') }}>
                      Done adding
                    </button>
                    <button type="button" className="btn btn--sm"
                      disabled={!!busy || !sub.title.trim()} onClick={submitSubtask}>
                      {busy === 'sub' ? 'Adding…' : 'Add subtask'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="tcard">
            <div className="tcard__head">
              <h2>
                Attachments
                {ticket.attachments.length > 0 && <span className="tsec__n">{ticket.attachments.length}</span>}
              </h2>
              <p className="note">Up to {formatBytes(MAX_ATTACHMENT_BYTES)} each. Saved immediately.</p>
            </div>

            <label className="drop">
              <input type="file" className="drop__input" disabled={!!busy}
                onChange={e => { attach(e.target.files); e.target.value = '' }} />
              <span className="drop__label">{busy === 'attach' ? 'Uploading…' : 'Choose a file'}</span>
              <span className="drop__hint">or drag one onto this box</span>
            </label>

            {ticket.attachments.length === 0 ? (
              <p className="muted tsec__empty">Nothing attached yet.</p>
            ) : (
              <ul className="atts">
                {ticket.attachments.map(a => (
                  <li key={a.id} className="att">
                    <a className="att__name" href={a.url} target="_blank" rel="noopener noreferrer">{a.name}</a>
                    <span className="att__meta">
                      {formatBytes(a.size)}{a.by ? ` · ${a.by}` : ''}{a.at ? ` · ${a.at}` : ''}
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

          {/* The interview this request came from.
              Collapsed by default: an engineer wants the synthesized description, and
              only reaches for the raw conversation when they suspect something was lost
              in the writing of it, which is exactly when having it kept matters. */}
          {ticket.conversation && ticket.conversation.turns.length > 0 && (
            <section className="tcard">
              <details className="wes-history">
                <summary>
                  <span className="wes-history-h">Wesley conversation</span>
                  <span className="tsec__n">{ticket.conversation.turns.length}</span>
                  <span className="note">
                    How this request was arrived at
                    {ticket.conversation.narration.length > 0 && ', including spoken narration'}
                  </span>
                </summary>
                <ol className="wes-history-list">
                  {ticket.conversation.turns.map((t, i) => (
                    <li key={i} className={`wes-history-turn wes-history-turn--${t.role}`}>
                      <span className="wes-history-who">
                        {t.role === 'assistant' ? 'Wesley' : ticket.createdBy || 'They'}
                      </span>
                      <span className="wes-history-text">{t.text}</span>
                    </li>
                  ))}
                </ol>
              </details>
            </section>
          )}

          {/* Components: what this ticket actually changed on the platform.
              Separate from the description on purpose: the description says what
              happened, this says what to look at if it breaks, or what to repeat when
              the same change has to go into another org. */}
          <section className="tcard">
            <div className="tcard__head">
              <h2>
                Components
                {ticket.components.length > 0 && <span className="tsec__n">{ticket.components.length}</span>}
              </h2>
              <p className="note">The BlueStep components this ticket created or changed.</p>
            </div>

            {ticket.components.length === 0 ? (
              <p className="muted tsec__empty">Nothing recorded yet.</p>
            ) : (
              <div className="tablewrap">
                <table className="fields comps">
                  <thead>
                    <tr>
                      <th scope="col">Component</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Change</th>
                      <th scope="col">Added</th>
                      <th scope="col"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ticket.components.map((c: ComponentRef) => (
                      <tr key={c.id}>
                        <th scope="row">
                          {c.url
                            ? <a className="inlink" href={c.url} target="_blank" rel="noopener noreferrer">{c.name}</a>
                            : c.name}
                        </th>
                        <td>{c.kind || dash}</td>
                        <td><span className="mark" data-change={c.change}>{c.change || 'Edit'}</span></td>
                        <td className="muted nowrap">{c.at || dash}{c.by ? ` · ${c.by}` : ''}</td>
                        <td className="comps__act">
                          <button type="button" className="linkbtn" disabled={!!busy}
                            onClick={() => {
                              setEditingComponent(c.id)
                              setComp({ name: c.name, kind: c.kind || 'Other', change: c.change || 'Edit', url: c.url })
                              setShowCompForm(true)
                              setFailure(''); setNotice('')
                            }}>
                            Edit
                          </button>
                          <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                            onClick={() => run('comp', deleteComponent(on, c.id),
                              () => setNotice(`Removed ${c.name}.`))}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!showCompForm ? (
              <p className="tsec__add">
                <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                  onClick={() => {
                    setEditingComponent(''); setComp({ ...EMPTY_COMPONENT })
                    setShowCompForm(true); setFailure(''); setNotice('')
                  }}>
                  Add a component
                </button>
              </p>
            ) : (
              <div className="efgrid efgrid--inset">
                <div className="ef ef--wide">
                  <label htmlFor="c-name">Name<span className="ef__req" aria-hidden="true">*</span></label>
                  <input id="c-name" type="text" value={comp.name} autoComplete="off" autoFocus
                    placeholder="Cobalt Maestro"
                    onChange={e => setComp(c => ({ ...c, name: e.target.value }))} />
                </div>
                <div className="ef">
                  <label htmlFor="c-kind">Kind</label>
                  <select id="c-kind" value={comp.kind}
                    onChange={e => setComp(c => ({ ...c, kind: e.target.value }))}>
                    {COMPONENT_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                <div className="ef">
                  <label htmlFor="c-change">Change</label>
                  <select id="c-change" value={comp.change}
                    onChange={e => setComp(c => ({ ...c, change: e.target.value }))}>
                    {COMPONENT_CHANGES.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                <div className="ef ef--wide">
                  <label htmlFor="c-url">Link</label>
                  <input id="c-url" type="url" value={comp.url} autoComplete="off"
                    placeholder="https://cobaltorg.bluestep.net/…"
                    onChange={e => setComp(c => ({ ...c, url: e.target.value }))} />
                </div>
                <div className="ef ef--wide tsec__formfoot">
                  <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                    onClick={() => { setShowCompForm(false); setEditingComponent(''); setFailure('') }}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn--sm"
                    disabled={!!busy || !comp.name.trim()}
                    onClick={() => {
                      const payload = {
                        name: comp.name.trim(), kind: comp.kind,
                        change: comp.change, url: comp.url.trim(),
                      }
                      const work = editingComponent
                        ? updateComponent(on, { componentId: editingComponent, ...payload })
                        : addComponent(on, payload)
                      run('comp', work, () => {
                        setShowCompForm(false); setEditingComponent('')
                        setComp({ ...EMPTY_COMPONENT })
                        setNotice(editingComponent ? 'Component updated.' : `Recorded ${payload.name}.`)
                      })
                    }}>
                    {editingComponent ? 'Save component' : 'Add component'}
                  </button>
                </div>
              </div>
            )}
          </section>


          {/* Activity: the ticket's history, oldest first, with the comment box at the
              bottom where the newest line is. Events and comments interleave because the
              question people ask is "what happened to this", and splitting them into two
              lists makes that question take two reads to answer. */}
          <section className="tcard">
            <div className="tcard__head">
              <h2>
                Activity
                {ticket.activityCount > 0 && <span className="tsec__n">{ticket.activityCount}</span>}
              </h2>
              <p className="note">
                Everything that happened to this ticket. Events write themselves; comments are yours.
              </p>
            </div>

            {ticket.activityCount > ticket.commentCount && (
              <p className="act__filter">
                <button type="button" className="linkbtn" onClick={() => setShowEvents(v => !v)}>
                  {showEvents
                    ? `Hide the ${ticket.activityCount - ticket.commentCount} automatic entries`
                    : `Show all ${ticket.activityCount} entries`}
                </button>
              </p>
            )}

            {(() => {
              const shown = showEvents
                ? ticket.activity
                : ticket.activity.filter((a: ActivityItem) => a.type === 'comment')
              if (!shown.length) {
                return (
                  <p className="muted tsec__empty">
                    {ticket.activityCount ? 'No comments yet.' : 'Nothing has happened yet.'}
                  </p>
                )
              }
              return (
                <ol className="acts">
                  {shown.map((a: ActivityItem) => (
                    <li key={a.id} className={`act act--${a.type}`}>
                      <span className="act__dot" aria-hidden="true" />
                      <div className="act__body">
                        <p className="act__line">
                          <span className="act__who">{a.who || 'Someone'}</span>
                          {a.type === 'event'
                            ? <span className="act__text"> {a.text}</span>
                            : <span className="act__said">{a.text}</span>}
                        </p>
                        <p className="act__meta">
                          <time dateTime={a.at} title={whenExact(a.at)}>{whenLabel(a.at)}</time>
                          {a.type === 'comment' && (
                            <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                              onClick={() => run('comment', deleteComment(on, a.id),
                                () => setNotice('Comment removed.'))}>
                              Remove
                            </button>
                          )}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )
            })()}

            <div className="act__compose">
              <textarea
                value={comment}
                rows={2}
                placeholder="Add a comment: what you found, what you are waiting on, what you decided."
                aria-label="Add a comment"
                onChange={e => setComment(e.target.value)}
                onKeyDown={e => {
                  // Ctrl/Cmd+Enter posts. Plain Enter stays a newline: a comment is prose,
                  // and losing a half-written paragraph to a stray keystroke is worse than
                  // reaching for a second key.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComment() }
                }}
              />
              <div className="act__composefoot">
                <span className="muted">⌘/Ctrl + Enter</span>
                <button type="button" className="btn btn--sm"
                  disabled={!!busy || !comment.trim()} onClick={submitComment}>
                  {busy === 'comment' ? 'Posting…' : 'Comment'}
                </button>
              </div>
            </div>
          </section>

        </div>

        {/* The properties rail: everything you SET, in one narrow column, so the
            description keeps the width. */}
        <aside className="tpage__rail" aria-label="Ticket properties">
          <section className="tcard tcard--rail">
            <h2 className="tcard__railh">Properties</h2>

            <div className="ef">
              <label htmlFor="tp-status">Status</label>
              <select id="tp-status" value={draft.status} onChange={e => edit('status', e.target.value)}>
                {TICKET_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="ef">
              <label htmlFor="tp-priority">Priority</label>
              <select id="tp-priority" value={draft.priority} onChange={e => edit('priority', e.target.value)}>
                {/* A real "unset" choice, so the state most tickets are in is one the
                    editor can both show and return to. */}
                <option value="">— none —</option>
                {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            {/* The two owners save on change rather than with the rest of the form:
                the endpoint resolves each id to a name against the user record, so
                there is nothing here for a draft to hold on to. */}
            <div className="ef">
              <label htmlFor="tp-responsible">Responsible</label>
              <UserPicker
                id="tp-responsible"
                value={ticket.responsibleId}
                placeholder="Nobody yet"
                disabled={!!busy}
                onChange={v => run('people', setTicketPeople(on, { responsibleId: v }),
                  () => setNotice('Responsible engineer updated.'))}
              />
              <p className="ef__hint">The engineer doing the work. The sprint board groups by this.</p>
            </div>
            <div className="ef">
              <label htmlFor="tp-accountable">Accountable</label>
              <UserPicker
                id="tp-accountable"
                value={ticket.accountableId}
                placeholder="Nobody yet"
                disabled={!!busy}
                onChange={v => run('people', setTicketPeople(on, { accountableId: v }),
                  () => setNotice('Accountable owner updated.'))}
              />
              <p className="ef__hint">The PM answerable to the client for it happening.</p>
            </div>
            {/* Only shown when it has something to say: an old ticket that predates
                the split still names whoever it was filed against. */}
            {ticket.assignee && !ticket.responsibleId && (
              <p className="ef__hint">
                Previously assigned to <strong>{ticket.assignee}</strong>.
              </p>
            )}
            <div className="ef">
              <label htmlFor="tp-due">Due date</label>
              <input id="tp-due" type="date" value={draft.dueDate} onChange={e => edit('dueDate', e.target.value)} />
            </div>
            <div className="ef">
              <label>Sprint</label>
              <p className="railval">
                {ticket.sprint
                  ? <Link className="inlink" to={`/sprints?sprint=${ticket.sprint}`}>{sprintLabel(ticket.sprint)}</Link>
                  : <span className="muted">Not planned</span>}
              </p>
              <p className="ef__hint">Set from the sprint board, against that sprint's capacity.</p>
            </div>
            <div className="ef">
              <label htmlFor="tp-est">Estimate (hours)</label>
              <input id="tp-est" type="number" min="0" step="0.25" value={draft.estHours}
                placeholder="-" onChange={e => edit('estHours', e.target.value)} />
            </div>

            <div className="tpage__save">
              <span className="editcard__status">
                {busy === 'save' ? 'Saving…' : dirty
                  ? `${Object.keys(pending).length} unsaved change${Object.keys(pending).length === 1 ? '' : 's'}`
                  : 'Saved'}
              </span>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!dirty || !!busy}
                onClick={() => { setDraft(draftOf(ticket)); setNotice('') }}>
                Revert
              </button>
              <button type="button" className="btn btn--sm" onClick={save}
                disabled={!dirty || !!busy || !draft.title.trim()}>
                Save
              </button>
            </div>
          </section>

          {/* Time sits under the properties: it is something you record about the
              ticket, not something you read it for. Stacked rather than a five-column
              table, because the rail is narrow and a note deserves the full width. */}
          <section className="tcard tcard--rail">
            <h2 className="tcard__railh">Time</h2>

            <p className="railtot">
              <strong data-over={overBudget ? '' : undefined}>{formatHours(logged)}</strong>
              <span className="muted">
                {est === null || est === 0
                  ? ' logged, no estimate'
                  : ` of ${formatHours(est)}${overBudget ? ', over' : ''}`}
              </span>
            </p>

            {ticket.timerRunning ? (
              <div className="timer timer--on">
                <span className="timer__dot" aria-hidden="true" />
                <span className="timer__t">{formatMinutes(liveMinutes)}</span>
                <button type="button" className="btn btn--sm" disabled={!!busy}
                  onClick={() => run('timer', stopTimer(on, timeNote), fresh => {
                    setTimeNote('')
                    setNotice(fresh.loggedMinutes > 0
                      ? `Stopped: logged ${formatMinutes(fresh.loggedMinutes)}.`
                      : 'Stopped. Under a minute, so nothing was logged.')
                  })}>
                  {busy === 'timer' ? 'Stopping…' : 'Stop'}
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                onClick={() => run('timer', startTimer(on), () => setNotice('Timer started.'))}>
                {busy === 'timer' ? 'Starting…' : 'Start timer'}
              </button>
            )}

            <div className="railtime">
              <div className="railtime__row">
                <div className="ef">
                  <label htmlFor="tp-amount">{editingTime ? 'New amount' : 'Amount'}</label>
                  <input id="tp-amount" type="text" value={timeAmount} autoComplete="off" placeholder="1h30m"
                    onChange={e => setTimeAmount(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submitTime() }} />
                </div>
                <div className="ef">
                  <label htmlFor="tp-date">Date</label>
                  <input id="tp-date" type="date" value={timeDate} onChange={e => setTimeDate(e.target.value)} />
                </div>
              </div>
              <div className="ef">
                <label htmlFor="tp-note">Note</label>
                <input id="tp-note" type="text" value={timeNote} autoComplete="off" placeholder="What you did"
                  onChange={e => setTimeNote(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitTime() }} />
              </div>
              <div className="railtime__go">
                <label className="checkline">
                  <input type="checkbox" checked={timeBillable}
                    onChange={e => setTimeBillable(e.target.checked)} />
                  <span>Billable</span>
                </label>
                <span className="tpage__spacer" />
                {editingTime && (
                  <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                    onClick={() => { setEditingTime(''); setTimeAmount(''); setTimeNote(''); setTimeBillable(true) }}>
                    Cancel
                  </button>
                )}
                <button type="button" className="btn btn--sm" onClick={submitTime}
                  disabled={!!busy || !timeAmount.trim()}>
                  {busy === 'time' ? 'Saving…' : editingTime ? 'Update' : 'Log'}
                </button>
              </div>
            </div>

            {ticket.time.length === 0 ? (
              <p className="muted tsec__empty">Nothing logged yet.</p>
            ) : (
              <ul className="tlog">
                {ticket.time.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).map(e => (
                  <li key={e.id} className="tlog__e" data-editing={editingTime === e.id ? '' : undefined}>
                    <span className="tlog__t">{formatMinutes(e.minutes)}</span>
                    <span className="tlog__d">{e.date}</span>
                    {e.billable === false && <span className="tag">unbilled</span>}
                    <span className="tlog__acts">
                      <button type="button" className="linkbtn" disabled={!!busy}
                        onClick={() => startEditingTime(e)}>Edit</button>
                      <button type="button" className="linkbtn linkbtn--danger" disabled={!!busy}
                        onClick={() => run('time', deleteTime(on, e.id), () => setNotice('Time entry removed.'))}>
                        Remove
                      </button>
                    </span>
                    {(e.note || e.who) && (
                      <span className="tlog__note">
                        {e.note}
                        {e.who ? <span className="muted">{e.note ? ' · ' : ''}{e.who}</span> : null}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </section>
  )
}
