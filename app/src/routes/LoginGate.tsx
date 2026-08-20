import { useState, type FormEvent } from 'react'
import { globalLoginUrl, login, nativeLoginSubmit, ssoLoginUrl } from '../api'
import ThemeToggle from '../components/ThemeToggle'

/*
 * The sign-in screen. Nothing else in Cobalt renders until this succeeds.
 *
 * Ported from the Program Portal's gate, with the same mechanism — a same-origin form
 * POST to the platform's login handler, then an authoritative re-probe of the session —
 * and three things it did not have:
 *
 *   1. Microsoft and Google. The platform's own login page offers them; a gate that
 *      omitted them would just be a slower route to the same page. They are full-page
 *      redirects to the OAuth broker, because that is what an external identity provider
 *      requires — there is no in-page version of it.
 *   2. A working sign-out. The reference used `/shared/login/logout`, which 404s.
 *   3. The theme toggle, so the first screen is not the one place the app ignores it.
 *
 * The password is posted to this same BlueStep host and nowhere else. It is not sent to
 * the Maestro, not logged, and not held after the request — the two `useState` values are
 * gone with the component.
 */

/** The provider buttons, so the markup below stays one loop rather than two copies. */
const PROVIDERS = [
  { id: 'microsoft', label: 'Microsoft', favicon: 'https://www.microsoft.com/favicon.ico' },
  { id: 'google', label: 'Google', favicon: 'https://www.google.com/favicon.ico' },
] as const

export default function LoginGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /*
   * Kept apart from `error` because it is not a form error and retrying cannot clear it:
   * the credentials were right, and the account simply has no way into this app. Showing
   * it in the red "check your typing" slot would send someone hunting for a typo that
   * isn't there — which is exactly what happened before this existed.
   */
  const [blocked, setBlocked] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setError('')
    if (!username.trim() || !password) {
      setError('Enter your username and password.')
      return
    }

    setBlocked('')
    setBusy(true)
    const result = await login(username.trim(), password)

    if (result.ok) {
      // Stay busy: the parent is about to replace this whole screen, and flipping the
      // button back to "Sign in" first would read as though nothing happened.
      onAuthenticated()
      return
    }

    if (result.reason === 'twoFactor') {
      // A global account needs the platform's e-mail verification step, which cannot be
      // completed inside a fetch. Hand the browser over; it comes back here after.
      nativeLoginSubmit(username.trim(), password)
      return
    }

    if (result.reason === 'noAccess') setBlocked(result.error)
    else setError(result.error)
    setBusy(false)
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

        <h1 className="login__title">Sign in</h1>
        <p className="login__lede">
          Cobalt reads live BlueStep data, so everything here is behind your account.
        </p>

        {/* Assertive rather than polite: the user is waiting on this answer and has
            nothing else to attend to. */}
        {error && <p className="login__err" role="alert">{error}</p>}

        {blocked && (
          <div className="login__blocked" role="alert">
            <p className="login__blockedhead">Signed in, but not to Cobalt</p>
            <p>{blocked}</p>
          </div>
        )}

        <form className="login__form" onSubmit={submit} noValidate>
          <label className="login__field">
            <span>Username</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={username}
              disabled={busy}
              onChange={e => setUsername(e.target.value)}
            />
          </label>

          <label className="login__field">
            <span>Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={e => setPassword(e.target.value)}
            />
          </label>

          <button className="btn login__go" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="login__or"><span>or</span></div>

        <div className="login__sso">
          {PROVIDERS.map(p => (
            <a className="login__provider" key={p.id} href={ssoLoginUrl(p.id)}>
              {/* The provider's own favicon, which is what the platform's login page
                  uses. Decorative — the label already names it. */}
              <img src={p.favicon} alt="" width={16} height={16} />
              <span>Continue with {p.label}</span>
            </a>
          ))}
        </div>

        <p className="login__alt">
          <a href={globalLoginUrl()}>Sign in with a global account</a>
        </p>

        <p className="login__legal">
          Your password goes to this BlueStep host over a secure connection and nowhere
          else.
        </p>
      </main>
    </div>
  )
}
