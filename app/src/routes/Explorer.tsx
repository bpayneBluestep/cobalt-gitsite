import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import TypeTree from '../components/TypeTree'
import FormList, { type FormRow } from '../components/FormList'
import FieldTable from '../components/FieldTable'
import CompositionBar from '../components/CompositionBar'
import CopyId from '../components/CopyId'
import { pigment, typeTally } from '../pigments'
import {
  schema, formById, typeById, formsForType, allForms, unattachedForms, search,
  childrenOf, formatWhen, type RecordType, type FieldHit,
} from '../schema'

function TypeDetail({ t }: { t: RecordType }) {
  const parents = t.parents.map(id => typeById.get(id)).filter(Boolean) as RecordType[]
  const kids = childrenOf(t)

  return (
    <>
      <header className="detail__head">
        <p className="eyebrow">{t.baseType ? 'Base record type' : 'Category'}</p>
        <h2>{t.displayName}</h2>
        {t.description && <p className="detail__desc">{t.description}</p>}
      </header>

      <dl className="facts">
        <div><dt>Internal name</dt><dd><code>{t.name}</code></dd></div>
        <div><dt>Top id</dt><dd><CopyId value={t.topId} label="record type id" /></dd></div>
        {parents.length > 0 && (
          <div>
            <dt>Extends</dt>
            <dd>{parents.map(p => (
              <Link key={p.topId} to={`/schema/type/${encodeURIComponent(p.topId)}`} className="inlink">{p.displayName}</Link>
            ))}</dd>
          </div>
        )}
        {kids.length > 0 && (
          <div>
            <dt>Categories</dt>
            <dd className="facts__wrap">{kids.map(k => (
              <Link key={k.topId} to={`/schema/type/${encodeURIComponent(k.topId)}`} className="inlink">{k.displayName}</Link>
            ))}</dd>
          </div>
        )}
      </dl>

      {!t.inList && (
        <div className="callout">
          <p className="callout__title">No base form wired yet</p>
          <p>
            <strong>{t.displayName}</strong> exists, but the platform's own record-type
            list leaves it out — the signature of a type with no base form set. It was
            recovered from the relationship graph, which is where everything in this
            tree comes from. Set a base form and display field on it in Relate admin and
            it will appear normally.
          </p>
        </div>
      )}

      {t.status === 'partial' && (
        <div className="callout">
          <p className="callout__title">Required vs optional unknown</p>
          <p>
            The platform threw rather than returning this type's form list, so its forms
            are shown as <strong>attached</strong> without saying which are required. The
            links themselves are accurate — they come from the relationship graph, not
            from this call. It throws for any type with no required form, including the
            built-in Individual and Organization.
          </p>
          <pre className="callout__pre">{t.error}</pre>
        </div>
      )}
    </>
  )
}

