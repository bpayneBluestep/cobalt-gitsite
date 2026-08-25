/*
 * designer.ts — the field-placement designer engine. Ported from eccrm's
 * designer.ts (proven in production there), adapted to a mount/unmount API so a
 * React route can host it: the engine owns everything inside its container and
 * repaints itself; React owns the page around it.
 *
 * The document is truth and is never edited here: pdf.js renders every page of
 * every PDF; tabs are absolutely-positioned divs over each page, moved/resized
 * with hand-rolled pointer events. Positions live in PDF points (pdf.ts) —
 * pixels are derived at render time, so zoom cannot drift a tab by construction.
 *
 * Placement is CLICK-TO-PLACE (click a palette type to arm it, click the page to
 * drop) plus drag-from-palette. Arrows nudge 1pt (Shift = 10pt), Ctrl+C/Ctrl+V
 * copy/paste (paste lands under the cursor), Delete removes. Autosaves 900ms
 * after the last change; Ctrl+S forces.
 *
 * Envelope tabs belong to RECIPIENTS; template tabs belong to ROLES. One code
 * path: both are "owners" with stable colors.
 */

import {
  pdfOpen, pdfRenderPage, geoScale, geoPxToPt, geoApplyTabRect, geoClampTab,
  geoRecipientColor, GEO_TAB_DEFAULTS, GEO_TAB_LABELS, type GeoPage,
} from './pdf'
import { randomTabId } from './api'

export interface DsgTab {
  id: string; docId: string; page: number
  x: number; y: number; w: number; h: number   // PDF points, top-left origin
  type: string; recipientId: string            // recipient id OR template role id
  required: boolean; label: string; options: string[]
  source?: string
}

interface DsgOwner { id: string; name: string; color: string; kind?: string }

export interface DsgHost {
  container: HTMLElement
  mode: 'env' | 'tpl'
  title: string
  docs: any[]                       // EnvDoc[], sorted by order
  tabs: DsgTab[]
  /* env mode */
  recipients?: any[]                // EnvRecipient[] (cc excluded here)
  correcting?: boolean              // envelope is Sent/Partially Signed
  locked?: { [rid: string]: boolean } // recipients who already signed
  /* tpl mode */
  roles?: any[]                     // { id, name, optional }
  /* persistence + chrome */
  save: (tabs: DsgTab[], roles: any[]) => Promise<any>
  onBack: () => void
  toast: (msg: string) => void
}

/* Sender fields may auto-fill from the company record when the send dialog
   opens. Keys are resolved by the send dialog (CompanyAgreements). */
export const ENV_PREFILL_SOURCES: { key: string; label: string }[] = [
  { key: 'companyName', label: 'Company name' },
  { key: 'contactName', label: 'Primary contact' },
  { key: 'contactEmail', label: 'Primary contact email' },
  { key: 'companyLocation', label: 'Company city, state' },
  { key: 'senderName', label: 'Sender name' },
  { key: 'today', label: "Today's date" },
]

interface DsgState extends DsgHost {
  owners: DsgOwner[]
  activeOwner: string
  armedType: string
  selected: string
  zoom: number
  dirty: boolean
  saving: boolean
  pages: GeoPage[]
  clipboard: DsgTab | null
  lockedMap: { [rid: string]: boolean }
}

let DSG: DsgState | null = null
let DSG_SAVE_T: any = null
const DSG_BASE_W = 816 // 8.5in at 96dpi — the 100% render width for a letter page

const esc = (s: unknown): string =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* ---- mount / unmount ---- */
export function dsgMount(host: DsgHost): void {
  const lockedMap = host.locked || {}
  let owners: DsgOwner[]
  let roles = host.roles || []
  if (host.mode === 'env') {
    owners = (host.recipients || []).filter((r: any) => r.kind !== 'cc')
      .map((r: any, i: number) => ({ id: r.id, name: r.name || '(unnamed)', color: geoRecipientColor(i), kind: r.kind }))
  } else {
    if (!roles.length) roles = [{ id: 'role1_' + Math.random().toString(36).slice(2, 6), name: 'Signer 1' }]
    owners = dsgOwnersFromRoles(roles)
  }
  // Both modes get the sender pseudo-owner: fields the SENDER fills in the send
  // dialog — never a signer's, never signature-like.
  owners.push({ id: '__sender__', name: 'Sender (at send)', color: '#64748b' })
  const firstUnlocked = owners.find(o => !lockedMap[o.id] && o.id !== '__sender__')
  DSG = {
    ...host,
    roles,
    owners,
    lockedMap,
    activeOwner: firstUnlocked ? firstUnlocked.id : (owners.length ? owners[0].id : ''),
    armedType: '', selected: '', zoom: 0, dirty: false, saving: false,
    pages: [], clipboard: null,
  }
  document.addEventListener('keydown', dsgKeydown)
  document.addEventListener('scroll', dsgOnScroll, true)
  window.addEventListener('resize', dsgOnResize)
  document.addEventListener('mousemove', dsgTrackMouse)
  paint()
}

export function dsgUnmount(): void {
  dsgFlushSave()
  document.removeEventListener('keydown', dsgKeydown)
  document.removeEventListener('scroll', dsgOnScroll, true)
  window.removeEventListener('resize', dsgOnResize)
  document.removeEventListener('mousemove', dsgTrackMouse)
  DSG = null
}

function paint(): void {
  const d = DSG; if (!d) return
  d.container.innerHTML = dsgView()
  setTimeout(dsgMountPages, 0)
}

