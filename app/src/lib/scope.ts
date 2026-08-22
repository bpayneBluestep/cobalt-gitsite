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
 *
 * There are two stores, not one, because Client Success asks the same question with a
 * different right answer. CS is one person covering every account, so its screens open
 * on Everyone; sharing the CRM's store would mean opening the queue silently filtered
 * to one owner's clients, or opening the pipeline unfiltered — one of the two would
 * always be wrong. Same control, same three states, separate memory.
 */

export type Scope = 'mine' | 'everyone' | string

/** Which store a screen reads. The CRM's is the default, so existing callers say nothing. */
export type ScopeStore = 'crm' | 'cs'

const KEYS: Record<ScopeStore, string> = {
  crm: 'cobalt-crm-scope',
  cs: 'cobalt-cs-scope',
}

const DEFAULTS: Record<ScopeStore, Scope> = {
  crm: 'mine',
  cs: 'everyone',
}

function stored(store: ScopeStore): Scope {
  try {
    const v = localStorage.getItem(KEYS[store])
    return v ? v : DEFAULTS[store]
  } catch {
    // Blocked storage: the default is still the useful answer.
    return DEFAULTS[store]
  }
}

const current: Record<ScopeStore, Scope> = {
  crm: stored('crm'),
  cs: stored('cs'),
}

const listeners: Record<ScopeStore, Set<(s: Scope) => void>> = {
  crm: new Set(),
  cs: new Set(),
}

export function getScope(store: ScopeStore = 'crm'): Scope {
  return current[store]
}

export function setScope(scope: Scope, store: ScopeStore = 'crm'): void {
  current[store] = scope || DEFAULTS[store]
  try {
    localStorage.setItem(KEYS[store], current[store])
  } catch {
    // Losing persistence costs the choice on next load, not the choice now.
  }
  for (const listener of Array.from(listeners[store])) listener(current[store])
}

export function subscribeScope(
  listener: (s: Scope) => void, store: ScopeStore = 'crm',
): () => void {
  listeners[store].add(listener)
  return () => listeners[store].delete(listener)
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
