import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolvePrinter, printCommand, listCommand } from '../src/cli.ts'

// Mock the shared printer module used by the CLI.
const m = vi.hoisted(() => ({
  getList: vi.fn(),
  getDevice: vi.fn(),
  sendTo: vi.fn(),
}))

vi.mock('../src/printer.ts', () => ({
  DeviceFinder: class {
    getList = m.getList
    getDevice = m.getDevice
  },
  Command: class {
    sendTo = m.sendTo
  },
}))

const devRPP = { id: 'id-rpp', name: 'RPP02N', gatt: {} }
const devTM = { id: 'id-tm', name: 'TM-T20', gatt: {} }

beforeEach(() => {
  m.getList.mockReset()
  m.getDevice.mockReset()
  m.sendTo.mockReset()
})

describe('resolvePrinter', () => {
  const devs = [devRPP, devTM] as BluetoothDevice[]

  it('matches by exact id', () => {
    expect(resolvePrinter('id-rpp', devs)?.name).toBe('RPP02N')
  })

  it('matches by case-insensitive name substring', () => {
    expect(resolvePrinter('rpp', devs)?.name).toBe('RPP02N')
    expect(resolvePrinter('TM', devs)?.name).toBe('TM-T20')
  })

  it('returns null when nothing matches', () => {
    expect(resolvePrinter('nope', devs)).toBeNull()
  })

  it('returns null and logs when multiple match', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const multi = [
      { id: 'a', name: 'POS A', gatt: {} },
      { id: 'b', name: 'POS B', gatt: {} },
    ] as BluetoothDevice[]
    expect(resolvePrinter('pos', multi)).toBeNull()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('listCommand', () => {
  it('lists printers', async () => {
    m.getList.mockResolvedValue([devRPP, devTM])
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
    m.getList.mockResolvedValue([devRPP])
    m.getDevice.mockResolvedValue(devRPP)
    m.sendTo.mockResolvedValue(undefined)
    const code = await printCommand(['RPP02N', 'Hello'])
    expect(code).toBe(0)
    expect(m.getDevice).toHaveBeenCalledWith('id-rpp', 'RPP02N')
    expect(m.sendTo).toHaveBeenCalledOnce()
  })

  it('returns 1 when missing arguments', async () => {
    expect(await printCommand(['RPP02N'])).toBe(1)
  })

  it('returns 1 when the printer is not found', async () => {
    m.getList.mockResolvedValue([devRPP])
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await printCommand(['nope', 'Hello'])).toBe(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('returns 1 when resolving the device fails', async () => {
    m.getList.mockResolvedValue([devRPP])
    m.getDevice.mockRejectedValue(new Error('no device'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await printCommand(['RPP02N', 'Hello'])).toBe(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('returns 1 when the write fails', async () => {
    m.getList.mockResolvedValue([devRPP])
    m.getDevice.mockResolvedValue(devRPP)
    m.sendTo.mockRejectedValue(new Error('boom'))
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
