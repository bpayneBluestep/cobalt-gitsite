import { useEffect, useState } from 'react'
import {
  ApiError, createDeal, updateDeal, deleteDeal, formatMoney,
  DEAL_PHASES, DEAL_CONFIDENCE,
  type Deal, type DealFieldKey,
} from '../api'
import { sanitizeHtml } from '../lib/html'
import RichTextEditor from './RichTextEditor'
import UserPicker from './UserPicker'
import DealActivity from './DealActivity'
import { useSession } from '../session'

/*
 * Create or edit one deal.
 *
 * Used from both the Pipeline board and Prospecting's "Start a deal", because they
 * are the same act at different moments — the second is just the first deal against
 * a company that had none.
 *
 * Won and Lost are separate buttons rather than two more entries in the phase
 * dropdown. Closing a deal is not the same kind of act as moving it along: it needs
 * a loss reason when lost, and it is the one change people want to be sure about
 * before it lands.
 *
 * The history and the follow-up are NOT fields here — they live in `DealActivity`
 * below, and they save themselves. A note is not a draft: you do not write "spoke to
 * Sarah" and then decide whether to keep it, and holding it in an unsaved form is how
 * it gets lost when the card closes.
 */

/**
 * What the outcome buttons may send. Wider than the form below.
 */
type WriteKey = DealFieldKey

/**
 * The fields the FORM edits — narrower than `DealFieldKey` on purpose:
 *
 *   * `nextStep` / `nextFollowUp` belong to the follow-up control below. Two controls
 *     for one value drift the moment both are on screen.
 *   * `closed` is owned by the Won / Lost / Reopen buttons. Not a checkbox, because
 *     closing a deal is not the same kind of act as editing one — a loss needs its
 *     reason, and it is the change people want to be sure about before it lands.
 */
type EditableKey = Exclude<DealFieldKey, 'nextStep' | 'nextFollowUp' | 'closed'>

type Draft = Record<EditableKey, string>

const EMPTY: Draft = {
  title: '', phase: 'Open Lead', ownerId: '', leadSource: '',
  mrr: '', fees: '', confidence: 'Yellow', firstBillingMonth: '', demoDate: '',
  notes: '', lossReason: '',
}

function draftOf(d: Deal): Draft {
  return {
    title: d.title || '',
    phase: d.phase || 'Open Lead',
    ownerId: d.ownerId || '',
    leadSource: d.leadSource || '',
    mrr: d.mrr === null || d.mrr === undefined ? '' : String(d.mrr),
    fees: d.fees === null || d.fees === undefined ? '' : String(d.fees),
    confidence: d.confidence || 'Yellow',
    firstBillingMonth: d.firstBillingMonth || '',
    demoDate: d.demoDate || '',
    notes: d.notes || '',
    lossReason: d.lossReason || '',
  }
}

function changedFields(draft: Draft, saved: Deal): Partial<Record<EditableKey, string>> {
  const out: Partial<Record<EditableKey, string>> = {}
  const was = draftOf(saved)
  for (const key of Object.keys(draft) as EditableKey[]) {
    // Notes is markup: compare sanitised, or a browser's own tidying reads as an edit.
    const now = key === 'notes' ? sanitizeHtml(draft[key]) : draft[key]
    const before = key === 'notes' ? sanitizeHtml(was[key]) : was[key]
    if (now !== before) out[key] = now
  }
  return out
}

/**
 * "23 days · 23 in phase" — whether the deal is progressing.
 *
 * Two numbers because they answer different questions, and the second one is the one
 * that matters: a deal can be young and stuck, or old and moving steadily. "at least"
 * appears when the phase entry date is the same as the open date, which means either it
 * never moved or the entry predates the field — both true, neither precise.
 */
function AgeLine({ deal }: { deal: Deal }) {
  if (deal.ageDays === null) return null
  const phase = deal.phaseAgeDays
  return (
    <span className="dage">
      <span>{deal.ageDays}d old</span>
      {phase !== null && (
        <span className="dage__ph" data-stuck={deal.stuck ? '' : undefined}>
          {deal.phaseSinceEstimated ? '≥' : ''}{phase}d in {deal.phase}
        </span>
      )}
      {deal.neverTouched
        ? <span className="dage__cold" title="No call, email or note has ever been logged">never touched</span>
        : deal.stale
          ? <span className="dage__cold">
              {deal.touchAgeDays}d since last touch
            </span>
          : null}
    </span>
  )
}

