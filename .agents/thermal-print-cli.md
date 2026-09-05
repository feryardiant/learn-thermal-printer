# Thermal Print — Bluetooth ESC/POS Printer CLI

Complete write-up of the investigation, decisions, and final working solution.

Date: 2026-09-05
Status: **Working** — BLE-based CLI prints successfully to the RPP02N printer.

---

## 1. Goal

Build a CLI that can:
- **List** available ESC/POS thermal printers (and *only* printers — no other serial/BLE devices)
- **Print** text to a chosen printer

```
bun src/cli.ts list
bun src/cli.ts print <printer> "Text to print"
```

## 2. Hardware / Environment

| Item | Value |
|------|-------|
| Printer | RPP02N (ESC/POS thermal receipt printer) |
| BT address | `86:67:7A:B0:10:CF` |
| Vendor / Product ID | `0x05AC` / `0x0239` |
| Firmware | `6.4.4` |
| Baud rate | **115200** (confirmed by user) |
| Transport | **Dual-mode**: classic Bluetooth SPP **and** BLE (GATT) |
| OS | macOS (MacBook Air, Apple Silicon / arm64) |
| Runtime | bun v1.4.0 (also works under Node v26.8.1) |
| Reference app | "Bluetooth Thermal Printer App" (`mate.bluetoothprint`) — prints successfully |

## 3. The Journey: Why We Ended Up on BLE

The CLI was originally built for **SPP** (writing to `/dev/cu.RPP02N`), which is the obvious approach for a serial printer. It did **not** work. This section documents why.

### 3.1 SPP approach (failed)

- Wrote ESC/POS bytes to `/dev/cu.RPP02N` (and `/dev/tty.RPP02N`) via plain file I/O
- Writes reported success, but **nothing printed** and the printer **LED did nothing**
- No response to status queries (`DLE EOT 4`, `GS r`)
- `system_profiler` **hung** while the SPP port was held open

### 3.2 Root cause: SPP link never establishes

Despite macOS System Settings showing the printer as **"Connected"**, the underlying ACL/RFCOMM link was **never actually up**:

```
"ConnectionHandle" = 0xfff   ← "no active connection" sentinel
"MaxACLPacketSize" = 0x0     ← no live ACL link
```

`bluetoothd` logs showed **no RFCOMM connection establishment** for RPP02N. So writes went into a pseudo-serial device with no live link → no LED, no print.

### 3.3 The reference app uses BLE, not SPP

- `lsof` on the working app showed it **never opens `/dev/cu.RPP02N`**
- It talks to `bluetoothd` over a **unix socket** (the BLE/GATT API)
- The printer advertises **both** SPP and BLE (`Services: 0xC02000 < Braille BLE ACL >`)

**Conclusion:** The printer's SPP channel does not establish a working link from macOS, but its **BLE channel does**. The app works because it uses BLE.

### 3.4 Decision

**Pivot the CLI to BLE (GATT).** This matches the working reference app and is the reliable path.

## 4. The Working BLE Recipe

- Library: **`webbluetooth`** (Node.js implementation of the Web Bluetooth spec, backed by SimpleBLE)
  - Works under **both bun and Node** on macOS arm64
  - Ships prebuilt binaries (no compile step)
  - v3.x default uses SimpleBLE v0.6.1 (MIT-licensed) — fine for non-commercial use
- Connect to the printer's BLE GATT service `0000ff00-0000-1000-8000-00805f9b34fb`
- Write ESC/POS bytes to characteristic `0000ff02-0000-1000-8000-00805f9b34fb` (write-without-response)
- **Confirmed working**: `HELLO BLE` printed successfully

### RPP02N GATT layout

| Service | Characteristic | Properties |
|---------|---------------|------------|
| `0000ff00-...` | `0000ff01` | notify |
| `0000ff00-...` | `0000ff02` | **write / writeWithoutResponse** ← ESC/POS data |
| `0000ff00-...` | `0000ff03` | notify |
| `000018f0-...` | `00002af0/2af1/ff03` | (health/other) |
| `0000fee7-...` | `0000fec7/fec8` | (other) |
| `e7810a71-...` | `bef8d6c9-...` | read/write/notify |
| `49535343-...` | `49535343-...` | (other) |

