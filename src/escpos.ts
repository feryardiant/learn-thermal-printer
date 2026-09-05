/** ESC/POS command builders. All commands are byte sequences sent to the printer. */

export const ESC = 0x1b
export const GS = 0x1d

/** `ESC @` — initialize the printer (resets formatting, clears buffers). */
export function init(): number[] {
  return [ESC, 0x40]
}

/** Encode text as UTF-8 bytes. */
export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** `ESC d n` — feed `n` lines. */
export function feedLines(n: number): number[] {
  return [ESC, 0x64, n & 0xff]
}

/**
 * `GS V m` — cut paper.
 * - `full`   → `GS V 65` (0x41)
 * - `partial`→ `GS V 66` (0x42)
 */
export function cut(mode: 'full' | 'partial'): number[] {
  return [GS, 0x56, mode === 'full' ? 0x41 : 0x42]
}

/** Concatenate byte arrays into a single buffer. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Interpret common escape sequences (`\n`, `\r`, `\t`) in user-provided text. */
export function interpretEscapes(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
}