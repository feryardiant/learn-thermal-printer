import { DeviceFinder, FinderError } from './printer.ts'
import { readFileSync, existsSync, statSync } from 'node:fs'

export function printUsage(): void {
  console.log(`Usage:
  bun src/cli.ts list [--all]        List available ESC/POS printers
  bun src/cli.ts print <printer> "<text>" [--no-cut] [--feed N]
                                     Print text or a receiptline file to a printer

<printer> is matched by name (e.g. "RPP02N") or a BLE device id.
<text>   is either a ReceiptLine document or a full path to a ReceiptLine (.md) file.
         If the path exists, the file is parsed and printed; otherwise the text is
         parsed directly as a ReceiptLine document.`)
}

export async function listCommand(showAll: boolean): Promise<void> {
  const printers = await new DeviceFinder().getList()

  if (showAll) {
    console.log('All BLE devices found:')
    for (const p of printers) console.log(`  ${(p.name ?? '').padEnd(24)} ${p.id}`)
    return
  }

  if (printers.length === 0) {
    console.log('No ESC/POS printers found.')
    console.log('Run with --all to see every BLE device.')
    return
  }

  console.log(`Available ESC/POS printer${printers.length === 1 ? '' : 's'}:`)
  for (const p of printers) console.log(`  ${(p.name ?? '').padEnd(24)} ${p.id}`)
}

/**
 * Return the ReceiptLine document for the `<text>` argument.
 * If the argument is a real file path, read and return the file contents;
 * otherwise treat the argument itself as the document / plain text.
 */
export function loadReceiptlineDoc(arg: string): string {
  try {
    if (existsSync(arg) && statSync(arg).isFile()) {
      return readFileSync(arg, 'utf8')
    }
  } catch {
    // not a readable file — fall through to raw text
  }
  return arg
}

export async function printCommand(args: string[]): Promise<number> {
  if (args.length < 2) {
    console.error(`Usage: bun src/cli.ts print <printer> "<text>" [--no-cut] [--feed N]`)
    return 1
  }

  const printerId = args[0]
  const text = args[1]

  let feed = 1
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

  const finder = new DeviceFinder()
  const doc = loadReceiptlineDoc(text)

  try {
    const device = await finder.getDevice(printerId)

    await device.send(doc, !noCut, feed)

    console.log(`Printed to ${device.name} (${device.id}).`)

    return 0
  } catch (err) {
    if (err instanceof FinderError) {
      console.error(err.message, 'id:', err.id, err)
    } else {
      console.error((err as Error).message)
    }

    return 1
  }
}

export async function main(): Promise<number> {
  const argv = process.argv
  let i = 1
  if (argv[i] === 'run') i++
  i++ // skip script path
  const cmd = argv[i] ?? ''
  const args = argv.slice(i + 1)

  try {
    switch (cmd) {
      case 'list':
        await listCommand(args.includes('--all'))
        process.exit(0)
      case 'print':
        process.exit(await printCommand(args))
      case 'help':
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
      default:
        printUsage()
        process.exit(1)
    }
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

// Only run the CLI when executed directly (not when imported by tests).
if (import.meta.main) {
  main()
}
