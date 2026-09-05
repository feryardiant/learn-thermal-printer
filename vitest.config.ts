import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Default environment for pure-logic tests.
    environment: 'node',
    // main.test.ts opts into happy-dom via a per-file comment.
    include: ['test/**/*.test.ts'],
    // Don't process CSS imports (main.ts imports style.css).
    css: false,
  },
})