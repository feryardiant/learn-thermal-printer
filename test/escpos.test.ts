import { describe, it, expect } from 'vitest'
import {
  ESC,
  GS,
  init,
  encodeText,
  feedLines,
  cut,
  concat,
  interpretEscapes,
} from '../src/escpos.ts'

describe('init', () => {
  it('returns ESC @ (initialize printer)', () => {
    expect(init()).toEqual([0x1b, 0x40])
  })
})

describe('encodeText', () => {
  it('encodes ASCII text to UTF-8 bytes', () => {
    expect(Array.from(encodeText('AB'))).toEqual([0x41, 0x42])
  })

  it('encodes multi-byte UTF-8 characters', () => {
    // 'é' is 0xC3 0xA9 in UTF-8
    expect(Array.from(encodeText('é'))).toEqual([0xc3, 0xa9])
  })

  it('encodes an empty string to an empty buffer', () => {
    expect(encodeText('').length).toBe(0)
  })
})

describe('feedLines', () => {
  it('returns ESC d n', () => {
    expect(feedLines(3)).toEqual([ESC, 0x64, 3])
  })

  it('masks n to a single byte', () => {
    expect(feedLines(300)).toEqual([ESC, 0x64, 300 & 0xff])
  })
})

describe('cut', () => {
  it('returns GS V 65 for a full cut', () => {
    expect(cut('full')).toEqual([GS, 0x56, 0x41])
  })

  it('returns GS V 66 for a partial cut', () => {
    expect(cut('partial')).toEqual([GS, 0x56, 0x42])
  })
})

describe('concat', () => {
  it('concatenates byte arrays in order', () => {
    const a = new Uint8Array([1, 2])
    const b = new Uint8Array([3])
    const c = new Uint8Array([4, 5, 6])
    expect(Array.from(concat([a, b, c]))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('returns an empty buffer for no parts', () => {
    expect(concat([]).length).toBe(0)
  })
})

describe('interpretEscapes', () => {
  it('interprets \\n, \\r, and \\t', () => {
    expect(interpretEscapes('a\\nb\\rc\\td')).toBe('a\nb\rc\td')
  })

  it('leaves plain text unchanged', () => {
    expect(interpretEscapes('hello world')).toBe('hello world')
  })

  it('leaves a backslash not followed by a recognized escape unchanged', () => {
    // 'a\\b' is the string `a\b` (backslash + b), which is not an escape.
    expect(interpretEscapes('a\\b')).toBe('a\\b')
  })
})