## 5. Final Solution — Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | Entry point: arg parsing, `list` / `print` commands, printer resolution |
| `src/ble.ts` | BLE discovery (`listBlePrinters`) + ESC/POS write (`writeToBlePrinter`) |
| `src/escpos.ts` | ESC/POS command builders (init, text, feed, cut) |
| `src/main.ts` | Web UI (unchanged; out of scope) |
| `package.json` | Added `webbluetooth` runtime dependency |
| `.agents/findings-ble-pivot.md` | Investigation notes (this document is the fuller write-up) |

### `src/ble.ts` — key details

- `ESCPOS_SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb'`
- `ESCPOS_WRITE_CHAR_UUID = '0000ff02-0000-1000-8000-00805f9b34fb'`
- `listBlePrinters()` — scans BLE, filters devices by ESC/POS name patterns (`rpp`, `pos`, `printer`, `thermal`, `tm-`, `epson`, etc.)
- `writeToBlePrinter()` — scans for the printer by id, connects, writes ESC/POS bytes via `writeValueWithoutResponse`, disconnects

### `src/escpos.ts` — commands

- `ESC @` (init) — resets printer
- Text encoded as UTF-8
- `ESC d n` (feed n lines)
- `GS V 65` (full cut) / `GS V 66` (partial cut)
- Escape-sequence interpretation (`\n`, `\r`, `\t`)

## 6. Usage

```
bun src/cli.ts list                          # list ESC/POS printers
bun src/cli.ts list --all                    # all BLE devices found
bun src/cli.ts print <printer> "Text"        # print text
bun src/cli.ts print <printer> "a\nb" --no-cut --feed 2
bun src/cli.ts help
```

`<printer>` is matched by **name** (e.g. `RPP02N`) or **BLE device id**.

## 7. Validation

- `bun src/cli.ts list` → shows only `RPP02N` (filters out earbud + unknown BLE devices)
- `bun src/cli.ts print RPP02N "..."` → prints successfully (confirmed physically)
- `bun src/cli.ts print nope "hi"` → clean error, exit 1
- `bunx tsc --noEmit` → passes for all CLI files (only pre-existing `src/main.ts` error remains)

## 8. Runtime Notes & Gotchas

### 8.1 `serialport` npm package crashes bun

- `serialport@13.0.0` panics bun on open:
  ```
  panic(main thread): unsupported uv function: uv_default_loop
  ```
- Known issue: oven-sh/bun#18546
- **Workaround**: use plain file I/O for SPP, or run under Node. (Moot now — we use BLE.)

### 8.2 `webbluetooth` works under both bun and Node

- Loads and runs under bun (no crash, unlike `serialport`)
- If you ever hit an intermittent hang (transient BLE scan timeout), the same file runs with `node src/cli.ts`

### 8.3 bun sandbox quirks (dev environment only)

- bun cannot write to the sandbox temp dir (`EPERM`); workaround: set `TMPDIR`/`BUN_INSTALL_CACHE_DIR` to a project dir
- `fd.read()` on a serial device does **not** unblock when the fd is closed — use a subprocess with a hard timeout for reads

### 8.4 macOS Bluetooth SPP quirks

- SPP devices appear as `/dev/tty.<name>` and `/dev/cu.<name>`; `cu.` is the outgoing device
- macOS UI can report "Connected" while the ACL link is actually down (`ConnectionHandle = 0xfff`)
- `cu`/`screen` tools fail due to `/var/spool/uucp` lock-file permission (uid 501)

## 9. Possible Follow-ups

- **`--codepage` option** for non-ASCII text (printer code-page selection)
- **Wire the CLI into the web UI** now that printing works
- **Support other printer models** — the service/characteristic UUIDs (`0000ff00`/`0000ff02`) are common for these cheap thermal printers but may differ on other models; `list` + error messages make this obvious