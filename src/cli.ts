import { listBlePrinters, writeToBlePrinter, type BlePrinter } from './ble.ts'
import { init, encodeText, feedLines, cut, concat, interpretEscapes } from './escpos.ts'

export function printUsage(): void {
  console.log(`Usage:
  node src/cli.ts list [--all]        List available ESC/POS printers
  node src/cli.ts print <printer> "<text>" [--no-cut] [--feed N]
                                     Print text to a printer

<printer> is matched by name (e.g. "RPP02N") or a BLE device id.`)
}

export async function listCommand(showAll: boolean): Promise<void> {
  const printers = await listBlePrinters()

  if (showAll) {
    console.log('All BLE devices found:')
    for (const p of printers) console.log(`  ${p.name.padEnd(24)} ${p.id}`)
    return
  }

  if (printers.length === 0) {
    console.log('No ESC/POS printers found.')
    console.log('Run with --all to see every BLE device.')
    return
  }

  console.log(`Available ESC/POS printer${printers.length === 1 ? '' : 's'}:`)
  for (const p of printers) console.log(`  ${p.name.padEnd(24)} ${p.id}`)
}

/** Resolve a user-supplied printer identifier to a BLE printer. */
export function resolvePrinter(arg: string, printers: BlePrinter[]): BlePrinter | null {
  const lower = arg.toLowerCase()

  // Exact id match.
  const byId = printers.find((p) => p.id === arg)
  if (byId) return byId

  // Name match (case-insensitive substring). Collect all matches.
  const matches = printers.filter((p) => p.name.toLowerCase().includes(lower))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    console.error(`"${arg}" matches multiple printers:`)
    for (const m of matches) console.error(`  ${m.name}  ${m.id}`)
    return null
  }

  return null
}

interface PrintOptions {
  feed: number
  noCut: boolean
}

export function buildEscPos(text: string, opts: PrintOptions): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from(init())]
  parts.push(encodeText(interpretEscapes(text)))
  parts.push(Uint8Array.from(feedLines(opts.feed)))
  if (!opts.noCut) parts.push(Uint8Array.from(cut('full')))
  return concat(parts)
}

export async function printCommand(args: string[]): Promise<number> {
  if (args.length < 2) {
    console.error('Usage: node src/cli.ts print <printer> "<text>" [--no-cut] [--feed N]')
    return 1
  }

  const printerArg = args[0]
  const text = args[1]

  let feed = 3
  let noCut = false
  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case '--no-cut':
        noCut = true
        break
      case '--feed':
        feed = parseInt(args[++i] ?? '', 10)
        if (Number.isNaN(feed) || feed < 0) {
          console.error('--feed requires a non-negative number.')
          return 1
        }
        break
      default:
        console.error(`Unknown option: ${args[i]}`)
        return 1
    }
  }

  const printers = await listBlePrinters()
  const printer = resolvePrinter(printerArg, printers)
  if (!printer) {
    console.error(`No printer found matching "${printerArg}".`)
    console.error('Run `node src/cli.ts list` to see available printers.')
    console.error('')
    console.error('If the printer is paired but not listed, it may be in SPP (classic) mode,')
    console.error('not advertising BLE. Enable BLE mode on the printer (e.g. connect to it once')
    console.error('with a Bluetooth printer app) so it advertises its BLE service, then retry.')
    return 1
  }

  const data = buildEscPos(text, { feed, noCut })
  try {
    await writeToBlePrinter(printer, data)
  } catch (err) {
    console.error(`Failed to print to ${printer.name}: ${(err as Error).message}`)
    return 1
  }

  console.log(`Printed to ${printer.name} (${printer.id}).`)
  return 0
}

export async function main(): Promise<number> {
  const argv = process.argv
  let i = 1
  if (argv[i] === 'run') i++
  i++ // skip script path
  const cmd = argv[i] ?? ''
  const args = argv.slice(i + 1)

  switch (cmd) {
    case 'list':
      await listCommand(args.includes('--all'))
      return 0
    case 'print':
      return await printCommand(args)
    case 'help':
    case '--help':
    case '-h':
      printUsage()
      return 0
    default:
      printUsage()
      return 1
  }
}

// Only run the CLI when executed directly (not when imported by tests).
if (import.meta.main) {
  // bun segfaults on the webbluetooth native binding (bun#18546 class of bug).
  // The CLI must be run with Node: `node src/cli.ts ...`.
  if (typeof Bun !== 'undefined') {
    console.error('The CLI must be run with Node (bun crashes on the webbluetooth native binding).')
    console.error('Usage: node src/cli.ts <command>')
    process.exit(1)
  }
  process.exit(await main())
}