// webbluetooth is a Node-only native module. Import only its types statically
// (erased at runtime) so this module stays browser-safe; the value is loaded
// dynamically in the Node (CLI) path only.
import type { BluetoothOptions } from 'webbluetooth'
// receiptline is Node-oriented (pulls in buffer/util/pngjs). It is imported
// lazily inside encode() and used in Node (CLI). In the browser, where those
// Node built-ins aren't polyfilled, we fall back to building ESC/POS bytes
// directly.

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
   * Chunks the data into MTU-sized writes, sending each chunk as its own
   * exact-size buffer. We use `writeValueWithResponse` for reliability; the key
   * detail is copying each chunk via `.slice().buffer` — webbluetooth reads
   * `value.buffer` verbatim (ignoring byteOffset), so passing a subarray view
   * would send the whole buffer and duplicate the print.
   */
  async send(doc: string, cutting: boolean = true, feed = 3) {
    const server = await this.connect()

    const char = await this.getCharacteristic(server)
    const bytes = await this.encode(doc, cutting, feed)

    // Let the BLE link settle before streaming writes.
    await new Promise((r) => setTimeout(r, 500))

    // BLE ATT limits each write to (MTU - 3) bytes. Chunk larger payloads and
    // pace them so the printer can process each chunk.
    const CHUNK = 237 // MTU 240 minus the 3-byte ATT header
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, bytes.length)
      const chunk = bytes.slice(offset, end).buffer // .slice copies → exact buffer
      await char.writeValueWithResponse(chunk)
      if (end < bytes.length) {
        // Small inter-chunk delay so the printer isn't overwhelmed.
        await new Promise((r) => setTimeout(r, 20))
      }
    }

    // Give the printer a moment to finish processing before disconnecting.
    await new Promise((r) => setTimeout(r, 500))

    server.disconnect()
  }

  async encode(doc: string, cutting: boolean = true, feed = 1): Promise<Uint8Array<ArrayBuffer>> {
    let data: string
    try {
      // Prefer receiptline (full ReceiptLine document support). This works in
      // Node (CLI). In the browser its Node-built-in deps aren't polyfilled, so
      // the dynamic import throws and we fall back to a direct builder below.
      const { default: receiptline } = await import('receiptline')
      data = receiptline.transform(doc, {
        cpl: 32,
        encoding: 'multilingual',
        command: 'escpos',
        cutting,
      })
    } catch {
      // Browser fallback: build a minimal ESC/POS stream (init + text + feed [+ cut]).
      return this.encodePlain(doc, cutting, feed)
    }

    // Convert receiptline's binary-string output (one char = one byte, 0–255)
    // into a Uint8Array, preserving raw bytes >127. Grow by 3 to prepend the feed
    // without overwriting the document's first bytes (init command / header).
    const buffer = new Uint8Array(data.length + 3)
    for (let i = 0; i < data.length; i++) {
      buffer[i + 3] = data.charCodeAt(i) & 0xff
    }

    // Prepend `ESC d feed` — advance the paper below the content before the cut.
    buffer.set(Uint8Array.from([0x1b, 0x64, feed & 0xff]), 0)

    return buffer
  }

  /**
   * Browser-safe minimal ESC/POS builder for text docs (no receiptline needed).
   * Emits: ESC @ (init) + text + ESC d n (feed) [+ GS V 66 (partial cut)].
   */
  private encodePlain(doc: string, cutting: boolean, feed: number): Uint8Array<ArrayBuffer> {
    const body = new TextEncoder().encode(doc.replace(/\r/g, ''))
    const cut = cutting ? [0x1d, 0x56, 0x42] : [] // GS V 66 (partial cut)
    // layout: ESC @ (2) + body + ESC d n (3) [+ cut]
    const out = new Uint8Array(2 + body.length + 3 + cut.length)
    let o = 0
    out.set([0x1b, 0x40], o); o += 2 // ESC @ init
    out.set(body, o); o += body.length
    out.set([0x1b, 0x64, feed & 0xff], o); o += 3 // ESC d n feed
    out.set(cut, o) // optional cut
    return out
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
      const picked = await bt.requestDevice({
        acceptAllDevices: true,
        optionalServices: [ESCPOS.SERVICE_UUID]
      })

      // In the browser, `navigator.bluetooth.requestDevice` opens a chooser and
      // returns ONE device (it does not invoke the deviceFound callback used by
      // the Node `webbluetooth` binding). Use the returned device directly.
      if (this.IN_BROWSER && picked && picked.name && this.isValid(picked.name)) {
        found.push(picked)
      }
    } catch {
      // Scan completed, timed out, or the chooser was cancelled
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

    const needle = (opt.name ?? '').toLowerCase()
    const matches = devices.filter((p) => (p.name ?? '').toLowerCase().includes(needle))

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
