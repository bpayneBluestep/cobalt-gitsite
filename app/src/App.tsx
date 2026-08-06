import { NavLink, Route, Routes } from 'react-router-dom'
import Home from './routes/Home'
import Status from './routes/Status'

export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">GitSite SPA Starter</span>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/status">Status</NavLink>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/status" element={<Status />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>

      <footer className="footer">
        Served under <code>/spa/</code> from a GitHub-backed BlueStep GitSite.
      </footer>
    </div>
  )
}
