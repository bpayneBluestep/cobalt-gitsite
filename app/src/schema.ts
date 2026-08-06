import raw from './schema.json'

export interface Field {
  fieldId: string
  label: string
  columnName: string
  dbColumnName: string | null
  fieldType: string
}

export interface FormUse {
  recordTypeId: string
  requirement: 'required' | 'optional'
}

export interface Form {
  topId: string
  displayName: string
  singleEntry: boolean | null
  fieldCount: number | null
  fields: Field[]
  status: 'ok' | 'error'
  error: string | null
  usedBy: FormUse[]
}

export interface RecordType {
  topId: string
  name: string
  displayName: string
  description: string | null
  baseType: boolean
  displayOrder: number
  parents: string[]
  subTypes: string[]
  requiredForms: string[]
  optionalForms: string[]
  status: 'ok' | 'partial'
  error: string | null
}

export interface Schema {
  org: string
  extractedAt: string
  source: string
  stats: {
    recordTypes: number
    baseTypes: number
    categories: number
    forms: number
    fields: number
    unlinkedForms: number
    fieldTypeCounts: Record<string, number>
  }
  recordTypes: RecordType[]
  forms: Form[]
  warnings: string[]
}

export const schema = raw as unknown as Schema

export const formById = new Map(schema.forms.map(f => [f.topId, f]))
export const typeById = new Map(schema.recordTypes.map(t => [t.topId, t]))

const byName = (a: { displayName: string }, b: { displayName: string }) =>
  a.displayName.localeCompare(b.displayName)

export const baseTypes = schema.recordTypes.filter(t => t.baseType).sort(byName)

/** Categories whose parent link never resolved — the platform lookup failed for
 *  them or for their base type, so we cannot place them in the tree. Surfaced in
 *  the UI rather than hidden, so the gap is visible instead of looking like
 *  "this org has no staff type". */
export const orphanCategories = schema.recordTypes
  .filter(t => !t.baseType && !t.parents.some(p => typeById.has(p)))
  .sort(byName)

export const childrenOf = (t: RecordType): RecordType[] =>
  t.subTypes.map(id => typeById.get(id)).filter((x): x is RecordType => !!x).sort(byName)

/** Every form a record type touches, with how it is attached. */
export function formsForType(t: RecordType): Array<{ form: Form; requirement: 'required' | 'optional' }> {
  const out: Array<{ form: Form; requirement: 'required' | 'optional' }> = []
  for (const id of t.requiredForms) {
    const form = formById.get(id)
    if (form) out.push({ form, requirement: 'required' })
  }
  for (const id of t.optionalForms) {
    const form = formById.get(id)
    if (form) out.push({ form, requirement: 'optional' })
  }
  return out.sort((a, b) => byName(a.form, b.form))
}

export const allForms = [...schema.forms].sort(byName)
export const unattachedForms = allForms.filter(f => f.usedBy.length === 0)

export interface FieldHit {
  form: Form
  field: Field
}

/** Search forms by name, and fields by label / column name / db column / id.
 *  Matching a field is how you answer "which form owns C1611?". */
export function search(query: string): { forms: Form[]; fieldHits: FieldHit[] } {
  const q = query.trim().toLowerCase()
  if (!q) return { forms: allForms, fieldHits: [] }

  const forms = allForms.filter(f => f.displayName.toLowerCase().includes(q))
  const formIds = new Set(forms.map(f => f.topId))
  const fieldHits: FieldHit[] = []

  for (const form of allForms) {
    for (const field of form.fields) {
      const hit =
        field.label.toLowerCase().includes(q) ||
        field.columnName.toLowerCase().includes(q) ||
        (field.dbColumnName || '').toLowerCase().includes(q) ||
        field.fieldId.toLowerCase().includes(q) ||
        field.fieldType.toLowerCase().includes(q)
      if (hit) fieldHits.push({ form, field })
    }
  }

  // A form whose fields matched is worth showing even if its name did not.
  for (const hit of fieldHits) {
    if (!formIds.has(hit.form.topId)) {
      formIds.add(hit.form.topId)
      forms.push(hit.form)
    }
  }

  return { forms: forms.sort(byName), fieldHits }
}

export function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
