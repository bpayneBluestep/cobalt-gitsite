/*
 * The caller's identity and capabilities, fetched once and shared.
 *
 * Every screen that hides something asks this rather than reasoning about roles itself.
 * The rules live on the server (`CAPABILITIES` in the Maestro); what arrives here is
 * already resolved to yes/no, so there is no second copy of the matrix to drift.
 *
 * This is presentation, not security. The bundle is public and `/b/maestro` can be called
 * by hand — enforcement is the form ACL on the platform, which the endpoint runs against
 * as the signed-in caller. What this buys is a UI that only offers what will actually
 * work, and says plainly when something is out of reach.
 *
 * It is also the gate: `signedOut` is what makes the whole app show the login screen
 * instead of itself, whether that is true on arrival or becomes true an hour later.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, getSession, onSessionLost, type Capability, type Session } from './api'

interface SessionState {
  session: Session | null
  loading: boolean
  /** Set when the session could not be read at all — not the same as "no access". */
  error: string
  /**
   * True when there is no authenticated session: either there never was one, or it
   * expired mid-use and some later call discovered it.
   */
  signedOut: boolean
  /**
   * Whether the caller holds a capability.
   *
   * False while loading and false on error, so nothing is ever offered on a guess. The
   * cost is a moment where the nav is empty; the alternative is a flash of controls that
   * vanish, which reads as a bug and invites a click that fails.
   */
  can: (capability: Capability) => boolean
  /** Every role the caller holds, for the places that name them rather than gate on them. */
  roles: string[]
  /** Re-probe the session. What the login gate calls once it has signed someone in. */
  reload: () => void
}

const NO_CAPABILITIES = () => false

const INITIAL: Omit<SessionState, 'reload'> = {
  session: null,
  loading: true,
  error: '',
  signedOut: false,
  can: NO_CAPABILITIES,
  roles: [],
}

const Ctx = createContext<SessionState>({ ...INITIAL, reload: () => {} })

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(INITIAL)
  // Bumping this re-runs the probe. Cheaper than duplicating the fetch in a callback,
  // and it keeps every path through "load the session" identical.
  const [attempt, setAttempt] = useState(0)

  const reload = useCallback(() => {
    setState(s => ({ ...s, loading: true, error: '', signedOut: false }))
    setAttempt(n => n + 1)
  }, [])

  useEffect(() => {
    let alive = true
    getSession()
      .then(session => {
        if (!alive) return
        setState({
          session,
          loading: false,
          error: '',
          signedOut: !session.loggedIn,
          can: (capability: Capability) => session.can?.[capability] === true,
          roles: session.roles || [],
        })
      })
      .catch((e: unknown) => {
        if (!alive) return
        const err = e instanceof ApiError ? e : null
        setState({
          ...INITIAL,
          loading: false,
          // An auth failure is not an error to report — it is the normal state of a
          // visitor who has not signed in, and it gets the gate rather than a message.
          error: err?.needsLogin ? '' : err?.message || 'Could not read your session.',
          signedOut: !!err?.needsLogin,
        })
      })
    return () => {
      alive = false
    }
  }, [attempt])

  /*
   * A session can die at any moment, and the call that discovers it is whichever one the
   * user happened to make. `api` announces it from the single funnel every response passes
   * through; this turns that into the gate, so an expired session behaves the same as
   * arriving signed out instead of surfacing as a random failed panel.
   */
  useEffect(() => onSessionLost(() => {
    setState(s => (s.signedOut ? s : { ...INITIAL, loading: false, signedOut: true }))
  }), [])

  return <Ctx.Provider value={{ ...state, reload }}>{children}</Ctx.Provider>
}

export const useSession = () => useContext(Ctx)
