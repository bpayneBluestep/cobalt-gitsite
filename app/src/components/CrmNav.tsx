import { NavLink } from 'react-router-dom'

/*
 * The CRM's own three pages. A sub-nav rather than three top-level items: they are
 * one job seen three ways — the numbers, the deals, and the people not yet in a
 * deal — and promoting them to the main nav would bury the other sections.
 */

const PAGES = [
  { to: '/crm', label: 'Dashboard', end: true },
  { to: '/crm/pipeline', label: 'Pipeline', end: false },
  { to: '/crm/prospecting', label: 'Prospecting', end: false },
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
