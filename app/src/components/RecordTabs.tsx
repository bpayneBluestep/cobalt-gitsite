import { Link, useLocation } from 'react-router-dom'
import { useSession } from '../session'
import type { Capability } from '../api'

/*
 * The tab strip on a company.
 *
 * Each tab is a real child route under /clients/<id>, so all of them render inside the
 * company's own shell: the name, the facts and this strip stay put while the panel
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
 * A Former Client keeps Tickets: the history of what was done for them is exactly what
 * you want when they come back, and hiding it would lose it.
 *
 * Two independent tests, and a tab needs to pass both. `when` asks what the company IS;
 * `needs` asks what the VIEWER may see. Success is the first tab where they differ: an
 * engineer has every reason to open a client record and no business reading its account
 * health, so the tab is not offered to them: the same rule the section nav follows.
 */

interface Tab {
  seg: string
  label: string
  /** Omit for a tab that is always shown. */
  when?: (categories: string[]) => boolean
  /** The capability required to see the tab at all. Omit for a tab everyone gets. */
  needs?: Capability
}

const isClientish = (categories: string[]) =>
  categories.includes('Client') || categories.includes('Former Client')

const TABS: Tab[] = [
  { seg: '', label: 'Info' },
  { seg: 'deals', label: 'Deals' },
  { seg: 'tickets', label: 'Tickets', when: isClientish },
  /*
   * Success is clientish for the same reason Tickets is: a lead has no relationship to
   * keep healthy yet, and a Former Client's history is exactly what you want in front of
   * you when they come back.
   */
  { seg: 'success', label: 'Success', when: isClientish, needs: 'viewCs' },
  { seg: 'contacts', label: 'Contacts' },
  { seg: 'files', label: 'Files' },
  /*
   * Agreements on every company: a lead is exactly who gets sent a contract, and
   * a client's agreements are renewals and addenda.
   */
  { seg: 'agreements', label: 'Agreements', needs: 'viewAgreements' },
]

export default function RecordTabs({
  companyId, categories,
}: {
  companyId: string
  categories: string[]
}) {
  const { pathname } = useLocation()
  const { can } = useSession()
  const base = `/clients/${companyId}`
  // Everything after the record's own path, minus slashes: '' | 'deals' | 'tickets' | …
  const here = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\//g, '') : ''

  const shown = TABS.filter(t => (!t.when || t.when(categories)) && (!t.needs || can(t.needs)))

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
