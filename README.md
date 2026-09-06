# Thermal Print

Print text to Bluetooth ESC/POS thermal printers (primarily RPP02N) from the browser or CLI.

## Quick start

```bash
bun install
bun run dev        # Vite dev server (browser UI)
bun run build      # tsc && vite build
bun run test       # vitest (32 tests)
```

## Usage

### Browser

Open `http://localhost:5173`, click **Check printer**, select your printer from the Bluetooth chooser, type text, click **Print**.

### CLI

```bash
bun src/cli.ts list                    # scan for BLE printers
bun src/cli.ts list --all              # all BLE devices
bun src/cli.ts print RPP02N "|^^Hello^^|"              # print ReceiptLine markup
bun src/cli.ts print RPP02N path/to/doc.md             # print from file
bun src/cli.ts print RPP02N "Hello" --no-cut --feed 5  # no cut, extra paper feed
```

## ReceiptLine markup

See [`public/samples/README.md`](public/samples/README.md) for the full reference.

```
|^^^Header^^^|
|"Condensed text"|
Item        | $1.50
-
|^Total: $25.00^|
```

## Architecture

- **Browser path** (`src/main.ts`): Web Bluetooth API
- **CLI path** (`src/cli.ts`): `webbluetooth` native module
- **Printer abstraction** (`src/printer.ts`): `DeviceFinder` (scan) + `Device` (connect/send)

For details see [`AGENTS.md`](AGENTS.md).