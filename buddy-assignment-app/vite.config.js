import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The assignment service (server/index.js) the dev server forwards the
// API to.  Override with e.g.
//   ASSIGNMENT_API=http://localhost:3001 npm run dev
const ASSIGNMENT_API =
  process.env.ASSIGNMENT_API || 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Galene forwards /assignment/ to the assignment service (or, during
  // development, to this dev server), so the page lives under it.
  base: '/assignment/',
  build: {
    // served by server/index.js
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Requests arrive through Galene's reverse proxy, with Galene's
    // Host header (which may be a LAN name).
    allowedHosts: true,
    proxy: {
      '/assignment/api': ASSIGNMENT_API,
    },
  },
})
