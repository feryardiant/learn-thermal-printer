// webbluetooth is a Node-only native module. Import only its types statically
// (erased at runtime) so this module stays browser-safe; the value is loaded
// dynamically in the Node (CLI) path only.
import type { BluetoothOptions } from 'webbluetooth'

export const ESCPOS = {
  /**
   * ESC/POS printers commonly expose their write characteristic under this service.
   */
  SERVICE_UUID: '0000ff00-0000-1000-8000-00805f9b34fb',

  /**
   * The write characteristic used to send ESC/POS data.
   */
  WRITE_CHAR_UUID: '0000ff02-0000-1000-8000-00805f9b34fb',
} as const

const ESC = 0x1b
const GS = 0x1d

export class Command {
  private cmds: Uint8Array[] = []

  constructor(text: string, feed: number, noCut: boolean, mode: 'full' | 'partial') {
    // Initialize with the default ESC/POS initialization command
    this.append([ESC, 0x40])

    // Encode text as UTF-8 bytes.
    this.append(this.encodeEscapes(text))

    // `ESC d n` — feed `n` lines.
    this.append([ESC, 0x64, feed & 0xff])

    if (!noCut) {
      // `GS V m` — cut paper.
      // - `full`   → `GS V 65` (0x41)
      // - `partial`→ `GS V 66` (0x42)
      this.append([GS, 0x56, mode === 'full' ? 0x41 : 0x42])
    }
  }

  /**
   * Build byte arrays into a single buffer and send it to the device.
   */
  async sendTo(device: BluetoothDevice): Promise<void> {
    const total = this.cmds.reduce((n, p) => n + p.length, 0)
    const data = new Uint8Array(total)
    let offset = 0

    for (const cmd of this.cmds) {
      data.set(cmd, offset)
      offset += cmd.length
    }

    if (!device.gatt) {
      throw new Error('Device has no GATT server.')
    }

    const server = await device.gatt.connect()

    try {
      const service = await server.getPrimaryService(ESCPOS.SERVICE_UUID)

      if (!service) {
        throw new Error(`Device does not expose ESC/POS service ${ESCPOS.SERVICE_UUID}`)
      }

      const char = await service.getCharacteristic(ESCPOS.WRITE_CHAR_UUID)

      if (!char) {
        throw new Error(`Device does not expose write characteristic ${ESCPOS.WRITE_CHAR_UUID}`)
      }

      // Use write-with-response so the write is acknowledged before we
      // disconnect. writeValueWithoutResponse is fire-and-forget: disconnecting
      // immediately after can drop the bytes before they reach the printer.
      await char.writeValueWithResponse(data.buffer as ArrayBuffer)
    } finally {
      try {
        server.disconnect()
      } catch {
        // ignore disconnect errors
      }
    }
  }

  /**
    * Encode common escape sequences (`\n`, `\r`, `\t`)  as UTF-8 bytes.
    */
  private encodeEscapes(text: string): Uint8Array {
    text = text
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')

    return new TextEncoder().encode(text)
  }

  private append(cmd: Uint8Array | number[]): this {
    if (cmd instanceof Uint8Array) {
      this.cmds.push(cmd)
    } else {
      this.cmds.push(Uint8Array.from(cmd))
    }

    return this
  }
}

export class DeviceFinder {
  /**
    * Substrings (case-insensitive) that indicate a BLE device is an ESC/POS
    * receipt printer. Matched against the device name.
    */
  static PATTERNS = [
    'rpp', 'pos', 'printer', 'thermal', 'receipt', 'escpos', 'esc-pos',
    'tm-', 'sp-', 'epson', 'star', 'bixolon', 'citizen', 'xprinter',
    'apos', 'samsung', 'sii', 'custom', 'rp-',
  ]

  /**
   * Whether we are running in a browser (where Web Bluetooth is available via
   * `navigator.bluetooth`) as opposed to Node (where we use `webbluetooth`).
   * Guarded against `navigator` being undefined in Node.
   */
  static IN_BROWSER = typeof navigator !== 'undefined' && 'bluetooth' in navigator

  async getList(): Promise<BluetoothDevice[]> {
    const found: BluetoothDevice[] = []
    const bt = await this.getBluetooth((device) => {
      if (this.isValid(device.name || '')) {
        found.push(device)
        return true // auto-select to stop scanning this device
      }

      return false
    })

    try {
      await bt.requestDevice({ acceptAllDevices: true })
    } catch {
      // scan completed or timed out; `found` already populated
    }

    return found
  }

  async getDevice(id: string, name: string): Promise<BluetoothDevice> {
    const bt = await this.getBluetooth((device) => device.id === id)
    const opt: RequestDeviceOptions = { acceptAllDevices: true }

    if (DeviceFinder.IN_BROWSER) {
      opt.optionalServices = [ESCPOS.SERVICE_UUID]
    }

    const device = await bt.requestDevice(opt)

    if (!device) {
      throw new Error(`BLE printer "${name}" not found`)
    }

    if (!device.gatt) {
      throw new Error('Device has no GATT server.')
    }

    return device
  }

  private isValid(name: string): boolean {
    const n = name.toLowerCase()

    return DeviceFinder.PATTERNS.some((p) => n.includes(p))
  }

  private async getBluetooth(deviceFound: BluetoothOptions['deviceFound'], scanTime = 8) {
    if (DeviceFinder.IN_BROWSER) {
      return navigator.bluetooth
    }

    // Node only — load the native webbluetooth binding lazily.
    const { Bluetooth } = await import('webbluetooth')
    return new Bluetooth({ deviceFound, scanTime })
  }
}
