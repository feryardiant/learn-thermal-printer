/// <reference types="vitest/config" />

import { defineConfig, Plugin } from 'vite'
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Serves receiptline's browser build at `/receiptline.js` without copying it into
 * the project:
 * - dev:     served from node_modules via configureServer (middleware).
 * - build:   emitted to `dist/receiptline.js` via generateBundle.
 * - preview: served from dist (already emitted by build).
 */
function receiptlineGlobal(): Plugin {
  // Path of the vendored receiptline browser build inside node_modules.
  // It isn't exported via package.json "exports"/"files", but is always present
  // after `bun install`. We serve it as `/receiptline.js` in dev and emit it to
  // dist/ on build — no manual copy into public/ required.
  const RECEIPTLINE_NODE_MODULE = require.resolve('receiptline/lib/receiptline.js')

  const OUT_DIR = fileURLToPath(new URL('./dist', import.meta.url))

  return {
    name: 'serve-receiptline',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (url === '/receiptline.js') {
          res.setHeader('Content-Type', 'application/javascript')
          res.end(readFileSync(RECEIPTLINE_NODE_MODULE))
          return
        }
        next()
      })
    },
    generateBundle() {
      // Emit the file into dist so `vite preview` (and deployments) have it.
      mkdirSync(OUT_DIR, { recursive: true })
      copyFileSync(RECEIPTLINE_NODE_MODULE, join(OUT_DIR, 'receiptline.js'))
    },
  }
}

export default defineConfig({
  plugins: [receiptlineGlobal()],
  build: {
    rollupOptions: {
      external: ['receiptline'],
    },
  },
  test: {
    // Default environment for pure-logic tests.
    environment: 'node',
    // main.test.ts opts into happy-dom via a per-file comment.
    include: ['test/**/*.test.ts'],
    // Don't process CSS imports (main.ts imports style.css).
    css: false,
  },
})
