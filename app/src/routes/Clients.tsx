import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  getClients, createClient, getCsQueue, ApiError,
  COMPANY_FIELDS, type Company, type CompanyFieldKey, type CsRow,
} from '../api'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: Company[] }
  | { phase: 'error'; error: ApiError }

/**
 * What the Last touch pill knows about one client.
 *
 * `band` is deliberately NOT the CS health colour. Health folds in an unanswered
 * detractor and the last temperature reading, so a client rung yesterday can be Red —
 * true, and completely wrong under a column headed "Last touch". This bands on contact
 * recency alone, using the account's own cadence, so the colour means what the label says.
 */
type Touch = {
  days: number | null
  when: string
  type: string
  cadence: number
  band: 'fresh' | 'due' | 'quiet' | 'never'
}

/*
 * The thresholds are the endpoint's, not ours: `checkDue` is past one cadence and
 * `goneQuiet` is past two, and a cadence is per-account (White Glove 14d, Self-Sufficient
 * 60d). Re-deriving them here with round numbers would give the Clients page a private
 * opinion about staleness that disagrees with /cs about the same client.
 */
const bandOf = (r: CsRow): Touch['band'] =>
  r.neverTouched ? 'never' : r.goneQuiet ? 'quiet' : r.checkDue ? 'due' : 'fresh'

const touchLabel = (t: Touch): string =>
  t.band === 'never' ? 'Never'
    : t.days === 0 ? 'Today'
    : t.days === 1 ? '1 day'
    : `${t.days} days`

/**
 * One owner filter chip.
 *
 * Keyed by `ownerId` where there is one, and by the NAME where there is not: four
 * clients still carry an imported free-text owner with no staff record behind it, and
 * keying on id alone would silently drop them from every chip while still counting them
 * in the total.
 */
type OwnerChip = { key: string; label: string; count: number }

const ownerKey = (r: Company): string =>
  r.ownerId ? r.ownerId : r.owner ? `name:${r.owner}` : 'none'

/*
 * "Active" is derived from the book, not from the staff list.
 *
 * An owner is offered here because clients are sitting under their name today. Building
 * the row from staff-with-employed instead would keep showing someone the moment their
 * Employee Info lags reality -- Tony Montiel is still flagged employed in Cobalt and
 * owns nothing, and would have had a chip that always returned zero rows. Reading the
 * loaded rows means every chip is guaranteed to yield results and the row maintains
 * itself as the book moves.
 */
function ownerChips(rows: Company[]): OwnerChip[] {
  const seen = new Map<string, OwnerChip>()
  for (const r of rows) {
    const key = ownerKey(r)
    const existing = seen.get(key)
    if (existing) existing.count += 1
    else seen.set(key, { key, label: r.owner || 'Unassigned', count: 1 })
  }
  // Biggest book first, then alphabetical: the two names most rows belong to are the
  // two people most likely to be looking for their own list.
  return [...seen.values()].sort((a, b) =>
    b.count - a.count || a.label.localeCompare(b.label))
}

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

type Draft = Record<CompanyFieldKey, string>

const EMPTY = COMPANY_FIELDS.reduce((acc, f) => { acc[f.key] = ''; return acc }, {} as Draft)

