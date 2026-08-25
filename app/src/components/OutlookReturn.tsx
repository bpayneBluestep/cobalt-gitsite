import { useEffect, useState } from 'react'

/*
 * The tail end of the Outlook round trip.
 *
 * `/b/outlookToken` finishes by redirecting the browser back into the app with
 * `?outlook=ok` or `?outlook=error&reason=<slug>`. Without something reading that, a
 * successful connection looks exactly like a page that reloaded for no reason, and a
 * failed one looks the same — which is the worst version, because the token silently
 * is not there.
 *
 * The marker is stripped from the URL as soon as it is read, so a refresh or a shared
 * link does not re-announce a connection that happened ten minutes ago.
 *
 * Reason slugs come from Microsoft (`invalid_client`, `invalid_grant`) or from the
 * callback itself (`state_expired`, `no_refresh_token`). They are translated here
 * rather than shown raw: `AADSTS`-flavoured text is not an answer to "what do I do now".
 */

const REASONS: Record<string, string> = {
  not_signed_in:
    'Your BlueStep session had expired by the time Microsoft sent you back. Sign in and try again.',
  no_connection_form:
    'Your record has no Outlook Connection form, so there was nowhere to store the token.',
  no_code: 'Microsoft sent you back without an authorization code.',
  state_mismatch:
    'That sign-in did not match one this app started. Begin again from Connect Outlook.',
  state_expired:
    'The connection took too long and expired. It only stays open for ten minutes.',
  no_app_settings: "Your unit's Microsoft app is not set up yet.",
  no_client_secret: "Your unit's app has no client secret saved.",
  connecting_disabled: 'Connecting is turned off for your unit.',
  no_refresh_token:
    'Microsoft did not return a refresh token, which means offline_access was not among ' +
    'the approved scopes. The connection would have died within the hour, so it was not kept.',
  invalid_client:
    'Microsoft rejected the client id or secret. Check them in Settings → Outlook.',
  invalid_grant:
    'The authorization code was already used or had expired. Try connecting again.',
  redirect_uri_mismatch:
    'The redirect URI does not match the one registered in the Entra app. They have to be ' +
    'identical, character for character.',
  invalid_request:
    'Microsoft rejected the request. The redirect URI or scope is usually the cause.',
  unauthorized_client: 'The app registration is not allowed to use this flow.',
  access_denied: 'Consent was declined, so nothing was connected.',
  bad_json: 'Microsoft returned something this could not read.',
  unexpected: 'Something went wrong finishing the connection.',
}

function explain(reason: string): string {
  if (!reason) return 'Something went wrong finishing the connection.'
  if (REASONS[reason]) return REASONS[reason]
  if (reason.indexOf('unreachable') === 0) {
    return 'Microsoft could not be reached from the server. Try again in a moment.'
  }
  if (reason.indexOf('http_') === 0) {
    return `Microsoft returned an unexpected ${reason.slice(5)} response.`
  }
  return `Microsoft reported: ${reason}`
}

type Result = { ok: true } | { ok: false; message: string } | null

export default function OutlookReturn() {
  const [result, setResult] = useState<Result>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('outlook')
    if (!outcome) return

    setResult(outcome === 'ok'
      ? { ok: true }
      : { ok: false, message: explain(params.get('reason') || '') })

    // Strip the marker so this announces itself exactly once. replaceState rather than
    // a navigation: the route the callback landed on is where the person should stay.
    params.delete('outlook')
    params.delete('reason')
    const qs = params.toString()
    window.history.replaceState(
      {}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
    )
  }, [])

  if (!result) return null

  return (
    <div className={'oreturn' + (result.ok ? '' : ' oreturn--bad')} role="status">
      <p className="oreturn__text">
        {result.ok
          ? 'Outlook connected. Cobalt can now send mail as you.'
          : `Outlook not connected. ${result.message}`}
      </p>
      <button type="button" className="oreturn__x" onClick={() => setResult(null)}
        aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
