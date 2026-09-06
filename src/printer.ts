// webbluetooth is a Node-only native module. Import only its types statically
// (erased at runtime) so this module stays browser-safe; the value is loaded
// dynamically in the Node (CLI) path only.
import type { BluetoothOptions } from 'webbluetooth'
import receiptline from 'receiptline'

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

export class Device {
  private device: BluetoothDevice

  constructor(device: BluetoothDevice) {
    this.device = device
  }

  get id(): string {
    return this.device.id
  }

  get name(): string {
    return this.device.name || 'Unknown device'
  }

  /**
   * Send a raw ESC/POS byte buffer to a device over its GATT write
   * characteristic.
   *
   * This printer loses ACKs on `writeValueWithResponse` (it prints the bytes but
   * the ACK is lost), which made retries resend the whole buffer and duplicate the
   * header. So we use `writeValueWithoutResponse` (fire-and-forget) to stream the
   * chunks after the link settles — the printer accepts and prints them reliably
   * without false failures.
   */
  async send(doc: string, cutting: boolean = true, feed = 3) {
    const server = await this.connect()

    const char = await this.getCharacteristic(server)
    const bytes = await this.encode(doc, cutting, feed)

    // Let the BLE link settle before streaming writes.
    await new Promise((r) => setTimeout(r, 500))

    // BLE ATT limits each write to (MTU - 3) bytes. Chunk larger payloads and
    // pace them so the printer can process each chunk.
    const CHUNK = 240 // MTU 240 minus the 3-byte ATT header
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length))
      await char.writeValueWithResponse(chunk.buffer)
      if (offset + CHUNK < bytes.length) {
        // Small inter-chunk delay so the printer isn't overwhelmed.
        await new Promise((r) => setTimeout(r, 20))
      }
    }

    // Give the printer a moment to finish processing before disconnecting.
    await new Promise((r) => setTimeout(r, 500))

    server.disconnect()
  }

  async encode(doc: string, cutting: boolean = true, feed = 1): Promise<Uint8Array<ArrayBuffer>> {
    // ReceiptLine transforms the document into ESC/POS bytes. `cutting` controls
    // the paper cut; a feed is prepended so the paper advances before the cut.
    const data = receiptline.transform(doc, {
      cpl: 32,
      encoding: 'multilingual',
      command: 'escpos',
      cutting,
    })

    /**
     * Convert receiptline's binary-string output (one char = one byte, 0–255)
     * into a Uint8Array, preserving raw bytes >127.
     */
    const buffer = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) {
      buffer[i] = data.charCodeAt(i) & 0xff
    }

    // Prepend `ESC d feed` — advance the paper below the content before the cut.
    buffer.set(Uint8Array.from([0x1b, 0x64, feed & 0xff]), 0)

    return buffer
  }

  async connect() {
    if (!this.device.gatt) {
      throw new FinderError(this.name, 'Device has no GATT server.')
    }

    const server = await this.device.gatt.connect()

    return server
  }

  async getCharacteristic(server: BluetoothRemoteGATTServer): Promise<BluetoothRemoteGATTCharacteristic> {
    const service = await server.getPrimaryService(ESCPOS.SERVICE_UUID)

    if (!service) {
      throw new Error(`Device does not expose ESC/POS service ${ESCPOS.SERVICE_UUID}`)
    }

    const char = await service.getCharacteristic(ESCPOS.WRITE_CHAR_UUID)

    if (!char) {
      throw new Error(`Device does not expose write characteristic ${ESCPOS.WRITE_CHAR_UUID}`)
    }

    return char
  }
}

export class DeviceFinder {
  /**
   * Substrings (case-insensitive) that indicate a BLE device is an ESC/POS
   * receipt printer. Matched against the device name.
   */
  readonly PATTERNS = [
    'rpp', 'pos', 'printer', 'thermal', 'receipt', 'escpos', 'esc-pos',
    'tm-', 'sp-', 'epson', 'star', 'bixolon', 'citizen', 'xprinter',
    'apos', 'samsung', 'sii', 'custom', 'rp-',
  ]

  /**
   * Whether we are running in a browser (where Web Bluetooth is available via
   * `navigator.bluetooth`) as opposed to Node (where we use `webbluetooth`).
   * Guarded against `navigator` being undefined in Node.
   */
  readonly IN_BROWSER = typeof navigator !== 'undefined' && 'bluetooth' in navigator

  async getList(): Promise<BluetoothDevice[]> {
    const found: BluetoothDevice[] = []
    const bt = await this.getBluetooth((device) => {
      if (!this.isValid(device.name)) {
        return false
      }

      found.push(device)

      return true
    })

    try {
      await bt.requestDevice({
        acceptAllDevices: true,
        optionalServices: [ESCPOS.SERVICE_UUID]
      })
    } catch {
      // scan completed or timed out; `found` already populated
    }

    return found
  }

  async find(opt: { id?: string, name?: string }): Promise<BluetoothDevice | undefined> {
    const devices = await this.getList()

    if (!opt.id && !opt.name) {
      throw new Error('`DeviceFinder.find` requires either `id` or `name` to be specified')
    }

    if (opt.id) {
      return devices.find((p) => p.id === opt.id)
    }

    const matches = devices.filter((p) => p.name.toLowerCase().includes(opt.name.toLowerCase()))

    if (matches.length === 1) {
      return matches[0]
    }

    const msgs = [`Multiple printers found with name "${opt.name}":`]

    for (const m of matches) msgs.push(` - ${m.name}: ${m.id}`)

    throw new Error(msgs.join('\n'))
  }

  async getDevice(name: string): Promise<Device> {
    const device = await this.find({ name })

    if (!device) {
      throw new FinderError(name, `Could not find device with ID "${name}"`)
    }

    return new Device(device)
  }

  private isValid(name: string): boolean {
    const n = name.toLowerCase()

    return this.PATTERNS.some((p) => n.includes(p))
  }

  private async getBluetooth(deviceFound: BluetoothOptions['deviceFound'], scanTime = 8) {
    if (this.IN_BROWSER) {
      return navigator.bluetooth
    }

    // Node only — load the native webbluetooth binding lazily.
    const { Bluetooth } = await import('webbluetooth')
    return new Bluetooth({ deviceFound, scanTime, allowAllDevices: true })
  }
}

export class FinderError extends Error {
  readonly id: string

  constructor(id: string, message: string) {
    super(message)
    this.id = id
  }
}
