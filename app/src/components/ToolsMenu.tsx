import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

/*
 * Native BlueStep admin tools, folded into this SPA's toolbar — the same idea as
 * gitsite-spa-starter/src/chrome.ts, adapted for a standalone GitSite.
 *
 * Two differences from that implementation, both forced:
 *
 *  1. No popup globals. eccrm's Organization Chart / Alternate Identifiers /
 *     Console Trace items call doPopup / doPopupFrame / winAttribs, which only
 *     exist when the page is mounted inside singleblock.jsp. A GitSite serves a
 *     bare index.html under /spa/, so those globals are undefined here. The ones
 *     that map to a real URL are plain links instead; the rest are omitted.
 *
 *  2. No current-page id. Those same items also read `curPagePrimaryObject` to
 *     scope themselves to the page you're on. A GitSite is not a BlueStep page
 *     object, so there is nothing to scope to — Current Container Child Tree,
 *     Change History and Alternate Identifiers are left out rather than shipped
 *     pointing at nothing.
 *
 * Every href is root-relative so it resolves against whatever host is serving
 * the SPA, and opens in a new tab so the explorer isn't lost. Access is enforced
 * by BlueStep, not here: an unauthorised visitor gets the login page.
 *
 * The menu as a whole is rendered only for `viewSchema` (Leadership and the two
 * engineer roles) — see App.tsx. That resolves the old TODO here, which wanted
 * super-only gating once a login existed: the login landed, and roles turned out
 * to be the better boundary than isSuper, since an engineer needs these tools and
 * is not a super. The `schema-behind-login` branch that TODO pointed at is dead.
 */

interface Tool {
  label: string
  href: string
  note?: string
}

interface Group {
  heading: string
  tools: Tool[]
}

// Ids verified to resolve on this org (U142140) via remoteObject — they are
// global (`___` with no U segment), not per-org, despite eccrm's note to refresh
// them per deployment.
const GROUPS: Group[] = [
  {
    heading: 'Platform',
    tools: [
      { label: 'Relate', href: '/shared/home.jsp?_a=530002___131263' },
      { label: 'Organization Admin', href: '/shared/home.jsp?_a=111020___151457' },
    ],
  },
  {
    heading: 'Inspect',
    tools: [
      { label: 'GraphQL', href: '/shared/graphql.jsp' },
      { label: 'Organization Chart', href: '/shared/admin/organization/orgpop.jsp' },
      { label: 'Organization Tree', href: '/shared/admin/organization/orgpop.jsp?_showAll=true&_hideAdminLinks=true' },
      { label: 'Cache Stats', href: '/admin/cachestatsnew.jsp' },
    ],
  },
  {
    heading: 'This tool',
    tools: [
      {
        label: 'Schema API endpoint',
        href: '/shared/admin/applications/relate/editScript.jsp?_event=edit&_id=363769___2',
        note: 'serves this page’s data',
      },
    ],
  },
  {
    heading: 'Session',
    tools: [
      { label: 'Temporary Login', href: '/shared/login/templogin.jsp' },
    ],
  },
]

export default function ToolsMenu() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

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

  return (
    <div className="tools" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="tools__btn"
        data-open={open || undefined}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        Tools
        <span className="tools__chev" aria-hidden="true" />
      </button>

      {open && (
        <div className="tools__menu" role="menu">
          {/* In-app tools come first and route internally — no new tab. */}
          <div className="tools__group">
            <p className="tools__heading">In this app</p>
            <Link className="tools__item" role="menuitem" to="/schema" onClick={() => setOpen(false)}>
              <span className="tools__label">Schema explorer</span>
              <span className="tools__note">record types &amp; fields</span>
            </Link>
          </div>

          {GROUPS.map(group => (
            <div className="tools__group" key={group.heading}>
              <p className="tools__heading">{group.heading}</p>
              {group.tools.map(tool => (
                <a
                  key={tool.label}
                  className="tools__item"
                  role="menuitem"
                  href={tool.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                >
                  <span className="tools__label">{tool.label}</span>
                  {tool.note && <span className="tools__note">{tool.note}</span>}
                </a>
              ))}
            </div>
          ))}
          <p className="tools__foot">Opens in a new tab. BlueStep enforces access.</p>
        </div>
      )}
    </div>
  )
}
