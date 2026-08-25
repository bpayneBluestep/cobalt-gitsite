import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getEnvelope, listAgreementTemplates, saveEnvelopeTabs, saveTemplateDesign,
} from '../agreements/api'
import { dsgMount, dsgUnmount, dsgBindDelegates } from '../agreements/designer'
import '../agreements/agreements.css'

/*
 * The field-placement designer, hosted for both targets:
 *
 *   /clients/:id/agreements/:entryId/design     — a Draft (or correcting) envelope
 *   /agreements/templates/:entryId/design       — a template's roles + tabs
 *
 * React renders the page chrome and loads the data; the framework-free engine in
 * agreements/designer.ts owns everything inside the container (pdf.js canvases,
 * drag/resize, keyboard, autosave). One geometry model with the signing view is
 * the reason a placed field lands exactly where the signer sees it.
 */

export default function DesignerPage({ mode }: { mode: 'env' | 'tpl' }) {
  const { id = '', entryId = '' } = useParams()
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error'; error?: string; title?: string }>({ phase: 'loading' })
  const [notice, setNotice] = useState('')

  useEffect(() => {
    dsgBindDelegates()
    let dead = false
    setState({ phase: 'loading' })

    async function boot() {
      const container = containerRef.current
      if (!container) return
      if (mode === 'env') {
        const env = await getEnvelope(id, entryId)
        if (dead) return
        // Draft: normal designing. Sent/Partially Signed: a CORRECTION — allowed,
        // with signed recipients' fields locked (the server enforces the same).
        if (env.status !== 'Draft' && env.status !== 'Sent' && env.status !== 'Partially Signed') {
          setState({ phase: 'error', error: `This envelope is ${env.status} and can no longer be edited.` })
          return
        }
        const locked: { [rid: string]: boolean } = {}
        for (const r of (env.recipients || [])) { if (r.status === 'signed') locked[r.id] = true }
        setState({ phase: 'ready', title: env.title })
        dsgMount({
          container,
          mode: 'env',
          title: env.title,
          docs: (env.documents || []).slice().sort((a: any, b: any) => a.order - b.order),
          tabs: (env.tabs || []) as any[],
          recipients: env.recipients || [],
          correcting: env.status !== 'Draft',
          locked,
          save: (tabs) => saveEnvelopeTabs(id, entryId, tabs),
          onBack: () => navigate(`/clients/${id}/agreements`),
          toast: setNotice,
        })
      } else {
        const list = await listAgreementTemplates()
        if (dead) return
        const t = (list || []).find(x => x.entryId === entryId)
        if (!t || !t.bodyJson || t.bodyJson.schemaVersion !== 3) {
          setState({ phase: 'error', error: 'Template not found or not an upload-based template.' })
          return
        }
        setState({ phase: 'ready', title: t.name })
        dsgMount({
          container,
          mode: 'tpl',
          title: t.name,
          docs: (t.bodyJson.documents || []).slice().sort((a: any, b: any) => a.order - b.order),
          tabs: (t.bodyJson.tabs || []) as any[],
          roles: (t.bodyJson.roles || []).slice(),
          save: (tabs, roles) => saveTemplateDesign(entryId, tabs, roles, (t.bodyJson!.anchors || []) as any[]),
          onBack: () => navigate('/agreements/templates'),
          toast: setNotice,
        })
      }
    }

    boot().catch(e => { if (!dead) setState({ phase: 'error', error: e instanceof Error ? e.message : String(e) }) })
    return () => { dead = true; dsgUnmount() }
  }, [mode, id, entryId, navigate])

  return (
    <section className="page agr" style={{ maxWidth: 'none' }}>
      <header className="page__head">
        <p className="eyebrow">{mode === 'env' ? 'Envelope' : 'Template'}</p>
        <h1>Place fields{state.title ? ` — ${state.title}` : ''}</h1>
      </header>
      {notice && <p className="board2__notice" role="status" onClick={() => setNotice('')}>{notice}</p>}
      {state.phase === 'loading' && <p className="empty">Loading designer…</p>}
      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">Designer unavailable</p>
          <p>{state.error}</p>
          <p className="callout__actions">
            <button type="button" className="btn" onClick={() => navigate(mode === 'env' ? `/clients/${id}/agreements` : '/agreements/templates')}>Back</button>
          </p>
        </div>
      )}
      <div ref={containerRef} />
    </section>
  )
}
