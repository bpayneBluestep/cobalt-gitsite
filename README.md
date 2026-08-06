# Cobalt — schema explorer

A visual map of a BlueStep org's Relate schema: record types and their categories,
every form, and each form's fields. Built to answer "what's actually in this org?"
and "which form owns `C1611`?" without digging through the platform UI.

Static SPA deployable as a BlueStep GitSite, served at the domain root. The
committed build artifact at the repo root (`index.html` + `assets/`) **is** what
gets served — there is no server-side build. Source lives in `app/`.

## What it shows

- **Record types** — base types and their categories as a tree. Filled square =
  base type, hollow = category. Click one to see the forms attached to it,
  marked `required` or `optional`.
- **Forms** — every form, each with a **composition bar**: a stacked stripe of its
  field types by share, so you can read a form's makeup before opening it.
- **Fields** — label, column name, type, DB column (`C####`), and field id.
  Every id is one click to copy.
- **Search** — matches form names *and* field labels, column names, DB columns,
  ids, and field types. Searching `C1611` tells you which form owns it and which
  field it is.
- **Unattached forms** — a filter for forms no record type references.

Field types are coloured from the cobalt pigment family; the mapping is fixed, so
a type is always the same colour (see `app/src/pigments.ts`).

Deep links work: `/type/<topId>` and `/form/<topId>` are bookmarkable.

## Data: a snapshot, not a live feed

The page reads `app/src/schema.json`, extracted from the platform and committed.
It is a point-in-time snapshot — regenerate it after changing the org's schema:

```bash
npm run extract-schema                  # default org: Cobalt (U142140)
npm run extract-schema -- --org U141985 # any org you can reach
npm run build                           # rebuild the artifact
```

The extractor talks to the BlueStep MCP gateway (`gateway.bluestep.net/mcp`) via
`invoke_org_tool`, not to an org's own `/mcp` — some orgs (Cobalt among them)
serve an empty `tools/list` directly while the gateway relays calls correctly.

**Credentials are never stored in this repo.** The extractor reads the global
`b6pt_` bearer from `$B6PT_TOKEN`, falling back to the MCP servers configured in
`~/.claude.json`.

### Known gaps in the extract

The extractor records what the platform refused rather than hiding it. Both show
up in the UI as `partial` tags and a callout:

- `get_record_type` throws a null-pointer error for some record types, so those
  types' own form lists are unavailable. Parent/child links are backfilled from
  the categories that *did* resolve, which is why a type can appear in the tree
  with no forms listed.
- `list_forms` caps at 100 results and exposes no cursor. Orgs with more than 100
  forms are **truncated**, and the extractor emits a warning saying so. Cobalt has
  3 forms, so this does not bite here — but it will on a large org.

## Commands

```bash
npm install
npm run dev             # local dev server
npm run extract-schema  # refresh app/src/schema.json from the platform
npm run build           # emits index.html + assets/ to the repo root
npm run preview         # preview the built artifact
```

## Deploy

Commit the build output and push to `main`. The BlueStep GitSite
(`cobalt.bluestep.net`) clones the repo and serves the root artifact at `/`; a
GitHub push webhook triggers redeploy.

- Git Ref: `main`
- Index Path: `index.html`
