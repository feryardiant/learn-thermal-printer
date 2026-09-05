# Thermal Print — Bluetooth Printer Investigation Findings

Date: 2026-09-05
Status: Investigation complete; decision made to pivot from SPP to BLE.

---

## 1. Goal

Build a CLI that can:
- List available ESC/POS thermal printers (no other serial devices)
- Send text to a printer: `bun src/cli.ts print <printer> "Text"`

## 2. Hardware / Environment

- **Printer**: RPP02N (ESC/POS thermal receipt printer)
  - Bluetooth address: `86:67:7A:B0:10:CF`
  - Vendor ID: `0x05AC`, Product ID: `0x0239`
  - Firmware: `6.4.4`
  - **Baud rate: 115200** (confirmed by user)
  - **Dual-mode**: supports both classic Bluetooth SPP **and** BLE (GATT)
    - `Services: 0xC02000 < Braille BLE ACL >`
- **OS**: macOS (MacBook Air, Apple Silicon / arm64)
- **Runtime**: bun v1.4.0
- **Working reference app**: "Bluetooth Thermal Printer App" (`mate.bluetoothprint`) — prints successfully

## 3. What Works

- Printer **self-test** works (hardware + paper fine)
- The reference app **prints successfully** over Bluetooth
- macOS reports RPP02N as **"Connected"** in System Settings

## 4. What Does NOT Work

- Writing ESC/POS bytes to `/dev/cu.RPP02N` (SPP) produces **no output**
  - Printer LED does **nothing** (bytes never arrive)
  - No response to status queries (`DLE EOT 4`, `GS r`)
- `system_profiler` **hangs** while the SPP port is held open (connection attempt stuck)

## 5. Key Evidence

### 5.1 SPP connection never establishes

Despite macOS UI showing "Connected", the underlying ACL/RFCOMM link is **not up**:

```
"ConnectionHandle" = 0xfff   ← "no active connection" sentinel
"MaxACLPacketSize" = 0x0     ← no live ACL link
```

`bluetoothd` logs show **no RFCOMM connection establishment** for RPP02N.

### 5.2 The working app uses BLE, not SPP

- `lsof -p <app_pid>` shows the app **never opens `/dev/cu.RPP02N`**
- It talks to `bluetoothd` over a **unix socket** (the BLE/GATT API)
- App bundles: `CorePrinter`, `RSBarcodes_Swift`, Google libs — a BLE printer app
- The printer advertises **both** SPP and BLE (`Services: 0xC02000 < Braille BLE ACL >`)

### 5.3 Conclusion

**The printer's SPP channel does not establish a working link from macOS, but its BLE channel does.** The reference app works because it uses BLE. Our CLI used SPP, which is the wrong transport for this printer.

## 6. Serial Port / SPP Findings

- Bluetooth SPP devices appear as `/dev/tty.<name>` and `/dev/cu.<name>` on macOS
- `cu.` = outgoing ("call unit") device — the one to open for writing
- Bluetooth SPP **ignores baud rate** at the RFCOMM level, but the printer still gates on its configured rate (115200)
- Plain file I/O (`node:fs`) can open and write to the device, but data goes nowhere without a live link
- `cu`/`screen` tools fail due to `/var/spool/uucp` lock-file permission (uid 501) — not usable for testing

## 7. Runtime Findings

### 7.1 `serialport` npm package crashes bun

- `bun add serialport` installs `serialport@13.0.0`
- Opening a port panics bun:
  ```
  Bun encountered a crash when running a NAPI module that tried to call
  the uv_default_loop libuv function.
  panic(main thread): unsupported uv function: uv_default_loop
  ```
- Known issue: oven-sh/bun#18546
- **Workaround**: use plain file I/O for SPP writes, or run under Node instead of bun

### 7.2 bun sandbox quirks

- bun cannot write to the sandbox temp dir (`EPERM`); workaround: set `TMPDIR`/`BUN_INSTALL_CACHE_DIR` to a project dir
- `fd.read()` on a serial device does **not** unblock when the fd is closed — use a subprocess with a hard timeout for reads

## 8. Current CLI State

Files created:
- `src/cli.ts` — arg parsing, `list` / `print` commands
- `src/serial.ts` — SPP enumeration + write (now obsolete for this printer)
- `src/escpos.ts` — ESC/POS command builders (init, text, feed, cut)

The SPP-based `serial.ts` is **obsolete** for this printer and will be replaced by a BLE implementation.

## 9. Decision: Pivot to BLE

- **Option A (chosen)**: Rewrite the CLI to connect via the printer's **BLE GATT** service and send ESC/POS bytes over its write characteristic.
- This matches the working reference app.
- `list` will enumerate **BLE** printers instead of scanning `/dev`.

### Open items for BLE implementation
1. Find a BLE library that works under bun (or run under Node)
2. Discover the printer's GATT service/characteristic UUIDs (probe them)
3. Rewrite `print` to write ESC/POS bytes over BLE
4. Rewrite `list` to enumerate BLE printers

## 10. Runtime Strategy (per user)

- If bun has issues with a BLE library, use bun **only as a TS→JS compiler**, then run the JS with **Node**
- Or write **plain JS** and run directly with Node (no compile step)

---

## 11. RESOLUTION — BLE Pivot Successful (2026-09-05)

### Working BLE recipe (confirmed)

- Library: **`webbluetooth`** (Node.js implementation of the Web Bluetooth spec, backed by SimpleBLE)
  - Works under **both bun and Node** on macOS arm64
  - Prebuilt binaries included (no compile needed)
- Connect to the printer's BLE GATT service `0000ff00-...`
- Write ESC/POS bytes to characteristic `0000ff02-...` (write-without-response)
- Confirmed: `HELLO BLE` printed successfully

### Printer GATT layout (RPP02N)

- Service `0000ff00-0000-1000-8000-00805f9b34fb`
  - char `0000ff01` (notify)
  - char `0000ff02` (**write / writeWithoutResponse**) ← ESC/POS data
  - char `0000ff03` (notify)
- Other services: `000018f0`, `0000fee7`, `e7810a71-...`, `49535343-...`

### CLI rewritten

- `src/serial.ts` (SPP) **deleted** → replaced by **`src/ble.ts`**
  - `listBlePrinters()` — scans BLE, filters by printer name patterns
  - `writeToBlePrinter()` — connects, writes ESC/POS bytes, disconnects
- `src/cli.ts` updated to use BLE
- `src/escpos.ts` unchanged
- Runtime: **bun** (works; `webbluetooth` loads and runs under bun)

### Validation

- `bun src/cli.ts list` → shows only `RPP02N`
- `bun src/cli.ts print RPP02N "..."` → prints successfully
- `bun src/cli.ts print nope "hi"` → clean error, exit 1
- `tsc` passes for CLI files (only pre-existing `src/main.ts` error remains)