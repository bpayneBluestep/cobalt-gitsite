import { Link, Route, Routes } from 'react-router-dom'
import Explorer from './routes/Explorer'
import ThemeToggle from './components/ThemeToggle'
import ToolsMenu from './components/ToolsMenu'
import { schema, formatWhen } from './schema'

export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">Cobalt</span>
          <span className="brand__sub">schema</span>
        </Link>

        <dl className="stats" aria-label="Schema totals">
          <div><dt>Record types</dt><dd>{schema.stats.recordTypes}</dd></div>
          <div><dt>Forms</dt><dd>{schema.stats.forms}</dd></div>
          <div><dt>Fields</dt><dd>{schema.stats.fields}</dd></div>
        </dl>

        <div className="topbar__end">
          <span className="stamp">
            <span className="stamp__org">{schema.org}</span>
            <span className="stamp__when">{formatWhen(schema.extractedAt)}</span>
          </span>
          <ToolsMenu />
          <ThemeToggle />
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Explorer />} />
          <Route path="/type/:typeId" element={<Explorer />} />
          <Route path="/form/:formId" element={<Explorer />} />
          <Route path="*" element={<Explorer />} />
        </Routes>
      </main>

      <footer className="footer">
        <span>
          Snapshot of <code>{schema.org}</code> — regenerate with{' '}
          <code>npm run extract-schema</code>.
        </span>
        <span className="muted">{schema.source}</span>
      </footer>
    </div>
  )
}
