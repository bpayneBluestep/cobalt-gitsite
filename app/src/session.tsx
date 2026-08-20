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
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, getSession, type Capability, type Session } from './api'

interface SessionState {
  session: Session | null
  loading: boolean
  /** Set when the session could not be read at all — not the same as "no access". */
  error: string
  /** True when the failure was "you aren't signed in". */
  needsLogin: boolean
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
}

const EMPTY: SessionState = {
  session: null,
  loading: true,
  error: '',
  needsLogin: false,
  can: () => false,
  roles: [],
}

const Ctx = createContext<SessionState>(EMPTY)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(EMPTY)

  useEffect(() => {
    let alive = true
    getSession()
      .then(session => {
        if (!alive) return
        setState({
          session,
          loading: false,
          error: '',
          needsLogin: !session.loggedIn,
          can: (capability: Capability) => session.can?.[capability] === true,
          roles: session.roles || [],
        })
      })
      .catch((e: unknown) => {
        if (!alive) return
        const err = e instanceof ApiError ? e : null
        setState({
          ...EMPTY,
          loading: false,
          error: err?.message || 'Could not read your session.',
          needsLogin: !!err?.needsLogin,
        })
      })
    return () => {
      alive = false
    }
  }, [])

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>
}

export const useSession = () => useContext(Ctx)
