// webbluetooth is a Node-only native module. Import only its types statically
// (erased at runtime) so this module stays browser-safe; the value is loaded
// dynamically in the Node (CLI) path only.
import type { Printer as TransformOpts } from 'receiptline'

interface RuleBarOptions {
  /** Half-height blank lines (ESC J partial feeds) above and below. */
  padding: number
}

export interface ReceiptlineImpl {
  transform(doc: string, opts: TransformOpts): string
}

/**
 * Build a full-width solid bar as a `GS v 0` raster strip.
 */
function buildRuleBar(opts: RuleBarOptions = { padding: 1 }): string {
  // cpl=32 chars × 12 dots/char = 384 dots wide → 48 bytes/row.
  const bytesPerRow = 48
  const height = 4 // dots tall — a clearly visible line
  const data = '\\xff'.repeat(bytesPerRow * height)

  // ESC J n: print-and-feed n/180". 15 ≈ half of the default 1/6" (30/180) line,
  // so the padding is half-height instead of a full LF. The trailing feed also
  // clears the 4-dot raster bar, so no extra LF is needed after it.
  const padding = '\\x1bJ\\x0f'

  // GS v 0 m xL xH yL yH d1...dk
  return (
    padding.repeat(opts.padding) + // half-height blank above the bar
    '\\x1dv0\\x00' + // GS v 0, m=0 (normal)
    '\\x30\\x00' + // xL=48, xH=0 (width in bytes)
    '\\x04\\x00' + // yL=4, yH=0 (height in dots)
    data +
    padding.repeat(opts.padding) // half-height blank below (also clears the bar)
  )
}

/**
 * ReceiptLine's built-in horizontal rule (a bare `-` line) fills the row with
 * byte 0x95, which the RPP02N's default code page renders as `ò` rather than a
 * line. Rewrite bare-dash lines into a raw `{x:...}` ESC/POS command that emits
 * a full-width `GS v 0` raster bar — a true solid line on any thermal printer,
 * independent of the printer's font/code page. The `command` property passes raw
 * bytes, so this needs no PNG decoding and works in the browser path too.
 */
