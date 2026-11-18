import { useEffect, useMemo, useState } from 'react'
import { answerMap, type AnswerInput, type Answers, type Rubric, type SideInput } from '../evaluations'

/*
 * The five values, scored 1–5 with a reason each, then two open reflections.
 *
 * One component for both sides of an evaluation, so the person and their supervisor
 * answer literally the same questions. Each value shows its five level definitions as a
 * row of buttons; the chosen level's definition stays visible under the row, because the
 * definition IS the standard being claimed, and a score picked without reading it is a
 * number, not an assessment.
 */

interface Props {
  rubric: Rubric
  answers: Answers | undefined
  editable: boolean
  /** Who is answering: changes only the hint copy, never the questions. */
  perspective: 'self' | 'supervisor'
  busy?: boolean
  /** Resolves when saved; rejects (and keeps the typed draft) when it did not. */
  onSave?: (side: SideInput, submit: boolean) => Promise<void>
}

const REASON_HINT = {
  self: 'The reasons and specific examples behind your score.',
  supervisor: 'The reasons and specific examples behind your score for them.',
}
/* Brandon's wording (2026-11-18), shown under each heading. The self versions are
   mirrored in the public page (Cobalt Self Assessment endpoint): change both. */
const PROUD_HINT = {
  self: "Where would you pat yourself on the back? In what areas do you feel like you're having a lot of success, " +
    'or are particularly proud of? This is a space to highlight yourself.',
  supervisor: 'Where would you pat them on the back? In what areas are they having a lot of success, ' +
    'or should they be particularly proud of? This is a space to highlight them.',
}
const IMPROVE_HINT = {
  self: 'As you reflect, what areas do you see you can make improvements on? What has held you back from that in the past? ' +
    "What is one specific thing you'll do differently next quarter, and what support from your supervisor or the team would help you get there?",
  supervisor: 'What areas do you see they can make improvements on? What has held them back from that in the past? ' +
    'What is one specific thing they should do differently next quarter, and what support will you or the team give them?',
}

