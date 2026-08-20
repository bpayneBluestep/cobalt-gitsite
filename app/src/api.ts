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

/*
 * Where the platform's own sign-in lives. These are the real, verified paths on this
 * host — not guesses:
 *
 *   login.jsp   accepts a form POST as `myassn.user.UserLoginWebView` (see `login`)
 *   logout.jsp  303s to whatever `desturl` names. The `.jsp` matters: the extensionless
 *               `/shared/login/logout` 404s, here and on every other GitSite host
 *               checked, so anything copied from a sibling site using it never worked.
 */
const LOGIN_URL = '/shared/login/login.jsp'
const LOGOUT_URL = '/shared/login/logout.jsp'

/*
 * The OAuth2 broker is a separate, fixed host — the org host is passed to it as a
 * parameter rather than being where the request goes.
 */
const OAUTH2_HOST = 'oauth2.bluestep.net'

/*
 * Session loss, broadcast rather than returned.
 *
 * Any of ~40 calls can be the one that discovers the session died, and each is made from
 * a route with its own error state. Rather than teach all of them to raise the login gate,
 * `handle` — the single funnel every response passes through — announces it, and the
 * session context listens. One place knows, one place reacts.
 */
type SessionLostListener = () => void
const sessionLostListeners: SessionLostListener[] = []

export function onSessionLost(listener: SessionLostListener): () => void {
  sessionLostListeners.push(listener)
  return () => {
    const i = sessionLostListeners.indexOf(listener)
    if (i >= 0) sessionLostListeners.splice(i, 1)
  }
}

function noteSessionLost(): void {
  for (const listener of sessionLostListeners.slice()) {
    try { listener() } catch { /* a listener must never break the request path */ }
  }
}

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
      noteSessionLost()
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
    if (code === 'AUTH_REQUIRED') noteSessionLost()
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
 * Every capability the Maestro reports. Names match the server's `CAPABILITIES` map.
 *
 * A `view` capability means Reader-or-better on the form behind it, an `edit` capability
 * means Editor — so these mirror the platform ACL rather than inventing a second, softer
 * set of rules that could disagree with it.
 */
export type Capability =
  | 'viewClients' | 'editClients'
  | 'viewDeals' | 'editDeals'
  | 'viewContacts' | 'editContacts'
  | 'viewFiles' | 'editFiles'
  | 'viewOwner' | 'editOwner'
  | 'viewTickets' | 'editTickets'
  | 'viewSprints' | 'editSprints'
  | 'viewStaff' | 'editStaff'
  | 'grantRoles'
  | 'viewReports'
  | 'viewSchema'

/**
 * Who is signed in and what they may do.
 *
 * `can` arrives resolved from the server. That is deliberate: this SPA holds no copy of
 * the role → capability rules, so the matrix has exactly one home and a change to it
 * takes effect on the next request without a redeploy of the front end.
 *
 * None of this is a security boundary — the bundle is public and anyone can call
 * `/b/maestro` directly. The boundary is the form ACL on the platform, which the endpoint
 * runs against as the caller. This is here so the UI tells the truth about what is
 * reachable, instead of offering buttons that fail.
 */
export interface Session {
  loggedIn: boolean
  userId: string
  /** The Individual record behind the login — the id that identifies you in the data. */
  recordId: string
  fullName: string
  isSuper: boolean
  roles: string[]
  staffRoles: string[]
  can: Record<Capability, boolean>
  org: string
}

export const getSession = (): Promise<Session> => maestroGet('session')

// ------------------------------------------------------------------------ sign-in

/*
 * Signing in, four ways, because the platform offers four and hiding any of them just
 * sends people to a different page to do the same thing.
 *
 * BlueStep login is not a JSON API — it is a form POST against a WebView class. Posting
 * it same-origin authenticates the cookie on THIS host, which is the host the Maestro is
 * on, so the session the SPA then uses is the one that was just created. A password typed
 * here goes to this BlueStep host and nowhere else; it is never sent to the Maestro, never
 * logged, and never held after the request.
 */

function loginFormBody(username: string, password: string): URLSearchParams {
  const body = new URLSearchParams()
  body.set('_postEvent', 'commit')
  body.set('_postFormClass', 'myassn.user.UserLoginWebView')
  // Anything other than "one" makes the handler run doLogin() now, rather than serving
  // step one and waiting for a second round trip.
  body.set('step', 'two')
  body.set('myUserName', username)
  body.set('myPassword', password)
  body.set('rememberMe', 'false')
  return body
}

