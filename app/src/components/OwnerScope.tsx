import { useCallback, useEffect, useState } from 'react'
import { useSession } from '../session'
import {
  getScope, isMine, scopeToOwnerId, setScope, subscribeScope,
  type Scope, type ScopeStore,
} from '../lib/scope'
import { loadUsers } from './UserPicker'
import type { User } from '../api'

/*
 * The Mine / Everyone / one-rep control that sits on every CRM screen.
 *
 * Two buttons and a select rather than a single dropdown with "Mine" as its first
 * option: Mine and Everyone are the two answers people actually want, and they are worth
 * one click each. Picking a named colleague is the rarer, more deliberate act, so it
 * gets the slower control.
 *
 * The whole thing hides when there is only one person who owns anything: a select with
 * one name in it is a control that cannot do anything.
 *
 * `store` picks which memory the control reads and writes. Client Success keeps its own,
 * because it opens on Everyone where the CRM opens on Mine. See lib/scope.ts.
 */

/** Read the shared scope and re-render when anything else changes it. */
export function useScope(store: ScopeStore = 'crm'): [Scope, (s: Scope) => void, string] {
  const [scope, set] = useState<Scope>(() => getScope(store))
  useEffect(() => subscribeScope(set, store), [store])
  const { session } = useSession()
  const ownerId = scopeToOwnerId(scope, session?.recordId || '')
  const write = useCallback((s: Scope) => setScope(s, store), [store])
  return [scope, write, ownerId]
}

export default function OwnerScope({
  label = 'Showing', store = 'crm',
}: { label?: string; store?: ScopeStore }) {
  const { session } = useSession()
  const [scope, setScope] = useScope(store)
  const [users, setUsers] = useState<User[]>([])

  useEffect(() => {
    let live = true
    loadUsers()
      .then(rows => { if (live) setUsers(rows) })
      // A failed roster is not worth a message here: Mine and Everyone still work, and
      // they are what almost everyone uses.
      .catch(() => {})
    return () => { live = false }
  }, [])

  const myId = session?.recordId || ''
  const mine = isMine(scope, myId)
  const everyone = scope === 'everyone'
  // Whatever is selected that is neither Mine nor Everyone: a named colleague.
  const namedId = mine || everyone ? '' : scope

  const others = users.filter(u => u.id !== myId)

  return (
    <div className="scope" role="group" aria-label={`${label} whose deals`}>
      <span className="scope__label">{label}</span>

      <button
        type="button"
        className="filter"
        data-on={mine ? '' : undefined}
        aria-pressed={mine}
        onClick={() => setScope('mine')}
        title={myId ? 'Only what you own' : 'Your login has no record behind it, so this shows everything'}
      >
        Mine
      </button>

      <button
        type="button"
        className="filter"
        data-on={everyone ? '' : undefined}
        aria-pressed={everyone}
        onClick={() => setScope('everyone')}
      >
        Everyone
      </button>

      {others.length > 0 && (
        <select
          className="scope__who"
          aria-label="Show one person's deals"
          value={namedId}
          onChange={e => setScope(e.target.value || 'mine')}
        >
          <option value="">Someone else…</option>
          {others.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      )}
    </div>
  )
}

/**
 * A one-line explanation of what the numbers on screen cover.
 *
 * Worth its own component because a scoped total looks exactly like an unscoped one, and
 * a rep who forgets the filter is set will read their own pipeline as the company's.
 */
export function ScopeNote({
  ownerName, store = 'crm',
}: { ownerName: string | null; store?: ScopeStore }) {
  const { session } = useSession()
  const [scope] = useScope(store)
  const myId = session?.recordId || ''

  if (scope === 'everyone') return null

  if (isMine(scope, myId)) {
    if (!myId) {
      return (
        <p className="scope__note" role="status">
          Your login has no staff record behind it, so “Mine” cannot be worked out,
          these are everyone’s.
        </p>
      )
    }
    return <p className="scope__note" role="status">Yours only. Switch to Everyone for the whole pipeline.</p>
  }

  return (
    <p className="scope__note" role="status">
      {ownerName ? `${ownerName}’s only.` : 'One person’s only.'} Switch to Mine or Everyone to change that.
    </p>
  )
}
