import { Link } from 'react-router-dom'
import { useSession } from '../session'

/*
 * What you see instead of a section you cannot reach.
 *
 * It answers the three questions someone in this position actually has — what did I try
 * to open, what do I hold, and who can change it — and then points at something that does
 * work. An empty page or a bare "Forbidden" makes a person wonder whether the app is
 * broken, and they ask a colleague instead of asking the one person who can fix it.
 *
 * Roles are listed rather than summarised on purpose: seeing "you hold: Sales" next to
 * "this needs Leadership" explains the situation completely, with nothing left to guess.
 */

export default function NoAccess({ what, needs }: { what: string; needs?: string }) {
  const { roles, session } = useSession()

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Cobalt</p>
        <h1>{what} is not yours to open</h1>
        <p className="page__sub-text">
          Your roles decide which parts of Cobalt you can reach. This one is not among them.
        </p>
      </header>

      <div className="noaccess">
        <dl className="noaccess__facts">
          <div>
            <dt>You are</dt>
            <dd>{session?.fullName || 'signed in'}</dd>
          </div>
          <div>
            <dt>You hold</dt>
            <dd>
              {roles.length
                ? roles.map(r => <span className="rolechip" key={r}>{r}</span>)
                : <span className="noaccess__none">no roles yet</span>}
            </dd>
          </div>
          {needs && (
            <div>
              <dt>This needs</dt>
              <dd className="noaccess__needs">{needs}</dd>
            </div>
          )}
        </dl>

        <p className="noaccess__fix">
          {roles.length
            ? 'If that looks wrong, someone in Leadership can change it on Settings → Users.'
            : 'Ask someone in Leadership to set your roles on Settings → Users. Until then almost ' +
              'everything here will be closed to you.'}
        </p>

        <p className="noaccess__go">
          <Link className="uc__link" to="/">Back to Home</Link>
        </p>
      </div>
    </section>
  )
}
