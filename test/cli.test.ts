import { describe, it, expect, vi, beforeEach } from 'vitest'
import { printCommand, listCommand, loadReceiptlineDoc } from '../src/cli.ts'

// Mock the printer module used by the CLI.
const m = vi.hoisted(() => ({
  getList: vi.fn(),
  getDevice: vi.fn(),
  send: vi.fn(),
}))

vi.mock('../src/printer.ts', () => ({
  DeviceFinder: class {
    getList = m.getList
    getDevice = m.getDevice
  },
  Device: class {
    send = m.send
  },
  FinderError: class extends Error {
    readonly id: string
    constructor(id: string, message: string) {
      super(message)
      this.id = id
    }
  },
}))

const devRPP = { id: 'id-rpp', name: 'RPP02N', gatt: {} }

beforeEach(() => {
  m.getList.mockReset()
  m.getDevice.mockReset()
  m.send.mockReset()
})

describe('listCommand', () => {
  it('lists printers', async () => {
    m.getList.mockResolvedValue([devRPP])
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    await listCommand(false)
    const logged = out.mock.calls.flat().join('\n')
    expect(logged).toContain('RPP02N')
    expect(logged).toContain('id-rpp')
    out.mockRestore()
  })

  it('shows all devices with --all', async () => {
    m.getList.mockResolvedValue([devRPP])
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    await listCommand(true)
    const logged = out.mock.calls.flat().join('\n')
    expect(logged).toContain('All BLE devices found:')
    out.mockRestore()
  })

  it('reports when no printers are found', async () => {
    m.getList.mockResolvedValue([])
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    await listCommand(false)
    const logged = out.mock.calls.flat().join('\n')
    expect(logged).toContain('No ESC/POS printers found.')
    out.mockRestore()
  })
})

describe('printCommand', () => {
  it('prints successfully', async () => {
    const dev = { id: 'id-rpp', name: 'RPP02N', send: m.send }
    m.getDevice.mockResolvedValue(dev)
    m.send.mockResolvedValue(undefined)
    const code = await printCommand(['RPP02N', 'Hello'])
    expect(code).toBe(0)
    expect(m.getDevice).toHaveBeenCalledWith('RPP02N')
    expect(m.send).toHaveBeenCalledOnce()
  })

  it('prints a ReceiptLine document from a file path', async () => {
    const dev = { id: 'id-rpp', name: 'RPP02N', send: m.send }
    m.getDevice.mockResolvedValue(dev)
    m.send.mockResolvedValue(undefined)
    const code = await printCommand(['RPP02N', 'src/samples/06-test-card.md'])
    expect(code).toBe(0)
    expect(m.send).toHaveBeenCalledOnce()
  })

  it('returns 1 when missing arguments', async () => {
    expect(await printCommand(['RPP02N'])).toBe(1)
  })

  it('returns 1 when the printer is not found', async () => {
    m.getDevice.mockRejectedValue(new Error('not found'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await printCommand(['nope', 'Hello'])).toBe(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('returns 1 when the send fails', async () => {
    const dev = { id: 'id-rpp', name: 'RPP02N', send: m.send }
    m.getDevice.mockResolvedValue(dev)
    m.send.mockRejectedValue(new Error('boom'))
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

describe('loadReceiptlineDoc', () => {
  it('returns the argument as-is when it is not a file path', () => {
    expect(loadReceiptlineDoc('|^Hello^|')).toBe('|^Hello^|')
  })
})