import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  generateClientAccess,
  getClientAccess,
  revokeClientAccess,
  type ClientAccessSecret,
  type ClientAccessState,
} from '../api'
import { useSession } from '../session'

/*
 * Client site access, at the bottom of a client's Info tab.
 *
 * Whether this client can read its own open tickets from its own BlueStep site, through
 * the public /b/clientTickets endpoint. The site sends a Cobalt Program ID (this Company's
 * id) and a secret; the Maestro stores only the secret's hash.
 *
 * So the secret exists in exactly one place: the generate response, shown once in the
 * dialog below, held only in this component's state and dropped when the dialog closes.
 *
 * Everyone who can see the board sees the status line. The buttons need
 * `manageClientAccess`; the endpoint refuses the writes without it regardless.
 */

type Load =
  | { phase: 'loading' }
  | { phase: 'ready'; access: ClientAccessState }
  | { phase: 'error'; message: string }

type Pending = 'regenerate' | 'off' | null

const asMessage = (e: unknown, fallback: string) =>
  (e instanceof ApiError ? e.message : fallback)

/** "Nov 9, 2026, 2:14 PM", or the raw value if it doesn't parse. */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function ClientAccessPanel({ companyId }: { companyId: string }) {
  const { can } = useSession()
  const mayManage = can('manageClientAccess')

  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [reveal, setReveal] = useState<ClientAccessSecret | null>(null)

  const refresh = useCallback(() => {
    getClientAccess(companyId)
      .then(access => setLoad({ phase: 'ready', access }))
      .catch(e => setLoad({ phase: 'error', message: asMessage(e, 'Could not read client site access.') }))
  }, [companyId])

  useEffect(() => {
    setLoad({ phase: 'loading' })
    setReveal(null)
    refresh()
  }, [refresh])

  const generate = () => {
    if (busy) return
    setBusy(true); setFailure('')
    generateClientAccess(companyId)
      .then(result => {
        setPending(null)
        setReveal(result)
        refresh()
      })
      .catch(e => setFailure(asMessage(e, 'Could not generate a secret.')))
      .finally(() => setBusy(false))
  }

  const turnOff = () => {
    if (busy) return
    setBusy(true); setFailure('')
    revokeClientAccess(companyId)
      .then(() => { setPending(null); refresh() })
      .catch(e => setFailure(asMessage(e, 'Could not turn off client site access.')))
      .finally(() => setBusy(false))
  }

  const closeConfirm = () => {
    if (busy) return
    setPending(null); setFailure('')
  }

  // Dropping the object is the whole of "the secret is not kept".
  const closeReveal = () => setReveal(null)

  return (
    <section className="panel caccess" aria-labelledby="caccess-h">
      <div className="caccess__row">
        <div className="caccess__text">
          <h2 id="caccess-h" className="caccess__title">Client site access</h2>

          {load.phase === 'loading' && <p className="caccess__status">Checking…</p>}

          {load.phase === 'error' && (
            <p className="caccess__status caccess__status--bad">
              {load.message}{' '}
              <button type="button" className="linkbtn" onClick={() => { setLoad({ phase: 'loading' }); refresh() }}>
                Try again
              </button>
            </p>
          )}

          {load.phase === 'ready' && !load.access.enabled && (
            <p className="caccess__status">
              Not set up. Generate a secret to let this client see their open tickets on their own
              BlueStep site.
            </p>
          )}

          {load.phase === 'ready' && load.access.enabled && (
            <p className="caccess__status">
              <span className="caccess__dot" aria-hidden="true" />
              On since {formatWhen(load.access.setAt) || 'an unknown date'}
              {load.access.setBy && <> · set by {load.access.setBy}</>}
            </p>
          )}

          {failure && !pending && <p className="caccess__status caccess__status--bad" role="alert">{failure}</p>}
        </div>

        {mayManage && load.phase === 'ready' && (
          <div className="caccess__actions">
            {load.access.enabled ? (
              <>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setFailure(''); setPending('regenerate') }}>
                  Regenerate
                </button>
                <button type="button" className="btn btn--ghost btn--sm btn--del" onClick={() => { setFailure(''); setPending('off') }}>
                  Turn off
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--sm" onClick={generate} disabled={busy}>
                {busy ? 'Generating…' : 'Generate secret'}
              </button>
            )}
          </div>
        )}
      </div>

      {pending && (
        <div className="confirm-back" onMouseDown={e => { if (e.target === e.currentTarget) closeConfirm() }}>
          <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="caccess-confirm-h">
            <h2 id="caccess-confirm-h">
              {pending === 'regenerate' ? 'Regenerate the secret?' : 'Turn off client site access?'}
            </h2>
            <p>
              The client&apos;s current secret stops working right away
              {pending === 'regenerate'
                ? ', so their site shows no tickets until the new one is pasted into their Cobalt Access form.'
                : ', and their site stops showing their open tickets.'}
            </p>
            <div className="confirm__foot">
              <span className="confirm__status">{failure}</span>
              <button type="button" className="btn btn--ghost" onClick={closeConfirm} disabled={busy}>
                Cancel
              </button>
              {pending === 'regenerate' ? (
                <button type="button" className="btn" onClick={generate} disabled={busy} autoFocus>
                  {busy ? 'Regenerating…' : 'Regenerate'}
                </button>
              ) : (
                <button type="button" className="btn btn--danger" onClick={turnOff} disabled={busy} autoFocus>
                  {busy ? 'Turning off…' : 'Turn off'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {reveal && (
        <div className="confirm-back">
          <div className="confirm caccess-reveal" role="dialog" aria-modal="true" aria-labelledby="caccess-reveal-h">
            <h2 id="caccess-reveal-h">Client site access is on</h2>
            <p>
              Paste both into the Cobalt Access form on the client&apos;s top-level Facility record.
              This secret won&apos;t be shown again.
            </p>
            <SecretValue label="Cobalt Program ID" value={reveal.programId} />
            <SecretValue label="Secret" value={reveal.secret} />
            <div className="confirm__foot">
              <button type="button" className="btn" onClick={closeReveal} autoFocus>Done</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/** One labelled, selectable, monospace value with its own Copy button. */
function SecretValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    if (!navigator.clipboard?.writeText) return
    navigator.clipboard.writeText(value).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) },
      () => setCopied(false),
    )
  }

  return (
    <div className="caccess-reveal__field">
      <span className="confirm__label">{label}</span>
      <div className="caccess-reveal__value">
        <code>{value}</code>
        <button type="button" className="btn btn--ghost btn--sm" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
