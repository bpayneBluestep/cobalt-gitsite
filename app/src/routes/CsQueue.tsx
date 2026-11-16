import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError, formatMoney, getCsQueue, getSurveyProblems, logTouchpoint,
  moneyWithheld, setSupportIntensity, surveyStateLabel, INTENSITY_DEFINITIONS, TEMPERATURES, TOUCHPOINT_TYPES,
  type CsInfo, type CsQueue as CsQueueData, type CsRow, type CsVocabularies, type SurveyProblems,
} from '../api'
import CsNav from '../components/CsNav'
import OwnerScope, { ScopeNote, useScope } from '../components/OwnerScope'
import { useSession } from '../session'
import { todayISO } from '../lib/time'

/*
 * The Monday screen.
 *
 * Every current client, with a health colour Cobalt worked out and a sentence saying
 * why: sorted so the worst thing is at the top. Nobody maintains a health field:
 * silence alone degrades an account, on a cadence matched to how much hand-holding
 * that client needs, so an account can go Red with nobody typing anything.
 *
 * Built on the follow-ups queue's skeleton on purpose. It is the same kind of screen,
 * a list of things owed, each actionable in place, and a queue you have to leave in
 * order to act on is a queue people stop using. Logging a touchpoint here re-renders
 * the row from the reply, so the account leaves "check due" without a reload.
 *
 * Scope opens on Everyone, unlike the CRM screens. Client Success is one person
 * covering every account today; opening on Mine would show them an empty screen and
 * tell them nothing is wrong.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: CsQueueData }
  | { phase: 'error'; error: ApiError }

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

/** Which form is open on which row. One at a time: three open editors is not a queue. */
type OpenForm =
  | { kind: 'none' }
  | { kind: 'log'; companyId: string }
  | { kind: 'intensity'; companyId: string }

function Kpi({ label, value, note, tone }: {
  label: string; value: string; note?: string; tone?: 'good' | 'warn' | 'bad'
}) {
  return (
    <div className="kpi" data-tone={tone}>
      <p className="kpi__k">{label}</p>
      <p className="kpi__v">{value}</p>
      {note && <p className="kpi__n">{note}</p>}
    </div>
  )
}

/**
 * The urgency spine on a row, borrowed from the follow-up queue's own states.
 *
 * Red reads as overdue and Yellow as due today because that is exactly what they mean
 * here: an account past twice its cadence is work you are already late on.
 */
const spine = (health: string) =>
  health === 'Red' ? 'overdue' : health === 'Yellow' ? 'today' : undefined

/**
 * The three groups, in the order they are worked.
 *
 * There used to be a fourth, Surveys due, with a Copy invite button. Surveys are now
 * sent by Cobalt itself (the Survey Runner), so nobody owes one: each row says where
 * its survey stands, and anything stopping one from going out is listed at the top.
 */
type GroupKey = 'act' | 'check' | 'healthy'

const GROUPS: { key: GroupKey; title: string; blurb: string }[] = [
  { key: 'act', title: 'Act now', blurb: 'Never contacted, gone quiet, or a Red reading.' },
  { key: 'check', title: 'Check due', blurb: 'Past cadence, or the last reading was Yellow or has expired.' },
  { key: 'healthy', title: 'Healthy', blurb: 'Fresh Green reading, inside cadence. Nothing owed.' },
]

/**
 * Where a row goes.
 *
 * Health alone decides. Surveys are not a group any more: Cobalt sends them itself, so
 * a survey is never something a person owes. Each row just says where its survey stands.
 */
function groupOf(r: CsRow): GroupKey {
  if (r.health === 'Red') return 'act'
  if (r.health === 'Yellow') return 'check'
  return 'healthy'
}

