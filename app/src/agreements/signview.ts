/*
 * signview.ts — the shared ENVELOPE signing view. Ported near-verbatim from
 * eccrm's signview.ts (proven in production there).
 *
 * Renders every page of every document with pdf.js and overlays the placed tabs
 * at their geometry coordinates: the current signer's tabs are live controls;
 * everyone else's render read-only (values included — you see what you co-sign).
 * The adopt-once signature modal is reused from signing.ts.
 *
 * Used by BOTH surfaces — the anonymous /spa/sign.html and the in-app signing
 * page — which is what keeps them identical. The host supplies the container and
 * the submit function; this file owns rendering, the NEXT walker, and
 * required-field gating.
 */

import {
  pdfOpen, pdfOpenData, pdfRenderPage, geoScale, geoApplyTabRect, type GeoPage,
} from './pdf'
import {
  sigEsc, sigToday, sigDateOf, sigAdopted, sigResetAdopted, sigOnChange, sigClickSign,
} from './signing'

export interface SvHost {
  container: HTMLElement
  env: any                  // { title, documents[], tabs[], recipients[], me }
  meId: string              // recipient id of the person signing ('' = read-only)
  submit: (payload: { signatureData: string; initialsData: string; typedName: string; tabValues: Record<string, any> }) => Promise<any>
  onDone: (res: any) => void
  /* finish-later: server-saved partial progress for this signer, and the save
     function. Progress restores field values and clicked-box state; the signature
     itself is never saved server-side pre-submit. */
  progress?: any
  saveProgress?: (p: { tabValues: Record<string, any>; typedName: string; hasAdopted: boolean }) => Promise<any>
  /* lazy documents: fetch one document's base64 on demand (anonymous page rides
     the token-gated docBytes action; in-app uses sourceUrl instead). */
  fetchDoc?: (docId: string) => Promise<string>
  /* Consent line docked in the sticky action bar. When set, Finish stays
     refused until the box is checked. */
  consentLabel?: string
}

let SV: SvHost | null = null
const SV_BASE_W = 816

/* Per-field signing state: adopting a signature never fills a box by itself —
   every signature/initials box must be individually clicked (the DocuSign model). */
const SV_APPLIED: { [tabId: string]: boolean } = {}
let SV_PENDING = '' // box clicked before a signature existed — apply after adopt
const SV_RESUME: { [tabId: string]: boolean } = {}
let SV_PROGVALS: Record<string, any> = {}
let SV_SAVE_TIMER: any = 0
let SV_LAST_SAVE = ''
const SV_DOCS_RENDERED: { [docId: string]: boolean } = {}

function svApply(tabId: string): void {
  const a = sigAdopted()
  if (!a || !a.dataUrl) { SV_PENDING = tabId; sigClickSign(); return }
  SV_APPLIED[tabId] = true
  svRepaintMine()
}
function svUnapply(tabId: string): void {
  delete SV_APPLIED[tabId]
  svRepaintMine()
}

