import { Link, NavLink, Route, Routes } from 'react-router-dom'
import type { ReactElement } from 'react'
import Clients from './routes/Clients'
import ClientTickets from './routes/ClientTickets'
import CompanyRecord from './routes/CompanyRecord'
import CompanyInfo from './routes/CompanyInfo'
import CompanyContacts from './routes/CompanyContacts'
import CompanyFiles from './routes/CompanyFiles'
import Tickets from './routes/Tickets'
import Explorer from './routes/Explorer'
import UnderConstruction from './routes/UnderConstruction'
import NoAccess from './routes/NoAccess'
import CrmDashboard from './routes/CrmDashboard'
import CrmPipeline from './routes/CrmPipeline'
import CrmProspecting from './routes/CrmProspecting'
import Sprints from './routes/Sprints'
import Settings from './routes/Settings'
import TicketPage from './routes/TicketPage'
import Intake from './routes/Intake'
import { SECTIONS } from './sections'
import type { Capability } from './api'
import { SessionProvider, useSession } from './session'
import ThemeToggle from './components/ThemeToggle'
import ToolsMenu from './components/ToolsMenu'

/*
 * A route nobody without the capability may open.
 *
 * Both halves matter. Hiding the nav item alone leaves the URL working, and a bookmarked
 * or pasted link is exactly how someone arrives at a page they should not see — so the
 * route is checked too, not just the menu.
 *
 * This is presentation. The endpoint runs as the caller against the platform's form ACLs,
 * so a hand-made request gets nothing back regardless of what this renders. What the
 * check buys is that the app never shows a screen it cannot fill.
 */
function Guarded({
  needs,
  what,
  children,
}: {
  needs: Capability
  what: string
  children: ReactElement
}) {
  const { can, loading } = useSession()
  // Say nothing while the session is in flight rather than flashing either answer.
  if (loading) return <p className="page__loading">Checking your access…</p>
  if (!can(needs)) return <NoAccess what={what} needs={CAPABILITY_LABELS[needs]} />
  return children
}

/**
 * How a capability is described to the person who lacks it.
 *
 * Role names, not capability names: "Leadership" is something a person can go and ask
 * for, whereas "editSprints" is an internal identifier that tells them nothing. The
 * server is the authority on the mapping; this is only the wording.
 */
const CAPABILITY_LABELS: Record<Capability, string> = {
  viewClients: 'any role',
  editClients: 'Leadership, Sales or Client Success',
  viewDeals: 'Leadership, Accounting, Sales or Client Success',
  editDeals: 'Leadership or Sales',
  viewContacts: 'any role',
  editContacts: 'Leadership, Sales or Client Success',
  viewFiles: 'any role',
  editFiles: 'any role except Accounting',
  viewOwner: 'any role',
  editOwner: 'Leadership, Sales or Client Success',
  viewTickets: 'any role',
  editTickets: 'Leadership, Relate Engineer, Infra Engineer or Client Success',
  viewSprints: 'Leadership, Relate Engineer, Infra Engineer or Client Success',
  editSprints: 'Leadership',
  viewStaff: 'any role',
  editStaff: 'Leadership',
  grantRoles: 'Leadership',
  viewReports: 'Leadership or Accounting',
  viewSchema: 'Leadership, Relate Engineer or Infra Engineer',
}

