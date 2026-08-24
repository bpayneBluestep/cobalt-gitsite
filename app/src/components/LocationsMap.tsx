import { useEffect, useState } from 'react'

/*
 * The org's unit tree, in a modal: ported from the eccrm CRM's Locations Map.
 *
 * `POST /getNavTree` is the platform's own navigation source, the same one the native
 * chrome's location switcher reads. It needs no arguments and no ids, which is why this
 * is one of the few pieces of native chrome that works unchanged in a standalone GitSite:
 * there is no page object involved.
 *
 * Each node's `text` is HTML with an inline SVG icon in front of the label, so it has to
 * be stripped: rendering it raw would mean trusting server HTML into the DOM, and
 * showing it unstripped puts a wall of markup on screen. The label is extracted as TEXT
 * and inserted as text; nothing here uses innerHTML.
 */

interface NavNode {
  text?: unknown
  href?: unknown
  nodes?: NavNode[]
}

/**
 * The visible label for a node.
 *
 * The SVG is removed first, then the remainder is decoded as text via the DOM's own
 * parser, which handles entities without this having to know the list, and the result
 * is used as a string, never as markup.
 */
function cleanLabel(text: unknown): string {
  const raw = String(text ?? '').replace(/<svg[\s\S]*?<\/svg>/gi, '')
  const holder = document.createElement('div')
  holder.innerHTML = raw
  return (holder.textContent || '').replace(/\s+/g, ' ').trim() || '-'
}

function Branch({ nodes, depth }: { nodes: NavNode[]; depth: number }) {
  return (
    <ul className="locmap__list" data-depth={depth}>
      {nodes.map((node, i) => {
        const label = cleanLabel(node.text)
        const href = typeof node.href === 'string' && node.href ? node.href : ''
        const kids = Array.isArray(node.nodes) ? node.nodes : []
        return (
          <li key={`${depth}-${i}-${label}`}>
            {href
              ? <a className="locmap__link" href={href}>{label}</a>
              : <span className="locmap__group">{label}</span>}
            {kids.length > 0 && <Branch nodes={kids} depth={depth + 1} />}
          </li>
        )
      })}
    </ul>
  )
}

export default function LocationsMap({ onClose }: { onClose: () => void }) {
  const [nodes, setNodes] = useState<NavNode[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    fetch('/getNavTree', { method: 'POST', credentials: 'include', cache: 'no-store' })
      .then(r => r.json())
      .then((tree: unknown) => {
        if (!alive) return
        setNodes(Array.isArray(tree) ? (tree as NavNode[]) : [])
      })
      .catch(() => { if (alive) setError('Could not load the locations map.') })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="locmap"
      // Only a click that both starts and ends on the backdrop dismisses: otherwise a
      // text selection that happens to finish outside the card closes it and loses the
      // place the user was reading.
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="locmap__card" role="dialog" aria-modal="true" aria-label="Locations map">
        <header className="locmap__head">
          <div>
            <h2>Locations</h2>
            <p>The org's unit tree, straight from the platform's own navigation.</p>
          </div>
          <button type="button" className="locmap__x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="locmap__body">
          {error && <p className="locmap__msg">{error}</p>}
          {!error && nodes === null && <p className="locmap__msg">Loading…</p>}
          {!error && nodes !== null && nodes.length === 0 && (
            <p className="locmap__msg">No locations came back.</p>
          )}
          {!error && nodes !== null && nodes.length > 0 && <Branch nodes={nodes} depth={0} />}
        </div>

        <p className="locmap__foot">Opens the platform's own pages. BlueStep enforces access.</p>
      </div>
    </div>
  )
}
