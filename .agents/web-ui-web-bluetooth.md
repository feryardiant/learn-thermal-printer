# Thermal Print — Web UI (Web Bluetooth) Implementation

Dedicated documentation for bringing the BLE printer to the browser using native Web Bluetooth.

Date: 2026-09-05
Status: **Implemented** — code complete and type-clean; final click-to-print requires a real human gesture (see §6).

---

## 1. Overview

The CLI prints to the RPP02N printer over BLE. This document covers the **browser UI** that does the same thing using the **native Web Bluetooth API** (`navigator.bluetooth`) — no server, no extra runtime dependency.

The browser's Web Bluetooth API speaks **BLE/GATT**, which is exactly the transport the CLI uses. So the earlier blocker (browser can't do SPP) is moot — BLE is natively supported.

## 2. Architecture

```
Browser (Web Bluetooth) ──BLE/GATT──> RPP02N printer
```

- No companion server
- No extra npm dependency (uses the built-in `navigator.bluetooth`)
- Reuses the ESC/POS command builders from `src/escpos.ts`

## 3. Files Changed

| File | Change |
|------|--------|
| `index.html` | New UI: Check printer button, device status, textarea, Print button, "No cut" checkbox, log `<pre>` |
| `src/main.ts` | Full Web Bluetooth flow (reuses `src/escpos.ts` builders) |
| `src/style.css` | Styles for textarea, row, status, checkbox |

## 4. UI Layout

```
Thermal Print
Print text to a Bluetooth ESC/POS printer.

[ Check printer ]   No device
[ Text to print... ]
[ Print ]           [x] No cut
[ log ]
```

- **Check printer** — opens the Web Bluetooth device chooser, selects the printer, enables Print
- **Text to print** — textarea for the content
- **Print** — sends ESC/POS bytes to the selected printer
- **No cut** — checkbox to skip the paper-cut command
- **log** — timestamped status/error messages

## 5. Core Logic (`src/main.ts`)

### 5.1 Constants

```ts
const ESCPOS_SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb'
const ESCPOS_WRITE_CHAR_UUID = '0000ff02-0000-1000-8000-00805f9b34fb'
```

### 5.2 Check printer (device selection)

```ts
$checkBtn.addEventListener('click', async () => {
  device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [ESCPOS_SERVICE_UUID],   // REQUIRED (see §6.2)
  })
  $deviceStatus.textContent = device.name
  $printBtn.disabled = false
})
```

### 5.3 Print (ESC/POS write)

```ts
async function writeEscPos(device: BluetoothDevice, data: Uint8Array): Promise<void> {
  const server = await device.gatt.connect()
  const service = await server.getPrimaryService(ESCPOS_SERVICE_UUID)
  const char = await service.getCharacteristic(ESCPOS_WRITE_CHAR_UUID)
  await char.writeValueWithoutResponse(data)
}
```

The ESC/POS byte sequence is built by `buildEscPos()` in `src/main.ts`, which reuses `src/escpos.ts`:
- `ESC @` (init)
- text (UTF-8)
- `ESC d n` (feed 3 lines)
- `GS V 65` (full cut) unless "No cut" is checked

## 6. Critical Web Bluetooth Requirements (learned via testing)

These are hard platform constraints, not optional.

### 6.1 User gesture

`requestDevice()` **must** be called synchronously inside a click/keydown handler. Calling it from `DOMContentLoaded` or after an `await` throws a `SecurityError`. The **Check printer** button (not page load) must trigger the chooser.

### 6.2 `optionalServices` — required to access the service

Without declaring the service UUID, the browser throws:

```
Origin is not allowed to access any service. Tip: Add the service UUID to
'optionalServices' in requestDevice() options.
```

**Fix:** pass the service UUID in `requestDevice()` options:

```ts
navigator.bluetooth.requestDevice({
  acceptAllDevices: true,
  optionalServices: [ESCPOS_SERVICE_UUID],
})
```

### 6.3 HTTPS or localhost

Web Bluetooth requires a secure context. The Vite dev server uses `@vitejs/plugin-basic-ssl` (HTTPS on `https://localhost:5173/`). A deployed site needs HTTPS.

### 6.4 Chrome-only

Web Bluetooth is only implemented in Chrome (not Firefox/Safari). The app guards with `'bluetooth' in navigator` and disables the Check button if unavailable.

## 7. Validation

