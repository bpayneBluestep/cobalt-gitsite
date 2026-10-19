import { useState, type SyntheticEvent } from 'react'
import type { Attachment } from '../api'

type Kind = 'video' | 'audio' | 'image' | null

/** What an attachment can be shown as in the page. The mime wins; the extension covers
 *  older rows saved with a blank or generic mime. */
export function previewKind(a: Attachment): Kind {
  const mime = (a.mime || '').toLowerCase()
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('image/')) return 'image'
  const ext = a.name.toLowerCase().split('.').pop() || ''
  if (['webm', 'mp4', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'm4a', 'ogg', 'oga', 'weba'].includes(ext)) return 'audio'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  return null
}

/**
 * Browser-recorded WebM (MediaRecorder, which is what the ticket's Record button makes)
 * is written without a duration, so Chrome reports Infinity and the scrubber can't seek.
 * Jumping far past the end makes the browser read to the last cluster and learn the real
 * length; then rewind to the start.
 */
function fixUnknownDuration(e: SyntheticEvent<HTMLMediaElement>) {
  const el = e.currentTarget
  if (el.duration !== Infinity && !Number.isNaN(el.duration)) return
  const rewind = () => {
    el.removeEventListener('durationchange', rewind)
    el.currentTime = 0
  }
  el.addEventListener('durationchange', rewind)
  el.currentTime = 1e101
}

/** The toggle that opens an inline player under the attachment row. */
export function PreviewToggle({ kind, open, onToggle }: { kind: Kind; open: boolean; onToggle: () => void }) {
  if (!kind) return null
  const verb = kind === 'image' ? 'View' : 'Play'
  return (
    <button type="button" className="linkbtn" aria-expanded={open} onClick={onToggle}>
      {open ? 'Hide' : verb}
    </button>
  )
}

/** The inline player itself. Streams straight from the /download/ URL, which serves
 *  byte ranges, so a long recording starts playing without downloading it first. */
export function PreviewPane({ a, kind }: { a: Attachment; kind: Kind }) {
  const [failed, setFailed] = useState(false)
  if (!kind) return null
  if (failed) {
    return (
      <p className="att__player att__player--fail" role="status">
        This browser can’t play {a.name}. <a href={a.url} target="_blank" rel="noopener noreferrer">Download it</a> instead.
      </p>
    )
  }
  if (kind === 'image') {
    return <img className="att__player" src={a.url} alt={a.name} onError={() => setFailed(true)} />
  }
  if (kind === 'audio') {
    return (
      <audio className="att__player" src={a.url} controls preload="metadata" autoPlay
        onLoadedMetadata={fixUnknownDuration} onError={() => setFailed(true)} />
    )
  }
  return (
    <video className="att__player" src={a.url} controls preload="metadata" autoPlay playsInline
      onLoadedMetadata={fixUnknownDuration} onError={() => setFailed(true)} />
  )
}
