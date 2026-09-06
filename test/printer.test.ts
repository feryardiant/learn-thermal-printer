import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Device, DeviceFinder, ESCPOS, solidRuleLines } from '../src/printer.ts'

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

describe('solidRuleLines', () => {
  it('rewrites bare-dash lines into a GS v 0 raster-bar command line', () => {
    const out = solidRuleLines('head\n-\ntail')
    expect(out).toMatch(/^head\n\{x:/)
    const bar = out.match(/\{x:([^}]+)\}/)![1]
    // GS v 0 m xL xH yL yH ... — a full-width raster strip (48 bytes/row × 4 rows)
    expect(bar.startsWith('\\x1dv0\\x00\\x30\\x00\\x04\\x00')).toBe(true)
    expect((bar.match(/\\xff/g) ?? [])).toHaveLength(48 * 4) // all-black data
    expect(bar.endsWith('\\n')).toBe(true) // trailing newline → own printed row
  })

  it('rewrites any standalone dash line (multi/unpadded) once', () => {
    const out = solidRuleLines('a\n--\n- \nb')
    expect(out.match(/{x:/g)).toHaveLength(2)
    expect(out).toMatch(/^a\n\{x:/)
    expect(out).toMatch(/\}\nb$/)
  })

  it('leaves normal lines untouched', () => {
    const out = solidRuleLines('- a bullet')
    expect(out).not.toContain('{x:')
    expect(out).toBe('- a bullet')
  })
})

describe('Device.encode', () => {
  it('feeds below the content before the cut', async () => {
    const bt = { id: 'dev-1', name: 'RPP02N', gatt: {} } as unknown as BluetoothDevice
    const device = new Device(bt)
    const bytes = await device.encode('Hi', true, 3)
    const all = Array.from(bytes)
    // Tail must be: ESC d 03 (feed) + GS V B 00 (full cut) — feed comes BEFORE
    // the cut so a trailing raster clears the head before cutting.
    expect(all.slice(-7)).toEqual([0x1b, 0x64, 0x03, 0x1d, 0x56, 0x42, 0x00])
    // The feed must not be at the very start (no blank lines at the top).
    expect(all.slice(0, 3)).not.toEqual([0x1b, 0x64, 0x03])
  })

  it('omits the cut when cutting is false but still feeds', async () => {
    const bt = { id: 'dev-1', name: 'RPP02N', gatt: {} } as unknown as BluetoothDevice
    const device = new Device(bt)
    const bytes = await device.encode('Hi', false, 1)
    const all = Array.from(bytes)
    // The paper-cut sequence is GS V (0x1d 0x56) — should be absent when cutting.
    const hasCut = all.some((v, i) => v === 0x1d && all[i + 1] === 0x56)
    expect(hasCut).toBe(false)
    // ...but the trailing feed is still present.
    expect(all.slice(-3)).toEqual([0x1b, 0x64, 0x01])
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
