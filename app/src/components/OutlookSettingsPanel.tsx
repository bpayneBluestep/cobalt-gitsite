import { useCallback, useEffect, useState } from 'react'
import {
  ApiError, getOutlookSettings, saveOutlookSettings,
  type OutlookSettings, type OutlookSettingsList,
} from '../api'

/*
 * Settings → Outlook.
 *
 * One card per unit. Each unit registers its OWN Microsoft Entra app, so a second
 * organisation running Cobalt plugs in its own client id, secret and tenant without
 * sharing a tenant with Behavioral and without anyone touching the endpoint.
 *
 * THE SECRET IS WRITE-ONLY. The endpoint never sends it back, so there is nothing to
 * prefill the box with and nothing to render by accident. That makes the empty box
 * ambiguous in a way worth resolving out loud rather than in a tooltip: leaving it empty
 * KEEPS whatever is stored. Removing a stored secret is a separate, explicit button, so
 * it can never happen by tabbing past a field.
 *
 * The redirect URI is the one value Microsoft compares character for character against
 * what is registered in the app, so it gets its own copy button at the top rather than
 * being left to be retyped from a form field. A typo there fails at the very end of the
 * OAuth round trip, which is the worst possible place to discover one.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: OutlookSettingsList }
  | { phase: 'error'; error: ApiError }

interface Draft {
  azureClientId: string
  azureClientSecret: string
  azureTenant: string
  azureRedirectUri: string
  azureScope: string
  outlookConnectEnabled: boolean
  outlookNotes: string
}

function draftOf(r: OutlookSettings): Draft {
  return {
    azureClientId: r.azureClientId || '',
    // Always blank: there is no stored value to show, by design.
    azureClientSecret: '',
    azureTenant: r.azureTenant || '',
    azureRedirectUri: r.azureRedirectUri || '',
    azureScope: r.azureScope || '',
    outlookConnectEnabled: !!r.outlookConnectEnabled,
    outlookNotes: r.outlookNotes || '',
  }
}

/** Copy to clipboard, degrading to a select-and-copy prompt where it is unavailable. */
function useCopy(): [string, (text: string, label: string) => void] {
  const [copied, setCopied] = useState('')
  const copy = (text: string, label: string) => {
    const done = () => { setCopied(label); window.setTimeout(() => setCopied(''), 2000) }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => setCopied(''))
    } else {
      done()
    }
  }
  return [copied, copy]
}

