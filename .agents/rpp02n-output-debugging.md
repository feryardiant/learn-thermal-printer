# Thermal Print — RPP02N Output Debugging & Fixes

Documents the debugging journey and fixes for the physical **RPP02N** thermal
printer's print output, from the first garbled print to the final clean layout.
Companion to `thermal-print-formatting-design.md` (which covers the ReceiptLine
adoption decision); this doc covers the **printer-specific byte-level fixes**.

Status: **All reported issues resolved and verified on the RPP02N.**

---

## 0. The printer & pipeline

- **Printer:** RPP02N — a generic/cheap ESC/POS thermal clone (58 mm, 203 dpi).
- **Pipeline:** `Device.encode()` → `receiptline.transform(doc, opts)` → ESC/POS
  byte string → `Uint8Array` → chunked BLE writes (`Device.send()`).
- **ReceiptLine config used** (in `src/printer.ts`):
  ```ts
  {
    cpl: 32,
    encoding: 'multilingual',
    command: 'generic',   // NOT 'escpos'
    spacing: true,
    cutting: false,       // cut is appended manually (see §5)
  }
  ```

The single most important finding: **the RPP02N is not a Seiko/Epson TM.** It
ignores the Seiko `FS ( A` / `FS C n` / `GS 8 L` sequences that ReceiptLine's
`'escpos'` command set emits, which caused most of the garbling.

---

## 1. Original symptoms (all at once)

1. **Every word underlined.**
2. A `-` divider line printed as `0òòòòò…` and, being >32 chars, wrapped.
3. First line of each file printed with a stray **`A0`** prefix (left-aligned,
   normal size) before the correctly-sized centered text.
4. **No vertical spacing** between lines.
5. A trailing **QR code printed as garbage**: `0p01ææ ò˚? ò˚> …`.

---

## 2. Root cause: `command: 'escpos'` = the Seiko `_thermal` set

`'escpos'` in receiptline maps to the **`_thermal`** command set, written for
Epson TM / Seiko RP. It leans on Seiko two-byte commands the RPP02N ignores:

- `open()` emits `FS ( A` (`1c 28 41 02 00 30 00`). The printer ignores `FS ( A`
  and echoes the parameter bytes → the stray **`41`('A') `30`('0') = "A0"**.
- The QR is rasterized with Seiko `GS 8 L … GS ( L` (`1d 38 4c …`). Unsupported →
  the header/parameter bytes print as text → `0p01…` garbage.
- Line spacing defaults to `spacing: false` → `ESC 3 0` (0-dot) → lines touch.

**Fix:** switch to `command: 'generic'`, which emits plain ESC/POS and the
universal `GS v 0` raster (same command the QR uses), and set `spacing: true`
(`ESC 2`, 1/6″ line spacing).

| Symptom | Root cause | Fix |
|---|---|---|
| `A0` prefix | `FS ( A` prelude leaked `A`+`0` | `command: 'generic'` |
| QR garbage `0p01…` | Seiko `GS 8 L` raster ignored | `command: 'generic'` (`GS v 0`) |
| No line spacing | `spacing:false` → `ESC 3 0` | `spacing: true` |
| `-` = `0òòò…` + wrap | `_thermal.hr()` = `FS C 0` + `0x95` fill | see §3 |
| All words underlined | printer latching from garbled stream | resolved once stream clean |

---

## 3. The horizontal rule (`-`) — three attempts

ReceiptLine's only "line" token is a **bare `-` (one or more, alone on a line)**;
`=` alone is the paper-cut token. There is **no bolder/thicker line token** — the
rule always auto-fills the full width with a single glyph byte, so its appearance
is entirely up to the printer's font/code page.

### Attempt 1 — built-in `-` rule
Emits byte **`0x95`** (wrapped in `ESC t 01`/`FS C 0`). RPP02N renders `0x95` as
**`ò`** → the original `òòòò…` line.

### Attempt 2 — CP437 box-drawing bar `0xC4`
Rewrote bare `-` lines into a raw `{x:\xc4…}` command (with `ESC t 0` to select
CP437). RPP02N's default **multibyte** page doesn't know `0xC4` → printed
**blank**.

### Attempt 3 — `GS v 0` raster strip (ADOPTED)
The font-independent fix: draw the line as a **bitmap** with `GS v 0` — the exact
command the QR uses (confirmed working). A bare `-` line is rewritten into a raw
`{x:...}` command emitting a full-width all-black raster strip.

```ts
// cpl=32 × 12 dots = 384 dots wide → 48 bytes/row; 4 dots tall
// GS v 0 m xL xH yL yH d1...dk
'\x1dv0\x00' + '\x30\x00' + '\x04\x00' + '\xff'.repeat(48 * 4)
```