export function svMount(host: SvHost): void {
  SV = host
  sigResetAdopted()
  for (const k in SV_APPLIED) delete SV_APPLIED[k]
  for (const k in SV_RESUME) delete SV_RESUME[k]
  for (const k in SV_DOCS_RENDERED) delete SV_DOCS_RENDERED[k]
  SV_PROGVALS = {}
  SV_PENDING = ''
  SV_LAST_SAVE = ''
  if (SV_SAVE_TIMER) { clearTimeout(SV_SAVE_TIMER); SV_SAVE_TIMER = 0 }
  const prog = host.meId && host.progress ? host.progress : null
  if (prog && prog.tabValues) {
    for (const t of (host.env.tabs || [])) {
      if (t.recipientId !== host.meId) continue
      const v = (prog.tabValues as any)[t.id]
      if (t.type === 'signature' || t.type === 'initials') { if (v === true) SV_RESUME[t.id] = true }
      else if (v != null) SV_PROGVALS[t.id] = v
    }
  }
  sigOnChange(svRepaintMine)
  let docs = (host.env.documents || []).slice().sort((a: any, b: any) => a.order - b.order)
  // Document visibility: an active signer sees ONLY the documents they have
  // fields on. (The public endpoint enforces the same server-side.) Read-only
  // views (meId '') and completed envelopes keep the full list.
  if (host.meId) {
    const mineDocs: { [id: string]: boolean } = {}
    for (const t of (host.env.tabs || [])) { if (t.recipientId === host.meId) mineDocs[t.docId] = true }
    const filtered = docs.filter((d: any) => mineDocs[d.id])
    if (filtered.length) docs = filtered
  }
  let html = '<div class="sv-doc-list">'
  let di = 0
  for (const doc of docs) {
    di++
    const n = Math.max(1, doc.pages || 1)
    html += `<div class="sv-dochead${di === 1 ? ' first' : ''}">
      <span class="sv-docnum">Document ${di} of ${docs.length}</span>
      <span class="sv-doctitle">${sigEsc(doc.name)}</span>
      <span class="sv-docpages">${n} page${n === 1 ? '' : 's'}</span>
    </div>`
    for (let p = 1; p <= n; p++) {
      html += `<div class="sv-page" data-doc="${sigEsc(doc.id)}" data-page="${p}" data-url="${sigEsc(doc.sourceUrl)}">
        <canvas></canvas><div class="sv-overlay"></div></div>`
    }
  }
  html += '</div>'
  const hasResume = prog && (Object.keys(SV_PROGVALS).length || Object.keys(SV_RESUME).length)
  host.container.innerHTML = (hasResume
    ? `<div class="sv-resume">Welcome back — your saved progress was restored.${Object.keys(SV_RESUME).length ? ' Sign any box to re-adopt your signature; your previously signed boxes fill back in with it.' : ''}</div>`
    : '')
    + html
    + `<div class="sv-bar">
        ${host.consentLabel && host.meId ? `<label class="sv-consent"><input type="checkbox" id="sv-consent" onchange="svUpdateProgress()"> ${sigEsc(host.consentLabel)}</label><div class="sv-consent-note" id="sv-consent-note" style="display:none" role="alert"></div>` : ''}
        <div class="sv-progress" id="sv-progress"></div>
        <span class="sv-savenote" id="sv-savenote"></span>
        ${host.saveProgress && host.meId ? '<button type="button" class="sg-btn ghost" id="sv-later" onclick="svSaveLater()">Finish later</button>' : ''}
        <button type="button" class="sg-btn ghost" id="sv-next" onclick="svNext()">Next</button>
        <button type="button" class="sg-btn primary" id="sv-finish" onclick="svFinish()" disabled>Finish</button>
      </div>`
  svRenderPages()
}

const SV_PAGES: GeoPage[] = []
/* Lazy per-document rendering: the first document renders immediately; the rest
   render as the reader approaches them (IntersectionObserver, generous margin). */
async function svRenderPages(): Promise<void> {
  const host = SV; if (!host) return
  SV_PAGES.length = 0
  const docs = (host.env.documents || []).slice().sort((a: any, b: any) => a.order - b.order)
  const pageEls = host.container.querySelectorAll('.sv-page')
  for (let i = 0; i < pageEls.length; i++) pageEls[i].classList.add('sv-page-loading')
  if (docs.length) await svRenderDoc(docs[0].id)
  if (docs.length > 1 && typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        io.unobserve(en.target)
        svRenderDoc((en.target as HTMLElement).getAttribute('data-doc') || '')
      }
    }, { rootMargin: '2400px 0px' })
    // Observe EVERY placeholder page, not just each doc's first: an instant jump
    // (End key, scrollbar drag) can land mid-doc without the first page ever
    // entering the margin, and the doc would never render.
    for (let i = 1; i < docs.length; i++) {
      const els2 = host.container.querySelectorAll(`.sv-page[data-doc="${docs[i].id}"]`)
      for (let j = 0; j < els2.length; j++) io.observe(els2[j])
    }
  } else {
    for (let i = 1; i < docs.length; i++) await svRenderDoc(docs[i].id)
  }
  svUpdateProgress()
}

