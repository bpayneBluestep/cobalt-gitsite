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
  value, docKey, onChange, placeholder, ariaLabel, tall, compact, onKeyDown,
}: {
  value: string
  /** Changes when a different ticket is loaded: the only time the DOM is reset. */
  docKey: string
  onChange: (html: string) => void
  placeholder?: string
  ariaLabel: string
  /** Give the body room: the ticket page's description is the main event. */
  tall?: boolean
  /** A couple of lines rather than a page: the comment box under the activity log. */
  compact?: boolean
  /** So a host can bind a submit shortcut without owning the editable. */
  onKeyDown?: (e: React.KeyboardEvent) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const loaded = useRef('')
  /*
   * The selection, saved before the link prompt steals focus.
   *
   * `window.prompt` blurs the editable, and a blurred contentEditable has no usable
   * selection to apply `createLink` to - the link would land wherever the caret
   * happened to fall back to, or nowhere. Saving the Range on mousedown and putting
   * it back afterwards is what makes "highlight a phrase, then link it" work.
   */
  const savedRange = useRef<Range | null>(null)

  function rememberSelection() {
    const sel = window.getSelection()
    if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange()
    }
  }

  function restoreSelection() {
    const range = savedRange.current
    if (!range) return
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
  }

  /** The anchor the caret sits in, if any: what makes Link double as Unlink. */
  function anchorAtCaret(): HTMLAnchorElement | null {
    const range = savedRange.current
    let node: Node | null = range ? range.startContainer : null
    while (node && node !== ref.current) {
      if ((node as Element).tagName === 'A') return node as HTMLAnchorElement
      node = node.parentNode
    }
    return null
  }

  function linkTool() {
    const el = ref.current
    if (!el) return
    const existing = anchorAtCaret()
    const selection = savedRange.current
    const hasText = !!selection && !selection.collapsed

    if (!existing && !hasText) {
      window.alert('Select the words you want to link first.')
      return
    }

    const current = existing?.getAttribute('href') || ''
    const answer = window.prompt(
      existing ? 'Edit the link (clear it to unlink):' : 'Link to:',
      current,
    )
    if (answer === null) return              // dismissed: leave the text alone

    el.focus()
    restoreSelection()
    const url = answer.trim()
    if (!url) {
      // Unlink needs the whole anchor selected, not just the caret inside it.
      if (existing) {
        const range = document.createRange()
        range.selectNodeContents(existing)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      run('unlink')
      return
    }
    // A bare host is what people paste. Without a scheme the browser treats it as a
    // relative path and the link silently points inside the app.
    const href = /^(https?:|mailto:|\/|#)/i.test(url) ? url : `https://${url}`
    if (existing && !hasText) {
      existing.setAttribute('href', href)
      emit()
      return
    }
    run('createLink', href)
  }

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
        <button
          type="button"
          className="rte__tool"
          title="Link the selected words (Ctrl+K)"
          onMouseDown={e => { e.preventDefault(); rememberSelection() }}
          onClick={linkTool}
        >
          Link
        </button>
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
        className={`rte__body${tall ? ' rte__body--tall' : ''}${compact ? ' rte__body--compact' : ''}`}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder || ''}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault()
            rememberSelection()
            linkTool()
            return
          }
          onKeyDown?.(e)
        }}
        onPaste={e => {
          e.preventDefault()
          const html = e.clipboardData.getData('text/html')
          const text = e.clipboardData.getData('text/plain')
          // Pasting a URL over selected words links them instead of replacing them.
          // That is what every other editor does, and it is the gesture Dan described.
          const sel = window.getSelection()
          if (!html && /^https?:\/\/\S+$/i.test(text.trim()) && sel && !sel.isCollapsed) {
            document.execCommand('createLink', false, text.trim())
            emit()
            return
          }
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
