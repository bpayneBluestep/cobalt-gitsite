import { Link, NavLink, Route, Routes } from 'react-router-dom'
import Clients from './routes/Clients'
import Explorer from './routes/Explorer'
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

        <nav className="mainnav" aria-label="Sections">
          <NavLink to="/" end>Clients</NavLink>
        </nav>

        <div className="topbar__end">
          <ToolsMenu />
          <ThemeToggle />
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Clients />} />
          {/* The schema explorer is a tool, not a section — reached from the
              Tools menu. Its deep links live under /schema so they stay
              bookmarkable. */}
          <Route path="/schema" element={<Explorer />} />
          <Route path="/schema/type/:typeId" element={<Explorer />} />
          <Route path="/schema/form/:formId" element={<Explorer />} />
          <Route path="*" element={<Clients />} />
        </Routes>
      </main>
    </div>
  )
}