/**
 * Why a sign-in did not produce a usable session.
 *
 * A named reason rather than a set of optional booleans, so the caller has to handle the
 * cases rather than testing flags that may or may not be present — and so TypeScript
 * narrows `error` onto exactly the variants that carry one.
 *
 *   twoFactor  a global account's e-mail verification; hand off to `nativeLoginSubmit`
 *   noAccess   credentials were RIGHT and the platform session exists, but this account
 *              cannot reach the Maestro. Retyping the password will never fix it.
 *   rejected   the username and password genuinely did not match
 */
export type LoginResult =
  | { ok: true }
  | { ok: false; reason: 'twoFactor' }
  | { ok: false; reason: 'noAccess'; error: string }
  | { ok: false; reason: 'rejected'; error: string }

/**
 * Detect a signed-in response from the login handler.
 *
 * The platform re-serves the login page on success as well as on failure, with HTTP 200
 * both times — but a successful one is rendered with the signed-in chrome, and that chrome
 * declares `isLoggedIn = true`. Measured on this host: present on success, absent when the
 * credentials are rejected.
 *
 * This is a HINT, never the authority: `session` decides whether the app is usable. It
 * exists only to tell the two failure modes apart, because "wrong password" and "right
 * password, no access to this app" need opposite responses from the person reading it.
 */
function looksSignedIn(html: string): boolean {
  return /isLoggedIn\s*=\s*true/.test(html)
}

/**
 * Try a username/password sign-in without leaving the page.
 *
 * The response is NOT the answer. A failed login returns the login page again with HTTP
 * 200, so believing the status code would report every bad password as a success. The
 * authoritative test is whether the session actually became authenticated, which is why
 * this re-probes `session` and trusts that instead.
 *
 * But a failed probe does not mean the password was wrong. The Maestro endpoint requires a
 * **Relate licence** — an unlicensed account signs in to the platform perfectly well and
 * still gets bounced from `/b/maestro`, which is indistinguishable from being signed out
 * if you only look at the probe. Reporting that as "wrong username or password" is what
 * this used to do, and it sent a real person hunting for a typo in a correct password.
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  let res: Response
  try {
    res = await fetch(LOGIN_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: loginFormBody(username, password).toString(),
    })
  } catch {
    return {
      ok: false,
      reason: 'rejected',
      error: 'Could not reach the sign-in service. Check your connection.',
    }
  }

  // A global account is bounced to e-mail verification, which an in-page fetch cannot
  // finish — the user has to see the platform's own page.
  if (res.redirected && /\/oauth2\/v1\/login\/verify/.test(res.url)) {
    return { ok: false, reason: 'twoFactor' }
  }

  // Read once, before the probe: the body is needed only if the probe fails, but a
  // Response body can be consumed exactly once so there is no second chance later.
  let html = ''
  try { html = await res.text() } catch { /* the marker check just says false */ }

  try {
    const session = await getSession()
    if (session && session.loggedIn) return { ok: true }
  } catch {
    /* fall through and work out WHICH failure this is */
  }

  if (looksSignedIn(html)) {
    return {
      ok: false,
      reason: 'noAccess',
      error:
        'Your username and password were accepted — you are signed in to BlueStep. But ' +
        'this account cannot open Cobalt: the endpoint it reads needs a Relate licence, ' +
        'and this account does not have one. An administrator has to grant it; signing in ' +
        'again will not help.',
    }
  }

  return { ok: false, reason: 'rejected', error: 'That username and password did not match.' }
}

/**
 * Where to come back to after a full-page round trip through the platform.
 *
 * A path, not an absolute URL: the platform's own login page passes a path and resolves
 * it against the host it was given, so matching that is the behaviour actually known to
 * work. Verified — `?desturl=/spa/` 303s to `/spa/` on this host.
 */
function returnPath(): string {
  return window.location.pathname + window.location.search + window.location.hash
}

/**
 * Hand the browser to the platform's login page as a real page load, carrying the
 * credentials already typed, so it can run the e-mail 2FA step and send us back.
 *
 * A hidden form rather than a redirect because this has to be a POST — a password does
 * not belong in a URL.
 */
export function nativeLoginSubmit(username: string, password: string): void {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = `${LOGIN_URL}?desturl=${encodeURIComponent(returnPath())}`
  form.style.display = 'none'
  const add = (name: string, value: string) => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  add('_postEvent', 'commit')
  add('_postFormClass', 'myassn.user.UserLoginWebView')
  add('step', 'two')
  add('myUserName', username)
  add('myPassword', password)
  add('rememberMe', 'false')
  document.body.appendChild(form)
  form.submit()
}

export type SsoProvider = 'microsoft' | 'google'

/**
 * Where to send someone signing in with Microsoft or Google.
 *
 * The broker is a fixed separate host and the org is a parameter, so `host` must be the
 * hostname the user is actually on — read from the page, never hard-coded. Cobalt answers
 * on two hostnames (`cobalt` and `cobaltorg`) and only the one being used will have a
 * session afterwards, so guessing would sign people in to the wrong place.
 */
