import { useState, type FormEvent } from 'react'
import { canChangePasswordInApp, changeExpiredPassword, type SessionRefusal } from '../api'
import ThemeToggle from '../components/ThemeToggle'
import { sanitizeHtml } from '../lib/html'
import { useSession } from '../session'

/*
 * The screen for a session the platform's access gate refuses: signed in, but not usable
 * until something is put right. Same card as the sign-in screen, because it sits in the
 * same place in the flow, and nothing else in Cobalt renders while it is up.
 *
 * Most often this is a forced password change. Whenever someone other than you sets your
 * password (an admin reset, a script), the platform sets Password Expire Start on your
 * Online Profile, and once that passes it refuses everything but your profile page until
 * you choose a new one. Classic pages send you to that page. Here you set it in place:
 * `changeExpiredPassword` posts the platform's own profile form, then re-probes.
 *
 * Three variants, picked from the refusal:
 *
 *   form      a tenant user's forced change: new password + confirm, saved in place
 *   handoff   anything the platform has to finish on its own page (a global account's
 *             profile, e-mail confirmation, or an in-place save that could not be driven)
 *   message   a refusal nobody can fix from here (org locked, address not allowed, the
 *             gate unavailable): the platform's words and a way out
 */

const HANDOFF_COPY: Record<string, { title: string; lede: string; go: string }> = {
  PASSWORD_CHANGE_REQUIRED: {
    title: 'Set a new password',
    lede: 'Your password was set by someone else, so BlueStep needs you to choose your own before you carry on. Your profile page opens to do it.',
    go: 'Open my profile',
  },
  EMAIL_CONFIRMATION_REQUIRED: {
    title: 'Confirm your e-mail address',
    lede: 'BlueStep needs you to confirm your e-mail address before you carry on. The confirmation page opens to do it.',
    go: 'Confirm my e-mail',
  },
}

export default function RefusalGate({ refusal }: { refusal: SessionRefusal }) {
  const { reload, signOut } = useSession()
  // Once an in-place save proves impossible, stay on the hand-off for this refusal.
  const [handoffError, setHandoffError] = useState('')
  const inApp = canChangePasswordInApp(refusal) && !handoffError

  let body
  if (refusal.kind === 'CREDENTIAL' && inApp) {
    body = <PasswordForm refusal={refusal} onDone={reload} onCannot={setHandoffError} onLost={signOut} />
  } else if (refusal.kind === 'CREDENTIAL' && refusal.fixUrl) {
    const copy = HANDOFF_COPY[refusal.reason] || {
      title: 'Your account needs attention',
      lede: refusal.message,
      go: 'Continue',
    }
    body = (
      <>
        <h1 className="login__title">{copy.title}</h1>
        <p className="login__lede">{copy.lede}</p>
        {handoffError && (
          <p className="login__err" role="alert">
            {handoffError} Use your profile page instead.
          </p>
        )}
        <a className="btn login__go refusal__go" href={refusal.fixUrl}>{copy.go}</a>
        <p className="refusal__hint">
          When you are done there, come back to {window.location.host} and you will be signed in.
        </p>
      </>
    )
  } else {
    const title =
      refusal.reason === 'ORGANIZATION_LOCKED' ? 'This organization is locked'
      : refusal.kind === 'PLACE' ? 'Not available from here'
      : refusal.kind === 'UNAVAILABLE' ? 'BlueStep could not check your access'
      : 'Your account needs attention'
    body = (
      <>
        <h1 className="login__title">{title}</h1>
        {/* The org lock message is the organization's own HTML: sanitised, never raw. */}
        <div className="login__blocked" role="alert">
          <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(refusal.message || 'Your session cannot be used right now.') }} />
        </div>
        {refusal.kind === 'UNAVAILABLE' && (
          <button className="btn login__go" type="button" onClick={reload}>Try again</button>
        )}
      </>
    )
  }

  return (
    <div className="login">
      <div className="login__toggle">
        <ThemeToggle />
      </div>

      <main className="login__card">
        <div className="login__brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="login__name">Cobalt</span>
          <span className="login__sub">ERP</span>
        </div>

        {body}

        <p className="login__alt">
          <button className="refusal__signout" type="button" onClick={signOut}>Sign out</button>
        </p>
      </main>
    </div>
  )
}

function PasswordForm({ refusal, onDone, onCannot, onLost }: {
  refusal: SessionRefusal
  onDone: () => void
  onCannot: (error: string) => void
  onLost: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setError('')
    if (!password) { setError('Enter a new password.'); return }
    if (password !== confirm) { setError('The two passwords do not match.'); return }

    setBusy(true)
    const result = await changeExpiredPassword(refusal.fixUrl!, password)
    if (result.ok) {
      // Stay busy: the session reloads and this whole screen is replaced.
      onDone()
      return
    }
    setBusy(false)
    if (result.reason === 'invalid') {
      setError(result.error)
    } else if (result.reason === 'sessionLost') {
      onLost()
    } else {
      onCannot(result.error)
    }
  }

  return (
    <>
      <h1 className="login__title">Set a new password</h1>
      <p className="login__lede">
        Your password was set by someone else, so BlueStep needs you to choose your own
        before you carry on.
      </p>

      {error && <p className="login__err" role="alert">{error}</p>}

      <form className="login__form" onSubmit={submit} noValidate>
        <label className="login__field">
          <span>New password</span>
          <input
            type="password"
            name="new-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            disabled={busy}
            onChange={e => setPassword(e.target.value)}
          />
        </label>

        <label className="login__field">
          <span>Re-type new password</span>
          <input
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            disabled={busy}
            onChange={e => setConfirm(e.target.value)}
          />
        </label>

        <p className="refusal__hint">
          Make it long or hard to guess; BlueStep refuses weak and commonly leaked passwords.
          If you sign in with Microsoft or Google, you can keep doing that afterwards.
        </p>

        <button className="btn login__go" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>
      </form>

      <p className="login__alt">
        <a href={refusal.fixUrl!}>Use my profile page instead</a>
      </p>
    </>
  )
}
