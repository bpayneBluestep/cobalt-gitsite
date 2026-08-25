import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../session'
import {
  listAgreementTemplates, saveAgreementTemplate, setAgreementTemplateStatus,
  uploadTemplateDoc, fileToBase64, type AgreementTemplate,
} from '../agreements/api'
import { pdfOpen, pdfRenderPage } from '../agreements/pdf'
import '../agreements/agreements.css'

/*
 * Agreement Templates — reusable envelopes: upload the PDFs once, place fields
 * once, send many times.
 *
 * Templates live on the per-unit Organization records ("Behavioral", "Assisted
 * Living"), so each unit keeps its own library; every template row carries its
 * library's name and creating one picks a library. Ported from eccrm's
 * agreementbuilder surface.
 */

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const TPL_CATEGORIES = ['Sales', 'Onboarding', 'Legal', 'Renewal', 'Other']
const TPL_STATUSES = ['Draft', 'Active', 'Archived']

interface Editing {
  entryId: string | null
  orgId: string
  orgName: string
  name: string
  description: string
  status: string
  category: string
  bodyJson: { schemaVersion: number; documents: any[]; roles: any[]; tabs: any[]; anchors: any[] }
}

export default function AgreementTemplates() {
  const { can } = useSession()
  const [list, setList] = useState<AgreementTemplate[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const canManage = can('manageAgreementTemplates')

  const load = useCallback(() => {
    setError('')
    listAgreementTemplates()
      .then(l => setList(l || []))
      .catch(e => setError(errMsg(e)))
  }, [])

  useEffect(load, [load])

  // First-page thumbnails on the editor's doc rows.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const canvases = root.querySelectorAll('canvas[data-thumb]')
    canvases.forEach(async c => {
      const canvas = c as HTMLCanvasElement
      const url = canvas.getAttribute('data-thumb') || ''
      if (!url || canvas.getAttribute('data-thumb-done')) return
      canvas.setAttribute('data-thumb-done', '1')
      try {
        const pdf = await pdfOpen(url)
        await pdfRenderPage(pdf, 1, canvas, 72)
        try { pdf.destroy() } catch { /* */ }
      } catch { /* blank canvas is fine */ }
    })
  })

  /* The unit libraries visible to this caller, derived from the rows themselves
     plus whichever library a create should target. */
  const libraries: { orgId: string; orgName: string }[] = []
  for (const t of (list || [])) {
    if (t.orgId && !libraries.find(l => l.orgId === t.orgId)) libraries.push({ orgId: t.orgId, orgName: t.orgName })
  }

  function startNew(orgId: string, orgName: string) {
    setEditing({
      entryId: null, orgId, orgName, name: '', description: '', status: 'Draft', category: 'Other',
      bodyJson: { schemaVersion: 3, documents: [], roles: [], tabs: [], anchors: [] },
    })
  }

  function startEdit(t: AgreementTemplate) {
    if (!t.bodyJson || t.bodyJson.schemaVersion !== 3) return
    setEditing(JSON.parse(JSON.stringify({
      entryId: t.entryId, orgId: t.orgId, orgName: t.orgName,
      name: t.name, description: t.description, status: t.status, category: t.category || 'Other',
      bodyJson: t.bodyJson,
    })))
  }

  async function archive(entryId: string) {
    if (!confirm('Archive this template? It will stop appearing when sending.')) return
    try { await setAgreementTemplateStatus(entryId, 'Archived'); load() }
    catch (e) { setNotice('Archive failed: ' + errMsg(e)) }
  }

  if (list === null && !error) return <section className="page"><p className="empty">Loading templates…</p></section>

  return (
    <section className="page agr" ref={rootRef}>
      {notice && <p className="board2__notice" role="status" onClick={() => setNotice('')}>{notice}</p>}
      {error && (
        <div className="callout">
          <p className="callout__title">Could not load templates</p>
          <p>{error}</p>
          <p className="callout__actions"><button type="button" className="btn" onClick={load}>Try again</button></p>
        </div>
      )}
      {!error && !editing && (
        <>
          <header className="page__head">
            <p className="eyebrow">Agreements</p>
            <div className="page__headrow">
              <h1>Agreement Templates</h1>
              {canManage && (
                <NewTemplateButton libraries={libraries} onPick={startNew} />
              )}
            </div>
            <p className="muted">
              Reusable envelopes: upload the PDFs once, place fields once, send many times.
              Each unit keeps its own library.
            </p>
          </header>
          {(list || []).length === 0 && (
            <div className="callout">
              <p className="callout__title">No templates yet</p>
              <p>Upload the PDFs for your first reusable agreement packet.</p>
            </div>
          )}
          {(list || []).map(t => {
            const v3 = !!(t.bodyJson && t.bodyJson.schemaVersion === 3)
            const docs = v3 ? (t.bodyJson!.documents || []).length : 0
            const fields = v3 ? (t.bodyJson!.tabs || []).length : 0
            return (
              <div className="env-row" key={t.entryId}>
                <div className="env-row-main">
                  <div className="env-row-title"><b>{t.name}</b> <span className="pill" data-env={t.status || 'Draft'}>{t.status || 'Draft'}</span></div>
                  <div className="env-row-meta">
                    {t.orgName || 'Library'} · {t.category || 'Uncategorized'} · {docs} PDF{docs === 1 ? '' : 's'} · {fields} field{fields === 1 ? '' : 's'}
                    {t.description ? ' · ' + t.description : ''}
                  </div>
                </div>
                <div className="env-row-acts">
                  {canManage && v3 && <button type="button" className="btn btn--ghost btn--sm" onClick={() => startEdit(t)}>Edit</button>}
                  {canManage && v3 && t.entryId && (
                    <Link className="btn btn--ghost btn--sm" to={`/agreements/templates/${encodeURIComponent(t.entryId)}/design`}>
                      Place fields{fields ? ` (${fields})` : ''}
                    </Link>
                  )}
                  {canManage && t.status !== 'Archived' && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => archive(t.entryId)}>Archive</button>
                  )}
                </div>
              </div>
            )
          })}
        </>
      )}
      {editing && (
        <TemplateEditor
          t={editing}
          setT={setEditing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); setNotice('Template saved.') }}
          notify={setNotice}
        />
      )}
    </section>
  )
}

