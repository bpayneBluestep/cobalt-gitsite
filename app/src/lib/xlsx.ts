/*
 * Spreadsheet in, rows of strings out: .xlsx or .csv.
 *
 * Deliberately not SheetJS. Cobalt keeps its runtime dependencies to three on purpose,
 * the npm build of SheetJS is years stale, and all the Finance report needs from an
 * .xlsx is the text of the first sheet. An .xlsx is a zip of XML; the browser already
 * ships both halves of reading one (DecompressionStream for the zip, DOMParser for the
 * XML), so the whole reader is the glue between them.
 *
 * Output is positional on purpose. QuickBooks leaves cells out of the XML when they
 * are blank (the expense report's column A is empty on every data row), and a reader
 * that packed the cells it found to the left would shift Amount into the wrong column
 * and produce plausible, wrong totals. Every row comes back with its blanks as ''.
 */

/** Rows of a sheet: row 0 is the sheet's first row, column 0 its column A. */
export type SheetRows = string[][]

/**
 * Read the first worksheet of an .xlsx, or a .csv, into rows of strings.
 *
 * Numbers come back as the text the file stores (`416.0`, `45123`), not formatted:
 * the caller knows whether a column is money or a date serial, the reader does not.
 */
export async function readSheet(bytes: Uint8Array, filename: string): Promise<SheetRows> {
  // The extension can lie (a CSV saved as .xlsx by hand), the zip signature cannot, so
  // anything that is not a zip is treated as text.
  if (/\.csv$/i.test(filename) || !isZip(bytes)) {
    return parseCsv(new TextDecoder().decode(bytes))
  }
  const entries = readCentralDirectory(bytes, filename)
  const sheetEntry =
    entries.find(e => e.name === 'xl/worksheets/sheet1.xml') ??
    entries.find(e => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name))
  if (!sheetEntry) throw new Error(`${filename}: no worksheet found in the .xlsx file.`)

  const sharedEntry = entries.find(e => e.name === 'xl/sharedStrings.xml')
  const shared = sharedEntry ? readSharedStrings(parseXml(await inflateEntry(bytes, sharedEntry, filename))) : []
  return readWorksheet(parseXml(await inflateEntry(bytes, sheetEntry, filename)), shared)
}

/**
 * CSV text to rows, RFC 4180: quoted fields, doubled quotes inside them, commas and
 * line breaks inside quotes, CRLF or LF.
 *
 * The leading BOM is stripped because QuickBooks writes one, and left in place it
 * glues itself to the first cell, so a header lookup for that cell quietly misses.
 */
export function parseCsv(text: string): SheetRows {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: SheetRows = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
      } else {
        field += ch
      }
      i += 1
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (ch === '\r' && src[i + 1] === '\n') i += 1
    } else {
      field += ch
    }
    i += 1
  }
  // A file that ends with a newline has no row after it; one that does not still owes
  // its last row.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// ── zip ────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/*
 * Entries come from the central directory, not by walking local headers from the
 * front: a local header written in streaming mode carries zero sizes (the real ones
 * follow the data), so only the central directory is trustworthy about where each
 * entry ends.
 */
