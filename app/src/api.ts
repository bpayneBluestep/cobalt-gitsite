/*
 * The single seam between this SPA and the platform. Everything that reads or
 * writes data goes through the Cobalt Maestro endpoint as one action envelope:
 *
 *   request  GET  /b/maestro?action=<name>
 *            POST /b/maestro   { action, ...fields }
 *   reply    { ok: true, data } | { ok: false, error, detail }
 *
 * Same-origin fetch, so the BlueStep session cookie rides along automatically.
 * Matches the contract used by gitsite-spa-starter/src/api.ts.
 */

const MAESTRO_URL = '/b/maestro'

export class ApiError extends Error {
  code: string
  status: number
  /** True when the failure means "you aren't signed in", not "the call broke". */
  needsLogin: boolean

  constructor(message: string, opts: { code?: string; status?: number; needsLogin?: boolean } = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = opts.code || 'REQUEST_FAILED'
    this.status = opts.status ?? 0
    this.needsLogin = !!opts.needsLogin
  }
}

async function handle(res: Response): Promise<any> {
  let json: any = null
  try {
    json = await res.json()
  } catch {
    // Non-JSON means we never reached the endpoint's own code. Distinguish the
    // two ways that happens, because they need opposite fixes:
    //   * the platform bounced us to the login page  -> sign in
    //   * the endpoint itself failed before running   -> it isn't compiled
    // A 5xx is NOT a login problem, even though it also arrives as HTML.
    const bouncedToLogin = res.status === 401 || (res.redirected && res.status < 400)
    if (bouncedToLogin) {
      throw new ApiError('Sign in to BlueStep to load this data.', {
        code: 'AUTH_REQUIRED', status: res.status, needsLogin: true,
      })
    }
    if (res.status >= 500) {
      throw new ApiError(
        `The Maestro returned HTTP ${res.status} with a non-JSON body. A bare "Error" here ` +
        `means the endpoint exists on the platform but no compiled code is published — the ` +
        `live snapshot needs scripts/app.js, not just a draft.`,
        { code: 'NOT_PUBLISHED', status: res.status },
      )
    }
    throw new ApiError(
      `The Maestro returned a non-JSON response (HTTP ${res.status}).`,
      { code: 'NON_JSON', status: res.status },
    )
  }

  if (!json || json.ok !== true) {
    const code = json?.error || 'REQUEST_FAILED'
    const detail = json?.detail || `Request failed (HTTP ${res.status}).`
    throw new ApiError(detail, { code, status: res.status, needsLogin: code === 'AUTH_REQUIRED' })
  }
  return json.data
}

