import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api'
import { getEvaluation, saveSelfAssessment, shortDate, type EvaluationDetail, type SideInput } from '../evaluations'
import ValuesForm from '../components/ValuesForm'

/*
 * /self-assessment/:staffId/:entryId - the page behind the link a supervisor sends.
 *
 * No capability gate: anyone signed in can open the URL, and the Maestro decides. It
 * answers the person themselves (and their reviewers) and 404s everyone else, so a
 * forwarded link shows nothing.
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; data: EvaluationDetail }
  | { phase: 'error'; message: string }

export default function SelfAssessment() {
  const { staffId = '', entryId = '' } = useParams()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback(() => {
    getEvaluation(staffId, entryId)
      .then(data => setState({ phase: 'ready', data }))
      .catch(err => setState({ phase: 'error', message: err instanceof ApiError ? err.message : String(err) }))
  }, [staffId, entryId])

  useEffect(() => { load() }, [load])

  function save(side: SideInput, submit: boolean): Promise<void> {
    setBusy(true); setNotice(''); setFailure('')
    return saveSelfAssessment(staffId, entryId, side, submit)
      .then(data => {
        setState({ phase: 'ready', data })
        setNotice(submit ? 'Submitted. Thank you.' : 'Draft saved. You can come back to this link and finish later.')
        if (submit) window.scrollTo({ top: 0, behavior: 'smooth' })
      })
      .catch(err => {
        setFailure(err instanceof ApiError ? err.message : String(err))
        throw err
      })
      .finally(() => setBusy(false))
  }

  if (state.phase === 'loading') return <section className="page"><p className="empty">Loading…</p></section>
  if (state.phase === 'error') {
    return (
      <section className="page">
        <div className="callout">
          <p className="callout__title">This self-assessment isn't available</p>
          <p>{state.message}</p>
          <p className="callout__actions"><Link className="btn" to="/">Go home</Link></p>
        </div>
      </section>
    )
  }

  const { data } = state
  const ev = data.evaluation
  const submitted = ev.self.status === 'Submitted'
  const notOpen = ev.self.status === 'Not Sent'

  return (
    <section className="page page--narrow">
      <header className="page__head">
        <p className="eyebrow">Quarterly evaluation · {ev.quarter}</p>
        <h1>{data.isSelf ? 'Your self-assessment' : `${data.name}: self-assessment`}</h1>
        {!submitted && data.isSelf && !notOpen && (
          <p className="page__sub-text">{data.rubric.instructions}</p>
        )}
        {submitted && (
          <p className="page__sub-text">
            Submitted {shortDate(ev.self.submittedAt)}. {data.isSelf
              ? 'Your supervisor will go over it with you. If something needs to change, ask them to reopen it.'
              : ''}
          </p>
        )}
      </header>

      {notice && <p className="board2__notice" role="status">{notice}</p>}
      {failure && <p className="editcard__err" role="alert">{failure}</p>}

      {notOpen ? (
        <div className="callout">
          <p className="callout__title">Not open yet</p>
          <p>This self-assessment hasn't been sent yet.</p>
        </div>
      ) : (
        <ValuesForm
          rubric={data.rubric}
          answers={ev.self.answers}
          editable={data.can.editSelf}
          perspective="self"
          busy={busy}
          onSave={save}
        />
      )}

      {data.isReviewer && !data.isSelf && (
        <p className="panel__foot">
          <Link className="inlink" to={`/staff/${staffId}/evaluations/${entryId}`}>Open the full evaluation log</Link>
        </p>
      )}
    </section>
  )
}