function readCentralDirectory(bytes: Uint8Array, filename: string): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-central-directory record is 22 bytes plus a comment of up to 64 KB, so
  // it is searched for backwards within that window.
  const stop = Math.max(0, bytes.length - 22 - 0xffff)
  let eocd = -1
  for (let p = bytes.length - 22; p >= stop; p -= 1) {
    if (view.getUint32(p, true) === 0x06054b50) { eocd = p; break }
  }
  if (eocd < 0) throw new Error(`${filename}: not a readable .xlsx file (no zip directory found).`)

  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  if (p === 0xffffffff) throw new Error(`${filename}: this .xlsx uses ZIP64, which this reader does not support.`)

  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`${filename}: the .xlsx zip directory is damaged.`)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    entries.push({
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      localHeaderOffset: view.getUint32(p + 42, true),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function inflateEntry(bytes: Uint8Array, entry: ZipEntry, filename: string): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const h = entry.localHeaderOffset
  if (view.getUint32(h, true) !== 0x04034b50) throw new Error(`${filename}: the .xlsx entry ${entry.name} is damaged.`)
  // The local header's own name/extra lengths, which need not match the central
  // directory's extra field.
  const start = h + 30 + view.getUint16(h + 26, true) + view.getUint16(h + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)

  if (entry.method === 0) return new TextDecoder().decode(data)
  if (entry.method !== 8) {
    throw new Error(`${filename}: the .xlsx entry ${entry.name} uses compression method ${entry.method}, which this reader does not support.`)
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot read .xlsx files (it has no DecompressionStream). Use a current Chrome, Edge, Safari or Firefox, or attach the file as .csv.')
  }
  // Copied into a fresh buffer: Blob wants an ArrayBuffer-backed view, and `bytes` may
  // be a window onto a larger (or shared) buffer.
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

// ── xml ────────────────────────────────────────────────────────────────────

/*
 * The one place XML is parsed, so a test outside the browser can stand in its own
 * DOMParser (through globalThis) without touching the rest of the reader.
 */
function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('The .xlsx file contains XML this reader cannot parse.')
  return doc
}

/*
 * Matched by local name in any namespace. Excel writes SpreadsheetML as the default
 * namespace, but some generators prefix it (`x:row`), and a plain tag-name lookup
 * would find nothing in those files.
 */
function byName(node: Document | Element, local: string): Element[] {
  return Array.from(node.getElementsByTagNameNS('*', local))
}

function childrenNamed(el: Element, local: string): Element[] {
  const out: Element[] = []
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (c as Element).localName === local) out.push(c as Element)
  }
  return out
}

/*
 * The text of a string item: every <t> under it, so a rich-text cell (one <r> run per
 * formatting change) reads as the whole string. <t> inside <rPh> is a phonetic
 * reading guide for East Asian text, not part of the value, so it is skipped.
 */
function stringItemText(si: Element): string {
  return byName(si, 't')
    .filter(t => (t.parentNode as Element | null)?.localName !== 'rPh')
    .map(t => t.textContent ?? '')
    .join('')
}

function readSharedStrings(doc: Document): string[] {
  return byName(doc, 'si').map(stringItemText)
}

/** "K12" → 10 (column K, zero-based). */
function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref.toUpperCase()) {
    const code = ch.charCodeAt(0)
    if (code < 65 || code > 90) break
    n = n * 26 + (code - 64)
  }
  return n - 1
}

function readWorksheet(doc: Document, shared: string[]): SheetRows {
  const rows: SheetRows = []
  let nextRow = 0
  for (const rowEl of byName(doc, 'row')) {
    // Rows Excel considers empty are simply absent, so the `r` attribute (1-based) is
    // what keeps row numbers honest; without one the row follows the previous.
    const r = parseInt(rowEl.getAttribute('r') ?? '', 10)
    const rowIdx = Number.isFinite(r) && r > 0 ? r - 1 : nextRow
    nextRow = rowIdx + 1
    const cells: string[] = []
    let nextCol = 0
    for (const c of childrenNamed(rowEl, 'c')) {
      const ref = c.getAttribute('r')
      const col = ref ? columnIndex(ref) : nextCol
      nextCol = col + 1
      cells[col] = cellText(c, shared)
    }
    for (let k = 0; k < cells.length; k += 1) if (cells[k] === undefined) cells[k] = ''
    while (rows.length < rowIdx) rows.push([])
    rows[rowIdx] = cells
  }
  return rows
}

function cellText(c: Element, shared: string[]): string {
  const type = c.getAttribute('t')
  if (type === 'inlineStr') {
    const is = childrenNamed(c, 'is')[0]
    return is ? stringItemText(is) : ''
  }
  const v = childrenNamed(c, 'v')[0]
  const raw = v ? v.textContent ?? '' : ''
  if (type === 's') return shared[parseInt(raw, 10)] ?? ''
  // 'n' (or no type), 'str' (a formula's cached text), 'b' (0/1) and 'e' (#N/A and
  // friends) all store their value as the <v> text itself.
  return raw
}
