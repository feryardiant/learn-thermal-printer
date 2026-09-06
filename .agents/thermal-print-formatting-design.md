# Thermal Print — Receipt Formatting Design (updated)

Tracks the decision journey about font sizes, alignment, formatting markup, the
DB storage format, and the render/print pipeline.

Status: **Adopted ReceiptLine (OFSC ReceiptLine Specification)** as the reference
format. Samples converted. Parser/emitter prototyping is next.

---

## 1. Measurement: dots, not points

ESC/POS thermal printers have **no concept of points (pt)**. They work in
**dots at the printhead's native resolution** — typically **203 dpi (8 dots/mm)**
for 58 mm / 80 mm receipt printers (a few are 300 dpi ≈ 11.8 dots/mm). At 203 dpi:
1 dot ≈ 0.125 mm ≈ 0.354 pt; Font A's 24-dot cell ≈ 3 mm ≈ ~8.5 pt.

There is **no "12 pt" or "20 pt"** — only discrete matrix cells and integer scaling.

## 2. No continuous font size

Two base fonts + integer scaling:

1. **Font A** — 12×24 dot cell (default)
2. **Font B** — 9×17, condensed (`ESC M 1`)
3. **`GS ! n`** — integer scale of the active font (lower nibble width, upper
   nibble height, each ×1–×8). **No fractional steps.**

## 3. Mixing sizes — per line and within a line

The printer is a **byte stream**; size commands affect subsequent text until
changed. Big + small on one line share a **single baseline** (side-by-side, not
nested rows). Sub/superscripts (`ESC S 0/1`) exist too.

## 4. Alignment

`ESC a n`: `0` left, `1` center, `2` right. Byte-stream switch, acts per **print
line**, computed against printable width at the **current font size** (size and
alignment are coupled per line). **Whole-line only** — two-column rows on one line
need padding / tab / absolute dot positioning or `GS L`/`GS D`.

## 5. Markup design — original custom attempt (superseded)

We sketched a custom plain-text format:
- **Alignment prefix column**: `<code> | ` where `l`/`c`/`r`/blank.
- Inline tokens: `#` big, `**` bold, `*` small (Font B), `__` underline, `====` divider.
- Bullets as literal `- ` text.

This worked but meant **inventing a syntax**. The user rightly pushed to avoid
that.

## 6. Standard vs. invent — the reality check

Only true standard is **ESC/POS itself** (raw bytes, no text markup). No universal
plain-text receipt markup exists. Candidates:

1. **ESC/POS command format** (samples `11–16`) — faithful but verbose/assembly-like.
2. **Epson ePOS-Print XML** / **Star "Printer Command"** — genuine vendor standards
   (XML), well-specified, but not plain text and vendor-locked.
3. **Markdown subset** — closest widely-understood text format; gap = no alignment.

## 7. The adopted answer: ReceiptLine (OFSC ReceiptLine Specification)

**`receiptline`** (Apache-2.0) — a documented, vendor-neutral **receipt
description language** (by the OpenReceipt Project, formerly recognized by OFSC).

- **One stored format drives both outputs:**
  ```js
  const command = receiptline.transform(doc, printer)  // → ESC/POS bytes
  const svg     = receiptline.transform(doc, display)  // → SVG image
  ```
- Real spec, not invented; markdown-like, **width-independent** text.
- **Barcodes & QR codes** built in (`receiptline.barcode.generate()`,
  `receiptline.qrcode.generate()`), with a free QR generator tool.
- Handles Epson TM, Seiko RP, Star MC, Citizen, Fujitsu.

### Why it fits our DB-storage question

Store the **ReceiptLine document (a string)** in the DB. Parse once →
emit two outputs (printer bytes + SVG/HTML). Works in any SQL/JSON/doc store.

### Display output is SVG, not literal HTML

ReceiptLine renders **SVG** for display (easy to embed, good fidelity for fixed
width). If browser-*editable* HTML DOM / native input fields are required, SVG
isn't that — but for a receipt (read-only layout) SVG is a fit. SVG depends on
system fonts.

## 8. ReceiptLine syntax reference (for the converted samples)

- **Table/columns**: columns separated by `|`.
- **Alignment** by how the column hugs the pipe (`|col|` center, `|col`/`col |`
  left, `col|`/`| col|` right).
