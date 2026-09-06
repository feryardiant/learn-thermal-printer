import type { ReceiptlineImpl } from "./printer"

export { }

declare global {
  var receiptline: ReceiptlineImpl | undefined
}
