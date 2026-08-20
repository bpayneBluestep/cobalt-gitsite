import { setTheme, type Theme } from '../lib/theme'
import useTheme from './useTheme'

/*
 * The one-button theme cycle, now used only on the sign-in screen.
 *
 * Signed in, the display mode lives in the account menu as a three-way segmented
 * control — more discoverable, and it sits with the other personal settings. But you
 * cannot open an account menu before you have an account, so the gate keeps this: a
 * single button that cycles, which is the smallest thing that still gives someone
 * reading a dark room a way out.
 *
 * State comes from the shared store, so changing the mode here and then signing in
 * shows the segmented control already agreeing with it.
 */

const NEXT: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' }
const LABEL: Record<Theme, string> = { system: 'System', dark: 'Dark', light: 'Light' }

export default function ThemeToggle() {
  const theme = useTheme()

  return (
    <button
      type="button"
      className="themetoggle"
      onClick={() => setTheme(NEXT[theme])}
      aria-label={`Colour theme: ${LABEL[theme]}. Switch to ${LABEL[NEXT[theme]]}.`}
      title={`Theme: ${LABEL[theme]}`}
    >
      {LABEL[theme]}
    </button>
  )
}
