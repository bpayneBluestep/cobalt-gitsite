import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getEnvelope, saveEnvelopeProgress, signEnvelope, type Envelope,
} from '../agreements/api'
import { svMount, svUnmount } from '../agreements/signview'
import '../agreements/agreements.css'
import '../agreements/signview.css'

/*
 * Full-page in-app signing (/clients/:id/agreements/:entryId/sign/:rid) on the
 * SAME shared signview the anonymous page uses — both "Sign now" and the
 * in-person hand-off land here. The recipient must be kind consultant/inperson;
 * external recipients sign on their emailed link.
 */

export default function EnvelopeSignPage() {
  const { id = '', entryId = '', rid = '' } = useParams()
  const navigate = useNavigate()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [env, setEnv] = useState<Envelope | null>(null)
  const [error, setError] = useState('')

  const back = () => navigate(`/clients/${id}/agreements`)

  useEffect(() => {
    let dead = false
    getEnvelope(id, entryId)
      .then(e => { if (!dead) setEnv(e) })
      .catch(e => { if (!dead) setError(e instanceof Error ? e.message : String(e)) })
    return () => { dead = true; svUnmount() }
  }, [id, entryId])

  useEffect(() => {
    const host = hostRef.current
    if (!env || !host || host.childNodes.length) return
    const me = (env.recipients || []).find(r => r.id === rid)
    if (!me) return
    if (me.status !== 'pending' || !(env.status === 'Sent' || env.status === 'Partially Signed')) return
    svMount({
      container: host,
      env,
      meId: me.id,
      consentLabel: 'I have read the disclosure, adopt this signature, and agree it is legally binding.',
      progress: (me as any).progress || null,
      saveProgress: p => saveEnvelopeProgress(id, entryId, me.id, p.tabValues, p.typedName, p.hasAdopted),
      submit: p => signEnvelope(id, entryId, me.id, p.signatureData, p.typedName, p.tabValues, p.initialsData),
      onDone: res => {
        alert(res && res.completed ? 'Signed — envelope complete. Signed PDFs are on file.' : 'Signed.')
        back()
      },
    })
  }, [env, rid, id, entryId]) // eslint-disable-line react-hooks/exhaustive-deps

  const me = env ? (env.recipients || []).find(r => r.id === rid) : null
  const signable = env && me && me.status === 'pending' && (env.status === 'Sent' || env.status === 'Partially Signed')

  return (
    <section className="page agr">
      <div className="env-signpage-inner">
        <div className="env-signpage-head">
          <button type="button" className="btn btn--ghost btn--sm" onClick={back}>‹ Back</button>
          {env && me && (
            <div className="env-signpage-title">
              <b>{env.title}</b>
              <span className="agr-meta">Signing as {me.name}{me.role ? ' — ' + me.role : ''}</span>
            </div>
          )}
        </div>
        {!env && !error && <p className="empty">Loading…</p>}
        {error && (
          <div className="callout">
            <p className="callout__title">Could not load this signing session</p>
            <p>{error}</p>
          </div>
        )}
        {env && !me && <p className="empty">That recipient is not on this envelope.</p>}
        {env && me && !signable && (
          <p className="empty">
            Nothing to sign — {me.status === 'signed' ? `${me.name} has already signed` : `this envelope is ${env.status}`}.
          </p>
        )}
        {env && env.disclosure && env.disclosure.text && signable && (
          <details className="env-disc">
            <summary>Electronic records &amp; signatures disclosure (version {env.disclosure.version})</summary>
            <pre className="env-disc-text">{env.disclosure.text}</pre>
          </details>
        )}
        <div ref={hostRef} />
      </div>
    </section>
  )
}
