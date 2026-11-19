import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError } from '../api'
import {
  attachFormalEvaluation, deleteEvaluation, fileToBase64, getEvaluation, removeFormalEvaluation,
  reopenEvaluation, saveSupervisorAssessment, sendSelfAssessment, shortDate,
  type EvaluationDetail, type SideInput,
} from '../evaluations'
import ValuesForm from '../components/ValuesForm'

/*
 * /staff/:id/evaluations/:entryId - one person's evaluation log for one quarter.
 *
 * Three tabs, because two full five-value forms plus the paperwork do not fit one
 * readable page:
 *   Overview         where each part stands, the link to send, the side-by-side scores,
 *                    and the formal one-page evaluation.
 *   Self-assessment  the person's answers, read-only here.
 *   Supervisor       the supervisor's answers to the same questions, editable until
 *                    submitted.
 *
 * Not behind a capability gate: a supervisor of record who is not in Leadership still
 * reviews their own reports. The Maestro decides who may open it.
 */

type Tab = 'overview' | 'self' | 'supervisor'
type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: EvaluationDetail }
  | { phase: 'error'; message: string }

const MAX_DOC_MB = 20

function StatusTag({ status }: { status: string }) {
  const kind = status === 'Submitted' ? 'done' : status === 'Not Sent' || status === 'Not Started' ? 'idle' : 'open'
  return <span className="evstatus" data-kind={kind}>{status}</span>
}