function Overview() {
  const tally = typeTally(schema.stats.fieldTypeCounts)

  return (
    <>
      <header className="detail__head">
        <p className="eyebrow">Legend</p>
        <h2>Field types in this org</h2>
        <p className="detail__desc">
          Each type has a fixed pigment. The stripe on every form card is that form's
          field types by share, so you can read its makeup before opening it.
        </p>
      </header>

      <ul className="legend">
        {tally.map(([type, n]) => (
          <li key={type}>
            <span className="legend__swatch" style={{ background: pigment(type) }} aria-hidden="true" />
            <span className="legend__name">{type}</span>
            <span className="legend__n">{n}</span>
          </li>
        ))}
      </ul>

      <h3 className="eyebrow eyebrow--section">Widest forms</h3>
      <ul className="widest">
        {[...allForms].sort((a, b) => b.fields.length - a.fields.length).slice(0, 6).map(f => (
          <li key={f.topId}>
            <Link to={`/schema/form/${encodeURIComponent(f.topId)}`} className="widest__row">
              <span className="widest__name">{f.displayName}</span>
              <span className="widest__bar"><CompositionBar fields={f.fields} height={10} /></span>
              <span className="widest__n">{f.fields.length}</span>
            </Link>
          </li>
        ))}
      </ul>

      {schema.warnings.length > 0 && (
        <div className="callout">
          <p className="callout__title">
            {schema.warnings.length} note{schema.warnings.length === 1 ? '' : 's'} from the extract
          </p>
          <p>
            Where a platform call refused to answer, the structure was read from the
            relationship graph instead — so the tree and the form links are complete.
            These say what had to be worked around.
          </p>
          <ul className="callout__list">
            {schema.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
    </>
  )
}

export default function Explorer() {
  const { typeId, formId } = useParams()
  const [query, setQuery] = useState('')
  const [onlyUnattached, setOnlyUnattached] = useState(false)

  const selectedType = typeId ? typeById.get(decodeURIComponent(typeId)) : undefined
  const selectedForm = formId ? formById.get(decodeURIComponent(formId)) : undefined

  const { rows, heading, emptyMessage, fieldHits } = useMemo((): {
    rows: FormRow[]; heading: string; emptyMessage: string; fieldHits: FieldHit[]
  } => {
    if (query.trim()) {
      const { forms, fieldHits: hits } = search(query)
      return {
        rows: forms.map(form => ({ form })),
        heading: `${forms.length} form${forms.length === 1 ? '' : 's'} matching “${query.trim()}”`,
        emptyMessage: `Nothing matches “${query.trim()}”. Search covers form names, field labels, column names, and ids.`,
        fieldHits: hits,
      }
    }
    if (onlyUnattached) {
      return {
        rows: unattachedForms.map(form => ({ form })),
        heading: `${unattachedForms.length} form${unattachedForms.length === 1 ? '' : 's'} not attached to a record type`,
        emptyMessage: 'Every form is attached to at least one record type.',
        fieldHits: [],
      }
    }
    if (selectedType) {
      const attached = formsForType(selectedType)
      return {
        rows: attached.map(({ form, requirement }) => ({ form, requirement })),
        heading: `${attached.length} form${attached.length === 1 ? '' : 's'} on ${selectedType.displayName}`,
        emptyMessage: 'No forms are attached to this record type.',
        fieldHits: [],
      }
    }
    return {
      rows: allForms.map(form => ({ form })),
      heading: `All ${allForms.length} form${allForms.length === 1 ? '' : 's'}`,
      emptyMessage: 'This org has no forms.',
      fieldHits: [],
    }
  }, [query, onlyUnattached, selectedType])

  return (
    <div className="schemapage">
      <div className="schemabar">
        <span className="schemabar__title">Schema</span>
        <dl className="stats" aria-label="Schema totals">
          <div><dt>Record types</dt><dd>{schema.stats.recordTypes}</dd></div>
          <div><dt>Forms</dt><dd>{schema.stats.forms}</dd></div>
          <div><dt>Fields</dt><dd>{schema.stats.fields}</dd></div>
        </dl>
        <span className="schemabar__stamp">
          Snapshot of <code>{schema.org}</code> · {formatWhen(schema.extractedAt)} · regenerate with{' '}
          <code>npm run extract-schema</code>
        </span>
      </div>

      <div className="explorer">
      <section className="pane pane--types" aria-labelledby="pane-types">
        <h2 className="pane__title" id="pane-types">Record types</h2>
        <p className="pane__sub">
          {schema.stats.baseTypes} base · {schema.stats.categories} categories
        </p>
        <TypeTree />
      </section>

      <section className="pane pane--forms" aria-labelledby="pane-forms">
        <h2 className="pane__title" id="pane-forms">Forms</h2>

        <div className="search">
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search forms, fields, C-columns, ids"
            aria-label="Search forms and fields"
          />
          {query && (
            <button type="button" className="search__clear" onClick={() => setQuery('')}>Clear</button>
          )}
        </div>

        <div className="filters">
          <button
            type="button"
            className="filter"
            data-on={onlyUnattached || undefined}
            onClick={() => setOnlyUnattached(v => !v)}
          >
            Unattached only
            <span className="filter__n">{unattachedForms.length}</span>
          </button>
          {(selectedType || onlyUnattached || query) && (
            <Link to="/schema" className="filter filter--reset" onClick={() => { setQuery(''); setOnlyUnattached(false) }}>
              Reset
            </Link>
          )}
        </div>

        <p className="pane__sub pane__sub--result">{heading}</p>
        <FormList rows={rows} emptyMessage={emptyMessage} />

        {fieldHits.length > 0 && (
          <>
            <h3 className="eyebrow eyebrow--section">
              {fieldHits.length} matching field{fieldHits.length === 1 ? '' : 's'}
            </h3>
            <ul className="hits">
              {fieldHits.slice(0, 40).map(({ form, field }) => (
                <li key={`${form.topId}:${field.fieldId}`}>
                  <Link to={`/schema/form/${encodeURIComponent(form.topId)}`} className="hit">
                    <span className="hit__spine" style={{ background: pigment(field.fieldType) }} aria-hidden="true" />
                    <span className="hit__label">{field.label || field.columnName}</span>
                    {field.dbColumnName && <code className="hit__db">{field.dbColumnName}</code>}
                    <span className="hit__form">{form.displayName}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {fieldHits.length > 40 && (
              <p className="note">Showing the first 40 of {fieldHits.length}. Narrow the search to see the rest.</p>
            )}
          </>
        )}
      </section>

      <section className="pane pane--detail" aria-labelledby="pane-detail">
        <h2 className="pane__title visually-hidden" id="pane-detail">Detail</h2>

        {selectedForm ? (
          <>
            <header className="detail__head">
              <p className="eyebrow">Form</p>
              <h2>{selectedForm.displayName}</h2>
              <p className="detail__desc">
                {selectedForm.fields.length} field{selectedForm.fields.length === 1 ? '' : 's'}
                {' · '}
                {selectedForm.singleEntry === null ? 'entry mode unknown'
                  : selectedForm.singleEntry ? 'single entry' : 'multi entry'}
              </p>
              <CompositionBar fields={selectedForm.fields} height={10} />
            </header>

            <dl className="facts">
              <div><dt>Top id</dt><dd><CopyId value={selectedForm.topId} label="form id" /></dd></div>
              <div>
                <dt>Used by</dt>
                <dd className="facts__wrap">
                  {selectedForm.usedBy.length === 0
                    ? <span className="muted">No record type attaches this form</span>
                    : selectedForm.usedBy.map(u => {
                      const t = typeById.get(u.recordTypeId)
                      return t ? (
                        <Link key={u.recordTypeId} to={`/schema/type/${encodeURIComponent(t.topId)}`} className="inlink">
                          {t.displayName}
                          <span className="tag" data-req={u.requirement}>{u.requirement}</span>
                        </Link>
                      ) : null
                    })}
                </dd>
              </div>
            </dl>

            {selectedForm.status === 'error' ? (
              <div className="callout">
                <p className="callout__title">Fields unavailable</p>
                <pre className="callout__pre">{selectedForm.error}</pre>
              </div>
            ) : (
              <FieldTable fields={selectedForm.fields} highlight={query} />
            )}
          </>
        ) : selectedType ? (
          <TypeDetail t={selectedType} />
        ) : (
          <Overview />
        )}
      </section>
      </div>
    </div>
  )
}
