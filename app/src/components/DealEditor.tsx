import { useEffect, useState } from 'react'
import {
  ApiError, createDeal, updateDeal, deleteDeal, formatMoney,
  DEAL_PHASES, DEAL_CONFIDENCE,
  type Deal, type DealFieldKey,
} from '../api'
import { sanitizeHtml } from '../lib/html'
import RichTextEditor from './RichTextEditor'

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
 */

type Draft = Record<DealFieldKey, string>

const EMPTY: Draft = {
  title: '', phase: 'Open Lead', owner: '', leadSource: '', products: '',
  mrr: '', fees: '', confidence: 'Yellow', anticipatedDate: '', demoDate: '',
  nextStep: '', notes: '', lossReason: '',
}

function draftOf(d: Deal): Draft {
  return {
    title: d.title || '',
    phase: d.phase || 'Open Lead',
    owner: d.owner || '',
    leadSource: d.leadSource || '',
    products: d.products || '',
    mrr: d.mrr === null || d.mrr === undefined ? '' : String(d.mrr),
    fees: d.fees === null || d.fees === undefined ? '' : String(d.fees),
    confidence: d.confidence || 'Yellow',
    anticipatedDate: d.anticipatedDate || '',
    demoDate: d.demoDate || '',
    nextStep: d.nextStep || '',
    notes: d.notes || '',
    lossReason: d.lossReason || '',
  }
}

function changedFields(draft: Draft, saved: Deal): Partial<Record<DealFieldKey, string>> {
  const out: Partial<Record<DealFieldKey, string>> = {}
  const was = draftOf(saved)
  for (const key of Object.keys(draft) as DealFieldKey[]) {
    // Notes is markup: compare sanitised, or a browser's own tidying reads as an edit.
    const now = key === 'notes' ? sanitizeHtml(draft[key]) : draft[key]
    const before = key === 'notes' ? sanitizeHtml(was[key]) : was[key]
    if (now !== before) out[key] = now
  }
  return out
}

export default function DealEditor({
  companyId, companyName, deal, lossReasons, sources, products,
  onSaved, onDeleted, onClose,
}: {
  companyId: string
  companyName: string
  /** An existing deal to edit, or null to create the company's first one. */
  deal: Deal | null
  lossReasons: string[]
  sources: string[]
  products: string[]
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

  const pending = deal ? changedFields(draft, deal) : {}
  const dirty = isNew || Object.keys(pending).length > 0

  function edit(key: DealFieldKey, value: string) {
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
      const fields: Partial<Record<DealFieldKey, string>> = {}
      for (const k of Object.keys(draft) as DealFieldKey[]) {
        const v = k === 'notes' ? sanitizeHtml(draft[k]) : draft[k].trim()
        if (v) fields[k] = v
      }
      run('save', createDeal(companyId, fields), () => onClose())
      return
    }
    if (!Object.keys(pending).length) { onClose(); return }
    run('save', updateDeal(companyId, deal!.entryId, pending), () => onClose())
  }

  /** Close the deal. A loss needs its reason, which is why this is its own step. */
  function closeDeal(outcome: 'Won' | 'Lost') {
    if (!deal || busy) return
    if (outcome === 'Lost' && !draft.lossReason) {
      setFailure('Pick a loss reason — a lost deal with no reason teaches nobody anything.')
      return
    }
    const fields: Partial<Record<DealFieldKey, string>> = { phase: outcome }
    if (outcome === 'Lost') fields.lossReason = draft.lossReason
    run('close', updateDeal(companyId, deal.entryId, fields), () => { setClosing(''); onClose() })
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
            ? 'It inherits the company’s source and owner unless you set them here.'
            : `${companyName}${deal!.createdAt ? ` · opened ${deal!.createdAt}` : ''}` +
              `${deal!.closedAt ? ` · closed ${deal!.closedAt}` : ''}`}
        </p>
      </div>

      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      {!isNew && (deal!.isWon || deal!.isLost) && (
        <p className="callout callout--plain dealcard__decided">
          <strong>{deal!.phase}</strong>
          {deal!.isLost && deal!.lossReason ? ` — ${deal!.lossReason}` : ''}
          {'. '}Move it back to an open phase to reopen it; the close date clears itself.
        </p>
      )}

      <div className="efgrid">
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
          <label htmlFor="d-close">Anticipated close</label>
          <input id="d-close" type="date" value={draft.anticipatedDate}
            onChange={e => edit('anticipatedDate', e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor="d-demo">Demo date</label>
          <input id="d-demo" type="date" value={draft.demoDate}
            onChange={e => edit('demoDate', e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor="d-owner">Owner</label>
          <input id="d-owner" type="text" value={draft.owner} autoComplete="off"
            onChange={e => edit('owner', e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor="d-source">Lead source</label>
          <select id="d-source" value={draft.leadSource} onChange={e => edit('leadSource', e.target.value)}>
            <option value="">—</option>
            {sources.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="ef ef--wide">
          <label htmlFor="d-products">Products</label>
          <input id="d-products" type="text" value={draft.products} autoComplete="off"
            placeholder={products.slice(0, 3).join(', ')}
            onChange={e => edit('products', e.target.value)} />
        </div>
        <div className="ef ef--wide">
          <label htmlFor="d-next">Next step</label>
          <input id="d-next" type="text" value={draft.nextStep} autoComplete="off"
            placeholder="The one thing that moves this forward"
            onChange={e => edit('nextStep', e.target.value)} />
        </div>
        <div className="ef ef--wide">
          <label htmlFor="d-notes">Notes</label>
          <RichTextEditor
            value={deal ? deal.notes || '' : ''}
            docKey={deal ? deal.entryId : 'new-' + companyId}
            ariaLabel="Deal notes"
            placeholder="What you know, who decides, what is in the way…"
            onChange={html => edit('notes', html)}
          />
        </div>
      </div>

      {!isNew && (
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
                <button type="button" className="btn btn--sm" onClick={() => setClosing('Won')} disabled={!!busy}>
                  Won
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setClosing('Lost')} disabled={!!busy}>
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
        {!isNew && (
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
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={!!busy}>Cancel</button>
            <button type="button" className="btn" onClick={save} disabled={!!busy || !dirty || !draft.title.trim()}>
              {isNew ? 'Create deal' : 'Save changes'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
