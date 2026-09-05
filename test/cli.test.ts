import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolvePrinter,
  buildEscPos,
  printCommand,
  listCommand,
} from '../src/cli.ts'
import { listBlePrinters, writeToBlePrinter } from '../src/ble.ts'

vi.mock('../src/ble.ts', () => ({
  listBlePrinters: vi.fn(),
  writeToBlePrinter: vi.fn(),
}))

const printers = [
  { name: 'RPP02N', id: 'id-rpp' },
  { name: 'TM-T20', id: 'id-tm' },
]

beforeEach(() => {
  vi.mocked(listBlePrinters).mockReset()
  vi.mocked(writeToBlePrinter).mockReset()
})

describe('resolvePrinter', () => {
  it('matches by exact id', () => {
    expect(resolvePrinter('id-rpp', printers)?.name).toBe('RPP02N')
  })

  it('matches by case-insensitive name substring', () => {
    expect(resolvePrinter('rpp', printers)?.name).toBe('RPP02N')
    expect(resolvePrinter('TM', printers)?.name).toBe('TM-T20')
  })

  it('returns null when nothing matches', () => {
    expect(resolvePrinter('nope', printers)).toBeNull()
  })

  it('returns null and logs when multiple match', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const multi = [
      { name: 'POS A', id: 'a' },
      { name: 'POS B', id: 'b' },
    ]
    expect(resolvePrinter('pos', multi)).toBeNull()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('buildEscPos', () => {
  it('builds init + text + feed + cut', () => {
    const bytes = Array.from(buildEscPos('Hi', { feed: 3, noCut: false }))
    // ESC @ + "Hi" + ESC d 3 + GS V 65
    expect(bytes).toEqual([0x1b, 0x40, 0x48, 0x69, 0x1b, 0x64, 0x03, 0x1d, 0x56, 0x41])
  })

  it('omits the cut when noCut is true', () => {
    const bytes = Array.from(buildEscPos('Hi', { feed: 3, noCut: true }))
    expect(bytes).not.toContain(0x1d)
  })

  it('uses the requested feed count', () => {
    const bytes = Array.from(buildEscPos('Hi', { feed: 5, noCut: true }))
    expect(bytes).toContain(0x1b)
    expect(bytes[bytes.length - 1]).toBe(5)
  })
})

describe('listCommand', () => {
  it('lists printers', async () => {
    vi.mocked(listBlePrinters).mockResolvedValue(printers)
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    await listCommand(false)
    const logged = out.mock.calls.flat().join('\n')
    expect(logged).toContain('RPP02N')
    expect(logged).toContain('id-rpp')
    out.mockRestore()
  })

  it('shows all devices with --all', async () => {
    vi.mocked(listBlePrinters).mockResolvedValue(printers)
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    await listCommand(true)
    const logged = out.mock.calls.flat().join('\n')
    expect(logged).toContain('All BLE devices found:')
    out.mockRestore()
  })

  it('reports when no printers are found', async () => {
    vi.mocked(listBlePrinters).mockResolvedValue([])
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    await listCommand(false)
    const logged = out.mock.calls.flat().join('\n')
    expect(logged).toContain('No ESC/POS printers found.')
    out.mockRestore()
  })
})

describe('printCommand', () => {
  it('prints successfully', async () => {
    vi.mocked(listBlePrinters).mockResolvedValue(printers)
    vi.mocked(writeToBlePrinter).mockResolvedValue(undefined)
    const code = await printCommand(['RPP02N', 'Hello'])
    expect(code).toBe(0)
    expect(writeToBlePrinter).toHaveBeenCalledOnce()
  })

  it('returns 1 when missing arguments', async () => {
    expect(await printCommand(['RPP02N'])).toBe(1)
  })

  it('returns 1 when the printer is not found', async () => {
    vi.mocked(listBlePrinters).mockResolvedValue(printers)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await printCommand(['nope', 'Hello'])).toBe(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('returns 1 when the write fails', async () => {
    vi.mocked(listBlePrinters).mockResolvedValue(printers)
    vi.mocked(writeToBlePrinter).mockRejectedValue(new Error('boom'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await printCommand(['RPP02N', 'Hello'])).toBe(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('returns 1 for an invalid --feed value', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await printCommand(['RPP02N', 'Hello', '--feed', 'abc'])).toBe(1)
    err.mockRestore()
  })

  it('returns 1 for an unknown option', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await printCommand(['RPP02N', 'Hello', '--bogus'])).toBe(1)
    err.mockRestore()
  })
})