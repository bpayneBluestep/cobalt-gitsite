import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ApiError, blueIqChat, blueIqTranscribe, blueIqUpload, addIntakeTicket,
  getClientList, getList,
  type IqAttachment, type IqMessage, type IqProposal, type List,
} from '../api'
import {
  blobToBase64, formatClock, recordingSupported, startRecording,
  REC_MAX_MS, type Recording, type RecResult,
} from '../lib/recorder'
import { sanitizeHtml } from '../lib/html'
import RichTextEditor from '../components/RichTextEditor'

/*
 * BlueIQ — guided intake.
 *
 * Someone with a half-formed need talks it through; BlueIQ interviews them, coaches
 * them into recording their screen, and assembles a request an engineer can act on
 * without a round-trip. Ported from beh's Ticket Maestro, which is the version that
 * has been in real use.
 *
 * The shape of the thing is the argument for it: a person who would have written
 * "the report is broken" is asked what they expected, what happened, and where to
 * find it — and is nudged into showing it. That is the whole product.
 *
 * Three properties worth keeping when editing this:
 *
 *   * BlueIQ proposes; it never creates. The proposal lands in an editable review
 *     card, and only the user's Submit creates a ticket — through `addTicket`, the
 *     same path and the same validation as one typed by hand.
 *   * Nothing is uploaded until submit. A recording lives as a blob and an object
 *     URL until then, so abandoning the interview leaves nothing behind.
 *   * No user-visible copy says "AI". It is BlueIQ.
 *
 * Four stages: chat → review → sending → done.
 */

type Stage = 'chat' | 'review' | 'done'

const NARRATION_PREFIX = '(While recording, I said:)'

/** Plain text into safe HTML, keeping line breaks — chat bubbles are not rich text. */
function textToHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

function Spark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z" />
      <path d="M19 14l.9 2.6L22.5 17.5l-2.6.9L19 21l-.9-2.6L15.5 17.5l2.6-.9L19 14z" opacity=".7" />
    </svg>
  )
}

