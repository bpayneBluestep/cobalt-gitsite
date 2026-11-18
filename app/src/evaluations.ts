import { maestroGet, maestroPost } from './api'

/*
 * Quarterly Evaluations: the client half of §6s in the Maestro.
 *
 * One evaluation LOG per person per quarter, on their staff record. A log holds the
 * person's self-assessment (sent to them as a link), their supervisor's answers to the
 * same questions, and the formal one-page evaluation. The rubric comes from the server
 * on every read, so the wording has exactly one home.
 */

export interface RubricValue {
  key: string
  name: string
  summary: string
  levels: Record<string, string>
}

export interface Rubric {
  version: number
  instructions: string
  scale: { score: number; label: string; meaning: string }[]
  values: RubricValue[]
}

export interface Answer { key: string; name: string; score: number | null; reason: string }
export interface Answers {
  rubricVersion: number
  values: Answer[]
  /** Areas you're proud of. */
  proud: string
  /** Areas for improvement. */
  improve: string
  unreadable?: boolean
}

/** One side's full submission: the five scored values plus the two reflections. */
export interface SideInput { values: AnswerInput[]; proud: string; improve: string }

export type SelfStatus = 'Not Sent' | 'Sent' | 'In Progress' | 'Submitted'
export type SupStatus = 'Not Started' | 'In Progress' | 'Submitted'

export interface Evaluation {
  entryId: string
  staffId: string
  quarter: string
  self: {
    status: SelfStatus
    sentAt: string
    sentBy: string
    submittedAt: string
    answers: Answers
    /** Reviewers only, once sent. */
    link?: string
  }
  /** Reviewers only. The person never receives these. */
  supervisor?: { status: SupStatus; by: string; submittedAt: string; answers: Answers }
  formalEvaluation?: { hasFile: boolean; filename: string; url: string; uploaded: string }
}

export interface EvaluationList {
  staffId: string
  name: string
  isSelf: boolean
  isReviewer: boolean
  defaultQuarter: string
  rubric: Rubric
  rows: Evaluation[]
}

export interface EvaluationDetail {
  evaluation: Evaluation
  name: string
  isSelf: boolean
  isReviewer: boolean
  can: { editSelf: boolean; editSupervisor: boolean; sendSelf: boolean; reopen: boolean; attach: boolean }
  rubric: Rubric
}

export interface AnswerInput { key: string; score: number | null; reason: string }

export const getEvaluations = (staffId: string): Promise<EvaluationList> =>
  maestroGet('evaluations', { staffId })

export const getEvaluation = (staffId: string, entryId: string): Promise<EvaluationDetail> =>
  maestroGet('evaluation', { staffId, entryId })

export const createEvaluation = (staffId: string, quarter: string):
  Promise<{ evaluation: Evaluation; created: boolean }> =>
  maestroPost('createEvaluation', { staffId, quarter })

export const sendSelfAssessment = (staffId: string, entryId: string):
  Promise<{ link: string; evaluation: Evaluation }> =>
  maestroPost('sendSelfAssessment', { staffId, entryId })

export const saveSelfAssessment = (staffId: string, entryId: string, side: SideInput, submit: boolean):
  Promise<EvaluationDetail> =>
  maestroPost('saveSelfAssessment', { staffId, entryId, ...side, submit })

export const saveSupervisorAssessment = (staffId: string, entryId: string, side: SideInput, submit: boolean):
  Promise<EvaluationDetail> =>
  maestroPost('saveSupervisorAssessment', { staffId, entryId, ...side, submit })

export const reopenEvaluation = (staffId: string, entryId: string, side: 'self' | 'supervisor'):
  Promise<EvaluationDetail> =>
  maestroPost('reopenEvaluation', { staffId, entryId, side })

export const attachFormalEvaluation = (
  staffId: string, entryId: string, file: { fileName: string; mimeType: string; dataBase64: string },
): Promise<EvaluationDetail> =>
  maestroPost('attachFormalEvaluation', { staffId, entryId, ...file })

export const removeFormalEvaluation = (staffId: string, entryId: string): Promise<EvaluationDetail> =>
  maestroPost('removeFormalEvaluation', { staffId, entryId })

export const deleteEvaluation = (staffId: string, entryId: string): Promise<{ deleted: boolean }> =>
  maestroPost('deleteEvaluation', { staffId, entryId })

/** "2026-11-18T16:09:11.28-07:00[US/Mountain]" -> "Nov 18, 2026". Blank stays blank. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  if (!m) return iso || ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Answers keyed by value, with every rubric value present (blank where unanswered). */
export function answerMap(rubric: Rubric, answers: Answers | undefined): Record<string, AnswerInput> {
  const out: Record<string, AnswerInput> = {}
  for (const v of rubric.values) out[v.key] = { key: v.key, score: null, reason: '' }
  for (const a of answers?.values || []) {
    if (out[a.key]) out[a.key] = { key: a.key, score: a.score, reason: a.reason || '' }
  }
  return out
}

export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      // Cut at ";base64," rather than the first comma: a data: URL's media type can
      // itself contain commas, and splitting there corrupts the payload.
      const i = s.indexOf(';base64,')
      resolve(i >= 0 ? s.slice(i + 8) : s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error || new Error('Could not read the file.'))
    r.readAsDataURL(f)
  })
}
