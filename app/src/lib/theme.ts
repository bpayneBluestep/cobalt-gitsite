/*
 * The display mode, as one store rather than one per component.
 *
 * There are now two ways to change it — the toggle on the sign-in screen, and the
 * segmented control in the account menu — and each used to be able to hold its own
 * `useState`. Two copies of the same setting drift the moment both are on screen: change
 * it in one and the other still shows the old value. So the value lives here, the DOM and
 * localStorage are written in one place, and both controls subscribe.
 *
 * `system` is the absence of a choice, not a third value: it removes the attribute and
 * the stored key so the page follows `prefers-color-scheme`. That is why nothing here
 * persists "system" — an empty slot already means it.
 */

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'cobalt-theme'

export const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Auto' },
]

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    // Private-mode or blocked storage: follow the system rather than fail.
    return 'system'
  }
}

let current: Theme = stored()
const listeners = new Set<(t: Theme) => void>()

function apply(theme: Theme): void {
  const root = document.documentElement
  try {
    if (theme === 'system') {
      root.removeAttribute('data-theme')
      localStorage.removeItem(KEY)
    } else {
      root.setAttribute('data-theme', theme)
      localStorage.setItem(KEY, theme)
    }
  } catch {
    // Storage can throw; the attribute is what actually changes the colours, so a
    // failure here costs persistence, not the theme itself.
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }
}

export function getTheme(): Theme {
  return current
}

export function setTheme(theme: Theme): void {
  current = theme
  apply(theme)
  for (const listener of Array.from(listeners)) listener(theme)
}

export function subscribeTheme(listener: (t: Theme) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/*
 * Apply the stored choice as soon as this module loads, which is before React's first
 * render — module scripts are deferred, so the document exists by now.
 *
 * A side effect at import rather than an `initTheme()` the entry point has to remember to
 * call: there is exactly one right moment for this and no reason to let a caller pick a
 * later one. The previous arrangement applied it in a component's `useEffect`, which is
 * after first paint — so a dark-mode user got a white flash on every load.
 */
apply(current)
