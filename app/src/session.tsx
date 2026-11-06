/*
 * The caller's identity and capabilities, fetched once and shared.
 *
 * Every screen that hides something asks this rather than reasoning about roles itself.
 * The rules live on the server (`CAPABILITIES` in the Maestro); what arrives here is
 * already resolved to yes/no, so there is no second copy of the matrix to drift.
 *
 * This is presentation, not security. The bundle is public and `/b/maestro` can be called
 * by hand: enforcement is the form ACL on the platform, which the endpoint runs against
 * as the signed-in caller. What this buys is a UI that only offers what will actually
 * work, and says plainly when something is out of reach.
 *
 * It is also the gate: `signedOut` is what makes the whole app show the login screen
 * instead of itself, whether that is true on arrival or becomes true an hour later.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  ApiError, getSession, getSessionRefusal, logout, onSessionLost,
  type Capability, type Session, type SessionRefusal,
} from './api'

interface SessionState {
  session: Session | null
  loading: boolean
  /** Set when the session could not be read at all, not the same as "no access". */
  error: string
  /**
   * True when there is no authenticated session: either there never was one, or it
   * expired mid-use and some later call discovered it.
   */
  signedOut: boolean
  /**
   * Set when the platform's access gate refuses a session that IS signed in: most often a
   * password someone else set, which must be changed before anything works. Takes the
   * place of `signedOut` (which stays false), because the answer is "put this right", not
   * "sign in". Asked of `/gql` only once Cobalt already believes it is signed out.
   */
  refusal: SessionRefusal | null
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
  /** Invalidate the session on the platform, then drop to the gate without a page load. */
  signOut: () => void
  /** Show the refusal gate. What the login gate calls when a sign-in is refused. */
  setRefusal: (refusal: SessionRefusal | null) => void
}

const NO_CAPABILITIES = () => false

const INITIAL: Omit<SessionState, 'reload' | 'signOut' | 'setRefusal'> = {
  session: null,
  loading: true,
  error: '',
  signedOut: false,
  refusal: null,
  can: NO_CAPABILITIES,
  roles: [],
}

const Ctx = createContext<SessionState>({ ...INITIAL, reload: () => {}, signOut: () => {}, setRefusal: () => {} })

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(INITIAL)
  // Bumping this re-runs the probe. Cheaper than duplicating the fetch in a callback,
  // and it keeps every path through "load the session" identical.
  const [attempt, setAttempt] = useState(0)

  const reload = useCallback(() => {
    setState(s => ({ ...s, loading: true, error: '', signedOut: false, refusal: null }))
    setAttempt(n => n + 1)
  }, [])

  const signOut = useCallback(() => {
    // Show the gate as soon as the request settles, whichever way it settled: the user
    // asked to be signed out, and `logout` never rejects.
    logout().then(() => setState({ ...INITIAL, loading: false, signedOut: true }))
  }, [])

  const setRefusal = useCallback((refusal: SessionRefusal | null) => {
    setState(s => ({ ...s, loading: false, refusal, signedOut: refusal ? false : s.signedOut }))
  }, [])

  /*
   * Signed out, or refused? Both look the same to the Maestro. Ask the platform which, and
   * land on the matching gate. Only reached on the signed-out path.
   */
  const settleSignedOut = useCallback(async (isCurrent: () => boolean) => {
    const refusal = await getSessionRefusal()
    if (!isCurrent()) return
    setState({ ...INITIAL, loading: false, signedOut: !refusal, refusal })
  }, [])

  useEffect(() => {
    let alive = true
    getSession()
      .then(session => {
        if (!alive) return
        if (!session.loggedIn) {
          void settleSignedOut(() => alive)
          return
        }
        setState({
          session,
          loading: false,
          error: '',
          signedOut: false,
          refusal: null,
          can: (capability: Capability) => session.can?.[capability] === true,
          roles: session.roles || [],
        })
      })
      .catch((e: unknown) => {
        if (!alive) return
        const err = e instanceof ApiError ? e : null
        if (err?.needsLogin) {
          void settleSignedOut(() => alive)
          return
        }
        setState({
          ...INITIAL,
          loading: false,
          // An auth failure is not an error to report. It is the normal state of a
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
  useEffect(() => {
    let checking = false
    return onSessionLost(() => {
      // Show the gate at once; then, if the platform says the session is refused rather
      // than gone (an admin reset the password mid-use), swap in the refusal gate.
      setState(s => (s.signedOut || s.refusal ? s : { ...INITIAL, loading: false, signedOut: true }))
      if (checking) return
      checking = true
      void getSessionRefusal().then(refusal => {
        checking = false
        if (refusal) setState(s => (s.signedOut ? { ...INITIAL, loading: false, refusal } : s))
      })
    })
  }, [])

  /*
   * Keep the session alive while Cobalt is open, the way every classic BlueStep page does.
   *
   * The platform session is a 60-minute IDLE timeout (Bluestep-Systems/web,
   * application.yml `server.servlet.session.timeout: 60m`). Classic pages survive all day
   * because common_js.jsp loops `fetch("/keep-alive")` at 90% of that interval for as long
   * as the tab is open. This SPA talks to the server only when you click, so a tab left
   * alone for an hour came back signed out. Same endpoint, same behaviour, here.
   *
   * Every 15 minutes rather than at 54: a background tab's timers get throttled and
   * delayed, and missing one ping by a few minutes must not cost the session. Also pinged
   * the moment the tab becomes visible again, which covers a long-throttled tab as long as
   * the hour has not already run out (a laptop asleep for more than an hour still ends it).
   * Only while signed in: a ping on a dead session would just mint an anonymous one.
   */
  const signedIn = !!state.session && !state.signedOut && !state.refusal
  useEffect(() => {
    if (!signedIn) return
    const ping = () => { fetch('/keep-alive', { credentials: 'same-origin', cache: 'no-store' }).catch(() => {}) }
    const timer = window.setInterval(ping, 15 * 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') ping() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [signedIn])

  return <Ctx.Provider value={{ ...state, reload, signOut, setRefusal }}>{children}</Ctx.Provider>
}

export const useSession = () => useContext(Ctx)
