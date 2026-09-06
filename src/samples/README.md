# Receipt Print Markup Reference

Plain-text markup for ESC/POS receipt printing. Each print line starts with an
alignment column, then a pipe, then the content.

## Alignment prefix

The leading column tells the printer how to align the whole line.

| Prefix | Meaning            |
|--------|--------------------|
| `l `   | left-align         |
| `c `   | center             |
| `r `   | right-align        |
| `  `   | leave default      |
| `  ` (blank content) | blank line |

The prefix is written as `<code>` + a space + `|` + a space.
Examples: `c | Centered`, `l | Left`, `r | Right`, `  | ` (blank).

## Inline styles (inside the content)

| Token          | Meaning                  |
|----------------|--------------------------|
| `# ...`        | large heading block (starts the line) |
| `**text**`     | **bold**                 |
| `*text*`       | *small / condensed* (Font B) |
| `__text__`     | __underline__            |
| `====`         | horizontal divider       |

Inline tokens can be mixed within one line, e.g. `r | **Total: $25**`.

## Notes

- Alignment applies per **print line** (whole line only).
- Use blank alignment lines (`  | `) for spacing.
- Keep each content line within the printable width (≈32 chars for Font A
  on a 58 mm / 203 dpi receipt) to avoid wrapping.
- Sizing is discrete (Font A / Font B / integer scale), not point-based.