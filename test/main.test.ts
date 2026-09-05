// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// main.ts (in src/) imports './style.css'; replace it with an empty module.
vi.mock('../src/style.css', () => ({}))

// Shared mocks for the Web Bluetooth API.
const bt = vi.hoisted(() => ({
  requestDevice: vi.fn(),
  getDevices: vi.fn(),
  getAvailability: vi.fn(),
  connect: vi.fn(),
  getPrimaryService: vi.fn(),
  getCharacteristic: vi.fn(),
  writeValueWithResponse: vi.fn(),
  disconnect: vi.fn(),
}))

const HTML = `
  <button id="check-btn">Check printer</button>
  <span id="device-status">No device</span>
  <button id="forget-btn" disabled>Forget</button>
  <textarea id="text-input"></textarea>
  <button id="print-btn" disabled>Print</button>
  <input id="no-cut" type="checkbox">
  <pre id="log"></pre>
`

const DEVICE = { id: 'dev-1', name: 'RPP02N', gatt: { connect: bt.connect } }

function setupDom(): void {
  document.body.innerHTML = HTML
}

function setupBluetooth(overrides: Record<string, unknown> = {}): void {
  const bluetooth = {
    getAvailability: bt.getAvailability,
    requestDevice: bt.requestDevice,
    getDevices: bt.getDevices,
    ...overrides,
  }
  Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true })
}

function removeBluetooth(): void {
  Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true })
  // Actually delete the property so `'bluetooth' in navigator` is false.
  // @ts-expect-error
  delete (navigator as Record<string, unknown>).bluetooth
}

function setupGattSuccess(): void {
  const char = { writeValueWithResponse: bt.writeValueWithResponse }
  const service = { getCharacteristic: bt.getCharacteristic }
  const server = { getPrimaryService: bt.getPrimaryService, disconnect: bt.disconnect }
  bt.connect.mockResolvedValue(server)
  bt.getPrimaryService.mockResolvedValue(service)
  bt.getCharacteristic.mockResolvedValue(char)
  bt.writeValueWithResponse.mockResolvedValue(undefined)
  bt.disconnect.mockResolvedValue(undefined)
}

async function loadMain(): Promise<void> {
  vi.resetModules()
  await import('../src/main.ts')
}

function dispatchReady(): void {
  document.dispatchEvent(new Event('DOMContentLoaded'))
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
}

function status(): string {
  return document.querySelector('#device-status')!.textContent ?? ''
}

function logText(): string {
  return document.querySelector('#log')!.textContent ?? ''
}

function btn(id: string): HTMLButtonElement {
  return document.querySelector(id) as HTMLButtonElement
}

function textarea(id: string): HTMLTextAreaElement {
  return document.querySelector(id) as HTMLTextAreaElement
}

beforeEach(() => {
  setupDom()
  localStorage.clear()
  bt.requestDevice.mockReset()
  bt.getDevices.mockReset()
  bt.getAvailability.mockReset()
  bt.connect.mockReset()
  bt.getPrimaryService.mockReset()
  bt.getCharacteristic.mockReset()
  bt.writeValueWithResponse.mockReset()
  bt.disconnect.mockReset()
})

