/* =====================================================================
   signpage/main.ts — the external signer's page, served at /spa/sign.html.

   The signer is NOT logged in. Reads ?entity&clientid&logid&token from the URL,
   loads the envelope + a gate verdict from the public runAsSuper endpoint
   /b/agreementSign (action=load), renders it through the shared signview, and
   posts the signature back (action=submit) or declines (action=decline). That
   endpoint remains the ONLY place an external signer's data is written.

   Independent of the React app by design: no api.ts, no session, no router. The
   only shared code is signview/signing/pdf — the same signing surface the in-app
   page uses, which is what keeps the two identical.

   Ported from eccrm's public/signpage.ts (proven in production there).
   ===================================================================== */

import { svMount } from '../agreements/signview'
import { sigEsc } from '../agreements/signing'
import '../agreements/signview.css'
import './signpage.css'

const INGESTER = '/b/agreementSign'
const root = document.getElementById('sign-root')

function qp(name: string): string {
  const m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search)
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''
}
const meta = { entity: qp('entity') || 'company', clientid: qp('clientid'), logid: qp('logid'), token: qp('token') }

/* ── gates ──────────────────────────────────────────────────────────────────
   These strings are what a signer sees when a link is stale — they should not
   drift without a deliberate decision. */
function gateMessage(gate: string): string {
  const map: { [k: string]: string[] } = {
    notfound: ['Link not found', 'This signing link is invalid or has expired.'],
    badtoken: ['Invalid link', 'This signing link is invalid. Please use the exact link from your email.'],
    voided: ['No longer available', 'This agreement has been withdrawn by the sender.'],
    declined: ['Declined', 'This signature request was declined.'],
    complete: ['Already completed', 'This agreement has already been fully signed. Thank you!'],
    alreadysigned: ['Already signed', 'You have already signed this document. Thank you!'],
    unconfigured: ['Not ready', 'This document is not ready to sign yet. Please contact the sender.'],
    notyourturn: ['Not your turn yet', 'These documents are signed in order, and an earlier signer has not finished yet. You will receive an email the moment it is your turn.'],
    expired: ['Expired', 'This signature request expired before all parties signed. Please contact the sender for a new one.'],
  }
  const m = map[gate] || ['Unavailable', 'This signing link cannot be opened.']
  return '<div class="sg-msg"><h2>' + sigEsc(m[0]) + '</h2><p>' + sigEsc(m[1]) + '</p></div>'
}

function setRoot(html: string): void { if (root) root.innerHTML = html }