function dsgOnScroll(): void { if (DSG) dsgPropsPosition() }
function dsgOnResize(): void { if (DSG) dsgPropsPosition() }

/* ---- view ---- */
function dsgView(): string {
  const d = DSG!
  if (d.owners.length < 2) {
    return `<div class="callout"><p class="callout__title">Nothing to place fields for</p>
      <p>${d.mode === 'env' ? 'Add at least one signing recipient before placing fields.' : 'Add a role first.'}</p>
      <p class="callout__actions"><button type="button" class="btn" data-dsg="back">Back</button></p></div>`
  }

  const ownerBtns = d.owners.map(o => `
    <button type="button" class="dsg-owner ${d.activeOwner === o.id ? 'active' : ''}${d.lockedMap[o.id] ? ' locked' : ''}" style="--oc:${o.color}"
      data-owner="${esc(o.id)}" data-dsg="owner" data-arg="${esc(o.id)}" title="${d.lockedMap[o.id] ? esc(o.name) + ' has already signed — their fields are locked' : 'New fields are assigned to ' + esc(o.name)}">
      <span class="dsg-owner-dot"></span>${esc(o.name)}${d.lockedMap[o.id] ? ' 🔒' : ''}</button>`).join('')

  const palette = Object.keys(GEO_TAB_DEFAULTS).map(t => `
    <button type="button" class="dsg-pal ${d.armedType === t ? 'armed' : ''}" data-pal="${t}" data-dsg="pal" data-arg="${t}"
      title="Drag onto the page, or click then click the page">${esc(GEO_TAB_LABELS[t] || t)}</button>`).join('')

  const zooms = [0.5, 0.75, 1, 1.25, 1.5, 2]
  const zoomBtns = `<button type="button" class="btn btn--ghost btn--sm" data-dsg="zoomfit" title="Fit the page to the window">Fit</button>`
    + zooms.map(z => `<button type="button" class="btn btn--ghost btn--sm ${Math.abs(d.zoom - z) < 0.01 ? 'dsg-z-on' : ''}" data-dsg="zoom" data-arg="${z}">${z * 100}%</button>`).join('')

  const pages = d.docs.map((doc: any) => {
    const n = Math.max(1, doc.pages || 1)
    let html = `<div class="dsg-docname">${esc(doc.name)}</div>`
    for (let p = 1; p <= n; p++) {
      html += `<div class="dsg-page" data-doc="${esc(doc.id)}" data-page="${p}" data-url="${esc(doc.sourceUrl)}">
        <canvas class="dsg-canvas"></canvas>
        <div class="dsg-overlay"></div>
      </div>`
    }
    return html
  }).join('')

  const rolesUi = d.mode === 'tpl' ? `<button type="button" class="btn btn--ghost btn--sm" data-dsg="addrole">+ Add role</button>
    <div class="dsg-holders">${(d.roles || []).map((r: any, ri: number) => `<div class="dsg-holders-row">
      <label title="An optional role may be left blank when this template is applied — that person and all their fields are omitted from the envelope.">
        <input type="checkbox" ${r.optional ? 'checked' : ''} data-dsg="optional" data-arg="${esc(r.id)}"> ${esc(r.name)} is optional</label>
      <button type="button" class="ico-mini" title="Rename ${esc(r.name)}" data-dsg="renamerole" data-arg="${esc(r.id)}">✎</button>
      <button type="button" class="ico-mini" title="Move up" ${ri === 0 ? 'disabled' : ''} data-dsg="moverole" data-arg="${esc(r.id)}|-1">↑</button>
      <button type="button" class="ico-mini" title="Move down" ${ri === (d.roles || []).length - 1 ? 'disabled' : ''} data-dsg="moverole" data-arg="${esc(r.id)}|1">↓</button>
      <button type="button" class="ico-mini danger" title="Delete ${esc(r.name)}" data-dsg="delrole" data-arg="${esc(r.id)}">✕</button></div>`).join('')}</div>` : ''

  return `
    ${d.correcting ? `<div class="callout callout--warn dsg-correct-note"><p>Correcting a sent envelope — fields of recipients who already signed are locked.</p></div>` : ''}
    <div class="dsg-head">
      <p class="dsg-hint">${d.armedType ? `Click the page to place a <b>${esc(GEO_TAB_LABELS[d.armedType])}</b> for <b>${esc((d.owners.find(o => o.id === d.activeOwner) || { name: '?' }).name)}</b> — Esc to cancel.` : 'Pick a field type, then click the page. Drag to move, edges to resize, arrows to nudge. Ctrl+C copies the selected field, Ctrl+V pastes it at your cursor.'}</p>
      <div class="dsg-head-acts">
        <span class="dsg-savestate">${d.saving ? 'Saving…' : d.dirty ? 'Unsaved' : 'Saved'}</span>
        <button type="button" class="btn btn--ghost" data-dsg="back">‹ Done</button>
      </div>
    </div>
    <div class="dsg-layout">
      <div class="dsg-side">
        <div class="dsg-card">
          <div class="dsg-side-h">${d.mode === 'env' ? 'Recipients' : 'Roles'}</div>
          <div class="dsg-owners">${ownerBtns}</div>
          ${rolesUi}
        </div>
        <div class="dsg-card">
          <div class="dsg-side-h">Fields</div>
          <div class="dsg-palette">${palette}</div>
        </div>
      </div>
      <div class="dsg-main">
        <div class="dsg-toolbar">${zoomBtns}<span class="dsg-count" id="dsg-count">${d.tabs.length} field${d.tabs.length === 1 ? '' : 's'}</span></div>
        <div class="dsg-scroll" id="dsg-scroll">${pages}</div>
      </div>
    </div>
    <div id="dsg-props" class="dsg-props-float${d.selected ? '' : ' dsg-hidden'}">${dsgPropsHtml()}</div>`
}

