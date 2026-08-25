/*
 * pdf.ts — pdf.js runtime loading + the ONE geometry model every agreements
 * surface shares. Ported from eccrm's pdfrt.ts + pdfgeo.ts.
 *
 * Tabs are stored in PDF POINTS with a TOP-LEFT origin, per page:
 *   { docId, page (1-based), x, y, w, h } — x,y is the tab's top-left corner.
 * The screen renders each page at some CSS width; scale = cssWidth / pageWidthPt.
 * Nothing ever stores pixels, which is what makes "zoom never drifts" true by
 * construction. (PDF's native space is bottom-left-origin; the flip happens
 * exactly once, in the server-side stamper.)
 *
 * pdf.js is ES-module-only and 1.7MB with its worker, so it stays OUT of the
 * bundle and loads on first use from /spa/vendor/. The dynamic import() is built
 * via new Function so Vite doesn't try to resolve or rewrite it at build time.
 */

// BASE_URL is '/spa/' in the build, '/' in dev — public/ files sit under it both ways.
function vendorUrl(file: string): string {
  return new URL(import.meta.env.BASE_URL + 'vendor/' + file, location.href).href
}

let PDFJS_P: Promise<any> | null = null

export function loadPdfJs(): Promise<any> {
  if (PDFJS_P) return PDFJS_P
  const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>
  PDFJS_P = dynImport(vendorUrl('pdf.min.mjs')).then((lib: any) => {
    lib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.mjs')
    return lib
  })
  return PDFJS_P
}

/** Open a document by URL. Same-origin — the platform session cookie rides along. */
export async function pdfOpen(url: string): Promise<any> {
  const lib = await loadPdfJs()
  return lib.getDocument({ url, withCredentials: true }).promise
}

/** Open a document from base64 bytes (the anonymous sign page gets PDFs embedded). */
export async function pdfOpenData(b64: string): Promise<any> {
  const lib = await loadPdfJs()
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return lib.getDocument({ data: u8 }).promise
}

/*
 * Render one page of a PDF into a canvas at a given CSS-pixel width. Shared by
 * thumbnails, the designer and the signing view — one code path for
 * "PDF url -> pixels" so scale math can never disagree between surfaces.
 */
export async function pdfRenderPage(
  pdf: any, pageNum: number, canvas: HTMLCanvasElement, cssWidth: number,
): Promise<{ wPt: number; hPt: number }> {
  const page = await pdf.getPage(pageNum)
  const base = page.getViewport({ scale: 1 }) // PDF points
  const scale = cssWidth / base.width
  const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const vp = page.getViewport({ scale: scale * ratio })
  canvas.width = Math.round(vp.width)
  canvas.height = Math.round(vp.height)
  canvas.style.width = cssWidth + 'px'
  canvas.style.height = Math.round(cssWidth * (base.height / base.width)) + 'px'
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
  return { wPt: base.width, hPt: base.height }
}

// ---------------------------------------------------------------- geometry

export interface GeoPage { docId: string; page: number; wPt: number; hPt: number }

export const geoPtToPx = (v: number, scale: number): number => v * scale
export const geoPxToPt = (v: number, scale: number): number => v / scale
export const geoScale = (cssWidth: number, wPt: number): number => cssWidth / wPt

/** Position a tab element over its page wrapper. Pixel-snapped so borders stay crisp. */
export function geoApplyTabRect(
  el: HTMLElement, tab: { x: number; y: number; w: number; h: number }, scale: number,
): void {
  el.style.left = Math.round(geoPtToPx(tab.x, scale)) + 'px'
  el.style.top = Math.round(geoPtToPx(tab.y, scale)) + 'px'
  el.style.width = Math.round(geoPtToPx(tab.w, scale)) + 'px'
  el.style.height = Math.round(geoPtToPx(tab.h, scale)) + 'px'
}

/** Clamp a tab rect (points) inside its page (points). */
export function geoClampTab(
  tab: { x: number; y: number; w: number; h: number }, wPt: number, hPt: number,
): void {
  tab.w = Math.min(tab.w, wPt)
  tab.h = Math.min(tab.h, hPt)
  tab.x = Math.max(0, Math.min(tab.x, wPt - tab.w))
  tab.y = Math.max(0, Math.min(tab.y, hPt - tab.h))
}

/* Default tab sizes in points, per type. Used by the designer for placement and
   by the signing view for minimum hit targets. */
export const GEO_TAB_DEFAULTS: { [type: string]: { w: number; h: number } } = {
  signature: { w: 150, h: 34 },
  initials: { w: 48, h: 22 },
  dateSigned: { w: 84, h: 16 },
  name: { w: 130, h: 16 },
  text: { w: 150, h: 16 },
  checkbox: { w: 13, h: 13 },
  radioGroup: { w: 120, h: 54 },
  dropdown: { w: 130, h: 18 },
}

export const GEO_TAB_LABELS: { [type: string]: string } = {
  signature: 'Signature', initials: 'Initials', dateSigned: 'Date signed',
  name: 'Name', text: 'Text', checkbox: 'Checkbox', radioGroup: 'Radio group',
  dropdown: 'Dropdown',
}

/* Recipient color assignments — index by recipient order-of-appearance.
   Chosen for contrast against white pages in both themes. */
const GEO_RECIPIENT_COLORS = ['#2563eb', '#d97706', '#0d9488', '#9333ea', '#dc2626', '#4d7c0f']
export const geoRecipientColor = (i: number): string =>
  GEO_RECIPIENT_COLORS[i % GEO_RECIPIENT_COLORS.length]