async function svRenderDoc(docId: string): Promise<void> {
  const host = SV; if (!host || !docId || SV_DOCS_RENDERED[docId]) return
  SV_DOCS_RENDERED[docId] = true
  const width = Math.min(SV_BASE_W, Math.max(320, (host.container.clientWidth || SV_BASE_W) - 8))
  const docMeta = (host.env.documents || []).find((d: any) => d.id === docId)
  const els = host.container.querySelectorAll(`.sv-page[data-doc="${docId}"]`)
  let pdf: any = null
  try {
    if (docMeta && docMeta.dataB64) pdf = await pdfOpenData(docMeta.dataB64)
    else if (host.fetchDoc) { const b64 = await host.fetchDoc(docId); pdf = await pdfOpenData(b64); if (docMeta) docMeta.dataB64 = b64 }
    else if (docMeta && docMeta.sourceUrl) pdf = await pdfOpen(docMeta.sourceUrl)
    else throw new Error('no document source')
  } catch {
    for (let i = 0; i < els.length; i++) { els[i].classList.remove('sv-page-loading'); els[i].classList.add('sv-page-err') }
    return
  }
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as HTMLElement
    const pageNum = Number(el.getAttribute('data-page')) || 1
    const canvas = el.querySelector('canvas') as HTMLCanvasElement
    try {
      const dims = await pdfRenderPage(pdf, pageNum, canvas, width)
      SV_PAGES.push({ docId, page: pageNum, wPt: dims.wPt, hPt: dims.hPt })
      el.style.width = canvas.style.width; el.style.height = canvas.style.height
      el.classList.remove('sv-page-loading')
      svPaintOverlay(el, docId, pageNum, width)
    } catch { el.classList.remove('sv-page-loading'); el.classList.add('sv-page-err') }
  }
  // Rehydrate saved values into the just-painted controls, then refresh state.
  svRestore(SV_PROGVALS)
  if (sigAdopted()) svRepaintMine(); else svUpdateProgress()
}

function svScale(docId: string, page: number, width: number): number {
  const info = SV_PAGES.find(p => p.docId === docId && p.page === page)
  return info ? geoScale(width, info.wPt) : 1
}

function svPaintOverlay(pageEl: HTMLElement, docId: string, page: number, width: number): void {
  const host = SV!
  const overlay = pageEl.querySelector('.sv-overlay') as HTMLElement
  const scale = svScale(docId, page, width)
  overlay.innerHTML = ''
  const byId: { [k: string]: any } = {}
  for (const r of (host.env.recipients || [])) byId[r.id] = r
  for (const t of (host.env.tabs || [])) {
    if (t.docId !== docId || t.page !== page) continue
    const mine = t.recipientId === host.meId
    const owner = byId[t.recipientId] || {}
    const el = document.createElement('div')
    el.className = 'sv-tab ' + (mine ? 'mine' : 'theirs')
    el.setAttribute('data-svtab', t.id)
    geoApplyTabRect(el, t, scale)
    el.innerHTML = svTabHtml(t, owner, mine)
    overlay.appendChild(el)
  }
}

