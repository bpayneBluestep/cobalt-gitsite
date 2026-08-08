import { Link } from 'react-router-dom'

/*
 * The tab strip on a company: Info, Tickets, Contacts, Files.
 *
 * Tickets is a peer of the others rather than a button off in the header — it is one
 * of the four things a company record holds, not an action you take on it.
 *
 * All four are links, so the strip is identical whether you are on the record itself
 * or on its ticket board, and the browser's back button walks the tabs. Info, Contacts
 * and Files live on the record route and pick their panel with `?tab=`; Tickets has its
 * own route because the board is a page in its own right, with deep links into a ticket.
 */

export type RecordTab = 'info' | 'tickets' | 'contacts' | 'files'

const TABS: { key: RecordTab; label: string }[] = [
  { key: 'info', label: 'Info' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'files', label: 'Files' },
]

/** Where a tab points. Info is the bare record — no query string to clean up later. */
export function tabPath(companyId: string, tab: RecordTab): string {
  if (tab === 'tickets') return `/clients/${companyId}/tickets`
  if (tab === 'info') return `/clients/${companyId}`
  return `/clients/${companyId}?tab=${tab}`
}

export default function RecordTabs({ companyId, active }: {
  companyId: string
  active: RecordTab
}) {
  return (
    <nav className="subnav" aria-label="Record sections">
      {TABS.map(t => (
        <Link
          key={t.key}
          to={tabPath(companyId, t.key)}
          className={t.key === active ? 'active' : undefined}
          aria-current={t.key === active ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
