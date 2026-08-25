/*
 * signing.ts — the adopt-once signature modal, shared by every signing surface:
 * the in-app signing page and the anonymous /spa/sign.html. Ported near-verbatim
 * from eccrm's signing.ts (proven in production there).
 *
 * Deliberately framework-free: it owns only the modal it creates, so the public
 * sign page can include it without dragging in React. The modal's inline onclick
 * handlers reference module functions, which a module build doesn't expose — the
 * block at the bottom attaches exactly those to window.
 */

export function sigEsc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function sigToday(): string {
  const d = new Date()
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear()
}

export function sigDateOf(iso?: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? (parseInt(m[2], 10) + '/' + parseInt(m[3], 10) + '/' + m[1]) : ''
}

/* ── the adopted signature ────────────────────────────────────────────────────
   One per page load. Held here so the modal, the inline placeholders and the
   submit handler all agree without the callers each inventing their own state. */
export interface SigAdopted { dataUrl: string; typedName: string; initialsUrl?: string }
let SIG_ADOPTED: SigAdopted | null = null
let SIG_ON_CHANGE: (() => void) | null = null

export function sigAdopted(): SigAdopted | null { return SIG_ADOPTED }
export function sigResetAdopted(): void { SIG_ADOPTED = null }
/** The host passes a re-render callback so adopting a signature updates the document. */
export function sigOnChange(fn: (() => void) | null): void { SIG_ON_CHANGE = fn }

const SIG_FONTS: { label: string; css: string }[] = [
  { label: 'Dancing Script', css: "'Dancing Script', cursive" },
  { label: 'Great Vibes', css: "'Great Vibes', cursive" },
  { label: 'Caveat', css: "'Caveat', cursive" },
]

let SIG_MODAL_PAD: SigPad | null = null
let SIG_MODAL_PAD_INI: SigPad | null = null
let SIG_MODAL_FONT = 0

export function sigClickSign(): void {
  sigCloseModal()
  const wrap = document.createElement('div')
  wrap.className = 'sg-modal-back'
  wrap.id = '__sgModal'
  wrap.innerHTML =
    '<div class="sg-modal" role="dialog" aria-label="Adopt your signature">'
    + '<div class="sg-modal-h">Adopt your signature</div>'
    + '<div class="sg-tabs">'
    + '<button type="button" class="sg-tab active" data-tab="type" onclick="sigModalTab(\'type\')">Type</button>'
    + '<button type="button" class="sg-tab" data-tab="draw" onclick="sigModalTab(\'draw\')">Draw</button>'
    + '</div>'
    + '<div class="sg-pane" data-pane="type">'
    + '<label class="sg-lbl">Full name</label>'
    + '<input id="__sgName" class="sg-name" placeholder="Your full legal name" oninput="sigModalPreview()">'
    + '<div class="sg-faces" id="__sgFaces"></div>'
    + '</div>'
    + '<div class="sg-pane" data-pane="draw" hidden>'
    + '<label class="sg-lbl">Signature</label>'
    + '<canvas id="__sgPad" class="sg-pad" width="560" height="150"></canvas>'
    + '<button type="button" class="sg-clear" onclick="sigModalClear()">Clear signature</button>'
    + '<label class="sg-lbl" style="margin-top:12px">Initials <span class="sg-lbl-soft">— used in the smaller initials boxes</span></label>'
    + '<canvas id="__sgPadIni" class="sg-pad sg-pad-ini" width="240" height="110"></canvas>'
    + '<button type="button" class="sg-clear" onclick="sigModalClearIni()">Clear initials</button>'
    + '</div>'
    + '<div class="sg-modal-f">'
    + '<button type="button" class="sg-btn ghost" onclick="sigCloseModal()">Cancel</button>'
    + '<button type="button" class="sg-btn primary" onclick="sigModalAdopt()">Adopt and sign</button>'
    + '</div>'
    + '<div class="sg-err" id="__sgErr" hidden></div>'
    + '</div>'
  document.body.appendChild(wrap)
  wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) sigCloseModal() })
  sigRenderFaces()
  const n = document.getElementById('__sgName') as HTMLInputElement | null
  if (n) { n.focus() }
}

function sigRenderFaces(): void {
  const host = document.getElementById('__sgFaces')
  if (!host) return
  const name = (document.getElementById('__sgName') as HTMLInputElement | null)
  const real = name ? name.value.trim() : ''
  const val = real || 'Your name'
  const ini = sigInitialsFrom(real) || '··'
  host.innerHTML = SIG_FONTS.map((f, i) =>
    '<button type="button" class="sg-face' + (i === SIG_MODAL_FONT ? ' active' : '') + '" onclick="sigModalPickFont(' + i + ')">'
    + '<span class="sg-face-name" style="font-family:' + f.css + '">' + sigEsc(val) + '</span>'
    + '<span class="sg-face-ini" title="Your initials — they fill the smaller initials boxes" style="font-family:' + f.css + '">' + sigEsc(ini) + '</span>'
    + '</button>').join('')
    + '<div class="sg-hint">The boxed mark is your initials — it fills the initials boxes.</div>'
}

