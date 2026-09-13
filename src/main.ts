import './style.css'
import { DeviceFinder, Device } from './printer.ts'
import { SAMPLES } from './samples.ts'
import type { Sample } from './samples.ts'

const $checkBtn = document.querySelector<HTMLButtonElement>('#check-btn')!
const $printBtn = document.querySelector<HTMLButtonElement>('#print-btn')!
const $deviceStatus = document.querySelector<HTMLElement>('#device-status')!
const $textInput = document.querySelector<HTMLTextAreaElement>('#text-input')!
const $noCut = document.querySelector<HTMLInputElement>('#no-cut')!
const $sampleGrid = document.querySelector<HTMLElement>('#sample-grid')!
const $log = document.querySelector<HTMLPreElement>('#log')!

let device: Device | undefined

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
  } else {
    $deviceStatus.textContent = 'No device'
    $printBtn.disabled = true
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
    log(`Selected: ${picked.name}`)
  } catch (err) {
    setDevice(undefined)
    log(`Selection failed: ${(err as Error).message}`)
  }
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

/**
 * Render a ReceiptLine document to an SVG preview string via the receiptline
 * global (loaded by the <script> tag). Uses the same cpl as printing so the
 * preview matches the printed width. Returns an empty string if unavailable.
 */
function renderSvg(doc: string): string {
  const rl = globalThis.receiptline
  if (typeof rl?.transform !== 'function') return ''
  return rl.transform(doc, { command: 'svg', cpl: 32 })
}

/**
 * Build a selectable sample card: an SVG preview plus a label. Clicking it
 * fills the editor with the sample's original ReceiptLine markup.
 */
function renderSampleCard(sample: Sample, text: string): HTMLElement {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'sample-card'
  card.dataset.sampleId = sample.id
  card.setAttribute('aria-label', `Load ${sample.label} sample`)

  const preview = document.createElement('div')
  preview.className = 'sample-preview'
  preview.innerHTML = renderSvg(text)

  const label = document.createElement('span')
  label.className = 'sample-label'
  label.textContent = sample.label

  card.append(preview, label)
  card.addEventListener('click', () => selectSample(sample, text, card))
  return card
}

/** Fill the editor with a sample and mark its card as selected. */
function selectSample(sample: Sample, text: string, card: HTMLElement): void {
  $textInput.value = text
  const selected = document.querySelectorAll<HTMLElement>('.sample-card.selected')
  for (let i = 0; i < selected.length; i++) {
    selected[i].classList.remove('selected')
  }
  card.classList.add('selected')
  log(`Loaded sample: ${sample.label}`)
}

/** Preload every sample, render its SVG preview, and add it to the grid. */
async function loadSamples(): Promise<void> {
  for (const sample of SAMPLES) {
    try {
      const res = await fetch(sample.path)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      $sampleGrid.appendChild(renderSampleCard(sample, text))
    } catch (err) {
      log(`Failed to load sample ${sample.label}: ${(err as Error).message}`)
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void loadSamples()

  if (!bluetoothSupported()) {
    log('Web Bluetooth is not available in this browser.')
    $checkBtn.disabled = true
    return
  }

  log('Web Bluetooth ready. Click "Check printer" to select a device.')
})
