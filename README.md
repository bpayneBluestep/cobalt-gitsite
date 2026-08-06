# Cobalt

Static SPA deployable as a BlueStep GitSite, served under `/spa/`.

The committed build artifact at the repo root (`index.html` + `assets/`) **is** what
gets served — there is no server-side build. Source lives in `app/`.

## Commands

```bash
npm install
npm run dev      # local dev server
npm run build    # emits index.html + assets/ to the repo root
npm run preview  # preview the built artifact
```

## Deploy

Commit the build output and push to `main`. The BlueStep GitSite
(`cobalt.bluestep.net`) clones the repo and serves the root artifact; a GitHub
push webhook triggers redeploy.

- Git Ref: `main`
- Index Path: `index.html`
