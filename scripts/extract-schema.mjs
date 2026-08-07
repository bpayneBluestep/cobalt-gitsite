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

  /** Run a GraphQL query through the org's graphql_query tool. */
  async function gql(org, query) {
    const r = await callOrg(org, 'graphql_query', { query });
    if (!r.ok) return { ok: false, error: r.error, data: null };
    // graphql_query returns the raw GraphQL envelope; surface field errors.
    let env = null;
    try { env = JSON.parse(r.text); } catch { /* not JSON */ }
    if (env?.errors?.length) return { ok: false, error: env.errors[0]?.message || 'graphql error', data: null };
    return { ok: true, error: null, data: env?.data ?? r.data };
  }

  return { init, callOrg, gql };
}

// ---------------------------------------------------------------- extraction
const cleanErr = e => String(e || '').replace(/\s+/g, ' ').trim().slice(0, 300);

// Relate object class ids, used by the children()/parents() graph queries.
const CLASS_RECORD_TYPE = 1000003;
const CLASS_RELATE_APP = 530002;

/*
 * Record-type structure comes from the relationship graph, not from
 * list_record_types / get_record_type. Both of those under-report on this
 * platform: get_record_type throws (RequiredDynoMetaMaster … null) for every type
 * with no required form — which includes the built-in Individual and Organization
 * — and list_record_types omits categories of any type that throws. The graph is
 * authoritative and always answers.
 *
 *   children(<relate app>, 1000003) -> every record type in the org
 *   children(<record type>, 1000003) -> that type's categories
 *   children(<form>,        1000003) -> the record types a form is attached to
 *
 * A type is a CATEGORY iff it appears as another type's child; everything else is
 * a base type. (Depth alone won't do it — the Relate app lists every type as a
 * child, categories included.)
 */
async function readTypeGraph(gw, org, warnings) {
  const app = await gw.gql(org, `{ remoteObjectsByName(classId:${CLASS_RELATE_APP}, name:"Relate"){ ... on Relate { topId } } }`);
  const relateAppId = app.data?.remoteObjectsByName?.[0]?.topId;
  if (!relateAppId) {
    warnings.push('Could not resolve the Relate app id, so record-type structure fell back to list_record_types alone (categories may be missing).');
    return null;
  }

  const kidsOf = async id => {
    const r = await gw.gql(org, `{ children(parentId:"${id}", classId:${CLASS_RECORD_TYPE}, start:0, count:200){ ... on RelateRecordType { topId displayName } } }`);
    if (!r.ok) {
      warnings.push(`children() failed for ${id}: ${cleanErr(r.error)}`);
      return []
    }
    return (r.data?.children || []).filter(c => c && c.topId)
  }

  const all = await kidsOf(relateAppId)
  const childrenById = new Map()
  for (const t of all) childrenById.set(t.topId, await kidsOf(t.topId))

  return { relateAppId, all, childrenById }
}

