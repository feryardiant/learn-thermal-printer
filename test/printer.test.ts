import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Device, DeviceFinder, ESCPOS, FinderError, solidRuleLines } from '../src/printer.ts'

// Mock webbluetooth: getBluetooth lazy-imports it only in the Node path.
const m = vi.hoisted(() => ({
  requestDevice: vi.fn(),
  getDevices: vi.fn(),
  instances: [] as Array<Record<string, unknown>>,
}))

vi.mock('webbluetooth', () => ({
  Bluetooth: class {
    constructor(opts: Record<string, unknown>) {
      m.instances.push(opts)
    }
    requestDevice = m.requestDevice
    getDevices = m.getDevices
  },
}))

function fakeDevice(id: string, name: string): { id: string; name: string; gatt?: unknown } {
  return { id, name, gatt: {} }
}

beforeEach(() => {
  m.instances.length = 0
  m.requestDevice.mockReset()
  m.getDevices.mockReset()
  vi.unstubAllGlobals()
})

describe('solidRuleLines', () => {
  it('rewrites bare-dash lines into a GS v 0 raster-bar command line', () => {
    const out = solidRuleLines('head\n-\ntail')
    expect(out).toMatch(/^head\n\{x:/)
    const bar = out.match(/\{x:([^}]+)\}/)![1]
    // half-line feed above, then GS v 0 m xL xH yL yH ... full-width raster strip
    expect(bar.startsWith('\\x1bJ\\x0f\\x1dv0\\x00\\x30\\x00\\x04\\x00')).toBe(true)
    expect((bar.match(/\\xff/g) ?? [])).toHaveLength(48 * 4) // all-black data
    // half-line feed below (also clears the bar)
    expect(bar.endsWith('\\x1bJ\\x0f')).toBe(true)
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
    it('returns only devices whose names match printer patterns', async () => {
      m.getDevices.mockResolvedValue([
        fakeDevice('id1', 'RPP02N'),
        fakeDevice('id2', 'EarFun Air Pro 4i'),
        fakeDevice('id3', 'TM-T20 Receipt Printer'),
        fakeDevice('id4', 'Unknown or Unsupported Device'),
      ])

      const printers = await new DeviceFinder().getList()
      expect(printers.map((p) => p.name)).toEqual(['RPP02N', 'TM-T20 Receipt Printer'])
    })

    it('returns an empty list when no printers are found', async () => {
      m.getDevices.mockResolvedValue([fakeDevice('id1', 'EarFun Air Pro 4i')])

      expect(await new DeviceFinder().getList()).toEqual([])
    })

    it('does not duplicate a device reported more than once', async () => {
      const device = fakeDevice('id1', 'RPP02N')
      m.getDevices.mockResolvedValue([device, device])

      const list = await new DeviceFinder().getList()
      expect(list.map((d) => d.id)).toEqual(['id1'])
    })
  })

  describe('getList (browser)', () => {
    function stubBrowser(requestDevice: ReturnType<typeof vi.fn>) {
      vi.stubGlobal('navigator', { bluetooth: { requestDevice } })
    }

    it('returns only the freshly picked device and does not accumulate', async () => {
      const requestDevice = vi.fn()
        .mockResolvedValueOnce(fakeDevice('id-1', 'RPP02N'))
        .mockResolvedValueOnce(fakeDevice('id-2', 'RPP02N'))
      stubBrowser(requestDevice)

      const finder = new DeviceFinder()
      expect(finder.IN_BROWSER).toBe(true)

      const first = await finder.getList()
      const second = await finder.getList()

      expect(first.map((d) => d.id)).toEqual(['id-1'])
      expect(second.map((d) => d.id)).toEqual(['id-2'])
    })

    it('accepts an unnamed pick', async () => {
      stubBrowser(vi.fn().mockResolvedValue(fakeDevice('id-1', '')))

      const list = await new DeviceFinder().getList()
      expect(list.map((d) => d.id)).toEqual(['id-1'])
    })

    it('returns an empty list when the chooser is cancelled', async () => {
      stubBrowser(vi.fn().mockRejectedValue(new Error('cancelled')))

      expect(await new DeviceFinder().getList()).toEqual([])
    })

    it('returns an empty list on chooser cancel even when getDevices has permitted devices', async () => {
      vi.stubGlobal('navigator', {
        bluetooth: {
          requestDevice: vi.fn().mockRejectedValue(new Error('cancelled')),
          getDevices: vi.fn().mockResolvedValue([fakeDevice('permitted-1', 'RPP02N')]),
        },
      })

      const list = await new DeviceFinder().getList()
      expect(list).toEqual([])
    })
  })

  describe('getDevice', () => {
    it('returns a Device wrapping the found printer', async () => {
      m.getDevices.mockResolvedValue([{ id: 'dev-1', name: 'RPP02N', gatt: {} }])

      const device = await new DeviceFinder().getDevice('RPP02N')
      expect(device.id).toBe('dev-1')
      expect(device.name).toBe('RPP02N')
    })

    it('throws when no device is found', async () => {
      m.getDevices.mockResolvedValue([{ id: 'dev-1', name: 'Other', gatt: {} }])

      await expect(new DeviceFinder().getDevice('Missing')).rejects.toThrow(FinderError)
      await expect(new DeviceFinder().getDevice('Missing')).rejects.toThrow(/Could not find printer/)
    })

    it('throws when multiple printers match', async () => {
      m.getDevices.mockResolvedValue([
        fakeDevice('id1', 'RPP02N'),
        fakeDevice('id2', 'RPP02N Plus'),
      ])

      await expect(new DeviceFinder().getDevice('rpp02n')).rejects.toThrow(/Multiple printers found/)
    })

    it('resolves a device by exact BLE id', async () => {
      m.getDevices.mockResolvedValue([fakeDevice('AA:BB:CC', 'RPP02N')])

      const device = await new DeviceFinder().getDevice('AA:BB:CC')
      expect(device.id).toBe('AA:BB:CC')
    })
  })
})
