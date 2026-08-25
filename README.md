# Cobalt: schema explorer

A visual map of a BlueStep org's Relate schema: record types and their categories,
every form, and each form's fields. Built to answer "what's actually in this org?"
and "which form owns `C1611`?" without digging through the platform UI.

**Live at <https://cobalt.bluestep.net/>.**

Static SPA deployed as a BlueStep GitSite. Routes are served at the host root; the
hashed assets are served under `/spa/` (see [Routes at the root](#routes-at-the-root-assets-under-spa)).
The committed build artifact at the repo root (`index.html` + `assets/`) **is** what
gets served. There is no server-side build. Source lives in `app/`.

## What it shows

- **Record types**: base types and their categories as a tree. Filled square =
  base type, hollow = category. Click one to see the forms attached to it,
  marked `required` or `optional`.
- **Forms**: every form, each with a **composition bar**: a stacked stripe of its
  field types by share, so you can read a form's makeup before opening it.
- **Fields**: label, column name, type, DB column (`C####`), and field id.
  Every id is one click to copy.
- **Search**: matches form names *and* field labels, column names, DB columns,
  ids, and field types. Searching `C1611` tells you which form owns it and which
  field it is.
- **Unattached forms**: a filter for forms no record type references.

Field types are coloured from the cobalt pigment family; the mapping is fixed, so
a type is always the same colour (see `app/src/pigments.ts`).

Deep links work: `/schema/type/<topId>` and `/schema/form/<topId>` are bookmarkable.

## Data: a snapshot, not a live feed

The page reads `app/src/schema.json`, extracted from the platform and committed.
It is a point-in-time snapshot: regenerate it after changing the org's schema:

```bash
npm run extract-schema                  # default org: Cobalt (U142140)
npm run extract-schema -- --org U141985 # any org you can reach
npm run build                           # rebuild the artifact
```

The extractor talks to the BlueStep MCP gateway (`gateway.bluestep.net/mcp`) via
`invoke_org_tool`, not to an org's own `/mcp`: some orgs (Cobalt among them)
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
  3 forms, so this does not bite here, but it will on a large org.

## Commands

```bash
npm install
npm run dev             # local dev server: routes at the root, same as production
npm run extract-schema  # refresh app/src/schema.json from the platform
npm run build           # emits index.html + assets/ to the repo root
npm run preview         # serves the artifact under /spa/: checks asset URLs only
```

`dev` uses `base: '/'` so `localhost:5173/clients` matches the deployed URL exactly and
Vite's history fallback covers deep links. `preview` replays the build's `/spa/` asset
base, which is the point of it. It confirms the emitted asset URLs resolve, but its
routes sit under `/spa/` where the router (basename `/`) won't match them. Use `dev` to
exercise navigation.

## Deploy

Commit the build output and push to `main`. The BlueStep GitSite clones the repo
and serves the root artifact under `/spa/`; the GitHub push webhook triggers
redeploy.

- Git Ref: `main`
- Index Path: `index.html`
- Served at: `https://cobalt.bluestep.net/`

## Routes at the root, assets under `/spa/`

The site has two mounts over the same unpacked commit, and they do different jobs:

| Mount | Serves |
|---|---|
| `/` | this app's `index.html`: at `/` via the welcome file, and at any deeper extensionless browser `GET` via the 404 funnel. **Never a file.** |
| `/spa/**` | the real files: `/spa/assets/index-<hash>.js`, plus the deploy webhook and pull trigger. |

So there are **two bases and they differ on purpose**:

- **Route base is `/`**: no `basename` on the router (see `app/src/main.tsx`). Every
  link, redirect and shared URL is root-relative: `/clients/123/files`, `/tickets/8`.
  Users never see `/spa/`.
- **Asset base stays `/spa/`**, `base: '/spa/'` in `vite.config.ts`, and it must be
  absolute, not `'./'`. The shell is served verbatim at arbitrary depth, so relative
  asset URLs would resolve against the route and 404. Building with `base: '/'` emits
  HTML that asks for `/assets/…`, which the root mount refuses: blank page.

`/spa/` still works as an entry point: it's just no longer linked to.

### Constraints the root mount puts on route design

1. **No dot in a route's last segment.** The funnel treats a trailing-segment dot as a
   file extension and declines, so `/clients/acme.co` hard-404s on deep-link or
   refresh. Percent-encoding doesn't help: the path is decoded before the check. Put
   dotted values in a query string or slug them. Today's ids (`1234___2`, ticket
   numbers) are dot-free, so nothing is affected; a future id format must stay that way.
2. **Routes can't collide with real server paths**, because the shell is served only
   *after* routing has already failed. Reserved at the root: `/shared/**`, `/gql`,
   `/appinfo/**`, `/api/**`, `/admin/**`, `/oauth2/v1/**`, `/spa/**`, `/error`,
   `/script/**`, `/transpiler`, `/tutorial`, `/console-trace`, the legacy webapp
   directories (`/code`, `/custom`, `/help`, `/info`, `/legal`, `/templates`, `/xml`,
   `/jslib`, `/partners`, …) and anything `*.jsp`. The Maestro's own `/b/maestro` is a
   real server path too. None of the current routes collide.
3. **`GET`/`HEAD` only.** A SPA route can never be a form `POST` target: the funnel
   declines write methods deliberately. Post to the endpoint instead, which is what
   `api.ts` already does.
4. **`fetch()` never gets the shell.** By design, so a failed Maestro call returns an
   honest 404 rather than HTML that explodes in `.json()`. Don't add client logic that
   assumes an HTML error body.
5. **The home route must stay `/`.** That one is served by the welcome file, not the
   funnel.

A site that has never deployed answers `503`; a commit that fails to materialise on the
pod answers `502`. Neither is a routing problem: don't paper over either client-side.

### Verifying a deploy

```bash
curl -sk -H 'Sec-Fetch-Mode: navigate' https://cobalt.bluestep.net/clients/x  # 200, shell
curl -sk https://cobalt.bluestep.net/assets/index.js                          # 404, expected
curl -sk https://cobalt.bluestep.net/spa/assets/index-<hash>.js               # 200, the file
```

`index.html` is served `no-cache`, other files `public, max-age=300`, so the hashed
filenames are load-bearing for a deploy to actually be visible.

## Agreements (e-signature)

Two pages, one repo. The app carries the Agreements tab (envelopes, packet wizard,
send, correct/resend/verify), the per-unit template libraries at
`/agreements/templates`, the field-placement designer, and in-app signing.
`app/sign.html` is a **second Vite entry** — its own bundle, no React — served at
`/spa/sign.html` for external signers with no session; it talks only to the public
`/b/agreementSign` endpoint and shares the signview/signing/pdf modules with the
in-app page, which is what keeps the two surfaces identical.

`app/public/vendor/` carries pdf.js (`pdf.min.mjs` + worker, loaded at runtime from
`/spa/vendor/`, never bundled) and `pdf-lib.js` (fetched by the SERVER-side stamper
in Cobalt Maestro/AgreementSign — removing it breaks completion, not this app).

Server side: `U142140/Cobalt Maestro` (envelope + template actions, as-caller),
`U142140/Cobalt AgreementSign` (public runAsSuper, token-gated), and the
`Cobalt Agreement Sweep` formula (reminders + expiry, 30 min).
