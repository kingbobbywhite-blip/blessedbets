import QRCode from 'qrcode'

/**
 * A QR code drawn for a terminal, to be scanned off the screen by a phone, in
 * exact black and white rather than the theme's "black" and "white" (often
 * greys). Two ways to draw it:
 *
 * - full (compact: false): every square of the code is two character cells
 *   painted as background. No font, line spacing or theme can distort that, so
 *   it is the one to use whenever the window is big enough (about 37 lines).
 * - compact: two rows of the code per line of text, using a half-block
 *   character where the two differ. It fits a standard 24-line window, but only
 *   reads where the font draws that character as exactly the top half of the
 *   cell; with some fonts and line spacings it does not.
 */
export interface TerminalQr {
  lines: string[]
  /** Columns and rows the code takes on screen, margin included. */
  width: number
  height: number
  /** Squares along one side of the code itself. */
  size: number
  compact: boolean
}

const BLACK = '16'
const WHITE = '231'

export function terminalQr(
  text: string,
  opts: { margin?: number; compact?: boolean; errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' } = {},
): TerminalQr {
  const margin = opts.margin ?? 2
  const compact = opts.compact ?? true
  const qr = QRCode.create(text, { errorCorrectionLevel: opts.errorCorrectionLevel ?? 'M' })
  const size = qr.modules.size
  const dark = (row: number, col: number) => row >= 0 && col >= 0 && row < size && col < size && Boolean(qr.modules.data[row * size + col])
  const lines: string[] = []
  if (!compact) {
    for (let row = -margin; row < size + margin; row++) {
      let line = ''
      for (let col = -margin; col < size + margin; col++) line += `\x1b[48;5;${dark(row, col) ? BLACK : WHITE}m  `
      lines.push(line + '\x1b[0m')
    }
    return { lines, width: (size + margin * 2) * 2, height: lines.length, size, compact }
  }
  for (let row = -margin; row < size + margin; row += 2) {
    let line = ''
    for (let col = -margin; col < size + margin; col++) {
      const top = dark(row, col)
      const bottom = dark(row + 1, col)
      if (top === bottom) line += `\x1b[48;5;${top ? BLACK : WHITE}m `
      else line += `\x1b[38;5;${top ? BLACK : WHITE};48;5;${bottom ? BLACK : WHITE}m▀`
    }
    lines.push(line + '\x1b[0m')
  }
  return { lines, width: size + margin * 2, height: lines.length, size, compact }
}

/**
 * The drawing for this window: the full one when it fits (with `extraLines`
 * of text around it), else the compact one. `fits` is false when even that
 * is cut off.
 */
export function terminalQrFor(text: string, window: { rows?: number; columns?: number }, extraLines = 4): TerminalQr & { fits: boolean } {
  const full = terminalQr(text, { compact: false })
  if (window.rows && window.columns && window.rows >= full.height + extraLines && window.columns >= full.width) return { ...full, fits: true }
  const small = terminalQr(text, { compact: true })
  const fits = !window.rows || !window.columns || (window.rows >= small.height + extraLines && window.columns >= small.width)
  return { ...small, fits }
}

/** The same code as a page of its own: large, black on white, with the link underneath. */
export async function pairingPage(opts: { qrText: string; url: string; expiresAt: string }): Promise<string> {
  const svg = await QRCode.toString(opts.qrText, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
  const until = new Date(opts.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair a phone with Switchboard</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
         background: #fff; color: #15171c; font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; box-sizing: border-box; text-align: center; }
  h1 { font-size: 26px; margin: 0; }
  .qr { width: min(70vh, 86vw, 520px); }
  .qr svg { display: block; width: 100%; height: auto; }
  code { font: 15px ui-monospace, Menlo, monospace; background: #eef0f4; padding: 4px 8px; border-radius: 6px; overflow-wrap: anywhere; }
  p { margin: 0; max-width: 46ch; }
  .muted { color: #646b78; font-size: 15px; }
</style>
<h1>Point your phone's camera here</h1>
<div class="qr">${svg}</div>
<p>Tap the link that appears on the phone. It opens Switchboard, already signed in.</p>
<p class="muted">Or type this into the phone's browser:</p>
<div><code>${esc(opts.url)}</code></div>
<p class="muted">Works until ${esc(until)}. The phone needs the Tailscale app switched on.</p>
</html>
`
}
