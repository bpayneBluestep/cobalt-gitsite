import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useRecord } from './CompanyRecord'
import { useSession } from '../session'
import {
  listEnvelopes, getEnvelope, createEnvelope, uploadEnvelopeDoc, removeEnvelopeDoc,
  reorderEnvelopeDocs, setEnvelopeRecipients, saveEnvelopeTabs, sendEnvelope,
  resendEnvelope, voidEnvelope, deleteEnvelope, verifyEnvelope,
  listAgreementTemplates, fileToBase64, bufToBase64, randomTabId,
  type Envelope, type EnvelopeListRow, type EnvRecipient, type AgreementTemplate, type VerifyResult,
} from '../agreements/api'
import { getContacts, type Company } from '../api'
import { pdfOpen, pdfRenderPage, geoScale, geoApplyTabRect } from '../agreements/pdf'
import '../agreements/agreements.css'

/*
 * The Agreements tab on a company: DocuSign-model e-signature envelopes.
 *
 * An envelope is N uploaded PDFs + M recipients + placed tabs, one status, one
 * audit trail. Ported from the eccrm CRM's agreements surface (where every
 * behavior here shipped and was verified); the server side is Cobalt Maestro's
 * envelope action set, byte-identical to eccrm's engine.
 */

const ENV_KINDS: { v: string; label: string }[] = [
  { v: 'external', label: 'Signs via email link' },
  { v: 'consultant', label: 'Signs in-app (me)' },
  { v: 'inperson', label: 'Signs in person' },
  { v: 'cc', label: 'Receives a copy (CC)' },
]

/* Rendered first-page thumbnails, keyed by source url — pdf.js work is not free,
   so a thumbnail renders once per url per session (module-level survives remounts). */
const ENV_THUMBS: { [url: string]: string } = {}

async function renderThumbs(rootEl: HTMLElement | null): Promise<void> {
  if (!rootEl) return
  const canvases = rootEl.querySelectorAll('canvas[data-thumb]')
  for (let i = 0; i < canvases.length; i++) {
    const canvas = canvases[i] as HTMLCanvasElement
    const url = canvas.getAttribute('data-thumb') || ''
    if (!url || canvas.getAttribute('data-thumb-done')) continue
    canvas.setAttribute('data-thumb-done', '1')
    if (ENV_THUMBS[url]) {
      const img = new Image()
      img.onload = () => { const ctx = canvas.getContext('2d'); if (ctx) { canvas.width = img.width; canvas.height = img.height; ctx.drawImage(img, 0, 0) } }
      img.src = ENV_THUMBS[url]
      continue
    }
    try {
      const pdf = await pdfOpen(url)
      await pdfRenderPage(pdf, 1, canvas, 72)
      ENV_THUMBS[url] = canvas.toDataURL('image/png')
      try { pdf.destroy() } catch { /* */ }
    } catch { /* leave the blank canvas — a thumbnail is never worth an error */ }
  }
}