export function ssoLoginUrl(provider: SsoProvider): string {
  const host = encodeURIComponent(window.location.hostname)
  const dest = encodeURIComponent(returnPath())
  return `https://${OAUTH2_HOST}/v1/login/initiate/${provider}?host=${host}&destUrl=${dest}`
}

/**
 * The platform's own login page, in global-account mode.
 *
 * Kept as an escape hatch: it is the page that handles every case this gate does not,
 * so a person who cannot get in here is never stuck.
 */
export function globalLoginUrl(): string {
  return `${LOGIN_URL}?step=two&_globalLogin=true&desturl=${encodeURIComponent(returnPath())}`
}

/**
 * Sign out without leaving the app.
 *
 * Fetching logout.jsp invalidates the session server-side; the caller then drops to the
 * gate locally. That beats a full-page redirect: the bundle stays loaded, so signing out
 * and back in is instant and lands exactly where it started rather than at the org home
 * page. Mirrors what the eccrm CRM does.
 *
 * A failure here is not reported. If the request did not land the session may still be
 * alive, but the user asked to be signed out — showing them the gate is the right
 * response either way, and the next call they make will bounce and confirm it.
 */
export async function logout(): Promise<void> {
  try {
    await fetch(LOGOUT_URL, { credentials: 'include', cache: 'no-store' })
  } catch {
    /* drop to the gate regardless */
  }
}

/**
 * A full-page sign-out, for the one case the in-app version cannot serve: the session is
 * unreadable, so there is no working app to stay inside.
 */
export function logoutUrl(): string {
  return `${LOGOUT_URL}?desturl=${encodeURIComponent(returnPath())}`
}

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
  /** The client's own BlueStep org, imported from beh. Empty for a company without one. */
  ehrLink: string
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

/*
 * Two tabs, not one per status: what is still to do, and what is finished. Splitting the
 * open work across Open / Ready / Current hid it — a board is for seeing everything
 * outstanding at once. The statuses still matter, so the Open tab GROUPS by them, in the
 * order of TICKET_STATUSES.
 */
