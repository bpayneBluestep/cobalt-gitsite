import { Link } from 'react-router-dom'
import { REPORTS } from '../reports'
import { useSession } from '../session'

/*
 * The Reports directory.
 *
 * A card per report: its name, the question it answers, and what it draws on. No
 * figures, no previews, no "at a glance" strip - this page exists to get you to the
 * right report, and a dashboard-of-dashboards would make it a thing to read rather
 * than a thing to pass through.
 *
 * A report the signed-in person cannot open is not shown at all. Listing it and then
 * refusing at the door would advertise what they are missing to no purpose; the section
 * itself is already gated, so anyone here can see at least one.
 */
export default function Reports() {
  const { can } = useSession()
  const visible = REPORTS.filter(r => !r.needs || can(r.needs))

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Reports</h1>
          <p className="page__sub">
            The numbers the company runs on, pulled from the records rather than a
            spreadsheet.
          </p>
        </div>
      </header>

      {visible.length === 0 ? (
        <p className="muted">No reports are available to your roles yet.</p>
      ) : (
        <ul className="rcards">
          {visible.map(r => (
            <li key={r.key} className="rcard">
              <Link to={r.path} className="rcard__hit">
                <h2 className="rcard__h">{r.name}</h2>
                <p className="rcard__d">{r.description}</p>
                {r.source && <p className="rcard__s">{r.source}</p>}
                <span className="rcard__go" aria-hidden="true">Open →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/*
        Said plainly rather than mocked up as greyed-out cards. A placeholder card is a
        promise with a date on it; a sentence is an honest statement of what is not here.
      */}
      <p className="rcards__next muted">
        Next up, in rough order: tickets opened against closed, pipeline by stage and
        value, and where tickets actually sit and wait.
      </p>
    </section>
  )
}