export default function Clients() {
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ phase: 'loading' })

  // The create panel. Adding a client also creates its list, so this is the one
  // place in the app that writes two records at once.
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState('')

  /*
   * Filtering happens here, not at the endpoint: `clients` returns every Company in the
   * category in one call and the list is small enough to hold, so a round trip per
   * keystroke would buy nothing and cost the responsiveness that makes a search feel
   * like a search.
   *
   * Matched against name, website and the address parts, because "the one in Provo" is
   * how people actually look for a client they cannot spell.
   */
  const [search, setSearch] = useState('')
  const [owner, setOwner] = useState('')

  /*
   * Touch data rides in a SECOND call, and its absence is not an error.
   *
   * `csQueue` needs `viewCs` (Leadership, Accounting, Client Success) while this page
   * needs only `viewClients`, which every role has. A rep or an engineer opening Clients
   * gets a 403 here — expected, not broken — so the column quietly renders a dash for
   * them rather than failing a page they are entitled to see. Kept out of `state` for
   * the same reason: the table must render the moment the clients land, without waiting
   * on a call that may never succeed.
   */
  const [touch, setTouch] = useState<Record<string, Touch>>({})

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getClients()
      .then(data => setState({ phase: 'ready', rows: data.rows }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))

    getCsQueue()
      .then(data => {
        const next: Record<string, Touch> = {}
        for (const r of data.rows) {
          next[r.companyId] = {
            days: r.contactAgeDays,
            when: r.lastContact,
            type: r.lastContactType,
            cadence: r.cadenceDays,
            band: bandOf(r),
          }
        }
        setTouch(next)
      })
      .catch(() => setTouch({}))
  }, [])

  useEffect(load, [load])

  const rows = state.phase === 'ready' ? state.rows : []

  /*
   * Counted across every client, never across the current search, so the numbers stay
   * still while you type. What the search did to the result is already spelled out by
   * the count line below.
   */
  const chips = useMemo(() => ownerChips(rows), [rows])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (owner && ownerKey(r) !== owner) return false
      if (!q) return true
      return [r.name, r.owner, r.website, r.city, r.state, r.postalCode]
        .some(v => String(v || '').toLowerCase().includes(q))
    })
  }, [rows, search, owner])

  const ownerLabel = chips.find(c => c.key === owner)?.label ?? ''

  function openPanel() {
    setDraft(EMPTY)
    setFailure('')
    setOpen(true)
  }

  function closePanel() {
    setOpen(false)
    setFailure('')
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.name.trim() || saving) return
    setSaving(true)
    setFailure('')

    // Send only what was filled in: an empty field is "not set", not "".
    const fields: Partial<Record<CompanyFieldKey, string>> = {}
    for (const f of COMPANY_FIELDS) {
      const v = draft[f.key].trim()
      if (v) fields[f.key] = v
    }

    createClient(fields)
      .then(result => {
        // Land on the new record so the next thing you do is fill it in. If the
        // list step failed the client still exists, so say so rather than
        // pretending the whole thing failed.
        navigate(`/clients/${result.company.id}`, {
          state: result.listError ? { warning: result.listError } : undefined,
        })
      })
      .catch(err => {
        setFailure(err instanceof ApiError ? err.message : String(err))
        setSaving(false)
      })
  }

  return (
    <section className="page">
      <header className="page__head">
        <div className="page__headrow">
          <div>
            <p className="eyebrow">Companies</p>
            <h1>Clients</h1>
          </div>
          <div className="page__head-tools">
            {state.phase === 'ready' && rows.length > 0 && (
              <div className="ef ef--narrow">
                <label htmlFor="cl-search">Search</label>
                <input
                  id="cl-search"
                  type="search"
                  value={search}
                  autoComplete="off"
                  placeholder="Name, owner, website, city…"
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            )}
            {!open && (
              <button type="button" className="btn" onClick={openPanel}>
                <span aria-hidden="true">+</span> New client
              </button>
            )}
          </div>
        </div>
        <p className="page__sub-text">
          Every Company record in the <code>Client</code> category, served by the Maestro.
          Open a name to view and edit its record.
        </p>

        {/* Only shown once there is a choice to make: with a single owner holding the
            whole book, a filter row is one permanently-pressed button and noise. */}
        {state.phase === 'ready' && chips.length > 1 && (
          <div className="ownerbar" role="group" aria-label="Filter by account owner">
            <button
              type="button"
              className="ownerchip"
              aria-pressed={!owner}
              onClick={() => setOwner('')}
            >
              All <span className="ownerchip__n">{rows.length}</span>
            </button>
            {chips.map(c => (
              <button
                key={c.key}
                type="button"
                className="ownerchip"
                aria-pressed={owner === c.key}
                // Clicking the pressed one clears it: the way back to everything is the
                // control you just used, not a hunt for the All button.
                onClick={() => setOwner(owner === c.key ? '' : c.key)}
              >
                {c.label} <span className="ownerchip__n">{c.count}</span>
              </button>
            ))}
          </div>
        )}
      </header>

      {open && (
        <form className="editcard newclient" onSubmit={submit}>
          <div className="editcard__head">
            <h2>New client</h2>
            <p className="note">
              Creates the company in the <code>Client</code> category and a matching
              list for its tickets.
            </p>
          </div>

          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          <div className="efgrid">
            {COMPANY_FIELDS.map(f => (
              <div className="ef" key={f.key}>
                <label htmlFor={`nc-${f.key}`}>
                  {f.label}
                  {'required' in f && f.required && <span className="ef__req" aria-hidden="true">*</span>}
                </label>
                <input
                  id={`nc-${f.key}`}
                  type="text"
                  value={draft[f.key]}
                  placeholder={'placeholder' in f ? f.placeholder : ''}
                  autoComplete="off"
                  autoFocus={f.key === 'name'}
                  onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <div className="editcard__foot">
            <span className="editcard__status">
              {saving ? 'Creating…' : 'A name is required. Check it before creating — deleting a company later takes its deals, agreements and tickets with it.'}
            </span>
            <button type="button" className="btn btn--ghost" onClick={closePanel} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!draft.name.trim() || saving}>
              Create client
            </button>
          </div>
        </form>
      )}

      {state.phase === 'loading' && <p className="empty">Loading clients…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load clients'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
          </p>
        </div>
      )}

      {state.phase === 'ready' && state.rows.length === 0 && (
        <div className="callout callout--plain">
          <p className="callout__title">No clients yet</p>
          <p>
            The Maestro answered, and the <code>Client</code> category is empty.
            Use <strong>New client</strong> above to add the first one.
          </p>
        </div>
      )}

      {state.phase === 'ready' && rows.length > 0 && shown.length === 0 && (
        <div className="callout callout--plain">
          <p className="callout__title">No match</p>
          <p>
            {/* Name both filters when both are on: "no match" with an owner chip still
                pressed off-screen is the classic way to think your data vanished. */}
            No client matches{search.trim() && <> “{search.trim()}”</>}
            {search.trim() && owner && ' '}
            {owner && <>under {ownerLabel}</>}.{' '}
            <button
              type="button"
              className="linkbtn"
              onClick={() => { setSearch(''); setOwner('') }}
            >
              Clear {search.trim() && owner ? 'both filters' : 'the filter'}
            </button>.
          </p>
        </div>
      )}

      {state.phase === 'ready' && shown.length > 0 && (
        <>
          <p className="page__count">
            {search.trim() || owner
              ? `${shown.length} of ${rows.length} client${rows.length === 1 ? '' : 's'}`
              : `${rows.length} client${rows.length === 1 ? '' : 's'}`}
            {owner && <> · {ownerLabel}</>}
          </p>
          <div className="tablewrap">
            <table className="fields">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Account owner</th>
                  <th scope="col">Last touch</th>
                  <th scope="col">Website</th>
                  <th scope="col">City</th>
                  <th scope="col">State</th>
                  <th scope="col">Postal</th>
                  <th scope="col"><span className="visually-hidden">Their org</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map(row => (
                  <tr key={row.id} className="rowlink">
                    <th scope="row">
                      {/* A real link, so the row is keyboard-reachable and opens in a
                          new tab on middle-click, not a div with an onClick. */}
                      <Link className="rowlink__a" to={`/clients/${row.id}`}>
                        {row.name || <span className="muted">(unnamed)</span>}
                      </Link>
                    </th>
                    {/* The account owner: who is answerable for this live client system.
                        Cached on the company by `setAccountOwner`, so it is a name here,
                        not a lookup. Unassigned is worth seeing at a glance, hence the
                        explicit word rather than a dash. */}
                    <td>
                      {row.owner || <span className="muted">Unassigned</span>}
                    </td>
                    {/* Days, not a date: "37 days" is the question people are asking of
                        this column, and a date makes them do the arithmetic. The date and
                        what the contact actually was live in the tooltip. */}
                    <td>
                      {touch[row.id]
                        ? (
                          <span
                            className="pill"
                            data-touch={touch[row.id].band}
                            title={
                              touch[row.id].band === 'never'
                                ? `No contact ever logged. Cadence: every ${touch[row.id].cadence}d.`
                                : `${touch[row.id].type || 'Contact'} on ${touch[row.id].when}. ` +
                                  `Cadence: every ${touch[row.id].cadence}d.`
                            }
                          >
                            {touchLabel(touch[row.id])}
                          </span>
                        )
                        : <span className="muted">-</span>}
                    </td>
                    <td>
                      {row.website
                        ? <a className="inlink" href={row.website} target="_blank" rel="noopener noreferrer">{row.website}</a>
                        : <span className="muted">-</span>}
                    </td>
                    <td>{row.city || <span className="muted">-</span>}</td>
                    <td>{row.state || <span className="muted">-</span>}</td>
                    <td>{row.postalCode || <span className="muted">-</span>}</td>
                    {/* Straight into the client's own BlueStep org. A new tab, always:
                        this leaves Cobalt for a different system entirely, and coming
                        "back" would mean losing whatever you had open here. */}
                    <td className="clients__org">
                      {row.ehrLink
                        ? (
                          <a className="btn btn--ghost btn--sm" href={row.ehrLink}
                            target="_blank" rel="noopener noreferrer"
                            title={`Open ${row.name || 'this client'} in a new tab`}>
                            Go to Org ↗
                          </a>
                        )
                        : <span className="muted">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
