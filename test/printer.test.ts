import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeviceFinder, Command, ESCPOS } from '../src/printer.ts'

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

function fakeDevice(id: string, name: string) {
  return { id, name }
}

/** Build a fake device + GATT chain that captures the written buffer. */
function captureDevice() {
  const writeFn = vi.fn().mockResolvedValue(undefined)
  const char = { writeValueWithResponse: writeFn }
  const service = { getCharacteristic: vi.fn().mockResolvedValue(char) }
  const server = {
    getPrimaryService: vi.fn().mockResolvedValue(service),
    disconnect: vi.fn(),
  }
  const gatt = { connect: vi.fn().mockResolvedValue(server) }
  const device = { id: 'dev-1', name: 'RPP02N', gatt } as unknown as BluetoothDevice
  return { device, writeFn, server, service, char }
}

beforeEach(() => {
  m.instances.length = 0
  m.requestDevice.mockReset()
})

describe('Command', () => {
  it('builds init + text + feed + cut', async () => {
    const { device, writeFn } = captureDevice()
    await new Command('Hi', 3, false, 'full').sendTo(device)
    const sent = writeFn.mock.calls[0][0]
    expect(Array.from(new Uint8Array(sent))).toEqual([
      0x1b, 0x40, 0x48, 0x69, 0x1b, 0x64, 0x03, 0x1d, 0x56, 0x41,
    ])
  })

  it('omits the cut when noCut is true', async () => {
    const { device, writeFn } = captureDevice()
    await new Command('Hi', 3, true, 'full').sendTo(device)
    const sent = Array.from(new Uint8Array(writeFn.mock.calls[0][0]))
    expect(sent).not.toContain(0x1d)
  })

  it('uses the requested feed count', async () => {
    const { device, writeFn } = captureDevice()
    await new Command('Hi', 5, true, 'full').sendTo(device)
    const sent = Array.from(new Uint8Array(writeFn.mock.calls[0][0]))
    expect(sent[sent.length - 1]).toBe(5)
  })

  it('interprets \\n escape sequences before encoding', async () => {
    const { device, writeFn } = captureDevice()
    await new Command('a\\nb', 0, true, 'full').sendTo(device)
    const sent = Array.from(new Uint8Array(writeFn.mock.calls[0][0]))
    expect(sent).toContain(0x0a) // newline byte
  })

  it('throws when the device has no GATT server', async () => {
    const device = { id: 'x', name: 'RPP02N' }
    await expect(
      new Command('Hi', 1, true, 'full').sendTo(device as unknown as BluetoothDevice),
    ).rejects.toThrow(/GATT/)
  })

  it('uses writeValueWithResponse', async () => {
    const { device, service } = captureDevice()
    await new Command('Hi', 1, true, 'full').sendTo(device)
    expect(service.getCharacteristic).toHaveBeenCalledWith(ESCPOS.WRITE_CHAR_UUID)
  })

  it('still disconnects when the write throws', async () => {
    const { device, writeFn, server } = captureDevice()
    writeFn.mockRejectedValue(new Error('write failed'))
    await expect(new Command('Hi', 1, true, 'full').sendTo(device)).rejects.toThrow(/write failed/)
    expect(server.disconnect).toHaveBeenCalledOnce()
  })
})

describe('PrinterDevice', () => {
  it('is detected as not-in-browser in the Node test environment', () => {
    expect(DeviceFinder.IN_BROWSER).toBe(false)
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

      // getBluetooth is async (lazy webbluetooth import); wait for the instance.
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
    it('requests the device by id and returns it', async () => {
      m.requestDevice.mockResolvedValue({ id: 'dev-1', name: 'RPP02N', gatt: {} })
      const device = await new DeviceFinder().getDevice('dev-1', 'RPP02N')
      expect(device.id).toBe('dev-1')
      expect(m.requestDevice).toHaveBeenCalledWith({ acceptAllDevices: true })
    })

    it('throws when no device is found', async () => {
      m.requestDevice.mockResolvedValue(undefined)
      await expect(new DeviceFinder().getDevice('x', 'Y')).rejects.toThrow(/not found/)
    })

    it('throws when the device has no GATT server', async () => {
      m.requestDevice.mockResolvedValue({ id: 'x', name: 'Y' })
      await expect(new DeviceFinder().getDevice('x', 'Y')).rejects.toThrow(/no GATT/)
    })
  })
})
