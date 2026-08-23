# ANSI Viewer

Renders a file's ANSI escape sequences — the colors and styles your
build tools and loggers emit — in a WebView panel, with line numbers
and native Ctrl+F find. `.log`, `.ansi` and `.ans` files open in it
automatically.

## Why another ANSI viewer

Large files. Extensions that colorize via VS Code's per-byte
text-decoration API stall on multi-megabyte logs; this one hands the
whole file to the browser engine as HTML spans, which is what browsers
are good at. Multi-MB logs render fine.

## What you get

- **The 16-color SGR palette** (basic + bright, foreground and
  background), plus bold, italic and underline. Styling state carries
  across lines, like a real terminal.
- **Line numbers that stay out of your way** — drawn as CSS counters,
  so they never appear in Ctrl+F results or copied text, and the
  number column stays pinned during horizontal scroll.
- **Title-bar buttons** on the viewer: toggle line wrap (wrapped rows
  get a hanging indent past the number gutter), and *Edit as Text* to
  flip to the ordinary editor. On a `.log`/`.ansi`/`.ans` text editor,
  an eye button flips back to the viewer. One panel per file — the
  toggle reuses the tab instead of spawning duplicates. The View/Edit
  toggle is deliberately the RIGHTMOST title-bar action in both modes,
  so it sits in the same screen position either way and you can
  click-toggle without moving the mouse.
- **A stats strip** at the top: SGR sequence count, line count, size.

## Markdown, too

The same view/edit convention is applied to Markdown: `.md` files
auto-open in VS Code's built-in preview, with title-bar buttons to
flip between preview and source. If you prefer VS Code's default
Markdown behavior, this is the extension's most opinionated feature —
feedback welcome.

## Notes and limits

- 256-color (`38;5;n`) and truecolor (`38;2;r;g;b`) sequences are not
  interpreted yet — only the classic 16-color codes.
- The panel is static HTML with no scripts (CSP `default-src 'none'`).
- Editing a file the viewer has open: use *Edit as Text*; the file
  stays editable until you explicitly reopen it in the viewer.