export const TICKET_TABS = [
  { key: 'open', label: 'Open', statuses: ['Open', 'Up Next', 'In Progress', 'In Review'] },
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

/** A BlueStep thing a ticket changed — the engineer's own record of the blast radius. */
export interface ComponentRef {
  id: string
  name: string
  kind: string
  /** 'New' or 'Edit'. */
  change: string
  url: string
  at: string
  by: string
}

export const COMPONENT_KINDS = [
  'Endpoint', 'Merge Report', 'Formula', 'Scheduled Script', 'Post-Save Script',
  'Form', 'Field', 'Option List', 'Query', 'View', 'Record Type', 'Site Page', 'Other',
] as const

export const COMPONENT_CHANGES = ['New', 'Edit'] as const

/** The Wesley interview a ticket came from, kept so the request can be audited. */
export interface TicketConversation {
  turns: { role: 'user' | 'assistant'; text: string; at?: string }[]
  narration: { text: string; at?: string }[]
}

export interface Ticket {
  entryId: string
  /** Global running number. Null only for a ticket that predates numbering. */
  ticketNumber: number | null
  title: string
  status: string
  priority: string
  dueDate: string
  /** A plain sprint number as a string ('3'), or '' for unplanned. Set from the board. */
  sprint: string
  /** Rich text (HTML). Sanitise before rendering — see lib/html.ts. */
  details: string

  /** The PM answerable to the client. Written only through `setTicketPeople`. */
  accountableId: string
  accountableName: string
  /** The engineer doing the work — what the sprint board groups by. */
  responsibleId: string
  responsibleName: string
  /** Retired free-text owner. Read-only, kept so old tickets still read sensibly. */
  assignee: string

  estHours: number | null
  /** Derived server-side from the time log; never written directly. */
  loggedHours: number | null
  time: TimeEntry[]
  timerRunning: boolean
  timerElapsedMinutes: number
  timerBy: string
  timerStartedAt: string

  attachments: Attachment[]
  components: ComponentRef[]
  /** Present only on a ticket that came from Wesley, and only on a single-ticket read. */
  conversation: TicketConversation | null
  /** True when this ticket was raised through the guided intake. */
  fromIntake: boolean

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

  // ---- subtasks -------------------------------------------------------------
  // A subtask is a whole ticket that names a parent, so everything above applies to one
  // as well. The fields below say where it sits. Only `parentId` and `parentNumber` are
  // stored; the rest is derived server-side from a single read of the list, which is why
  // a renamed parent never leaves a stale title behind.

  /** Entry id of the parent, or '' for a top-level ticket. Always on the same list. */
  parentId: string
  parentNumber: number | null
  /** Resolved server-side; '' unless this is a subtask whose parent still exists. */
  parentTitle: string
  /** True when this row belongs underneath its parent rather than on its own. */
  isSubtask: boolean
  /** Its parent is gone. Reported as top-level so an orphan cannot vanish from the board. */
  orphaned: boolean

  /** How many subtasks this ticket has, and how many are done. Both 0 when it has none. */
  subtaskCount: number
  subtaskDone: number
  /** The children's hours, summed — kept apart from the parent's own so nothing double-counts. */
  subtaskEstHours: number
  subtaskLoggedHours: number

  // ---- activity ---------------------------------------------------------------
  /** Events and comments in one ordered list, oldest first. Empty on a board row. */
  activity: ActivityItem[]
  /** How many items the log holds — present on board rows, where `activity` is not. */
  activityCount: number
  commentCount: number

  /** The children in full. Present only on a single-ticket read; null on a board row. */
  subtasks: Ticket[] | null
  /** A crumb back to the parent. Present only on a single-ticket read of a subtask. */
  parent: TicketParent | null
}

/**
 * One line of a ticket's history.
 *
 * `event` is written by the endpoint when a write actually changed something — derived
 * from the diff, so re-saving an unchanged form adds nothing. `comment` is a person's,
 * and is the only kind that can be removed: an event is the record's own account of
 * what happened, and letting people rewrite that turns a history into a story.
 */
export interface ActivityItem {
  id: string
  type: 'event' | 'comment'
  who: string
  /** ISO instant. */
  at: string
  text: string
}

/** Just enough of a parent to link back to it from a subtask. */
export interface TicketParent {
  entryId: string
  ticketNumber: number | null
  title: string
  status: string
  subtaskCount: number
  subtaskDone: number
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
 * stamps, the time log, attachments and components are append-and-recompute rather
 * than overwrite, and the two owners need their names resolved from the user record.
 * `sprint` is missing on purpose — it is set from the sprint board, not typed on the
 * ticket page. The endpoint enforces all of this; it is not a convention.
 */
export type TicketFieldKey =
  'title' | 'status' | 'priority' | 'dueDate' | 'details' | 'estHours'

export const getTickets = (params: { listId?: string; responsible?: string; sprint?: string; status?: string } = {}): Promise<TicketList> =>
  maestroGet('tickets', params as Record<string, string>)

/**
 * One ticket, by number or entry id, without knowing which list it is on — what a
 * shared `/tickets/8` link resolves through. Ticket numbers are org-wide, so the
 * number alone is enough; `listId` skips the endpoint's scan when it is known.
 */
export const getTicket = (key: string, listId?: string): Promise<{ ticket: Ticket; list: List; listsScanned: number }> =>
  maestroGet('ticket', listId ? { key, listId } : { key })

export const getList = (id: string): Promise<List & { tickets: Ticket[] }> => maestroGet('list', { id })

export const getLists = (params: { clientId?: string; kind?: string } = {}): Promise<{ total: number; rows: List[] }> =>
  maestroGet('lists', params as Record<string, string>)

/** Create or find the list for a client — how a client's board comes into being. */
export const getClientList = (clientId: string): Promise<List & { created: boolean; tickets: Ticket[] }> =>
  maestroPost('clientList', { clientId })

/**
 * Create a ticket. The two owners ride alongside `fields` rather than inside it,
 * because the endpoint resolves them against the user list instead of writing them
 * straight through — the same reason they are absent from `TicketFieldKey`.
 */
export const addTicket = (
  listId: string,
  fields: Partial<Record<TicketFieldKey, string>>,
  people: { accountableId?: string; responsibleId?: string } = {},
): Promise<Ticket> =>
  maestroPost('addTicket', { listId, fields: { ...fields, ...people } })

export const updateTicket = (listId: string, entryId: string, fields: Partial<Record<TicketFieldKey, string>>): Promise<Ticket> =>
  maestroPost('updateTicket', { listId, entryId, fields })

/**
 * Delete a ticket. A parent with subtasks is refused (409 HAS_SUBTASKS) unless
 * `cascade` is passed — the caller has to have seen the children named before the
 * delete takes them too.
 */
export const deleteTicket = (
  listId: string,
  entryId: string,
  cascade = false,
): Promise<{ deleted: string; subtasksDeleted: string[]; listId: string }> =>
  maestroPost('deleteTicket', cascade ? { listId, entryId, cascade: 'true' } : { listId, entryId })

// ------------------------------------------------------------------- subtasks
// Breaking a big ticket into bite-sized chunks. A subtask is a full ticket with a
// parent — its own number, status, owner, estimate and timer — because the pieces of
// a large job are precisely the things that go to different people in different
// sprints, which a checklist row could never express.
//
// Two rules the endpoint enforces, worth knowing before calling these: parent and
// child live on the SAME list, and subtasks are ONE level deep. A subtask cannot have
// subtasks of its own, and a ticket that already has children cannot become one.

/** Create a subtask under `parentId`. Same shape as `addTicket` otherwise. */
export const addSubtask = (
  listId: string,
  parentId: string,
  fields: Partial<Record<TicketFieldKey, string>>,
  people: { accountableId?: string; responsibleId?: string } = {},
): Promise<Ticket> =>
  maestroPost('addSubtask', { listId, parentId, fields: { ...fields, ...people } })

/**
 * Attach an existing ticket to a parent, move it to a different one, or promote it
 * back to top-level with an empty `parentId`.
 *
 * This is the common path, not `addSubtask`: work is usually broken up after somebody
 * has written it down and realised it is three jobs.
 */
export const setParent = (on: On, parentId: string): Promise<Ticket> =>
  maestroPost('setParent', { ...on, parentId })

// ------------------------------------------------------------------- activity
// The ticket's history. Events write themselves from every other action; these two
// are the only way a person puts something in it directly.

export const addComment = (on: On, text: string): Promise<Ticket> =>
  maestroPost('addComment', { ...on, text })

/** Comments only — the endpoint refuses an event with NOT_A_COMMENT. */
export const deleteComment = (on: On, commentId: string): Promise<Ticket> =>
  maestroPost('deleteComment', { ...on, commentId })

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
/** Video gets far more room — see MAX_RECORDING_BYTES in the endpoint. */
export const MAX_RECORDING_BYTES = 64 * 1024 * 1024
/** The ceiling that applies to a given file. Mirrors `uploadCeiling` server-side. */
export const ceilingFor = (mimeType: string): number =>
  (mimeType || '').toLowerCase().startsWith('video/') ? MAX_RECORDING_BYTES : MAX_ATTACHMENT_BYTES

export const uploadAttachment = (
  on: On,
  file: { fileName: string; mimeType: string; dataBase64: string },
): Promise<Ticket> => maestroPost('uploadAttachment', { ...on, ...file })

export const deleteAttachment = (on: On, attachmentId: string): Promise<Ticket> =>
  maestroPost('deleteAttachment', { ...on, attachmentId })

/**
 * Set either owner. An omitted key leaves that role alone; an empty string clears it —
 * which is why this takes a partial rather than two strings.
 */
export const setTicketPeople = (
  on: On,
  people: { accountableId?: string; responsibleId?: string },
): Promise<Ticket> => maestroPost('setTicketPeople', { ...on, ...people })

export const addComponent = (
  on: On,
  component: { name: string; kind: string; change: string; url?: string },
): Promise<Ticket> => maestroPost('addComponent', { ...on, ...component })

export const updateComponent = (
  on: On,
  component: { componentId: string; name?: string; kind?: string; change?: string; url?: string },
): Promise<Ticket> => maestroPost('updateComponent', { ...on, ...component })

export const deleteComponent = (on: On, componentId: string): Promise<Ticket> =>
  maestroPost('deleteComponent', { ...on, componentId })

// ------------------------------------------------------------------- Wesley
// Guided intake: a conversation that interviews the person, coaches them into
// recording their screen, and hands back a title and a structured description an
// engineer can act on. Ported from beh's Ticket Maestro.
//
// Two things about this seam are load-bearing:
//   * Wesley NEVER writes to the platform. It returns a proposal; the user edits it
//     and `addTicket` creates the ticket through the same validation as any other.
//   * The model provider is reached only from the endpoint. The key is server-side,
//     which matters here specifically because this repo is public.
//
// Nothing user-visible ever says "AI". It is Wesley.

export interface IqMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What Wesley hands back once it is satisfied it has enough. */
export interface IqProposal {
  title: string
  description: string
  summary: string
}

export interface IqTurn {
  assistantMessage: string
  proposal?: IqProposal
  done?: boolean
}

/** A file or link gathered during the interview, before any ticket exists. */
export interface IqAttachment {
  kind: 'video' | 'image' | 'url'
  fileName?: string
  /** Empty until uploaded — a link has one from the start, a file gets one at submit. */
  url: string
  mime?: string
  size?: number
  at?: string
  by?: string
  /** Kept client-side only: the blob and its object URL for local preview. */
  blob?: Blob
  localUrl?: string
}

/** A stored artifact, as `wesleyUpload` returns it. */
export interface IqRef {
  fileName: string
  url: string
  mime: string
  size: number
  at: string
  by: string
}

/**
 * Whether Wesley is configured, and the ceilings the recorder must budget against.
 *
 * The limits come from the server rather than being written down here as well. They
 * were duplicated once and drifted: the recorder was producing ~200 KB/s against a
 * 10 MB cap, so it blew the limit at 53 seconds and only said so at submit.
 */
export const wesleyStatus = (): Promise<{
  available: boolean
  maxRecordingBytes?: number
  maxAttachmentBytes?: number
}> => maestroGet('wesleyStatus')

/**
 * One turn. Send the WHOLE conversation every time — the endpoint holds no session,
 * which is what makes a reload or a second tab harmless.
 */
export const wesleyChat = (
  messages: IqMessage[],
  context: { hasRecording?: boolean; listName?: string; clientName?: string } = {},
): Promise<IqTurn> => maestroPost('wesleyChat', { messages, ...context })

/** Mic audio only. The screen video is never sent anywhere. */
export const wesleyTranscribe = (
  audioBase64: string, mimeType: string,
): Promise<{ transcript: string }> => maestroPost('wesleyTranscribe', { audioBase64, mimeType })

export const wesleyUpload = (
  listId: string, file: { fileName: string; dataBase64: string; mimeType: string },
): Promise<{ ref: IqRef }> => maestroPost('wesleyUpload', { listId, ...file })

/**
 * Create the ticket the interview produced.
 *
 * Separate from `addTicket` only in what it carries: the same action underneath, so
 * an intake ticket is an ordinary ticket that happens to remember where it came from.
 */
export const addIntakeTicket = (
  listId: string,
  fields: { title: string; details: string },
  intake: { attachments: Partial<IqRef & { kind: string }>[]; conversation: TicketConversation },
): Promise<Ticket> => maestroPost('addTicket', { listId, fields: { ...fields, ...intake } })

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
  mrr: number | null
  fees: number | null
  confidence: string
  /**
   * `YYYY-MM` — when billing is expected to start. Month precision on purpose: this
   * replaced a day-precise close date nobody could answer honestly while the deal was
   * still open, and the forecast now buckets by it.
   */
  firstBillingMonth: string
  demoDate: string
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
    /** Open deals whose billing is expected to START this month — not deals closing. */
    billingThisMonthCount: number; billingThisMonthMrr: number; averageOpenMrr: number
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
    confidences: string[]; lossReasons: string[]
    probability: Record<string, number>
  }
}