export default function ValuesForm({ rubric, answers, editable, perspective, busy, onSave }: Props) {
  const initial = useMemo(() => answerMap(rubric, answers), [rubric, answers])
  const [draft, setDraft] = useState<Record<string, AnswerInput>>(initial)
  const [proud, setProud] = useState(answers?.proud || '')
  const [improve, setImprove] = useState(answers?.improve || '')
  const [dirty, setDirty] = useState(false)
  const [openLevels, setOpenLevels] = useState<Record<string, boolean>>({})

  // A fresh server copy replaces the draft only when nothing is being typed over it.
  useEffect(() => {
    if (dirty) return
    setDraft(initial)
    setProud(answers?.proud || '')
    setImprove(answers?.improve || '')
  }, [initial, answers, dirty])

  // Warn before losing typed work.
  useEffect(() => {
    if (!dirty || !editable) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty, editable])

  const setScore = (key: string, score: number) => {
    setDraft(prev => ({ ...prev, [key]: { ...prev[key], score } })); setDirty(true)
  }
  const setReason = (key: string, reason: string) => {
    setDraft(prev => ({ ...prev, [key]: { ...prev[key], reason } })); setDirty(true)
  }

  const missing = rubric.values.filter(v => !draft[v.key]?.score || !draft[v.key]?.reason.trim()).length
    + (proud.trim() ? 0 : 1) + (improve.trim() ? 0 : 1)

  function save(submit: boolean) {
    if (!onSave) return
    if (submit && !window.confirm(
      perspective === 'self'
        ? 'Submit your self-assessment? You will not be able to change it afterwards unless your supervisor reopens it.'
        : 'Submit the supervisor review? Reopen it later if something needs to change.',
    )) return
    onSave({ values: rubric.values.map(v => draft[v.key]), proud, improve }, submit)
      .then(() => setDirty(false))
      .catch(() => { /* the page shows the error; the draft stays as typed */ })
  }

  const scaleLabel = (n: number | null) => rubric.scale.find(s => s.score === n)?.label || ''

  return (
    <div className="vform">
      {rubric.values.map(v => {
        const a = draft[v.key]
        const showAll = !!openLevels[v.key]
        return (
          <section className="vcard" key={v.key}>
            <header className="vcard__head">
              <h3>{v.name}</h3>
              {!editable && a.score != null && (
                <span className="vscore" data-score={a.score}>{a.score} · {scaleLabel(a.score)}</span>
              )}
            </header>
            <p className="vcard__summary">{v.summary}</p>

            {editable && (
              <div className="vscale" role="radiogroup" aria-label={`${v.name} score`}>
                {rubric.scale.map(s => (
                  <button
                    key={s.score}
                    type="button"
                    role="radio"
                    aria-checked={a.score === s.score}
                    data-on={a.score === s.score ? '' : undefined}
                    disabled={busy}
                    onClick={() => setScore(v.key, s.score)}
                    title={v.levels[String(s.score)]}
                  >
                    <b>{s.score}</b>
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            )}

            {a.score != null && (
              <p className="vlevel"><b>{a.score}.</b> {v.levels[String(a.score)]}</p>
            )}

            <button type="button" className="linkbtn vcard__levels-toggle"
              onClick={() => setOpenLevels(prev => ({ ...prev, [v.key]: !showAll }))}>
              {showAll ? 'Hide what each score means' : 'What does each score mean?'}
            </button>
            {showAll && (
              <ul className="vlevels">
                {rubric.scale.map(s => (
                  <li key={s.score} data-on={a.score === s.score ? '' : undefined}>
                    <b>{s.score} · {s.label}.</b> {v.levels[String(s.score)]}
                  </li>
                ))}
              </ul>
            )}

            {editable ? (
              <div className="ef ef--wide">
                <label htmlFor={`r-${v.key}`}>Reason and examples</label>
                <textarea id={`r-${v.key}`} rows={4} value={a.reason} disabled={busy}
                  placeholder={REASON_HINT[perspective]}
                  onChange={e => setReason(v.key, e.target.value)} />
              </div>
            ) : (
              <p className="vreason">{a.reason || <span className="muted">No reason given.</span>}</p>
            )}
          </section>
        )
      })}

      <section className="vcard vcard--reflect">
        <header className="vcard__head"><h3>Areas you're proud of</h3></header>
        {editable && <p className="vcard__summary">{PROUD_HINT[perspective]}</p>}
        {editable ? (
          <textarea rows={7} value={proud} disabled={busy} aria-label="Areas you're proud of"
            onChange={e => { setProud(e.target.value); setDirty(true) }} />
        ) : <p className="vreason">{proud || <span className="muted">Nothing written.</span>}</p>}
      </section>

      <section className="vcard vcard--reflect">
        <header className="vcard__head"><h3>Areas for improvement</h3></header>
        {editable && <p className="vcard__summary">{IMPROVE_HINT[perspective]}</p>}
        {editable ? (
          <textarea rows={7} value={improve} disabled={busy} aria-label="Areas for improvement"
            onChange={e => { setImprove(e.target.value); setDirty(true) }} />
        ) : <p className="vreason">{improve || <span className="muted">Nothing written.</span>}</p>}
      </section>

      {editable && onSave && (
        <div className="vform__foot">
          <span className="editcard__status">
            {busy ? 'Saving…' : dirty ? 'Unsaved changes' : missing ? `${missing} left to answer` : 'Ready to submit'}
          </span>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => save(false)}>
            Save draft
          </button>
          <button type="button" className="btn" disabled={busy || missing > 0} onClick={() => save(true)}
            title={missing ? 'Every value needs a score and a reason, and both reflections need writing.' : undefined}>
            Submit
          </button>
        </div>
      )}
    </div>
  )
}
