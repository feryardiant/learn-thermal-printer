import { Bluetooth } from 'webbluetooth'

/** ESC/POS printers commonly expose their write characteristic under this service. */
export const ESCPOS_SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb'
/** The write characteristic used to send ESC/POS data. */
export const ESCPOS_WRITE_CHAR_UUID = '0000ff02-0000-1000-8000-00805f9b34fb'

export interface BlePrinter {
  /** Device name reported by BLE, e.g. `RPP02N`. */
  name: string
  /** Stable BLE device identifier (adapter-assigned). */
  id: string
}

/**
 * Substrings (case-insensitive) that indicate a BLE device is an ESC/POS
 * receipt printer. Matched against the device name.
 */
const PRINTER_PATTERNS = [
  'rpp', 'pos', 'printer', 'thermal', 'receipt', 'escpos', 'esc-pos',
  'tm-', 'sp-', 'epson', 'star', 'bixolon', 'citizen', 'xprinter',
  'apos', 'samsung', 'sii', 'custom', 'rp-',
]

function isPrinterName(name: string): boolean {
  const n = name.toLowerCase()
  return PRINTER_PATTERNS.some((p) => n.includes(p))
}

/**
 * Scan for BLE devices and return those that look like ESC/POS printers.
 * Uses a `deviceFound` hook to auto-select matching printers and stop early.
 */
export async function listBlePrinters(scanTime = 8): Promise<BlePrinter[]> {
  const found: BlePrinter[] = []
  const deviceFound = (device: { name: string; id: string }) => {
    if (isPrinterName(device.name)) {
      found.push({ name: device.name, id: device.id })
      return true // auto-select to stop scanning this device
    }
    return false
  }

  const bt = new Bluetooth({ deviceFound, scanTime })
  try {
    await bt.requestDevice({ acceptAllDevices: true })
  } catch {
    // scan completed or timed out; `found` already populated
  }
  return found
}

/**
 * Connect to a BLE printer and send ESC/POS bytes over its write characteristic.
 * Scans for the printer by id, then writes.
 */
export async function writeToBlePrinter(
  printer: BlePrinter,
  data: Uint8Array,
  scanTime = 8,
): Promise<void> {
  const deviceFound = (device: { name: string; id: string }) => {
    return device.id === printer.id
  }

  const bt = new Bluetooth({ deviceFound, scanTime })
  const device = await bt.requestDevice({ acceptAllDevices: true })
  if (!device) throw new Error(`BLE printer "${printer.name}" not found`)

  const server = await device.gatt.connect()
  try {
    const service = await server.getPrimaryService(ESCPOS_SERVICE_UUID)
    if (!service) {
      throw new Error(`Printer "${printer.name}" does not expose ESC/POS service ${ESCPOS_SERVICE_UUID}`)
    }
    const char = await service.getCharacteristic(ESCPOS_WRITE_CHAR_UUID)
    if (!char) {
      throw new Error(`Printer "${printer.name}" does not expose write characteristic ${ESCPOS_WRITE_CHAR_UUID}`)
    }
    // Use write-with-response so the write is acknowledged before we disconnect.
    // writeValueWithoutResponse is fire-and-forget: if we disconnect immediately
    // after, the bytes can be dropped before reaching the printer (flaky prints).
    await char.writeValueWithResponse(data.buffer as ArrayBuffer)
  } finally {
    try {
      await server.disconnect()
    } catch {
      // ignore disconnect errors
    }
  }
}