/**
 * The deal fields a client may write; the rest are server-owned.
 *
 * `products` and `nextStep` are gone — neither was being answered honestly, so both
 * were noise dressed as data. `anticipatedDate` is replaced by `firstBillingMonth`.
 * All three still exist on the platform form, relabelled "(retired)", because a
 * BlueStep field can never be deleted.
 */
export type DealFieldKey =
  'title' | 'phase' | 'owner' | 'leadSource' | 'mrr' | 'fees'
  | 'confidence' | 'firstBillingMonth' | 'demoDate' | 'notes' | 'lossReason'

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
/** `2026-09` as `Sep 2026`. An empty or malformed month renders as an em dash. */
export function formatMonth(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''))
  if (!m) return '—'
  // Built from parts rather than parsed as a date: `new Date('2026-09')` is UTC
  // midnight, which in a western timezone renders as August.
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[Number(m[2]) - 1]} ${m[1]}`
}

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
  maxBytes: number
  /** Every folder in use, ancestors included, sorted. A new cabinet has none. */
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

// ------------------------------------------------------------------- sprints
// beh's model: each engineer is a column, and the column measures the estimates
// assigned to them against their capacity. Cobalt needs almost no new schema for it —
// a ticket already carries `sprint`, `responsible` and `estHours`.
//
// A sprint is a plain counting number — 1, 2, 3 — the way the team says it out loud.
// It used to be an ISO week (2026-W33), which reads like a date but is not one, and
// nobody ever said it. The server treats the key as an opaque string; the format is
// the only thing the two sides have to agree on, so it is validated at both ends.
//
// The roster is PER SPRINT. Capacity moves week to week, and an engineer who is out
// comes off that sprint only — never off a sprint that already happened.

export const ENGINEER_DISCIPLINES = ['Engineer', 'Implementation', 'Support', 'Design', 'Other'] as const

/** Digits only, no leading zero — mirrors the endpoint's own check. */
export const SPRINT_PATTERN = /^[1-9]\d{0,3}$/

export const isSprintKey = (key: string): boolean => SPRINT_PATTERN.test(String(key || ''))

export interface Engineer {
  entryId: string
  name: string
  email: string
  role: string
  capacity: number
  active: boolean
  /** The sprint this roster row is for. Empty means it is a template row. */
  sprint: string
}

export interface Team {
  teamListId: string
  disciplines: string[]
  /** The sprint asked for, or null when the default roster was asked for. */
  sprint: string | null
  /**
   * True when this sprint has no roster of its own and the default is standing in.
   * Editing a template row changes the starting point of every future sprint, so the
   * UI has to say which one you are looking at.
   */
  isTemplate: boolean
  /** Every sprint that has a roster, oldest first. */
  sprints: string[]
  total: number
  weeklyCapacity: number
  rows: Engineer[]
}

export interface SprintColumn {
  engineer: string
  entryId: string
  role: string
  capacity: number
  tickets: Ticket[]
  estHours: number
  loggedHours: number
  remaining: number
  over: boolean
  /** Percent of capacity committed, or null when they have no capacity set. */
  utilisation: number | null
  done: number
}

export interface SprintBoard {
  sprint: string
  /** True when the default roster is standing in because this sprint has none yet. */
  rosterIsTemplate: boolean
  /** Every sprint that has a roster, oldest first — what the picker offers. */
  sprints: string[]
  listsScanned: number
  columns: SprintColumn[]
  /** In this sprint but with nobody's name on it. */
  unassigned: Ticket[]
  backlog: Ticket[]
  backlogTotal: number
  totals: {
    engineers: number; tickets: number; capacity: number; estHours: number
    loggedHours: number; remaining: number; over: boolean
    utilisation: number | null; done: number; unassigned: number
  }
  statuses: string[]
  priorities: string[]
}

export type EngineerFieldKey = 'name' | 'email' | 'role' | 'capacity' | 'active' | 'sprint'

/** The roster for one sprint. No sprint asks for the default roster. */
export const getTeam = (sprint = '', includeInactive = false): Promise<Team> =>
  maestroGet('team', {
    ...(sprint ? { sprint } : {}),
    ...(includeInactive ? { includeInactive: 'true' } : {}),
  })

/**
 * Start a sprint by copying the previous roster forward. Idempotent — a sprint that
 * already has a roster comes back untouched, so a double-click cannot double a column.
 */
export const createSprint = (sprint: string, from?: string): Promise<Team & { created: number; copiedFrom: string | null; note?: string }> =>
  maestroPost('createSprint', { sprint, from: from || '' })

export const addEngineer = (fields: Partial<Record<EngineerFieldKey, string>>): Promise<Team> =>
  maestroPost('addEngineer', { fields })

export const updateEngineer = (entryId: string, fields: Partial<Record<EngineerFieldKey, string>>): Promise<Team> =>
  maestroPost('updateEngineer', { entryId, fields })

export const deleteEngineer = (entryId: string): Promise<Team> =>
  maestroPost('deleteEngineer', { entryId })

export const getSprint = (sprint: string): Promise<SprintBoard> =>
  maestroGet('sprint', { sprint })

/**
 * Put a ticket into a sprint (and optionally onto an engineer). An empty sprint pulls
 * it out. The engineer is the RESPONSIBLE one — moving a ticket between sprints never
 * changes who is accountable to the client for it.
 */
export const assignSprint = (
  listId: string, entryId: string, sprint: string, responsibleId?: string,
): Promise<Ticket> =>
  maestroPost('assignSprint', { listId, entryId, sprint, responsibleId: responsibleId || '' })

// -- sprint number helpers --------------------------------------------------

/** Step a sprint number, never below 1. */
export function shiftSprint(key: string, by: number): string {
  const n = Number(key)
  if (!isFinite(n) || n < 1) return '1'
  return String(Math.max(1, Math.round(n) + by))
}

/**
 * A name reduced to something two spellings of the same person agree on.
 *
 * A BlueStep person record reads "Payne, Brandon"; every hand-entered name — a roster
 * row, an old assignee — reads "Brandon Payne". Lower-case, drop punctuation, sort the
 * words, and both become "brandon payne". Mirrors `nameKey` in the endpoint, because
 * the two have to agree about which column a ticket belongs in.
 */
export function nameKey(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

/** `Sprint 3` — the one label the whole app uses for a sprint. */
export function sprintLabel(key: string): string {
  return key ? `Sprint ${key}` : 'No sprint'
}

// ------------------------------------------------------------- settings: users
// A person in Cobalt carries BOTH the Staff and User categories — never one or the other —
// with employment details on the Employee Info form. Both matter: User is what the All
// Users query lists, and Staff is what every "Security - <Role>" query requires, so a
// User-only record could have roles ticked and be granted nothing. `createUser` creates
// through a query that demands both so they attach together.
//
// Supervisor is a text id plus a denormalised name — the standing pattern in this project
// rather than a relationship field.

export const DEPARTMENTS = [
  'Engineering', 'Implementation', 'Support', 'Sales', 'Leadership', 'Operations',
] as const
export const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern'] as const

/*
 * Permission roles. A fallback, not the source of truth — `users` returns `staffRoles`
 * and the UI should prefer that, so adding a role on the platform does not need a
 * redeploy here. This copy exists only so the checkbox group can render before the first
 * response lands.
 *
 * A role is not a department: someone sits in one department but can hold several roles,
 * and "Leadership" appears in both lists meaning different things.
 */
export const STAFF_ROLES = [
  'Leadership', 'Accounting', 'Sales', 'Relate Engineer', 'Infra Engineer', 'Client Success',
] as const

export interface User {
  id: string
  name: string
  jobTitle: string
  department: string
  dateOfHire: string
  employmentType: string
  workEmail: string
  workPhone: string
  employed: boolean
  notes: string
  /**
   * Permission roles, any number of them. Ticking one puts the person in the matching
   * dynamic security group — this is a permission change, not a label.
   */
  roles: string[]
  supervisorId: string
  supervisorName: string
  /** False when nothing on Employee Info has been filled in yet. */
  hasEmployeeInfo: boolean
  /** The stored supervisor id no longer matches any user. */
  supervisorMissing: boolean
  directReports: number
}

export interface UserList {
  departments: string[]
  employmentTypes: string[]
  /** The server's role vocabulary — prefer this over the STAFF_ROLES fallback. */
  staffRoles: string[]
  total: number
  withEmployeeInfo: number
  rows: User[]
}

export type EmployeeFieldKey =
  'jobTitle' | 'department' | 'dateOfHire' | 'employmentType'
  | 'workEmail' | 'workPhone' | 'employed' | 'notes'

/**
 * An employment write. Every field is a string except `roles`, which is a real array —
 * the endpoint validates it as a set, and stringifying it would arrive as one bogus
 * option name rather than several roles.
 *
 * Sending `roles: []` clears every role. Omitting the key leaves them untouched.
 */
export type EmployeeWrite =
  Partial<Record<EmployeeFieldKey, string> & { roles: string[] }>

export const getUsers = (includeFormer = false): Promise<UserList> =>
  maestroGet('users', includeFormer ? { includeFormer: 'true' } : {})

export const updateEmployee = (id: string, fields: EmployeeWrite): Promise<User> =>
  maestroPost('updateEmployee', { id, fields })

/** An empty supervisorId clears it. Self and a two-person cycle are refused. */
export const setSupervisor = (id: string, supervisorId: string): Promise<User> =>
  maestroPost('setSupervisor', { id, supervisorId })

/**
 * Creates the person RECORD only — the API cannot mint a BlueStep login.
 *
 * `firstName` and `lastName` are sent separately and are both required. The endpoint does
 * accept a single `name` and split it on the last space, but that fallback guesses which
 * words are the surname, so this app never uses it.
 *
 * The response reports what actually landed: `categoriesAttached` is read back from the
 * record, and `needsStaffCategory` is true only if Staff genuinely failed to attach.
 */
export const createUser = (
  fields: EmployeeWrite & { firstName: string; lastName: string },
): Promise<User & {
  loginCreated: boolean
  nameWritten: boolean
  categoriesAttached: string[]
  needsStaffCategory: boolean
  note: string
}> => maestroPost('createUser', { fields })

// ------------------------------------------------------------- account owner
// One open stint (no `to`) is the current owner; the closed ones are the history.

export interface OwnerStint {
  entryId: string
  userId: string
  userName: string
  from: string
  to: string
  handoffNote: string
  assignedBy: string
  assignedAt: string
  current: boolean
}

export interface AccountOwner {
  companyId: string
  companyName: string
  current: OwnerStint | null
  /** More than one open stint — only possible by hand-editing the BlueStep form. */
  conflict: boolean
  history: OwnerStint[]
  total: number
  mirrored: string
}

export const getAccountOwner = (companyId: string): Promise<AccountOwner> =>
  maestroGet('accountOwner', { companyId })

/** Hand the client over from `fromDate`. An empty userId leaves it unowned. */
export const setAccountOwner = (
  companyId: string, userId: string, fromDate: string, note?: string,
): Promise<AccountOwner> =>
  maestroPost('setAccountOwner', { companyId, userId, fromDate, note: note || '' })

export const COMPANY_CATEGORIES = ['Lead', 'Client', 'Former Client'] as const

/** Move a company to exactly one category. */
export const setCategory = (id: string, category: string): Promise<Company> =>
  maestroPost('setCategory', { id, category })
