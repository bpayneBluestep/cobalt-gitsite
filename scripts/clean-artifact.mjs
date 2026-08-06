// Removes the previously-built SPA artifact from the repo root before a rebuild.
// Vite is configured with emptyOutDir:false (outDir is above `root`), so stale
// hashed assets would otherwise accumulate. We only ever delete the known build
// outputs — never source under ./app.
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Only build outputs. Adding paths here is safe; never add "app".
const artifacts = ['index.html', 'assets']

for (const name of artifacts) {
  await rm(resolve(repoRoot, name), { recursive: true, force: true })
}

console.log('[clean-artifact] removed:', artifacts.join(', '))
