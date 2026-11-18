import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api'
import { createEvaluation, getEvaluations, type EvaluationList } from '../evaluations'

/*
 * The Evaluations panel on a staff record: every quarterly evaluation log for this person,
 * and the button that starts the next one. The quarter defaults to the one being evaluated
 * now (the quarter that just ended, during the first 30 days of a new one).
 */

function splitQuarter(q: string): { year: number; quarter: number } {
  const m = /^(\d{4}) Q([1-4])$/.exec(q)
  const now = new Date()
  return m ? { year: Number(m[1]), quarter: Number(m[2]) } : { year: now.getFullYear(), quarter: Math.floor(now.getMonth() / 3) + 1 }
}

export default function EvaluationsPanel({ staffId, name }: { staffId: string; name: string }) {
  const navigate = useNavigate()
  const [data, setData] = useState<EvaluationList | null>(null)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const [year, setYear] = useState(0)
  const [quarter, setQuarter] = useState(0)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    getEvaluations(staffId)
      .then(d => { setData(d); setError('') })
      .catch(err => setError(err instanceof ApiError ? err.message : String(err)))
  }, [staffId])

  useEffect(() => { load() }, [load])

  function startPicking() {
    if (!data) return
    const d = splitQuarter(data.defaultQuarter)
    setYear(d.year); setQuarter(d.quarter); setPicking(true)
  }

  function create() {
    setBusy(true); setError('')
    createEvaluation(staffId, `${year} Q${quarter}`)
      .then(r => navigate(`/staff/${staffId}/evaluations/${encodeURIComponent(r.evaluation.entryId)}`))
      .catch(err => { setError(err instanceof ApiError ? err.message : String(err)); setBusy(false) })
  }

  const thisYear = new Date().getFullYear()
  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2]
  const existing = new Set((data?.rows || []).map(r => r.quarter))
  const chosen = `${year} Q${quarter}`

  return (
    <div className="panel">
      <div className="panel__head">
        <h2>Quarterly evaluations</h2>
        {data?.isReviewer && !picking && (
          <button type="button" className="btn btn--sm" onClick={startPicking}>New evaluation</button>
        )}
      </div>

      {error && <p className="editcard__err" role="alert">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {picking && (
        <div className="evpick">
          <div className="ef">
            <label htmlFor="ev-q">Quarter</label>
            <select id="ev-q" value={quarter} onChange={e => setQuarter(Number(e.target.value))}>
              {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
            </select>
          </div>
          <div className="ef">
            <label htmlFor="ev-y">Year</label>
            <select id="ev-y" value={year} onChange={e => setYear(Number(e.target.value))}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="evpick__actions">
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setPicking(false)}>Cancel</button>
            <button type="button" className="btn" disabled={busy} onClick={create}>
              {busy ? 'Opening…' : existing.has(chosen) ? `Open ${chosen}` : `Start ${chosen}`}
            </button>
          </div>
        </div>
      )}

      {data && (data.rows.length ? (
        <table className="evlist">
          <thead>
            <tr><th>Quarter</th><th>Self-assessment</th>{data.isReviewer && <><th>Supervisor review</th><th>Formal evaluation</th></>}</tr>
          </thead>
          <tbody>
            {data.rows.map(r => (
              <tr key={r.entryId}>
                <td>
                  <Link className="inlink" to={data.isReviewer
                    ? `/staff/${staffId}/evaluations/${encodeURIComponent(r.entryId)}`
                    : `/self-assessment/${staffId}/${encodeURIComponent(r.entryId)}`}>
                    {r.quarter}
                  </Link>
                </td>
                <td><span className="evstatus" data-kind={kindOf(r.self.status)}>{r.self.status}</span></td>
                {data.isReviewer && (
                  <>
                    <td><span className="evstatus" data-kind={kindOf(r.supervisor?.status || '')}>{r.supervisor?.status}</span></td>
                    <td>{r.formalEvaluation?.hasFile
                      ? <a className="inlink" href={r.formalEvaluation.url} target="_blank" rel="noopener noreferrer">Attached</a>
                      : <span className="muted">-</span>}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        !picking && <p className="muted">No evaluations for {name} yet.</p>
      ))}
    </div>
  )
}

function kindOf(status: string): string {
  return status === 'Submitted' ? 'done' : status === 'Not Sent' || status === 'Not Started' ? 'idle' : 'open'
}
