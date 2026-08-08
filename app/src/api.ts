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

export interface Company {
  id: string
  name: string
  website: string
  street: string
  city: string
  state: string
  postalCode: string
  categories: string[]
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

/** Save only the keys that changed. The reply is the record as re-read server-side. */
export const updateCompany = (id: string, fields: Partial<Record<CompanyFieldKey, string>>): Promise<Company> =>
  maestroPost('updateCompany', { id, fields })

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

export interface Ticket {
  entryId: string
  title: string
  status: string
  priority: string
  assignee: string
  dueDate: string
  sprint: string
  details: string
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

/** The editable ticket fields — the server-stamped audit ones are excluded. */
export type TicketFieldKey = 'title' | 'status' | 'priority' | 'assignee' | 'dueDate' | 'sprint' | 'details'

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

export const COMPANY_CATEGORIES = ['Lead', 'Client', 'Former Client'] as const

/** Move a company to exactly one category. */
export const setCategory = (id: string, category: string): Promise<Company> =>
  maestroPost('setCategory', { id, category })
