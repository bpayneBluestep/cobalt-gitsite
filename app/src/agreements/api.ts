/*
 * Agreements API — the typed seam between the agreements UI and Cobalt Maestro.
 *
 * Every action here was ported from the eccrm envelope system and verified
 * end-to-end on this org (see U142140/Cobalt Maestro). Envelope actions address
 * a COMPANY record by `id`; template actions address the per-unit Organization
 * records ("Behavioral", "Assisted Living") — a template carries `orgId`/`orgName`
 * saying which unit's library it lives in, and creating one targets a library
 * with `orgId`.
 */

import { maestroGet, maestroPost } from '../api'

export interface EnvDoc {
  id: string; name: string; order: number; sourceUrl: string
  fileEntryId?: string; pages: number; kind: string
  signedUrl?: string; signedHash?: string
}

export interface EnvRecipient {
  id: string; role: string; name: string; email: string
  kind: 'external' | 'consultant' | 'inperson' | 'cc'
  routingOrder: number; status: string; signedAt: string
  typedName: string; signatureData: string; tabValues: Record<string, unknown>
  hasToken: boolean
  notifiedAt?: string; viewedAt?: string; declinedAt?: string; declineReason?: string
  accessCode?: string; disclosureVersion?: string; disclosureAcceptedAt?: string
  progress?: { tabValues: Record<string, unknown>; typedName: string; hasAdopted: boolean } | null
}

export interface EnvTab {
  id: string; docId: string; page: number
  x: number; y: number; w: number; h: number
  type: string; recipientId: string
  required: boolean; label: string; options: string[]
  source?: string
}

export interface Envelope {
  entryId: string; schemaVersion: number; title: string; status: string
  sentAt: string; completedAt: string; voidReason: string; createdBy: string; createdAt: string
  signedPdf: string; documents: EnvDoc[]; tabs: EnvTab[]; anchors: unknown[]
  recipients: EnvRecipient[]; audit: unknown[]
  routing?: string; expiresAt?: string; expireDays?: number; remindEveryDays?: number
  activeOrder?: number; senderName?: string; senderValues?: Record<string, unknown>
  disclosure?: { version: string; text: string } | null
  notified?: unknown[]
  /** 'company' or 'org' (standalone): where the server found this envelope. */
  hostEntity?: 'company' | 'org'
}

export interface EnvelopeListRow {
  entryId: string; title: string; status: string; legacy: boolean
  sentAt: string; completedAt: string; createdAt: string; signedPdf: string
  docCount: number
  recipients: { name: string; kind: string; status: string }[]
}

export interface AgreementTemplate {
  entryId: string; orgId: string; orgName: string
  name: string; description: string; status: string; category: string
  version: string; createdBy: string; createdAt: string; updatedAt: string
  bodyJson: {
    schemaVersion: number
    documents: EnvDoc[]
    roles: { id: string; name: string; optional?: boolean }[]
    tabs: EnvTab[]
    anchors?: unknown[]
  } | null
}

export interface VerifyResult {
  chained: number
  unchainedLegacy: number
  firstBreak: { index: number; event: string; at: string; reason: string } | null
  documentHash: { stored: string; match: boolean | null } | null
}

// ---------------------------------------------------------------- report

export interface AgreementsReportRecipient {
  name: string; email?: string; role?: string; kind: string; routingOrder: number
  status: string; notifiedAt?: string; viewedAt?: string; signedAt?: string
  declinedAt?: string; declineReason?: string
}

export interface AgreementsReportRow {
  entryId: string; companyId: string; companyName: string
  /** 'company' (+ the company id) or 'org' (+ the Organization record id) for a standalone envelope. */
  hostEntity?: 'company' | 'org'; hostId?: string
  title: string; status: string; legacy: boolean
  createdAt: string; createdBy: string; senderName: string
  sentAt: string; completedAt: string; voidReason: string
  expiresAt: string; lastReminderAt: string; routing: string
  dealId: string; signedPdf: string; docCount: number; lastActivityAt: string
  recipients: AgreementsReportRecipient[]
  /** Who the envelope is blocked on right now (sequential: the active routing order only). */
  waitingOn: AgreementsReportRecipient[]
  error?: string
}

export interface AgreementsReport {
  generatedAt: string; companies: number; standalone?: number; total: number; rows: AgreementsReportRow[]
}

/** Every envelope on every company, for Reports > Agreements. */
export const getAgreementsReport = (): Promise<AgreementsReport> => maestroGet('agreementsReport')

// ---------------------------------------------------------------- envelopes

/**
 * Where an envelope lives. A plain string is a company id (every existing caller);
 * `{ entity: 'org', id }` is a STANDALONE envelope on an Organization record, sent
 * from Reports > Agreements with no company attached (Leadership + Sales only).
 * The server also resolves a plain id that matches no company to the org records,
 * which is how the in-app sign / designer routes reach a standalone envelope.
 */
export type EnvHost = string | { entity: 'company' | 'org'; id: string }
const hp = (h: EnvHost): { id: string; entity?: string } =>
  typeof h === 'string' ? { id: h } : { id: h.id, entity: h.entity }
export const hostId = (h: EnvHost): string => (typeof h === 'string' ? h : h.id)

export const listEnvelopes = (host: EnvHost): Promise<EnvelopeListRow[]> =>
  maestroGet('listEnvelopes', { ...hp(host) })