const fmtDate = (s?: string) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}/${m[1]}` : ''
}

function StatusPill({ status }: { status: string }) {
  return <span className="pill" data-env={status}>{status}</span>
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/* Roles ("slots") of one template. Optional roles may be skipped at apply time. */
function tplSlots(body: any): { id: string; label: string; optional: boolean }[] {
  const out: { id: string; label: string; optional: boolean }[] = []
  for (const r of (body.roles || [])) {
    out.push({ id: r.id, label: r.name || 'Signer', optional: !!r.optional })
  }
  return out
}

/* Slots of one template + consolidation keys for multi-template packets. Two
   DISTINCT roles sharing a name inside one template are different people, so
   duplicate labels are occurrence-numbered; across templates, occurrence N of a
   name merges with occurrence N of the same name. */
function packKeys(body: any): { slot: { id: string; label: string; optional: boolean }; key: string; label: string }[] {
  const seen: { [k: string]: number } = {}
  return tplSlots(body).map(sl => {
    const base = sl.label.trim().toLowerCase()
    const n = (seen[base] = (seen[base] || 0) + 1)
    return { slot: sl, key: n === 1 ? base : base + '#' + n, label: n === 1 ? sl.label : sl.label + ' (' + n + ')' }
  })
}

interface PickOpt { label: string; name: string; email: string; kind: string }

export default function CompanyAgreements() {
  const { company } = useRecord()
  const { can, session } = useSession()
  const fullName = session?.fullName || ''
  const [rows, setRows] = useState<EnvelopeListRow[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Envelope | null>(null)
  const [notice, setNotice] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [picks, setPicks] = useState<PickOpt[]>([])
  const rootRef = useRef<HTMLDivElement | null>(null)

  const canEdit = can('editAgreements')

  const load = useCallback((keepOpen = false) => {
    setError('')
    listEnvelopes(company.id)
      .then(list => { setRows(list || []); if (!keepOpen) setOpen(null) })
      .catch(e => setError(errMsg(e)))
  }, [company.id])

  useEffect(() => { setRows(null); setOpen(null); load() }, [load])

  // Contacts feed the recipient pickers — loaded once per company visit.
  useEffect(() => {
    let dead = false
    getContacts(company.id).then(cl => {
      if (dead) return
      const sorted = (cl.rows || []).slice().sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
      const out: PickOpt[] = sorted
        .filter(ct => (ct.fullName || (ct.firstName + ' ' + ct.lastName)).trim())
        .map(ct => ({
          label: (ct.fullName || (ct.firstName + ' ' + ct.lastName)).trim()
            + (ct.role ? ' — ' + ct.role : '') + (ct.email ? '' : ' (no email on file)'),
          name: (ct.fullName || (ct.firstName + ' ' + ct.lastName)).trim(),
          email: ct.email || '', kind: 'external',
        }))
      if (fullName) out.push({ label: fullName + ' — me, signs in-app', name: fullName, email: '', kind: 'consultant' })
      setPicks(out)
    }).catch(() => { /* picker just stays empty */ })
    return () => { dead = true }
  }, [company.id, fullName])

  useEffect(() => { renderThumbs(rootRef.current) })

  async function openEnvelope(entryId: string) {
    try { setOpen(await getEnvelope(company.id, entryId)) }
    catch (e) { setNotice(errMsg(e)) }
  }

  async function doVoid(entryId: string) {
    const reason = prompt('Void this envelope? Recipients will no longer be able to sign.\nReason (optional):', '')
    if (reason == null) return
    try {
      await voidEnvelope(company.id, entryId, reason)
      if (open && open.entryId === entryId) setOpen(null)
      load(true)
      setNotice('Envelope voided.')
    } catch (e) { setNotice('Void failed: ' + errMsg(e)) }
  }

  if (rows === null && !error) return <p className="empty">Loading agreements…</p>
  if (error) {
    return (
      <div className="callout">
        <p className="callout__title">Could not load agreements</p>
        <p>{error}</p>
        <p className="callout__actions"><button type="button" className="btn" onClick={() => load()}>Try again</button></p>
      </div>
    )
  }

  return (
    <div className="agr" ref={rootRef}>
      {notice && <p className="board2__notice" role="status" onClick={() => setNotice('')}>{notice}</p>}
      {open ? (
        <EnvelopeDetail
          company={company} env={open} picks={picks} canEdit={canEdit}
          setEnv={setOpen}
          onClose={() => { setOpen(null); load() }}
          onVoid={() => doVoid(open.entryId)}
          notify={setNotice}
          reloadList={() => load(true)}
        />
      ) : (
        <>
          <div className="page__headrow" style={{ alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ margin: 0 }}>Agreements</h2>
              <p className="muted" style={{ margin: '4px 0 14px' }}>
                Envelopes of one or more PDF documents sent for e-signature.
              </p>
            </div>
            <span className="env-head-acts">
              {can('manageAgreementTemplates') && (
                <Link className="btn btn--ghost" to="/agreements/templates">Templates</Link>
              )}
              {canEdit && (
                <button type="button" className="btn" onClick={() => setShowNew(true)}>+ New envelope</button>
              )}
            </span>
          </div>
          {rows && rows.length === 0 && (
            <div className="callout">
              <p className="callout__title">No agreements yet</p>
              <p>Create an envelope, upload the PDFs to sign, and add recipients.</p>
            </div>
          )}
          {(rows || []).map(r => (
            <div className="env-row" key={r.entryId}>
              <div className="env-row-main">
                <div className="env-row-title"><b>{r.title}</b> <StatusPill status={r.status} /></div>
                <div className="env-row-meta">
                  {r.docCount} document{r.docCount === 1 ? '' : 's'} · {fmtDate(r.createdAt)}
                  {r.completedAt ? ' · completed ' + fmtDate(r.completedAt) : ''}
                </div>
                <div className="env-row-who">
                  {(r.recipients || []).map((x, i) => (
                    <span key={i} className={'env-chip' + (x.status === 'signed' ? ' done' : '')} title={`${x.kind} · ${x.status}`}>{x.name || '?'}</span>
                  ))}
                </div>
              </div>
              <div className="env-row-acts">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => openEnvelope(r.entryId)}>Open</button>
                {canEdit && r.status !== 'Completed' && r.status !== 'Voided' && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => doVoid(r.entryId)}>Void</button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
      {showNew && (
        <NewEnvelopeModal
          company={company} picks={picks}
          onClose={() => setShowNew(false)}
          onCreated={env => { setShowNew(false); setOpen(env); load(true) }}
          notify={setNotice}
        />
      )}
    </div>
  )
}

/* ---- new envelope: pick templates (packet) or start blank ---- */
function NewEnvelopeModal({
  company, picks, onClose, onCreated, notify,
}: {
  company: Company; picks: PickOpt[]
  onClose: () => void
  onCreated: (env: Envelope) => void
  notify: (m: string) => void
}) {
  const [tpls, setTpls] = useState<AgreementTemplate[] | null>(null)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [step, setStep] = useState<'pick' | 'roles'>('pick')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [slots, setSlots] = useState<{ key: string; label: string; optional: boolean; from: string[] }[]>([])
  const [slotVals, setSlotVals] = useState<Record<number, { name: string; email: string; kind: string; order: number }>>({})

  useEffect(() => {
    // Only ACTIVE upload-based templates are offered for sending.
    listAgreementTemplates()
      .then(list => setTpls((list || []).filter(t =>
        t.bodyJson && t.bodyJson.schemaVersion === 3 && (t.bodyJson.documents || []).length > 0 && t.status === 'Active')))
      .catch(() => setTpls([]))
  }, [])

  const sel = (tpls || []).filter(t => checked[t.entryId])

  async function createBlank() {
    const t = prompt('Envelope title (e.g. "Master Services Agreement"):', '')
    if (t == null) return
    try {
      const env = await createEnvelope(company.id, t.trim() || 'Untitled envelope')
      onCreated(env)
    } catch (e) { notify('Create failed: ' + errMsg(e)) }
  }

  function next() {
    if (!sel.length) return
    // Consolidated roles across the selected templates, matched by trimmed
    // case-insensitive name; `optional` survives only if optional EVERYWHERE.
    const roles: { key: string; label: string; optional: boolean; from: string[] }[] = []
    const byKey: Record<string, { key: string; label: string; optional: boolean; from: string[] }> = {}
    for (const t of sel) {
      for (const k of packKeys(t.bodyJson)) {
        let r = byKey[k.key]
        if (!r) { r = { key: k.key, label: k.label, optional: k.slot.optional, from: [] }; byKey[k.key] = r; roles.push(r) }
        if (!k.slot.optional) r.optional = false
        if (r.from.indexOf(t.name) < 0) r.from.push(t.name)
      }
    }
    setSlots(roles)
    const init: Record<number, { name: string; email: string; kind: string; order: number }> = {}
    roles.forEach((_r, i) => { init[i] = { name: '', email: '', kind: 'external', order: 1 } })
    setSlotVals(init)
    setTitle(sel.length === 1 ? sel[0].name : '')
    setStep('roles')
  }

  /* Create the packet: one envelope, the consolidated recipients set ONCE, then
     each template's documents copied and tabs remapped in selection order. A
     mid-loop failure keeps the draft valid: documents copied so far stay, their
     tabs are saved best-effort, and the message names the template that failed. */
  async function createPacket() {
    const filled: any[] = []; const keyToIdx: Record<string, number> = {}
    for (let i = 0; i < slots.length; i++) {
      const v = slotVals[i] || { name: '', email: '', kind: 'external', order: 1 }
      if (!v.name.trim()) {
        if (slots[i].optional) continue
        notify(`"${slots[i].label}" needs a name (or mark the role optional in its templates).`); return
      }
      keyToIdx[slots[i].key] = filled.length
      filled.push({ role: slots[i].label, name: v.name.trim(), email: v.email.trim(), kind: v.kind, routingOrder: Math.max(1, v.order || 1) })
    }
    if (!filled.length) { notify('At least one signer is needed.'); return }
    setBusy(true)
    let env: Envelope | null = null; const allTabs: any[] = []; let failedTpl = ''
    const finalTitle = title.trim() || (sel.length === 1 ? sel[0].name : `Signing packet (${sel.length} agreements)`)
    try {
      setStatus('Creating envelope…')
      env = await createEnvelope(company.id, finalTitle)
      env = await setEnvelopeRecipients(company.id, env.entryId, filled, finalTitle)
      // consolidated role key -> real recipient id (server materializes in order sent)
      const keyToRid: Record<string, string> = {}
      for (const k in keyToIdx) keyToRid[k] = env.recipients[keyToIdx[k]] ? env.recipients[keyToIdx[k]].id : ''
      let done = 0
      const totalDocs = sel.reduce((n, t) => n + (t.bodyJson!.documents || []).length, 0)
      for (const t of sel) {
        failedTpl = t.name
        const body = t.bodyJson!
        const slotKey: Record<string, string> = {}
        for (const k of packKeys(body)) slotKey[k.slot.id] = k.key
        const mapSlot = (slot: string) => slot === '__sender__' ? '__sender__' : (keyToRid[slotKey[slot] || ''] || null)
        const docs = (body.documents || []).slice().sort((a: any, b: any) => a.order - b.order)
        for (const doc of docs) {
          done++
          setStatus(`Copying "${doc.name}" (${done}/${totalDocs})…`)
          const resp = await fetch(doc.sourceUrl, { credentials: 'include' })
          if (!resp.ok) throw new Error(`Could not fetch template PDF "${doc.name}" (${resp.status}).`)
          const b64 = bufToBase64(await resp.arrayBuffer())
          env = await uploadEnvelopeDoc(company.id, env!.entryId, doc.name, b64, doc.pages || 0)
          const newDoc = env.documents[env.documents.length - 1]
          for (const tb of (body.tabs || [])) {
            if (tb.docId !== doc.id) continue
            const rid = mapSlot(String(tb.recipientId))
            if (!rid) continue
            allTabs.push({ ...tb, id: randomTabId(), docId: newDoc.id, recipientId: rid })
          }
        }
        failedTpl = ''
      }
      setStatus(`Saving ${allTabs.length} fields…`)
      env = await saveEnvelopeTabs(company.id, env.entryId, allTabs)
      notify(`Envelope created — ${sel.length} agreement${sel.length === 1 ? '' : 's'}, ${allTabs.length} fields.`)
      onCreated(env)
    } catch (e) {
      // Keep what copied so far — the draft stays valid and editable.
      if (env && allTabs.length) { try { env = await saveEnvelopeTabs(company.id, env.entryId, allTabs) } catch { /* best-effort */ } }
      setBusy(false); setStatus('')
      if (env) {
        notify((failedTpl ? `"${failedTpl}" failed: ` : 'Packet failed: ') + errMsg(e) + ' — the draft keeps what was copied.')
        onCreated(env)
      } else {
        notify('Create failed: ' + errMsg(e))
      }
    }
  }

  const totals = sel.reduce((acc, t) => {
    acc.docs += (t.bodyJson!.documents || []).length
    acc.fields += (t.bodyJson!.tabs || []).length
    return acc
  }, { docs: 0, fields: 0 })

  return (
    <div className="agr-modal-back" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={'agr-modal' + (step === 'roles' ? ' wide' : '')} role="dialog" aria-modal="true">
        {step === 'pick' && (
          <>
            <div className="agr-modal-head">
              <div>
                <b>New envelope</b>
                <p>Pick every agreement this company needs — they combine into one envelope, one signing session.</p>
              </div>
              <button type="button" className="ico-mini" onClick={onClose}>✕</button>
            </div>
            {tpls === null && <p className="agr-meta">Loading templates…</p>}
            {tpls !== null && tpls.length === 0 && (
              <p className="agr-meta">
                No active templates yet — start with a blank envelope, or build templates under{' '}
                <Link to="/agreements/templates">Agreement Templates</Link>.
              </p>
            )}
            <div className="env-tpl-list">
              {(tpls || []).map(t => (
                <label className="env-tpl-row env-tpl-check" key={t.entryId}>
                  <input type="checkbox" checked={!!checked[t.entryId]}
                    onChange={e => setChecked({ ...checked, [t.entryId]: e.target.checked })} />
                  <span className="env-tpl-check-body">
                    <b>{t.name}</b>
                    <span className="agr-meta">
                      {t.orgName ? t.orgName + ' · ' : ''}
                      {(t.bodyJson!.documents || []).length} PDF{(t.bodyJson!.documents || []).length === 1 ? '' : 's'} · {(t.bodyJson!.tabs || []).length} field{(t.bodyJson!.tabs || []).length === 1 ? '' : 's'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="agr-modal-foot">
              <span className="agr-modal-status">
                {sel.length ? `${sel.length} template${sel.length === 1 ? '' : 's'} · ${totals.docs} PDF${totals.docs === 1 ? '' : 's'} · ${totals.fields} field${totals.fields === 1 ? '' : 's'}` : 'Nothing selected.'}
              </span>
              <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn--ghost" onClick={createBlank}>Blank envelope</button>
              <button type="button" className="btn" disabled={!sel.length} onClick={next}>Continue</button>
            </div>
          </>
        )}
        {step === 'roles' && (
          <>
            <div className="agr-modal-head">
              <div>
                <b>Who signs?</b>
                <p>These {sel.length} template{sel.length === 1 ? '' : 's'} need {slots.length} role{slots.length === 1 ? '' : 's'}. The same name in two templates is the same person here.</p>
              </div>
              <button type="button" className="ico-mini" onClick={onClose} disabled={busy}>✕</button>
            </div>
            <div className="agr-field">
              <label>Envelope title</label>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Onboarding Packet" />
            </div>
            {slots.length > 1 && (
              <p className="env-pack-note">
                Seeing two rows for the same person? The templates spell that role differently — assign both to the
                same person now, and align the role names in the designer later.
              </p>
            )}
            {slots.map((r, i) => (
              <div className="env-tpl-slot" key={r.key}>
                <div className="env-tpl-slot-h">
                  {r.label}{r.optional && <span className="env-slot-opt"> optional — leave blank to skip</span>}
                </div>
                {sel.length > 1 && <div className="env-pack-from">in: {r.from.join(', ')}</div>}
                <div className="env-rec">
                  {picks.length > 0 && (
                    <select className="env-rec-pick" title="Fill from the company's contacts" value=""
                      onChange={e => {
                        const o = picks[Number(e.target.value)]
                        if (o) setSlotVals(v => ({ ...v, [i]: { ...(v[i] || { order: 1 }), name: o.name, email: o.email, kind: o.kind, order: (v[i] || { order: 1 }).order } }))
                      }}>
                      <option value="">Contacts…</option>
                      {picks.map((o, oi) => <option key={oi} value={oi}>{o.label}</option>)}
                    </select>
                  )}
                  <input className="env-rec-name" placeholder="Full name" value={slotVals[i]?.name || ''}
                    onChange={e => setSlotVals(v => ({ ...v, [i]: { ...(v[i] || { email: '', kind: 'external', order: 1 }), name: e.target.value } }))} />
                  <input className="env-rec-email" placeholder="Email (for email link)" value={slotVals[i]?.email || ''}
                    onChange={e => setSlotVals(v => ({ ...v, [i]: { ...(v[i] || { name: '', kind: 'external', order: 1 }), email: e.target.value } }))} />
                  <select value={slotVals[i]?.kind || 'external'}
                    onChange={e => setSlotVals(v => ({ ...v, [i]: { ...(v[i] || { name: '', email: '', order: 1 }), kind: e.target.value } }))}>
                    {ENV_KINDS.filter(k => k.v !== 'cc').map(k => <option key={k.v} value={k.v}>{k.label}</option>)}
                  </select>
                  <input className="env-rec-order" type="number" min={1} title="Signing order" value={slotVals[i]?.order || 1}
                    onChange={e => setSlotVals(v => ({ ...v, [i]: { ...(v[i] || { name: '', email: '', kind: 'external' }), order: Math.max(1, Number(e.target.value) || 1) } }))} />
                </div>
              </div>
            ))}
            <div className="agr-modal-foot">
              <span className="agr-modal-status">{status}</span>
              <button type="button" className="btn btn--ghost" onClick={() => setStep('pick')} disabled={busy}>Back</button>
              <button type="button" className="btn" onClick={createPacket} disabled={busy}>
                {busy ? 'Creating…' : 'Create envelope'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ---- envelope detail: Draft editor / in-flight controls / read-only viewer ---- */
function EnvelopeDetail({
  company, env, picks, canEdit, setEnv, onClose, onVoid, notify, reloadList,
}: {
  company: Company; env: Envelope; picks: PickOpt[]; canEdit: boolean
  setEnv: (e: Envelope) => void
  onClose: () => void
  onVoid: () => void
  notify: (m: string) => void
  reloadList: () => void
}) {
  const navigate = useNavigate()
  const [correct, setCorrect] = useState(false)
  const [title, setTitle] = useState(env.title)
  const [showSend, setShowSend] = useState(false)
  const [showAddTpl, setShowAddTpl] = useState(false)
  const [verify, setVerify] = useState<VerifyResult | null>(null)
  const [handOff, setHandOff] = useState<EnvRecipient | null>(null)
  const saveTimer = useRef<any>(null)

  const draft = env.status === 'Draft'
  const inflight = env.status === 'Sent' || env.status === 'Partially Signed'
  const editable = canEdit && (draft || (correct && inflight))
  const docs = (env.documents || []).slice().sort((a, b) => a.order - b.order)

  useEffect(() => { setTitle(env.title) }, [env.entryId, env.title])

  /* Recipient edits mutate a local copy and persist debounced — one server write
     per meaningful edit, not per keypress. */
  function persistRecipients(next: Envelope, immediate = false) {
    setEnv(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const doSave = () => {
      setEnvelopeRecipients(company.id, next.entryId, next.recipients, title.trim())
        .then(setEnv)
        .catch(e => notify('Save failed: ' + errMsg(e)))
    }
    if (immediate) doSave()
    else saveTimer.current = setTimeout(doSave, 700)
  }

  function recChange(i: number, key: string, val: string) {
    const next = { ...env, recipients: env.recipients.slice() }
    const r: any = { ...next.recipients[i] }
    r[key] = key === 'routingOrder' ? Math.max(1, Number(val) || 1) : val
    next.recipients[i] = r
    persistRecipients(next, key === 'kind' || key === 'routingOrder')
  }

  function recAdd() {
    const maxOrder = env.recipients.reduce((m, r) => Math.max(m, r.routingOrder || 1), 0)
    const next = {
      ...env,
      recipients: env.recipients.concat([{
        id: '', role: '', name: '', email: '', kind: 'external' as const,
        routingOrder: maxOrder + 1, status: 'pending', signedAt: '',
        typedName: '', signatureData: '', tabValues: {}, hasToken: false,
      }]),
    }
    setEnv(next)
  }

  function recRemove(i: number) {
    const next = { ...env, recipients: env.recipients.slice() }
    next.recipients.splice(i, 1)
    persistRecipients(next, true)
  }

  function pickPdf() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/pdf'
    input.multiple = true
    input.onchange = async () => {
      const files = Array.from(input.files || [])
      let cur = env
      for (const f of files) {
        if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) { notify(f.name + ' is not a PDF.'); continue }
        if (f.size > 25 * 1024 * 1024) { notify(f.name + ' is over the 25 MB limit.'); continue }
        try {
          const b64 = await fileToBase64(f)
          // Page count read client-side — the server has no reason to parse the PDF.
          let pages = 0
          try { const pdf = await pdfOpen(URL.createObjectURL(f)); pages = pdf.numPages; try { pdf.destroy() } catch { /* */ } } catch { /* */ }
          const name = f.name.replace(/\.pdf$/i, '')
          cur = await uploadEnvelopeDoc(company.id, cur.entryId, name, b64, pages)
          setEnv(cur)
        } catch (e) { notify('Upload failed: ' + errMsg(e)) }
      }
      reloadList()
    }
    input.click()
  }

  async function removeDoc(docId: string) {
    if (!confirm('Remove this document from the envelope?')) return
    try { setEnv(await removeEnvelopeDoc(company.id, env.entryId, docId)) }
    catch (e) { notify('Remove failed: ' + errMsg(e)) }
  }

  async function moveDoc(docId: string, dir: number) {
    const ids = docs.map(d => d.id)
    const i = ids.indexOf(docId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ids[i] = ids[j]; ids[j] = docId
    try { setEnv(await reorderEnvelopeDocs(company.id, env.entryId, ids)) }
    catch (e) { notify('Reorder failed: ' + errMsg(e)) }
  }

  async function doResend(recipientId: string) {
    try {
      setEnv(await resendEnvelope(company.id, env.entryId, recipientId))
      notify('Signing link re-emailed.')
    } catch (e) { notify('Resend failed: ' + errMsg(e)) }
  }

  async function doVerify() {
    try { setVerify(await verifyEnvelope(company.id, env.entryId)) }
    catch (e) { notify('Verify failed: ' + errMsg(e)) }
  }

  async function doDelete() {
    if (!confirm('Delete this draft envelope? This cannot be undone.')) return
    try {
      await deleteEnvelope(company.id, env.entryId)
      notify('Draft deleted.')
      onClose()
    } catch (e) { notify('Delete failed: ' + errMsg(e)) }
  }

  function signNow(r: EnvRecipient) {
    navigate(`/clients/${company.id}/agreements/${encodeURIComponent(env.entryId)}/sign/${encodeURIComponent(r.id)}`)
  }

  const signedDocs = docs.filter((d: any) => d.signedUrl)

  const metaBits: string[] = []
  if (env.status !== 'Draft') {
    metaBits.push(env.routing === 'sequential' ? 'Signing order enforced' : 'All signers at once')
    if (env.expiresAt) metaBits.push('Expires ' + (fmtDate(String(env.expiresAt).slice(0, 10)) || env.expiresAt))
    if (env.remindEveryDays) metaBits.push(`Reminders every ${env.remindEveryDays} day${env.remindEveryDays === 1 ? '' : 's'}`)
    if (env.senderName) metaBits.push('Sent by ' + env.senderName)
  }

  return (
    <>
      <div className="page__headrow" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {draft && canEdit
              ? <input className="env-title-input" value={title}
                  onChange={e => setTitle(e.target.value)}
                  onBlur={() => { if (title.trim() && title !== env.title) persistRecipients({ ...env, title: title.trim() }, true) }} />
              : env.title}
            <StatusPill status={env.status} />
          </h2>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            {draft ? 'Upload documents, add recipients, place fields, then send.'
              : inflight ? (correct ? 'Correcting — edit pending recipients, or open Place fields to move their fields.' : 'In flight — use Correct to edit recipients or move fields; Resend to nudge a signer.')
                : 'Read-only.'}
          </p>
        </div>
        <div className="env-head-acts">
          <button type="button" className="btn btn--ghost" onClick={onClose}>‹ All agreements</button>
          {editable && (
            <Link className="btn btn--ghost" to={`/clients/${company.id}/agreements/${encodeURIComponent(env.entryId)}/design`}>
              Place fields{env.tabs && env.tabs.length ? ` (${env.tabs.length})` : ''}
            </Link>
          )}
          {draft && canEdit && (
            <>
              <button type="button" className="btn btn--ghost" onClick={() => setShowAddTpl(true)}
                title="Append another template's documents and fields to this envelope">+ Add from template</button>
              <button type="button" className="btn" onClick={() => setShowSend(true)}>Send</button>
            </>
          )}
          {inflight && canEdit && !correct && (
            <button type="button" className="btn btn--ghost" onClick={() => setCorrect(true)}
              title="Edit recipients or move fields on this sent envelope">Correct</button>
          )}
          {correct && (
            <button type="button" className="btn" onClick={async () => {
              setCorrect(false)
              try { setEnv(await getEnvelope(company.id, env.entryId)) } catch { /* keep local */ }
              notify('Corrections saved. Pending signers see the updated envelope on their existing links — use Resend to nudge them.')
            }}>Done correcting</button>
          )}
          {env.status === 'Completed' && (
            <span className="env-signed-list">
              {signedDocs.map((d: any) => (
                <a key={d.id} className="btn btn--ghost btn--sm" href={d.signedUrl} target="_blank" rel="noopener noreferrer">{d.name} — signed</a>
              ))}
              {env.signedPdf && <a className="btn btn--sm" href={env.signedPdf} target="_blank" rel="noopener noreferrer">Certificate of completion</a>}
            </span>
          )}
          {env.status !== 'Draft' && (
            <button type="button" className="btn btn--ghost" onClick={doVerify}
              title="Recompute the audit hash chain and completion hash">Verify</button>
          )}
          {canEdit && env.status !== 'Completed' && env.status !== 'Voided' && (
            <button type="button" className="btn btn--ghost" onClick={onVoid}>Void</button>
          )}
          {draft && canEdit && (
            <button type="button" className="btn btn--ghost dsg-danger" onClick={doDelete}>Delete draft</button>
          )}
        </div>
      </div>

      {correct && (
        <div className="env-correct-note">
          Correcting a sent envelope — recipients who already signed are locked, and their placed fields can't move.
          Pending signers see the updated envelope on their existing link.
        </div>
      )}
      {env.status === 'Voided' && env.voidReason && (
        <div className="env-meta-line">Voided: “{env.voidReason}”</div>
      )}
      {metaBits.length > 0 && <div className="env-meta-line">{metaBits.join(' · ')}</div>}

      <div className="env-card">
        <div className="env-card-h">Documents</div>
        {docs.length === 0 && <p className="agr-meta">No documents yet — upload the PDF(s) this envelope will send for signature.</p>}
        {docs.map((d, i) => (
          <div className="env-doc" key={d.id}>
            <canvas className="env-thumb" data-thumb={d.sourceUrl} width={72} height={93} />
            <div className="env-doc-body">
              <b>{d.name}</b>
              <div className="agr-meta">{d.pages ? `${d.pages} page${d.pages === 1 ? '' : 's'}` : 'PDF'}</div>
            </div>
            {draft && canEdit && (
              <div className="env-doc-acts">
                <button type="button" className="ico-mini" title="Move up" disabled={i === 0} onClick={() => moveDoc(d.id, -1)}>↑</button>
                <button type="button" className="ico-mini" title="Move down" disabled={i === docs.length - 1} onClick={() => moveDoc(d.id, 1)}>↓</button>
                <button type="button" className="ico-mini danger" title="Remove" onClick={() => removeDoc(d.id)}>✕</button>
              </div>
            )}
          </div>
        ))}
        {draft && canEdit && (
          <p style={{ margin: '10px 0 0' }}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={pickPdf}>Add PDF</button>
            <span className="agr-meta" style={{ marginLeft: 8 }}>PDF only · signed in the order shown</span>
          </p>
        )}
      </div>

      <div className="env-card">
        <div className="env-card-h">Recipients</div>
        {(env.recipients || []).length === 0 && <p className="agr-meta">No recipients yet.</p>}
        {(env.recipients || []).map((r, i) => (editable && r.status !== 'signed') ? (
          <div className="env-rec" key={i}>
            {picks.length > 0 && (
              <select className="env-rec-pick" title="Fill from the company's contacts" value=""
                onChange={e => {
                  const o = picks[Number(e.target.value)]
                  if (!o) return
                  const next = { ...env, recipients: env.recipients.slice() }
                  next.recipients[i] = { ...next.recipients[i], name: o.name, email: o.email, kind: o.kind as any }
                  persistRecipients(next, true)
                }}>
                <option value="">Contacts…</option>
                {picks.map((o, oi) => <option key={oi} value={oi}>{o.label}</option>)}
              </select>
            )}
            <input className="env-rec-name" value={r.name} placeholder="Full name" onChange={e => recChange(i, 'name', e.target.value)} />
            <input className="env-rec-email" value={r.email} placeholder="Email (for email link)" onChange={e => recChange(i, 'email', e.target.value)} />
            <select value={r.kind} onChange={e => recChange(i, 'kind', e.target.value)}>
              {ENV_KINDS.map(k => <option key={k.v} value={k.v}>{k.label}</option>)}
            </select>
            <input className="env-rec-order" type="number" min={1} value={r.routingOrder} title="Signing order"
              onChange={e => recChange(i, 'routingOrder', e.target.value)} />
            {r.kind === 'external' && (
              <input className="env-rec-code" value={r.accessCode || ''} placeholder="Access code (optional)"
                title="They must enter this code to open their link — share it out-of-band"
                onChange={e => recChange(i, 'accessCode', e.target.value)} />
            )}
            <button type="button" className="ico-mini danger" title="Remove" onClick={() => recRemove(i)}>✕</button>
          </div>
        ) : (
          <RecipientRow key={i} env={env} r={r} canEdit={canEdit} onResend={() => doResend(r.id)}
            onSignNow={() => signNow(r)} onHandOff={() => setHandOff(r)} />
        ))}
        {editable && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={recAdd}>+ Add recipient</button>
        )}
      </div>

      {env.disclosure && env.disclosure.text && (
        <details className="env-disc">
          <summary>Electronic records &amp; signatures disclosure (version {env.disclosure.version})</summary>
          <pre className="env-disc-text">{env.disclosure.text}</pre>
        </details>
      )}

      {showSend && (
        <SendModal company={company} env={env} onClose={() => setShowSend(false)}
          onSent={(fresh) => {
            setShowSend(false); setEnv(fresh); reloadList()
            const n = (fresh.notified || []).length
            notify('Sent.' + (n ? ` ${n} signing link${n === 1 ? '' : 's'} emailed.` : ' No one to email yet.'))
          }} notify={notify} />
      )}
      {showAddTpl && (
        <AddTemplateModal company={company} env={env} picks={picks}
          onClose={() => setShowAddTpl(false)}
          onApplied={(fresh, msg) => { setShowAddTpl(false); setEnv(fresh); reloadList(); notify(msg) }}
          notify={notify} />
      )}
      {verify && (
        <div className="agr-modal-back" onMouseDown={e => { if (e.target === e.currentTarget) setVerify(null) }}>
          <div className="agr-modal" role="dialog" aria-modal="true">
            <div className="agr-modal-head">
              <div><b>Integrity check</b><p>Audit hash chain + completion record hash.</p></div>
              <button type="button" className="ico-mini" onClick={() => setVerify(null)}>✕</button>
            </div>
            <div className={'env-verify-line ' + (verify.firstBreak ? 'bad' : 'good')}>
              {verify.firstBreak
                ? <span><b>Audit chain BROKEN</b> at event #{verify.firstBreak.index + 1} (“{verify.firstBreak.event}”, {fmtDate(verify.firstBreak.at) || verify.firstBreak.at}): {verify.firstBreak.reason}</span>
                : <span>Audit chain intact — {verify.chained} chained event{verify.chained === 1 ? '' : 's'} verified{verify.unchainedLegacy ? ` (${verify.unchainedLegacy} pre-chain event${verify.unchainedLegacy === 1 ? '' : 's'} skipped)` : ''}.</span>}
            </div>
            {verify.documentHash && verify.documentHash.stored ? (
              <div className={'env-verify-line ' + (verify.documentHash.match === false ? 'bad' : 'good')}>
                {verify.documentHash.match === false
                  ? <span><b>Completion hash MISMATCH</b> — the signing record changed after completion.</span>
                  : <span>Completion record hash matches: <code>{String(verify.documentHash.stored).slice(0, 32)}…</code></span>}
              </div>
            ) : <div className="env-verify-line agr-meta">No completion hash yet (envelope not completed).</div>}
          </div>
        </div>
      )}
      {handOff && (
        <div className="agr-modal-back">
          <div className="agr-modal" role="dialog" aria-modal="true" style={{ width: 'min(460px,94vw)' }}>
            <div className="env-hand">
              <h2>Hand the device to {handOff.name}</h2>
              <p className="agr-meta">They'll review the documents and sign right here, in person. Take the device back when they finish.</p>
              <div className="env-hand-acts">
                <button type="button" className="btn btn--ghost" onClick={() => setHandOff(null)}>Cancel</button>
                <button type="button" className="btn" onClick={() => { const r = handOff; setHandOff(null); signNow(r) }}>Begin signing</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* One recipient's read-only row: status-aware pill + lifecycle actions. */
function RecipientRow({
  env, r, canEdit, onResend, onSignNow, onHandOff,
}: {
  env: Envelope; r: EnvRecipient; canEdit: boolean
  onResend: () => void; onSignNow: () => void; onHandOff: () => void
}) {
  const inflight = env.status === 'Sent' || env.status === 'Partially Signed'
  const turn = env.routing !== 'sequential' || (r.routingOrder || 1) === (env.activeOrder || 0)
  const kindLabel = (ENV_KINDS.find(k => k.v === r.kind) || { label: r.kind }).label
  let pill: React.ReactNode
  if (r.kind === 'cc') pill = <span className="pill">CC</span>
  else if (r.status === 'signed') pill = <span className="pill" data-env="Completed">Signed{r.signedAt ? ' · ' + fmtDate(String(r.signedAt).slice(0, 10)) : ''}</span>
  else if (r.status === 'declined') pill = <span className="pill" data-env="Declined">Declined</span>
  else if (inflight && !turn) pill = <span className="pill" title="Earlier signers haven't finished yet">Waiting · order {r.routingOrder}</span>
  else if (inflight) pill = <span className="pill" data-env="Sent">{r.notifiedAt ? 'Emailed' : 'Their turn'}</span>
  else pill = <span className="pill" data-env="Draft">{r.status}</span>
  return (
    <div className="env-rec-ro">
      <div className="env-rec-ro-main">
        <b>{r.name}</b>
        <span className="agr-meta">
          {r.email || ''}{r.email ? ' · ' : ''}{kindLabel} · order {r.routingOrder}
        </span>
        {r.status === 'declined' && r.declineReason && (
          <div className="agr-meta env-decline-reason">“{r.declineReason}”</div>
        )}
      </div>
      {pill}
      <span className="env-rec-acts">
        {canEdit && inflight && r.status === 'pending' && turn && r.kind === 'external' && r.email && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onResend}>Resend</button>
        )}
        {canEdit && inflight && r.status === 'pending' && turn && r.kind === 'consultant' && (
          <button type="button" className="btn btn--sm" onClick={onSignNow}>Sign now</button>
        )}
        {canEdit && inflight && r.status === 'pending' && turn && r.kind === 'inperson' && (
          <button type="button" className="btn btn--sm" onClick={onHandOff}>Hand off to sign</button>
        )}
      </span>
    </div>
  )
}

/* ---- send options: routing, expiration, reminders + on-page sender fields ---- */
function SendModal({
  company, env, onClose, onSent, notify,
}: {
  company: Company; env: Envelope
  onClose: () => void
  onSent: (env: Envelope) => void
  notify: (m: string) => void
}) {
  const { session } = useSession()
  const fullName = session?.fullName || ''
  const [seq, setSeq] = useState(env.status === 'Draft' ? true : env.routing === 'sequential')
  const [exp, setExp] = useState(Number(env.expireDays) || 30)
  const [rem, setRem] = useState(env.remindEveryDays == null ? 3 : Number(env.remindEveryDays))
  const [busy, setBusy] = useState(false)
  const paneRef = useRef<HTMLDivElement | null>(null)

  const senderTabs = (env.tabs || []).filter((t: any) => t.recipientId === '__sender__')
  const hasSender = senderTabs.length > 0

  /* A sender tab may carry a `source` — a company-record binding resolved when
     this dialog opens. Prefilled but editable; frozen into senderValues at send. */
  const prefillValue = useCallback((key: string): string => {
    switch (key) {
      case 'companyName': return company.name || ''
      case 'contactName': return company.contactName || ''
      case 'contactEmail': return company.contactEmail || ''
      case 'companyLocation': return [company.city, company.state].filter(Boolean).join(', ')
      case 'senderName': return fullName || ''
      case 'today': { const d = new Date(); return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() }
      default: return ''
    }
  }, [company, fullName])

  /* On-page sender fill: render ONLY the pages that carry sender tabs and
     overlay a real input at each tab's spot — the sender sees exactly where
     each value lands. Imperative because pdf.js paints canvases. */
  useEffect(() => {
    if (!hasSender) return
    let dead = false
    const pane = paneRef.current
    if (!pane) return
    const docs = (env.documents || []).slice().sort((a: any, b: any) => a.order - b.order)
    const spots: { doc: any; page: number }[] = []
    for (const doc of docs) {
      const pages: number[] = []
      for (const t of senderTabs) if (t.docId === doc.id && pages.indexOf(t.page) < 0) pages.push(t.page)
      pages.sort((a, b) => a - b).forEach(pg => spots.push({ doc, page: pg }))
    }
    if (!spots.length) { pane.innerHTML = ''; return }
    pane.innerHTML = spots.map(sp =>
      `<div class="env-sv-pagelabel">${sp.doc.name} — page ${sp.page}</div>
       <div class="env-sv-page" data-doc="${sp.doc.id}" data-page="${sp.page}"><canvas></canvas><div class="env-sv-overlay"></div></div>`).join('')
    const width = Math.min(820, Math.max(320, (pane.clientWidth || 820)))
    ;(async () => {
      const byDoc: { [k: string]: any } = {}
      const els = pane.querySelectorAll('.env-sv-page')
      for (let i = 0; i < els.length; i++) {
        if (dead) return
        const el = els[i] as HTMLElement
        const docId = el.getAttribute('data-doc') || ''
        const pageNum = Number(el.getAttribute('data-page')) || 1
        const doc = docs.find((d: any) => d.id === docId)
        const canvas = el.querySelector('canvas') as HTMLCanvasElement
        const pageTabs = senderTabs.filter((t: any) => t.docId === docId && t.page === pageNum)
        try {
          if (!byDoc[docId]) byDoc[docId] = await pdfOpen(doc!.sourceUrl)
          const dims = await pdfRenderPage(byDoc[docId], pageNum, canvas, width)
          el.style.width = canvas.style.width; el.style.height = canvas.style.height
          const scale = geoScale(width, dims.wPt)
          const overlay = el.querySelector('.env-sv-overlay') as HTMLElement
          for (const t of pageTabs) {
            const wrap = document.createElement('div')
            wrap.className = 'env-sv-tab'
            geoApplyTabRect(wrap, t, scale)
            const saved = ((env.senderValues || {}) as any)[t.id]
            if (t.type === 'checkbox') {
              wrap.innerHTML = `<input type="checkbox" id="env-sv-${t.id}" ${saved ? 'checked' : ''} title="${t.label || 'Sender checkbox'}">`
            } else {
              const auto = !saved && (t as any).source ? prefillValue((t as any).source) : ''
              const v = String(saved || auto || '').replace(/"/g, '&quot;')
              wrap.innerHTML = `<input id="env-sv-${t.id}" class="${auto ? 'env-sv-auto' : ''}" value="${v}"
                placeholder="${t.label || (t.required !== false ? 'required' : '')}"
                title="${t.label || 'Sender field'}${t.required !== false ? ' (required)' : ''}">`
              const inp = wrap.querySelector('input') as HTMLInputElement
              inp.addEventListener('input', () => inp.classList.remove('env-sv-auto', 'env-sv-miss'))
            }
            overlay.appendChild(wrap)
          }
        } catch {
          // page didn't render — fall back to labeled inputs so send still works
          el.classList.add('env-sv-err')
          el.style.width = 'auto'; el.style.height = 'auto'
          el.innerHTML = '<div class="env-sv-loading">Couldn\'t render this page — fill the fields here instead.</div>'
            + pageTabs.map((t: any) => `<div class="agr-field" style="padding:0 12px 10px"><label>${t.label || 'Sender field'}${t.required !== false ? ' *' : ''}</label>
              <input id="env-sv-${t.id}"></div>`).join('')
        }
      }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.entryId])

  async function confirm() {
    const senderValues: Record<string, unknown> = {}
    for (const t of senderTabs) {
      const inp = document.getElementById('env-sv-' + t.id) as HTMLInputElement | null
      const v = inp ? (t.type === 'checkbox' ? (inp.checked ? true : '') : inp.value.trim()) : ''
      if (t.required !== false && !v && t.type !== 'checkbox') {
        notify('Fill in the highlighted field before sending.')
        if (inp) { inp.classList.add('env-sv-miss'); inp.scrollIntoView({ block: 'center' }); inp.focus() }
        return
      }
      senderValues[t.id] = v
    }
    setBusy(true)
    try {
      const fresh = await sendEnvelope(company.id, env.entryId, {
        routing: seq ? 'sequential' : 'parallel',
        expireDays: Math.max(0, exp || 0),
        remindEveryDays: Math.max(0, rem || 0),
        senderValues,
      })
      onSent(fresh)
    } catch (e) {
      setBusy(false)
      notify('Send failed: ' + errMsg(e))
    }
  }

  return (
    <div className="agr-modal-back" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={'agr-modal' + (hasSender ? ' wide' : '')} role="dialog" aria-modal="true">
        <div className="agr-modal-head">
          <div><b>Send “{env.title}”</b><p>Each recipient gets a personal signing link by email.</p></div>
          <button type="button" className="ico-mini" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <label className="dsg-req" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={seq} onChange={e => setSeq(e.target.checked)} />
          Enforce signing order — a recipient is emailed only after everyone with a lower order number has finished
        </label>
        <div className="agr-field" style={{ marginTop: 12 }}>
          <label>Expires after (days — 0 = never)</label>
          <input type="number" min={0} value={exp} onChange={e => setExp(Math.max(0, Number(e.target.value) || 0))} />
        </div>
        <div className="agr-field">
          <label>Remind pending signers every (days — 0 = off)</label>
          <input type="number" min={0} value={rem} onChange={e => setRem(Math.max(0, Number(e.target.value) || 0))} />
        </div>
        {hasSender && (
          <div className="env-sender-fields">
            <div className="env-card-h">Your fields — fill them in on the page</div>
            <p className="agr-meta env-sv-hint">These stamp onto the documents before anyone signs. Yellow = auto-filled from the company record; edit anything.</p>
            <div ref={paneRef} className="env-sv-pane"><div className="env-sv-loading">Rendering pages…</div></div>
          </div>
        )}
        <div className="agr-modal-foot">
          <span className="agr-modal-status" />
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={confirm} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  )
}

/* ---- composite templates: append a template to a DRAFT ----
   Roles are matched to the envelope's existing recipients BY NAME; unmatched
   roles add a new person, optional roles can be skipped. */
function AddTemplateModal({
  company, env, picks, onClose, onApplied, notify,
}: {
  company: Company; env: Envelope; picks: PickOpt[]
  onClose: () => void
  onApplied: (env: Envelope, msg: string) => void
  notify: (m: string) => void
}) {
  const [tpls, setTpls] = useState<AgreementTemplate[] | null>(null)
  const [picked, setPicked] = useState<AgreementTemplate | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [maps, setMaps] = useState<Record<number, string>>({})
  const [news, setNews] = useState<Record<number, { name: string; email: string; kind: string; order: number }>>({})

  useEffect(() => {
    listAgreementTemplates()
      .then(list => setTpls((list || []).filter(t =>
        t.bodyJson && t.bodyJson.schemaVersion === 3 && (t.bodyJson.documents || []).length > 0 && t.status === 'Active')))
      .catch(() => setTpls([]))
  }, [])

  const slots = picked ? tplSlots(picked.bodyJson) : []

  function pick(t: AgreementTemplate) {
    setPicked(t)
    const s = tplSlots(t.bodyJson)
    const m: Record<number, string> = {}
    const n: Record<number, { name: string; email: string; kind: string; order: number }> = {}
    s.forEach((sl, i) => {
      const match = (env.recipients || []).find(r => (r.role || '').trim().toLowerCase() === sl.label.trim().toLowerCase())
      m[i] = match ? match.id : '__new__'
      n[i] = { name: '', email: '', kind: 'external', order: 1 }
    })
    setMaps(m); setNews(n)
  }

  async function apply() {
    if (!picked) return
    const body = picked.bodyJson!
    // resolve each slot: existing rid | new person | skipped
    const slotPick: { slot: any; rid?: string; add?: any }[] = []
    for (let i = 0; i < slots.length; i++) {
      const v = maps[i] || '__new__'
      if (v === '__skip__') continue
      if (v === '__new__') {
        const nv = news[i] || { name: '', email: '', kind: 'external', order: 1 }
        if (!nv.name.trim()) {
          if (slots[i].optional) continue
          notify(`"${slots[i].label}" needs a person — pick an existing recipient or enter a name.`); return
        }
        slotPick.push({ slot: slots[i], add: { role: slots[i].label, name: nv.name.trim(), email: nv.email.trim(), kind: nv.kind, routingOrder: Math.max(1, nv.order || 1) } })
      } else slotPick.push({ slot: slots[i], rid: v })
    }
    setBusy(true)
    try {
      let cur = env
      const adds = slotPick.filter(sp => sp.add)
      if (adds.length) {
        setStatus(`Adding ${adds.length} recipient${adds.length === 1 ? '' : 's'}…`)
        // existing recipients go back verbatim WITH ids (the server preserves
        // state by id); new ones follow and come back in order after them.
        const keep = (cur.recipients || []).map(r => ({ id: r.id, role: r.role, name: r.name, email: r.email, kind: r.kind, routingOrder: r.routingOrder, accessCode: (r as any).accessCode }))
        cur = await setEnvelopeRecipients(company.id, cur.entryId, keep.concat(adds.map(a => a.add)), cur.title)
        for (let j = 0; j < adds.length; j++) {
          const nr = cur.recipients[keep.length + j]
          if (nr) adds[j].rid = nr.id
        }
      }
      const slotToRid: Record<string, string> = {}
      for (const sp of slotPick) if (sp.rid) slotToRid[sp.slot.id] = sp.rid
      const mapSlot = (slot: string) => slot === '__sender__' ? '__sender__' : (slotToRid[slot] || null)
      const newTabs: any[] = []
      const docs = (body.documents || []).slice().sort((a: any, b: any) => a.order - b.order)
      for (let di = 0; di < docs.length; di++) {
        const doc = docs[di]
        setStatus(`Copying "${doc.name}" (${di + 1}/${docs.length})…`)
        const resp = await fetch(doc.sourceUrl, { credentials: 'include' })
        if (!resp.ok) throw new Error(`Could not fetch template PDF "${doc.name}" (${resp.status}).`)
        const b64 = bufToBase64(await resp.arrayBuffer())
        cur = await uploadEnvelopeDoc(company.id, cur.entryId, doc.name, b64, doc.pages || 0)
        const newDoc = cur.documents[cur.documents.length - 1]
        for (const tb of (body.tabs || [])) {
          if (tb.docId !== doc.id) continue
          const rid = mapSlot(String(tb.recipientId))
          if (!rid) continue
          newTabs.push({ ...tb, id: randomTabId(), docId: newDoc.id, recipientId: rid })
        }
      }
      setStatus(`Saving ${newTabs.length} fields…`)
      cur = await saveEnvelopeTabs(company.id, cur.entryId, (cur.tabs || []).concat(newTabs))
      onApplied(cur, `"${picked.name}" added — ${docs.length} document${docs.length === 1 ? '' : 's'}, ${newTabs.length} fields.`)
    } catch (e) {
      setBusy(false); setStatus('')
      notify('Add failed: ' + errMsg(e))
    }
  }

  return (
    <div className="agr-modal-back" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={'agr-modal' + (picked ? ' wide' : '')} role="dialog" aria-modal="true">
        <div className="agr-modal-head">
          <div>
            <b>{picked ? picked.name : 'Add from template'}</b>
            <p>{picked ? 'Who fills each of its roles on this envelope?' : 'Its documents and fields append to this envelope — recipients are shared.'}</p>
          </div>
          <button type="button" className="ico-mini" onClick={onClose} disabled={busy}>✕</button>
        </div>
        {!picked && (
          <div className="env-tpl-list">
            {tpls === null && <p className="agr-meta">Loading templates…</p>}
            {tpls !== null && tpls.length === 0 && <p className="agr-meta">No active templates to add.</p>}
            {(tpls || []).map(t => (
              <button type="button" className="env-tpl-row" key={t.entryId} onClick={() => pick(t)}>
                <b>{t.name}</b>
                <span className="agr-meta">
                  {t.orgName ? t.orgName + ' · ' : ''}
                  {(t.bodyJson!.documents || []).length} PDF{(t.bodyJson!.documents || []).length === 1 ? '' : 's'} · {(t.bodyJson!.tabs || []).length} field{(t.bodyJson!.tabs || []).length === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          </div>
        )}
        {picked && slots.map((sl, i) => (
          <div className="env-tpl-slot" key={sl.id}>
            <div className="env-tpl-slot-h">{sl.label}{sl.optional && <span className="env-slot-opt"> optional</span>}</div>
            <div className="env-rec">
              <select value={maps[i] || '__new__'} onChange={e => setMaps({ ...maps, [i]: e.target.value })}>
                {(env.recipients || []).map(r => (
                  <option key={r.id} value={r.id}>{r.name}{r.role ? ' — ' + r.role : ''}{(maps[i] === r.id) ? ' (matched)' : ''}</option>
                ))}
                <option value="__new__">New person…</option>
                {sl.optional && <option value="__skip__">Skip — leave this role out</option>}
              </select>
            </div>
            {(maps[i] || '__new__') === '__new__' && (
              <div className="env-rec">
                {picks.length > 0 && (
                  <select className="env-rec-pick" title="Fill from the company's contacts" value=""
                    onChange={e => {
                      const o = picks[Number(e.target.value)]
                      if (o) setNews(n => ({ ...n, [i]: { ...(n[i] || { order: 1 }), name: o.name, email: o.email, kind: o.kind, order: (n[i] || { order: 1 }).order } }))
                    }}>
                    <option value="">Contacts…</option>
                    {picks.map((o, oi) => <option key={oi} value={oi}>{o.label}</option>)}
                  </select>
                )}
                <input className="env-rec-name" placeholder="Full name" value={news[i]?.name || ''}
                  onChange={e => setNews(n => ({ ...n, [i]: { ...(n[i] || { email: '', kind: 'external', order: 1 }), name: e.target.value } }))} />
                <input className="env-rec-email" placeholder="Email (for email link)" value={news[i]?.email || ''}
                  onChange={e => setNews(n => ({ ...n, [i]: { ...(n[i] || { name: '', kind: 'external', order: 1 }), email: e.target.value } }))} />
                <select value={news[i]?.kind || 'external'}
                  onChange={e => setNews(n => ({ ...n, [i]: { ...(n[i] || { name: '', email: '', order: 1 }), kind: e.target.value } }))}>
                  {ENV_KINDS.filter(k => k.v !== 'cc').map(k => <option key={k.v} value={k.v}>{k.label}</option>)}
                </select>
                <input className="env-rec-order" type="number" min={1} title="Signing order" value={news[i]?.order || 1}
                  onChange={e => setNews(n => ({ ...n, [i]: { ...(n[i] || { name: '', email: '', kind: 'external' }), order: Math.max(1, Number(e.target.value) || 1) } }))} />
              </div>
            )}
          </div>
        ))}
        <div className="agr-modal-foot">
          <span className="agr-modal-status">{status}</span>
          {picked && <button type="button" className="btn btn--ghost" onClick={() => setPicked(null)} disabled={busy}>Back</button>}
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {picked && <button type="button" className="btn" onClick={apply} disabled={busy}>{busy ? 'Adding…' : 'Add to envelope'}</button>}
        </div>
      </div>
    </div>
  )
}
