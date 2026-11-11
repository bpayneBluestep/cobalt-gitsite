import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError, getUsers, type Company } from '../api'
import { useSession } from '../session'
import {
  getAgreementsReport, getEnvelope, voidEnvelope, listAgreementTemplates,
  type AgreementsReport as Report, type AgreementsReportRow as Row,
  type AgreementsReportRecipient as Recipient, type Envelope, type EnvHost,
} from '../agreements/api'
import { EnvHostContext, EnvelopeDetail, NewEnvelopeModal, renderThumbs, type PickOpt } from './CompanyAgreements'
import { downloadCsv } from '../lib/csv'
import '../agreements/agreements.css'

/*
 * The Agreements report.
 *
 * One question: of everything we have sent for signature, where does each one stand?
 * Envelopes live on their company record, so until now answering it meant opening every
 * client's Agreements tab. This page reads them all at once (Maestro `agreementsReport`)
 * and leads with what still needs chasing.
 *
 * "Waiting on" is the people the envelope is blocked on RIGHT NOW. On a sequential
 * envelope that is only the active routing order: the countersigner after them has not
 * been asked yet, so naming them would send you chasing the wrong person.
 *
 * Test and demo envelopes (the E2E and self-test companies) are hidden by default. The
 * rule is a name match, so it is stated on screen and one click undoes it.
 *
 * STANDALONE agreements (Leadership + Sales only) are also started and worked here:
 * one-off paperwork with no company attached, such as a referral agreement. They live
 * on the Organization record whose template library they came from, so the signed PDFs
 * land beside it. "New agreement" opens the same envelope editor the company tab uses,
 * wrapped in an org host; a standalone row opens back into it. The server returns
 * standalone rows only to callers with editAgreements.
 */

type Bucket = 'open' | 'draft' | 'completed' | 'closed' | 'all'

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'open', label: 'Out for signature' },
  { key: 'completed', label: 'Signed' },
  { key: 'draft', label: 'Drafts' },
  { key: 'closed', label: 'Declined & voided' },
  { key: 'all', label: 'All' },
]

function bucketOf(status: string): Exclude<Bucket, 'all'> {
  if (status === 'Sent' || status === 'Partially Signed') return 'open'
  if (status === 'Completed') return 'completed'
  if (status === 'Voided' || status === 'Declined') return 'closed'
  return 'draft'
}

const TEST_RE = /\b(test|e2e|demo)\b|self-test/i
const isTest = (r: Row) => TEST_RE.test(r.companyName) || TEST_RE.test(r.title)

/** Days a chase is allowed before it turns amber, then red. */
const WARN_DAYS = 7
const BAD_DAYS = 14

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; report: Report }
  | { phase: 'error'; error: string; needsLogin?: boolean }

/** The org library a standalone envelope lives in. */
interface OrgLib { orgId: string; orgName: string }

/* The envelope editor takes a company; a standalone envelope has none, so it gets a
   stand-in whose id is the org record id and whose CRM fields are blank (sender
   fields bound to the company record then start empty, to be typed at send). */
function standIn(orgId: string, orgName: string): Company {
  return { id: orgId, name: orgName } as unknown as Company
}
const orgHost = (orgId: string): EnvHost => ({ entity: 'org', id: orgId })
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const LOGIN_URL = '/shared/login/login.jsp?desturl=' +
  encodeURIComponent(window.location.pathname + window.location.search)