export async function maestroGet(action: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams({ action, ...params })
  let res: Response
  try {
    res = await fetch(`${MAESTRO_URL}?${qs}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    })
  } catch {
    throw new ApiError('Could not reach the Maestro. Check your connection.', { code: 'NETWORK' })
  }
  return handle(res)
}

export async function maestroPost(action: string, payload: Record<string, unknown> = {}): Promise<any> {
  let res: Response
  try {
    res = await fetch(MAESTRO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action, ...payload }),
    })
  } catch {
    throw new ApiError('Could not reach the Maestro. Check your connection.', { code: 'NETWORK' })
  }
  return handle(res)
}

// ---------------------------------------------------------------- typed actions

/**
 * A company as `companyRow` returns it — the whole Company Info catalog, including
 * the CRM half. The four `contact*` fields are a MIRROR of the primary contact, kept
 * in step by the endpoint, so every screen that shows a company gets the contact's
 * name without walking the Contacts form.
 */
export interface Company {
  id: string
  name: string
  website: string
  street: string
  city: string
  state: string
  postalCode: string
  categories: string[]

  contactName: string
  contactTitle: string
  contactEmail: string
  contactPhone: string
  owner: string
  leadSource: string
  leadStatus: string
  beds: number | null
  lastTouch: string
  nextFollowUp: string
  crmNotes: string
}

export interface CompanyList {
  category: string | null
  total: number
  rows: Company[]
}

export const getClients = (): Promise<CompanyList> => maestroGet('clients')

export const getCompanies = (category?: string): Promise<CompanyList> =>
  maestroGet('companies', category ? { category } : {})

export const getCompany = (id: string): Promise<Company> => maestroGet('company', { id })

export interface List {
  id: string
  listName: string
  desc: string
  clientId: string
  clientName: string
  kind: string
  archived: boolean
  isClientList: boolean
}

export interface NewClient {
  company: Company
  /** The client's list, created alongside. Null only if that second step failed. */
  list: List | null
  inClientCategory: boolean
  /** Set when the client was created but its list wasn't — the client still exists. */
  listError: string | null
}

/**
 * Add a client. This creates two records: the Company in the Client category and
 * its List, whose clientId points back at the company.
 */
export const createClient = (fields: Partial<Record<CompanyFieldKey, string>>): Promise<NewClient> =>
  maestroPost('createClient', { fields })

/** The fields a company record exposes for editing, in display order. */
export const COMPANY_FIELDS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'website', label: 'Website', placeholder: 'https://example.com' },
  { key: 'street', label: 'Street' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'postalCode', label: 'Postal code' },
] as const

export type CompanyFieldKey = (typeof COMPANY_FIELDS)[number]['key']

/**
 * The CRM half of Company Info.
 *
 * Kept separate from COMPANY_FIELDS because that list drives the record page's plain
 * text inputs, and these are not all text — two are dates and one is rich text. They
 * write through the same `updateCompany` action; only the rendering differs.
 */
export type CrmFieldKey =
  'contactName' | 'contactTitle' | 'contactEmail' | 'contactPhone' | 'owner'
  | 'leadSource' | 'leadStatus' | 'beds' | 'lastTouch' | 'nextFollowUp' | 'crmNotes'

/** Save only the keys that changed. The reply is the record as re-read server-side. */
export const updateCompany = (
  id: string,
  fields: Partial<Record<CompanyFieldKey | CrmFieldKey, string>>,
): Promise<Company> => maestroPost('updateCompany', { id, fields })

// ------------------------------------------------------------------- tickets
// Vocabulary and tab mapping match the beh "Clickup Killer" exactly. The endpoint
// is the authority — these are the client's copy for rendering controls, and the
// endpoint validates every write against its own list.

export const TICKET_STATUSES = ['Open', 'Up Next', 'In Progress', 'In Review', 'Complete'] as const
export const TICKET_PRIORITIES = ['Low', 'Normal', 'High', 'Critical'] as const

export const TICKET_TABS = [
  { key: 'open', label: 'Open', statuses: ['Open'] },
  { key: 'ready', label: 'Ready', statuses: ['Up Next'] },
  { key: 'current', label: 'Current', statuses: ['In Progress', 'In Review'] },
  { key: 'completed', label: 'Completed', statuses: ['Complete'] },
] as const

/** Priority order for sorting a group, highest first — beh's PRIORITY_RANK. */
export const PRIORITY_RANK: Record<string, number> = { Critical: 4, High: 3, Normal: 2, Low: 1 }

/** One row in a ticket's time log. Ids are stable — never address these by index. */
export interface TimeEntry {
  id: string
  date: string
  minutes: number
  who: string
  note: string
  billable: boolean
}

/** A file on a ticket. `url` is a same-origin /download/ path. */
export interface Attachment {
  id: string
  name: string
  url: string
  mime: string
  size: number
  at: string
  by: string
}

export interface Ticket {
  entryId: string
  /** Global running number. Null only for a ticket that predates numbering. */
  ticketNumber: number | null
  title: string
  status: string
  priority: string
  assignee: string
  dueDate: string
  sprint: string
  /** Rich text (HTML). Sanitise before rendering — see lib/html.ts. */
  details: string

  estHours: number | null
  /** Derived server-side from the time log; never written directly. */
  loggedHours: number | null
  time: TimeEntry[]
  timerRunning: boolean
  timerElapsedMinutes: number
  timerBy: string
  timerStartedAt: string

  attachments: Attachment[]

  roadblocked: boolean
  roadblockReason: string
  roadblockedAt: string
  roadblockedBy: string

  createdBy: string
  createdAt: string
  completedAt: string
  listId: string
  listName: string
  clientId: string
  clientName: string
}

export interface TicketList {
  statuses: string[]
  priorities: string[]
  listsScanned: number
  total: number
  rows: Ticket[]
}

/**
 * The ticket fields `addTicket` / `updateTicket` accept.
 *
 * Everything else a ticket carries is written through its own action, because the
 * value alone would leave the ticket inconsistent: a roadblock needs its reason and
 * stamps, and the time log and attachments are append-and-recompute rather than
 * overwrite. The endpoint enforces this — it is not a convention.
 */
export type TicketFieldKey =
  'title' | 'status' | 'priority' | 'assignee' | 'dueDate' | 'sprint' | 'details' | 'estHours'

export const getTickets = (params: { listId?: string; assignee?: string; sprint?: string; status?: string } = {}): Promise<TicketList> =>
  maestroGet('tickets', params as Record<string, string>)

export const getList = (id: string): Promise<List & { tickets: Ticket[] }> => maestroGet('list', { id })

export const getLists = (params: { clientId?: string; kind?: string } = {}): Promise<{ total: number; rows: List[] }> =>
  maestroGet('lists', params as Record<string, string>)

/** Create or find the list for a client — how a client's board comes into being. */
export const getClientList = (clientId: string): Promise<List & { created: boolean; tickets: Ticket[] }> =>
  maestroPost('clientList', { clientId })

export const addTicket = (listId: string, fields: Partial<Record<TicketFieldKey, string>>): Promise<Ticket> =>
  maestroPost('addTicket', { listId, fields })

export const updateTicket = (listId: string, entryId: string, fields: Partial<Record<TicketFieldKey, string>>): Promise<Ticket> =>
  maestroPost('updateTicket', { listId, entryId, fields })

export const deleteTicket = (listId: string, entryId: string): Promise<{ deleted: string; listId: string }> =>
  maestroPost('deleteTicket', { listId, entryId })

// ------------------------------------------------------- time, blocks, files
// Each of these returns the WHOLE ticket, re-read server-side — so a caller
// replaces its copy rather than patching it and hoping the patch matches.

type On = { listId: string; entryId: string }

/** Log time. Send `minutes` or `hours`, not both. */
export const logTime = (
  on: On,
  entry: { minutes?: number; hours?: number; date?: string; note?: string; billable?: boolean },
): Promise<Ticket> => maestroPost('logTime', { ...on, ...entry })

export const editTime = (
  on: On,
  entry: { timeId: string; minutes: number; date?: string; note?: string; billable?: boolean },
): Promise<Ticket> => maestroPost('editTime', { ...on, ...entry })

export const deleteTime = (on: On, timeId: string): Promise<Ticket> =>
  maestroPost('deleteTime', { ...on, timeId })

export const startTimer = (on: On): Promise<Ticket> => maestroPost('startTimer', on)

/** Stop the clock; the elapsed minutes become a log entry. */
export const stopTimer = (on: On, note?: string): Promise<Ticket & { loggedMinutes: number }> =>
  maestroPost('stopTimer', { ...on, note: note || '' })

export const setRoadblock = (on: On, active: boolean, reason?: string): Promise<Ticket> =>
  maestroPost('setRoadblock', { ...on, active, reason: reason || '' })

/** Max upload the endpoint accepts, so the UI can refuse before sending. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export const uploadAttachment = (
  on: On,
  file: { fileName: string; mimeType: string; dataBase64: string },
): Promise<Ticket> => maestroPost('uploadAttachment', { ...on, ...file })

export const deleteAttachment = (on: On, attachmentId: string): Promise<Ticket> =>
  maestroPost('deleteAttachment', { ...on, attachmentId })

// ------------------------------------------------------------------ formatting

/** Minutes as `1h 30m` / `45m` / `2h`. Used everywhere time is shown. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes || 0))
  if (!m) return '0m'
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (!h) return `${rest}m`
  if (!rest) return `${h}h`
  return `${h}h ${rest}m`
}

/** Hours as `3.5h`, or an em dash when there is no value at all. */
export function formatHours(hours: number | null): string {
  if (hours === null || hours === undefined) return '—'
  return `${Math.round(hours * 100) / 100}h`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

// ----------------------------------------------------------------------- crm
// Vocabularies match beh's CRM Intelligence Dashboard exactly — same phases, same
// lead sources, same loss reasons — so the two tools describe one pipeline the same
// way. The endpoint is the authority and validates every write against its own copy.

export const DEAL_PHASES = [
  'Open Lead', 'Contact Made', 'Scheduling Demo', 'Negotiating', 'Agreements', 'Won', 'Lost',
] as const

/** The phases a deal is still being worked in — the pipeline's columns. */
export const OPEN_PHASES = [
  'Open Lead', 'Contact Made', 'Scheduling Demo', 'Negotiating', 'Agreements',
] as const

export const DEAL_CONFIDENCE = ['Green', 'Yellow', 'Red'] as const
export const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Nurturing', 'Unqualified'] as const

export interface Deal {
  entryId: string
  title: string
  phase: string
  owner: string
  leadSource: string
  products: string
  productList: string[]
  mrr: number | null
  fees: number | null
  confidence: string
  anticipatedDate: string
  demoDate: string
  nextStep: string
  notes: string
  lossReason: string
  createdBy: string
  createdAt: string
  closedAt: string

  /** Derived server-side from the phase — never stored, so they cannot disagree. */
  isOpen: boolean
  isWon: boolean
  isLost: boolean
  probability: number
  annualValue: number
  weightedMrr: number

  companyId: string
  companyName: string
  companyCity: string
  companyState: string
  companyCategories: string[]
}

/** A company as the CRM sees it: Company Info plus its deal roll-up. */
export interface Lead extends Company {
  dealCount: number
  openDealCount: number
  wonDealCount: number
  lostDealCount: number
  hasOpenDeal: boolean
  /** No deal has ever been opened — a genuine first conversation. */
  neverWorked: boolean
  /** Has deals, but all decided — a re-approach, not a first call. */
  decidedOnly: boolean
  openMrr: number
  weightedMrr: number
  /** The furthest-along open phase, or '' when nothing is open. */
  phase: string
}

export interface LeadList {
  statuses: string[]
  sources: string[]
  categories: string[]
  total: number
  prospecting: number
  neverWorked: number
  decidedOnly: number
  inPipeline: number
  rows: Lead[]
}

export interface PipelineColumn {
  phase: string
  probability: number
  count: number
  mrr: number
  weightedMrr: number
  annualValue: number
  rows: Deal[]
}

export interface Pipeline {
  phases: string[]
  openPhases: string[]
  confidences: string[]
  sources: string[]
  products: string[]
  lossReasons: string[]
  owner: string | null
  companiesScanned: number
  openTotal: number
  columns: PipelineColumn[]
}

export interface CrmSummary {
  today: string
  counts: {
    companies: number; leads: number; clients: number
    prospecting: number; neverWorked: number
    openDeals: number; wonDeals: number; lostDeals: number
  }
  value: {
    openMrr: number; weightedMrr: number; openAnnualValue: number; wonMrr: number
    closingThisMonthCount: number; closingThisMonthMrr: number; averageOpenMrr: number
  }
  winRate: number | null
  byPhase: { phase: string; count: number; mrr: number; probability: number }[]
  bySource: { source: string; count: number; mrr: number }[]
  byOwner: { owner: string; openDeals: number; mrr: number; weightedMrr: number; won: number }[]
  losses: { reason: string; count: number }[]
  hot: Deal[]
  followUps: {
    companyId: string; companyName: string; owner: string; contactName: string
    leadStatus: string; nextFollowUp: string; lastTouch: string
    overdue: boolean; hasOpenDeal: boolean
  }[]
  overdueFollowUps: number
  vocabularies: {
    phases: string[]; openPhases: string[]; statuses: string[]; sources: string[]
    products: string[]; confidences: string[]; lossReasons: string[]
    probability: Record<string, number>
  }
}

/** The deal fields a client may write; the rest are server-owned. */
export type DealFieldKey =
  'title' | 'phase' | 'owner' | 'leadSource' | 'products' | 'mrr' | 'fees'
  | 'confidence' | 'anticipatedDate' | 'demoDate' | 'nextStep' | 'notes' | 'lossReason'

export const getCrmSummary = (): Promise<CrmSummary> => maestroGet('crmSummary')

export const getPipeline = (owner?: string): Promise<Pipeline> =>
  maestroGet('pipeline', owner ? { owner } : {})

export const getLeads = (params: { status?: string; source?: string; owner?: string; category?: string } = {}): Promise<LeadList> =>
  maestroGet('leads', params as Record<string, string>)

export const getDeals = (params: { companyId?: string; phase?: string; owner?: string; openOnly?: string } = {}): Promise<{ total: number; rows: Deal[] }> =>
  maestroGet('deals', params as Record<string, string>)

export const createDeal = (companyId: string, fields: Partial<Record<DealFieldKey, string>>): Promise<Deal> =>
  maestroPost('createDeal', { companyId, fields })

export const updateDeal = (companyId: string, entryId: string, fields: Partial<Record<DealFieldKey, string>>): Promise<Deal> =>
  maestroPost('updateDeal', { companyId, entryId, fields })

export const deleteDeal = (companyId: string, entryId: string): Promise<{ deleted: string; companyId: string }> =>
  maestroPost('deleteDeal', { companyId, entryId })

/** `$13,400`. Null reads as an em dash, because "no value" is not "zero". */
export function formatMoney(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return '$' + Math.round(value).toLocaleString('en-US')
}

/** `$13.4k` — for headline figures where the exact dollar is noise. */
export function formatCompactMoney(value: number | null): string {
  if (value === null || value === undefined) return '—'
  const n = Math.round(value)
  if (Math.abs(n) >= 1000000) return '$' + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm'
  if (Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return '$' + n.toLocaleString('en-US')
}

// ------------------------------------------------------------------ contacts
// The individuals at a company. Exactly one is primary; the endpoint enforces that
// by clearing every other entry whenever one is set, so it cannot go plural.

export const CONTACT_ROLES = [
  'Decision Maker', 'Champion', 'Influencer', 'Blocker', 'Clinical', 'Billing', 'IT', 'Other',
] as const

export interface Contact {
  entryId: string
  firstName: string
  lastName: string
  fullName: string
  title: string
  role: string
  email: string
  phone: string
  mobile: string
  notes: string
  primary: boolean
}

export interface ContactList {
  companyId: string
  companyName: string
  roles: string[]
  total: number
  primaryEntryId: string | null
  /** True if more than one entry carries the flag — only possible via the platform UI. */
  primaryConflict: boolean
  /** The primary's details as copied onto Company Info. */
  mirrored: { contactName: string; contactTitle: string; contactEmail: string; contactPhone: string }
  rows: Contact[]
}

export type ContactFieldKey =
  'firstName' | 'lastName' | 'title' | 'role' | 'email' | 'phone' | 'mobile' | 'notes'

export const getContacts = (companyId: string): Promise<ContactList> =>
  maestroGet('contacts', { companyId })

export const addContact = (
  companyId: string,
  fields: Partial<Record<ContactFieldKey, string>>,
  primary = false,
): Promise<ContactList> => maestroPost('addContact', { companyId, fields, primary })

export const updateContact = (companyId: string, entryId: string, fields: Partial<Record<ContactFieldKey, string>>): Promise<ContactList> =>
  maestroPost('updateContact', { companyId, entryId, fields })

export const setPrimaryContact = (companyId: string, entryId: string): Promise<ContactList> =>
  maestroPost('setPrimaryContact', { companyId, entryId })

export const deleteContact = (companyId: string, entryId: string): Promise<ContactList> =>
  maestroPost('deleteContact', { companyId, entryId })

// --------------------------------------------------------------------- files
// A filing cabinet per company, using eccrm's design: one entry per file, and
// FOLDERS ARE NOT OBJECTS — the folder is a "/"-separated path on the entry and the
// tree is derived from every path in use. An entry with a folder and no file is a
// marker, which is the only thing that makes an empty folder persist.

export interface FileDoc {
  hasFile: boolean
  filename: string
  url: string
  contentType: string
  size: number
  thumbUrl: string
}

export interface FileEntry {
  entryId: string
  name: string
  folder: string
  timestamp: string
  uploadedBy: string
  file: FileDoc
  /** A folder placeholder rather than a file. */
  isMarker: boolean
}

export interface FileCabinet {
  companyId: string
  companyName: string
  defaultFolders: string[]
  maxBytes: number
  /** Every folder that exists, ancestors included, sorted. */
  folders: string[]
  total: number
  totalBytes: number
  rows: FileEntry[]
}

export const getFiles = (companyId: string): Promise<FileCabinet> =>
  maestroGet('files', { companyId })

export const addFile = (companyId: string, file: {
  filename: string; dataBase64: string; name?: string; folder?: string; contentType?: string
}): Promise<FileEntry> => maestroPost('addFile', { companyId, ...file })

/** Rename and move are the same write: `name` and/or `folder`. */
export const updateFile = (companyId: string, entryId: string, fields: { name?: string; folder?: string }): Promise<FileEntry> =>
  maestroPost('updateFile', { companyId, entryId, fields })

export const deleteFile = (companyId: string, entryId: string): Promise<{ deleted: string }> =>
  maestroPost('deleteFile', { companyId, entryId })

export const createFolder = (companyId: string, folder: string): Promise<{ created: boolean; folder: string; reason?: string }> =>
  maestroPost('createFolder', { companyId, folder })

export const renameFolder = (companyId: string, oldPath: string, newPath: string): Promise<{ renamed: number; from: string; to: string }> =>
  maestroPost('renameFolder', { companyId, oldPath, newPath })

export const deleteFolder = (companyId: string, folder: string): Promise<{ deleted: string; entriesRemoved: number; filesRemoved: number }> =>
  maestroPost('deleteFolder', { companyId, folder })

export const COMPANY_CATEGORIES = ['Lead', 'Client', 'Former Client'] as const

/** Move a company to exactly one category. */
export const setCategory = (id: string, category: string): Promise<Company> =>
  maestroPost('setCategory', { id, category })
