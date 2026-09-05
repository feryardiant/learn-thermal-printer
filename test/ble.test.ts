import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listBlePrinters,
  writeToBlePrinter,
  ESCPOS_SERVICE_UUID,
  ESCPOS_WRITE_CHAR_UUID,
} from '../src/ble.ts'

// Mocks shared between the webbluetooth mock and the tests.
const m = vi.hoisted(() => {
  return {
    requestDevice: vi.fn(),
    connect: vi.fn(),
    getPrimaryService: vi.fn(),
    getCharacteristic: vi.fn(),
    writeValueWithResponse: vi.fn(),
    disconnect: vi.fn(),
    // Captures the options passed to `new Bluetooth(...)`.
    instances: [] as Array<{ deviceFound: (d: { name: string; id: string }) => boolean }>,
  }
})

vi.mock('webbluetooth', () => {
  return {
    Bluetooth: class {
      constructor(opts: { deviceFound: (d: { name: string; id: string }) => boolean }) {
        m.instances.push(opts)
      }
      requestDevice = m.requestDevice
    },
  }
})

function makeDevice(id: string, name: string) {
  return { id, name }
}

beforeEach(() => {
  m.instances.length = 0
  m.requestDevice.mockReset()
  m.connect.mockReset()
  m.getPrimaryService.mockReset()
  m.getCharacteristic.mockReset()
  m.writeValueWithResponse.mockReset()
  m.disconnect.mockReset()
})

describe('listBlePrinters', () => {
  it('returns only devices whose names look like ESC/POS printers', async () => {
    // requestDevice resolves; the deviceFound hook is invoked per device.
    m.requestDevice.mockResolvedValue(undefined)
    const promise = listBlePrinters(1)

    const bt = m.instances[0]
    expect(bt).toBeDefined()

    // Feed devices through the captured deviceFound hook.
    const found = bt.deviceFound
    expect(found(makeDevice('id1', 'RPP02N'))).toBe(true)
    expect(found(makeDevice('id2', 'EarFun Air Pro 4i'))).toBe(false)
    expect(found(makeDevice('id3', 'TM-T20 Receipt Printer'))).toBe(true)
    expect(found(makeDevice('id4', 'Unknown or Unsupported Device'))).toBe(false)

    const printers = await promise
    expect(printers.map((p) => p.name)).toEqual(['RPP02N', 'TM-T20 Receipt Printer'])
  })

  it('returns an empty list when no printers are found', async () => {
    m.requestDevice.mockResolvedValue(undefined)
    const promise = listBlePrinters(1)
    const bt = m.instances[0]
    bt.deviceFound(makeDevice('id1', 'EarFun Air Pro 4i'))
    expect(await promise).toEqual([])
  })
})

describe('writeToBlePrinter', () => {
  function setupSuccess() {
    const char = { writeValueWithResponse: m.writeValueWithResponse }
    const service = { getCharacteristic: m.getCharacteristic }
    const server = {
      getPrimaryService: m.getPrimaryService,
      disconnect: m.disconnect,
    }
    const gatt = { connect: m.connect }
    const device = { id: 'dev-1', name: 'RPP02N', gatt }

    m.requestDevice.mockResolvedValue(device)
    m.connect.mockResolvedValue(server)
    m.getPrimaryService.mockResolvedValue(service)
    m.getCharacteristic.mockResolvedValue(char)
    m.writeValueWithResponse.mockResolvedValue(undefined)
    m.disconnect.mockResolvedValue(undefined)

    return { device, server, service, char }
  }

  it('connects, writes ESC/POS bytes, and disconnects', async () => {
    const { server, char } = setupSuccess()
    const data = new Uint8Array([0x1b, 0x40, 0x41])

    await writeToBlePrinter({ id: 'dev-1', name: 'RPP02N' }, data, 1)

    expect(m.requestDevice).toHaveBeenCalledWith({ acceptAllDevices: true })
    expect(m.connect).toHaveBeenCalledOnce()
    expect(m.getPrimaryService).toHaveBeenCalledWith(ESCPOS_SERVICE_UUID)
    expect(m.getCharacteristic).toHaveBeenCalledWith(ESCPOS_WRITE_CHAR_UUID)
    expect(m.writeValueWithResponse).toHaveBeenCalledWith(data.buffer)
    expect(m.disconnect).toHaveBeenCalledOnce()
    expect(char.writeValueWithResponse).toBe(m.writeValueWithResponse)
    expect(server.disconnect).toBe(m.disconnect)
  })

  it('throws when the device is not found', async () => {
    m.requestDevice.mockResolvedValue(undefined)
    await expect(
      writeToBlePrinter({ id: 'nope', name: 'Missing' }, new Uint8Array(), 1),
    ).rejects.toThrow(/not found/)
  })

  it('throws when the ESC/POS service is missing', async () => {
    setupSuccess()
    m.getPrimaryService.mockResolvedValue(undefined)
    await expect(
      writeToBlePrinter({ id: 'dev-1', name: 'RPP02N' }, new Uint8Array(), 1),
    ).rejects.toThrow(/does not expose ESC\/POS service/)
  })

  it('throws when the write characteristic is missing', async () => {
    setupSuccess()
    m.getCharacteristic.mockResolvedValue(undefined)
    await expect(
      writeToBlePrinter({ id: 'dev-1', name: 'RPP02N' }, new Uint8Array(), 1),
    ).rejects.toThrow(/does not expose write characteristic/)
  })

  it('still disconnects when the write throws', async () => {
    setupSuccess()
    m.writeValueWithResponse.mockRejectedValue(new Error('write failed'))
    await expect(
      writeToBlePrinter({ id: 'dev-1', name: 'RPP02N' }, new Uint8Array(), 1),
    ).rejects.toThrow(/write failed/)
    expect(m.disconnect).toHaveBeenCalledOnce()
  })
})
