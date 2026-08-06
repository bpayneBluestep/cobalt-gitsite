#!/usr/bin/env node
/*
 * Extract a BlueStep org's Relate schema into app/src/schema.json.
 *
 *   npm run extract-schema                 # default org (Cobalt, U142140)
 *   npm run extract-schema -- --org U141985
 *   npm run extract-schema -- --org U142140 --out app/src/schema.json
 *
 * Talks to the BlueStep MCP gateway (gateway.bluestep.net/mcp) rather than an
 * org's own /mcp, because some orgs serve an empty tools/list directly while the
 * gateway relays tools/call correctly.
 *
 * Credentials: never stored in this repo. The global b6pt_ bearer is read from
 * $B6PT_TOKEN, or discovered from ~/.claude.json's configured MCP servers.
 *
 * Known platform gaps (recorded per-item in the output, not swallowed):
 *   - get_record_type throws an NPE for some record types (null
 *     getRequiredMetaMasters()). Those types still appear, flagged
 *     status:"partial", but their own form lists are unavailable. Parent/child
 *     links are backfilled from the categories that DO resolve.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import process from 'node:process';

const GATEWAY_HOST = 'gateway.bluestep.net';
const GATEWAY_PATH = '/mcp';
const DEFAULT_ORG = 'U142140';

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { org: DEFAULT_ORG, outFile: 'app/src/schema.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--org' && argv[i + 1]) out.org = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) out.outFile = argv[++i];
  }
  if (!/^U?\d+$/.test(out.org)) throw new Error(`--org must be a U-number, got "${out.org}"`);
  if (!out.org.startsWith('U')) out.org = 'U' + out.org;
  return out;
}

// ---------------------------------------------------------------- auth
function findToken() {
  if (process.env.B6PT_TOKEN) return 'Bearer ' + process.env.B6PT_TOKEN.replace(/^Bearer\s+/, '');
  const cfgPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(cfgPath)) throw new Error('Set $B6PT_TOKEN (no ~/.claude.json to read a token from)');
  const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const buckets = [j.mcpServers || {}, ...Object.values(j.projects || {}).map(p => (p && p.mcpServers) || {})];
  for (const b of buckets) {
    for (const name of Object.keys(b)) {
      const h = (b[name].headers || {}).Authorization || '';
      if (/^Bearer\s+b6pt_/.test(h)) return h;
    }
  }
  throw new Error('No global b6pt_ token found. Set $B6PT_TOKEN.');
}

// ---------------------------------------------------------------- MCP over HTTP
function gatewayClient() {
  const token = findToken();
  let sessionId = null;
  let nextId = 10;
  const cookies = {};

  function rpc(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const cookieHeader = Object.keys(cookies).length
        ? { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') }
        : {};
      const req = https.request({
        hostname: GATEWAY_HOST, path: GATEWAY_PATH, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(data),
          Authorization: token,
          ...cookieHeader,
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
      }, res => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          // BlueStep runs a clustered Tomcat; the MCP session is pinned to one
          // node via JSESSIONID. Echo cookies back or follow-ups 404 the session.
          for (const c of res.headers['set-cookie'] || []) {
            const m = /^([^=]+)=([^;]*)/.exec(c);
            if (m) cookies[m[1]] = m[2];
          }
          if (res.headers['mcp-session-id']) sessionId = res.headers['mcp-session-id'];
          let payload = buf;
          if (buf.includes('data:')) {
            payload = buf.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
          }
          let json = null;
          try { json = payload ? JSON.parse(payload) : null; } catch { /* non-JSON */ }
          resolve({ json, status: res.statusCode, raw: buf });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async function init() {
    const r = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cobalt-schema-extract', version: '1' } },
    });
    if (r.status !== 200) throw new Error(`gateway initialize failed: HTTP ${r.status} ${r.raw.slice(0, 200)}`);
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async function callOrg(org, tool, args = {}) {
    const r = await rpc({
      jsonrpc: '2.0', id: ++nextId, method: 'tools/call',
      params: { name: 'invoke_org_tool', arguments: { org, tool, arguments: args } },
    });
    if (r.json?.error) return { ok: false, error: r.json.error.message || 'rpc error', data: null };
    const content = r.json?.result?.content;
    const isError = !!r.json?.result?.isError;
    const text = Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    // Some tools report failure as a plain {"error": "..."} body with isError false.
    const softError = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : null;
    return { ok: !isError && !softError, error: softError || (isError ? text : null), data: data?.data ?? data, text };
  }

  return { init, callOrg };
}

// ---------------------------------------------------------------- extraction
const cleanErr = e => String(e || '').replace(/\s+/g, ' ').trim().slice(0, 300);

