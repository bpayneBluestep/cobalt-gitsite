import raw from './schema.json'

export interface Field {
  fieldId: string
  label: string
  columnName: string
  dbColumnName: string | null
  fieldType: string
}

/** 'attached' means the link is real but the platform wouldn't tell us whether
 *  the form is required or optional for that type. */
export type Requirement = 'base' | 'required' | 'optional' | 'attached'

export interface FormUse {
  recordTypeId: string
  requirement: Requirement
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
  /** The type's identity form. Not a parent/child link — read separately. */
  baseFormId: string | null
  /** Label of the field used as the record's title. */
  displayFieldLabel: string | null
  requiredForms: string[]
  optionalForms: string[]
  /** Forms linked to this type whose requirement the platform wouldn't report. */
  attachedForms: string[]
  /** False when the type exists but list_record_types omits it — the signature of
   *  a record type with no base form wired yet. */
  inList: boolean
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
export function formsForType(t: RecordType): Array<{ form: Form; requirement: Requirement }> {
  const out: Array<{ form: Form; requirement: Requirement }> = []
  const groups: Array<[Requirement, string[]]> = [
    ['base', t.baseFormId ? [t.baseFormId] : []],
    ['required', t.requiredForms],
    ['optional', t.optionalForms],
    ['attached', t.attachedForms],
  ]
  const taken = new Set<string>()
  for (const [requirement, ids] of groups) {
    for (const id of ids) {
      if (taken.has(id)) continue
      const form = formById.get(id)
      if (form) { taken.add(id); out.push({ form, requirement }) }
    }
  }
  return out.sort((a, b) => byName(a.form, b.form))
}

export const formCount = (t: RecordType): number =>
  new Set([
    ...(t.baseFormId ? [t.baseFormId] : []),
    ...t.requiredForms, ...t.optionalForms, ...t.attachedForms,
  ]).size

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