export function solidRuleLines(doc: string): string {
  // A horizontal-rule line for the RPP02N. ReceiptLine's built-in `-` rule fills
  // the row with byte 0x95, which this printer renders as `ò`; a bare CP437 bar
  // (0xc4) renders blank because the printer's default multibyte page doesn't know
  // it. The font-independent way to draw a solid line is a `GS v 0` raster strip —
  // the same command receiptline uses for QR codes, which the RPP02N honors. We
  // rewrite bare-dash lines into a raw `{x:...}` command that emits a full-width
  // all-black raster bar.
  const RULE_BAR = buildRuleBar()

  return doc.replace(/^[\t ]*-+[\t ]*$/gm, `{x:${RULE_BAR}}`)
}

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
    // Resolve the receiptline API: in the browser it's a global script
    // (window.receiptline, loaded via <script src="/receiptline.js">); in Node
    // (CLI) it's an ESM import. Both expose { transform }.
    const receiptline = await this.getReceiptline()
    let data: string

    if (receiptline) {
      // The cut is emitted manually below so we can advance (feed) the paper
      // below the last line — including a trailing QR raster — before cutting.
      // ReceiptLine's built-in cut sits at the very end of the output with no
      // feed after a trailing raster, so a doc ending in a QR got cut through
      // the code. `cutting: false` here keeps the cut out of `data`.
      data = receiptline.transform(solidRuleLines(doc), {
        cpl: 32,
        encoding: 'multilingual',
        // 'generic' emits the universal GS v 0 raster + plain ESC/POS (no Seiko
        // `FS ( A` prelude, no `GS 8 L`), which the RPP02N actually honors. The
        // RPP02N ignores the Seiko-only 'escpos' (_thermal) sequences, which leaked
        // stray bytes ('A0'), printed the QR header as text ('0p01...'), and garbled
        // the stream. 'generic' still supports fonts/sizes/emphasis for text lines.
        command: 'generic',
        // default spacing:false emits `ESC 3 0` (0-dot line spacing), so printed
        // lines touch with no vertical gap. spacing:true emits `ESC 2` (1/6-inch),
        // restoring readable gaps between rows.
        spacing: true,
        cutting: false,
      })
    } else {
      // receiptline is a hard requirement — there is no plain-text fallback. A
      // missing/modified receiptline would otherwise silently print raw markup, so
      // we fail loudly instead.
      throw new Error([
        'receiptline is not available. In the browser ensure /receiptline.js is served;',
        'in the CLI install the receiptline dependency.'
      ].join(' '))
    }

    // Convert receiptline's binary-string output (one char = one byte, 0–255)
    // into a Uint8Array, preserving raw bytes >127.
    const bytes = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) {
      bytes[i] = data.charCodeAt(i) & 0xff
    }

    // `ESC d feed` — advance the paper below the content (so any trailing raster
    // clears the print head) before the cut. `GS V B 00` is the full cut that
    // ReceiptLine's 'generic' command set emits.
    const feedSeq = Uint8Array.from([0x1b, 0x64, feed & 0xff])
    const cutSeq = Uint8Array.from([0x1d, 0x56, 0x42, 0x00])
    const tailLen = feedSeq.length + (cutting ? cutSeq.length : 0)

    const buffer = new Uint8Array(data.length + tailLen)
    buffer.set(bytes, 0)
    buffer.set(feedSeq, data.length)
    if (cutting) buffer.set(cutSeq, data.length + feedSeq.length)

    return buffer
  }

  /**
   * Resolve receiptline's `transform` API across environments:
   * - Browser: global `window.receiptline` (loaded as a script tag).
   * - Node (CLI): lazy ESM `await import('receiptline')`.
   * Returns null if unavailable.
   */
  private async getReceiptline(): Promise<ReceiptlineImpl | null> {
    // Browser global (window.receiptline).
    if (typeof globalThis.receiptline?.transform === 'function') {
      return globalThis.receiptline
    }

    // Node: lazy import.
    try {
      const mod = await import('receiptline')
      const rl = (mod.default ?? mod)
      return rl
    } catch {
      return null
    }
  }

  private async connect() {
    if (!this.device.gatt) {
      throw new FinderError(this.name, 'Device has no GATT server.')
    }

    const server = await this.device.gatt.connect()

    return server
  }

  private async getCharacteristic(server: BluetoothRemoteGATTServer): Promise<BluetoothRemoteGATTCharacteristic> {
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

  private devices: BluetoothDevice[] = []

  async getList(): Promise<BluetoothDevice[]> {
    const bt = await this.getBluetooth()

    if (!this.IN_BROWSER && this.devices.length > 0) {
      return this.devices
    }

    try {
      const picked = await bt.requestDevice({
        acceptAllDevices: true,
        optionalServices: [ESCPOS.SERVICE_UUID]
      })

      // In the browser, `navigator.bluetooth.requestDevice` opens a chooser and
      // returns ONE device (it does not invoke the deviceFound callback used by
      // the Node `webbluetooth` binding). Use the returned device directly.
      if (picked) {
        this.devices.push(picked)
      }
    } catch {
      // Scan completed, timed out, or the chooser was cancelled
    }

    return this.devices
  }

  async find(opt: { id?: string, name?: string }): Promise<BluetoothDevice | undefined> {
    const devices = await this.getList()

    if (!opt.id && !opt.name) {
      throw new Error('`DeviceFinder.find` requires either `id` or `name` to be specified')
    }

    if (opt.id) {
      return devices.find((p) => p.id === opt.id)
    }

    const matches = devices.filter((p) => {
      const toLower = (name?: string) => (name ?? '').toLowerCase()
      return toLower(p.name).includes(toLower(opt.name))
    })

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

  private async getBluetooth(scanTime = 8) {
    if (!this.IN_BROWSER) {
      // Node only — load the native webbluetooth binding lazily.
      const { Bluetooth } = await import('webbluetooth')

      return new Bluetooth({
        allowAllDevices: true,
        deviceFound: (device) => {
          if (!this.isValid(device.name)) {
            return false
          }

          this.devices.push(device)
          return true
        },
        scanTime,
      })
    }

    // Most browsers don't have this method accessible in Chrome its burried under
    // `chrome://flags/#enable-web-bluetooth-new-permissions-backend` flag
    const permittedDevices = await navigator.bluetooth.getDevices?.() || []

    console.debug('permittedDevices', permittedDevices)

    for (const device of permittedDevices) {
      if (this.isValid(device.name)) {
        this.devices.push(device)
      }
    }

    return navigator.bluetooth
  }
}

export class FinderError extends Error {
  readonly id: string

  constructor(id: string, message: string) {
    super(message)
    this.id = id
  }
}
