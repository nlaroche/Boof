Create src/client/lib/ansi.ts with a function ansiToHtml(text: string): string.

It converts ANSI escape codes to HTML spans with inline styles. Support colors 30-37 for foreground, 90-97 for bright, 40-47 background, bold, and reset. Map to hex color values. Strip unknown escape sequences. Return HTML string.
