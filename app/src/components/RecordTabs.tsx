import { Link, useLocation } from 'react-router-dom'

/*
 * The tab strip on a company: Info, Tickets, Contacts, Files.
 *
 * Each tab is a real child route under /clients/<id>, so all four render inside the
 * company's own shell — the name, the facts and this strip stay put while the panel
 * below changes. Tickets used to be a page of its own and lost that header, which made
 * it feel like leaving the record rather than moving around inside it.
 */

const TABS = [
  { seg: '', label: 'Info' },
  { seg: 'tickets', label: 'Tickets' },
  { seg: 'contacts', label: 'Contacts' },
  { seg: 'files', label: 'Files' },
]

export default function RecordTabs({ companyId }: { companyId: string }) {
  const { pathname } = useLocation()
  const base = `/clients/${companyId}`
  // Everything after the record's own path, minus slashes: '' | 'tickets' | …
  const here = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\//g, '') : ''

  return (
    <nav className="subnav" aria-label="Record sections">
      {TABS.map(t => (
        <Link
          key={t.seg || 'info'}
          to={t.seg ? `${base}/${t.seg}` : base}
          className={t.seg === here ? 'active' : undefined}
          aria-current={t.seg === here ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