/* ── load ─────────────────────────────────────────────────────────────────── */
let ACCESS_CODE = ''
function load(): void {
  const url = INGESTER + '?action=load&lazy=1&entity=' + encodeURIComponent(meta.entity)
    + '&clientid=' + encodeURIComponent(meta.clientid)
    + '&logid=' + encodeURIComponent(meta.logid)
    + '&token=' + encodeURIComponent(meta.token)
    + (ACCESS_CODE ? '&code=' + encodeURIComponent(ACCESS_CODE) : '')
  fetch(url, { headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(j => {
      if (!j || !j.ok) { setRoot(gateMessage('notfound')); return }
      const d = j.data
      if (d.gate === 'code') { renderCodeGate(!!d.bad); return }
      if (d.gate !== 'ok') { setRoot(gateMessage(d.gate)); return }
      if (d.kind === 'envelope') { renderEnvelopeSign(d); return }
      setRoot(gateMessage('notfound'))
    })
    .catch(() => setRoot(gateMessage('notfound')))
}

/* ── boot ─────────────────────────────────────────────────────────────────── */
if (!meta.clientid || !meta.logid || !meta.token) setRoot(gateMessage('badtoken'))
else load()

/* ---- envelope flow — the shared signview does the heavy lifting ----
   Read-only when the envelope is completed (adds PDF downloads) or when this
   signer already signed (waiting on others). Live signers also get a decline
   path and a withdraw-consent path. */
function renderEnvelopeSign(d: any): void {
  if (!root) return
  const me = d.me || {}
  const readOnly = !!(d.completed || d.mySigned)
  // ESIGN disclosure: shown ONCE, before any signing UI, and the acceptance
  // (version + IP) is recorded server-side before the documents render.
  if (!readOnly && d.disclosure && d.disclosure.text && !d.meDisclosureAccepted) { renderDisclosure(d); return }
  const headMsg = d.completed
    ? 'All parties have signed. Review the documents below, or download the completed PDFs.'
    : d.mySigned
      ? 'You have signed — waiting on the remaining signers. You\'ll receive the completed PDF by email when everyone has finished.'
      : (me.name ? 'Please review and complete your fields, ' + sigEsc(me.name) + '.' : 'Please review and sign.')
  setRoot(
    '<div class="sg-wrap sv-wrap' + (readOnly ? ' sv-ro-mode' : '') + '">'
    + '<div class="sg-head">'
    + (d.orgName ? '<div class="sg-org">' + sigEsc(d.orgName) + '</div>' : '')
    + '<h1>' + sigEsc(d.title) + '</h1>'
    + '<p class="sg-hi">' + headMsg + '</p>'
    + (d.completed ? envDownloadsHtml(d) : '')
    + '</div>'
    + '<div id="sv-host"></div>'
    + (readOnly ? ''
      : '<p class="sg-declinerow"><button type="button" class="sg-declineline" id="sg-envdecline">Decline to sign</button>'
        + ' · <button type="button" class="sg-declineline" id="sg-envwithdraw">Withdraw consent to sign electronically</button></p>')
    + '</div>')
  const pdfBtn = document.getElementById('sg-envpdf')
  if (pdfBtn) (pdfBtn as HTMLButtonElement).onclick = function () { envPdfDownload('', null) }
  const dls = document.querySelectorAll('.sg-dl')
  for (let di = 0; di < dls.length; di++) {
    (function (el: any) { el.onclick = function () { envPdfDownload(el.getAttribute('data-docid') || '', el) } })(dls[di])
  }
  const decBtn = document.getElementById('sg-envdecline')
  if (decBtn) (decBtn as HTMLButtonElement).onclick = function () { envDeclineFlow(false) }
  const wdBtn = document.getElementById('sg-envwithdraw')
  if (wdBtn) (wdBtn as HTMLButtonElement).onclick = function () { envDeclineFlow(true) }
  svMount({
    container: document.getElementById('sv-host')!,
    env: d,
    meId: readOnly ? '' : (me.id || ''),
    progress: me.progress || null,
    fetchDoc: function (docId: string) {
      return fetch(INGESTER, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'docBytes', entity: meta.entity, clientid: meta.clientid, logid: meta.logid, token: meta.token, code: ACCESS_CODE, docId }),
      }).then(r => r.json()).then(j => {
        if (!j || !j.ok || !j.data || !j.data.dataB64) throw new Error((j && j.error) || 'Document failed to load.')
        return j.data.dataB64 as string
      })
    },
    saveProgress: readOnly ? undefined : function (p) {
      return fetch(INGESTER, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveProgress', entity: meta.entity, clientid: meta.clientid, logid: meta.logid, token: meta.token, code: ACCESS_CODE, tabValues: p.tabValues, typedName: p.typedName, hasAdopted: p.hasAdopted }),
      }).then(r => r.json()).then(j => {
        if (!j || !j.ok) throw new Error((j && j.error) || 'Save failed.')
        return j.data || j
      })
    },
    consentLabel: readOnly ? undefined : 'I agree to sign these documents electronically, and that my electronic signature is legally binding.',
    submit: function (p) {
      return fetch(INGESTER, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit', entity: meta.entity, clientid: meta.clientid, logid: meta.logid,
          token: meta.token, code: ACCESS_CODE, consent: true, signatureData: p.signatureData, initialsData: p.initialsData || '',
          typedName: p.typedName, tabValues: p.tabValues,
        }),
      }).then(r => r.json()).then(j => {
        if (!j || !j.ok) throw new Error((j && j.error) || 'Signing failed.')
        return j.data || j
      })
    },
    onDone: function (res) {
      setRoot('<div class="sg-done"><h1>Thank you!</h1>'
        + '<p>Your signature has been recorded.'
        + (res && res.completed ? ' All parties have now signed — the completed document is on file.' : ' You will receive a copy once all parties have signed.')
        + '</p></div>')
    },
  })
}

/* Completed downloads: one button per signed document plus the certificate. */
function envDownloadsHtml(d: any): string {
  const docs = (d.documents || []).filter(function (x: any) { return x.signed })
  if (!docs.length) return '<p><button type="button" class="sg-btn primary" id="sg-envpdf">Download completed PDF</button></p>'
  let rows = ''
  for (let i = 0; i < docs.length; i++) {
    rows += '<button type="button" class="sg-btn ghost sg-dl" data-docid="' + sigEsc(docs[i].id) + '">' + sigEsc(docs[i].name) + ' — signed</button>'
  }
  rows += '<button type="button" class="sg-btn primary sg-dl" data-docid="">Certificate of completion</button>'
  return '<div class="sg-dl-list">' + rows + '</div>'
}

/* Completed-envelope PDF: the bytes ride a token-gated response (the anonymous
   /download wall), then save via a blob link. docId picks one signed document;
   '' fetches the certificate. */
