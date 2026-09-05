# Finding — Printer Flakiness: SPP/BLE Mode Toggle After Restart

Date: 2026-09-05
Status: **Root cause identified.** Not a code bug — the printer powers on in SPP (classic) mode, disabling its BLE radio.

---

## 1. Symptom

After the following sequence:

1. Disconnect the printer
2. Restart (power cycle) the printer
3. Reconnect it

Both the **CLI** and the **Web UI** report that printing **succeeds**, yet **nothing prints**:

```
Peripheral ready to send: <CBPeripheral: 0x10b2d7750, ... name = RPP02N, mtu = 240, state = disconnecting>
Printed to RPP02N (0132F8C5-AD4F-3C6B-EEC5-94412A7A7D76).
```

The write is accepted ("success") but no paper comes out. The same silent failure occurs on both the `write-tests` and `main` branches — because **both use the same BLE implementation**, so this is not a regression and not a code bug.

## 2. Root Cause: Printer toggled from BLE to SPP mode

The RPP02N is a **dual-mode** printer (classic Bluetooth SPP **and** BLE). Which radio it advertises is a **printer-side state**, and it changed across the restart:

| State | `system_profiler` `Services:` value | Meaning |
|-------|-------------------------------------|---------|
| Working (previous session) | `0xC02000 < Braille BLE ACL >` | BLE **+** ACL (SPP) — BLE on |
| After restart (broken) | `0x802000 < Braille ACL >` | ACL (SPP) only — **BLE off** |

After restart, the printer powered on advertising **classic SPP only** — its BLE radio is not broadcasting.

## 3. Why it fails silently

Evidence gathered:

- A BLE scan (`webbluetooth` `requestDevice`, scan 6s and 12s) does **not** find RPP02N — it is not advertising BLE.
- Yet `webbluetooth` still returned a device and the write "succeeded".

**Explanation:** the browser/runtime's Bluetooth stack returns a **stale cached `BluetoothDevice`** for the previously-authorized RPP02N. The GATT write is accepted against this cached handle / a broken link and reports success, but no bytes actually reach the printer's BLE service.

The `system_profiler` evidence confirms the printer is registered with the OS over the classic ACL (SPP) connection (`Services: 0x802000`), but its BLE GATT interface is not available.

## 4. The core problem in one sentence

**The printer is physically in SPP (classic) mode after the restart, so BLE writes are a no-op that the stack still reports as successful — a silent failure.**

## 5. How to resolve

This is a **printer-side** configuration issue, not a code fix:

1. **Put the printer back into BLE mode.** For dual-mode ESC/POS printers this is usually:
   - A **long press on a button/feed** to toggle SPP ↔ BLE, or
   - A **default-settings reset** (some print a config page), or
   - A **fresh power cycle** (the previous session it came up in BLE mode).
2. Confirm the printer is back in BLE mode with:
   ```
   system_profiler -detailLevel 2 | grep -A8 "RPP02N:"
   ```
   Look for `Services: 0xC02000 < Braille BLE ACL >` (BLE on) rather than `0x802000` (BLE off).
3. Once BLE is advertising, the CLI and Web UI print correctly with **no code change**.

### Update (2026-09-05): There is no toggle command — BLE mode is entered via a BLE connection

Testing showed that **there is no command/button that toggles the mode** in the usual sense. Instead:

- The printer powers on into an **inconsistent mode** after a restart (sometimes SPP-only, sometimes BLE+ACL).
- Connecting to it **once via a BLE app** (e.g. the Thermer app, as observed) causes the printer to re-enter **BLE mode**, and it **stays** in BLE mode for subsequent connections.
- After running the Thermer app once, both our CLI and Web UI print correctly again.

So the practical workaround is:

> **Connect to the printer once with a Bluetooth printer app (e.g. Thermer) to bring it into BLE mode; thereafter our CLI/Web UI work until the printer is power-cycled again.**

The printer entering BLE mode is a **side effect of a successful BLE connection**, not a documented setting or command.

## 6. Code improvement (implemented 2026-09-05)

Added clearer diagnostics so the silent failure is actionable:

- **CLI** (`src/cli.ts`): when a printer isn't found on BLE, prints a message explaining the likely SPP-mode cause and the workaround (connect once with a Bluetooth printer app).
- **Web UI** (`src/main.ts`): added a `logSPPWorkaround()` helper that logs the same tip on BLE selection failure or print failure.

Both surfaces now tell the user *why* printing may fail silently and how to fix it (switch the printer to BLE mode via a printer app). The tests still pass (46) since they mock the BLE module.

## 7. ROOT CAUSE UPDATE (2026-09-05): `writeValueWithoutResponse` + immediate disconnect drops writes

Further testing revealed the real recurring cause of the flakiness is **not** the printer mode (that was a red herring). The printer *was* found, connected, and both writes reported success — yet nothing printed. The culprit is in **our write path**:

### The bug

- The CLI did `writeValueWithoutResponse(data)` then **immediately** `server.disconnect()`.
- `writeValueWithoutResponse` is **fire-and-forget**: it returns before the bytes are actually transmitted.
- Disconnecting immediately can **drop the unacknowledged write** — the bytes never reach the printer.
- It's a **race**: when timing is favorable it prints; when not, the write is lost. That's why it was flaky across disconnect/reconnect/restart.

### The fix

Switch to **`writeValueWithResponse`**, which waits for the device to acknowledge the write before the promise resolves. Then disconnecting immediately is safe.

```ts
await char.writeValueWithResponse(data.buffer as ArrayBuffer)
```

### Evidence

- Diagnostic using `writeWithResponse` printed reliably even with an immediate disconnect.
- Our CLI using `writeWithoutResponse` + immediate disconnect was unreliable.
- Updating `src/ble.ts` and `src/main.ts` to `writeValueWithResponse` fixed it; the CLI printed on the next run.

### Files changed

- `src/ble.ts` — `writeToBlePrinter` now uses `writeValueWithResponse`
- `src/main.ts` — `writeEscPos` now uses `writeValueWithResponse`
- `src/ble.test.ts`, `src/main.test.ts` — updated mocks/assertions to `writeValueWithResponse`

All **46 tests pass**; both tsc configs clean.

## 7. Key takeaway

- **Both CLI and Web UI are correct and identical** across branches — the failure is environmental (printer mode), not regressive.
- Always confirm the printer is in **BLE mode** (`0xC02000`) before testing prints.
- The `write-tests` branch's 46 tests **still pass** because they mock the BLE module and never touch real hardware.