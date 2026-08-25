import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles.css'

/*
 * This app has TWO bases and they are deliberately different. Do not collapse them.
 *
 *   ROUTES  live at the host root, so there is NO basename. The GitSite's root mount
 *           serves this shell for any extensionless browser GET that fails server-side
 *           routing, which makes /clients and /tickets/8 real, bookmarkable URLs.
 *           Nobody ever sees /spa/.
 *
 *   ASSETS  still live under /spa/. That is the only mount which streams files, and
 *           the root mount hard-404s anything with a file extension. Vite's `base`
 *           owns that at build time (import.meta.env.BASE_URL), which is why it must
 *           never be read back as a route prefix. It used to be, and that is exactly
 *           the coupling this comment exists to prevent someone restoring.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
