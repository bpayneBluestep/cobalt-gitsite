import { Link, useLocation } from 'react-router-dom'

/*
 * The tab strip on a company.
 *
 * Each tab is a real child route under /clients/<id>, so all of them render inside the
 * company's own shell — the name, the facts and this strip stay put while the panel
 * below changes. Tickets used to be a page of its own and lost that header, which made
 * it feel like leaving the record rather than moving around inside it.
 *
 * Which tabs appear depends on what the company IS, and that is not cosmetic:
 *
 *   * Tickets are support work on a system somebody is running. A lead has no system,
 *     so a Tickets tab on one is an invitation to file work against a company that
 *     cannot receive it.
 *   * Deals belong on everything. A lead's deals are why it is a lead; a client's are
 *     upsells, which is where most growth comes from and which previously had nowhere
 *     to live except the shared pipeline board.
 *
 * A Former Client keeps Tickets — the history of what was done for them is exactly what
 * you want when they come back, and hiding it would lose it.
 */

interface Tab {
  seg: string
  label: string
  /** Omit for a tab that is always shown. */
  when?: (categories: string[]) => boolean
}

const isClientish = (categories: string[]) =>
  categories.includes('Client') || categories.includes('Former Client')

const TABS: Tab[] = [
  { seg: '', label: 'Info' },
  { seg: 'deals', label: 'Deals' },
  { seg: 'tickets', label: 'Tickets', when: isClientish },
  { seg: 'contacts', label: 'Contacts' },
  { seg: 'files', label: 'Files' },
]

export default function RecordTabs({
  companyId, categories,
}: {
  companyId: string
  categories: string[]
}) {
  const { pathname } = useLocation()
  const base = `/clients/${companyId}`
  // Everything after the record's own path, minus slashes: '' | 'deals' | 'tickets' | …
  const here = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\//g, '') : ''

  const shown = TABS.filter(t => !t.when || t.when(categories))

  return (
    <nav className="subnav" aria-label="Record sections">
      {shown.map(t => (
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