export default function OutlookSettingsPanel() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [copied, copy] = useCopy()

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getOutlookSettings()
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load() }, [load])

  const d = state.phase === 'ready' ? state.data : null

  function begin(row: OutlookSettings) {
    setEditing(row.orgId)
    setNotice(''); setFailure('')
    const base = draftOf(row)
    // Prefill the three boxes that have a right answer, but only when they are EMPTY:
    // a stored value the user chose always wins over a suggestion.
    if (d) {
      if (!base.azureTenant) base.azureTenant = d.defaults.azureTenant
      if (!base.azureRedirectUri) base.azureRedirectUri = d.defaults.azureRedirectUri
      if (!base.azureScope) base.azureScope = d.defaults.azureScope
    }
    setDraft(base)
  }

  function save(row: OutlookSettings) {
    if (!draft || busy) return
    setBusy('save'); setNotice(''); setFailure('')
    const { azureClientSecret, ...rest } = draft
    saveOutlookSettings(row.orgId, {
      ...rest,
      // Sent only when something was typed. Empty means "leave the stored one alone",
      // and the endpoint enforces the same rule rather than trusting this.
      ...(azureClientSecret.trim() ? { azureClientSecret: azureClientSecret.trim() } : {}),
    })
      .then(res => {
        setNotice(
          `${res.org} saved.` +
          (azureClientSecret.trim() ? ' The client secret was replaced.' : '') +
          (res.settings.configured ? '' : ` Still missing: ${res.settings.missing.join(', ')}.`),
        )
        setEditing(null); setDraft(null)
        load()
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  function clearSecret(row: OutlookSettings) {
    if (busy) return
    if (!window.confirm(
      `Remove the stored client secret for ${row.orgName}?\n\n` +
      'Connecting an inbox will stop working for this unit until a new one is saved.',
    )) return
    setBusy('clear'); setNotice(''); setFailure('')
    saveOutlookSettings(row.orgId, { outlookConnectEnabled: false }, true)
      .then(res => {
        setNotice(`The client secret for ${res.org} was removed and connecting was turned off.`)
        setEditing(null); setDraft(null)
        load()
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  const set = (k: keyof Draft, v: string | boolean) =>
    setDraft(prev => (prev ? { ...prev, [k]: v } : prev))

  return (
    <>
      {state.phase === 'loading' && <p className="empty">Loading Outlook settings…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">Could not load Outlook settings</p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            <button type="button" className="btn" onClick={load}>Try again</button>
          </p>
        </div>
      )}

      {d && (
        <>
          <div className="callout">
            <p className="callout__title">Redirect URI</p>
            <p>
              Register this exact string in the Entra app under
              {' '}<strong>Authentication → Web → Redirect URIs</strong>. Microsoft compares
              it character for character, so copy it rather than retyping it.
            </p>
            <p>
              <code className="db">{d.redirectUri}</code>
            </p>
            <p className="callout__actions">
              <button type="button" className="btn btn--sm"
                onClick={() => copy(d.redirectUri, 'redirect')}>
                {copied === 'redirect' ? 'Copied' : 'Copy redirect URI'}
              </button>
            </p>
          </div>

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {d.rows.length === 0 && (
            <p className="empty">
              No organization record is visible. There should be one per unit.
            </p>
          )}

          {d.rows.map(row => {
            const open = editing === row.orgId
            return (
              <div className="editcard" key={row.orgId}>
                <div className="editcard__head">
                  <h2>
                    {row.orgName}
                    {row.configured
                      ? <span className="tag">configured</span>
                      : <span className="tag tag--warn">not set up</span>}
                    {row.outlookConnectEnabled && <span className="tag">connecting on</span>}
                  </h2>
                  <p className="note">
                    {row.unit ? `Unit: ${row.unit.name}. ` : ''}
                    {row.configured
                      ? 'This unit has its own Entra app registered.'
                      : `Still needed: ${row.missing.join(', ')}.`}
                  </p>
                  {row.readError && (
                    <p className="editcard__err" role="alert">
                      The settings form could not be read: {row.readError}
                    </p>
                  )}
                </div>

                {!open && (
                  <>
                    <dl className="facts">
                      <div>
                        <dt>Client id</dt>
                        <dd>{row.azureClientId
                          ? <code className="db">{row.azureClientId}</code>
                          : <span className="muted">not set</span>}</dd>
                      </div>
                      <div>
                        <dt>Client secret</dt>
                        <dd>{row.secretSet
                          ? <span className="muted">stored, never shown</span>
                          : <span className="muted">not set</span>}</dd>
                      </div>
                      <div>
                        <dt>Tenant</dt>
                        <dd>{row.azureTenant || <span className="muted">not set</span>}</dd>
                      </div>
                      <div>
                        <dt>Redirect URI</dt>
                        <dd>{row.azureRedirectUri
                          ? <code className="db">{row.azureRedirectUri}</code>
                          : <span className="muted">not set</span>}</dd>
                      </div>
                      <div>
                        <dt>Scope</dt>
                        <dd>{row.azureScope || <span className="muted">not set</span>}</dd>
                      </div>
                      <div>
                        <dt>Connecting</dt>
                        <dd>{row.outlookConnectEnabled ? 'On' : 'Off'}</dd>
                      </div>
                      {row.outlookNotes && (
                        <div>
                          <dt>Notes</dt>
                          <dd>{row.outlookNotes}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="editcard__foot">
                      {row.secretSet && (
                        <button type="button" className="linkbtn" disabled={!!busy}
                          onClick={() => clearSecret(row)}>
                          Remove stored secret
                        </button>
                      )}
                      <button type="button" className="btn" disabled={!!busy}
                        onClick={() => begin(row)}>
                        Edit
                      </button>
                    </div>
                  </>
                )}

                {open && draft && (
                  <>
                    <div className="efgrid">
                      <div className="ef">
                        <label htmlFor={`o-id-${row.orgId}`}>Application (client) id</label>
                        <input id={`o-id-${row.orgId}`} type="text" autoComplete="off"
                          value={draft.azureClientId}
                          onChange={e => set('azureClientId', e.target.value)} />
                        <p className="ef__hint">
                          From the app's Overview page. A GUID.
                        </p>
                      </div>

                      <div className="ef">
                        <label htmlFor={`o-sec-${row.orgId}`}>Client secret</label>
                        <input id={`o-sec-${row.orgId}`} type="password" autoComplete="new-password"
                          value={draft.azureClientSecret}
                          placeholder={row.secretSet ? 'Stored. Type to replace it.' : 'Not set yet'}
                          onChange={e => set('azureClientSecret', e.target.value)} />
                        <p className="ef__hint">
                          {row.secretSet
                            ? 'Leaving this empty keeps the stored secret. It is never sent back to this page.'
                            : 'The secret VALUE, not the secret id. Azure only shows it once, right after you create it.'}
                        </p>
                      </div>

                      <div className="ef">
                        <label htmlFor={`o-ten-${row.orgId}`}>Tenant</label>
                        <input id={`o-ten-${row.orgId}`} type="text" autoComplete="off"
                          value={draft.azureTenant}
                          onChange={e => set('azureTenant', e.target.value)} />
                        <p className="ef__hint">
                          A tenant id, a domain, or <code>common</code> for any work account.
                        </p>
                      </div>

                      <div className="ef ef--wide">
                        <label htmlFor={`o-red-${row.orgId}`}>Redirect URI</label>
                        <input id={`o-red-${row.orgId}`} type="text" autoComplete="off"
                          value={draft.azureRedirectUri}
                          onChange={e => set('azureRedirectUri', e.target.value)} />
                        <p className="ef__hint">
                          Has to match the app registration exactly. Suggested:
                          {' '}<code>{d.defaults.azureRedirectUri}</code>
                        </p>
                      </div>

                      <div className="ef ef--wide">
                        <label htmlFor={`o-sco-${row.orgId}`}>Scope</label>
                        <input id={`o-sco-${row.orgId}`} type="text" autoComplete="off"
                          value={draft.azureScope}
                          onChange={e => set('azureScope', e.target.value)} />
                        <p className="ef__hint">
                          Space separated. <code>offline_access</code> is what earns a refresh
                          token: without it the connection dies in about an hour.
                        </p>
                      </div>

                      <div className="ef ef--wide">
                        <label className="checkline">
                          <input type="checkbox" checked={draft.outlookConnectEnabled}
                            onChange={e => set('outlookConnectEnabled', e.target.checked)} />
                          <span>Let people connect their inbox for this unit</span>
                        </label>
                        <p className="ef__hint">
                          Off until the app is registered and tested. Nothing sends mail while
                          this is off.
                        </p>
                      </div>

                      <div className="ef ef--wide">
                        <label htmlFor={`o-not-${row.orgId}`}>Notes</label>
                        <textarea id={`o-not-${row.orgId}`} rows={2}
                          value={draft.outlookNotes}
                          onChange={e => set('outlookNotes', e.target.value)} />
                        <p className="ef__hint">
                          Who owns the app registration, and when the secret expires.
                        </p>
                      </div>
                    </div>

                    <div className="editcard__foot">
                      <span className="editcard__status">{busy === 'save' ? 'Saving…' : ''}</span>
                      <button type="button" className="btn btn--ghost" disabled={!!busy}
                        onClick={() => { setEditing(null); setDraft(null) }}>
                        Cancel
                      </button>
                      <button type="button" className="btn" disabled={!!busy}
                        onClick={() => save(row)}>
                        Save settings
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          })}

          <p className="panel__foot">
            Each unit registers its own app in its own Microsoft tenant, so nothing here is
            shared between units and a second organisation can plug in its own without
            code changes. The client secret is stored on the unit's Organization record and
            is never sent back to this page: replacing one is a write with no matching read.
          </p>
        </>
      )}
    </>
  )
}
