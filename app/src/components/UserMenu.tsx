import { useEffect, useRef, useState } from 'react'
import {
  ApiError, getOutlookConnection, getOutlookConnectUrl, outlookDisconnect,
  type OutlookConnection,
} from '../api'
import { setTheme, THEMES } from '../lib/theme'
import useTheme from './useTheme'
import { useSession } from '../session'

/*
 * Who you are, and everything personal to you: modelled on the eccrm CRM's account
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
  // Surname-first means the LAST word is the given name, so take the outer two either
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

  /*
   * The Outlook connection is loaded when the menu is FIRST opened, not on mount.
   * Every signed-in page renders this component, and a connection nobody is looking at
   * is not worth a request on every navigation.
   */
  const [conn, setConn] = useState<OutlookConnection | null>(null)
  const [connErr, setConnErr] = useState('')
  const [connBusy, setConnBusy] = useState('')
  const loadedRef = useRef(false)

  function loadConn() {
    setConnErr('')
    getOutlookConnection()
      .then(setConn)
      .catch(err => setConnErr(err instanceof ApiError ? err.message : String(err)))
  }

  useEffect(() => {
    if (!open || loadedRef.current) return
    loadedRef.current = true
    loadConn()
  }, [open])

  function connect() {
    if (connBusy) return
    setConnBusy('connect'); setConnErr('')
    getOutlookConnectUrl()
      // A full page navigation, not a popup: the consent screen refuses to render in a
      // frame, and a popup here would be the thing the browser blocks.
      .then(r => { window.location.href = r.url })
      .catch(err => {
        setConnErr(err instanceof ApiError ? err.message : String(err))
        setConnBusy('')
      })
  }

  function disconnect() {
    if (connBusy) return
    if (!window.confirm(
      'Forget your stored Outlook token?\n\n' +
      'Cobalt will stop sending mail as you. This does not withdraw the permission at ' +
      'Microsoft: do that in your Microsoft account if you want it fully revoked.',
    )) return
    setConnBusy('disconnect'); setConnErr('')
    outlookDisconnect()
      .then(r => setConn(r.connection))
      .catch(err => setConnErr(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setConnBusy(''))
  }

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
            {/* The roles, because in this app they decide what you can see, so "why
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

          {/*
            Connecting your mailbox belongs here rather than in Settings: Settings holds
            the UNIT's app registration, which is a Leadership concern, while this is your
            own account and everyone with a mailbox has one.
          */}
          <div className="usermenu__group">
            <p className="tools__heading">Outlook</p>
            {!conn && !connErr && <p className="tools__note">Checking…</p>}
            {connErr && <p className="tools__note usermenu__err">{connErr}</p>}
            {conn && conn.connected && !conn.stale && (
              <>
                <p className="tools__note">
                  Connected{conn.mailbox ? ' as ' : ''}
                  {conn.mailbox && <strong>{conn.mailbox}</strong>}
                </p>
                <button
                  type="button"
                  className="tools__item usermenu__out"
                  role="menuitem"
                  disabled={!!connBusy}
                  onClick={disconnect}
                >
                  <span className="tools__label">
                    {connBusy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Outlook'}
                  </span>
                </button>
              </>
            )}
            {conn && conn.stale && (
              <p className="tools__note usermenu__err">
                Half connected: no token was stored. Connect again.
              </p>
            )}
            {conn && (!conn.connected || conn.stale) && (
              conn.canConnect ? (
                <button
                  type="button"
                  className="tools__item"
                  role="menuitem"
                  disabled={!!connBusy}
                  onClick={connect}
                >
                  <span className="tools__label">
                    {connBusy === 'connect' ? 'Opening Microsoft…' : 'Connect Outlook'}
                  </span>
                  <span className="tools__note">send mail as you</span>
                </button>
              ) : (
                /* Why it is unavailable, rather than a button that fails on click. */
                <p className="tools__note">{conn.reason || 'Not available yet.'}</p>
              )
            )}
          </div>

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