export default function EvaluationLog() {
  const { id: staffId = '', entryId = '' } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [copied, setCopied] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    getEvaluation(staffId, entryId)
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({ phase: 'error', message: err instanceof ApiError ? err.message : String(err) }))
  }, [staffId, entryId])

  useEffect(() => { load() }, [load])

  function run<T>(label: string, p: () => Promise<T>, said: string, after?: (r: T) => void): Promise<void> {
    setBusy(label); setNotice(''); setFailure('')
    return p()
      .then(r => { if (after) after(r); setNotice(said) })
      .catch(err => {
        setFailure(err instanceof ApiError ? err.message : String(err))
        throw err
      })
      .finally(() => setBusy(''))
  }
  const quiet = (p: Promise<void>) => { p.catch(() => { /* shown in the failure line */ }) }
  const ready = (data: EvaluationDetail) => setState({ phase: 'ready', data })

  if (state.phase === 'loading') return <section className="page"><p className="empty">Loading…</p></section>
  if (state.phase === 'error') {
    return (
      <section className="page">
        <div className="callout">
          <p className="callout__title">Could not open this evaluation</p>
          <p>{state.message}</p>
          <p className="callout__actions"><Link className="btn" to={`/staff/${staffId}`}>Back to the staff record</Link></p>
        </div>
      </section>
    )
  }

  const { data } = state
  const ev = data.evaluation
  const sup = ev.supervisor
  const doc = ev.formalEvaluation
  const link = ev.self.link || ''
  const firstName = data.name.includes(',') ? data.name.split(',')[1].trim() : data.name.split(' ')[0]

  function send() {
    quiet(run('send', () => sendSelfAssessment(staffId, entryId), 'Self-assessment link is ready to send.',
      () => load()))
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { window.prompt('Copy this link:', link) }
  }

  const mailto = 'mailto:?subject=' + encodeURIComponent(`Your ${ev.quarter} self-assessment`) +
    '&body=' + encodeURIComponent(
      `Hi ${firstName},\n\nHere is your self-assessment for ${ev.quarter}. Score yourself on each of our five values ` +
      `and write the reasons and examples behind each score, plus what you're proud of and where you want to improve.\n\n` +
      `${link}\n\nYou can save a draft and come back to it before you submit.\n`)

  function saveSup(side: SideInput, submit: boolean): Promise<void> {
    return run('sup', () => saveSupervisorAssessment(staffId, entryId, side, submit),
      submit ? 'Supervisor review submitted.' : 'Supervisor review saved as a draft.', ready)
  }

  function reopen(side: 'self' | 'supervisor') {
    const what = side === 'self' ? `${firstName}'s self-assessment` : 'the supervisor review'
    if (!window.confirm(`Reopen ${what} so it can be edited again?`)) return
    quiet(run('reopen', () => reopenEvaluation(staffId, entryId, side), `Reopened ${what}.`, ready))
  }

  async function attach(file: File | undefined) {
    if (!file) return
    if (file.size > MAX_DOC_MB * 1024 * 1024) { setFailure(`That file is over ${MAX_DOC_MB} MB.`); return }
    if (doc?.hasFile && !window.confirm(`Replace ${doc.filename}?`)) return
    let dataBase64 = ''
    try { dataBase64 = await fileToBase64(file) } catch (e) { setFailure(String(e)); return }
    quiet(run('attach', () => attachFormalEvaluation(staffId, entryId,
      { fileName: file.name, mimeType: file.type || 'application/octet-stream', dataBase64 }),
      'Formal evaluation attached.', ready))
    if (fileRef.current) fileRef.current.value = ''
  }

  function removeDoc() {
    if (!window.confirm('Remove the attached formal evaluation?')) return
    quiet(run('remove', () => removeFormalEvaluation(staffId, entryId), 'Formal evaluation removed.', ready))
  }

  function remove() {
    if (!window.confirm(`Delete the ${ev.quarter} evaluation log for ${data.name}? Use this only for a log started by mistake.`)) return
    quiet(run('delete', () => deleteEvaluation(staffId, entryId), 'Deleted.',
      () => navigate(`/staff/${staffId}`)))
  }

  const selfScores: Record<string, number | null> = {}
  for (const a of ev.self.answers.values) selfScores[a.key] = a.score
  const supScores: Record<string, number | null> = {}
  for (const a of sup?.answers.values || []) supScores[a.key] = a.score
  const selfVisible = ev.self.status === 'Submitted'
  const anySup = Object.values(supScores).some(s => s != null)

  const deletable = data.isReviewer && ev.self.status !== 'Submitted' && sup?.status !== 'Submitted' && !doc?.hasFile

  /*
   * Print one side as a clean, read-only page. The screen view (tabs, buttons, an
   * editable form) is hidden on paper; .evprint holds the saved answers read-only under
   * a header naming whose evaluation it is, plus signature lines for the file copy.
   * The document title becomes the PDF file name when "Save as PDF" is picked.
   */
  const printSide: 'self' | 'supervisor' | null =
    tab === 'self' && selfVisible ? 'self' : tab === 'supervisor' && sup ? 'supervisor' : null
  function print() {
    const was = document.title
    const what = printSide === 'self' ? 'Self-assessment' : 'Supervisor review'
    document.title = `${data.name} - ${ev.quarter} ${what}`
    const restore = () => { document.title = was; window.removeEventListener('afterprint', restore) }
    window.addEventListener('afterprint', restore)
    window.print()
  }
  const printBar = printSide && (
    <p className="evprintbar">
      {printSide === 'supervisor' && data.can.editSupervisor && (
        <span className="muted">Prints the last saved version.</span>
      )}
      <button type="button" className="btn btn--sm btn--ghost" onClick={print}>Print</button>
    </p>
  )

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">
          <Link className="inlink" to={`/staff/${staffId}`}>{data.name}</Link> · Quarterly evaluation
        </p>
        <h1>{ev.quarter} evaluation</h1>
        <p className="page__sub-text evhead">
          <span>Self-assessment <StatusTag status={ev.self.status} /></span>
          {sup && <span>Supervisor review <StatusTag status={sup.status} /></span>}
          {doc && <span>Formal evaluation <StatusTag status={doc.hasFile ? 'Submitted' : 'Not Started'} /></span>}
        </p>
        <div className="seg evtabs" role="tablist">
          {(['overview', 'self', 'supervisor'] as Tab[]).map(t => (
            <button key={t} type="button" role="tab" aria-selected={tab === t}
              data-on={tab === t ? '' : undefined} onClick={() => setTab(t)}>
              {t === 'overview' ? 'Overview' : t === 'self' ? 'Self-assessment' : 'Supervisor review'}
            </button>
          ))}
        </div>
      </header>

      {notice && <p className="board2__notice" role="status">{notice}</p>}
      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      {tab === 'overview' && (
        <>
          {/* ── 1. Self-assessment ─────────────────────────────────────────── */}
          <div className="panel">
            <div className="panel__head">
              <h2>1 · Self-assessment</h2>
              <StatusTag status={ev.self.status} />
            </div>
            {ev.self.status === 'Not Sent' ? (
              <>
                <p className="note">
                  {firstName} scores themselves on the five values and explains each score. Generate the link,
                  then send it to them. No sign-in needed: anyone with the link can open and edit it, so send it
                  only to {firstName}. They can save a draft and come back.
                </p>
                {data.can.sendSelf && (
                  <button type="button" className="btn" disabled={!!busy} onClick={send}>
                    {busy === 'send' ? 'Generating…' : 'Generate self-assessment link'}
                  </button>
                )}
              </>
            ) : (
              <>
                <dl className="facts">
                  <div><dt>Sent</dt><dd>{shortDate(ev.self.sentAt)}{ev.self.sentBy ? ` by ${ev.self.sentBy}` : ''}</dd></div>
                  <div><dt>Submitted</dt><dd>{ev.self.submittedAt ? shortDate(ev.self.submittedAt) : <span className="muted">not yet</span>}</dd></div>
                </dl>
                {!link && data.can.sendSelf && (
                  <button type="button" className="btn btn--sm" disabled={!!busy} onClick={send}>
                    {busy === 'send' ? 'Generating…' : 'Generate link'}
                  </button>
                )}
                {link && ev.self.status !== 'Submitted' && (
                  <div className="evlink">
                    <input type="text" readOnly value={link} aria-label="Self-assessment link"
                      onFocus={e => e.currentTarget.select()} />
                    <button type="button" className="btn btn--sm" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
                    <a className="btn btn--sm btn--ghost" href={mailto}>Email it</a>
                  </div>
                )}
                <p className="callout__actions">
                  {selfVisible && (
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setTab('self')}>
                      Read {firstName}'s answers
                    </button>
                  )}
                  {data.can.reopen && ev.self.status === 'Submitted' && (
                    <button type="button" className="linkbtn" disabled={!!busy} onClick={() => reopen('self')}>
                      Reopen for {firstName}
                    </button>
                  )}
                </p>
              </>
            )}
          </div>

          {/* ── 2. Supervisor review ───────────────────────────────────────── */}
          {sup && (
            <div className="panel">
              <div className="panel__head">
                <h2>2 · Supervisor review</h2>
                <StatusTag status={sup.status} />
              </div>
              <p className="note">
                The same five values and two reflections, answered about {firstName}.
                {sup.by ? ` Last saved by ${sup.by}.` : ''}
                {sup.submittedAt ? ` Submitted ${shortDate(sup.submittedAt)}.` : ''}
              </p>
              <p className="callout__actions">
                <button type="button" className="btn btn--sm" onClick={() => setTab('supervisor')}>
                  {data.can.editSupervisor ? (sup.status === 'Not Started' ? 'Start the supervisor review' : 'Continue the supervisor review') : 'Read the supervisor review'}
                </button>
                {data.can.reopen && sup.status === 'Submitted' && (
                  <button type="button" className="linkbtn" disabled={!!busy} onClick={() => reopen('supervisor')}>
                    Reopen
                  </button>
                )}
              </p>
            </div>
          )}

          {/* ── Side by side ───────────────────────────────────────────────── */}
          {(selfVisible || anySup) && (
            <div className="panel">
              <div className="panel__head"><h2>Scores side by side</h2></div>
              <table className="evcompare">
                <thead>
                  <tr><th>Value</th><th>Self</th><th>Supervisor</th><th>Gap</th></tr>
                </thead>
                <tbody>
                  {data.rubric.values.map(v => {
                    const a = selfVisible ? selfScores[v.key] ?? null : null
                    const b = supScores[v.key] ?? null
                    const gap = a != null && b != null ? a - b : null
                    return (
                      <tr key={v.key} data-gap={gap != null && Math.abs(gap) >= 2 ? 'big' : undefined}>
                        <td>{v.name}</td>
                        <td>{a ?? <span className="muted">-</span>}</td>
                        <td>{b ?? <span className="muted">-</span>}</td>
                        <td>{gap == null ? <span className="muted">-</span> : gap > 0 ? `+${gap}` : gap}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="panel__foot">
                Gap = self minus supervisor. A gap of 2 or more is highlighted: that's where the conversation is.
                {!selfVisible && ' Self scores appear once the self-assessment is submitted.'}
              </p>
            </div>
          )}

          {/* ── 3. Formal evaluation ───────────────────────────────────────── */}
          {doc && (
            <div className="panel">
              <div className="panel__head">
                <h2>3 · Formal evaluation</h2>
                <StatusTag status={doc.hasFile ? 'Submitted' : 'Not Started'} />
              </div>
              {doc.hasFile ? (
                <dl className="facts">
                  <div><dt>File</dt><dd><a className="inlink" href={doc.url} target="_blank" rel="noopener noreferrer">{doc.filename}</a></dd></div>
                  {doc.uploaded && <div><dt>Attached</dt><dd>{doc.uploaded}</dd></div>}
                </dl>
              ) : (
                <p className="note">Attach the one-page written evaluation for {ev.quarter} (PDF or Word).</p>
              )}
              {data.can.attach && (
                <p className="callout__actions">
                  <input ref={fileRef} type="file" hidden
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={e => { void attach(e.target.files?.[0]) }} />
                  <button type="button" className="btn btn--sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                    {busy === 'attach' ? 'Uploading…' : doc.hasFile ? 'Replace file' : 'Attach file'}
                  </button>
                  {doc.hasFile && (
                    <button type="button" className="linkbtn" disabled={!!busy} onClick={removeDoc}>Remove</button>
                  )}
                </p>
              )}
            </div>
          )}

          {deletable && (
            <p className="panel__foot">
              Started this log on the wrong quarter?{' '}
              <button type="button" className="linkbtn" disabled={!!busy} onClick={remove}>Delete it</button>
            </p>
          )}
        </>
      )}

      {printSide && (
        <div className="evprint" aria-hidden="true">
          <header className="evprint__head">
            <p className="evprint__kicker">Quarterly evaluation · {ev.quarter}</p>
            <h1>{printSide === 'self' ? 'Self-assessment' : 'Supervisor review'}</h1>
            <dl className="evprint__facts">
              <div><dt>Employee</dt><dd>{data.name}</dd></div>
              {printSide === 'supervisor' && sup?.by && <div><dt>Supervisor</dt><dd>{sup.by}</dd></div>}
              <div>
                <dt>Status</dt>
                <dd>{printSide === 'self'
                  ? `Submitted ${shortDate(ev.self.submittedAt)}`
                  : sup?.status === 'Submitted' ? `Submitted ${shortDate(sup.submittedAt)}` : `${sup?.status} (not submitted)`}
                </dd>
              </div>
            </dl>
          </header>
          <ValuesForm
            rubric={data.rubric}
            answers={printSide === 'self' ? ev.self.answers : sup?.answers}
            editable={false}
            perspective={printSide}
          />
          <div className="evprint__sign">
            <div><span /><p>Employee signature</p></div>
            <div><span /><p>Date</p></div>
            <div><span /><p>Supervisor signature</p></div>
            <div><span /><p>Date</p></div>
          </div>
        </div>
      )}

      {tab === 'self' && (
        ev.self.status === 'Submitted' ? (
          <>
            {printBar}
            <ValuesForm rubric={data.rubric} answers={ev.self.answers} editable={false} perspective="self" />
          </>
        ) : (
          <div className="callout">
            <p className="callout__title">Not submitted yet</p>
            <p>
              {firstName}'s answers show here once they submit
              {ev.self.status === 'Not Sent' ? ', after you send them the link.' : '.'}
            </p>
          </div>
        )
      )}

      {tab === 'supervisor' && sup && (
        <>
          {printBar}
          {data.can.editSupervisor && (
            <p className="page__sub-text">{data.rubric.instructions}</p>
          )}
          <ValuesForm
            rubric={data.rubric}
            answers={sup.answers}
            editable={data.can.editSupervisor}
            perspective="supervisor"
            busy={busy === 'sup'}
            onSave={saveSup}
          />
        </>
      )}
    </section>
  )
}
