import { NavLink } from 'react-router-dom'

/*
 * The CRM's own pages. A sub-nav rather than five top-level items: they are one job seen
 * five ways: what you owe today, the numbers, the open deals, the people not yet in a
 * deal, and what already happened, and promoting them to the main nav would bury the
 * other sections.
 *
 * Follow-ups is first, and deliberately not the Dashboard. The dashboard answers "how is
 * it going"; follow-ups answers "what am I doing", and that is the question someone opens
 * a CRM with in the morning.
 */

const PAGES = [
  { to: '/crm/follow-ups', label: 'Follow-ups', end: false },
  { to: '/crm', label: 'Dashboard', end: true },
  { to: '/crm/pipeline', label: 'Pipeline', end: false },
  { to: '/crm/prospecting', label: 'Prospecting', end: false },
  { to: '/crm/closed', label: 'Won & lost', end: false },
]

export default function CrmNav({ counts }: { counts?: Record<string, number> }) {
  return (
    <nav className="subnav" aria-label="CRM pages">
      {PAGES.map(p => (
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
