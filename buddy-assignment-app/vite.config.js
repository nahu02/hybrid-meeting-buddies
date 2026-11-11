import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Galene server the dev/preview servers proxy to.  Set
// GALENE_TARGET to point somewhere else, e.g.
//   GALENE_TARGET=http://localhost:8443 npm run dev
const GALENE_TARGET =
  process.env.GALENE_TARGET || 'https://localhost:8443'

// The app always uses same-origin URLs (/protocol.js, /ws,
// /group/<name>/.status), exactly as it does when it is served by the
// Galene server itself; during development the dev server proxies those
// paths to the Galene server, so no environment-dependent code is
// needed in the app.
const galeneProxy = {
  target: GALENE_TARGET,
  changeOrigin: true,
  secure: false,
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Galene serves the built app under /assignment/ (the openUrl
  // message sends participants to /assignment/<group>/<id>?role=<role>,
  // see webserver.assignmentHandler).
  base: '/assignment/',
  build: {
    // ... into the directory the Go server serves; it is a build
    // artifact, so it is gitignored (see the repository .gitignore).
    outDir: '../static/assignment',
    emptyOutDir: true,
    // the modulepreload polyfill is emitted as an inline script, which
    // Galene's Content-Security-Policy forbids
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: {
      // protocol.js (Galene's client library, loaded with a plain
      // <script src="/protocol.js"> in index.html)
      '/protocol.js': galeneProxy,
      // fallback websocket endpoint (the /group/<name>/.status fetch
      // below usually already returns the real Galene endpoint)
      '/ws': { ...galeneProxy, ws: true },
      // /group/<name>/.status: websocket endpoint and auth info
      '/group': galeneProxy,
      '/hf-proxy': {
        target: 'https://router.huggingface.co/hf-inference',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hf-proxy/, ''),
        secure: true
      }
    }
  },
  preview: {
    proxy: {
      '/protocol.js': galeneProxy,
      '/ws': { ...galeneProxy, ws: true },
      '/group': galeneProxy,
      '/hf-proxy': {
        target: 'https://router.huggingface.co/hf-inference',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hf-proxy/, ''),
        secure: true
      }
    }
  }
})