Because it's a bitmap, it's independent of the printer's font/code page — it can
never come out as `ò` or blank. The `command` property passes raw bytes, so it
needs **no PNG decoding** and works in the **browser path** too (unlike an
`{image:…}` divider, which would break in the browser).

### Padding around the bar
The bar initially sat tight against the text. Two refinements:
1. **Full-line padding** — `\n` before/after the bar (one blank line each side).
2. **Half-height padding (final)** — replaced `\n` with **`ESC J 15`**
   (`1b 4a 0f`, print-and-feed 15/180″ ≈ half of the 1/6″ line):
   ```ts
   const halfLine = '\x1bJ\x0f'
   halfLine + GS v 0 bar + halfLine   // half-height gap above & below
   ```
   The trailing `ESC J 15` also clears the 4-dot raster, so no extra LF is needed.

---

## 4. Blank lines

An **empty line** is the proper, supported grammar for a blank row, and it works
as-is (verified: `a⏎⏎b` → `a`, empty row, `b`). ReceiptLine also lets you be
explicit with `~` (a row of spaces). There is no special "blank" token — an empty
line already *is* one. The user confirmed empty lines print exactly as desired.

---

## 5. Cut after a trailing QR (or any trailing raster)

**Symptom:** a document ending in a QR code printed but **stopped before the cut
line** — the cut landed on/above the QR. Moving the QR up and ending with text
"fixed" it (the text's LF advanced the paper past the QR).

**Root cause:** `encode()` **prepended** the feed (`ESC d N`) before the content,
while the cut (`GS V`) is emitted by ReceiptLine at the *very end* of the output.
So a trailing raster was cut with **no feed** after it.

**Fix:** run the transform with `cutting: false` (so ReceiptLine doesn't embed a
cut at the end), then append the cut **manually** after the content, followed by
the feed:

```ts
// content's own trailing LF already advances below the last line (incl. a QR)
if (cutting) buffer.set(cutSeq, data.length)              // GS V B 00  (cut)
buffer.set(feedSeq, data.length + (cutting ? cutSeq.length : 0))  // ESC d N (feed)
```

Byte order: **content → cut (`GS V B 00`) → feed (`ESC d N`)**. This is a general
fix — a trailing QR (or any raster) now clears the print head before cutting, so
the sample can keep the QR as its last line.

---

## 6. Final ReceiptLine config & byte layout

```ts
data = receiptline.transform(doc, {
  cpl: 32,
  encoding: 'multilingual',
  command: 'generic',   // plain ESC/POS + GS v 0 raster (RPP02N honors it)
  spacing: true,        // ESC 2 (1/6″) line spacing
  cutting: false,       // cut appended manually in encode()
})
```

`encode()` output tail (when cutting):
`…content…  GS V B 00  ESC d N`

---

## 7. Key ReceiptLine grammar facts (verified against source + output)

- **`-`** (bare, alone) = horizontal rule. **`=`** (alone) = paper cut.
- **`~`** = space; a line of `~` is a row of spaces.
- **empty line** = blank row.
- **`__text__`** (double underscore) is a **no-op** — each `_` toggles underline,
  so `__` = on-then-off. Real underline is **single** `_text_`.
- **`^`** double width, **`^^`** double height, **`^^^`…`^^^^^^^`** 2×–6× size.
- **`{x:…}`** `command` property injects **raw bytes** — used for the raster bar.
- Alignment is by how a column hugs the pipe: `|col|` center, `|col` left,
  `col|` right.

---

## 8. Files touched

- `src/printer.ts` — `command: 'generic'`, `spacing: true`, `solidRuleLines()`
  (rewrites bare `-` → `GS v 0` raster bar with `ESC J 15` half-line padding),
  manual cut-then-feed tail in `encode()`.
- `test/printer.test.ts` — tests for `solidRuleLines` and the `encode()` tail.
- `src/samples/*.md` — reverted to clean `-` dividers (the rewriter handles them);
  `04-event-ticket.md` keeps the QR as its last line.

## 9. Caveats / notes

- `ESC J n` units are n/180″ per spec (some 203-dpi printers treat it as n/203),
  so `15` is "about" half a line either way — tune `0x0f` if the gap looks off.
- Bar thickness is `height = 4` dots in `buildRuleBar()` — a one-number tweak.
- The `0xC4`/`0x95` glyphs are printer-firmware-dependent; only the `GS v 0`
  raster is guaranteed across printers.
- `multilingual` encoding triggers `ESC t` codepage switches for non-ASCII chars
  (em-dash `—`, bullets `•`). If stray glyphs ever appear near those, swap them
  for ASCII or switch encoding.