function sigModalPreview(): void { sigRenderFaces() }
function sigModalPickFont(i: number): void { SIG_MODAL_FONT = i; sigRenderFaces() }

function sigModalTab(which: string): void {
  const modal = document.getElementById('__sgModal')
  if (!modal) return
  const tabs = modal.querySelectorAll('.sg-tab')
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i] as HTMLElement
    t.classList.toggle('active', t.getAttribute('data-tab') === which)
  }
  const panes = modal.querySelectorAll('.sg-pane')
  for (let i = 0; i < panes.length; i++) {
    const p = panes[i] as HTMLElement
    p.hidden = p.getAttribute('data-pane') !== which
  }
  if (which === 'draw' && !SIG_MODAL_PAD) {
    SIG_MODAL_PAD = sigSetupPad(document.getElementById('__sgPad') as HTMLCanvasElement | null)
    SIG_MODAL_PAD_INI = sigSetupPad(document.getElementById('__sgPadIni') as HTMLCanvasElement | null)
  }
}

function sigModalClear(): void { if (SIG_MODAL_PAD) SIG_MODAL_PAD.clear() }
function sigModalClearIni(): void { if (SIG_MODAL_PAD_INI) SIG_MODAL_PAD_INI.clear() }

function sigModalErr(msg: string): void {
  const e = document.getElementById('__sgErr')
  if (!e) return
  e.textContent = msg
  ;(e as HTMLElement).hidden = !msg
}

export function sigCloseModal(): void {
  if (SIG_MODAL_PAD) { SIG_MODAL_PAD.destroy(); SIG_MODAL_PAD = null }
  if (SIG_MODAL_PAD_INI) { SIG_MODAL_PAD_INI.destroy(); SIG_MODAL_PAD_INI = null }
  const m = document.getElementById('__sgModal')
  if (m && m.parentNode) m.parentNode.removeChild(m)
}

/* Draw the typed name to a canvas in the chosen face and export a PNG.
   document.fonts.load() is awaited: a canvas will happily draw in the fallback
   serif if the webfont has not arrived, producing a signature that looks nothing
   like the one the person picked — found only once it's in a signed PDF. */
async function sigRasterizeTyped(name: string, cssFont: string): Promise<string> {
  const px = 64
  const spec = px + 'px ' + cssFont
  try { if ((document as any).fonts) { await (document as any).fonts.load(spec, name) } } catch { /* fall through */ }
  const pad = 16
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) return ''
  measure.font = spec
  const w = Math.ceil(measure.measureText(name).width) + pad * 2
  const h = Math.ceil(px * 1.9)
  const ratio = Math.max(2, Math.min(3, window.devicePixelRatio || 1))
  const c = document.createElement('canvas')
  c.width = Math.round(w * ratio)
  c.height = Math.round(h * ratio)
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  ctx.scale(ratio, ratio)
  ctx.font = spec
  ctx.fillStyle = '#12325a'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, pad, h / 2)
  return c.toDataURL('image/png')
}

/* Normalise a signature image before it is ever submitted: crop to the actual
   ink, then scale to fit a fixed box (at most SIG_OUT_W x SIG_OUT_H), so the PDF
   stamper gets a correctly-sized mark regardless of pad size or pixel ratio. */
const SIG_OUT_W = 440
const SIG_OUT_H = 88

export function sigNormalize(dataUrl: string): Promise<string> {
  return new Promise(function (resolve) {
    if (!dataUrl) { resolve(''); return }
    const img = new Image()
    img.onerror = function () { resolve(dataUrl) }
    img.onload = function () {
      try {
        const w = img.naturalWidth || img.width
        const h = img.naturalHeight || img.height
        if (!w || !h) { resolve(dataUrl); return }

        const src = document.createElement('canvas')
        src.width = w; src.height = h
        const sctx = src.getContext('2d')
        if (!sctx) { resolve(dataUrl); return }
        sctx.drawImage(img, 0, 0)

        // Ink bounds. Alpha > 8 ignores the anti-aliased ghost around a stroke.
        let minX = w, minY = h, maxX = -1, maxY = -1
        try {
          const d = sctx.getImageData(0, 0, w, h).data
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              if (d[(y * w + x) * 4 + 3] > 8) {
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
              }
            }
          }
        } catch { /* getImageData unavailable — full frame */ }
        if (maxX < 0) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1 }

        const pad = 3
        minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad)
        maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad)
        const cw = maxX - minX + 1
        const ch = maxY - minY + 1

        let scale = Math.min(SIG_OUT_W / cw, SIG_OUT_H / ch)
        if (scale > 2) scale = 2
        const ow = Math.max(1, Math.round(cw * scale))
        const oh = Math.max(1, Math.round(ch * scale))

        const out = document.createElement('canvas')
        out.width = ow; out.height = oh
        const octx = out.getContext('2d')
        if (!octx) { resolve(dataUrl); return }
        octx.drawImage(src, minX, minY, cw, ch, 0, 0, ow, oh)
        resolve(out.toDataURL('image/png'))
      } catch { resolve(dataUrl) }
    }
    img.src = dataUrl
  })
}

