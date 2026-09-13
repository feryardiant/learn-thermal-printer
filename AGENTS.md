# AGENTS.md — thermal-print

## Overview

Web UI + Node CLI for printing text to Bluetooth ESC/POS thermal printers (primarily RPP02N). Uses **receiptline** for ReceiptLine markup → ESC/POS encoding.

Dual-path architecture:
- **Browser** (`src/main.ts`): Web Bluetooth API (`navigator.bluetooth`)
- **CLI** (`src/cli.ts`): `webbluetooth` native Node module

## Commands

| Command | What |
|---|---|
| `bun run dev` | Vite dev server |
| `bun run build` | `tsc && vite build` (typecheck first) |
| `bun run test` | `vitest run` (all 3 test files) |
| `bun run test:watch` | `vitest` (watch mode) |

**Gotcha:** `bun test` uses bun's native test runner and will fail (`vi.hoisted` not supported). Always use `bun run test` to invoke vitest from package.json scripts.

## CLI runner constraint

**Must use `bun`** (not `node`). Example:
```
bun src/cli.ts list
bun src/cli.ts print RPP02N "<ReceiptLine markup>"
```

## receiptline

receiptline browser build lives in `node_modules/receiptline/lib/receiptline.js`. A custom Vite plugin (`receiptlineGlobal()` in `vite.config.ts`) serves it at `/receiptline.js` — no manual copy needed. In the browser it's loaded via `<script>` tag (global `window.receiptline`); in the CLI it's lazy-imported via ESM.

## ESC/POS quirks (RPP02N-specific)

- Use `command: 'generic'` (not `'escpos'`). The RPP02N ignores Seiko-specific sequences.
- `solidRuleLines()` rewrites bare `-` lines into `GS v 0` raster bars (the printer's code page renders 0x95 as `ò`, not a line).
- MTU chunking: 237 bytes per write (MTU 240 − 3-byte ATT header), 20ms inter-chunk delay.
- Feed-before-cut (`ESC d` then `GS V B 00`): ensures trailing rasters clear the print head before cutting.
- SPP vs BLE workaround: if paired but not found, connect via a printer app to switch from classic SPP to BLE mode.

## Tests

Vitest, 32 tests across 3 files:

| File | Environment | Notes |
|---|---|---|
| `test/printer.test.ts` | node | Mocks `webbluetooth` native module |
| `test/cli.test.ts` | node | Mocks printer module |
| `test/main.test.ts` | happy-dom | Must be first (`// @vitest-environment happy-dom`). Mocks style.css import. |

`vitest.config.ts` sets default env to `node`; `main.test.ts` opts into happy-dom per-file.

## Architecture notes

- **Entrypoints**: `src/main.ts` (browser), `src/cli.ts` (Node CLI). Neither imports the other.
- **Printer abstraction**: `DeviceFinder` (scan/find BLE devices) + `Device` (connect/send) in `src/printer.ts`.
- **DeviceFinder patterns**: Matches printer names (case-insensitive) against `['rpp', 'pos', 'printer', 'thermal', 'receipt', 'escpos', ...]`.
- **No CI**: No `.github/` workflows.

## Code style

- TypeScript strict, `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, no unused locals/params.
- EditorConfig: 2-space indent, LF, UTF-8.
- `.gitignore` blocks `.vscode/*` (except extensions.json).
