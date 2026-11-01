import { BOOST_BAND, colourAt, type Pixels } from "./boost"
import type { OcrBox } from "./extract"

/**
 * Whether a leg hit, read off the ring around the player's picture.
 *
 * A PrizePicks entry screen rings each player green once the leg has hit and
 * red once it has missed, with a tick or a cross on the ring when the game is
 * over. Text recognition sees none of it — the number at the end of the
 * progress bar is in a coloured bubble it reads as junk — so a logged loss
 * used to arrive with every leg "Not settled", and unless each one was set by
 * hand it said nothing about which legs failed. That is the one question the
 * tracker exists to answer: "NBA unders 1-3" needs the results of the legs, not
 * just the entry.
 *
 * The colour is set when the leg is DECIDED, not when the game ends: on a real
 * screen, an under already past its line in the fourth quarter was ringed red
 * while its game was still live. That is the right reading, because an under
 * that has been crossed cannot come back. A leg still open is ringed in
 * neither colour and is left unsettled.
 *
 * Measured on two real entry screens, 1206 pixels wide: the ring sits at 13-24%
 * of the width and nothing else in that band is that green or that red — not
 * the Hawks' red, the Packers' green or a player's skin, which are all darker
 * than the ring's saturated lime and scarlet. The progress bar below a hit leg
 * is the same lime and starts in the same band, so rows it crosses are
 * skipped, the same way the goblin detector skips them.
 */

export type Outcome = "WIN" | "LOSS"

/** Where the ring sits, as fractions of the image width. */
export const RING_BAND = { from: 0.11, to: 0.26 }

/**
 * The outcome on the row a line sits in: WIN for a green ring, LOSS for a red
 * one, null for a row that was looked at and holds neither.
 *
 * Only the line's own rows are read, unpadded. A leg's name and stat rows
 * both cross the ring, so each gives an answer on its own; padding would reach
 * the progress bar of the leg above, whose colour is that leg's result.
 */
export function outcomeAt(px: Pixels, box: OcrBox): Outcome | null {
  const ya = Math.max(0, Math.floor(box.y0))
  const yb = Math.min(px.height, Math.ceil(box.y1))
  const rx0 = Math.floor(px.width * RING_BAND.from)
  const rx1 = Math.ceil(px.width * RING_BAND.to)
  const bx0 = Math.floor(px.width * BOOST_BAND.barFrom)
  const bx1 = Math.ceil(px.width * BOOST_BAND.barTo)
  const barRun = px.width * 0.05
  let green = 0
  let red = 0
  for (let y = ya; y < yb; y++) {
    let across = 0
    for (let x = bx0; x < bx1; x++) if (colourAt(px, x, y)) across++
    if (across > barRun) continue // a progress bar, not a ring
    for (let x = rx0; x < rx1; x++) {
      const c = colourAt(px, x, y)
      if (c === "green") green++
      else if (c === "red") red++
    }
  }
  // Two arcs of a ring about 0.5% of the width thick cross every row of a
  // line, so a 25-pixel row of text holds a few hundred. A stray pixel or two
  // of anti-aliasing must not settle a leg.
  const need = Math.max(12, px.width * 0.004 * Math.max(1, yb - ya) * 0.5)
  if (green >= need && green > red * 3) return "WIN"
  if (red >= need && red > green * 3) return "LOSS"
  return null
}

/**
 * Tag every positioned line with the outcome on its row. Lines with no
 * position are left without the field, so "unsettled" is only ever claimed
 * for a row that was actually looked at.
 */
export function tagOutcomes<L extends { bbox?: OcrBox; outcome?: Outcome | null }>(
  lines: L[],
  px: Pixels,
  scale = 1,
): L[] {
  return lines.map((l) => {
    if (!l.bbox) return l
    const b = l.bbox
    return { ...l, outcome: outcomeAt(px, { x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale }) }
  })
}