/* "New template" picks the unit library when more than one is visible. */
function NewTemplateButton({
  libraries, onPick,
}: {
  libraries: { orgId: string; orgName: string }[]
  onPick: (orgId: string, orgName: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (libraries.length <= 1) {
    const lib = libraries[0]
    return (
      <button type="button" className="btn" onClick={() => {
        if (lib) onPick(lib.orgId, lib.orgName)
        else alert('No template library is visible to you. An Organization record per unit holds the libraries — ask an admin.')
      }}>+ New template</button>
    )
  }
  return (
    <span style={{ position: 'relative' }}>
      <button type="button" className="btn" onClick={() => setOpen(o => !o)}>+ New template</button>
      {open && (
        <span style={{ position: 'absolute', right: 0, top: '110%', zIndex: 50, display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 8, boxShadow: 'var(--el-16)' }}>
          {libraries.map(l => (
            <button key={l.orgId} type="button" className="btn btn--ghost btn--sm" onClick={() => { setOpen(false); onPick(l.orgId, l.orgName) }}>
              {l.orgName || l.orgId}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

function TemplateEditor({
  t, setT, onCancel, onSaved, notify,
}: {
  t: Editing
  setT: (t: Editing) => void
  onCancel: () => void
  onSaved: () => void
  notify: (m: string) => void
}) {
  const [busy, setBusy] = useState(false)

  function pickPdf() {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'application/pdf'; input.multiple = true
    input.onchange = async () => {
      const files = Array.from(input.files || [])
      let cur = t
      for (const f of files) {
        if (f.size > 25 * 1024 * 1024) { notify(f.name + ' is over the 25 MB limit.'); continue }
        try {
          const b64 = await fileToBase64(f)
          let pages = 0
          try { const pdf = await pdfOpen(URL.createObjectURL(f)); pages = pdf.numPages; try { pdf.destroy() } catch { /* */ } } catch { /* */ }
          const name = f.name.replace(/\.pdf$/i, '')
          const res = await uploadTemplateDoc(name, b64, cur.orgId)
          cur = {
            ...cur,
            bodyJson: {
              ...cur.bodyJson,
              documents: cur.bodyJson.documents.concat([{
                id: 'd' + (cur.bodyJson.documents.length + 1) + '_' + Math.random().toString(36).slice(2, 8),
                name, order: cur.bodyJson.documents.length + 1,
                sourceUrl: res.url, pages, kind: 'pdf',
              }]),
            },
          }
          setT(cur)
        } catch (e) { notify('Upload failed: ' + errMsg(e)) }
      }
    }
    input.click()
  }

  function removeDoc(i: number) {
    // The org-library PDF is left in place: another template version may
    // reference it, and library documents attach by name.
    const docs = t.bodyJson.documents.slice()
    docs.splice(i, 1)
    docs.forEach((d: any, n: number) => { d.order = n + 1 })
    setT({ ...t, bodyJson: { ...t.bodyJson, documents: docs } })
  }

  async function save() {
    if (!t.name.trim()) { notify('Give the template a name.'); return }
    if (!t.bodyJson.documents.length) { notify('Upload at least one PDF.'); return }
    setBusy(true)
    try {
      await saveAgreementTemplate(t.entryId, {
        name: t.name.trim(), description: t.description.trim(),
        category: t.category, status: t.status, bodyJson: t.bodyJson,
      }, t.orgId)
      onSaved()
    } catch (e) {
      setBusy(false)
      notify('Save failed: ' + errMsg(e))
    }
  }

  return (
    <>
      <header className="page__head">
        <p className="eyebrow">{t.orgName || 'Library'}</p>
        <div className="page__headrow">
          <h1>{t.entryId ? 'Edit template' : 'New template'}</h1>
          <span className="env-head-acts">
            {t.entryId && (
              <Link className="btn btn--ghost" to={`/agreements/templates/${encodeURIComponent(t.entryId)}/design`}>
                Place fields{t.bodyJson.tabs.length ? ` (${t.bodyJson.tabs.length})` : ''}
              </Link>
            )}
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="button" className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </span>
        </div>
        {!t.entryId && <p className="muted">Save first, then place fields — the designer needs a saved template to write to.</p>}
      </header>
      <div className="tpl-grid">
        <div className="env-card" style={{ marginTop: 0 }}>
          <div className="agr-field"><label>Name</label>
            <input value={t.name} placeholder="Master Services Agreement" onChange={e => setT({ ...t, name: e.target.value })} /></div>
          <div className="agr-field"><label>Description</label>
            <input value={t.description} placeholder="Short description" onChange={e => setT({ ...t, description: e.target.value })} /></div>
          <div className="agr-field"><label>Category</label>
            <select value={t.category} onChange={e => setT({ ...t, category: e.target.value })}>
              {TPL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select></div>
          <div className="agr-field"><label>Status</label>
            <select value={t.status} onChange={e => setT({ ...t, status: e.target.value })}>
              {TPL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <p className="agr-meta">Only <b>Active</b> templates are offered when sending.</p>
        </div>
        <div className="env-card" style={{ marginTop: 0 }}>
          <div className="env-card-h">Documents</div>
          {t.bodyJson.documents.length === 0 && <p className="agr-meta">No documents yet — upload the PDFs this template sends.</p>}
          {t.bodyJson.documents.map((d: any, i: number) => (
            <div className="env-doc" key={d.id}>
              <canvas className="env-thumb" data-thumb={d.sourceUrl} width={72} height={93} />
              <div className="env-doc-body"><b>{d.name}</b><div className="agr-meta">{d.pages ? d.pages + ' pages' : 'PDF'}</div></div>
              <div className="env-doc-acts">
                <button type="button" className="ico-mini danger" title="Remove" onClick={() => removeDoc(i)}>✕</button>
              </div>
            </div>
          ))}
          <p style={{ margin: '10px 0 0' }}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={pickPdf}>Add PDF</button>
          </p>
        </div>
      </div>
    </>
  )
}