function Shell() {
  const { loading, error, needsLogin, can, roles, session } = useSession()

  // A section is in the nav only if its capability is held. `needs` lives on the section
  // itself, so the nav and the route below read the same declaration.
  const sections = SECTIONS.filter(s => !s.needs || can(s.needs))

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">Cobalt</span>
          <span className="brand__sub">ERP</span>
        </Link>

        {/* Driven by SECTIONS, so a nav item and its page can never disagree. */}
        <nav className="mainnav" aria-label="Sections">
          {sections.map(s => (
            <NavLink key={s.key} to={s.path} end={s.path === '/'}>{s.label}</NavLink>
          ))}
        </nav>

        <div className="topbar__end">
          {can('viewSchema') && <ToolsMenu />}
          <ThemeToggle />
        </div>
      </header>

      <main>
        {/*
          Three states before any route renders, because they need different answers and
          conflating them is what makes a permission problem look like an outage:
            * not signed in       -> sign in
            * session unreadable  -> the app is broken, say so
            * signed in, no roles -> nothing is wrong, you just have no access yet
        */}
        {needsLogin ? (
          <section className="page">
            <header className="page__head">
              <h1>Sign in to Cobalt</h1>
              <p className="page__sub-text">
                Cobalt reads live BlueStep data, so it needs your session. Sign in and reload.
              </p>
            </header>
          </section>
        ) : error ? (
          <section className="page">
            <header className="page__head">
              <h1>Cobalt could not read your session</h1>
              <p className="page__sub-text">{error}</p>
            </header>
          </section>
        ) : !loading && session && roles.length === 0 ? (
          <NoAccess what="Cobalt" />
        ) : (
          <Routes>
            {/* Only the unbuilt sections get a placeholder. A built one keeps its nav
                item and takes its own routes below. */}
            {SECTIONS.filter(s => !s.built).map(s => (
              <Route
                key={s.key}
                path={s.path}
                element={
                  s.needs ? (
                    <Guarded needs={s.needs} what={s.label}>
                      <UnderConstruction section={s} />
                    </Guarded>
                  ) : (
                    <UnderConstruction section={s} />
                  )
                }
              />
            ))}

            <Route path="/crm" element={<Guarded needs="viewDeals" what="CRM"><CrmDashboard /></Guarded>} />
            <Route path="/crm/pipeline" element={<Guarded needs="viewDeals" what="The pipeline"><CrmPipeline /></Guarded>} />
            <Route path="/crm/prospecting" element={<Guarded needs="viewDeals" what="Prospecting"><CrmProspecting /></Guarded>} />
            <Route path="/sprints" element={<Guarded needs="viewSprints" what="Sprints"><Sprints /></Guarded>} />
            <Route path="/settings" element={<Guarded needs="viewStaff" what="Settings"><Settings /></Guarded>} />

            {/* Clients is live. It sits under /clients rather than the root now that
                Home has it, and is reached from Home and from CRM.

                A company record is a LAYOUT: its name, facts, stage control and tab strip
                are rendered once, and each section below is a child route — so the header
                stays put whichever tab you are on, tickets included. */}
            <Route path="/clients" element={<Guarded needs="viewClients" what="Clients"><Clients /></Guarded>} />
            <Route
              path="/clients/:id"
              element={<Guarded needs="viewClients" what="This client"><CompanyRecord /></Guarded>}
            >
              <Route index element={<CompanyInfo />} />
              <Route path="tickets" element={<ClientTickets />} />
              <Route path="contacts" element={<CompanyContacts />} />
              <Route path="files" element={<CompanyFiles />} />
            </Route>

            {/* A ticket is a page of its own, addressed by its org-wide number, so the
                link can be pasted into a chat and opened by whoever gets it. An entry id
                works in the same slot for a ticket that never got a number. */}
            <Route
              path="/tickets/:key"
              element={<Guarded needs="viewTickets" what="This ticket"><TicketPage /></Guarded>}
            />

            {/* Wesley guided intake. Addressed by the client it is for, so the entry
                point on a client's board is a plain link and the page can be sent to
                someone who needs to raise a request.

                Deliberately ungated beyond being signed in: raising a request is the one
                thing anyone with a login should be able to do, and it creates a ticket
                rather than reading anyone else's. */}
            <Route path="/clients/:clientId/request" element={<Intake />} />
            <Route path="/request" element={<Intake />} />

            {/* The schema explorer is a tool, not a section — reached from the
                Tools menu. Its deep links live under /schema so they stay
                bookmarkable. */}
            <Route path="/tickets" element={<Guarded needs="viewTickets" what="Tickets"><Tickets /></Guarded>} />
            <Route path="/schema" element={<Guarded needs="viewSchema" what="The schema explorer"><Explorer /></Guarded>} />
            <Route
              path="/schema/type/:typeId"
              element={<Guarded needs="viewSchema" what="The schema explorer"><Explorer /></Guarded>}
            />
            <Route
              path="/schema/form/:formId"
              element={<Guarded needs="viewSchema" what="The schema explorer"><Explorer /></Guarded>}
            />

            <Route path="*" element={<UnderConstruction section={SECTIONS[0]} />} />
          </Routes>
        )}
      </main>
    </div>
  )
}

export default function App() {
  /*
   * The provider wraps the shell rather than sitting in main.tsx, so the header can gate
   * its own nav from the same session the routes use — one fetch for the whole app.
   */
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  )
}
