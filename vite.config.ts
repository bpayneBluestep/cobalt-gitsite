import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = dirname(fileURLToPath(import.meta.url))

// GitSite contract. The site is backed by two mounts over the same unpacked commit:
//
//   /spa/**  the only mount that streams real files. Assets MUST be requested here.
//   /        serves this app's index.html: the welcome file at "/", and the 404
//            funnel for any deeper extensionless browser GET. It never serves a file:
//            a path whose last segment has a dot is classified as an asset and hard
//            404s at the root.
//
// So `base` is an ASSET base, not a route prefix:
//   - It stays "/spa/" for the build. With "/" the emitted HTML asks for /assets/…,
//     which the root mount refuses: a blank page, verified against the live deploy.
//   - It must be ABSOLUTE, never "./". The shell is served verbatim at arbitrary
//     depth (/clients/123/files), so relative asset URLs would resolve against the
//     route and 404.
//   - Routes carry no prefix at all. See the note in app/src/main.tsx.
//
// Dev serves from "/" so local URLs match production route-for-route and Vite's
// history fallback handles deep links; only the build needs the /spa/ asset prefix.
//
// The deploy artifact is the *committed build output at the repo root* (default
// INDEX_PATH = "index.html"). Source lives in ./app.
export default defineConfig(({ command }) => ({
  root: 'app',
  base: command === 'build' ? '/spa/' : '/',
  plugins: [react()],
  build: {
    // Emit the built SPA to the repository root so the zipball root IS the
    // artifact root. `emptyOutDir: false` because outDir is above `root`;
    // scripts/clean-artifact.mjs removes stale output before each build.
    outDir: resolve(repoRoot),
    emptyOutDir: false,
  },
}))
