import { Link } from 'react-router-dom'
import type { Section } from '../sections'

/*
 * The placeholder for a section that is not built yet.
 *
 * It says three things, in this order, because that is the order someone landing
 * here wants them: what this section is for, what is already in place that it will
 * use, and where to go instead right now. No progress bars and no dates: an
 * invented percentage is worse than an honest "not yet".
 */

export default function UnderConstruction({ section }: { section: Section }) {
  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Cobalt</p>
        <h1>{section.label}</h1>
        <p className="page__sub-text">{section.purpose}</p>
      </header>

      <div className="uc">
        <p className="uc__flag">Under construction</p>
        <p className="uc__lede">
          This section is a placeholder. Nothing here is stored or read yet.
        </p>

        <div className="uc__cols">
          <div className="uc__col">
            <h2 className="uc__h">What will live here</h2>
            <ul className="uc__list">
              {section.planned.map(item => <li key={item}>{item}</li>)}
            </ul>
          </div>

          {section.foundation && (
            <div className="uc__col">
              <h2 className="uc__h">Already in place</h2>
              <p className="uc__note">{section.foundation}</p>
            </div>
          )}
        </div>
      </div>

      {section.live && section.live.length > 0 && (
        <div className="uc__live">
          <h2 className="uc__h">Working today</h2>
          <ul className="uc__links">
            {section.live.map(l => (
              <li key={l.to}>
                <Link className="uc__link" to={l.to}>{l.label}</Link>
                <span className="uc__linknote">{l.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
