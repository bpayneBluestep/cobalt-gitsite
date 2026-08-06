import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <section className="card">
      <h1>It deploys.</h1>
      <p>
        If you are reading this at <code>https://&lt;site-domain&gt;/spa/</code>,
        the GitSite pipeline worked end to end: the platform resolved the
        configured ref to a commit, validated the zipball, and materialized this
        build on the pod filesystem.
      </p>

      <p>
        This page is a static SPA built with Vite + React and its base path set
        to <code>/spa/</code>. Nothing here runs on a server — the repository{' '}
        <em>is</em> the deploy artifact.
      </p>

      <h2>Prove client-side routing</h2>
      <ol>
        <li>
          Click <Link to="/status">Status</Link> — the URL becomes{' '}
          <code>/spa/status</code> with no full page load.
        </li>
        <li>
          Now <strong>hard-refresh</strong> that URL. The server has no{' '}
          <code>/spa/status</code> file, but because the path has no file
          extension it falls back to <code>index.html</code> and this SPA
          re-renders the route. That fallback is the whole point.
        </li>
      </ol>
    </section>
  )
}
