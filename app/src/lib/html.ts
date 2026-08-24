/*
 * Sanitising for ticket details.
 *
 * Details are rich text, stored as HTML and rendered with dangerouslySetInnerHTML.
 * That is only safe with an allowlist, so this strips everything not on it: on the
 * way IN (before saving, and after a paste) and again on the way OUT (before
 * rendering). Twice on purpose: content already in the field predates this code,
 * and a value can also be edited straight on the BlueStep form.
 *
 * The allowlist is what the editor can produce and nothing more. No images, no
 * iframes, no styles, no event handlers, no javascript: URLs.
 */

const ALLOWED_TAGS = [
  'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'CODE', 'PRE',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H3', 'H4', 'A', 'DIV', 'SPAN',
]

/** Tags kept for their content but unwrapped, because the editor over-produces them. */
const UNWRAP_TAGS = ['DIV', 'SPAN', 'FONT']

const ALLOWED_ATTRS: Record<string, string[]> = {
  A: ['href', 'title'],
}

function safeHref(value: string): string | null {
  const v = value.trim()
  // Relative and anchor links are fine; absolute ones must be http(s) or mailto.
  if (/^(\/|#|\.\/)/.test(v)) return v
  if (/^(https?:|mailto:)/i.test(v)) return v
  return null
}

function clean(node: Element): void {
  // Walk a static copy: the loop reparents and removes nodes as it goes.
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue

    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove()
      continue
    }

    const el = child as Element
    const tag = el.tagName.toUpperCase()

    if (ALLOWED_TAGS.indexOf(tag) < 0) {
      // Not allowed: drop the element but keep any text it was wrapping, so
      // pasting from a word processor loses the markup and not the words.
      clean(el)
      el.replaceWith(...Array.from(el.childNodes))
      continue
    }

    clean(el)

    for (const attr of Array.from(el.attributes)) {
      const allowed = ALLOWED_ATTRS[tag] || []
      if (allowed.indexOf(attr.name.toLowerCase()) < 0) {
        el.removeAttribute(attr.name)
        continue
      }
      if (attr.name.toLowerCase() === 'href') {
        const href = safeHref(attr.value)
        if (href === null) el.removeAttribute('href')
        else el.setAttribute('href', href)
      }
    }

    if (UNWRAP_TAGS.indexOf(tag) >= 0 && !el.attributes.length) {
      el.replaceWith(...Array.from(el.childNodes))
    }
  }
}

/** HTML reduced to the allowlist. Returns '' for anything with no content. */
export function sanitizeHtml(html: string): string {
  if (!html) return ''
  const host = document.createElement('div')
  host.innerHTML = html
  clean(host)
  const out = host.innerHTML.trim()
  // A single empty paragraph or a stray <br> is "nothing", not content.
  return /^(<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>|<br\s*\/?>|\s)*$/i.test(out) ? '' : out
}

/** Rich text as one line of plain text, for table cells and search. */
export function htmlToText(html: string): string {
  if (!html) return ''
  const host = document.createElement('div')
  host.innerHTML = html
  return (host.textContent || '').replace(/\s+/g, ' ').trim()
}

/** Plain text as HTML, keeping paragraph and line breaks. */
export function textToHtml(text: string): string {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
}
