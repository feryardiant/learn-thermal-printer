# ReceiptLine Markup Reference

This project uses **ReceiptLine** (OFSC ReceiptLine Specification), a vendor-neutral receipt description language. The library `receiptline` transforms ReceiptLine documents into ESC/POS bytes.

## Basic structure

Columns are separated by `|`. Each line is one print row.

```
|^^^Header^^^|
|"subtitle"|
Item        | $5.00
-
|^"Total: $25"^|
```

## Alignment

Alignment is determined by how the text sits relative to the pipe:

| Syntax | Alignment |
|--------|-----------|
| `\|text` | Left |
| `text\|` | Right |
| `\|text\|` | Center |
| `text` (no pipe) | Default (left, full width) |

## Inline formatting

| Token | Effect |
|-------|--------|
| `^text^` | Double width |
| `^^text^^` | Double height |
| `^^^…^^^^^^^` | 2×–6× size (more carets = larger) |
| `"text"` | Emphasis (bold on most printers) |
| `_text_` | Underline |
| `` `text` `` | Invert (white-on-black) |
| `~` | Non-breaking space |

## Special lines

| Line | Meaning |
|------|---------|
| `-` | Horizontal rule (solid line via raster bar) |
| `=` | Paper cut (at end of document) |
| (blank line) | Empty row / spacing |

## Properties

Single-column lines can be wrapped in `{ key: value; }` to set properties:

```
{ align: center; text: "Wrapped text that will fill the line"; }
```

| Property | Values | Description |
|----------|--------|-------------|
| `align` | `left`, `center`, `right` | Line alignment |
| `width` | number | Column width in characters |
| `border` | `true`, `false` | Column border |
| `text` | string | Wrapping text content |
| `code` | `ean13`, `code128`, `qrcode`, ... | Generate a barcode |
| `option` | string | Barcode/QR options |
| `image` | path | Print an image (Node only) |
| `command` | escape sequence | Raw ESC/POS command |

## Examples

See the sample files in this directory for full documents:
- `01-recipt.md` — simple receipt
- `02-invoice.md` — invoice with line items
- `03-order-ticket.md` — kitchen order
- `04-event-ticket.md` — event ticket
- `05-menu.md` — menu
- `06-test-card.md` — formatting test card