function isoDay(s: string): string {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

function fmtDate(s: string): string {
  const d = isoDay(s)
  if (!d) return ''
  const [y, m, day] = d.split('-')
  return `${parseInt(m, 10)}/${parseInt(day, 10)}/${y}`
}

function todayIso(): string {
  const t = new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** Whole days between two YYYY-MM-DD strings; null when either is missing. */
function daysBetween(from: string, to: string): number | null {
  const a = isoDay(from), b = isoDay(to)
  if (!a || !b) return null
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function ageTone(days: number | null): 'warn' | 'bad' | undefined {
  if (days == null) return undefined
  if (days >= BAD_DAYS) return 'bad'
  if (days >= WARN_DAYS) return 'warn'
  return undefined
}

/** Signers only: cc recipients receive a copy and never sign. */
const signers = (r: Row) => r.recipients.filter(x => x.kind !== 'cc')

function whereThey(x: Recipient): string {
  if (x.viewedAt) return `opened ${fmtDate(x.viewedAt)}`
  if (x.kind === 'consultant' || x.kind === 'inperson') return 'signs in Cobalt'
  if (x.notifiedAt) return `emailed ${fmtDate(x.notifiedAt)}, not opened`
  return 'not opened yet'
}

export default function AgreementsReport() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [bucket, setBucket] = useState<Bucket>('open')
  const [query, setQuery] = useState('')
  const [showTests, setShowTests] = useState(false)
  const [onlyStandalone, setOnlyStandalone] = useState(false)
  const { can, session } = useSession()
  const canEdit = can('editAgreements')
  const fullName = session?.fullName || ''
  const [params, setParams] = useSearchParams()
  const [notice, setNotice] = useState('')
  // Standalone editing: the org libraries, the one being created in, the open envelope.
  const [libs, setLibs] = useState<OrgLib[] | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [newIn, setNewIn] = useState<OrgLib | null>(null)
  const [openEnv, setOpenEnv] = useState<{ lib: OrgLib; env: Envelope } | null>(null)
  const [picks, setPicks] = useState<PickOpt[]>([])
  const editorRef = useRef<HTMLDivElement | null>(null)
  // Document thumbnails in the open standalone envelope (pdf.js, cached per url).
  useEffect(() => { renderThumbs(editorRef.current) })

  const load = useCallback(() => {
    setState({ phase: 'loading' })
    getAgreementsReport()
      .then(report => setState({ phase: 'ready', report }))
      .catch(err => setState({
        phase: 'error',
        error: err instanceof ApiError ? err.message : String(err),
        needsLogin: err instanceof ApiError && err.needsLogin,
      }))
  }, [])

  useEffect(() => { load() }, [load])

  // Org libraries = the Organization records that hold templates (Behavioral,
  // Assisted Living). Read once, only for people who can send standalone agreements.
  useEffect(() => {
    if (!canEdit) return
    listAgreementTemplates().then(list => {
      const seen: Record<string, OrgLib> = {}
      for (const t of list || []) if (t.orgId && !seen[t.orgId]) seen[t.orgId] = { orgId: t.orgId, orgName: t.orgName }
      setLibs(Object.values(seen).sort((a, b) => a.orgName.localeCompare(b.orgName)))
    }).catch(() => setLibs([]))
  }, [canEdit])

  // Recipient picker: me + current staff as in-app signers. Everyone else is typed in;
  // a standalone envelope has no contacts to pick from.
  useEffect(() => {
    if (!canEdit) return
    let dead = false
    const signerName = (n: string) => {
      const m = (n || '').match(/^([^,]+),\s*(.+)$/)
      return m ? (m[2] + ' ' + m[1]).trim() : (n || '').trim()
    }
    getUsers().then(ul => {
      if (dead) return
      const out: PickOpt[] = []
      if (fullName) out.push({ label: fullName + ' — me, signs in-app', name: fullName, email: '', kind: 'consultant' })
      const staff = ((ul && ul.rows) || []).map(u => signerName(u.name))
        .filter(n => n && n !== fullName).sort((a, b) => a.localeCompare(b))
        .map(n => ({ label: n + ' — staff, signs in-app', name: n, email: '', kind: 'consultant' }))
      setPicks(out.concat(staff))
    }).catch(() => { /* picker stays empty; recipients can still be typed */ })
    return () => { dead = true }
  }, [canEdit, fullName])

  const libName = useCallback((orgId: string) =>
    (libs || []).find(l => l.orgId === orgId)?.orgName || 'Organization', [libs])

  const openStandalone = useCallback(async (orgId: string, entryId: string) => {
    try {
      const env = await getEnvelope(orgHost(orgId), entryId)
      setOpenEnv({ lib: { orgId, orgName: libName(orgId) }, env })
    } catch (e) { setNotice('Could not open that agreement: ' + errText(e)) }
  }, [libName])

  // ?org=&env= reopens a standalone envelope (the designer and in-app signing page
  // send people back here, since there is no company tab to return to).
  useEffect(() => {
    const org = params.get('org'), env = params.get('env')
    if (!org || !env || !canEdit) return
    setParams({}, { replace: true })
    openStandalone(org, env)
  }, [params, setParams, canEdit, openStandalone])

  function startNew() {
    if (!libs || libs.length === 0) { setNotice('No template library found: add a template first.'); return }
    if (libs.length === 1) setNewIn(libs[0])
    else setChoosing(true)
  }

  async function voidStandalone(lib: OrgLib, entryId: string) {
    const reason = prompt('Void this agreement? Recipients will no longer be able to sign.\nReason (optional):', '')
    if (reason == null) return
    try {
      await voidEnvelope(orgHost(lib.orgId), entryId, reason)
      setOpenEnv(null); load(); setNotice('Agreement voided.')
    } catch (e) { setNotice('Void failed: ' + errText(e)) }
  }

  const report = state.phase === 'ready' ? state.report : null
  const today = todayIso()

  const base = useMemo(
    () => (report?.rows || []).filter(r =>
      (showTests || !isTest(r)) && (!onlyStandalone || r.hostEntity === 'org')),
    [report, showTests, onlyStandalone],
  )
  const hiddenTests = (report?.rows.length || 0) - base.length

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { open: 0, draft: 0, completed: 0, closed: 0, all: base.length }
    for (const r of base) c[bucketOf(r.status)]++
    return c
  }, [base])

  const kpi = useMemo(() => {
    const open = base.filter(r => bucketOf(r.status) === 'open')
    const ages = open.map(r => daysBetween(r.sentAt, today) ?? 0)
    const signed30 = base.filter(r => {
      const d = daysBetween(r.completedAt, today)
      return r.status === 'Completed' && d != null && d <= 30
    }).length
    return {
      open: open.length,
      oldest: ages.length ? Math.max(...ages) : 0,
      stale: ages.filter(a => a >= WARN_DAYS).length,
      signed30,
      drafts: base.filter(r => bucketOf(r.status) === 'draft').length,
    }
  }, [base, today])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = base.filter(r => {
      if (bucket !== 'all' && bucketOf(r.status) !== bucket) return false
      if (!q) return true
      const hay = [r.companyName, r.title, r.status, ...r.recipients.map(x => x.name + ' ' + (x.email || ''))]
        .join(' ').toLowerCase()
      return hay.includes(q)
    })
    // What needs chasing first: open envelopes oldest-sent first; everything else newest first.
    const key = (r: Row) => isoDay(r.completedAt) || isoDay(r.sentAt) || isoDay(r.createdAt)
    return list.sort((a, b) => {
      const ao = bucketOf(a.status) === 'open', bo = bucketOf(b.status) === 'open'
      if (ao !== bo) return ao ? -1 : 1
      if (ao) return isoDay(a.sentAt).localeCompare(isoDay(b.sentAt))
      return key(b).localeCompare(key(a))
    })
  }, [base, bucket, query])

  function exportCsv() {
    const out: (string | number)[][] = [[
      'Company', 'Agreement', 'Status', 'Created', 'Sent', 'Completed', 'Days out',
      'Waiting on', 'Signed', 'Signers', 'Void reason',
    ]]
    for (const r of rows) {
      const s = signers(r)
      const open = bucketOf(r.status) === 'open'
      out.push([
        r.companyName, r.title, r.status, isoDay(r.createdAt), isoDay(r.sentAt), isoDay(r.completedAt),
        open ? (daysBetween(r.sentAt, today) ?? '') : '',
        r.waitingOn.map(x => x.name).join('; '),
        `${s.filter(x => x.status === 'signed').length} of ${s.length}`,
        s.map(x => `${x.name} (${x.status})`).join('; '),
        r.voidReason || '',
      ])
    }
    downloadCsv(`agreements-${today}.csv`, out)
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Agreements</h1>
          <p className="page__sub">
            Everything sent for signature, across every company: what is still out, who it is
            waiting on, and what has closed.
          </p>
        </div>
        <span className="env-head-acts">
          {canEdit && (
            <button type="button" className="btn btn--sm" onClick={startNew} disabled={libs === null}>
              + New agreement
            </button>
          )}
          <Link className="btn btn--ghost btn--sm" to="/reports">All reports</Link>
        </span>
      </header>

      {notice && <p className="board2__notice" role="status" onClick={() => setNotice('')}>{notice}</p>}

      {openEnv && (
        <EnvHostContext.Provider value={orgHost(openEnv.lib.orgId)}>
          <div className="agr agrep__editor" ref={editorRef}>
            <p className="muted agrep__standalone-note">
              Standalone agreement · {openEnv.lib.orgName} library · no company attached
            </p>
            <EnvelopeDetail
              company={standIn(openEnv.lib.orgId, openEnv.lib.orgName)}
              env={openEnv.env} picks={picks} canEdit={canEdit}
              setEnv={env => setOpenEnv(o => (o ? { ...o, env } : o))}
              onClose={() => { setOpenEnv(null); load() }}
              onVoid={() => voidStandalone(openEnv.lib, openEnv.env.entryId)}
              notify={setNotice}
              reloadList={load}
            />
          </div>
        </EnvHostContext.Provider>
      )}

      {choosing && libs && (
        <div className="agr agr-modal-back" onMouseDown={e => { if (e.target === e.currentTarget) setChoosing(false) }}>
          <div className="agr-modal" role="dialog" aria-modal="true" aria-labelledby="agrep-lib-h">
            <div className="agr-modal-head">
              <div>
                <b id="agrep-lib-h">New standalone agreement</b>
                <p>Which template library? The signed agreement is filed on that organization's record.</p>
              </div>
              <button type="button" className="ico-mini" onClick={() => setChoosing(false)}>✕</button>
            </div>
            <div className="agrep__libs">
              {libs.map(l => (
                <button key={l.orgId} type="button" className="btn btn--ghost"
                  onClick={() => { setChoosing(false); setNewIn(l) }}>{l.orgName}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {newIn && (
        <EnvHostContext.Provider value={orgHost(newIn.orgId)}>
          <div className="agr">
            <NewEnvelopeModal
              company={standIn(newIn.orgId, newIn.orgName)} picks={picks}
              onClose={() => setNewIn(null)}
              onCreated={env => { const lib = newIn; setNewIn(null); setOpenEnv({ lib, env }); load() }}
              notify={setNotice}
            />
          </div>
        </EnvHostContext.Provider>
      )}

      {state.phase === 'loading' && <p className="muted">Reading every company's agreements…</p>}

      {state.phase === 'error' && (
        <div className="callout">
          <p className="callout__title">
            {state.needsLogin ? 'Your BlueStep session has ended' : "Couldn't load the agreements"}
          </p>
          <p>{state.error}</p>
          <p className="callout__actions">
            {state.needsLogin
              ? <a className="btn" href={LOGIN_URL}>Sign in to BlueStep</a>
              : <button type="button" className="btn" onClick={load}>Try again</button>}
          </p>
        </div>
      )}

      {report && !openEnv && (
        <>
          <div className="kpis">
            <div className="kpi" data-tone={kpi.open ? 'warn' : 'good'}>
              <p className="kpi__k">Out for signature</p>
              <p className="kpi__v">{kpi.open}</p>
              <p className="kpi__n">{kpi.open ? `oldest sent ${plural(kpi.oldest, 'day')} ago` : 'nothing waiting'}</p>
            </div>
            <div className="kpi" data-tone={kpi.stale ? 'bad' : undefined}>
              <p className="kpi__k">Waiting {WARN_DAYS}+ days</p>
              <p className="kpi__v">{kpi.stale}</p>
              <p className="kpi__n">{kpi.stale ? 'worth a nudge' : 'none overdue'}</p>
            </div>
            <div className="kpi" data-tone="good">
              <p className="kpi__k">Signed, last 30 days</p>
              <p className="kpi__v">{kpi.signed30}</p>
              <p className="kpi__n">{plural(counts.completed, 'agreement')} signed in all</p>
            </div>
            <div className="kpi">
              <p className="kpi__k">Drafts</p>
              <p className="kpi__v">{kpi.drafts}</p>
              <p className="kpi__n">built, not sent</p>
            </div>
          </div>

          <div className="trep__filters agrep__filters">
            <div className="seg" role="group" aria-label="Status">
              {BUCKETS.map(b => (
                <button key={b.key} type="button" data-on={bucket === b.key ? '' : undefined}
                  aria-pressed={bucket === b.key} onClick={() => setBucket(b.key)}>
                  {b.label} <span className="agrep__n">{counts[b.key]}</span>
                </button>
              ))}
            </div>
            <div className="search agrep__search">
              <label className="visually-hidden" htmlFor="agrep-q">Search</label>
              <input id="agrep-q" type="search" placeholder="Company, agreement or signer"
                value={query} onChange={e => setQuery(e.target.value)} />
            </div>
            <label className="agrep__toggle">
              <input type="checkbox" checked={showTests} onChange={e => setShowTests(e.target.checked)} />
              Show test records{hiddenTests && !showTests ? ` (${hiddenTests} hidden)` : ''}
            </label>
            {canEdit && (
              <label className="agrep__toggle">
                <input type="checkbox" checked={onlyStandalone} onChange={e => setOnlyStandalone(e.target.checked)} />
                Standalone only{report.standalone ? ` (${report.standalone})` : ''}
              </label>
            )}
            <span className="tpage__spacer" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={load}>Refresh</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={!rows.length} onClick={exportCsv}>
              Export CSV
            </button>
          </div>

          {rows.length === 0 ? (
            <div className="callout callout--plain">
              <p className="callout__title">
                {bucket === 'open' && !query ? 'Nothing is out for signature' : 'No agreements match'}
              </p>
              <p className="muted">
                {bucket === 'open' && !query
                  ? 'Every agreement that has been sent is signed, declined or voided.'
                  : 'Try another status or clear the search.'}
              </p>
            </div>
          ) : (
            <div className="tablewrap">
              <table className="fields compact agrep">
                <thead>
                  <tr>
                    <th scope="col">Company</th>
                    <th scope="col">Agreement</th>
                    <th scope="col">Status</th>
                    <th scope="col">Sent</th>
                    <th scope="col" className="num">{bucket === 'open' ? 'Days out' : 'Days'}</th>
                    <th scope="col">Waiting on</th>
                    <th scope="col">Signers</th>
                    <th scope="col"><span className="visually-hidden">Links</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <ReportRow key={(r.hostId || r.companyId) + r.entryId} r={r} today={today}
                      onOpenStandalone={canEdit ? openStandalone : undefined} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="muted agrep__foot">
            {plural(report.total, 'agreement')} on {plural(report.companies, 'company')}, read{' '}
            {new Date(String(report.generatedAt).replace(/\[.*\]$/, '')).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
            {' '}Days out turns amber at {WARN_DAYS} and red at {BAD_DAYS}. On a Signed row, Days is
            how long it took to come back.
          </p>
        </>
      )}
    </section>
  )
}

function ReportRow({ r, today, onOpenStandalone }: {
  r: Row; today: string
  onOpenStandalone?: (orgId: string, entryId: string) => void
}) {
  const standalone = r.hostEntity === 'org' && !!r.hostId && !!r.entryId && !r.legacy
  const b = bucketOf(r.status)
  const s = signers(r)
  const signedCount = s.filter(x => x.status === 'signed').length
  const days = b === 'open'
    ? daysBetween(r.sentAt, today)
    : b === 'completed' ? daysBetween(r.sentAt, r.completedAt) : null
  const tone = b === 'open' ? ageTone(days) : undefined
  const declined = r.recipients.find(x => x.status === 'declined')

  return (
    <tr>
      <td>
        {r.companyId
          ? <Link to={`/clients/${encodeURIComponent(r.companyId)}/agreements`}>{r.companyName || '(unnamed)'}</Link>
          : standalone ? <span className="agrep__standalone">{r.companyName}</span> : r.companyName}
      </td>
      <td>
        {standalone && onOpenStandalone
          ? <button type="button" className="linkbtn agrep__open" onClick={() => onOpenStandalone(r.hostId!, r.entryId)}>
              <strong>{r.title || 'Untitled'}</strong>
            </button>
          : <strong>{r.title || 'Untitled'}</strong>}
        <div className="agrep__sub muted">
          {r.status === 'Completed' && r.completedAt
            ? `Signed ${fmtDate(r.completedAt)}`
            : r.status === 'Draft' ? `Created ${fmtDate(r.createdAt)}${r.createdBy ? ' by ' + r.createdBy : ''}` : ''}
          {r.status === 'Voided' && r.voidReason ? `Voided: ${r.voidReason}` : ''}
          {declined ? `Declined by ${declined.name}${declined.declineReason ? ': ' + declined.declineReason : ''}` : ''}
          {b === 'open' && r.lastReminderAt ? `Last reminder ${fmtDate(r.lastReminderAt)}` : ''}
        </div>
      </td>
      <td><span className="pill" data-env={r.status}>{r.status}</span></td>
      <td>{fmtDate(r.sentAt) || <span className="muted">·</span>}</td>
      <td className="num">
        {days == null ? <span className="muted">·</span>
          : <span className="agrep__age" data-tone={tone}>{days}</span>}
      </td>
      <td>
        {r.waitingOn.length === 0 ? <span className="muted">·</span> : (
          <ul className="agrep__who">
            {r.waitingOn.map((x, i) => (
              <li key={i}>
                <span>{x.name || x.email || 'Unnamed signer'}</span>
                <span className="muted"> · {whereThey(x)}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        <div className="agrep__signers">
          <span className="agrep__count">{signedCount} of {s.length}</span>
          {s.map((x, i) => (
            <span key={i} className={'env-chip' + (x.status === 'signed' ? ' done' : '')}
              title={`${x.name}: ${x.status}${x.signedAt ? ' ' + fmtDate(x.signedAt) : ''}`}>
              {x.name || '?'}
            </span>
          ))}
        </div>
      </td>
      <td className="agrep__links">
        {r.signedPdf && r.status === 'Completed' && (
          <a href={r.signedPdf} target="_blank" rel="noreferrer">Signed PDF</a>
        )}
      </td>
    </tr>
  )
}