async function extract(org) {
  const gw = gatewayClient();
  await gw.init();

  const warnings = [];
  console.log(`[extract] org ${org}`);

  // --- record types -------------------------------------------------
  const rtRes = await gw.callOrg(org, 'list_record_types', { limit: 100 });
  if (!rtRes.ok) throw new Error(`list_record_types failed: ${cleanErr(rtRes.error)}`);
  const rawTypes = rtRes.data?.items || [];
  console.log(`[extract] ${rawTypes.length} record types`);

  const recordTypes = rawTypes.map(t => ({
    topId: t.topId,
    name: t.name,
    displayName: t.displayName,
    description: t.description || null,
    baseType: !!t.baseType,
    displayOrder: t.displayOrder ?? 0,
    parents: [],
    subTypes: [],
    requiredForms: [],
    optionalForms: [],
    status: 'pending',
    error: null,
  }));
  const byId = new Map(recordTypes.map(t => [t.topId, t]));

  // --- per-type detail (parent links + form associations) ------------
  for (const rt of recordTypes) {
    const r = await gw.callOrg(org, 'get_record_type', { recordTypeId: rt.topId });
    if (!r.ok) {
      rt.status = 'partial';
      rt.error = cleanErr(r.error);
      warnings.push(`get_record_type failed for "${rt.displayName}" (${rt.topId}): ${rt.error}`);
      continue;
    }
    const d = r.data || {};
    rt.status = 'ok';
    rt.parents = (d.applicableBaseTypes || []).map(b => b.topId);
    rt.subTypes = (d.subTypes || []).map(s => s.topId);
    rt.requiredForms = (d.requiredForms || []).map(f => f.topId);
    rt.optionalForms = (d.optionalForms || []).map(f => f.topId);
    if (d.description && !rt.description) rt.description = d.description;
  }

  // Backfill: base types whose own lookup NPE'd still learn their children
  // from the categories that resolved and named them as a parent.
  for (const rt of recordTypes) {
    for (const parentId of rt.parents) {
      const parent = byId.get(parentId);
      if (parent && !parent.subTypes.includes(rt.topId)) parent.subTypes.push(rt.topId);
    }
  }
  // And children learn parents from a base type that DID resolve its subTypes.
  for (const rt of recordTypes) {
    for (const childId of rt.subTypes) {
      const child = byId.get(childId);
      if (child && !child.parents.includes(rt.topId)) child.parents.push(rt.topId);
    }
  }

  // --- forms + fields ----------------------------------------------
  const formRes = await gw.callOrg(org, 'list_forms', { limit: 100 });
  if (!formRes.ok) throw new Error(`list_forms failed: ${cleanErr(formRes.error)}`);
  let rawForms = formRes.data?.items || [];
  if (formRes.data?.hasMore) {
    warnings.push(`list_forms reported hasMore with ${rawForms.length} returned; the tool caps at 100 per call and exposes no cursor, so forms beyond the first 100 are NOT in this snapshot.`);
  }
  console.log(`[extract] ${rawForms.length} forms${formRes.data?.hasMore ? ' (truncated at 100 — see warnings)' : ''}`);

  const forms = [];
  let done = 0;
  for (const f of rawForms) {
    const r = await gw.callOrg(org, 'describe_form', { formId: f.topId });
    done++;
    if (done % 25 === 0 || done === rawForms.length) console.log(`[extract]   fields ${done}/${rawForms.length}`);
    if (!r.ok) {
      forms.push({
        topId: f.topId, displayName: f.displayName, singleEntry: null,
        fieldCount: null, fields: [], status: 'error', error: cleanErr(r.error),
      });
      warnings.push(`describe_form failed for "${f.displayName}" (${f.topId}): ${cleanErr(r.error)}`);
      continue;
    }
    const d = r.data || {};
    forms.push({
      topId: f.topId,
      displayName: d.displayName || f.displayName,
      singleEntry: d.singleEntry ?? null,
      fieldCount: d.fieldCount ?? (d.fields || []).length,
      fields: (d.fields || []).map(x => ({
        fieldId: x.fieldId,
        label: x.label,
        columnName: x.columnName,
        dbColumnName: x.dbColumnName,
        fieldType: x.fieldType,
      })),
      status: 'ok',
      error: null,
    });
  }

  // --- reverse index: form -> record types that use it --------------
  const usedBy = new Map();
  for (const rt of recordTypes) {
    for (const [kind, ids] of [['required', rt.requiredForms], ['optional', rt.optionalForms]]) {
      for (const id of ids) {
        if (!usedBy.has(id)) usedBy.set(id, []);
        usedBy.get(id).push({ recordTypeId: rt.topId, requirement: kind });
      }
    }
  }
  for (const f of forms) f.usedBy = usedBy.get(f.topId) || [];

  const fieldTypeCounts = {};
  for (const f of forms) for (const fl of f.fields) {
    fieldTypeCounts[fl.fieldType] = (fieldTypeCounts[fl.fieldType] || 0) + 1;
  }

  return {
    org,
    extractedAt: new Date().toISOString(),
    source: `https://${GATEWAY_HOST}${GATEWAY_PATH} (invoke_org_tool)`,
    stats: {
      recordTypes: recordTypes.length,
      baseTypes: recordTypes.filter(t => t.baseType).length,
      categories: recordTypes.filter(t => !t.baseType).length,
      forms: forms.length,
      fields: forms.reduce((n, f) => n + f.fields.length, 0),
      unlinkedForms: forms.filter(f => !f.usedBy.length).length,
      fieldTypeCounts,
    },
    recordTypes,
    forms,
    warnings,
  };
}

// ---------------------------------------------------------------- main
const { org, outFile } = parseArgs(process.argv.slice(2));
const schema = await extract(org);
const outPath = path.resolve(process.cwd(), outFile);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n');

console.log(`\n[extract] wrote ${path.relative(process.cwd(), outPath)}`);
console.log(`[extract] ${schema.stats.recordTypes} record types (${schema.stats.baseTypes} base / ${schema.stats.categories} categories), ` +
  `${schema.stats.forms} forms, ${schema.stats.fields} fields`);
if (schema.warnings.length) {
  console.log(`[extract] ${schema.warnings.length} warning(s):`);
  for (const w of schema.warnings) console.log(`  ! ${w}`);
}
