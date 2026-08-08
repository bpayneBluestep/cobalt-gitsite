import { useCallback, useEffect, useState } from 'react'
import {
  ApiError, getAccountOwner, setAccountOwner, getUsers,
  type AccountOwner, type User,
} from '../api'
import { todayISO } from '../lib/time'

/*
 * Who owns this client, and since when.
 *
 * The history is deliberately not shown — it is kept so that the question "who had this
 * last spring" has an answer later, and a table nobody reads yet would just be noise. The
 * count is surfaced instead, so it is obvious the history exists.
 *
 * Handing over closes the previous stint the day before the new one starts, which is why
 * the date matters and why the endpoint refuses a date on or before the current start.
 */

export default function AccountOwnerCard({ companyId, onChanged }: {
  companyId: string
  onChanged?: () => void
}) {
  const [data, setData] = useState<AccountOwner | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)
  const [pick, setPick] = useState('')
  const [from, setFrom] = useState(todayISO())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    getAccountOwner(companyId)
      .then(setData)
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [companyId])

  useEffect(load, [load])
  useEffect(() => { getUsers().then(u => setUsers(u.rows)).catch(() => setUsers([])) }, [])

  function assign(userId: string) {
    if (busy) return
    setBusy(true); setFailure(''); setNotice('')
    setAccountOwner(companyId, userId, from, note)
      .then(fresh => {
        setData(fresh)
        setAssigning(false)
        setNote('')
        setNotice(fresh.current
          ? `${fresh.current.userName} owns this from ${fresh.current.from}.`
          : 'This client has no owner now.')
        if (onChanged) onChanged()
      })
      .catch(err => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="editcard">
      <div className="editcard__head">
        <h2>Account owner</h2>
        <p className="note">
          Who is in charge of this client. Each handover is date-bounded, so the history
          is kept even though nothing shows it yet.
        </p>
      </div>

      {failure && <p className="editcard__err" role="alert">{failure}</p>}
      {notice && <p className="board2__notice" role="status">{notice}</p>}

      {loading && <p className="empty">Loading…</p>}

      {data && data.conflict && (
        <div className="callout callout--warn">
          <p className="callout__title">More than one owner is open</p>
          <p>
            Two stints have no end date, which can only happen if one was cleared on the
            BlueStep form directly. Assigning an owner below will close them all.
          </p>
        </div>
      )}

      {data && !assigning && (
        <>
          <dl className="facts">
            <div>
              <dt>Current owner</dt>
              <dd>
                {data.current ? (
                  <>
                    <strong>{data.current.userName}</strong>
                    <span className="muted"> since {data.current.from}</span>
                  </>
                ) : <span className="muted">Nobody — this client is unowned</span>}
              </dd>
            </div>
            <div>
              <dt>History kept</dt>
              <dd>
                {data.history.length === 0
                  ? <span className="muted">No previous owners</span>
                  : `${data.history.length} previous ${data.history.length === 1 ? 'stint' : 'stints'}`}
              </dd>
            </div>
          </dl>
          <div className="editcard__foot">
            <span className="editcard__status" />
            {data.current && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
                onClick={() => { setPick(''); setFrom(todayISO()); setAssigning(true) }}>
                Hand over
              </button>
            )}
            {!data.current && (
              <button type="button" className="btn btn--sm" disabled={busy}
                onClick={() => { setPick(''); setFrom(todayISO()); setAssigning(true) }}>
                Assign an owner
              </button>
            )}
          </div>
        </>
      )}

      {data && assigning && (
        <>
          <div className="efgrid">
            <div className="ef">
              <label htmlFor="ao-user">New owner</label>
              <select id="ao-user" value={pick} onChange={e => setPick(e.target.value)}>
                <option value="">Pick a person…</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="ef">
              <label htmlFor="ao-from">Owned from</label>
              <input id="ao-from" type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </div>
            <div className="ef ef--wide">
              <label htmlFor="ao-note">Handover note</label>
              <input id="ao-note" type="text" value={note} autoComplete="off"
                placeholder="Anything the new owner needs to know"
                onChange={e => setNote(e.target.value)} />
            </div>
          </div>
          <p className="panel__foot">
            {data.current
              ? `${data.current.userName}'s stint will be closed the day before this date.`
              : 'Nobody holds this client at the moment.'}
          </p>
          <div className="editcard__foot">
            <span className="editcard__status">{busy ? 'Saving…' : ''}</span>
            {data.current && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
                onClick={() => assign('')}>
                Leave unowned
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={() => setAssigning(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => assign(pick)} disabled={busy || !pick}>
              {data.current ? 'Hand over' : 'Assign'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