/* The control (mine) or the read-only value (theirs) for one tab. */
function svTabHtml(t: any, owner: any, mine: boolean): string {
  // Sender-filled fields: values live on the envelope, not a signer.
  if (t.recipientId === '__sender__') {
    const sval = ((SV && SV.env && (SV.env as any).senderValues) || {})[t.id]
    if (t.type === 'checkbox') return `<span class="sv-box${sval ? ' on' : ''}"></span>`
    return `<span class="sv-ro">${sigEsc(sval == null ? '' : String(sval))}</span>`
  }
  const val = (owner.tabValues || {})[t.id]
  const signed = owner.status === 'signed'
  if (t.type === 'signature' || t.type === 'initials') {
    if (mine) {
      const a = sigAdopted()
      const mark = a ? (t.type === 'initials' ? (a.initialsUrl || a.dataUrl) : a.dataUrl) : ''
      if (SV_APPLIED[t.id] && mark) return `<img class="sv-sig-img sv-applied" src="${mark}" alt="${t.type}" onclick="svUnapply('${sigEsc(t.id)}')" title="Click to remove">`
      return `<button type="button" class="sv-sign-box" onclick="svApply('${sigEsc(t.id)}')">${t.type === 'initials' ? 'Initial' : 'Sign'}</button>`
    }
    const theirMark = t.type === 'initials' ? (owner.initialsData || owner.signatureData) : owner.signatureData
    if (signed && theirMark) return `<img class="sv-sig-img" src="${sigEsc(theirMark)}" alt="">`
    return `<span class="sv-ph">${sigEsc(owner.name || '')}</span>`
  }
  if (t.type === 'dateSigned') return `<span class="sv-ro">${mine ? sigToday() : (signed ? sigDateOf(owner.signedAt) : '')}</span>`
  if (t.type === 'name') {
    if (mine) { const a = sigAdopted(); return `<span class="sv-ro">${sigEsc(a && a.typedName ? a.typedName : '')}</span>` }
    return `<span class="sv-ro">${sigEsc(signed ? (owner.typedName || owner.name || '') : '')}</span>`
  }
  if (t.type === 'checkbox') {
    if (mine) return `<input type="checkbox" data-svfk="${sigEsc(t.id)}" onchange="svUpdateProgress()">`
    return `<span class="sv-box${val ? ' on' : ''}"></span>`
  }
  if (t.type === 'dropdown') {
    if (mine) return `<select data-svfk="${sigEsc(t.id)}" onchange="svUpdateProgress()"><option value=""></option>${(t.options || []).map((o: string) => `<option>${sigEsc(o)}</option>`).join('')}</select>`
    return `<span class="sv-ro">${sigEsc(val == null ? '' : String(val))}</span>`
  }
  if (t.type === 'radioGroup') {
    if (mine) return `<span class="sv-radio" data-svfk="${sigEsc(t.id)}">${(t.options || []).map((o: string) =>
      `<label><input type="radio" name="svr_${sigEsc(t.id)}" value="${sigEsc(o)}" onchange="svUpdateProgress()"> ${sigEsc(o)}</label>`).join('')}</span>`
    return `<span class="sv-ro">${sigEsc(val == null ? '' : String(val))}</span>`
  }
  // text
  if (mine) return `<input type="text" data-svfk="${sigEsc(t.id)}" placeholder="${sigEsc(t.label || '')}" oninput="svUpdateProgress()">`
  return `<span class="sv-ro">${sigEsc(val == null ? '' : String(val))}</span>`
}

/* Repaint only MY tabs after a signature is adopted — typed values survive. */
function svRepaintMine(): void {
  const host = SV; if (!host) return
  // Adoption completes the click that opened the modal: apply THAT box only —
  // plus any boxes restored from a saved session (they were clicked before).
  if (SV_PENDING && sigAdopted()) { SV_APPLIED[SV_PENDING] = true; SV_PENDING = '' }
  if (sigAdopted()) { for (const k in SV_RESUME) { SV_APPLIED[k] = true; delete SV_RESUME[k] } }
  const keep = svCollect()
  const els = host.container.querySelectorAll('.sv-tab.mine')
  const byId: { [k: string]: any } = {}
  for (const r of (host.env.recipients || [])) byId[r.id] = r
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as HTMLElement
    const t = (host.env.tabs || []).find((x: any) => x.id === el.getAttribute('data-svtab'))
    if (t) el.innerHTML = svTabHtml(t, byId[t.recipientId] || {}, true)
  }
  svRestore(keep)
  svUpdateProgress()
}