/** Never-touched first, then longest silence. */
function sortRows(rows: CsRow[]): CsRow[] {
  return rows.slice().sort((a, b) => {
    if (a.neverTouched !== b.neverTouched) return a.neverTouched ? -1 : 1
    const ageA = a.contactAgeDays === null ? Infinity : a.contactAgeDays
    const ageB = b.contactAgeDays === null ? Infinity : b.contactAgeDays
    return ageB - ageA
  })
}

export default function CsQueue() {
  const { can } = useSession()
  const mayEdit = can('editCs')

  const [, , ownerId] = useScope('cs')
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [open, setOpen] = useState<OpenForm>({ kind: 'none' })
  const [showHealthy, setShowHealthy] = useState(false)
  /* What is stopping surveys from going out. Its own call, and allowed to fail quietly:
     the queue is still the queue without it. */
  const [surveys, setSurveys] = useState<SurveyProblems | null>(null)
  useEffect(() => {
    getSurveyProblems().then(setSurveys).catch(() => setSurveys(null))
  }, [])

  /*
   * Rows patched in place from an action's reply.
   *
   * `logTouchpoint` returns the freshly computed health, so the row can be corrected
   * without another walk of every company, which is the whole point of acting from
   * the queue. Keyed by company id and cleared on every reload.
   */
  const [patched, setPatched] = useState<Record<string, CsInfo>>({})

  const load = useCallback((who: string) => {
    setState({ phase: 'loading' })
    setPatched({})
    getCsQueue(who ? { ownerId: who } : {})
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err : new ApiError(String(err)),
      }))
  }, [])

  useEffect(() => { load(ownerId) }, [load, ownerId])

  const d = state.phase === 'ready' ? state.data : null

  const rows = useMemo(() => {
    if (!d) return []
    const merged = d.rows.map(r => (patched[r.companyId] ? { ...r, ...patched[r.companyId] } : r))
    const q = search.trim().toLowerCase()
    if (!q) return merged
    return merged.filter(r =>
      [r.companyName, r.reason, r.owner, r.supportIntensity]
        .some(v => String(v || '').toLowerCase().includes(q)))
  }, [d, patched, search])

  const grouped = useMemo(() => {
    const out: Record<GroupKey, CsRow[]> = { act: [], check: [], healthy: [] }
    for (const r of rows) out[groupOf(r)].push(r)
    return {
      act: sortRows(out.act),
      check: sortRows(out.check),
      healthy: out.healthy.slice().sort((a, b) => a.companyName.localeCompare(b.companyName)),
    }
  }, [rows])

  function run(id: string, work: Promise<unknown>, done: (result: unknown) => void) {
    setBusy(id)
    setFailure('')
    setNotice('')
    work
      .then(done)
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(''))
  }

  /** Fold a fresh `cs` into the row, so the account moves group without a reload. */
  function patch(companyId: string, cs: CsInfo, message: string) {
    setPatched(p => ({ ...p, [companyId]: cs }))
    setOpen({ kind: 'none' })
    setNotice(message)
  }

  const isOpen = (kind: OpenForm['kind'], companyId: string) =>
    open.kind !== 'none' && open.kind === kind && open.companyId === companyId

  const headline = d ? d.headline : null
  const pct = headline && headline.goodStandingPct !== null ? headline.goodStandingPct : null

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Cobalt</p>
        <h1>Client Success</h1>
        <p className="page__sub-text">
          No client goes quiet, no bad signal goes unowned. Every current client is here
          with a computed health and the reason for it: worst first.
        </p>
      </header>

      <CsNav counts={d ? { Queue: d.headline.red + d.headline.checksDue } : undefined} />

      {state.phase === 'loading' && <p className="empty">Working out where every client stands…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.error.needsLogin ? 'Sign in required' : 'Could not load the queue'}
          </p>
          <p>{state.error.message}</p>
          <p className="callout__actions">
            {state.error.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={() => load(ownerId)}>Try again</button>}
          </p>
        </div>
      )}

      {d && headline && (
        <>
          <div className="pipebar">
            <div className="pipebar__totals">
              <span><strong>{headline.clients}</strong> client{headline.clients === 1 ? '' : 's'}</span>
              <span className={headline.red ? 'bad' : undefined}><strong>{headline.red}</strong> red</span>
              <span className="muted"><strong>{headline.green}</strong> green</span>
            </div>
            <div className="pipebar__tools">
              <div className="ef ef--narrow">
                <label htmlFor="cs-search">Search</label>
                <input id="cs-search" type="search" value={search} autoComplete="off"
                  placeholder="Company, reason, owner…"
                  onChange={e => setSearch(e.target.value)} />
              </div>
              {/* Everyone by default: one specialist covers every account, so a Mine
                  filter would open the screen on nothing at all. */}
              <OwnerScope store="cs" />
            </div>
          </div>

          <ScopeNote ownerName={null} store="cs" />

          <div className="kpis">
            <Kpi
              label="Good standing"
              value={pct === null ? '-' : `${pct}%`}
              note={pct === null
                ? 'no clients to measure'
                : `${headline.green} of ${headline.clients} on a fresh Green inside cadence`}
              tone={pct === null ? undefined : headline.tone}
            />
            <Kpi
              label="Red accounts"
              value={String(headline.red)}
              note="never contacted, gone quiet or a Red reading"
              tone={headline.red ? 'bad' : undefined}
            />
            <Kpi
              label="Checks due"
              value={String(headline.checksDue)}
              note="past cadence, nothing said yet"
              tone={headline.checksDue ? 'warn' : undefined}
            />
            <Kpi
              label="Surveys out"
              value={surveys ? String(surveys.awaiting) : '-'}
              note={surveys
                ? `${surveys.scheduled} scheduled · ${!surveys.enabled ? 'sending is off' : surveys.testMode ? 'test mode' : 'sent automatically'}`
                : 'sent automatically'}
            />
            <Kpi
              label="Survey problems"
              value={surveys ? String(surveys.problems.length) : '-'}
              note="stopping a survey from going out"
              tone={surveys && surveys.problems.length ? 'bad' : undefined}
            />
          </div>

          {notice && <p className="board2__notice" role="status">{notice}</p>}
          {failure && <p className="editcard__err" role="alert">{failure}</p>}

          {moneyWithheld(d.rows, d.moneyHidden) && (
            <p className="note">
              Revenue is hidden for your roles, so these rows carry no MRR. Health does not
              depend on it. Nothing on this screen is missing because of it.
            </p>
          )}

          {surveys && surveys.problems.length > 0 && (
            <section className="panel">
              <header className="panel__head">
                <h2>Stopping a survey from going out</h2>
                <span className="panel__n">{surveys.problems.length}</span>
              </header>
              <p className="panel__note">
                Surveys send themselves. These are the only things that need a person.
              </p>
              <ul className="facts__wrap">
                {surveys.problems.map((p, i) => (
                  <li key={i}>
                    {p.companyId
                      ? <><Link className="inlink" to={`/clients/${p.companyId}/contacts`}>{p.companyName}</Link>: {p.detail}</>
                      : p.detail}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/*
            Two different empty answers, because they need opposite next steps: nothing to
            show at all is a data question, and nothing matching is a filter you should
            clear.
          */}
          {d.rows.length === 0 && (
            <div className="callout callout--plain">
              <p className="callout__title">No client accounts yet</p>
              <p>
                Companies in the Client category appear here. Move one over from{' '}
                <Link className="inlink" to="/clients">Clients</Link> and it lands in this
                queue with its cadence already running.
              </p>
            </div>
          )}

          {d.rows.length > 0 && rows.length === 0 && (
            <div className="callout callout--plain">
              <p className="callout__title">Nothing matches</p>
              <p>
                {search
                  ? <>No client matches “{search}”.{' '}
                      <button type="button" className="linkbtn" onClick={() => setSearch('')}>
                        Clear the search
                      </button>.</>
                  : <>This owner has no client accounts. Switch to Everyone to see the whole book.</>}
              </p>
            </div>
          )}

          {GROUPS.map(group => {
            const mine = grouped[group.key]
            if (!mine.length) return null
            const collapsed = group.key === 'healthy' && !showHealthy

            return (
              <section className="panel" key={group.key}>
                <header className="panel__head">
                  <h2>{group.title}</h2>
                  <span className="panel__n">{mine.length}</span>
                  {group.key === 'healthy' && (
                    <button type="button" className="subtoggle"
                      aria-expanded={showHealthy}
                      onClick={() => setShowHealthy(v => !v)}>
                      <span className="subtoggle__caret" aria-hidden="true">{showHealthy ? '▾' : '▸'}</span>
                      {showHealthy ? 'Hide' : 'Show'}
                    </button>
                  )}
                </header>
                <p className="panel__note">{group.blurb}</p>

                {!collapsed && (
                  <ul className="fulist">
                    {mine.map(r => (
                      <QueueRow
                        key={r.companyId}
                        row={r}
                        mayEdit={mayEdit}
                        busy={busy}
                        open={open}
                        isOpen={isOpen}
                        setOpen={setOpen}
                        vocabularies={d.vocabularies}
                        run={run}
                        patch={patch}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )
          })}

          <p className="panel__foot">
            Walked {d.companiesScanned} compan{d.companiesScanned === 1 ? 'y' : 'ies'} to build
            this, and worked out every colour from the touchpoint log, the survey responses
            and today's date. Nothing here is a stored score.
          </p>
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ one row */

function QueueRow({
  row, mayEdit, busy, open, isOpen, setOpen, vocabularies, run, patch,
}: {
  row: CsRow
  mayEdit: boolean
  busy: string
  open: OpenForm
  isOpen: (kind: OpenForm['kind'], companyId: string) => boolean
  setOpen: (o: OpenForm) => void
  vocabularies: CsVocabularies
  run: (id: string, work: Promise<unknown>, done: (result: unknown) => void) => void
  patch: (companyId: string, cs: CsInfo, message: string) => void
}) {
  const id = row.companyId
  const working = busy === id
  const anyOpen = open.kind !== 'none' && open.companyId === id

  return (
    <li className="fu" data-state={spine(row.health)}>
      <div className="fu__main">
        <p className="fu__title">
          <Link className="inlink" to={`/clients/${id}/success`}>{row.companyName}</Link>{' '}
          <span className="pill" data-tone={row.health.toLowerCase()}>{row.health}</span>
        </p>

        <p className="fu__step">{row.reason}</p>

        <p className="fu__meta">
          {/* The one place a colour is carried by CSS rather than a word: the house
              Green/Yellow/Red dot, same control the pipeline uses for confidence. */}
          <span className="dotc" data-c={row.health} title={`${row.health}: ${row.reason}`} />
          {row.neverTouched ? (
            <span className="bad">never contacted</span>
          ) : (
            <span>
              {row.lastContactType || 'contact'} · {row.contactAgeDays}d ago
            </span>
          )}
          <span className="dot" aria-hidden="true">·</span>
          <span>
            {row.supportIntensity || <span className="muted">intensity unset</span>}
            {' · every '}{row.cadenceDays}d
          </span>
          {row.temperature && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span>{row.temperature} on {row.temperatureDate}</span>
            </>
          )}
          <span className="dot" aria-hidden="true">·</span>
          <span className={row.survey && row.survey.status === 'Held' ? 'bad' : undefined}>
            survey {surveyStateLabel(row.survey)}
          </span>
          {/* Presence, not a flag: a redacted row has no `mrr` key at all. */}
          {row.mrr !== null && row.mrr !== undefined && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span>{formatMoney(row.mrr)}<span className="muted">/mo</span></span>
            </>
          )}
          {row.renewsInDays !== null && row.renewsInDays <= 90 && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span className="flag flag--warn">Renews in {row.renewsInDays}d</span>
            </>
          )}
          {row.nextFollowUp && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span className="fu__due">follow-up {row.nextFollowUp}</span>
            </>
          )}
          {row.owner && (
            <>
              <span className="dot" aria-hidden="true">·</span>
              <span className="muted">{row.owner}</span>
            </>
          )}
        </p>

        {row.nextStep && <p className="fu__step">{row.nextStep}</p>}

        {isOpen('log', id) && (
          <LogForm row={row} types={vocabularies.touchpointTypes} busy={working}
            onCancel={() => setOpen({ kind: 'none' })}
            onSave={fields => run(id, logTouchpoint(id, fields), result => {
              const r = result as { cs: CsInfo }
              patch(id, r.cs, `${row.companyName}: logged. ${r.cs.reason}`)
            })} />
        )}

        {isOpen('intensity', id) && (
          <IntensityForm row={row} levels={vocabularies.supportIntensities} busy={working}
            onCancel={() => setOpen({ kind: 'none' })}
            onSave={body => run(id, setSupportIntensity(id, body), result => {
              const r = result as { cs: CsInfo; cadenceDays: number }
              patch(id, r.cs, `${row.companyName}: now ${body.level}, every ${r.cadenceDays}d.`)
            })} />
        )}
      </div>

      {mayEdit && !anyOpen && (
        <div className="fu__acts">
          <button type="button" className="btn btn--sm" disabled={working}
            onClick={() => setOpen({ kind: 'log', companyId: id })}>
            Log touchpoint
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={working}
            onClick={() => setOpen({ kind: 'intensity', companyId: id })}>
            Intensity
          </button>
          {/*
            Escalation lives on the account's Success tab, not on this row, and it is
            deliberate rather than automatic: a CS save is usually a phone call, and
            auto-created tickets nobody triaged are noise with a number.

            It is not here because a queue row cannot tell whether this client HAS a
            ticket list: `csQueue` carries no list id, and measured against live data in
            August 2026, 14 of 91 clients had none. The tickets tab resolves-or-CREATES
            on arrival, so a link from every row would quietly mint a list for those
            fourteen the first time anyone clicked through. The Success tab knows,
            because on one company it can afford to ask.
          */}
        </div>
      )}
    </li>
  )
}

/* --------------------------------------------------------------- log a contact */

function LogForm({ row, types, busy, onCancel, onSave }: {
  row: CsRow
  types: string[]
  busy: boolean
  onCancel: () => void
  onSave: (fields: { date: string; type: string; temperature: string; notes: string }) => void
}) {
  const picker = types.length ? types : [...TOUCHPOINT_TYPES]
  const [date, setDate] = useState(todayISO())
  const [type, setType] = useState(picker[0] || 'Call')
  const [temperature, setTemperature] = useState('')
  const [notes, setNotes] = useState('')

  return (
    <div className="editcard">
      <header className="editcard__head">
        <h2>Log a touchpoint: {row.companyName}</h2>
        <p className="note">
          A record of a contact that happened. There is no edit afterwards: a wrong
          reading is corrected by logging a newer one, like a ledger.
        </p>
      </header>

      <div className="efgrid">
        <div className="ef">
          <label htmlFor={`d-${row.companyId}`}>Date</label>
          <input id={`d-${row.companyId}`} type="date" value={date} max={todayISO()}
            onChange={e => setDate(e.target.value)} />
        </div>
        <div className="ef">
          <label htmlFor={`t-${row.companyId}`}>Type<span className="ef__req">*</span></label>
          <select id={`t-${row.companyId}`} value={type} onChange={e => setType(e.target.value)}>
            {picker.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="ef">
          <label>Temperature</label>
          <div className="filters" role="group" aria-label="Temperature reading">
            {TEMPERATURES.map(t => (
              <button key={t} type="button" className="filter"
                data-on={temperature === t ? '' : undefined}
                aria-pressed={temperature === t}
                onClick={() => setTemperature(temperature === t ? '' : t)}>
                {t}
              </button>
            ))}
          </div>
          <p className="ef__hint">
            Optional, but a contact with no reading leaves the account Yellow, because
            silence about how it went proves nothing good.
          </p>
        </div>
        <div className="ef ef--wide">
          <label htmlFor={`n-${row.companyId}`}>Notes</label>
          <textarea id={`n-${row.companyId}`} rows={3} value={notes}
            placeholder="What was said, and what happens next."
            onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="editcard__foot">
        <button type="button" className="btn" disabled={busy}
          onClick={() => onSave({ date, type, temperature, notes })}>
          {busy ? 'Saving…' : 'Log it'}
        </button>
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <span className="editcard__status">
          {temperature === 'Red'
            ? 'A Red reading also sets a follow-up on this company, two days out.'
            : 'Logging resets this account’s cadence clock.'}
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------- change the intensity */

function IntensityForm({ row, levels, busy, onCancel, onSave }: {
  row: CsRow
  levels: string[]
  busy: boolean
  onCancel: () => void
  onSave: (body: { level: string; reason: string; cadenceOverrideDays?: string }) => void
}) {
  const options = levels.length ? levels : INTENSITY_DEFINITIONS.map(d => d.level)
  const [level, setLevel] = useState(row.supportIntensity || 'Standard')
  const [reason, setReason] = useState('')
  const [override, setOverride] = useState('')

  return (
    <div className="editcard">
      <header className="editcard__head">
        <h2>Support intensity: {row.companyName}</h2>
        <p className="note">
          How much ongoing guidance or hand-holding this client typically needs. Use it to
          prioritise follow-ups and tailor the level of service. It sets how often the
          queue asks about the account.
        </p>
      </header>

      <div className="efgrid">
        <div className="ef">
          <label htmlFor={`l-${row.companyId}`}>Level<span className="ef__req">*</span></label>
          <select id={`l-${row.companyId}`} value={level} onChange={e => setLevel(e.target.value)}>
            {options.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <p className="ef__hint">Currently every {row.cadenceDays} days.</p>
        </div>
        <div className="ef">
          <label htmlFor={`o-${row.companyId}`}>Cadence override (days)</label>
          <input id={`o-${row.companyId}`} type="number" min={1} max={365} value={override}
            placeholder="leave blank to use the level"
            onChange={e => setOverride(e.target.value)} />
          <p className="ef__hint">
            For the accounts that need their own rhythm, 7 for a weekly outreach client.
            Blank clears it.
          </p>
        </div>
        <div className="ef ef--wide">
          <label htmlFor={`r-${row.companyId}`}>Reason<span className="ef__req">*</span></label>
          <textarea id={`r-${row.companyId}`} rows={2} value={reason}
            placeholder="Why this is changing."
            onChange={e => setReason(e.target.value)} />
          <p className="ef__hint">
            Required: it is the audit trail. The change is logged as an Intensity Change
            touchpoint, which does not count as contact.
          </p>
        </div>
      </div>

      <ul className="callout__list">
        {INTENSITY_DEFINITIONS.map(d => (
          <li key={d.level}><strong>{d.level}</strong> · {d.what}</li>
        ))}
      </ul>

      <div className="editcard__foot">
        <button type="button" className="btn" disabled={busy || !reason.trim()}
          onClick={() => onSave({
            level,
            reason: reason.trim(),
            cadenceOverrideDays: override.trim(),
          })}>
          {busy ? 'Saving…' : 'Set the intensity'}
        </button>
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <span className="editcard__status">
          {reason.trim() ? 'Changes the cadence, and so the health, immediately.' : 'A reason is required.'}
        </span>
      </div>
    </div>
  )
}
