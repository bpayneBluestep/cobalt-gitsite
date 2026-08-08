import { Link, NavLink, Route, Routes } from 'react-router-dom'
import Clients from './routes/Clients'
import ClientTickets from './routes/ClientTickets'
import CompanyRecord from './routes/CompanyRecord'
import CompanyInfo from './routes/CompanyInfo'
import CompanyContacts from './routes/CompanyContacts'
import CompanyFiles from './routes/CompanyFiles'
import Tickets from './routes/Tickets'
import Explorer from './routes/Explorer'
import UnderConstruction from './routes/UnderConstruction'
import CrmDashboard from './routes/CrmDashboard'
import CrmPipeline from './routes/CrmPipeline'
import CrmProspecting from './routes/CrmProspecting'
import Sprints from './routes/Sprints'
import Settings from './routes/Settings'
import TicketPage from './routes/TicketPage'
import { SECTIONS } from './sections'
import ThemeToggle from './components/ThemeToggle'
import ToolsMenu from './components/ToolsMenu'

export default function App() {
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
          {SECTIONS.map(s => (
            <NavLink key={s.key} to={s.path} end={s.path === '/'}>{s.label}</NavLink>
          ))}
        </nav>

        <div className="topbar__end">
          <ToolsMenu />
          <ThemeToggle />
        </div>
      </header>

      <main>
        <Routes>
          {/* Only the unbuilt sections get a placeholder. A built one keeps its nav
              item and takes its own routes below. */}
          {SECTIONS.filter(s => !s.built).map(s => (
            <Route key={s.key} path={s.path} element={<UnderConstruction section={s} />} />
          ))}

          <Route path="/crm" element={<CrmDashboard />} />
          <Route path="/crm/pipeline" element={<CrmPipeline />} />
          <Route path="/crm/prospecting" element={<CrmProspecting />} />
          <Route path="/sprints" element={<Sprints />} />
          <Route path="/settings" element={<Settings />} />

          {/* Clients is live. It sits under /clients rather than the root now that
              Home has it, and is reached from Home and from CRM.

              A company record is a LAYOUT: its name, facts, stage control and tab strip
              are rendered once, and each section below is a child route — so the header
              stays put whichever tab you are on, tickets included. */}
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:id" element={<CompanyRecord />}>
            <Route index element={<CompanyInfo />} />
            <Route path="tickets" element={<ClientTickets />} />
            <Route path="contacts" element={<CompanyContacts />} />
            <Route path="files" element={<CompanyFiles />} />
          </Route>

          {/* A ticket is a page of its own, addressed by its org-wide number, so the
              link can be pasted into a chat and opened by whoever gets it. An entry id
              works in the same slot for a ticket that never got a number. */}
          <Route path="/tickets/:key" element={<TicketPage />} />

          {/* The schema explorer is a tool, not a section — reached from the
              Tools menu. Its deep links live under /schema so they stay
              bookmarkable. */}
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/schema" element={<Explorer />} />
          <Route path="/schema/type/:typeId" element={<Explorer />} />
          <Route path="/schema/form/:formId" element={<Explorer />} />

          <Route path="*" element={<UnderConstruction section={SECTIONS[0]} />} />
        </Routes>
      </main>
    </div>
  )
}
