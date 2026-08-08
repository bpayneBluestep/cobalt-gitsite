import { formatTyped, isPhoneOk, PHONE_HINT } from '../lib/phone'

/*
 * A phone field that formats itself.
 *
 * Type digits and the punctuation appears; paste anything and it is re-punctuated. The
 * only way to end up with a number the platform will refuse is an area code or prefix
 * starting 0 or 1, which is called out under the field rather than corrected — see
 * lib/phone.ts for why shifting someone's digits is the worse option.
 */

export default function PhoneInput({ id, value, onChange, autoFocus }: {
  id: string
  value: string
  onChange: (next: string) => void
  autoFocus?: boolean
}) {
  const bad = !isPhoneOk(value)
  return (
    <>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        autoFocus={autoFocus}
        value={value}
        placeholder="(555) 234-0101"
        aria-invalid={bad || undefined}
        aria-describedby={bad ? `${id}-hint` : undefined}
        onChange={e => onChange(formatTyped(value, e.target.value))}
      />
      {bad && <span className="ef__warn" id={`${id}-hint`}>{PHONE_HINT}</span>}
    </>
  )
}