export default function Intake() {
  const { clientId = '' } = useParams()
  const [params] = useSearchParams()
  const listIdParam = params.get('listId') || ''
  const navigate = useNavigate()

  const [list, setList] = useState<List | null>(null)
  const [listError, setListError] = useState('')

  const [stage, setStage] = useState<Stage>('chat')
  const [messages, setMessages] = useState<IqMessage[]>([])
  const [attachments, setAttachments] = useState<IqAttachment[]>([])
  const [proposal, setProposal] = useState<IqProposal | null>(null)
  const [thinking, setThinking] = useState(false)
  const [failure, setFailure] = useState('')
  const [draft, setDraft] = useState('')

  // Review-card edits
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [sending, setSending] = useState('')
  const [created, setCreated] = useState<{ number: number | null; entryId: string } | null>(null)

  // Recording
  const [recording, setRecording] = useState<Recording | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [recBusy, setRecBusy] = useState('')
  const [recWarn, setRecWarn] = useState('')

  const threadRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const booted = useRef(false)

  const hasRecording = attachments.some(a => a.kind === 'video')

  // ---- the list this request belongs to -----------------------------------
  useEffect(() => {
    const load = listIdParam ? getList(listIdParam) : getClientList(clientId)
    load
      .then(l => setList(l))
      .catch(err => setListError(err instanceof ApiError ? err.message : String(err)))
  }, [clientId, listIdParam])

  // ---- one turn ------------------------------------------------------------
  const runTurn = useCallback(async (history: IqMessage[]) => {
    setThinking(true)
    setFailure('')
    try {
      const turn = await blueIqChat(history, {
        hasRecording,
        listName: list?.listName || '',
        clientName: list?.clientName || '',
      })
      const next = turn.assistantMessage
        ? [...history, { role: 'assistant' as const, content: turn.assistantMessage }]
        : history
      setMessages(next)

      if (turn.proposal && (turn.done || turn.proposal.title)) {
        setProposal(turn.proposal)
        setTitle(turn.proposal.title || '')
        setDescription(turn.proposal.description || '')
        setStage('review')
      }
    } catch (err) {
      // A failed turn is shown as a message rather than a banner: the conversation is
      // the interface, and a dead-end banner leaves nowhere to type.
      const detail = err instanceof ApiError ? err.message : String(err)
      setMessages([...history, {
        role: 'assistant',
        content: `Sorry — I had trouble there. Mind trying that again?\n\n(${detail})`,
      }])
    } finally {
      setThinking(false)
    }
  }, [hasRecording, list])

  // The opening move: an empty history means BlueIQ greets and asks the first
  // question, so the greeting is never hard-coded here.
  useEffect(() => {
    if (booted.current || !list) return
    booted.current = true
    void runTurn([])
  }, [list, runTurn])

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  function send() {
    const text = draft.trim()
    if (!text || thinking) return
    setDraft('')
    void runTurn([...messages, { role: 'user', content: text }])
  }

  // ---- attachments ---------------------------------------------------------
  function addAttachment(a: IqAttachment) {
    setAttachments(prev => [...prev, a])
  }

  function removeAttachment(index: number) {
    setAttachments(prev => {
      const gone = prev[index]
      if (gone?.localUrl) { try { URL.revokeObjectURL(gone.localUrl) } catch { /* already revoked */ } }
      return prev.filter((_, i) => i !== index)
    })
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    addAttachment({
      kind: 'image', fileName: file.name, url: '', mime: file.type || 'image/png',
      blob: file, localUrl: URL.createObjectURL(file),
    })
  }

  // Pasting a screenshot straight into the composer — the fastest path there is.
  function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const blob = it.getAsFile()
        if (blob) {
          e.preventDefault()
          addAttachment({
            kind: 'image', fileName: `pasted-${Date.now()}.png`, url: '', mime: blob.type,
            blob, localUrl: URL.createObjectURL(blob),
          })
        }
        return
      }
    }
  }

  function addLink() {
    const raw = window.prompt('Paste a link to the page where this happens:')
    if (!raw) return
    const url = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`
    try { new URL(url) } catch { setRecWarn('That did not look like a web link.'); return }
    addAttachment({ kind: 'url', url })
  }

  // ---- recording -----------------------------------------------------------
  async function onRecordingDone(result: RecResult) {
    setRecording(null)
    setElapsed(0)

    addAttachment({
      kind: 'video',
      fileName: `screen-recording-${Date.now()}.webm`,
      url: '',
      mime: result.videoMime,
      blob: result.videoBlob,
      localUrl: URL.createObjectURL(result.videoBlob),
    })

    // The narration IS the user's answer — transcribe it and let BlueIQ react, rather
    // than leaving a silent attachment and an unanswered question.
    if (!result.audioBlob) {
      setRecBusy('')
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Got your recording — it’s attached. I didn’t catch any narration in it, ' +
          'though. No problem: record again and talk me through what’s happening, or just ' +
          'tell me here what you wanted to show.',
      }])
      return
    }

    setRecBusy('Listening to your recording…')
    try {
      const base64 = await blobToBase64(result.audioBlob)
      const { transcript } = await blueIqTranscribe(base64, result.audioBlob.type || 'audio/webm')
      const said = (transcript || '').trim()
      setRecBusy('')
      if (!said) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Got your recording — it’s attached, but I couldn’t make out any speech. ' +
            'Tell me here what you wanted to show, or record again and talk me through it.',
        }])
        return
      }
      const history: IqMessage[] = [...messages, {
        role: 'user', content: `${NARRATION_PREFIX} ${said}`,
      }]
      setMessages(history)
      await runTurn(history)
    } catch (err) {
      setRecBusy('')
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Got your recording — it’s attached. I couldn’t listen to it just now ' +
          `(${err instanceof ApiError ? err.message : String(err)}), so tell me here what ` +
          'you were showing me.',
      }])
    }
  }

  async function beginRecording() {
    if (recording) return
    setRecWarn('')
    if (!recordingSupported()) {
      setRecWarn('Recording isn’t available in this browser — add a screenshot or just describe it.')
      return
    }
    try {
      const handle = await startRecording(r => { void onRecordingDone(r) }, setElapsed)
      setRecording(handle)
    } catch {
      // Dismissing the screen picker lands here. It is a normal choice, not an error.
      setRecWarn('No screen was shared, so there’s nothing recorded. You can try again any time.')
    }
  }

  // ---- submit --------------------------------------------------------------
  async function submit() {
    if (!list || sending) return
    const finalTitle = title.trim()
    if (!finalTitle) { setFailure('Add a short title so we know what to call this.'); return }
    setFailure('')

    try {
      // Upload now, not earlier: an abandoned interview leaves no orphaned files.
      const refs: Partial<{ kind: string; fileName: string; url: string; mime: string; size: number }>[] = []
      let n = 0
      for (const a of attachments) {
        n++
        if (a.kind === 'url') { refs.push({ kind: 'url', url: a.url, fileName: a.url }); continue }
        if (!a.blob) { if (a.url) refs.push({ kind: a.kind, url: a.url, fileName: a.fileName }); continue }
        setSending(`Uploading ${n} of ${attachments.length}…`)
        const dataBase64 = await blobToBase64(a.blob)
        const { ref } = await blueIqUpload(list.id, {
          fileName: a.fileName || `attachment-${n}`,
          dataBase64,
          mimeType: a.blob.type || (a.kind === 'video' ? 'video/webm' : 'image/png'),
        })
        refs.push({ ...ref, kind: a.kind })
      }

      setSending('Creating your request…')
      const ticket = await addIntakeTicket(
        list.id,
        { title: finalTitle, details: sanitizeHtml(description) },
        {
          attachments: refs,
          conversation: {
            turns: messages.map(m => ({ role: m.role, text: m.content })),
            narration: messages
              .filter(m => m.role === 'user' && m.content.startsWith(NARRATION_PREFIX))
              .map(m => ({ text: m.content.slice(NARRATION_PREFIX.length).trim() })),
          },
        },
      )
      setCreated({ number: ticket.ticketNumber, entryId: ticket.entryId })
      setStage('done')
    } catch (err) {
      setSending('')
      setFailure(err instanceof ApiError ? err.message : String(err))
    }
  }

  function keepRefining() {
    setStage('chat')
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: 'Sure — what else should I add, or what did I get wrong? Tell me and I’ll update your request.',
    }])
  }

  const boardPath = list?.clientId ? `/clients/${list.clientId}/tickets` : '/clients'

  // ---- render --------------------------------------------------------------
  if (listError) {
    return (
      <section className="page">
        <div className="callout">
          <p className="callout__title">Couldn’t start a request</p>
          <p>{listError}</p>
          <p className="callout__actions"><Link className="btn" to="/clients">Back to Clients</Link></p>
        </div>
      </section>
    )
  }

  if (stage === 'done') {
    return (
      <section className="page biq">
        <div className="biq-done">
          <div className="biq-done-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <h2>Your request is in</h2>
          <p>
            We’ve logged {created?.number != null ? `ticket #${created.number}` : 'your ticket'}.
            {' '}We’ll take it from here — thanks for the detail.
          </p>
          <p className="callout__actions">
            {created?.number != null && (
              <Link className="btn" to={`/tickets/${created.number}`}>Open the ticket</Link>
            )}
            {' '}
            <Link className="btn btn--ghost" to={boardPath}>Back to the board</Link>
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="page biq">
      <div className="biq-top">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate(boardPath)}>
          ← Back to board
        </button>
        {list && (
          <span className="muted">
            {list.clientName ? `Request for ${list.clientName}` : list.listName}
          </span>
        )}
      </div>

      <div className="biq-header">
        <span className="biq-spark" aria-hidden="true"><Spark /></span>
        <div>
          <div className="biq-brand-name">BlueIQ</div>
          <div className="biq-brand-sub">Tell me what you need — I’ll turn it into a request.</div>
        </div>
      </div>

      {stage === 'chat' ? (
        <div className="biq-stage">
          <div className="biq-thread" ref={threadRef}>
            {messages.map((m, i) => (
              <div key={i} className={`biq-row biq-row--${m.role}`}>
                {m.role === 'assistant' && (
                  <div className="biq-av" aria-hidden="true"><Spark size={16} /></div>
                )}
                <div
                  className={`biq-bubble biq-bubble--${m.role}`}
                  dangerouslySetInnerHTML={{ __html: textToHtml(m.content) }}
                />
              </div>
            ))}
            {thinking && (
              <div className="biq-row biq-row--assistant">
                <div className="biq-av" aria-hidden="true"><Spark size={16} /></div>
                <div className="biq-bubble biq-bubble--assistant biq-typing">
                  <span /><span /><span />
                </div>
              </div>
            )}
          </div>

          {recording && (
            <div className="biq-recording">
              <span className="biq-rec-dot" aria-hidden="true" />
              <span className="biq-rec-label">Recording</span>
              <span className="biq-rec-time">{formatClock(elapsed)}</span>
              <span className="muted">
                · up to {formatClock(REC_MAX_MS)} ({formatClock(REC_MAX_MS - elapsed)} left)
              </span>
              <button type="button" className="btn btn--sm" onClick={() => recording.stop()}>
                Stop
              </button>
              <p className="biq-rec-coach">
                Talk me through it out loud — say what you expected versus what happened, and
                point to where things are. (Please don’t read client names aloud.)
              </p>
            </div>
          )}

          {recBusy && <p className="biq-rec-busy"><Spark size={15} /> {recBusy}</p>}
          {recWarn && <p className="biq-rec-warn" role="status">{recWarn}</p>}

          <div className="biq-composer">
            <div className="biq-tools">
              <button type="button" className="biq-tool biq-tool--primary"
                onClick={beginRecording} disabled={!!recording || !!recBusy}
                title="Record your screen — the most helpful thing you can do">
                Record screen
              </button>
              <label className="biq-tool">
                Add screenshot
                <input type="file" accept="image/*" onChange={onFilePicked} hidden />
              </label>
              <button type="button" className="biq-tool" onClick={addLink}>Paste a link</button>
            </div>

            {attachments.length > 0 && (
              <ul className="biq-atts">
                {attachments.map((a, i) => (
                  <li key={i} className="biq-att">
                    {a.kind === 'image' && <img src={a.localUrl || a.url} alt="" />}
                    <span className="biq-att-name">
                      {a.kind === 'video' ? 'Screen recording'
                        : a.kind === 'url' ? a.url
                        : a.fileName || 'Screenshot'}
                    </span>
                    <button type="button" className="linkbtn linkbtn--danger"
                      onClick={() => removeAttachment(i)} aria-label="Remove">
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="biq-input-row">
              <textarea
                ref={inputRef}
                value={draft}
                rows={1}
                placeholder="Type your answer…"
                disabled={thinking}
                onPaste={onPaste}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                }}
              />
              <button type="button" className="btn" onClick={send} disabled={thinking || !draft.trim()}>
                Send
              </button>
            </div>
            <p className="biq-hint">
              The most helpful thing you can do is <strong>record your screen and talk me
              through it</strong> — show me what’s happening, or point to where you’d want
              something. Please describe what you see rather than typing client names.
            </p>
          </div>
        </div>
      ) : (
        <div className="biq-stage">
          <div className="biq-review-intro">
            <span className="biq-spark" aria-hidden="true"><Spark /></span>
            <div>
              <div className="biq-review-h">Here’s your request</div>
              <div className="biq-review-sub">
                Give it a look. Edit anything, or keep refining — then send it our way.
              </div>
            </div>
          </div>

          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          <div className="editcard">
            <div className="ef ef--wide">
              <label htmlFor="biq-title">Title</label>
              <input id="biq-title" type="text" value={title} autoComplete="off"
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }} />
            </div>
            <div className="ef ef--wide">
              <label>Description</label>
              <RichTextEditor
                value={proposal?.description || ''}
                docKey="biq-review"
                ariaLabel="Request description"
                placeholder="Describe the request…"
                tall
                onChange={html => setDescription(html)}
              />
            </div>
            <div className="ef ef--wide">
              <label>Attached</label>
              {attachments.length === 0 ? (
                <p className="muted">No screenshots, recordings, or links attached.</p>
              ) : (
                <ul className="biq-atts biq-atts--review">
                  {attachments.map((a, i) => (
                    <li key={i} className="biq-att">
                      {a.kind === 'video' && <video src={a.localUrl || a.url} controls preload="metadata" />}
                      {a.kind === 'image' && <img src={a.localUrl || a.url} alt="" />}
                      {a.kind === 'url' && (
                        <a className="inlink" href={a.url} target="_blank" rel="noopener noreferrer">{a.url}</a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="editcard__foot">
              <span className="editcard__status">{sending}</span>
              <button type="button" className="btn btn--ghost" onClick={keepRefining} disabled={!!sending}>
                Keep refining
              </button>
              <button type="button" className="btn" onClick={submit} disabled={!!sending || !title.trim()}>
                Submit request
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
