import { NavLink } from 'react-router-dom'
import { baseTypes, childrenOf, orphanCategories, type RecordType } from '../schema'

function TypeRow({ t, depth }: { t: RecordType; depth: number }) {
  const formCount = t.requiredForms.length + t.optionalForms.length

  return (
    <li>
      <NavLink
        to={`/type/${encodeURIComponent(t.topId)}`}
        className="typerow"
        data-depth={depth}
        data-kind={t.baseType ? 'base' : 'category'}
      >
        <span className="typerow__mark" aria-hidden="true" />
        <span className="typerow__name">{t.displayName}</span>
        {t.status === 'partial' && (
          <span className="tag tag--warn" title="The platform could not return this type's form list">
            partial
          </span>
        )}
        {formCount > 0 && <span className="typerow__count">{formCount}</span>}
      </NavLink>
      {childrenOf(t).length > 0 && (
        <ul className="typetree__children">
          {childrenOf(t).map(c => <TypeRow key={c.topId} t={c} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  )
}

export default function TypeTree() {
  return (
    <nav className="typetree" aria-label="Record types">
      <ul>
        {baseTypes.map(t => <TypeRow key={t.topId} t={t} depth={0} />)}
      </ul>

      {orphanCategories.length > 0 && (
        <div className="typetree__orphans">
          <h3 className="eyebrow">Unplaced categories</h3>
          <p className="note">
            These are categories, but the platform did not return a parent for them,
            so their place in the hierarchy is unknown.
          </p>
          <ul>
            {orphanCategories.map(t => <TypeRow key={t.topId} t={t} depth={0} />)}
          </ul>
        </div>
      )}
    </nav>
  )
}
