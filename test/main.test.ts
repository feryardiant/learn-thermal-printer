// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// main.ts (in src/) imports './style.css'; replace it with an empty module.
vi.mock('../src/style.css', () => ({}))

// main.ts uses DeviceFinder / Device from printer.ts.
const printer = vi.hoisted(() => ({
  getList: vi.fn(),
  find: vi.fn(),
  send: vi.fn(),
}))

vi.mock('../src/printer.ts', () => ({
  DeviceFinder: class {
    getList = printer.getList
    find = printer.find
  },
  Device: class {
    private bt: { id: string; name?: string }
    constructor(bt: { id: string; name?: string }) {
      this.bt = bt
    }
    get id() {
      return this.bt.id
    }
    get name() {
      return this.bt.name ?? 'Unknown device'
    }
    send = printer.send
  },
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

const BT_DEVICE = { id: 'dev-1', name: 'RPP02N' }

function setupDom(): void {
  document.body.innerHTML = HTML
}

function setupBluetooth(): void {
  Object.defineProperty(navigator, 'bluetooth', {
    value: { requestDevice: vi.fn(), getDevices: vi.fn(), getAvailability: vi.fn() },
    configurable: true,
  })
}

function removeBluetooth(): void {
  Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true })
  delete (navigator as unknown as Record<string, unknown>).bluetooth
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
  printer.getList.mockReset()
  printer.find.mockReset()
  printer.send.mockReset()
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

  it('auto-reconnects when find returns the saved device', async () => {
    localStorage.setItem('thermal-print-device', JSON.stringify({ id: 'dev-1', name: 'RPP02N' }))
    setupBluetooth()
    printer.find.mockResolvedValue(BT_DEVICE)
    await loadMain()
    dispatchReady()
    await flush()

    expect(status()).toBe('RPP02N')
    expect(btn('#print-btn').hasAttribute('disabled')).toBe(false)
    expect(logText()).toContain('Auto-reconnected')
  })
})

describe('check printer', () => {
  it('scans and selects a device, then saves it', async () => {
    setupBluetooth()
    printer.getList.mockResolvedValue([BT_DEVICE])
    await loadMain()

    btn('#check-btn').click()
    await flush()

    expect(status()).toBe('RPP02N')
    expect(btn('#print-btn').hasAttribute('disabled')).toBe(false)
    expect(localStorage.getItem('thermal-print-device')).toContain('dev-1')
  })

  it('falls back to scanning when the saved device is gone', async () => {
    localStorage.setItem('thermal-print-device', JSON.stringify({ id: 'gone', name: 'Old' }))
    setupBluetooth()
    printer.find.mockResolvedValue(undefined)
    printer.getList.mockResolvedValue([BT_DEVICE])
    await loadMain()

    btn('#check-btn').click()
    await flush()

    expect(printer.getList).toHaveBeenCalledOnce()
    expect(status()).toBe('RPP02N')
  })
})

describe('print', () => {
  it('calls Device.send and logs success', async () => {
    setupBluetooth()
    printer.getList.mockResolvedValue([BT_DEVICE])
    printer.send.mockResolvedValue(undefined)
    await loadMain()

    btn('#check-btn').click()
    await flush()

    textarea('#text-input').value = 'Hi'
    btn('#print-btn').click()
    await flush()

    expect(printer.send).toHaveBeenCalledOnce()
    expect(printer.send).toHaveBeenCalledWith('Hi', true, 3)
    expect(logText()).toContain('Printed 2 chars')
  })

  it('does nothing when no device is selected', async () => {
    setupBluetooth()
    await loadMain()
    btn('#print-btn').click()
    await flush()
    expect(printer.send).not.toHaveBeenCalled()
  })
})

describe('forget', () => {
  it('clears the saved device and resets state', async () => {
    setupBluetooth()
    printer.getList.mockResolvedValue([BT_DEVICE])
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