import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Device, DeviceFinder, ESCPOS } from '../src/printer.ts'

// Mock webbluetooth: getBluetooth lazy-imports it only in the Node path.
const m = vi.hoisted(() => ({
  requestDevice: vi.fn(),
  instances: [] as Array<{ deviceFound: (d: { id: string; name: string }) => boolean }>,
}))

vi.mock('webbluetooth', () => ({
  Bluetooth: class {
    constructor(opts: { deviceFound: (d: { id: string; name: string }) => boolean }) {
      m.instances.push(opts)
    }
    requestDevice = m.requestDevice
  },
}))

function fakeDevice(id: string, name: string): { id: string; name: string; gatt?: unknown } {
  return { id, name, gatt: {} }
}

beforeEach(() => {
  m.instances.length = 0
  m.requestDevice.mockReset()
})

describe('Device.encode', () => {
  it('produces ESC/POS bytes with a prepended feed', async () => {
    const bt = { id: 'dev-1', name: 'RPP02N', gatt: {} } as unknown as BluetoothDevice
    const device = new Device(bt)
    const bytes = await device.encode('Hi', false, 3)
    // First 3 bytes = ESC d feed; followed by escaped text + cut.
    expect(Array.from(bytes.slice(0, 3))).toEqual([0x1b, 0x64, 0x03])
    // Contains TEXT and a paper-cut byte (0x1d GS ...).
    const all = Array.from(bytes)
    expect(all).toContain(0x1d)
  })

  it('omits the cut when cutting is false', async () => {
    const bt = { id: 'dev-1', name: 'RPP02N', gatt: {} } as unknown as BluetoothDevice
    const device = new Device(bt)
    const bytes = await device.encode('Hi', false, 1)
    const all = Array.from(bytes)
    // The paper-cut sequence is GS V (0x1d 0x56) — should be absent when cutting.
    const hasCut = all.some((v, i) => v === 0x1d && all[i + 1] === 0x56)
    expect(hasCut).toBe(false)
  })
})

describe('Device.send', () => {
  function setupGatt() {
    const writeFn = vi.fn().mockResolvedValue(undefined)
    const char = { writeValueWithResponse: writeFn }
    const service = { getCharacteristic: vi.fn().mockResolvedValue(char) }
    const server = {
      getPrimaryService: vi.fn().mockResolvedValue(service),
      disconnect: vi.fn(),
    }
    const gatt = { connect: vi.fn().mockResolvedValue(server) }
    const bt = { id: 'dev-1', name: 'RPP02N', gatt } as unknown as BluetoothDevice
    return { bt, server, service, char, writeFn }
  }

  it('sends chunks via writeValueWithResponse and disconnects', async () => {
    const { bt, server, service, char, writeFn } = setupGatt()
    const device = new Device(bt)
    await device.send('Hello', false, 1)

    expect(server.getPrimaryService).toHaveBeenCalledWith(ESCPOS.SERVICE_UUID)
    expect(service.getCharacteristic).toHaveBeenCalledWith(ESCPOS.WRITE_CHAR_UUID)
    expect(writeFn).toHaveBeenCalled() // at least the chunk
    expect(server.disconnect).toHaveBeenCalledOnce()
    expect(char.writeValueWithResponse).toBe(writeFn)
  })

  it('throws when the device has no GATT server', async () => {
    const bt = { id: 'x', name: 'RPP02N' } as unknown as BluetoothDevice
    const device = new Device(bt)
    await expect(device.send('Hi')).rejects.toThrow(/no GATT/i)
  })
})

describe('DeviceFinder', () => {
  it('is detected as not-in-browser in the Node test environment', () => {
    expect(new DeviceFinder().IN_BROWSER).toBe(false)
  })

  describe('getList', () => {
    function scanGate() {
      let resolveScan!: (v: unknown) => void
      m.requestDevice.mockImplementationOnce(
        () => new Promise((r) => {
          resolveScan = r
        }),
      )
      return () => resolveScan(undefined)
    }

    it('returns only devices whose names match printer patterns', async () => {
      const release = scanGate()
      const promise = new DeviceFinder().getList()

      await vi.waitFor(() => expect(m.instances.length).toBe(1))
      const bt = m.instances[0]
      expect(bt.deviceFound(fakeDevice('id1', 'RPP02N'))).toBe(true)
      expect(bt.deviceFound(fakeDevice('id2', 'EarFun Air Pro 4i'))).toBe(false)
      expect(bt.deviceFound(fakeDevice('id3', 'TM-T20 Receipt Printer'))).toBe(true)
      expect(bt.deviceFound(fakeDevice('id4', 'Unknown or Unsupported Device'))).toBe(false)

      release()
      const printers = await promise
      expect(printers.map((p) => p.name)).toEqual(['RPP02N', 'TM-T20 Receipt Printer'])
    })

    it('returns an empty list when no printers are found', async () => {
      const release = scanGate()
      const promise = new DeviceFinder().getList()
      await vi.waitFor(() => expect(m.instances.length).toBe(1))
      m.instances[0].deviceFound(fakeDevice('id1', 'EarFun Air Pro 4i'))
      release()
      expect(await promise).toEqual([])
    })
  })

  describe('getDevice', () => {
    function scanFor(name: string) {
      let resolveScan!: (v: unknown) => void
      m.requestDevice.mockImplementation(() => new Promise((r) => (resolveScan = r)))
      return {
        release: () => resolveScan(undefined),
        pending: new DeviceFinder().getDevice(name),
        async feedOnce(dev: { id: string; name: string; gatt?: unknown }) {
          await vi.waitFor(() => expect(m.instances.length).toBe(1))
          m.instances[0].deviceFound(dev)
        },
      }
    }

    it('returns a Device wrapping the found printer', async () => {
      const s = scanFor('RPP02N')
      await s.feedOnce({ id: 'dev-1', name: 'RPP02N', gatt: {} })
      s.release()
      const device = await s.pending
      expect(device.id).toBe('dev-1')
      expect(device.name).toBe('RPP02N')
    })

    it('throws when no device is found', async () => {
      const s = scanFor('Missing')
      await s.feedOnce({ id: 'dev-1', name: 'Other', gatt: {} })
      s.release()
      await expect(s.pending).rejects.toThrow()
    })
  })

  describe('find', () => {
    it('throws when neither id nor name is given', async () => {
      // find() calls getList() first; drive the scan so it resolves.
      let resolveScan!: (v: unknown) => void
      m.requestDevice.mockImplementation(() => new Promise((r) => (resolveScan = r)))
      const pending = new DeviceFinder().find({})
      await vi.waitFor(() => expect(m.instances.length).toBe(1))
      resolveScan(undefined)
      await expect(pending).rejects.toThrow()
    })
  })
})