- **Special chars**: `-` hr, `=` cut, `~` space, `_` underline, `"` emphasis, `` ` ``
  invert, `^` double width, `^^` double height, `^^^` … `^^^^^^^` 2×–6× size.
- **Properties** (single-column lines, `{ key: value; ... }`): `align`, `width`,
  `border`, `text` (wrap), `code` (+`option`), `image`, `command`, `comment`.
- **Escape**: `\\`, `\|`, `\-`, `\=`, `\n` (manual wrap), `\x`_nn_.

## 9. Migration of samples

All `src/samples/*.md` converted to ReceiptLine-valid documents. The old custom
`l | c | r` markup is **out of scope** going forward. The `11–16` (command) and
`21–26` (Epson XML) files remain as reference of the two vendor formats for
comparison only.

## 10. BLE write limits & connection stability (finding)

When sending ReceiptLine output to the printer over BLE, two constraints surfaced:

### 10.1 BLE ATT write size limit

- A single GATT write is limited to **MTU − 3** bytes. The RPP02N reports
  `mtu = 240`, so each write can carry **≤ 237 bytes**.
- Larger payloads must be **chunked** and written sequentially. A single write of
  the whole buffer is truncated/dropped (only the first few lines printed).
- Fix: `sendDataToDevice()` loops over the buffer in 237-byte chunks.

### 10.2 Printer connection drops mid-stream (unresolved hardware/flakiness)

- Even with chunking, long documents (e.g. `06-test-card.md`, ~1666 bytes) can
  cause the printer's BLE connection to drop partway:
  - Observed: `CBATTErrorDomain Code=118 "Unknown ATT error"` and
    `Characteristic FF02 could not be written` mid-write.
  - The printer may print the full file but then **repeat the first lines** at the
    bottom before stopping — the connection drops, we reconnect, and the first
    chunk (leading lines) is re-buffered.
- This is a **printer firmware / connection-stability limit**, not a code bug.
  Even small payloads sometimes fail (`200 bytes: FAIL`) depending on the
  printer's radio state.
- The same SPP/BLE mode flakiness documented earlier is the likely contributor.

## 11. Decision point — options to explore (tracking log)

**Status of the write-size problem:** fixed (chunking).
**Status of the connection-drop problem:** unresolved, printer-side.

### The write-size cap (resolved)

| Item | Value |
|------|-------|
| BLE ATT max write | MTU − 3 = **237 bytes** (RPP02N MTU 240) |
| Fix | `sendDataToDevice()` chunks into 237-byte writes |
| Verified | printer accepts 237-byte chunks |

### The remaining issue (connection drops mid-stream)

- Long documents (~1666 bytes, e.g. `06-test-card.md`) drop the BLE link partway.
- Symptom: full file prints but **first lines repeat at the bottom** before
  stopping — a drop + reconnect + re-buffer of the first chunk.
- Low-level errors: `CBATTErrorDomain Code=118 "Unknown ATT error"` and
  `Characteristic FF02 could not be written`. Even ~200-byte payloads sometimes
  fail, so it's a **link-layer/radio stability** issue, not size or timing.

### Conclusion

Chunking was necessary and correct, but cannot overcome a printer BLE link that
drops under sustained/detailed writes. This is firmware/hardware-side flakiness
(related to the earlier SPP/BLE mode instability).

### Options (experimented in order)

1. **Accept for short docs** — chunking already makes small/medium receipts
   reliable; only long ones hit the connection-drop wall. Document that real
   receipts (usually < a few hundred bytes) work.
2. **Retry with cleanup** — on a mid-write failure, send `ESC @` (init) to flush
   partial buffers, then resend, avoiding the duplicated-header artifact.
3. **Investigate the printer radio** — fresh connect via the Thermer app to
   re-stabilize BLE mode, check antenna/power, or test a different printer.

---

### Log

- **2026-09-06 — Option 1 (accept short docs):** Tested. Short inline docs
  (`|^Short test^|`, 3 lines) printed OK. But even the small `01-recipt.md`
  (~a few hundred bytes) intermittently failed with `Characteristic FF02 could
  not be written`. **Option 1 is unreliable right now** — the printer's BLE link
  is unstable enough that even short receipts fail. Not a viable path alone.

- **2026-09-06 — Option 2 (retry with cleanup):** Implemented: `sendDataToDevice`
  now disconnects, sends `ESC @` to flush partial buffers, and retries up to 2
  more times on a write failure. Tests updated & passing (38). **Result:** the
  receipt still failed on all 3 attempts (`01-recipt.md`) — three sequential
  `Characteristic FF02 could not be written`. Retry does not overcome the
  instability; it's persistent, not a one-shot race.

- **2026-09-06 — Option 3 (investigate printer radio):** Next. The connection is
  persistently unstable at the ATT/link layer even for short docs. Try a fresh
  BLE (re)connect via the Thermer app, verify the printer is in a stable BLE
  mode, and/or rule out antenna/power/distance. Also consider testing another
  printer.

### KEY FINDING (2026-09-06) — lost ACK on `writeValueWithResponse`

A direct reproduction pinned the mechanism:

Input (the Anu receipt), 3 logged write failures, but the printer printed:

- **header twice**, then **full content once**, and **another header at the bottom**

Explanation: each "failed" attempt actually **reached the printer at least partly**
(the header), but the ATT **acknowledgment was lost** → our code treated it as
failure and **resent the entire buffer from byte 0 on retry** (including the `ESC @`
reset + header). The printer accumulates the re-sent prefix on each attempt; only
on the last attempt does the full stream survive.

**Root cause:** this printer loses ACKs on `writeValueWithResponse` yet still prints
— so write-with-response produces false failures that trigger destructive
full-from-start resends (duplicated header/lines at the bottom).

### Implication for the next option

Retrying the whole buffer is wrong. Options:

- **Option 4 — `writeValueWithoutResponse`**: since the printer accepts and prints
  the bytes even when ACKs are unreliable, use fire-and-forget writes for the
  chunk stream (kept open, not immediately disconnected). No false-failure => no
  resend duplication.
- **Option 5 — retry only the failed chunk** (not from byte 0) using
  `writeValueWithResponse`, so a lost ACK doesn't re-send the header.

### LOG — Option 4 (`writeValueWithoutResponse`) — promising, remaining cut issue

Tested `opt4-test.mjs`: connect, wait ~300ms, send `ESC @` reset, then stream the
chunks with `writeValueWithoutResponse`, keep the link open, disconnect after.

**Result:**
- **No false failures** (no `Characteristic FF02 could not be written`).
- **No duplicated header** — the full content printed **once**, cleanly.
- **Remaining issue:** the last line printed under the paper-cut line — i.e. the
  cut landed too early, cutting through the final text line instead of after it.

**Conclusion:** `writeValueWithoutResponse` solves the lost-ACK duplication. The
remaining fix is **cut positioning**: feed a few lines before the `GS V` cut so it
clears the content. Implement in `sendDataToDevice`.

### LOG — Option 4 implemented (2026-09-06)

Changed `sendDataToDevice` to:
- Use **`writeValueWithoutResponse`** for the chunk stream (printer accepts and
  prints; no lost-ACK false failure, no resend duplication).
- Wait ~300ms for the BLE link to settle before writing.
- Wait ~500ms after writing before disconnecting so the printer finishes.
- Removed the reset-on-retry / from-start resend entirely.

Changed the CLI to **prepend** the feed before the data (so the paper advances
below the last line before the cut) and raised the default `--feed` to 3.

**Result:** `01-recipt.md` prints with no errors. Confirmed no duplicated header
and no `Characteristic FF02 could not be written`.

Need to visually confirm the cut lands below the content.

### LOG — REALITY CHECK (2026-09-06): silent mid-write drop even without errors

- `01-recipt.md` (only **923 bytes / 4 chunks**) printed only through **line 6,
  truncated mid-word** (`"Item with very"`).
- With `writeValueWithoutResponse` there is **no error reported** — the write
  silently succeeded at the API level, but the printer only received part. A
  mid-ATT-write drop is invisible.
- A repeat test: 3/4 rounds sent 4 chunks, then the **connection hung** (unsettled
  await) — intermittent connection stalls.

**Conclusion:** the RPP02N's BLE link is **deeply and intermittently unstable** —
it drops **mid-write**, regardless of write-with/without-response, and even for
small ~900-byte documents. This is firmware/hardware flakiness, not a protocol or
code issue. Neither write method is reliable for sustained output.

## 12. Decision — deeper printer-side instability, realistic next steps

Given the printer's BLE link is intermittently unstable even for tiny docs, the
options are:
1. **Reset the printer's BLE state** between/around prints — e.g. toggle via the
   Thermer app (previously re-stabilized SPP/BLE mode), or power-cycle, then
   retry. Verify a *fresh* connection prints cleanly more than a stale one.
2. **Treat printing as best-effort / non-transactional** — accept that long or
   repeated prints may drop; keep the pipeline correct but not guaranteed.
3. **Test a different/known-good BLE printer** to confirm whether this specific
   RPP02N unit is defective vs. a general BLE-thermal limitation.
4. **Add a post-print read/status** (if the printer exposes one) to detect drops,
   or print in small batches with explicit acknowledgment.
5. **Fall back to SPP** — earlier finding: this printer's SPP channel never
   established a link on macOS, so this is likely not viable.

### LOG — Option 1 (prime connect) tested, did NOT help (2026-09-06)

Tried a bare prime connect/disconnect before sending to wake the radio:
- Sent 4 chunks with no API errors.
- **Printed only through line 5** (this time *less* than the previous line 6),
  under the cut line — connection dropped again at ~400-500 bytes.

**Result:** a bare connect/disconnect does **not** stabilize the link. Combined
with the earlier tests, the RPP02N's BLE link drops at an unpredictable byte count
(~400-900 bytes) regardless of write method, chunking, or priming.

**So the practical workaround remains:** re-stabilize via the Thermer app or a
power-cycle, print while the link is fresh, and keep the pipeline best-effort.