async function extract(org) {
  const gw = gatewayClient();
  await gw.init();

  const warnings = [];
  console.log(`[extract] org ${org}`);

  // --- record types -------------------------------------------------
  // list_record_types supplies metadata (name, description); the relationship
  // graph supplies the structure and catches types the list omits entirely.
  const rtRes = await gw.callOrg(org, 'list_record_types', { limit: 100 });
  if (!rtRes.ok) throw new Error(`list_record_types failed: ${cleanErr(rtRes.error)}`);
  const listed = new Map((rtRes.data?.items || []).map(t => [t.topId, t]));

  const graph = await readTypeGraph(gw, org, warnings);
  const seen = new Map();
  const add = t => {
    if (!seen.has(t.topId)) seen.set(t.topId, { topId: t.topId, displayName: t.displayName });
  };
  if (graph) for (const t of graph.all) add(t);
  for (const t of listed.values()) add(t);
  if (graph) for (const kids of graph.childrenById.values()) for (const k of kids) add(k);

  const categoryIds = new Set();
  if (graph) for (const kids of graph.childrenById.values()) for (const k of kids) categoryIds.add(k.topId);

  const recordTypes = [...seen.values()].map(t => {
    const meta = listed.get(t.topId) || {};
    const subTypes = (graph?.childrenById.get(t.topId) || []).map(k => k.topId);
    return {
      topId: t.topId,
      name: meta.name || t.displayName,
      displayName: meta.displayName || t.displayName,
      description: meta.description || null,
      // Derived from the graph, not the platform's baseType flag — that flag
      // reads false for a type whose base form isn't wired yet.
      baseType: graph ? !categoryIds.has(t.topId) : !!meta.baseType,
      displayOrder: meta.displayOrder ?? 0,
      parents: [],
      subTypes,
      baseFormId: null,
      displayFieldLabel: null,
      requiredForms: [],
      optionalForms: [],
      attachedForms: [],
      inList: listed.has(t.topId),
      status: 'pending',
      error: null,
    };
  });
  const byId = new Map(recordTypes.map(t => [t.topId, t]));

  for (const rt of recordTypes) {
    for (const childId of rt.subTypes) {
      const child = byId.get(childId);
      if (child && !child.parents.includes(rt.topId)) child.parents.push(rt.topId);
    }
  }

  const hidden = recordTypes.filter(t => !t.inList);
  console.log(`[extract] ${recordTypes.length} record types` +
    (hidden.length ? ` (${hidden.length} found only via the relationship graph)` : ''));
  if (hidden.length) {
    warnings.push(
      `${hidden.length} record type(s) exist but are missing from list_record_types — ` +
      `${hidden.map(t => `"${t.displayName}"`).join(', ')}. They were recovered from the ` +
      `relationship graph. This is what a record type with no base form wired looks like.`,
    );
  }

  /*
   * A base record type's identity form is its `baseForm`, and that association is
   * NOT a parent/child link — so the children() graph can't see it, and
   * list_forms doesn't necessarily list the form either (Cobalt's "Company Info"
   * base form is absent from it). Read baseForm + allForms per type over GraphQL
   * and treat those as form discovery as well as linkage; otherwise the most
   * important form in the org goes missing from the picture.
   */
  const extraForms = new Map();
  for (const rt of recordTypes) {
    const r = await gw.gql(org, `{ remoteObject(id:"${rt.topId}"){ ... on RelateRecordType { baseForm { ... on RelateForm { topId displayName } } displayField { ... on RelateFieldWrapper { topId } } allForms { ... on RelateForm { topId displayName } } } } }`);
    const d = r.data?.remoteObject;
    if (!d) continue;
    if (d.baseForm?.topId) {
      rt.baseFormId = d.baseForm.topId;
      extraForms.set(d.baseForm.topId, d.baseForm.displayName);
    }
    for (const f of d.allForms || []) {
      if (f?.topId) extraForms.set(f.topId, f.displayName);
    }
  }

  // --- per-type detail: required vs optional forms, where obtainable ---
  for (const rt of recordTypes) {
    const r = await gw.callOrg(org, 'get_record_type', { recordTypeId: rt.topId });
    if (!r.ok) {
      rt.status = 'partial';
      rt.error = cleanErr(r.error);
      continue;
    }
    const d = r.data || {};
    rt.status = 'ok';
    rt.requiredForms = (d.requiredForms || []).map(f => f.topId);
    rt.optionalForms = (d.optionalForms || []).map(f => f.topId);
    if (d.baseForm?.topId) rt.baseFormId = d.baseForm.topId;
    if (d.displayField) rt.displayFieldLabel = d.displayField.label || d.displayField.name || null;
    if (d.description && !rt.description) rt.description = d.description;
  }
  const partial = recordTypes.filter(t => t.status === 'partial');
  if (partial.length) {
    warnings.push(
      `get_record_type failed for ${partial.length} type(s) — ` +
      `${partial.map(t => `"${t.displayName}"`).join(', ')} — so their forms are shown as ` +
      `"attached" without a required/optional distinction. The platform throws ` +
      `RequiredDynoMetaMaster…getRequiredMetaMasters() is null for any type with no ` +
      `required form, including the built-in Individual and Organization. Structure is ` +
      `unaffected: it comes from the relationship graph.`,
    );
  }

  // --- forms + fields ----------------------------------------------
  const formRes = await gw.callOrg(org, 'list_forms', { limit: 100 });
  if (!formRes.ok) throw new Error(`list_forms failed: ${cleanErr(formRes.error)}`);
  const rawForms = formRes.data?.items || [];
  if (formRes.data?.hasMore) {
    warnings.push(`list_forms reported hasMore with ${rawForms.length} returned; the tool caps at 100 per call and exposes no cursor, so forms beyond the first 100 are NOT in this snapshot.`);
  }

  // Fold in forms the record types reference but list_forms doesn't return.
  const seenForms = new Set(rawForms.map(f => f.topId));
  const missed = [];
  for (const [topId, displayName] of extraForms) {
    if (seenForms.has(topId)) continue;
    seenForms.add(topId);
    rawForms.push({ topId, displayName });
    missed.push(displayName);
  }
  if (missed.length) {
    warnings.push(
      `${missed.length} form(s) are referenced by a record type but missing from list_forms — ` +
      `${missed.map(n => `"${n}"`).join(', ')}. Recovered from the record types' baseForm/allForms. ` +
      `A base form in particular can be absent from that list.`,
    );
  }
  console.log(`[extract] ${rawForms.length} forms` +
    (missed.length ? ` (${missed.length} recovered from record types)` : '') +
    (formRes.data?.hasMore ? ' (list truncated at 100 — see warnings)' : ''));

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

  // --- form <-> record type links -----------------------------------
  // A form's attachment shows up as the record type being a CHILD of the form,
  // so children(<form>) is the authoritative link — it resolves even for types
  // whose get_record_type throws. Requirement comes from get_record_type where
  // that worked, otherwise the link is reported as plain "attached".
  const requirementOf = new Map();
  for (const rt of recordTypes) {
    // A base form is the type's identity form — the strongest link there is, and
    // it must win over any weaker attachment for the same pair.
    if (rt.baseFormId) requirementOf.set(`${rt.baseFormId}:${rt.topId}`, 'base');
    for (const [kind, ids] of [['required', rt.requiredForms], ['optional', rt.optionalForms]]) {
      for (const id of ids) {
        const key = `${id}:${rt.topId}`
        if (requirementOf.get(key) !== 'base') requirementOf.set(key, kind)
      }
    }
  }

  for (const f of forms) {
    const r = await gw.gql(org, `{ children(parentId:"${f.topId}", classId:${CLASS_RECORD_TYPE}, start:0, count:200){ ... on RelateRecordType { topId } } }`);
    if (!r.ok) {
      warnings.push(`Could not read record-type links for form "${f.displayName}": ${cleanErr(r.error)}`);
      f.usedBy = [];
      continue;
    }
    const linked = new Map()
    for (const c of r.data?.children || []) {
      if (c?.topId && byId.has(c.topId)) linked.set(c.topId, requirementOf.get(`${f.topId}:${c.topId}`) || 'attached')
    }
    // baseForm is not a parent/child link, so add those pairs explicitly.
    for (const rt of recordTypes) {
      if (rt.baseFormId === f.topId) linked.set(rt.topId, 'base')
    }
    f.usedBy = [...linked.entries()].map(([recordTypeId, requirement]) => ({ recordTypeId, requirement }));
    // Mirror weaker links onto the record type so the tree can count its forms.
    // base/required/optional already live on the type from get_record_type.
    for (const use of f.usedBy) {
      const rt = byId.get(use.recordTypeId);
      if (rt && use.requirement === 'attached' && !rt.attachedForms.includes(f.topId)) {
        rt.attachedForms.push(f.topId);
      }
    }
  }

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