describe('page load', () => {
  it('shows ready state when bluetooth is supported and no device is saved', async () => {
    setupBluetooth()
    await loadMain()
    dispatchReady()
    await flush()

    expect(status()).toBe('No device')
    expect(logText()).toContain('Web Bluetooth ready')
    expect(btn('#check-btn').hasAttribute('disabled')).toBe(false)
  })

  it('disables Check when bluetooth is unsupported', async () => {
    removeBluetooth()
    await loadMain()
    dispatchReady()
    await flush()

    expect(logText()).toContain('Web Bluetooth is not available')
    expect(btn('#check-btn').hasAttribute('disabled')).toBe(true)
  })

  it('shows remembered state when getDevices is unsupported', async () => {
    localStorage.setItem('thermal-print-device', JSON.stringify({ id: 'dev-1', name: 'RPP02N' }))
    setupBluetooth({ getDevices: undefined })
    await loadMain()
    dispatchReady()
    await flush()

    expect(status()).toContain('RPP02N')
    expect(status()).toContain('click Check to connect')
    expect(btn('#print-btn').hasAttribute('disabled')).toBe(true)
  })

  it('auto-reconnects when getDevices returns the saved device', async () => {
    localStorage.setItem('thermal-print-device', JSON.stringify({ id: 'dev-1', name: 'RPP02N' }))
    setupBluetooth()
    bt.getDevices.mockResolvedValue([DEVICE])
    await loadMain()
    dispatchReady()
    await flush()

    expect(status()).toBe('RPP02N')
    expect(btn('#print-btn').hasAttribute('disabled')).toBe(false)
    expect(logText()).toContain('Auto-reconnected')
  })
})

describe('check printer', () => {
  it('selects a device via the chooser and saves it', async () => {
    setupBluetooth()
    bt.requestDevice.mockResolvedValue(DEVICE)
    await loadMain()

    btn('#check-btn').click()
    await flush()

    expect(status()).toBe('RPP02N')
    expect(btn('#print-btn').hasAttribute('disabled')).toBe(false)
    expect(localStorage.getItem('thermal-print-device')).toContain('dev-1')
  })

  it('reconnects to a saved device without the chooser', async () => {
    localStorage.setItem('thermal-print-device', JSON.stringify({ id: 'dev-1', name: 'RPP02N' }))
    setupBluetooth()
    bt.getDevices.mockResolvedValue([DEVICE])
    await loadMain()

    btn('#check-btn').click()
    await flush()

    expect(status()).toBe('RPP02N')
    expect(bt.requestDevice).not.toHaveBeenCalled()
    expect(logText()).toContain('Reconnected')
  })

  it('falls back to the chooser when the saved device is gone', async () => {
    localStorage.setItem('thermal-print-device', JSON.stringify({ id: 'gone', name: 'Old' }))
    setupBluetooth()
    bt.getDevices.mockResolvedValue([DEVICE])
    bt.requestDevice.mockResolvedValue(DEVICE)
    await loadMain()

    btn('#check-btn').click()
    await flush()

    expect(bt.requestDevice).toHaveBeenCalledOnce()
    expect(status()).toBe('RPP02N')
  })
})

describe('print', () => {
  it('writes ESC/POS bytes and logs success', async () => {
    setupBluetooth()
    setupGattSuccess()
    bt.requestDevice.mockResolvedValue(DEVICE)
    await loadMain()

    btn('#check-btn').click()
    await flush()

    textarea('#text-input').value = 'Hi'
    btn('#print-btn').click()
    await flush()

    expect(bt.writeValueWithResponse).toHaveBeenCalledOnce()
    const arg = bt.writeValueWithResponse.mock.calls[0][0]
    // ESC @ + "Hi" + feed 3 + cut
    expect(Array.from(new Uint8Array(arg))).toEqual([
      0x1b, 0x40, 0x48, 0x69, 0x1b, 0x64, 0x03, 0x1d, 0x56, 0x41,
    ])
    expect(logText()).toContain('Printed 2 chars')
  })

  it('does nothing when no device is selected', async () => {
    setupBluetooth()
    await loadMain()
    btn('#print-btn').click()
    await flush()
    expect(bt.writeValueWithResponse).not.toHaveBeenCalled()
  })
})

describe('forget', () => {
  it('clears the saved device and resets state', async () => {
    setupBluetooth()
    bt.requestDevice.mockResolvedValue(DEVICE)
    await loadMain()

    btn('#check-btn').click()
    await flush()
    expect(localStorage.getItem('thermal-print-device')).toContain('dev-1')

    btn('#forget-btn').click()
    await flush()

    expect(localStorage.getItem('thermal-print-device')).toBeNull()
    expect(status()).toBe('No device')
    expect(btn('#print-btn').hasAttribute('disabled')).toBe(true)
  })
})
