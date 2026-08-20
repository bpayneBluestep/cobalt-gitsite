/*
 * Whose work you are looking at — remembered, and "mine" until you say otherwise.
 *
 * Every CRM screen used to open on the whole company's pipeline. That is the right
 * default for exactly one person, the sales manager, and the wrong one for everybody
 * who has to find their own deals in it first. So the default is Mine.
 *
 * Three states, one value:
 *
 *   'mine'      — resolved against the signed-in person at read time
 *   'everyone'  — no owner filter at all
 *   '<recordId>' — one named rep
 *
 * 'mine' is stored as the literal word rather than the caller's own id, deliberately.
 * Storing the id would mean a shared browser, or a person whose record is re-pointed,
 * silently keeps looking at someone else's book and calling it "mine".
 *
 * Shared as a store rather than per-screen state because moving between Pipeline,
 * Prospecting and Follow-ups should not reset who you are looking at — that is the same
 * question being asked three ways, and re-answering it on every navigation is the kind
 * of small friction that makes a tool feel like it is arguing with you.
 */

export type Scope = 'mine' | 'everyone' | string

const KEY = 'cobalt-crm-scope'

function stored(): Scope {
  try {
    const v = localStorage.getItem(KEY)
    return v ? v : 'mine'
  } catch {
    // Blocked storage: the default is still the useful answer.
    return 'mine'
  }
}

let current: Scope = stored()
const listeners = new Set<(s: Scope) => void>()

export function getScope(): Scope {
  return current
}

export function setScope(scope: Scope): void {
  current = scope || 'mine'
  try {
    localStorage.setItem(KEY, current)
  } catch {
    // Losing persistence costs the choice on next load, not the choice now.
  }
  for (const listener of Array.from(listeners)) listener(current)
}

export function subscribeScope(listener: (s: Scope) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The `ownerId` a scope means for this caller — '' for everyone.
 *
 * A signed-in person with no record behind their login cannot own anything, so 'mine'
 * collapses to no filter for them rather than to an empty-string owner that would match
 * every unowned row. Rare, but it is exactly the case where a silent wrong answer would
 * look like real data.
 */
export function scopeToOwnerId(scope: Scope, myRecordId: string): string {
  if (scope === 'everyone') return ''
  if (scope === 'mine') return myRecordId || ''
  return scope
}

/** True when the scope names the signed-in person, however it was expressed. */
export function isMine(scope: Scope, myRecordId: string): boolean {
  return scope === 'mine' || (!!myRecordId && scope === myRecordId)
}
