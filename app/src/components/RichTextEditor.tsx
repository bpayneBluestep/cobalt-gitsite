import { useEffect, useRef } from 'react'
import { sanitizeHtml } from '../lib/html'

/*
 * A small rich-text editor for ticket details.
 *
 * contentEditable plus execCommand. execCommand is deprecated and it is still the
 * only formatting API every browser implements without a library, and a library is
 * not an option here: the artifact CSP blocks external scripts, and bundling an
 * editor to get bold and bullets is a poor trade for an internal tool.
 *
 * Two rules make it safe and predictable:
 *   * the DOM is only written on mount and when the ticket changes (`docKey`).
 *     Re-rendering into a focused contentEditable moves the caret to the start,
 *     which makes typing feel broken, so React never touches it while editing.
 *   * paste is intercepted and sanitised, so pasting from Word or a browser cannot
 *     smuggle markup past the allowlist.
 */

const TOOLS: { cmd: string; arg?: string; label: string; title: string; className?: string }[] = [
  { cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)', className: 'rte__b' },
  { cmd: 'italic', label: 'I', title: 'Italic (Ctrl+I)', className: 'rte__i' },
  { cmd: 'insertUnorderedList', label: '• List', title: 'Bulleted list' },
  { cmd: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
  { cmd: 'formatBlock', arg: 'h3', label: 'H', title: 'Heading' },
  { cmd: 'formatBlock', arg: 'p', label: '¶', title: 'Normal text' },
  { cmd: 'removeFormat', label: 'Clear', title: 'Strip formatting' },
]

export default function RichTextEditor({
  value, docKey, onChange, placeholder, ariaLabel, tall,
}: {
  value: string
  /** Changes when a different ticket is loaded: the only time the DOM is reset. */
  docKey: string
  onChange: (html: string) => void
  placeholder?: string
  ariaLabel: string
  /** Give the body room: the ticket page's description is the main event. */
  tall?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const loaded = useRef('')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (loaded.current === docKey) return
    loaded.current = docKey
    el.innerHTML = sanitizeHtml(value)
  }, [docKey, value])

  function emit() {
    const el = ref.current
    if (el) onChange(el.innerHTML)
  }

  function run(cmd: string, arg?: string) {
    const el = ref.current
    if (!el) return
    el.focus()
    try {
      document.execCommand(cmd, false, arg)
    } catch {
      // A browser that refuses the command leaves the text alone: acceptable.
    }
    emit()
  }

  return (
    <div className="rte">
      <div className="rte__bar" role="toolbar" aria-label="Formatting">
        {TOOLS.map(t => (
          <button
            key={t.cmd + (t.arg || '')}
            type="button"
            className={`rte__tool${t.className ? ' ' + t.className : ''}`}
            title={t.title}
            // Keep the selection: mousedown would blur the editable first.
            onMouseDown={e => e.preventDefault()}
            onClick={() => run(t.cmd, t.arg)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        ref={ref}
        className={tall ? 'rte__body rte__body--tall' : 'rte__body'}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder || ''}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onPaste={e => {
          e.preventDefault()
          const html = e.clipboardData.getData('text/html')
          const text = e.clipboardData.getData('text/plain')
          const safe = html
            ? sanitizeHtml(html)
            : text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
          document.execCommand('insertHTML', false, safe)
          emit()
        }}
      />
    </div>
  )
}
