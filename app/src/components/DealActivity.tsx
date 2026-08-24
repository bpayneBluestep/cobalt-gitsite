import { useEffect, useState } from 'react'
import {
  ApiError, ACTIVITY_KINDS, addDealNote, completeFollowUp, getDeal, setDealFollowUp,
  type ActivityItem, type DealDetail,
} from '../api'
import { todayISO, whenExact, whenLabel } from '../lib/time'
import { useSession } from '../session'

/*
 * A deal's history, and the follow-up that says what happens next.
 *
 * The two live together because they are one loop: you log what happened, and in the
 * same breath you decide when to come back to it. Split across two places, the second
 * half stops being done, which is how a CRM ends up full of deals nobody has touched
 * and nobody has decided to drop either.
 *
 * Newest first, unlike a ticket's history. A ticket is read forwards to understand how
 * it got here; a deal is read backwards to answer "where did we leave this" before a
 * call, and that answer is always at the top.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; deal: DealDetail }
  | { phase: 'error'; error: string }

/** How a follow-up reads, given the server's own verdict on it. */
function followUpLabel(deal: DealDetail): { text: string; tone: string } {
  if (!deal.nextFollowUp) return { text: 'No follow-up set', tone: 'none' }
  const days = deal.followUpInDays
  if (deal.followUpState === 'overdue') {
    const late = days === null ? 0 : Math.abs(days)
    return { text: `Overdue by ${late} day${late === 1 ? '' : 's'}`, tone: 'bad' }
  }
  if (deal.followUpState === 'today') return { text: 'Due today', tone: 'warn' }
  return { text: `Due in ${days} day${days === 1 ? '' : 's'}`, tone: 'ok' }
}

function KindTag({ kind }: { kind?: string }) {
  if (!kind || kind === 'Note') return null
  return <span className="act__kind" data-k={kind}>{kind}</span>
}

function Entry({ item }: { item: ActivityItem }) {
  return (
    <li className="act" data-type={item.type}>
      <div className="act__head">
        <KindTag kind={item.kind} />
        <span className="act__who">{item.who || 'Someone'}</span>
        <span className="act__when" title={whenExact(item.at)}>{whenLabel(item.at)}</span>
      </div>
      {/* Plain text, rendered as text. Notes are typed by people and never contain
          markup we should honour: the deal's rich-text `notes` field is the place for
          formatted content. */}
      <p className="act__text">{item.text}</p>
    </li>
  )
}