function svCollect(): Record<string, any> {
  // Saved values act as defaults: fields in documents not yet rendered (lazy)
  // keep their saved value until their DOM exists and overrides it.
  const out: Record<string, any> = {}
  for (const k in SV_PROGVALS) out[k] = SV_PROGVALS[k]
  const els = document.querySelectorAll('[data-svfk]')
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as HTMLElement
    const k = el.getAttribute('data-svfk')!
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') out[k] = (el as HTMLInputElement).checked
    else if (el.tagName === 'INPUT' || el.tagName === 'SELECT') out[k] = (el as HTMLInputElement).value
    else { const r = el.querySelector('input:checked') as HTMLInputElement | null; out[k] = r ? r.value : '' }
  }
  return out
}
function svRestore(vals: Record<string, any>): void {
  const els = document.querySelectorAll('[data-svfk]')
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as HTMLElement
    const k = el.getAttribute('data-svfk')!
    if (!(k in vals)) continue
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') (el as HTMLInputElement).checked = !!vals[k]
    else if (el.tagName === 'INPUT' || el.tagName === 'SELECT') (el as HTMLInputElement).value = String(vals[k] || '')
    else { const r = el.querySelector(`input[value="${CSS.escape(String(vals[k]))}"]`) as HTMLInputElement | null; if (r) r.checked = true }
  }
}

/* Which of my required tabs are still empty? Signature/initials boxes count
   ONLY when individually clicked — adoption alone completes nothing. */
function svMissing(): any[] {
  const host = SV!; const vals = svCollect()
  return (host.env.tabs || []).filter((t: any) => {
    if (t.recipientId !== host.meId || t.required === false) return false
    if (t.type === 'signature' || t.type === 'initials') return !SV_APPLIED[t.id]
    if (t.type === 'dateSigned' || t.type === 'name') return false // auto
    const v = vals[t.id]
    if (t.type === 'checkbox') return v !== true
    return v == null || String(v) === ''
  })
}

function svUpdateProgress(): void {
  const host = SV; if (!host) return
  const missing = svMissing()
  const mine = (host.env.tabs || []).filter((t: any) => t.recipientId === host.meId && t.required !== false).length
  const p = document.getElementById('sv-progress')
  if (p) p.textContent = mine ? (mine - missing.length) + ' of ' + mine + ' required fields complete' : ''
  // Finish stays CLICKABLE when only consent is missing — clicking it then shows
  // a loud, explicit error (a disabled button reads as silently broken).
  const consentEl = document.getElementById('sv-consent') as HTMLInputElement | null
  if (consentEl && consentEl.checked) svConsentError(false)
  const f = document.getElementById('sv-finish') as HTMLButtonElement | null
  if (f) f.disabled = missing.length > 0
  const n = document.getElementById('sv-next') as HTMLButtonElement | null
  if (n) n.style.display = missing.length ? '' : 'none'
  svScheduleSave()
}

/* ── finish-later autosave ───────────────────────────────────────────────────
   Debounced ~20s behind the last change, plus the explicit button. Saves field
   values + clicked-box booleans + typed name — never the signature image. */
function svScheduleSave(): void {
  const host = SV
  if (!host || !host.meId || !host.saveProgress) return
  if (SV_SAVE_TIMER) clearTimeout(SV_SAVE_TIMER)
  SV_SAVE_TIMER = setTimeout(function () { SV_SAVE_TIMER = 0; svSaveNow(false) }, 20000)
}
function svProgressPayload(): { tabValues: Record<string, any>; typedName: string; hasAdopted: boolean } {
  const host = SV!
  const tv = svCollect()
  for (const t of (host.env.tabs || [])) {
    if (t.recipientId === host.meId && (t.type === 'signature' || t.type === 'initials')) tv[t.id] = !!(SV_APPLIED[t.id] || SV_RESUME[t.id])
  }
  const a = sigAdopted()
  return {
    tabValues: tv,
    typedName: a ? a.typedName : ((host.progress && host.progress.typedName) || ''),
    hasAdopted: !!a || !!(host.progress && host.progress.hasAdopted),
  }
}
function svSaveNow(manual: boolean): void {
  const host = SV
  if (!host || !host.meId || !host.saveProgress) return
  const p = svProgressPayload()
  const key = JSON.stringify(p.tabValues) + '|' + p.typedName + '|' + p.hasAdopted
  if (!manual && key === SV_LAST_SAVE) return
  host.saveProgress(p).then(function () {
    SV_LAST_SAVE = key
    const el = document.getElementById('sv-savenote')
    if (el) el.textContent = manual ? 'Saved — reopen your link anytime to continue.' : 'Progress saved'
  }).catch(function (e: any) {
    if (manual) alert('Could not save: ' + (e && e.message ? e.message : String(e)))
  })
}
function svSaveLater(): void { svSaveNow(true) }

