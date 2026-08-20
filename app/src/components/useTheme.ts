import { useEffect, useState } from 'react'
import { getTheme, subscribeTheme, type Theme } from '../lib/theme'

/**
 * Read the current display mode and re-render when anything changes it.
 *
 * Deliberately read-only — setting goes through `setTheme` directly, so there is no
 * per-component setter that could write without telling the other subscribers.
 */
export default function useTheme(): Theme {
  const [theme, setLocal] = useState<Theme>(getTheme)
  useEffect(() => subscribeTheme(setLocal), [])
  return theme
}
