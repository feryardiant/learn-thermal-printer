/**
 * Manifest of printable sample templates. The ReceiptLine documents themselves
 * live in `public/samples/` so the browser UI can fetch (preload) and render
 * them as SVG previews; the CLI reads them by path when passed to `print`.
 */
export interface Sample {
  /** Stable identifier, also used as the CSS class for the selected state. */
  id: string
  /** Human-readable label shown under the preview. */
  label: string
  /** Web path served by Vite from `public/samples/`. */
  path: string
}

export const SAMPLES: Sample[] = [
  { id: 'receipt', label: 'Receipt', path: '/samples/01-recipt.md' },
  { id: 'invoice', label: 'Invoice', path: '/samples/02-invoice.md' },
  { id: 'order-ticket', label: 'Order Ticket', path: '/samples/03-order-ticket.md' },
  { id: 'event-ticket', label: 'Event Ticket', path: '/samples/04-event-ticket.md' },
  { id: 'menu', label: 'Menu', path: '/samples/05-menu.md' },
  { id: 'test-card', label: 'Test Card', path: '/samples/06-test-card.md' },
]