/* NEXT: scroll to the first incomplete required tab and pulse it. If that tab
   sits in a lazy document that hasn't rendered yet, render it now, then land. */
function svNext(): void {
  const missing = svMissing()
  if (!missing.length) return
  const t = missing[0]
  const go = (el: HTMLElement) => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse')
  }
  const el = document.querySelector(`[data-svtab="${t.id}"]`) as HTMLElement | null
  if (el) { go(el); return }
  const pageEl = (document.querySelector(`.sv-page[data-doc="${t.docId}"][data-page="${t.page}"]`)
    || document.querySelector(`.sv-page[data-doc="${t.docId}"]`)) as HTMLElement | null
  if (pageEl) pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
  svRenderDoc(t.docId).then(() => {
    const el2 = document.querySelector(`[data-svtab="${t.id}"]`) as HTMLElement | null
    if (el2) go(el2)
  })
}

/* Loud consent error: red banner in the bar + highlighted checkbox. Cleared the
   moment the box is checked (svUpdateProgress). */
function svConsentError(show: boolean): void {
  const lb = document.querySelector('.sv-consent') as HTMLElement | null
  const note = document.getElementById('sv-consent-note')
  if (lb) lb.classList.toggle('sv-consent-err', show)
  if (note) {
    note.textContent = show ? 'You haven’t consented yet — check the box above to finish signing.' : ''
    ;(note as HTMLElement).style.display = show ? '' : 'none'
    if (show) { lb && lb.scrollIntoView({ behavior: 'smooth', block: 'center' }); lb && (lb.classList.remove('pulse'), void lb.offsetWidth, lb.classList.add('pulse')) }
  }
}

async function svFinish(): Promise<void> {
  const host = SV; if (!host) return
  const missing = svMissing()
  if (missing.length) { svNext(); return }
  if (host.consentLabel) {
    const c = document.getElementById('sv-consent') as HTMLInputElement | null
    if (!c || !c.checked) { svConsentError(true); if (c) c.focus(); return }
  }
  const a = sigAdopted()
  const btn = document.getElementById('sv-finish') as HTMLButtonElement | null
  if (btn) { btn.disabled = true; btn.textContent = 'Signing…' }
  if (SV_SAVE_TIMER) { clearTimeout(SV_SAVE_TIMER); SV_SAVE_TIMER = 0 }
  try {
    // Per-box applied state rides in tabValues (true = clicked, false = left
    // blank) so the stamper only stamps boxes this signer actually clicked.
    const tv = svCollect()
    for (const t of (host.env.tabs || [])) {
      if (t.recipientId === host.meId && (t.type === 'signature' || t.type === 'initials')) tv[t.id] = !!SV_APPLIED[t.id]
    }
    const res = await host.submit({
      signatureData: a ? a.dataUrl : '',
      initialsData: a && a.initialsUrl ? a.initialsUrl : '',
      typedName: a ? a.typedName : '',
      tabValues: tv,
    })
    host.onDone(res)
  } catch (e: any) {
    if (btn) { btn.disabled = false; btn.textContent = 'Finish' }
    alert('Signing failed: ' + (e && e.message ? e.message : String(e)))
  }
}

/** Tear down the view's module state when a host unmounts. */
export function svUnmount(): void {
  SV = null
  sigOnChange(null)
  if (SV_SAVE_TIMER) { clearTimeout(SV_SAVE_TIMER); SV_SAVE_TIMER = 0 }
}

/* The overlay's inline handlers resolve against window — attach exactly those. */
Object.assign(window as any, { svApply, svUnapply, svUpdateProgress, svNext, svFinish, svSaveLater })
