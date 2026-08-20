import { useEffect, useRef, useState } from 'react'
import { setTheme, THEMES } from '../lib/theme'
import useTheme from './useTheme'
import { useSession } from '../session'

/*
 * Who you are, and everything personal to you — modelled on the eccrm CRM's account
 * menu, which is where that app puts the same three things:
 *
 *   • the name, spelled out, because a shared machine or a second account is exactly
 *     when you need to be sure
 *   • My Account, the platform's own profile page (password, e-mail, preferences)
 *   • the display mode, as a personal device-local setting
 *   • the way out
 *
 * A dropdown rather than the flat name-plus-link this replaces: the topbar was going to
 * accumulate one control per personal setting otherwise, and "Sign out" sitting
 * permanently exposed next to the nav is an easy misclick.
 */

/** "Payne, Brandon" -> "BP". Handles the platform's surname-first form and a plain one. */
function initials(fullName: string): string {
  const words = fullName.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  // Surname-first means the LAST word is the given name — so take the outer two either
  // way and let the order look how it looks. Two letters is all this needs to be.
  const first = words[0][0] || ''
  const last = words[words.length - 1][0] || ''
  return (first + last).toUpperCase()
}

export default function UserMenu() {
  const { session, roles, signOut } = useSession()
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  // Same dismissal contract as ToolsMenu: outside click, and Escape returns focus to
  // the button that opened it.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const name = session?.fullName || 'Signed in'

  return (
    <div className="usermenu" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="usermenu__btn"
        data-open={open || undefined}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className="usermenu__avatar" aria-hidden="true">{initials(name)}</span>
        <span className="usermenu__name">{name}</span>
        <span className="tools__chev" aria-hidden="true" />
      </button>

      {open && (
        <div className="usermenu__menu" role="menu">
          <div className="usermenu__id">
            <p className="usermenu__idname">{name}</p>
            {/* The roles, because in this app they decide what you can see — so "why
                can't I open Sprints" is answered here rather than by asking someone. */}
            <p className="usermenu__idroles">
              {roles.length ? roles.join(' · ') : 'No roles'}
              {session?.isSuper && <span className="usermenu__super">super</span>}
            </p>
          </div>

          <a
            className="tools__item"
            role="menuitem"
            href="/shared/user/myprofile.jsp"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            <span className="tools__label">My Account</span>
            <span className="tools__note">password &amp; profile</span>
          </a>

          <div className="usermenu__group">
            <p className="tools__heading">Display mode</p>
            <div className="usermenu__seg" role="group" aria-label="Display mode">
              {THEMES.map(t => (
                <button
                  type="button"
                  key={t.id}
                  data-on={theme === t.id || undefined}
                  aria-pressed={theme === t.id}
                  onClick={() => setTheme(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="usermenu__group">
            <button
              type="button"
              className="tools__item usermenu__out"
              role="menuitem"
              disabled={leaving}
              onClick={() => {
                setLeaving(true)
                setOpen(false)
                signOut()
              }}
            >
              <span className="tools__label">{leaving ? 'Signing out…' : 'Sign out'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