export default function DealActivity({
  companyId, entryId, onChanged,
}: {
  companyId: string
  entryId: string
  /** Called with the fresh deal after anything that changes it, so a parent list can re-read. */
  onChanged?: (deal: DealDetail) => void
}) {
  const { can } = useSession()
  const mayEdit = can('editDeals')

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')

  // Composing a note.
  const [kind, setKind] = useState<string>('Call')
  const [text, setText] = useState('')
  const [alsoSchedule, setAlsoSchedule] = useState(false)

  // The follow-up being set. Either alongside a note or on its own.
  const [when, setWhen] = useState('')
  const [step, setStep] = useState('')
  const [rescheduling, setRescheduling] = useState(false)

  function load() {
    setState({ phase: 'loading' })
    getDeal(companyId, entryId)
      .then(deal => setState({ phase: 'ready', deal }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err.message : String(err),
      }))
  }

  useEffect(load, [companyId, entryId])

  const deal = state.phase === 'ready' ? state.deal : null

  /** Every write lands the same way: replace the deal, tell the parent, clear the form. */
  function run(label: string, work: Promise<DealDetail>, after?: () => void) {
    setBusy(label)
    setFailure('')
    work
      .then(fresh => {
        setState({ phase: 'ready', deal: fresh })
        if (onChanged) onChanged(fresh)
        if (after) after()
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function logIt() {
    if (!text.trim() || busy) return
    run('note', addDealNote(companyId, entryId, {
      text: text.trim(),
      kind,
      // Only send the follow-up half if it was actually filled in: an unticked box
      // must not clear a follow-up that already exists.
      ...(alsoSchedule && when ? { nextFollowUp: when, nextStep: step.trim() } : {}),
    }), () => {
      setText('')
      setAlsoSchedule(false)
      setWhen('')
      setStep('')
    })
  }

  function saveFollowUp() {
    if (!when || busy) return
    run('follow', setDealFollowUp(companyId, entryId, { nextFollowUp: when, nextStep: step.trim() }),
      () => { setRescheduling(false); setWhen(''); setStep('') })
  }

  function clearFollowUp() {
    if (busy) return
    run('clear', setDealFollowUp(companyId, entryId, { nextFollowUp: '', nextStep: '' }),
      () => setRescheduling(false))
  }

  function markDone() {
    if (busy) return
    run('done', completeFollowUp(companyId, entryId, {
      ...(text.trim() ? { text: text.trim(), kind } : {}),
    }), () => setText(''))
  }

  if (state.phase === 'loading') return <p className="empty">Loading the history…</p>

  if (state.phase === 'error') {
    return (
      <div className="callout">
        <p className="callout__title">Could not load this deal’s history</p>
        <p>{state.error}</p>
        <p className="callout__actions">
          <button type="button" className="btn" onClick={load}>Try again</button>
        </p>
      </div>
    )
  }

  if (!deal) return null

  const fu = followUpLabel(deal)
  const showForm = rescheduling || !deal.nextFollowUp

  return (
    <div className="dact">
      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      {/* ── what happens next ─────────────────────────────────────────────── */}
      <section className="dact__next" data-tone={fu.tone}>
        <div className="dact__nexthead">
          <h3>Next</h3>
          <span className="dact__due">{fu.text}</span>
        </div>

        {deal.nextFollowUp && (
          <p className="dact__step">
            {deal.nextStep
              ? deal.nextStep
              : <span className="muted">No action written down. Say what you will do, or it will not get done.</span>}
            <span className="dact__on"> · {deal.nextFollowUp}</span>
          </p>
        )}

        {!deal.isOpen && (
          <p className="note">
            This deal is closed, so it has no follow-up. Reopen it to schedule one.
          </p>
        )}

        {mayEdit && deal.isOpen && (
          <>
            {deal.nextFollowUp && !rescheduling && (
              <div className="dact__acts">
                <button type="button" className="btn btn--sm" disabled={!!busy} onClick={markDone}>
                  {busy === 'done' ? 'Saving…' : 'Did it'}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                  onClick={() => { setRescheduling(true); setWhen(deal.nextFollowUp); setStep(deal.nextStep) }}>
                  Reschedule
                </button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={clearFollowUp}>
                  {busy === 'clear' ? 'Clearing…' : 'Nothing more to do'}
                </button>
              </div>
            )}

            {showForm && (
              <div className="dact__fuform">
                <div className="ef">
                  <label htmlFor="fu-when">When</label>
                  <input id="fu-when" type="date" value={when} min={todayISO()}
                    onChange={e => setWhen(e.target.value)} />
                </div>
                <div className="ef ef--wide">
                  <label htmlFor="fu-step">What you will do</label>
                  <input id="fu-step" type="text" value={step} autoComplete="off"
                    placeholder="Call Sarah about the pricing tier"
                    onChange={e => setStep(e.target.value)} />
                </div>
                <div className="dact__acts">
                  {rescheduling && (
                    <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy}
                      onClick={() => { setRescheduling(false); setWhen(''); setStep('') }}>
                      Cancel
                    </button>
                  )}
                  <button type="button" className="btn btn--sm" disabled={!!busy || !when} onClick={saveFollowUp}>
                    {busy === 'follow' ? 'Saving…' : deal.nextFollowUp ? 'Move it' : 'Schedule it'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── log something ─────────────────────────────────────────────────── */}
      {mayEdit && (
        <section className="dact__log">
          <div className="dact__logrow">
            <div className="ef ef--narrow">
              <label htmlFor="act-kind">What happened</label>
              <select id="act-kind" value={kind} onChange={e => setKind(e.target.value)}>
                {(deal.activityKinds && deal.activityKinds.length ? deal.activityKinds : ACTIVITY_KINDS)
                  .map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
          </div>

          <textarea
            className="dact__box"
            rows={3}
            value={text}
            maxLength={4000}
            placeholder="What was said, what they want, what is in the way…"
            onChange={e => setText(e.target.value)}
          />

          {deal.isOpen && (
            <label className="dact__also">
              <input type="checkbox" checked={alsoSchedule}
                onChange={e => setAlsoSchedule(e.target.checked)} />
              <span>…and set a follow-up</span>
            </label>
          )}

          {alsoSchedule && deal.isOpen && (
            <div className="dact__fuform">
              <div className="ef">
                <label htmlFor="act-when">When</label>
                <input id="act-when" type="date" value={when} min={todayISO()}
                  onChange={e => setWhen(e.target.value)} />
              </div>
              <div className="ef ef--wide">
                <label htmlFor="act-step">What you will do</label>
                <input id="act-step" type="text" value={step} autoComplete="off"
                  onChange={e => setStep(e.target.value)} />
              </div>
            </div>
          )}

          <div className="dact__acts">
            <span className="dact__count">
              {deal.activity.length} entr{deal.activity.length === 1 ? 'y' : 'ies'}
            </span>
            <button type="button" className="btn btn--sm" disabled={!!busy || !text.trim()} onClick={logIt}>
              {busy === 'note' ? 'Saving…' : 'Log it'}
            </button>
          </div>
        </section>
      )}

      {/* ── the history ───────────────────────────────────────────────────── */}
      {deal.activity.length === 0 ? (
        <p className="empty">
          Nothing logged yet.{' '}
          {mayEdit ? 'The first call or email you record shows up here.' : ''}
        </p>
      ) : (
        <ol className="actlist">
          {/* A copy before reversing: the array belongs to the loaded deal, and
              reversing in place would scramble it for anything else reading it. */}
          {deal.activity.slice().reverse().map(item => <Entry key={item.id} item={item} />)}
        </ol>
      )}
    </div>
  )
}