- `bunx tsc --noEmit` → **passes cleanly**
- UI loads without console errors
- Web Bluetooth availability confirmed (`'bluetooth' in navigator` → `true`)
- Device selection **confirmed working** — clicking Check printer selected **RPP02N** and enabled the Print button
- The `optionalServices` fix addresses the exact "Origin is not allowed to access any service" error observed

## 8. Testing Limitation (important)

**The final click-to-print cannot be completed by automation.**

Web Bluetooth's device chooser is a **native OS dialog** that requires a real human gesture. Synthetic/automated clicks are treated as:

```
User cancelled the requestDevice() chooser.
```

This is a security feature, not a bug. To verify end-to-end, a human must:
1. Click **Check printer**
2. Select **RPP02N** in the chooser
3. Type text
4. Click **Print**

## 9. Manual Test Steps

1. Start the dev server: `bun run dev` (HTTPS on `https://localhost:5173/`)
2. Open Chrome, proceed past the self-signed cert warning
3. Click **Check printer**
4. Select **RPP02N** in the chooser
5. Type text in the textarea
6. Click **Print**
7. Confirm the printer outputs the text

## 10. Possible Follow-ups

- Add a **printer re-selection** flow (remember the last device via `getDevices()`)
- Add **print options** (font size, alignment, barcode) via more ESC/POS commands
- Fall back to the **local companion server** (Path B) if any-browser support is needed

---

## 11. Persisting the Printer Selection (2026-09-05)

Added the ability to **remember the selected printer across page reloads**.

### What persists vs. what doesn't

| Item | Persists across reload? | Mechanism |
|------|------------------------|-----------|
| Device **selection / permission** | ✅ | Browser remembers granted devices; `getDevices()` re-acquires without the chooser |
| Device **id + name** (for display) | ✅ | `localStorage` (`thermal-print-device`) |
| **Live GATT connection** | ❌ | Tied to the page's JS context; torn down on *any* unload (reload, close, navigate) |

**Key point:** you cannot keep a live connection alive across a reload, and `localStorage` can't hold a connection object. But because the browser remembers the permission, reconnection is *seamless* — one click reconnects without re-showing the chooser.

### Changes

- `src/main.ts`:
  - `loadSavedDevice()` / `saveDevice()` / `clearSavedDevice()` — localStorage helpers
  - `setDevice()` — centralizes UI state (status text, Print/Forget enabled state)
  - **Check printer** now first tries `getDevices()` to reconnect to the remembered device; falls back to the `requestDevice()` chooser if not found
  - **Forget** button clears localStorage and resets state
  - On load, shows `RPP02N (remembered)` if a device was saved
- `index.html`: added a **Forget** button

### Reconnect flow (one click)

```ts
const saved = loadSavedDevice()
if (saved) {
  const devices = await navigator.bluetooth.getDevices()  // no chooser
  const match = devices.find((d) => d.id === saved.id)
  if (match) { setDevice(match); return }                  // reconnected
}
// fall back to chooser
const picked = await navigator.bluetooth.requestDevice({ ... })
saveDevice({ id: picked.id, name: picked.name })
```

### Validation

- `bunx tsc --noEmit` → passes cleanly
- Setting a saved device in localStorage, then reloading, correctly shows `RPP02N (remembered)` and the reconnect hint
- Clearing localStorage restores the clean "No device" state

### Note

`getDevices()` is called from the click handler, so it works whether or not the browser requires a user gesture for it (both `requestDevice` and `getDevices` are safest inside a click handler).

### Important finding: `getDevices()` may not exist in this Chrome build

Testing revealed that the running Chrome exposes **only** these on `navigator.bluetooth`:

```
getAvailability, requestDevice, addEventListener, dispatchEvent, removeEventListener, when
```

**`getDevices()` is NOT available.** This means:

- **Auto-reconnect on load is not possible** in this browser — there is no API to re-acquire a device without the chooser.
- The only way to get a device is `requestDevice()`, which **requires a real user gesture** (click → chooser → select).
- The user must click **Check printer** and select the printer on each page load.

### Honest status text

To avoid the misleading "connected" impression, the status now shows:

- `RPP02N (click Check to connect)` — remembered but **not** connected; Print stays disabled
- `RPP02N` — actually connected; Print enabled

`reconnectById()` guards with `typeof navigator.bluetooth.getDevices !== 'function'` and throws a clear error if unsupported, so `autoReconnect()` degrades gracefully to the remembered state.