export default function DealEditor({
  companyId, companyName, deal, lossReasons, sources,
  onSaved, onDeleted, onClose,
}: {
  companyId: string
  companyName: string
  /** An existing deal to edit, or null to create the company's first one. */
  deal: Deal | null
  lossReasons: string[]
  sources: string[]
  onSaved: (d: Deal) => void
  onDeleted: () => void
  onClose: () => void
}) {
  const isNew = !deal
  const [draft, setDraft] = useState<Draft>(() =>
    deal ? draftOf(deal) : { ...EMPTY, title: `${companyName} — ` })
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')
  const [closing, setClosing] = useState<'' | 'Won' | 'Lost'>('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setDraft(deal ? draftOf(deal) : { ...EMPTY, title: `${companyName} — ` })
    setFailure(''); setClosing(''); setConfirmDelete(false)
  }, [deal ? deal.entryId : 'new', companyId])

  /*
   * Accounting and Client Success can SEE deals — they need to know what a client bought
   * and what it bills — but only Leadership and Sales may change one. Rather than a second
   * read-only component, the same card goes inert: the fields disable together and the
   * buttons that write are not rendered at all.
   */
  const { can } = useSession()
  const mayEdit = can('editDeals')

  const pending = deal ? changedFields(draft, deal) : {}
  const dirty = isNew || Object.keys(pending).length > 0

  function edit(key: EditableKey, value: string) {
    setDraft(d => ({ ...d, [key]: value }))
    setFailure('')
  }

  function run(label: string, work: Promise<Deal>, after?: (d: Deal) => void) {
    setBusy(label); setFailure('')
    work
      .then(fresh => { onSaved(fresh); if (after) after(fresh) })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function save() {
    if (busy) return
    if (!draft.title.trim()) { setFailure('A deal needs a title.'); return }

    if (isNew) {
      // Send only what was filled in, so a blank never overwrites a server default.
      // An unset owner is left out entirely, which is what makes the server fall back
      // to the company's owner and then to you.
      const fields: Partial<Record<EditableKey, string>> = {}
      for (const k of Object.keys(draft) as EditableKey[]) {
        const v = k === 'notes' ? sanitizeHtml(draft[k]) : draft[k].trim()
        if (v) fields[k] = v
      }
      run('save', createDeal(companyId, fields), () => onClose())
      return
    }
    if (!Object.keys(pending).length) { onClose(); return }
    run('save', updateDeal(companyId, deal!.entryId, pending), () => onClose())
  }

  /**
   * Close the deal. A loss needs its reason, which is why this is its own step.
   *
   * `closed: 'true'` matters as much as the phase, and its absence was a real bug: phase
   * and `closed` are separate fields on purpose — the phase records how far a deal got,
   * the boolean records that it is over — and setting only the first left twenty deals
   * that were plainly finished still sitting in the forecast, on no board column, and
   * absent from the won/lost log. Both, together, always.
   *
   * A lost deal keeps the phase it reached rather than being moved to "Lost": losing at
   * Agreements is a completely different story from losing at Contact Made, and that is
   * exactly what a single terminal phase would erase. Only a WIN moves the phase, because
   * Won is a real stage a deal arrives at.
   */
  function closeDeal(outcome: 'Won' | 'Lost') {
    if (!deal || busy) return
    if (outcome === 'Lost' && !draft.lossReason) {
      setFailure('Pick a loss reason — a lost deal with no reason teaches nobody anything.')
      return
    }
    const fields: Partial<Record<WriteKey, string>> = { closed: 'true' }
    if (outcome === 'Won') fields.phase = 'Won'
    else fields.lossReason = draft.lossReason
    run('close', updateDeal(companyId, deal.entryId, fields), () => { setClosing(''); onClose() })
  }

  /**
   * Put a decided deal back on the board.
   *
   * Clearing `closed` is enough for a LOST deal: it kept the phase it reached, so it
   * reappears exactly where it stopped. A WON deal has no such phase to return to — Won
   * is not a board column — so it also needs one, and Agreements is the honest answer
   * rather than a guess: it is by definition the stage a deal is at immediately before
   * being won.
   */
  function reopen() {
    if (!deal || busy) return
    const fields: Partial<Record<WriteKey, string>> = { closed: 'false' }
    if (deal.phase === 'Won') fields.phase = 'Agreements'
    run('reopen', updateDeal(companyId, deal.entryId, fields), () => onClose())
  }

  function remove() {
    if (!deal || busy) return
    setBusy('delete'); setFailure('')
    deleteDeal(companyId, deal.entryId)
      .then(() => onDeleted())
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => { setBusy(''); setConfirmDelete(false) })
  }

  return (
    <div className="editcard dealcard">
      <div className="editcard__head">
        <h2>{isNew ? `New deal — ${companyName}` : draft.title || 'Deal'}</h2>
        <p className="note">
          {isNew
            ? 'It inherits the company’s source and owner unless you set them here — and falls back to you.'
            : `${companyName}${deal!.createdAt ? ` · opened ${deal!.createdAt}` : ''}` +
              `${deal!.closedAt ? ` · closed ${deal!.closedAt}` : ''}`}
        </p>
        {!isNew && deal!.isOpen && <AgeLine deal={deal!} />}
      </div>

      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      {!isNew && (deal!.isWon || deal!.isLost) && (
        <div className="callout callout--plain dealcard__decided">
          <p>
            <strong>{deal!.isWon ? 'Won' : `Lost at ${deal!.phase}`}</strong>
            {deal!.isLost && deal!.lossReason ? ` — ${deal!.lossReason}` : ''}
            {deal!.closedAt ? ` · ${deal!.closedAt}` : ''}
            {'. '}It is out of the forecast and off the board.
          </p>
          {mayEdit && (
            <p className="callout__actions">
              <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={reopen}>
                {busy === 'reopen' ? 'Reopening…' : 'Reopen'}
              </button>
            </p>
          )}
        </div>
      )}

      {/*
        Not closed, but sitting at a phase no board column holds. The pipeline counts it
        and cannot show it, so the fix belongs wherever the deal is open — here included.
      */}
      {!isNew && deal!.isOpen && deal!.phase === 'Won' && (
        <div className="callout callout--warn">
          <p className="callout__title">Marked Won, but not closed</p>
          <p>
            This deal is still counted as open, so it is in the forecast, and no pipeline
            column can hold it. {mayEdit ? 'Record that it is over:' : 'Only Leadership or Sales can fix this.'}
          </p>
          {mayEdit && (
            <p className="callout__actions">
              <button type="button" className="btn btn--sm" disabled={!!busy}
                onClick={() => run('close', updateDeal(companyId, deal!.entryId, { closed: 'true' }))}>
                {busy === 'close' ? 'Saving…' : 'Mark it closed'}
              </button>
            </p>
          )}
        </div>
      )}

      {!mayEdit && (
        <p className="callout callout--plain">
          Read-only — deals are visible to your role but only Leadership or Sales can change
          them.
        </p>
      )}

      {/* A fieldset so one `disabled` covers every control inside, including the rich-text
          editor, rather than threading a flag through each. `efgrid--fs` only undoes the
          element's default border, padding and intrinsic min-width. */}
      <fieldset className="efgrid efgrid--fs" disabled={!mayEdit}>
        <div className="ef ef--wide">
          <label htmlFor="d-title">Deal<span className="ef__req" aria-hidden="true">*</span></label>
          <input id="d-title" type="text" value={draft.title} autoComplete="off"
            onChange={e => edit('title', e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor="d-phase">Phase</label>
          <select id="d-phase" value={draft.phase} onChange={e => edit('phase', e.target.value)}>
            {DEAL_PHASES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="ef">
          <label htmlFor="d-conf">Confidence</label>
          <select id="d-conf" value={draft.confidence} onChange={e => edit('confidence', e.target.value)}>
            {DEAL_CONFIDENCE.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="ef">
          <label htmlFor="d-mrr">MRR</label>
          <input id="d-mrr" type="number" min="0" step="50" value={draft.mrr}
            onChange={e => edit('mrr', e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor="d-fees">One-time fees</label>
          <input id="d-fees" type="number" min="0" step="100" value={draft.fees}
            onChange={e => edit('fees', e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor="d-billing">Anticipated first billing month</label>
          {/*
            A month, not a date. Nobody knows which DAY of September billing starts on
            while the deal is still open, and asking for one only invites a made-up
            answer that the forecast then reports as though it meant something.
          */}
          <input id="d-billing" type="month" value={draft.firstBillingMonth}
            onChange={e => edit('firstBillingMonth', e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor="d-demo">Demo date</label>
          <input id="d-demo" type="date" value={draft.demoDate}
            onChange={e => edit('demoDate', e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor="d-owner">Owner</label>
          {/*
            Picked, never typed. Owner was free text until 2026-08-20, and that is
            exactly why: "Brandon Payne", "Payne, Brandon" and "brandon" were three
            owners as far as every by-owner total was concerned, and no amount of careful
            typing fixes that at the reporting end.
          */}
          <UserPicker id="d-owner" value={draft.ownerId} placeholder="Nobody yet"
            disabled={!mayEdit} onChange={id => edit('ownerId', id)} />
          {/* A deal imported with a name and no matching user record still has to show
              who it says owns it, or the row reads as unowned when it is not. */}
          {!isNew && !draft.ownerId && deal!.owner && (
            <p className="ef__hint">
              Currently “{deal!.owner}”, imported as a name with no matching staff record.
              Pick someone to make it filterable.
            </p>
          )}
        </div>
        <div className="ef">
          <label htmlFor="d-source">Lead source</label>
          <select id="d-source" value={draft.leadSource} onChange={e => edit('leadSource', e.target.value)}>
            <option value="">—</option>
            {sources.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="ef ef--wide">
          <label htmlFor="d-notes">Background</label>
          <RichTextEditor
            value={deal ? deal.notes || '' : ''}
            docKey={deal ? deal.entryId : 'new-' + companyId}
            ariaLabel="Deal background"
            placeholder="What you know, who decides, what is in the way…"
            onChange={html => edit('notes', html)}
          />
          <p className="ef__hint">
            Standing context, rewritten as it changes. Individual calls and emails go in
            the history below, where they keep their date.
          </p>
        </div>
      </fieldset>

      {mayEdit && !isNew && (
        <div className="dealcard__close">
          {closing === 'Lost' ? (
            <>
              <div className="ef ef--wide">
                <label htmlFor="d-loss">Why was it lost?</label>
                <select id="d-loss" value={draft.lossReason} onChange={e => edit('lossReason', e.target.value)}>
                  <option value="">Pick a reason…</option>
                  {lossReasons.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="dealcard__closebtns">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setClosing('')} disabled={!!busy}>
                  Cancel
                </button>
                <button type="button" className="btn btn--danger btn--sm" onClick={() => closeDeal('Lost')}
                  disabled={!!busy || !draft.lossReason}>
                  {busy === 'close' ? 'Closing…' : 'Mark lost'}
                </button>
              </div>
            </>
          ) : closing === 'Won' ? (
            <div className="dealcard__closebtns">
              <span className="board2__confirm">
                Close as won at {formatMoney(Number(draft.mrr) || 0)} MRR?
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setClosing('')} disabled={!!busy}>
                Not yet
              </button>
              <button type="button" className="btn btn--sm" onClick={() => closeDeal('Won')} disabled={!!busy}>
                {busy === 'close' ? 'Closing…' : 'Mark won'}
              </button>
            </div>
          ) : (
            !deal!.isWon && !deal!.isLost && (
              <div className="dealcard__closebtns">
                <span className="panel__note">Outcome</span>
                <button type="button" className="btn btn--sm" onClick={() => setClosing('Won')}>
                  Won
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setClosing('Lost')}>
                  Lost
                </button>
              </div>
            )
          )}
        </div>
      )}

      <div className="editcard__foot">
        <span className="editcard__status">
          {busy === 'save' ? 'Saving…' : isNew
            ? 'A title is required.'
            : Object.keys(pending).length
              ? `${Object.keys(pending).length} unsaved change${Object.keys(pending).length === 1 ? '' : 's'}`
              : ''}
        </span>
        {mayEdit && !isNew && (
          confirmDelete ? (
            <>
              <span className="board2__confirm">Delete this deal?</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(false)} disabled={!!busy}>
                Keep
              </button>
              <button type="button" className="btn btn--danger btn--sm" onClick={remove} disabled={!!busy}>
                {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(true)} disabled={!!busy}>
              Delete
            </button>
          )
        )}
        {!confirmDelete && (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={!!busy}>
              {mayEdit ? 'Cancel' : 'Close'}
            </button>
            {mayEdit && (
              <button type="button" className="btn" onClick={save} disabled={!!busy || !dirty || !draft.title.trim()}>
                {isNew ? 'Create deal' : 'Save changes'}
              </button>
            )}
          </>
        )}
      </div>

      {/*
        Only for a deal that exists. A new one has no id to hang history on, and asking
        someone to log a call against something not yet saved is a trap.
      */}
      {!isNew && (
        <>
          <h3 className="dealcard__hist">History</h3>
          <DealActivity companyId={companyId} entryId={deal!.entryId} onChanged={onSaved} />
        </>
      )}
    </div>
  )
}
