import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

const KEY = 'cobalt-theme'
const next: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' }
const label: Record<Theme, string> = { system: 'System', dark: 'Dark', light: 'Light' }

function read(): Theme {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(read)

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') {
      root.removeAttribute('data-theme')
      localStorage.removeItem(KEY)
    } else {
      root.setAttribute('data-theme', theme)
      localStorage.setItem(KEY, theme)
    }
  }, [theme])

  return (
    <button
      type="button"
      className="themetoggle"
      onClick={() => setTheme(t => next[t])}
      aria-label={`Colour theme: ${label[theme]}. Switch to ${label[next[theme]]}.`}
      title={`Theme: ${label[theme]}`}
    >
      {label[theme]}
    </button>
  )
}
