import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = dirname(fileURLToPath(import.meta.url))

// GitSite contract:
//   - The app is served at the domain root. `base` stays at its default "/"
//     so hashed asset URLs emit as "/assets/...". The "/spa/" prefix this
//     starter used to require is no longer needed by the platform.
//   - The deploy artifact is the *committed build output at the repo root*
//     (default INDEX_PATH = "index.html"). Source lives in ./app; the build
//     emits index.html + assets/ to the repo root.
export default defineConfig({
  root: 'app',
  plugins: [react()],
  build: {
    // Emit the built SPA to the repository root so the zipball root IS the
    // artifact root. `emptyOutDir: false` because outDir is above `root`;
    // scripts/clean-artifact.mjs removes stale output before each build.
    outDir: resolve(repoRoot),
    emptyOutDir: false,
  },
})