function envPdfDownload(docId: string, btnEl: HTMLButtonElement | null): void {
  const btn = btnEl || (document.getElementById('sg-envpdf') as HTMLButtonElement | null)
  const orig = btn ? btn.textContent : ''
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…' }
  const restore = function () { if (btn) { btn.disabled = false; btn.textContent = orig } }
  fetch(INGESTER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pdf', entity: meta.entity, clientid: meta.clientid, logid: meta.logid, token: meta.token, code: ACCESS_CODE, docId: docId || '' }),
  })
    .then(r => r.json())
    .then(j => {
      if (!j || !j.ok || !j.data || !j.data.dataB64) throw new Error((j && j.error) || 'The PDF isn\'t ready yet — try again shortly.')
      const bin = atob(j.data.dataB64)
      const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([u8], { type: 'application/pdf' }))
      a.download = j.data.filename || 'completed-documents.pdf'
      a.click()
      restore()
    })
    .catch(e => { restore(); alert(e && e.message ? e.message : String(e)) })
}

function envDeclineFlow(withdrawn: boolean): void {
  const reason = prompt(withdrawn
    ? 'Withdraw your consent to sign electronically?\nThe sender will be notified and can arrange paper signing instead. Reason (optional):'
    : 'Decline to sign these documents?\nThe sender will be notified. Reason (optional):', '')
  if (reason == null) return
  fetch(INGESTER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'decline', entity: meta.entity, clientid: meta.clientid, logid: meta.logid, token: meta.token,
      reason: reason || (withdrawn ? 'Withdrew consent to electronic signing' : ''), withdrawn: withdrawn === true,
    }),
  })
    .then(r => r.json())
    .then(j => {
      if (!j || !j.ok) throw new Error((j && j.error) || 'Could not record the decline.')
      setRoot('<div class="sg-msg"><h2>Declined</h2><p>You have declined to sign. The sender has been notified.</p></div>')
    })
    .catch(e => { alert(e && e.message ? e.message : String(e)) })
}

/* Access-code gate: the recipient types the code the sender shared out-of-band;
   the envelope loads only when the server accepts it. */
function renderCodeGate(bad: boolean): void {
  setRoot('<div class="sg-msg"><h2>Access code required</h2>'
    + '<p>The sender protected these documents with an access code. Enter it to continue.</p>'
    + (bad ? '<p class="sg-code-bad">That code wasn\'t right — try again.</p>' : '')
    + '<p><input id="sg-code" class="sg-code-input" autocomplete="off" placeholder="Access code">'
    + ' <button type="button" class="sg-btn primary" id="sg-code-go">Continue</button></p></div>')
  const go = document.getElementById('sg-code-go')
  const inp = document.getElementById('sg-code') as HTMLInputElement | null
  const submit = function () { ACCESS_CODE = inp ? inp.value.trim() : ''; if (ACCESS_CODE) load() }
  if (go) (go as HTMLButtonElement).onclick = submit
  if (inp) { inp.focus(); inp.onkeydown = function (e) { if ((e as KeyboardEvent).key === 'Enter') submit() } }
}

/* ESIGN disclosure screen — acceptance recorded server-side BEFORE signing. */
function renderDisclosure(d: any): void {
  const me = d.me || {}
  setRoot('<div class="sg-wrap">'
    + '<div class="sg-head">'
    + (d.orgName ? '<div class="sg-org">' + sigEsc(d.orgName) + '</div>' : '')
    + '<h1>Before you sign</h1>'
    + '<p class="sg-hi">' + (me.name ? sigEsc(me.name) + ', please' : 'Please') + ' review this disclosure about signing electronically.</p>'
    + '</div>'
    + '<pre class="sg-disclosure">' + sigEsc(d.disclosure.text) + '</pre>'
    + '<p class="sg-disc-acts">'
    + '<button type="button" class="sg-btn primary" id="sg-disc-agree">I agree — continue to the documents</button></p>'
    + '<p class="sg-declinerow"><button type="button" class="sg-declineline" id="sg-disc-no">I do not consent to electronic signing</button></p>'
    + '</div>')
  const agree = document.getElementById('sg-disc-agree') as HTMLButtonElement | null
  if (agree) agree.onclick = function () {
    agree.disabled = true; agree.textContent = 'One moment…'
    fetch(INGESTER, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'acceptDisclosure', entity: meta.entity, clientid: meta.clientid, logid: meta.logid, token: meta.token, code: ACCESS_CODE }),
    })
      .then(r => r.json())
      .then(j => {
        if (!j || !j.ok) throw new Error((j && j.error) || 'Could not record your consent.')
        d.meDisclosureAccepted = true
        renderEnvelopeSign(d)
      })
      .catch(e => { agree.disabled = false; agree.textContent = 'I agree — continue to the documents'; alert(e && e.message ? e.message : String(e)) })
  }
  const no = document.getElementById('sg-disc-no')
  if (no) (no as HTMLButtonElement).onclick = function () { envDeclineFlow(true) }
}