export const getEnvelope = (host: EnvHost, entryId: string): Promise<Envelope> =>
  maestroGet('getEnvelope', { ...hp(host), entryId })

export const createEnvelope = (host: EnvHost, title: string): Promise<Envelope> =>
  maestroPost('createEnvelope', { ...hp(host), title })

export const uploadEnvelopeDoc = (
  host: EnvHost, entryId: string, name: string, dataBase64: string, pages: number,
): Promise<Envelope> =>
  maestroPost('uploadEnvelopeDoc', { ...hp(host), entryId, name, dataBase64, pages })

export const removeEnvelopeDoc = (host: EnvHost, entryId: string, docId: string): Promise<Envelope> =>
  maestroPost('removeEnvelopeDoc', { ...hp(host), entryId, docId })

export const reorderEnvelopeDocs = (host: EnvHost, entryId: string, docIds: string[]): Promise<Envelope> =>
  maestroPost('reorderEnvelopeDocs', { ...hp(host), entryId, docIds })

export const setEnvelopeRecipients = (
  host: EnvHost, entryId: string, recipients: unknown[], title?: string,
): Promise<Envelope> =>
  maestroPost('setEnvelopeRecipients', { ...hp(host), entryId, recipients, title: title || '' })

export const saveEnvelopeTabs = (host: EnvHost, entryId: string, tabs: unknown[]): Promise<Envelope> =>
  maestroPost('saveEnvelopeTabs', { ...hp(host), entryId, tabs })

export const sendEnvelope = (
  host: EnvHost, entryId: string,
  opts?: { routing?: string; expireDays?: number; remindEveryDays?: number; senderValues?: Record<string, unknown> },
): Promise<Envelope> =>
  maestroPost('sendEnvelope', { ...hp(host), entryId, ...(opts || {}) })

export const resendEnvelope = (host: EnvHost, entryId: string, recipientId: string): Promise<Envelope> =>
  maestroPost('resendEnvelope', { ...hp(host), entryId, recipientId })

export const voidEnvelope = (host: EnvHost, entryId: string, reason: string): Promise<Envelope> =>
  maestroPost('voidEnvelope', { ...hp(host), entryId, reason })

export const deleteEnvelope = (host: EnvHost, entryId: string): Promise<{ ok: boolean }> =>
  maestroPost('deleteEnvelope', { ...hp(host), entryId })

export const verifyEnvelope = (host: EnvHost, entryId: string): Promise<VerifyResult> =>
  maestroGet('verifyEnvelope', { ...hp(host), entryId })

// In-app signing (consultant / in-person). The recipient id names who is signing;
// the server checks kind, turn and status — this is the same write path the
// public page's submit uses, minus the token (a session stands in for it).
export const saveEnvelopeProgress = (
  host: EnvHost, entryId: string, recipientId: string,
  tabValues: Record<string, unknown>, typedName: string, hasAdopted: boolean,
): Promise<{ ok: boolean; savedAt: string }> =>
  maestroPost('saveEnvelopeProgress', { ...hp(host), entryId, recipientId, tabValues, typedName, hasAdopted })

export const signEnvelope = (
  host: EnvHost, entryId: string, recipientId: string,
  signatureData: string, typedName: string, tabValues: Record<string, unknown>, initialsData: string,
): Promise<Envelope & { completed?: boolean }> =>
  maestroPost('signEnvelope', { ...hp(host), entryId, recipientId, signatureData, typedName, tabValues, initialsData })

// ---------------------------------------------------------------- templates

export const listAgreementTemplates = (): Promise<AgreementTemplate[]> =>
  maestroGet('listAgreementTemplates')

export const getAgreementTemplate = (entryId: string): Promise<AgreementTemplate> =>
  maestroGet('getAgreementTemplate', { entryId })

/** entryId null = create (orgId picks the unit library); set = update. */
export const saveAgreementTemplate = (
  entryId: string | null, fields: Record<string, unknown>, orgId?: string,
): Promise<AgreementTemplate> =>
  maestroPost('saveAgreementTemplate', { entryId: entryId || '', orgId: orgId || '', fields })

export const setAgreementTemplateStatus = (entryId: string, status: string): Promise<AgreementTemplate> =>
  maestroPost('setAgreementTemplateStatus', { entryId, status })

export const uploadTemplateDoc = (
  name: string, dataBase64: string, orgId?: string,
): Promise<{ url: string; name: string }> =>
  maestroPost('uploadTemplateDoc', { name, dataBase64, orgId: orgId || '' })

export const saveTemplateDesign = (
  entryId: string, tabs: unknown[], roles: unknown[], anchors: unknown[],
): Promise<{ ok: boolean; tabs: number; roles: number; anchors: number }> =>
  maestroPost('saveTemplateDesign', { entryId, tabs, roles, anchors })

// ---------------------------------------------------------------- shared bits

/** File -> raw base64 (no data: prefix). */
export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(f)
  })
}

/** ArrayBuffer -> base64, chunked so big PDFs don't blow the arg limit. */
export function bufToBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < u8.length; i += 8192) {
    bin += String.fromCharCode.apply(null, Array.prototype.slice.call(u8, i, Math.min(u8.length, i + 8192)))
  }
  return btoa(bin)
}

export const randomTabId = () => 't_' + Math.random().toString(36).slice(2, 10)