async function sigModalAdopt(): Promise<void> {
  sigModalErr('')
  const modal = document.getElementById('__sgModal')
  if (!modal) return
  const typeTab = modal.querySelector('.sg-tab[data-tab="type"]')
  const typing = !!typeTab && typeTab.classList.contains('active')

  if (typing) {
    const el = document.getElementById('__sgName') as HTMLInputElement | null
    const name = el ? el.value.trim() : ''
    if (!name) { sigModalErr('Type your full name to adopt a signature.'); return }
    const url = await sigRasterizeTyped(name, SIG_FONTS[SIG_MODAL_FONT].css)
    if (!url) { sigModalErr('Could not create the signature image. Try the Draw tab.'); return }
    SIG_ADOPTED = { dataUrl: await sigNormalize(url), typedName: name, initialsUrl: await sigMakeInitials(name, SIG_FONTS[SIG_MODAL_FONT].css) }
  } else {
    if (!SIG_MODAL_PAD || !SIG_MODAL_PAD.isDrawn()) { sigModalErr('Draw your signature first.'); return }
    // A drawn signature still needs a typed name — the certificate prints it.
    const el = document.getElementById('__sgName') as HTMLInputElement | null
    const name = el && el.value.trim() ? el.value.trim() : ''
    if (!SIG_MODAL_PAD_INI || !SIG_MODAL_PAD_INI.isDrawn()) { sigModalErr('Draw your initials too — they fill the initials boxes.'); return }
    SIG_ADOPTED = { dataUrl: await sigNormalize(SIG_MODAL_PAD.dataUrl()), typedName: name, initialsUrl: await sigNormalize(SIG_MODAL_PAD_INI.dataUrl()) }
  }
  sigCloseModal()
  if (SIG_ON_CHANGE) SIG_ON_CHANGE()
}

/* "Brandon Payne" -> "BP". '' when the name has no letters. */
function sigInitialsFrom(name: string): string {
  return (name || '').split(/\s+/).map(w => (w.replace(/[^A-Za-z]/g, '')[0] || '')).join('').toUpperCase().slice(0, 4)
}

async function sigMakeInitials(name: string, cssFont: string): Promise<string> {
  const initials = sigInitialsFrom(name)
  if (!initials) return ''
  try { const url = await sigRasterizeTyped(initials, cssFont); return url ? await sigNormalize(url) : '' } catch { return '' }
}

interface SigPad {
  isDrawn(): boolean
  clear(): void
  /** '' when nothing has been drawn. */
  dataUrl(): string
  destroy(): void
}

/* Attach a drawing surface to a canvas. Returns a handle rather than setting a
   module global, so two pads can never fight over one "drawn" flag. */
function sigSetupPad(canvas: HTMLCanvasElement | null): SigPad {
  const noop: SigPad = { isDrawn: () => false, clear: () => { }, dataUrl: () => '', destroy: () => { } }
  if (!canvas) return noop
  const ctx = canvas.getContext('2d')
  if (!ctx) return noop

  // Match the device pixel ratio so the signature isn't a blurry upscale —
  // this is the artifact that ends up in a legal PDF.
  const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const cssW = canvas.clientWidth || canvas.width
  const cssH = canvas.clientHeight || canvas.height
  canvas.width = Math.round(cssW * ratio)
  canvas.height = Math.round(cssH * ratio)
  ctx.scale(ratio, ratio)

  ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#12325a'

  let drawing = false, drawn = false, lx = 0, ly = 0

  const pos = function (e: any): { x: number; y: number } {
    const r = canvas.getBoundingClientRect()
    const t = (e.touches && e.touches[0]) || e
    return { x: (t.clientX - r.left) * (cssW / r.width), y: (t.clientY - r.top) * (cssH / r.height) }
  }
  const start = function (e: any): void { drawing = true; const p = pos(e); lx = p.x; ly = p.y; e.preventDefault() }
  const move = function (e: any): void {
    if (!drawing) return
    const p = pos(e)
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(p.x, p.y); ctx.stroke()
    lx = p.x; ly = p.y; drawn = true; e.preventDefault()
  }
  const end = function (): void { drawing = false }

  canvas.addEventListener('mousedown', start)
  canvas.addEventListener('mousemove', move)
  canvas.addEventListener('touchstart', start, { passive: false })
  canvas.addEventListener('touchmove', move, { passive: false })
  canvas.addEventListener('touchend', end)
  document.addEventListener('mouseup', end)

  return {
    isDrawn: () => drawn,
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false },
    dataUrl: () => drawn ? canvas.toDataURL('image/png') : '',
    destroy: () => {
      canvas.removeEventListener('mousedown', start)
      canvas.removeEventListener('mousemove', move)
      canvas.removeEventListener('touchstart', start)
      canvas.removeEventListener('touchmove', move)
      canvas.removeEventListener('touchend', end)
      document.removeEventListener('mouseup', end)
    },
  }
}

/* The modal's inline onclick handlers resolve against window — attach exactly
   the functions its HTML references. */
Object.assign(window as any, {
  sigModalTab, sigModalPreview, sigModalPickFont, sigModalClear, sigModalClearIni,
  sigModalAdopt, sigCloseModal,
})
