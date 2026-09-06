import './style.css'
import { DeviceFinder, Device } from './printer.ts'

const $checkBtn = document.querySelector<HTMLButtonElement>('#check-btn')!
const $printBtn = document.querySelector<HTMLButtonElement>('#print-btn')!
const $forgetBtn = document.querySelector<HTMLButtonElement>('#forget-btn')!
const $deviceStatus = document.querySelector<HTMLElement>('#device-status')!
const $textInput = document.querySelector<HTMLTextAreaElement>('#text-input')!
const $noCut = document.querySelector<HTMLInputElement>('#no-cut')!
const $log = document.querySelector<HTMLPreElement>('#log')!

let device: Device | undefined

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
  console.info(msg)
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

function setDevice(d: Device | undefined): void {
  device = d
  if (d) {
    $deviceStatus.textContent = d.name
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
 * Returns a Device if found, otherwise null.
 */
async function reconnectById(id: string): Promise<Device | null> {
  const finder = new DeviceFinder()
  const found = await finder.find({ id })
  return found ? new Device(found) : null
}

/**
 * Try to auto-reconnect to the saved printer on page load.
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

  try {
    // Open the device chooser once and select the picked printer.
    // In the browser, `finder.getList()` calls navigator.bluetooth.requestDevice
    // (the chooser) and returns the picked device.
    const list = await finder.getList()
    if (!list.length) {
      log('No ESC/POS printer found.')
      logSPPWorkaround()
      return
    }
    const picked = new Device(list[0])
    setDevice(picked)
    saveDevice({ id: picked.id, name: picked.name })
    log(`Selected: ${picked.name}`)
  } catch (err) {
    setDevice(undefined)
    log(`Selection failed: ${(err as Error).message}`)
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
    // The Device.send pipeline (receiptline + chunked writes) prints the text.
    await device.send(text, !$noCut.checked, 3)
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