/* Properties panel for the selected tab. */
function dsgPropsHtml(): string {
  const d = DSG!
  const t = d.tabs.find(x => x.id === d.selected)
  if (!t) return ''
  const head = `<div class="dsg-props-head"><div class="dsg-side-h">${esc(GEO_TAB_LABELS[t.type] || t.type)}</div>
    <button type="button" class="ico-mini" title="Close (Esc)" data-dsg="deselect">✕</button></div>`
  if (d.lockedMap[t.recipientId]) {
    const lockedOwner = d.owners.find(o => o.id === t.recipientId)
    return `${head}
      <p class="dsg-meta">${esc(lockedOwner ? lockedOwner.name : 'This recipient')} has already signed — this field can't be changed by a correction.</p>`
  }
  const owner = d.owners.filter(o => !d.lockedMap[o.id]).map(o => `<option value="${esc(o.id)}"${t.recipientId === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('')
  const prefill = t.recipientId === '__sender__' && t.type === 'text' ? `
    <div class="dsg-field"><label>Auto-fill from</label><select data-dsg="prefill">
      <option value="">(typed by the sender)</option>
      ${ENV_PREFILL_SOURCES.map(sc => `<option value="${sc.key}"${(t as any).source === sc.key ? ' selected' : ''}>${esc(sc.label)}</option>`).join('')}
    </select></div>` : ''
  const needsOpts = t.type === 'radioGroup' || t.type === 'dropdown'
  const auto = t.type === 'dateSigned' || t.type === 'name'
  return `${head}
    <div class="dsg-field"><label>Assigned to</label><select data-dsg="prop-recipientId">${owner}</select></div>
    ${prefill}
    ${auto ? `<p class="dsg-meta">Filled automatically when they sign.</p>` : `
      <div class="dsg-field"><label>Label</label><input value="${esc(t.label)}" data-dsg="prop-label"></div>
      ${needsOpts ? `<div class="dsg-field"><label>Options (one per line)</label>
        <textarea rows="4" data-dsg="prop-options">${esc((t.options || []).join('\n'))}</textarea></div>` : ''}
      <label class="dsg-req"><input type="checkbox" ${t.required ? 'checked' : ''} data-dsg="prop-required"> Required</label>`}
    <div class="dsg-prop-acts">
      <button type="button" class="btn btn--ghost btn--sm" data-dsg="dup">+ Duplicate</button>
      <button type="button" class="btn btn--ghost btn--sm dsg-danger" data-dsg="del">Delete</button>
    </div>`
}

/* ---- event delegation: one listener, every [data-dsg] control ---- */
function dsgDelegate(ev: Event): void {
  const d = DSG; if (!d) return
  const el = (ev.target as HTMLElement).closest('[data-dsg]') as HTMLElement | null
  if (!el || !d.container.contains(el)) return
  const what = el.getAttribute('data-dsg') || ''
  const arg = el.getAttribute('data-arg') || ''
  const type = ev.type

  if (type === 'click') {
    if (what === 'back') { d.onBack(); return }
    if (what === 'owner') { dsgSetOwner(arg); return }
    if (what === 'pal') { dsgPalClick(arg); return }
    if (what === 'zoom') { dsgZoom(Number(arg) || 1); return }
    if (what === 'zoomfit') { dsgZoomFit(); return }
    if (what === 'addrole') { dsgAddRole(); return }
    if (what === 'renamerole') { dsgRenameRole(arg); return }
    if (what === 'moverole') { const [id, dir] = arg.split('|'); dsgMoveRole(id, Number(dir)); return }
    if (what === 'delrole') { dsgDeleteRole(arg); return }
    if (what === 'deselect') { dsgDeselect(); return }
    if (what === 'dup') { dsgDuplicate(); return }
    if (what === 'del') { dsgDelete(); return }
  }
  if (type === 'change') {
    if (what === 'optional') { dsgToggleOptional(arg); return }
    if (what === 'prop-recipientId') { dsgProp('recipientId', (el as HTMLSelectElement).value); return }
    if (what === 'prop-required') { dsgProp('required', (el as HTMLInputElement).checked); return }
    if (what === 'prefill') { dsgPrefillSource((el as HTMLSelectElement).value); return }
  }
  if (type === 'input') {
    if (what === 'prop-label') { dsgProp('label', (el as HTMLInputElement).value); return }
    if (what === 'prop-options') { dsgPropOptions((el as HTMLTextAreaElement).value); return }
  }
}

/* pointerdown needs its own path: palette drag + page click + tab drag. */
function dsgPointerDown(ev: PointerEvent): void {
  const d = DSG; if (!d) return
  const target = ev.target as HTMLElement
  if (!d.container.contains(target)) return
  const pal = target.closest('[data-dsg="pal"]') as HTMLElement | null
  if (pal) { dsgPalDown(ev, pal.getAttribute('data-arg') || ''); return }
  const tabEl = target.closest('.dsg-tab') as HTMLElement | null
  if (tabEl) {
    const t = d.tabs.find(x => x.id === tabEl.getAttribute('data-tab'))
    if (t && !d.lockedMap[t.recipientId]) { dsgTabPointerDown(ev, tabEl, t); return }
    if (t) { dsgSelect(t.id); ev.preventDefault(); ev.stopPropagation() }
    return
  }
  const pageEl = target.closest('.dsg-page') as HTMLElement | null
  if (pageEl) {
    // click-to-place (or deselect) resolved on pointerdown for snappiness
    const docId = pageEl.getAttribute('data-doc') || ''
    const page = Number(pageEl.getAttribute('data-page')) || 1
    if (!d.armedType) { d.selected = ''; dsgRepaintAll(); return }
    const rect = pageEl.getBoundingClientRect()
    dsgPlaceAt(docId, page, ev.clientX - rect.left, ev.clientY - rect.top, d.armedType)
  }
}

/* ---- page mounting: render canvases + overlays after the DOM exists ---- */
async function dsgMountPages(): Promise<void> {
  const d = DSG; if (!d) return
  // zoom 0 is the fit-to-width sentinel: measure the scroll container once the
  // DOM exists, pick the zoom that fills it, and re-render.
  if (d.zoom === 0) {
    const sc = document.getElementById('dsg-scroll')
    if (!sc) return
    const avail = sc.clientWidth - 48
    d.zoom = Math.max(0.5, Math.min(2, Math.round((avail / DSG_BASE_W) * 20) / 20))
    paint()
    return
  }
  const pageEls = d.container.querySelectorAll('.dsg-page')
  const byUrl: { [url: string]: any } = {}
  for (let i = 0; i < pageEls.length; i++) {
    const el = pageEls[i] as HTMLElement
    const url = el.getAttribute('data-url') || ''
    const docId = el.getAttribute('data-doc') || ''
    const pageNum = Number(el.getAttribute('data-page')) || 1
    const canvas = el.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas || !url) continue
    try {
      if (!byUrl[url]) byUrl[url] = await pdfOpen(url)
      const dims = await pdfRenderPage(byUrl[url], pageNum, canvas, Math.round(DSG_BASE_W * d.zoom))
      if (!d.pages.find(p => p.docId === docId && p.page === pageNum)) {
        d.pages.push({ docId, page: pageNum, wPt: dims.wPt, hPt: dims.hPt })
      }
      el.style.width = canvas.style.width
      el.style.height = canvas.style.height
      dsgPaintOverlay(el, docId, pageNum)
    } catch { el.classList.add('dsg-page-err') }
  }
}

function dsgPageInfo(docId: string, page: number): GeoPage | null {
  return DSG ? (DSG.pages.find(p => p.docId === docId && p.page === page) || null) : null
}

function dsgScaleFor(docId: string, page: number): number {
  const info = dsgPageInfo(docId, page)
  return info ? geoScale(DSG_BASE_W * DSG!.zoom, info.wPt) : 1
}

/* Redraw the tab divs on one page's overlay. */
function dsgPaintOverlay(pageEl: HTMLElement, docId: string, page: number): void {
  const d = DSG!
  const overlay = pageEl.querySelector('.dsg-overlay') as HTMLElement | null
  if (!overlay) return
  const scale = dsgScaleFor(docId, page)
  overlay.innerHTML = ''
  for (const t of d.tabs) {
    if (t.docId !== docId || t.page !== page) continue
    const o = d.owners.find(x => x.id === t.recipientId)
    const lockedT = !!d.lockedMap[t.recipientId]
    const el = document.createElement('div')
    el.className = 'dsg-tab' + (d.selected === t.id ? ' selected' : '') + (lockedT ? ' locked' : '')
    el.setAttribute('data-tab', t.id)
    el.style.setProperty('--oc', o ? o.color : '#64748b')
    el.innerHTML = `<span class="dsg-tab-label">${esc(t.type === 'checkbox' ? '' : (t.label || GEO_TAB_LABELS[t.type] || t.type))}</span>`
    geoApplyTabRect(el, t, scale)
    el.addEventListener('click', (e) => e.stopPropagation())
    overlay.appendChild(el)
    if (!lockedT) dsgResizeCursor(el)
  }
}

function dsgRepaintAll(): void {
  const d = DSG; if (!d) return
  const pageEls = d.container.querySelectorAll('.dsg-page')
  for (let i = 0; i < pageEls.length; i++) {
    const el = pageEls[i] as HTMLElement
    dsgPaintOverlay(el, el.getAttribute('data-doc') || '', Number(el.getAttribute('data-page')) || 1)
  }
  dsgPropsRefresh()
}

/* ---- drag + resize, hand-rolled on pointer events ----
   Drag anywhere in the tab moves it; the outer 6px of each edge resizes;
   positions snap to a 3pt grid on release; everything clamps to the page. */
const DSG_EDGE = 6    // px — resize handle thickness
const DSG_GRID = 3    // pt — release snap

function dsgTabPointerDown(ev: PointerEvent, el: HTMLElement, tab: DsgTab): void {
  if (ev.button !== 0) return
  ev.preventDefault(); ev.stopPropagation()
  dsgSelect(tab.id)
  const scale = dsgScaleFor(tab.docId, tab.page)
  const rect = el.getBoundingClientRect()
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top
  const edges = {
    l: px <= DSG_EDGE, r: px >= rect.width - DSG_EDGE,
    t: py <= DSG_EDGE, b: py >= rect.height - DSG_EDGE,
  }
  const resizing = edges.l || edges.r || edges.t || edges.b
  const start = { x: tab.x, y: tab.y, w: tab.w, h: tab.h, cx: ev.clientX, cy: ev.clientY }
  const info = dsgPageInfo(tab.docId, tab.page)
  let moved = false

  const onMove = (mv: PointerEvent) => {
    const dxPt = geoPxToPt(mv.clientX - start.cx, scale)
    const dyPt = geoPxToPt(mv.clientY - start.cy, scale)
    if (Math.abs(dxPt) + Math.abs(dyPt) > 0.5) moved = true
    if (!resizing) {
      tab.x = start.x + dxPt; tab.y = start.y + dyPt
    } else {
      if (edges.r) tab.w = Math.max(8, start.w + dxPt)
      if (edges.b) tab.h = Math.max(8, start.h + dyPt)
      if (edges.l) { const w2 = Math.max(8, start.w - dxPt); tab.x = start.x + (start.w - w2); tab.w = w2 }
      if (edges.t) { const h2 = Math.max(8, start.h - dyPt); tab.y = start.y + (start.h - h2); tab.h = h2 }
    }
    if (info) geoClampTab(tab, info.wPt, info.hPt)
    geoApplyTabRect(el, tab, scale)
  }
  const onUp = () => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onUp)
    if (moved) {
      // snap on release, not during — dragging feels 1:1, results line up
      tab.x = Math.round(tab.x / DSG_GRID) * DSG_GRID
      tab.y = Math.round(tab.y / DSG_GRID) * DSG_GRID
      tab.w = Math.round(tab.w / DSG_GRID) * DSG_GRID
      tab.h = Math.round(tab.h / DSG_GRID) * DSG_GRID
      if (info) geoClampTab(tab, info.wPt, info.hPt)
      geoApplyTabRect(el, tab, scale)
      dsgTouched()
    }
    dsgPropsPosition()
  }
  el.setPointerCapture(ev.pointerId)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
}

/* Resize affordance: show the right cursor near edges. */
function dsgResizeCursor(el: HTMLElement): void {
  el.addEventListener('pointermove', function (ev: PointerEvent) {
    if ((ev as any).buttons) return // mid-gesture — capture handler owns it
    const rect = el.getBoundingClientRect()
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top
    const l = px <= DSG_EDGE, r = px >= rect.width - DSG_EDGE, t = py <= DSG_EDGE, b = py >= rect.height - DSG_EDGE
    el.style.cursor = (l && t) || (r && b) ? 'nwse-resize' : (r && t) || (l && b) ? 'nesw-resize'
      : l || r ? 'ew-resize' : t || b ? 'ns-resize' : 'move'
  })
}

/* ---- interactions ---- */
function dsgSetOwner(id: string): void {
  const d = DSG!
  if (d.lockedMap[id]) { d.toast('That recipient has already signed — new fields can\'t be assigned to them.'); return }
  d.activeOwner = id
  const t = d.tabs.find(x => x.id === d.selected)
  if (t) {
    t.recipientId = id
    const el = d.container.querySelector('[data-tab="' + t.id + '"]') as HTMLElement | null
    const o = d.owners.find(x => x.id === id)
    if (el && o) el.style.setProperty('--oc', o.color)
    dsgTouched()
  }
  dsgUiSync()
  dsgPropsRefresh()
}

function dsgArm(type: string): void {
  const d = DSG!
  d.armedType = d.armedType === type ? '' : type
  d.selected = ''
  const els = d.container.querySelectorAll('.dsg-tab.selected')
  for (let i = 0; i < els.length; i++) els[i].classList.remove('selected')
  dsgUiSync()
  dsgPropsRefresh()
}

// Create a tab of `type` centred on a page-local pixel point. Shared by
// click-to-place and drag-from-palette.
const DSG_SIGNER_ONLY: { [t: string]: boolean } = { signature: true, initials: true, dateSigned: true, name: true }
function dsgPlaceAt(docId: string, page: number, pxX: number, pxY: number, type: string): void {
  const d = DSG!
  if (d.activeOwner === '__sender__' && DSG_SIGNER_ONLY[type]) { d.toast('Sender fields are filled at send time — signature-type fields need a signer.'); d.armedType = ''; paint(); return }
  const scale = dsgScaleFor(docId, page)
  const def = GEO_TAB_DEFAULTS[type]
  const tab: DsgTab = {
    id: randomTabId(),
    docId, page,
    x: geoPxToPt(pxX, scale) - def.w / 2, y: geoPxToPt(pxY, scale) - def.h / 2,
    w: def.w, h: def.h,
    type, recipientId: d.activeOwner,
    required: true, label: '', options: type === 'radioGroup' ? ['Option 1', 'Option 2'] : [],
  }
  const info = dsgPageInfo(docId, page)
  if (info) geoClampTab(tab, info.wPt, info.hPt)
  d.tabs.push(tab)
  d.selected = tab.id
  d.armedType = ''
  dsgTouched()
  // Paint only the affected page — a full paint() here scrolls the user to the top.
  const pageEl = d.container.querySelector('.dsg-page[data-doc="' + docId + '"][data-page="' + page + '"]') as HTMLElement | null
  if (pageEl) dsgPaintOverlay(pageEl, docId, page)
  dsgUiSync()
  dsgPropsRefresh()
}

/* ---- drag-from-palette ---- */
let DSG_PAL_SUPPRESS_CLICK = false
function dsgPalDown(ev: PointerEvent, type: string): void {
  if (ev.button !== 0) return
  const startX = ev.clientX, startY = ev.clientY
  let ghost: HTMLElement | null = null
  DSG_PAL_SUPPRESS_CLICK = false

  const pageUnder = (x: number, y: number): HTMLElement | null => {
    const el = document.elementFromPoint(x, y)
    return el ? (el.closest('.dsg-page') as HTMLElement | null) : null
  }
  const onMove = (mv: PointerEvent) => {
    if (!ghost) {
      if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 5) return
      DSG_PAL_SUPPRESS_CLICK = true
      ghost = document.createElement('div')
      ghost.className = 'dsg-ghost'
      const o = DSG!.owners.find(x => x.id === DSG!.activeOwner)
      ghost.style.setProperty('--oc', o ? o.color : '#64748b')
      ghost.textContent = GEO_TAB_LABELS[type] || type
      document.body.appendChild(ghost)
    }
    const pg = pageUnder(mv.clientX, mv.clientY)
    const def = GEO_TAB_DEFAULTS[type]
    const scale = pg ? dsgScaleFor(pg.getAttribute('data-doc') || '', Number(pg.getAttribute('data-page')) || 1) : 1
    ghost.style.width = Math.round(def.w * scale) + 'px'
    ghost.style.height = Math.round(def.h * scale) + 'px'
    ghost.style.left = Math.round(mv.clientX - (def.w * scale) / 2) + 'px'
    ghost.style.top = Math.round(mv.clientY - (def.h * scale) / 2) + 'px'
    ghost.classList.toggle('droppable', !!pg)
  }
  const onUp = (up: PointerEvent) => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    if (!ghost) return // plain click — the click handler arms as before
    ghost.remove()
    const pg = pageUnder(up.clientX, up.clientY)
    if (!pg) return
    const rect = pg.getBoundingClientRect()
    dsgPlaceAt(pg.getAttribute('data-doc') || '', Number(pg.getAttribute('data-page')) || 1,
      up.clientX - rect.left, up.clientY - rect.top, type)
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
}

function dsgPalClick(type: string): void {
  if (DSG_PAL_SUPPRESS_CLICK) { DSG_PAL_SUPPRESS_CLICK = false; return }
  dsgArm(type)
}

/* Sync the sidebar chrome WITHOUT a repaint: a full paint rebuilds the scroll
   pane and re-rasterizes every pdf.js canvas. */
function dsgUiSync(): void {
  const d = DSG; if (!d) return
  const pals = d.container.querySelectorAll('.dsg-pal')
  for (let i = 0; i < pals.length; i++) pals[i].classList.toggle('armed', pals[i].getAttribute('data-pal') === d.armedType)
  const owners = d.container.querySelectorAll('.dsg-owner')
  for (let i = 0; i < owners.length; i++) owners[i].classList.toggle('active', owners[i].getAttribute('data-owner') === d.activeOwner)
  const count = document.getElementById('dsg-count')
  if (count) count.textContent = d.tabs.length + ' field' + (d.tabs.length === 1 ? '' : 's')
  const hint = d.container.querySelector('.dsg-hint') as HTMLElement | null
  if (hint) hint.innerHTML = d.armedType
    ? `Click the page to place a <b>${esc(GEO_TAB_LABELS[d.armedType])}</b> for <b>${esc((d.owners.find(o => o.id === d.activeOwner) || { name: '?' }).name)}</b> — Esc to cancel.`
    : 'Pick a field type, then click the page. Drag to move, edges to resize, arrows to nudge. Ctrl+C copies the selected field, Ctrl+V pastes it at your cursor.'
}

function dsgPropsRefresh(): void {
  const d = DSG
  const props = document.getElementById('dsg-props')
  if (!props || !d) return
  props.innerHTML = dsgPropsHtml()
  // The editor is a POPOVER anchored beside the selected field.
  props.classList.toggle('dsg-hidden', !d.selected)
  dsgPropsPosition()
}

/* Place the popover beside the selected tab: to its right, flipping left when
   the viewport runs out, clamped vertically. Re-run on scroll/resize/drag-end. */
function dsgPropsPosition(): void {
  const d = DSG
  const panel = document.getElementById('dsg-props')
  if (!d || !panel || !d.selected || panel.classList.contains('dsg-hidden')) return
  const el = d.container.querySelector('[data-tab="' + d.selected + '"]') as HTMLElement | null
  if (!el) return
  const r = el.getBoundingClientRect()
  const pw = panel.offsetWidth || 280
  const ph = panel.offsetHeight || 240
  let left = r.right + 14
  if (left + pw > window.innerWidth - 12) left = r.left - pw - 14
  if (left < 12) { left = Math.max(12, Math.min(window.innerWidth - pw - 12, r.left)) }
  let top = r.top - 10
  top = Math.max(64, Math.min(window.innerHeight - ph - 12, top))
  panel.style.left = left + 'px'
  panel.style.top = top + 'px'
  panel.style.right = 'auto'
}

/* Track the cursor so Ctrl+V can paste WHERE THE MOUSE IS. */
const DSG_MOUSE = { x: 0, y: 0 }
function dsgTrackMouse(e: MouseEvent): void { DSG_MOUSE.x = e.clientX; DSG_MOUSE.y = e.clientY }
function dsgMouseSpot(): { docId: string; page: number; x: number; y: number } | null {
  const hit = document.elementFromPoint(DSG_MOUSE.x, DSG_MOUSE.y) as HTMLElement | null
  const pg = hit && hit.closest ? hit.closest('.dsg-page') as HTMLElement | null : null
  if (!pg) return null
  const docId = pg.getAttribute('data-doc') || ''
  const page = Number(pg.getAttribute('data-page')) || 1
  const r = pg.getBoundingClientRect()
  const scale = dsgScaleFor(docId, page)
  return { docId, page, x: geoPxToPt(DSG_MOUSE.x - r.left, scale), y: geoPxToPt(DSG_MOUSE.y - r.top, scale) }
}

function dsgDeselect(): void {
  const d = DSG!; d.selected = ''
  const els = d.container.querySelectorAll('.dsg-tab.selected')
  for (let i = 0; i < els.length; i++) els[i].classList.remove('selected')
  dsgPropsRefresh()
}
function dsgSelect(id: string): void {
  const d = DSG!; d.selected = id; d.armedType = ''
  // IN PLACE, never a repaint: this runs on pointerdown, and rebuilding the
  // overlay destroys the element about to be dragged.
  const els = d.container.querySelectorAll('.dsg-tab.selected')
  for (let i = 0; i < els.length; i++) els[i].classList.remove('selected')
  const el = d.container.querySelector('[data-tab="' + id + '"]')
  if (el) el.classList.add('selected')
  dsgPropsRefresh()
}

function dsgProp(key: string, val: any): void {
  const d = DSG!
  const t = d.tabs.find(x => x.id === d.selected)
  if (!t) return
  if (d.lockedMap[t.recipientId]) return
  if (key === 'recipientId' && d.lockedMap[String(val)]) { d.toast('That recipient has already signed.'); return }
  if (key === 'recipientId' && String(val) === '__sender__' && DSG_SIGNER_ONLY[t.type]) { d.toast('Signature-type fields need a signer, not the sender.'); return }
  ;(t as any)[key] = val
  dsgTouched()
  if (key === 'recipientId') {
    const el = d.container.querySelector('[data-tab="' + t.id + '"]') as HTMLElement | null
    const o = d.owners.find(x => x.id === val)
    if (el && o) el.style.setProperty('--oc', o.color)
  }
}

function dsgPrefillSource(key: string): void {
  const d = DSG!
  const t = d.tabs.find(x => x.id === d.selected)
  if (!t) return
  ;(t as any).source = key || undefined
  // Give an unlabeled tab the source's friendly name — the send dialog shows it.
  const src = ENV_PREFILL_SOURCES.find(sc => sc.key === key)
  if (src && !t.label) { t.label = src.label }
  dsgTouched()
  dsgRepaintAll()
}

function dsgPropOptions(text: string): void {
  const d = DSG!
  const t = d.tabs.find(x => x.id === d.selected)
  if (!t) return
  t.options = String(text).split('\n').map(s => s.trim()).filter(s => !!s)
  dsgTouched()
}

function dsgDuplicate(): void {
  const d = DSG!
  const t = d.tabs.find(x => x.id === d.selected)
  if (!t) return
  if (d.lockedMap[t.recipientId]) { d.toast('Locked — that recipient has already signed.'); return }
  const copy: DsgTab = JSON.parse(JSON.stringify(t))
  copy.id = randomTabId()
  copy.x += 12; copy.y += 12
  const info = dsgPageInfo(copy.docId, copy.page)
  if (info) geoClampTab(copy, info.wPt, info.hPt)
  d.tabs.push(copy)
  d.selected = copy.id
  dsgTouched()
  dsgRepaintAll()
}

function dsgDelete(): void {
  const d = DSG!
  const sel = d.tabs.find(x => x.id === d.selected)
  if (sel && d.lockedMap[sel.recipientId]) { d.toast('Locked — that recipient has already signed.'); return }
  d.tabs = d.tabs.filter(x => x.id !== d.selected)
  d.selected = ''
  dsgTouched()
  dsgRepaintAll()
}

function dsgZoom(z: number): void {
  const d = DSG!
  d.zoom = z
  d.pages = [] // page px sizes change; pt sizes are re-reported on render
  paint()
}

function dsgZoomFit(): void {
  const d = DSG!
  d.zoom = 0; d.pages = []
  paint()
}

function dsgAddRole(): void {
  const d = DSG!
  const name = prompt('Role name (e.g. "Client signer"):', 'Signer ' + ((d.roles || []).length + 1))
  if (name == null) return
  const id = 'role' + ((d.roles || []).length + 1) + '_' + Math.random().toString(36).slice(2, 6)
  d.roles = d.roles || []
  d.roles.push({ id, name: name.trim() || ('Signer ' + d.roles.length) })
  dsgRebuildOwners()
  d.activeOwner = id
  dsgTouched()
  paint()
}

function dsgOwnersFromRoles(roles: any[]): DsgOwner[] {
  return roles.map((r: any, i: number) => ({ id: r.id, name: (r.name || r.label || 'Role') + (r.optional ? ' (optional)' : ''), color: geoRecipientColor(i) }))
}
function dsgRebuildOwners(): void {
  const d = DSG!
  d.owners = dsgOwnersFromRoles(d.roles || [])
  d.owners.push({ id: '__sender__', name: 'Sender (at send)', color: '#64748b' })
}
function dsgRenameRole(roleId: string): void {
  const d = DSG!
  const r = (d.roles || []).find((x: any) => x.id === roleId)
  if (!r) return
  const name = prompt('Rename role:', r.name || '')
  if (name == null || !name.trim()) return
  r.name = name.trim()
  dsgRebuildOwners()
  dsgTouched()
  paint()
}

/* Reorder roles — the order sets the apply wizard's slot order. */
function dsgMoveRole(roleId: string, dir: number): void {
  const d = DSG!
  const roles = d.roles || []
  const i = roles.findIndex((x: any) => x.id === roleId)
  const j = i + (dir < 0 ? -1 : 1)
  if (i < 0 || j < 0 || j >= roles.length) return
  const t = roles[i]; roles[i] = roles[j]; roles[j] = t
  dsgRebuildOwners()
  dsgTouched()
  paint()
}

/* Delete a role. Its placed fields go with it — confirmed first. */
function dsgDeleteRole(roleId: string): void {
  const d = DSG!
  const r = (d.roles || []).find((x: any) => x.id === roleId)
  if (!r) return
  const owned = d.tabs.filter((t: any) => t.recipientId === roleId).length
  if (!confirm('Delete the role "' + (r.name || 'Role') + '"'
    + (owned ? ' and its ' + owned + ' placed field' + (owned === 1 ? '' : 's') : '') + '?')) return
  d.roles = (d.roles || []).filter((x: any) => x.id !== roleId)
  d.tabs = d.tabs.filter((t: any) => t.recipientId !== roleId)
  if (d.selected && !d.tabs.some((t: any) => t.id === d.selected)) d.selected = ''
  dsgRebuildOwners()
  if (!d.owners.some(o => o.id === d.activeOwner)) d.activeOwner = d.owners.length ? d.owners[0].id : ''
  dsgTouched()
  paint()
}

function dsgToggleOptional(roleId: string): void {
  const d = DSG!
  const r = (d.roles || []).find((x: any) => x.id === roleId)
  if (!r) return
  r.optional = !r.optional
  dsgRebuildOwners()
  dsgTouched()
  paint()
}

/* ---- keyboard (bound at mount; acts only while mounted) ---- */
function dsgKeydown(ev: KeyboardEvent): void {
  const d = DSG
  if (!d) return
  const tag = (document.activeElement && document.activeElement.tagName) || ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (ev.key === 'Escape') { d.armedType = ''; d.selected = ''; paint(); return }
  const t = d.tabs.find(x => x.id === d.selected)
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); dsgFlushSave(); return }
  if (!t) return
  if (d.lockedMap[t.recipientId]) return // signed recipients' fields are immutable
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') { d.clipboard = JSON.parse(JSON.stringify(t)); return }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') {
    if (!d.clipboard) return
    if (d.lockedMap[d.clipboard.recipientId]) return
    const copy: DsgTab = JSON.parse(JSON.stringify(d.clipboard))
    copy.id = randomTabId()
    const m = dsgMouseSpot()
    if (m) {
      // paste CENTERED under the cursor, on whichever page it's over
      copy.docId = m.docId; copy.page = m.page
      copy.x = m.x - copy.w / 2; copy.y = m.y - copy.h / 2
    } else {
      copy.x += 12; copy.y += 12 // cursor not over a page — offset beside original
    }
    const infoP = dsgPageInfo(copy.docId, copy.page)
    if (infoP) geoClampTab(copy, infoP.wPt, infoP.hPt)
    d.tabs.push(copy); d.selected = copy.id; dsgTouched(); dsgRepaintAll(); return
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') { ev.preventDefault(); dsgDuplicate(); return }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); dsgDelete(); return }
  const step = ev.shiftKey ? 10 : 1
  let moved = true
  if (ev.key === 'ArrowLeft') t.x -= step
  else if (ev.key === 'ArrowRight') t.x += step
  else if (ev.key === 'ArrowUp') t.y -= step
  else if (ev.key === 'ArrowDown') t.y += step
  else moved = false
  if (moved) {
    ev.preventDefault()
    const info = dsgPageInfo(t.docId, t.page)
    if (info) geoClampTab(t, info.wPt, info.hPt)
    dsgTouched()
    dsgRepaintAll()
  }
}

/* ---- autosave ---- */
function dsgTouched(): void {
  const d = DSG!
  d.dirty = true
  const st = d.container.querySelector('.dsg-savestate'); if (st) st.textContent = 'Unsaved'
  if (DSG_SAVE_T) clearTimeout(DSG_SAVE_T)
  DSG_SAVE_T = setTimeout(dsgFlushSave, 900)
}

async function dsgFlushSave(): Promise<void> {
  const d = DSG
  if (!d || !d.dirty || d.saving) return
  if (DSG_SAVE_T) { clearTimeout(DSG_SAVE_T); DSG_SAVE_T = null }
  d.saving = true
  const st = d.container.querySelector('.dsg-savestate'); if (st) st.textContent = 'Saving…'
  try {
    await d.save(d.tabs, (d.roles || []).map((r: any) => ({ id: r.id, name: r.name, optional: !!r.optional })))
    d.dirty = false
    if (st) st.textContent = 'Saved'
  } catch (e: any) {
    if (st) st.textContent = 'Save failed'
    d.toast('Save failed: ' + (e && e.message ? e.message : String(e)))
  }
  d.saving = false
}

/* Delegated listeners live on document but check container membership, so React
   re-mounts can't leak duplicate per-element handlers. Bound once. */
let DSG_DELEGATES_BOUND = false
export function dsgBindDelegates(): void {
  if (DSG_DELEGATES_BOUND) return
  DSG_DELEGATES_BOUND = true
  document.addEventListener('click', dsgDelegate)
  document.addEventListener('change', dsgDelegate)
  document.addEventListener('input', dsgDelegate)
  document.addEventListener('pointerdown', dsgPointerDown)
}
