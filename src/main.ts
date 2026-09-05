import './style.css'
import { DeviceFinder, Command } from './printer.ts'

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

const finder = new DeviceFinder()

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
    // In the browser this shows the device chooser.
    const picked = await finder.getDevice('', '')
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
    // Write-with-response is used so the write is acknowledged before disconnect.
    await new Command(text, 3, $noCut.checked, 'full').sendTo(device)
    log(`Printed ${text.length} chars to ${device.name}.`)
  } catch (err) {
    log(`Print failed: ${(err as Error).message}`)
    logSPPWorkaround()
  }
})

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
