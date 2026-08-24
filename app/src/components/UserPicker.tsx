import { useEffect, useState } from 'react'
import { getUsers, type User } from '../api'

/*
 * Pick a person from the user list.
 *
 * A ticket's accountable and responsible owners are chosen, never typed. The old
 * free-text assignee is exactly why: "Dana", "dana k" and "Dana Kirby" were three
 * different engineers as far as the sprint board was concerned, and no amount of
 * careful typing fixes that at the reporting end.
 *
 * The roster is small, changes rarely, and is wanted by three separate screens, so it
 * is fetched ONCE per page load and shared. A module-level promise rather than a
 * context: every caller wants the same list, nobody wants to own it, and a second
 * mount during the first fetch joins that fetch instead of starting another.
 */

let cache: Promise<User[]> | null = null

export function loadUsers(): Promise<User[]> {
  if (!cache) {
    cache = getUsers()
      .then(list => list.rows)
      .catch(err => {
        // Don't cache a failure: a picker mounted after the network recovers should
        // be able to try again rather than being permanently empty.
        cache = null
        throw err
      })
  }
  return cache
}

/** Drop the cache after anything that changes the user list. */
export function forgetUsers(): void {
  cache = null
}

export default function UserPicker({
  id, value, onChange, disabled, placeholder = '-', ariaLabel,
}: {
  id?: string
  /** The selected user's record id, or '' for nobody. */
  value: string
  onChange: (userId: string) => void
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
}) {
  const [users, setUsers] = useState<User[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    loadUsers()
      .then(rows => { if (live) setUsers(rows) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [])

  // A selected user who is not in the list, someone who has since left: would
  // otherwise silently reset the select to "nobody" the moment anything else is
  // edited. Keep them visible instead, and say why.
  const known = users.some(u => u.id === value)

  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={e => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {value && !known && <option value={value}>(no longer listed)</option>}
      {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      {failed && <option value="" disabled>Could not load the user list</option>}
    </select>
  )
}
