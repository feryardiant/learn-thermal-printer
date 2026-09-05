import './style.css'
import { init, encodeText, feedLines, cut, concat, interpretEscapes } from './escpos.ts'

/** ESC/POS printers commonly expose their write characteristic under this service. */
const ESCPOS_SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb'
/** The write characteristic used to send ESC/POS data. */
const ESCPOS_WRITE_CHAR_UUID = '0000ff02-0000-1000-8000-00805f9b34fb'

const $checkBtn = document.querySelector<HTMLButtonElement>('#check-btn')!
const $printBtn = document.querySelector<HTMLButtonElement>('#print-btn')!
const $forgetBtn = document.querySelector<HTMLButtonElement>('#forget-btn')!
const $deviceStatus = document.querySelector<HTMLElement>('#device-status')!
const $textInput = document.querySelector<HTMLTextAreaElement>('#text-input')!
const $noCut = document.querySelector<HTMLInputElement>('#no-cut')!
const $log = document.querySelector<HTMLPreElement>('#log')!

let device: BluetoothDevice | undefined

/** localStorage key for the last-selected printer. */
const STORAGE_KEY = 'thermal-print-device'

interface SavedDevice {
  id: string
  name: string
}

function loadSavedDevice(): SavedDevice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SavedDevice) : null
  } catch {
    return null
  }
}

function saveDevice(d: SavedDevice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d))
  } catch {
    // ignore storage errors
  }
}

function clearSavedDevice(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore storage errors
  }
}

function log(msg: string): void {
  $log.textContent = `${new Date().toLocaleTimeString()} ${msg}\n${$log.textContent ?? ''}`
}

function bluetoothSupported(): boolean {
  return 'bluetooth' in navigator
}

/**
 * Explain the likely SPP-mode situation when BLE selection fails or a print
 * targets a printer that isn't advertising BLE.
 */
function logSPPWorkaround(): void {
  log('Tip: If the printer is paired but not found/printing, it may be in SPP')
  log('(classic) mode, not advertising BLE. Connect to it once with a Bluetooth')
  log('printer app to switch it to BLE mode, then retry.')
}

function setDevice(d: BluetoothDevice | undefined): void {
  device = d
  if (d) {
    $deviceStatus.textContent = d.name ?? 'Unknown device'
    $printBtn.disabled = false
    $forgetBtn.disabled = false
  } else {
    $deviceStatus.textContent = 'No device'
    $printBtn.disabled = true
    $forgetBtn.disabled = true
  }
}

/** Show a remembered-but-not-yet-connected printer in the status. */
function showRemembered(name: string): void {
  $deviceStatus.textContent = `${name} (click Check to connect)`
  $printBtn.disabled = true
  $forgetBtn.disabled = false
}

/**
 * Reconnect to a previously-authorized device by id, without the chooser.
 * Returns the device if found, otherwise null.
 */
async function reconnectById(id: string): Promise<BluetoothDevice | null> {
  // Some Chrome builds don't expose getDevices(); in that case we can't
  // re-acquire a device without the chooser.
  if (typeof navigator.bluetooth.getDevices !== 'function') {
    throw new Error('getDevices() is not supported in this browser')
  }
  const devices = await navigator.bluetooth.getDevices()
  return devices.find((d) => d.id === id) ?? null
}

/**
 * Try to auto-reconnect to the saved printer on page load.
 * `getDevices()` + `gatt.connect()` may require a user gesture in some
 * browsers; if so, we fall back to showing the remembered state.
 */
async function autoReconnect(): Promise<void> {
  const saved = loadSavedDevice()
  if (!saved) return

  try {
    const match = await reconnectById(saved.id)
    if (match) {
      setDevice(match)
      log(`Auto-reconnected to ${match.name}.`)
    } else {
      showRemembered(saved.name)
      log(`Remembered printer "${saved.name}" not found. Click "Check printer".`)
    }
  } catch (err) {
    // Likely requires a user gesture; keep the remembered state.
    showRemembered(saved.name)
    log(`Auto-reconnect needs a click: ${(err as Error).message}`)
  }
}

$checkBtn.addEventListener('click', async () => {
  if (!bluetoothSupported()) {
    log('Web Bluetooth is not available in this browser.')
    return
  }

  // If we remember a printer, try to reconnect to it without the chooser.
  const saved = loadSavedDevice()
  if (saved) {
    try {
      const match = await reconnectById(saved.id)
      if (match) {
        setDevice(match)
        log(`Reconnected to ${match.name}.`)
        return
      }
      log(`Remembered printer "${saved.name}" not found; opening chooser.`)
    } catch (err) {
      log(`Reconnect failed: ${(err as Error).message}`)
    }
  }

  try {
    // Must be called synchronously within the click handler (user gesture).
    const picked = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [ESCPOS_SERVICE_UUID],
    })
    setDevice(picked)
    saveDevice({ id: picked.id, name: picked.name ?? 'Unknown device' })
    log(`Selected: ${picked.name}`)
  } catch (err) {
    setDevice(undefined)
    log(`Selection failed: ${(err as Error).message}`)
    logSPPWorkaround()
  }
})

$forgetBtn.addEventListener('click', () => {
  clearSavedDevice()
  setDevice(undefined)
  log('Forgot saved printer.')
})

$printBtn.addEventListener('click', async () => {
  if (!device) return

  const text = $textInput.value
  if (!text.trim()) {
    log('Enter some text to print.')
    return
  }

  try {
    const data = buildEscPos(text, { feed: 3, noCut: $noCut.checked })
    await writeEscPos(device, data)
    log(`Printed ${text.length} chars to ${device.name}.`)
  } catch (err) {
    log(`Print failed: ${(err as Error).message}`)
    logSPPWorkaround()
  }
})

/** Build the ESC/POS byte sequence for a print job. */
function buildEscPos(text: string, opts: { feed: number; noCut: boolean }): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from(init())]
  parts.push(encodeText(interpretEscapes(text)))
  parts.push(Uint8Array.from(feedLines(opts.feed)))
  if (!opts.noCut) parts.push(Uint8Array.from(cut('full')))
  return concat(parts)
}

/** Connect to the device's GATT server and write ESC/POS bytes. */
async function writeEscPos(device: BluetoothDevice, data: Uint8Array): Promise<void> {
  if (!device.gatt) {
    throw new Error('Device has no GATT server.')
  }
  const server = await device.gatt.connect()
  try {
    const service = await server.getPrimaryService(ESCPOS_SERVICE_UUID)
    if (!service) {
      throw new Error(`Device does not expose ESC/POS service ${ESCPOS_SERVICE_UUID}`)
    }
    const char = await service.getCharacteristic(ESCPOS_WRITE_CHAR_UUID)
    if (!char) {
      throw new Error(`Device does not expose write characteristic ${ESCPOS_WRITE_CHAR_UUID}`)
    }
    await char.writeValueWithResponse(data.buffer as ArrayBuffer)
  } finally {
    try {
      server.disconnect()
    } catch {
      // ignore disconnect errors
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!bluetoothSupported()) {
    log('Web Bluetooth is not available in this browser.')
    $checkBtn.disabled = true
    return
  }

  if (loadSavedDevice()) {
    void autoReconnect()
  } else {
    log('Web Bluetooth ready. Click "Check printer" to select a device.')
  }
})
