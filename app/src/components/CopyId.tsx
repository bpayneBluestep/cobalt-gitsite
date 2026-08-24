import { useState } from 'react'

/** topIds and fieldIds get pasted into BsJs constantly, so make them one click. */
export default function CopyId({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard is unavailable (insecure context or denied): select it instead
      // so the id can still be copied by hand.
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        const node = document.createTextNode(value)
        document.body.appendChild(node)
        const range = document.createRange()
        range.selectNode(node)
        sel.addRange(range)
        window.setTimeout(() => { sel.removeAllRanges(); node.remove() }, 50)
      }
    }
  }

  return (
    <button
      type="button"
      className="copyid"
      data-copied={copied || undefined}
      onClick={copy}
      title={`Copy ${label || 'id'}: ${value}`}
      aria-label={`Copy ${label || 'id'} ${value}`}
    >
      <code>{value}</code>
      <span className="copyid__hint" aria-hidden="true">{copied ? 'copied' : 'copy'}</span>
    </button>
  )
}
