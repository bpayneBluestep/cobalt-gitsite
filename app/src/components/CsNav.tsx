import { NavLink } from 'react-router-dom'
import { useSession } from '../session'

/*
 * Client Success's own pages: the same sub-nav shape the CRM uses.
 *
 * The Queue is first and is the point of the section: it answers "who do I ring today".
 * Surveys and Quarter are both looking backwards, one at what clients said and one at
 * what we did about it, and neither is a screen anyone opens on a Monday morning.
 *
 * Surveys is hidden without `viewSurveys` rather than shown-and-refused. It is the one
 * page in the section that a role holding `viewCs` may genuinely not reach: Accounting
 * can see health, not the words a client typed, so offering the tab would be offering
 * a NoAccess screen.
 */

export default function CsNav({ counts }: { counts?: Record<string, number> }) {
  const { can } = useSession()

  const pages = [
    { to: '/cs', label: 'Queue', end: true },
    ...(can('viewSurveys') ? [{ to: '/cs/surveys', label: 'Surveys', end: false }] : []),
    { to: '/cs/quarter', label: 'Quarter', end: false },
  ]

  return (
    <nav className="subnav" aria-label="Client Success pages">
      {pages.map(p => (
        <NavLink key={p.to} to={p.to} end={p.end}>
          {p.label}
          {counts && counts[p.label] !== undefined && (
            <span className="subnav__n">{counts[p.label]}</span>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
