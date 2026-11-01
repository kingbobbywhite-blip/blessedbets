import type { OcrBox } from "./extract"

/**
 * Goblins and demons, found by colour.
 *
 * PrizePicks marks a boosted pick with a small face beside its line: a green
 * goblin (an easier line that pays less) or a red demon (a harder one that
 * pays more). Text recognition cannot tell them apart; both come out as "O",
 * "W" or "@". Their colours can: nothing else in the line box is that green
 * or that red. And it matters: on fifteen real entries, goblins hit 16 of 19
 * while standard picks went 4 of 13, and the payout was cut to match.
 *
 * The face sits in the line box at the right of the leg's row, just left of
 * the arrow and the value. So for each OCR line that ends in a number, look
 * in that band of the row for saturated green or red. Rows a progress bar
 * crosses are skipped: a bar is coloured all the way across, a face is not.
 */

export type Boost = "goblin" | "demon"

export interface Pixels {
  width: number
  height: number
  /** RGBA, row-major, 4 bytes a pixel, like ImageData.data. */
  data: Uint8ClampedArray | Uint8Array | number[]
}

/**
 * Where to look, as fractions of the image width. Measured on real entry
 * screens: the face sits at 68-72%. A progress bar is told apart by a long
 * coloured run between the avatar, whose ring and jersey are green or red
 * too, and the line box; on a name row that stretch holds only white text.
 */
export const BOOST_BAND = { from: 0.6, to: 0.78, barFrom: 0.27, barTo: 0.6 }

const isGreen = (r: number, g: number, b: number) => g > 150 && g - r > 50 && g - b > 80
const isRed = (r: number, g: number, b: number) => r > 170 && r - g > 90 && r - b > 90

export function colourAt(px: Pixels, x: number, y: number): "green" | "red" | null {
  const i = (y * px.width + x) * 4
  const r = px.data[i]
  const g = px.data[i + 1]
  const b = px.data[i + 2]
  return isGreen(r, g, b) ? "green" : isRed(r, g, b) ? "red" : null
}

/**
 * The boost on the row a line sits in, or null for a standard pick.
 *
 * `box` is in the image's own pixels. OCR sometimes folds the avatar into a
 * line and returns a box two rows tall, reaching the progress bar of the leg
 * above or below. So pixel rows a bar crosses are skipped one by one rather
 * than the line given up on, and the area a face needs is scaled to a line
 * of text, not to the box.
 */
export function boostAt(px: Pixels, box: OcrBox): Boost | null {
  const h = Math.max(1, box.y1 - box.y0)
  const text = Math.min(h, px.width * 0.035)
  const pad = h < px.width * 0.035 ? h * 0.25 : 0
  const ya = Math.max(0, Math.floor(box.y0 - pad))
  const yb = Math.min(px.height, Math.ceil(box.y1 + pad))
  const bx0 = Math.floor(px.width * BOOST_BAND.barFrom)
  const bx1 = Math.ceil(px.width * BOOST_BAND.barTo)
  const fx0 = Math.floor(px.width * BOOST_BAND.from)
  const fx1 = Math.ceil(px.width * BOOST_BAND.to)
  const barRun = px.width * 0.05
  let green = 0
  let red = 0
  for (let y = ya; y < yb; y++) {
    let across = 0
    for (let x = bx0; x < bx1; x++) if (colourAt(px, x, y)) across++
    if (across > barRun) continue // a progress bar, not a face
    for (let x = fx0; x < fx1; x++) {
      const c = colourAt(px, x, y)
      if (c === "green") green++
      else if (c === "red") red++
    }
  }
  const need = Math.max(12, text * text * 0.06)
  if (green >= need && green > red * 2) return "goblin"
  if (red >= need && red > green * 2) return "demon"
  return null
}

/**
 * Tag each line that ends in a number with the boost on its row: a goblin, a
 * demon, or null for a row that was checked and holds neither. Lines not
 * checked are left without the field, so "standard" is only ever claimed
 * for a row that was actually looked at.
 */
export function tagBoosts<L extends { text: string; bbox?: OcrBox; boost?: Boost | null }>(
  lines: L[],
  px: Pixels,
  scale = 1,
): L[] {
  return lines.map((l) => {
    if (!l.bbox || !/\d\s*$/.test(l.text)) return l
    const b = l.bbox
    return { ...l, boost: boostAt(px, { x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale }) }
  })
}
