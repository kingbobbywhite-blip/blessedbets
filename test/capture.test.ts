import { afterEach, describe, expect, it, vi } from "vitest"
import { extractProps, linesFromText, mergeReads, readEntryHeader, type OcrLine, type PropCandidate } from "@/lib/ocr/extract"
import { PAGE_SEG_MODE } from "@/lib/ocr/engine"
import grid from "./fixtures/ocr/board-grid.json"
import list from "./fixtures/ocr/board-list.json"
import hard from "./fixtures/ocr/board-hard.json"
import lineup from "./fixtures/ocr/real-prizepicks-lineup.json"
import settledAddison from "./fixtures/ocr/settled-nfl-addison.json"
import settledOtton from "./fixtures/ocr/settled-nfl-otton.json"
import settledJuszczyk from "./fixtures/ocr/settled-nfl-juszczyk.json"
import settledBlack from "./fixtures/ocr/settled-nfl-black.json"
import settledIriafen from "./fixtures/ocr/settled-wnba-iriafen.json"
import nightStewart from "./fixtures/ocr/settled-wnba-stewart-power.json"
import nightLoyd from "./fixtures/ocr/settled-wnba-loyd-flex.json"
import nightWilliams from "./fixtures/ocr/settled-wnba-williams-power.json"
import nightMitchell from "./fixtures/ocr/settled-wnba-mitchell-flex.json"
import nightMeidroth from "./fixtures/ocr/settled-mixed-meidroth-power.json"
import nflJudkins from "./fixtures/ocr/settled-mixed-judkins-power.json"
import nflJeudy from "./fixtures/ocr/settled-nfl-jeudy-power.json"
import nflRodgers from "./fixtures/ocr/settled-nfl-rodgers-power.json"
import wnbaGray from "./fixtures/ocr/settled-wnba-gray-power.json"
import wnbaLoydPaid from "./fixtures/ocr/settled-wnba-loyd-paid.json"
import nflWaller from "./fixtures/ocr/settled-nfl-waller-goblins.json"
import nbaFears from "./fixtures/ocr/open-nba-fears-power.json"
import { draftFromCandidate } from "@/lib/tracker/entries"
import { outcomeAt, tagOutcomes } from "@/lib/ocr/ring"
import type { Pixels } from "@/lib/ocr/boost"

/**
 * Capture-a-slate regression tests.
 *
 * The fixtures are real Tesseract output, not hand-written text: three phone
 * screenshots of rendered boards, run through the same segmentation mode and
 * block walk as lib/ocr/engine.ts, positions included. They pin the two
 * failures that made capture return nothing, or worse, the wrong thing:
 *
 *   - SINGLE_BLOCK segmentation merged grid columns and dropped every line
 *     value, so a PrizePicks screenshot produced zero props.
 *   - AUTO segmentation fixed that but emits a list board's right-aligned values
 *     after all the names, so pairing by output order pinned each value to the
 *     wrong player. Pairing by position fixes it.
 *
 * Every assertion is on the full set, so a wrong pairing fails as loudly as a
 * missing one.
 */

const props = (lines: OcrLine[]) =>
  extractProps(lines)
    .candidates.map((c) => `${c.player} | ${c.line} | ${c.marketKey}`)
    .sort()

describe("OCR engine configuration", () => {
  it("uses AUTO page segmentation, not tesseract.js's SINGLE_BLOCK default", () => {
    // SINGLE_BLOCK is what broke capture. Changing this back fails every
    // screenshot test below as well, but this names the cause.
    expect(PAGE_SEG_MODE).toBe("3")
  })
})

describe("real OCR output", () => {
  it("reads a two-column PrizePicks grid", () => {
    expect(props(grid as OcrLine[])).toEqual([
      "Anthony Edwards | 3.5 | 3PM",
      "LeBron James | 24.5 | PTS",
      "Nikola Jokic | 12.5 | REB",
      "Stephen Curry | 27.5 | PTS",
    ])
  })

  it("pairs a list board's right-aligned values with the right player", () => {
    // The regression: Clark's 8.5 Assists used to land on Breanna Stewart.
    expect(props(list as OcrLine[])).toEqual([
      "Aja Wilson | 24.5 | PTS",
      "Breanna Stewart | 32.5 | PRA",
      "Caitlin Clark | 8.5 | AST",
    ])
  })

  it("survives badges, a filter bar of stat words, hyphens, apostrophes and combo stats", () => {
    // The regression: "Blocked Shots" read as a name and took Collier's line.
    expect(props(hard as OcrLine[])).toEqual([
      "A'ja Wilson | 38.5 | PRA",
      "Breanna Stewart | 9.5 | REB",
      "Brittney Griner | 1.5 | BLK",
      "Caitlin Clark | 8.5 | AST",
      "Napheesa Collier | 2.5 | 3PM",
      "Skylar Diggins-Smith | 14.5 | PTS",
    ])
  })

  it("reads a real PrizePicks entry screen: name and arrowed value on one row, stat below", () => {
    // A user's own screenshot, cleaned up the way the engine does it. The
    // arrow reads as "T" or "7" and the decimal point is often lost, so every
    // value here is a repair and every one must be flagged for checking.
    const c = extractProps(lineup as OcrLine[]).candidates
    expect(c.map((x) => `${x.player} | ${x.line} | ${x.marketKey}`).sort()).toEqual([
      "Jonquel Jones | 1.5 | AST",
      "Leonie Fiebich | 0.5 | 3PM",
      "Napheesa Collier | 1.5 | AST",
      "Olivia Miles | 0.5 | 3PM",
    ])
    expect(c.every((x) => x.issues.some((i) => /Check it against the app/.test(i)))).toBe(true)
  })

  it("never pairs a value with a player below it", () => {
    // Positions without the name above them: nothing is the right answer.
    const lines: OcrLine[] = [
      { text: "24.5 Points", bbox: { x0: 800, y0: 50, x1: 1100, y1: 90 } },
      { text: "LeBron James", bbox: { x0: 50, y0: 200, x1: 300, y1: 240 } },
    ]
    expect(extractProps(lines).candidates).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Settled PrizePicks entry screens.
//
// Real phone screenshots of five settled entries (four NFL, one WNBA, from
// before the WNBA was dropped as a league: the reader still has to read it), read by
// the app's own OCR in a browser, both the raw and the cleaned-up pass. Before
// these, capture got 0 props from two of them and the wrong value from most of
// the rest. What the reads have in common:
//
//   - The up/down arrow before the line comes out as junk: "tT", "oT", "St",
//     "*", '"', "T" for up; "J", "wv", "oY", "U", "\" for down. It usually
//     swallows the decimal point too: 44.5 reads "445", 0.5 reads "05".
//   - The stat shares a row with "TEAM - POS - #N", and receptions print "Recs".
//   - Jersey numbers and icons leave junk before the name: "99 Brock Bowers".
//   - A player who did not play is marked "Reboot".
//
// The arrow is also the only record of which side was taken, so it is read
// where it can be, and left blank rather than guessed where it cannot.
// ---------------------------------------------------------------------------

type Read = { raw: OcrLine[]; cleaned: OcrLine[] }
const both = (r: Read) => mergeReads(extractProps(r.raw).candidates, extractProps(r.cleaned).candidates)
const legs = (r: Read) =>
  both(r)
    .map((c) => `${c.player} | ${c.line} | ${c.marketKey} | ${c.side ?? "?"}${c.dnp ? " | DNP" : ""}`)
    .sort()

describe("settled PrizePicks entry screens", () => {
  it("reads an NFL entry with a receptions under, a rushing over and a Reboot", () => {
    expect(legs(settledAddison as Read)).toEqual([
      "Jack Bech | 0.5 | REC_YDS | OVER | DNP",
      "Jordan Addison | 5.5 | REC | UNDER",
      "Tyler Allgeier | 2.5 | RUSH_YDS | OVER",
    ])
  })

  it("reads all three unders, including two whose stat is only 'Recs'", () => {
    expect(legs(settledOtton as Read)).toEqual([
      "Brock Bowers | 9.5 | REC | UNDER",
      "Cade Otton | 65.5 | REC_YDS | UNDER",
      "George Pickens | 5.5 | REC | UNDER",
    ])
  })

  it("restores the decimal an arrow swallowed, and picks the better spelling of a name", () => {
    expect(legs(settledJuszczyk as Read)).toEqual([
      "Jack Bech | 4.5 | REC_YDS | OVER | DNP",
      "Kyle Juszczyk | 0.5 | REC_YDS | OVER",
      "Tyler Shough | 44.5 | RUSH_YDS | UNDER",
    ])
  })

  it("reads what is on screen and reports the players whose line it could not see", () => {
    // Neither read caught Michael Wilson's or Brock Bowers's line, so they are
    // not invented; they are listed so the tracker can ask for them.
    expect(legs(settledBlack as Read)).toEqual(["Kaelon Black | 14.5 | RUSH_YDS | OVER"])
    const r = settledBlack as Read
    const missing = new Set([...extractProps(r.raw).unpairedNames, ...extractProps(r.cleaned).unpairedNames])
    expect(missing).toContain("Michael Wilson")
    expect(missing).toContain("Brock Bowers")
  })

  it("reads a WNBA entry, including a whole-number line and an l misread for I", () => {
    expect(legs(settledIriafen as Read)).toEqual([
      "Jessica Shepard | 4.5 | AST | OVER",
      "Kiki Iriafen | 9 | REB | OVER",
      "Paige Bueckers | 2.5 | REB | OVER",
      "Sonia Citron | 3.5 | AST | OVER",
    ])
  })

  it("reads the stake, the payout and the entry type from the header", () => {
    // Every one of these was marked Loss, so each paid nothing. The raw read
    // of Addison's screen turned the badge into "Less".
    expect(readEntryHeader((settledAddison as Read).raw)).toEqual({ stake: 2, payout: 12, paid: 0, picks: 3, mode: "power" })
    expect(readEntryHeader((settledOtton as Read).raw)).toEqual({ stake: 1, payout: 5.5, paid: 0, picks: 3, mode: "power" })
    expect(readEntryHeader((settledIriafen as Read).raw)).toEqual({ stake: 4, payout: 26.1, paid: 0, picks: 4, mode: "power" })
    // The cleaned pass reads "$" as "S": "Dp S1 for S6".
    expect(readEntryHeader((settledBlack as Read).cleaned)).toEqual({ stake: 1, payout: 6, paid: 0, picks: 3, mode: "power" })
  })
})

// ---------------------------------------------------------------------------
// One night of settled entries: five PrizePicks screens, four WNBA and one
// mixed with baseball, read the same way. What they added to the list above:
//
//   - The up arrow also reads as "r", glued to the value: "Or15", "Oo r75".
//   - A goblin or demon icon sits before the arrow and reads as letters,
//     "OW", "Ow", "Oo", "OS", "w". Read as a whole, "OW r15" took its W for a
//     down arrow and recorded an over as an under.
//   - A lone "v" before the value is the down arrow, not the name suffix V.
//   - A settled entry that paid shows "$10 paid $5", not "$10 for $X".
//   - Baseball legs share entries with basketball ones.
// ---------------------------------------------------------------------------

describe("a night of settled entries", () => {
  it("reads a 3-pick power play of unders", () => {
    expect(legs(nightStewart as Read)).toEqual([
      "Breanna Stewart | 3.5 | AST | UNDER",
      "Courtney Williams | 4 | AST | UNDER",
      "Marine Johannes | 4.5 | PTS | UNDER",
    ])
  })

  it("reads a 6-pick flex of goblins and a demon", () => {
    expect(legs(nightLoyd as Read)).toEqual([
      "Jewell Loyd | 0.5 | 3PM | OVER",
      "Jonquel Jones | 1.5 | 3PM | OVER",
      "Kayla McBride | 1.5 | REB | OVER",
      "Kelsey Mitchell | 1.5 | REB | UNDER",
      "Leonie Fiebich | 0.5 | 3PM | OVER",
      "Olivia Miles | 0.5 | 3PM | OVER",
    ])
  })

  it("reads a 2-pick power play", () => {
    expect(legs(nightWilliams as Read)).toEqual([
      "Courtney Williams | 4 | AST | UNDER",
      "Marine Johannes | 4.5 | PTS | UNDER",
    ])
  })

  it("reads the other side of the same line in another entry as an over", () => {
    // The regression: "Kelsey Mitchell OW r15" is a goblin then an up arrow,
    // and came out UNDER, which hid that she was on both sides of 1.5.
    // Jones "OW v 25" read as 25 assists; Fiebich's raw 35 rebounds loses to
    // the cleaned 3.5; Hull's "v.25" is 2.5, not the cleaned 12.5.
    expect(legs(nightMitchell as Read)).toEqual([
      "Jonquel Jones | 2.5 | AST | UNDER",
      "Kelsey Mitchell | 1.5 | REB | OVER",
      "Leonie Fiebich | 3.5 | REB | UNDER",
      "Lexie Hull | 2.5 | REB | UNDER",
      "Napheesa Collier | 2.5 | AST | UNDER",
      "Olivia Miles | 6.5 | AST | UNDER",
    ])
  })

  it("keeps baseball legs in a mixed entry, unpriced, instead of dropping them", () => {
    const c = both(nightMeidroth as Read)
    expect(c.map((x) => `${x.player} | ${x.line} | ${x.marketKey ?? x.marketLabel} | ${x.side ?? "?"}`).sort()).toEqual([
      // The arrow on Wilson's row read as a "4": "A'ja Wilson 4 42.5".
      "A'ja Wilson | 42.5 | PRA | OVER",
      "Breanna Stewart | 33 | PR | OVER",
      "Chase Meidroth | 4.5 | Hitter Fantasy Score | OVER",
      "Christian Walker | 1.5 | Hits + Runs + RBIs | OVER",
      "Jackie Young | 7.5 | AST | OVER",
      "Pauline Astier | 7.5 | RA | OVER",
    ])
    const meidroth = c.find((x) => x.player === "Chase Meidroth")!
    expect(meidroth.issues.join(" ")).toMatch(/not a stat this app models/)
  })

  it("reads what a settled entry paid, and a Loss as paying nothing", () => {
    const h = (r: Read) => readEntryHeader(r.raw, r.cleaned)
    expect(h(nightStewart as Read)).toEqual({ stake: 5, payout: 30, paid: 0, picks: 3, mode: "power" })
    expect(h(nightWilliams as Read)).toEqual({ stake: 5, payout: 15, paid: 0, picks: 2, mode: "power" })
    expect(h(nightMeidroth as Read)).toEqual({ stake: 5, payout: 305, paid: 0, picks: 6, mode: "power" })
    // Flex entries under a Win badge that returned less than the stake.
    expect(h(nightLoyd as Read)).toEqual({ stake: 10, payout: null, paid: 5, picks: 6, mode: "flex" })
    expect(h(nightMitchell as Read)).toEqual({ stake: 5, payout: null, paid: 2, picks: 6, mode: "flex" })
  })

  it("takes the side from the arrow nearest the value, not the icon before it", () => {
    const one = (text: string, stat: string) => extractProps([{ text }, { text: stat }]).candidates[0]
    expect(one("Kelsey Mitchell OW r15", "IND-G- #0 Rebounds").side).toBe("OVER")
    expect(one("Jackie Young Oo r75", "LVA-G- #0 Assists").side).toBe("OVER")
    expect(one("Napheesa Collier OS v25", "MIN-F- #24 Assists").side).toBe("UNDER")
    // The old reads still hold: "wv" is a down arrow, "tT" an up one.
    expect(one("Cade Otton wv 655", "TB-TE- #88 Rec Yards").side).toBe("UNDER")
    expect(one("Olivia Miles @ tT 05", "MIN-G- #5 3PTM").side).toBe("OVER")
  })
})

// ---------------------------------------------------------------------------
// A second night: five power plays, NFL and WNBA, the fixtures tagged with the
// goblin and demon faces the engine finds by colour. New here:
//
//   - The up arrow reads as a "4", alone ("Kelsey Mitchell 4 15") or glued
//     on ("415"); the down arrow sometimes as a "1", or swallows the 1 of a
//     1.5 ("vi5").
//   - "KC" opens a name and is also a team code.
//   - A promo line struck through to 0.5 ("A'ja Wilson 42.5 0.5"): the new
//     line is the one that counts.
// ---------------------------------------------------------------------------

const typed = (r: Read) =>
  both(r)
    .map((c) => `${c.player} | ${c.line} | ${c.marketKey ?? c.marketLabel} | ${c.side ?? "?"} | ${c.boost ?? "standard"}`)
    .sort()

describe("a second night, with goblins and demons", () => {
  it("reads an NFL and WNBA 4-pick, a demon and a promo line among them", () => {
    expect(typed(nflJudkins as Read)).toEqual([
      // A 0.5 promo line, struck through from 42.5; no arrow survived either read.
      "A'ja Wilson | 0.5 | PRA | ? | standard",
      "Cheyenne Parker-Tyus | 3.5 | REB | UNDER | standard",
      // A demon over; its arrow read as nothing at all.
      "Michael Pittman Jr. | 3.5 | REC | ? | demon",
      "Quinshon Judkins | 12.5 | REC_YDS | UNDER | standard",
    ])
  })

  it("reads three goblins and two standard picks, Rodgers' over among them", () => {
    expect(typed(nflJeudy as Read)).toEqual([
      "Aaron Rodgers | 1.5 | RUSH_YDS | OVER | standard",
      "DK Metcalf | 2.5 | REC | OVER | goblin",
      "Jaylen Warren | 2.5 | REC | OVER | goblin",
      "Jerry Jeudy | 0.5 | REC | OVER | goblin",
      "Michael Pittman Jr. | 3.5 | REC | UNDER | standard",
    ])
  })

  it("keeps initials that spell a team: KC Concepcion Jr.", () => {
    expect(typed(nflRodgers as Read)).toEqual([
      "Aaron Rodgers | 1.5 | RUSH_YDS | UNDER | standard",
      "Deshaun Watson | 33.5 | RUSH_YDS | UNDER | goblin",
      "KC Concepcion Jr. | 38.5 | REC_YDS | UNDER | goblin",
    ])
  })

  it("reads the up arrow when it comes out as a 4", () => {
    expect(typed(wnbaGray as Read)).toEqual([
      "Chelsea Gray | 0.5 | 3PM | OVER | goblin",
      "Jackie Young | 1.5 | 3PM | OVER | goblin",
      "Jackie Young | 20.5 | PTS | OVER | standard",
      "Kelsey Mitchell | 1.5 | AST | OVER | goblin",
      "Lexie Hull | 0.5 | AST | OVER | goblin",
    ])
  })

  it("reads 415 rebounds as an up arrow and 1.5, and vi5 as a down arrow and 1.5", () => {
    expect(typed(wnbaLoydPaid as Read)).toEqual([
      "Jewell Loyd | 0.5 | 3PM | OVER | goblin",
      "Kelsey Mitchell | 1.5 | REB | OVER | standard",
      "Sophie Cunningham | 1.5 | 3PM | UNDER | goblin",
    ])
    expect(readEntryHeader((wnbaLoydPaid as Read).raw, (wnbaLoydPaid as Read).cleaned)).toEqual({
      stake: 3, payout: null, paid: 9, picks: 3, mode: "power",
    })
  })

  it("finds the faces on the first night too", () => {
    expect(typed(nightMitchell as Read).map((s) => s.split(" | ").slice(0, 1).concat(s.split(" | ").slice(4)).join(" "))).toEqual([
      "Jonquel Jones goblin",
      "Kelsey Mitchell goblin",
      "Leonie Fiebich demon",
      "Lexie Hull demon",
      "Napheesa Collier demon",
      "Olivia Miles goblin",
    ])
  })

  it("leaves the pick type unknown on a read with no colour", () => {
    expect(both(settledAddison as Read).every((c) => c.boost === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A third night: two 4-pick power plays, read by the engine with the ring
// colours tagged as well as the faces. New here:
//
//   - An entry still in play says "$3.75 to win $24.38", not "$X for $Y", and
//     the header reader returned nothing for it: no stake, no payout.
//   - Each player's ring is green once the leg hits and red once it misses —
//     including an under crossed in the fourth quarter of a game still live.
//     Before this, every leg of a logged loss came in "Not settled".
// ---------------------------------------------------------------------------

const settled = (r: Read) =>
  both(r)
    .map((c) => `${c.player} | ${c.line} | ${c.marketKey} | ${c.side ?? "?"} | ${c.boost ?? "standard"} | ${c.outcome ?? "open"}`)
    .sort()

describe("a third night, with each leg's result read off its ring", () => {
  it("reads four NFL goblins, three of them on one team's tight ends, and which two missed", () => {
    expect(settled(nflWaller as Read)).toEqual([
      "Darren Waller | 2.5 | REC | UNDER | goblin | WIN",
      "MarShawn Lloyd | 0.5 | REC | OVER | goblin | WIN",
      "Mitchell Evans | 1.5 | REC | UNDER | goblin | LOSS",
      "Tommy Tremble | 1.5 | REC | OVER | goblin | LOSS",
    ])
    // Four goblins took a 10x 4-pick to 4x: each leg needed 70.7% to break even.
    expect(readEntryHeader((nflWaller as Read).raw, (nflWaller as Read).cleaned)).toEqual({
      stake: 10, payout: 40, paid: 0, picks: 4, mode: "power",
    })
  })

  it("reads an NBA entry still in play: four unders, two goblins, an under crossed in the fourth", () => {
    expect(settled(nbaFears as Read)).toEqual([
      "Donovan Clingan | 10.5 | PTS | UNDER | standard | LOSS",
      "Jalen Johnson | 21.5 | PTS | UNDER | standard | WIN",
      "Jeremiah Fears | 3.5 | AST | UNDER | goblin | LOSS",
      "Zion Williamson | 3.5 | AST | UNDER | goblin | WIN",
    ])
  })

  it('reads "$3.75 to win $24.38" as the all-hit return, with no result yet', () => {
    expect(readEntryHeader((nbaFears as Read).raw, (nbaFears as Read).cleaned)).toEqual({
      stake: 3.75, payout: 24.38, paid: null, picks: 4, mode: "power",
    })
    expect(readEntryHeader(linesFromText("S5 to win S50\n4-Pick Power Play"))).toEqual({
      stake: 5, payout: 50, paid: null, picks: 4, mode: "power",
    })
  })

  it("never tags a header row with a result", () => {
    for (const r of [nflWaller, nbaFears] as Read[]) {
      for (const l of [...r.raw, ...r.cleaned]) {
        if (/Power Play|\$|Final|Q4|Entry/.test(l.text)) expect(l.outcome ?? null).toBeNull()
      }
    }
  })

  it("logs the ring's result, and lets a Reboot outrank it", () => {
    const [waller] = both(nflWaller as Read).filter((c) => c.player === "Darren Waller")
    expect(draftFromCandidate(waller).result).toBe("WIN")
    expect(draftFromCandidate({ ...waller, outcome: "LOSS" }).result).toBe("LOSS")
    expect(draftFromCandidate({ ...waller, outcome: null }).result).toBe("PENDING")
    expect(draftFromCandidate({ ...waller, outcome: "WIN", dnp: true }).result).toBe("VOID")
  })

  it("claims nothing when the two reads see different colours", () => {
    const c = (outcome: "WIN" | "LOSS"): PropCandidate => ({
      player: "Jalen Johnson", marketKey: "PTS", marketLabel: "Points", rawMarket: "Points", line: 21.5,
      confidence: 0.9, sourceLines: [0], issues: [], outcome,
    })
    expect(mergeReads([c("WIN")], [c("WIN")])[0].outcome).toBe("WIN")
    expect(mergeReads([c("WIN")], [c("LOSS")])[0].outcome).toBeNull()
    expect(mergeReads([{ ...c("WIN"), outcome: undefined }], [c("LOSS")])[0].outcome).toBe("LOSS")
  })
})

describe("finding a leg's result by the colour of its ring", () => {
  const W = 1000
  const H = 300
  const LIME: [number, number, number] = [108, 240, 20]
  const SCARLET: [number, number, number] = [235, 50, 60]
  function screen(paint: (x: number, y: number) => [number, number, number] | null): Pixels {
    const data = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const c = paint(x, y) ?? [24, 24, 36]
        data.set([c[0], c[1], c[2], 255], i)
      }
    }
    return { width: W, height: H, data }
  }
  // A ring 5 pixels thick, centred at 18.5% of the width.
  const ring = (colour: [number, number, number]) => (x: number, y: number) => {
    const d = Math.hypot(x - 185, y - 150)
    return d >= 50 && d < 55 ? colour : null
  }
  const nameRow = { x0: 250, y0: 120, x1: 700, y1: 145 }

  it("reads green as a hit, red as a miss, and neither as open", () => {
    expect(outcomeAt(screen(ring(LIME)), nameRow)).toBe("WIN")
    expect(outcomeAt(screen(ring(SCARLET)), nameRow)).toBe("LOSS")
    expect(outcomeAt(screen(ring([200, 200, 200])), nameRow)).toBeNull()
  })

  it("is not fooled by the green progress bar of the leg above", () => {
    // A hit's bar runs lime from the ring's band right across the row.
    const bar = (x: number, y: number) => (y >= 120 && y < 130 && x > 132 && x < 900 ? LIME : null)
    expect(outcomeAt(screen((x, y) => bar(x, y) ?? ring(SCARLET)(x, y)), nameRow)).toBe("LOSS")
    expect(outcomeAt(screen(bar), { ...nameRow, y1: 130 })).toBeNull()
  })

  it("ignores a coloured face out at the line value", () => {
    const face = (x: number, y: number) => (x >= 690 && x < 720 && y >= 120 && y < 145 ? SCARLET : null)
    expect(outcomeAt(screen(face), nameRow)).toBeNull()
  })

  it("scales a box from the cleaned read back to the original pixels", () => {
    const px = screen(ring(LIME))
    const lines: OcrLine[] = [{ text: "Jalen Johnson V 21.5", bbox: { x0: 500, y0: 240, x1: 1400, y1: 290 } }, { text: "typed" }]
    const [tagged, typed] = tagOutcomes(
      lines,
      px,
      2,
    )
    expect(tagged.outcome).toBe("WIN")
    expect("outcome" in typed).toBe(false)
  })
})

describe("merging the raw and cleaned reads", () => {
  const cand = (player: string, line: number): PropCandidate => ({
    player, marketKey: "PTS", marketLabel: "Points", rawMarket: "Points", line,
    confidence: 0.9, sourceLines: [0], issues: [],
  })

  it("keeps one copy when the reads agree", () => {
    expect(mergeReads([cand("LeBron James", 24.5)], [cand("LeBron James", 24.5)])).toHaveLength(1)
  })

  it("keeps the raw value and flags it when the reads disagree", () => {
    // Measured: cleanup turned a large 3.5 into 3.9. Never pick silently.
    const [m] = mergeReads([cand("Anthony Edwards", 3.5)], [cand("Anthony Edwards", 3.9)])
    expect(m.line).toBe(3.5)
    expect(m.issues.join(" ")).toMatch(/disagree: 3.5 and 3.9/)
  })

  it("prefers the read that kept its decimal point", () => {
    // 35 rebounds is not a line anyone posts; 3.5 is. And 25 beside 2.5 is
    // the same digits with the point lost.
    const reb = (line: number): PropCandidate => ({ ...cand("Leonie Fiebich", line), marketKey: "REB", marketLabel: "Rebounds" })
    const [a] = mergeReads([reb(35)], [reb(3.5)])
    expect(a.line).toBe(3.5)
    expect(a.issues.join(" ")).toMatch(/Took 3.5/)
    const [b] = mergeReads([cand("Marine Johannes", 45)], [cand("Marine Johannes", 4.5)])
    expect(b.line).toBe(4.5)
    // Whole-number lines exist. A 3.3 is not a line, so 33 stays.
    const [c] = mergeReads([cand("Breanna Stewart", 33)], [cand("Breanna Stewart", 3.3)])
    expect(c.line).toBe(33)
  })

  it("adds props only the cleaned read found", () => {
    expect(mergeReads([], [cand("Olivia Miles", 0.5)]).map((c) => c.player)).toEqual(["Olivia Miles"])
  })
})

describe("typed and pasted text", () => {
  const typed = (t: string) => props(linesFromText(t))

  it("reads one prop per line", () => {
    expect(typed("LeBron James 24.5 Points\nStephen Curry 27.5 Points")).toEqual([
      "LeBron James | 24.5 | PTS",
      "Stephen Curry | 27.5 | PTS",
    ])
  })

  it("ignores over/under and accepts shorthand", () => {
    expect(typed("Caitlin Clark over 8.5 assists\nLeBron James o24.5 pts\nJalen Brunson u6.5 ast")).toEqual([
      "Caitlin Clark | 8.5 | AST",
      "Jalen Brunson | 6.5 | AST",
      "LeBron James | 24.5 | PTS",
    ])
  })

  it("accepts the stat before the value, and separators", () => {
    expect(typed("LeBron James: Points 24.5\nShai Gilgeous-Alexander - 31.5 - Pts+Rebs+Asts")).toEqual([
      "LeBron James | 24.5 | PTS",
      "Shai Gilgeous-Alexander | 31.5 | PRA",
    ])
  })

  it("accepts comma-separated lines with no header", () => {
    expect(typed("LeBron James, 24.5, Points")).toEqual(["LeBron James | 24.5 | PTS"])
  })

  it("capitalises a lowercase name", () => {
    expect(typed("lebron james 24.5 points")).toEqual(["Lebron James | 24.5 | PTS"])
  })

  it("keeps the full stop in Jr. and initials", () => {
    expect(typed("Jaren Jackson Jr. 1.5 Blocks\nP.J. Washington 6.5 Rebounds")).toEqual([
      "Jaren Jackson Jr. | 1.5 | BLK",
      "P.J. Washington | 6.5 | REB",
    ])
  })

  it("finds the name after leading junk such as a date", () => {
    expect(typed("Tue Sep 26 Tyrese Haliburton 2.5 threes")).toEqual(["Tyrese Haliburton | 2.5 | 3PM"])
  })

  it("flags a surname-only entry for review instead of guessing", () => {
    const c = extractProps(linesFromText("jokic 12.5 reb")).candidates
    expect(c).toHaveLength(1)
    expect(c[0].issues.join(" ")).toMatch(/full name/)
  })

  it("still reads the stacked layout", () => {
    expect(typed("LAL - F\nLeBron James\nvs GSW Tue 7:30pm\n24.5\nPoints\nLess\nMore")).toEqual([
      "LeBron James | 24.5 | PTS",
    ])
  })

  it("reads name and value on one line with the stat on the next", () => {
    expect(typed("Jonquel Jones 1.5\nAssists\nOlivia Miles 0.5\n3PTM")).toEqual([
      "Jonquel Jones | 1.5 | AST",
      "Olivia Miles | 0.5 | 3PM",
    ])
  })

  it("reads NFL props, including three-digit yardage lines", () => {
    expect(
      typed(
        "Josh Allen Pass Yards 245.5\nTravis Kelce over 5.5 Receptions\nJames Cook 68.5 Rush Yds\n" +
          "Amon-Ra St. Brown Receiving Yards 79.5\nSaquon Barkley Rush + Rec Yds 120.5\nC.J. Stroud 1.5 Pass TDs",
      ),
    ).toEqual([
      "Amon-Ra St. Brown | 79.5 | REC_YDS",
      "C.J. Stroud | 1.5 | PASS_TDS",
      "James Cook | 68.5 | RUSH_YDS",
      "Josh Allen | 245.5 | PASS_YDS",
      "Saquon Barkley | 120.5 | RUSH_REC_YDS",
      "Travis Kelce | 5.5 | REC",
    ])
  })

  it("lets the stat decide whether a leading 7 is the arrow", () => {
    // 71.5 assists is impossible, so the 7 was the up-arrow and the line is 1.5.
    // 72.5 receiving yards is an ordinary line and must be left alone.
    expect(typed("Jonquel Jones 71.5\nNYL - C - #35 Assists\nJustin Jefferson 72.5\nMIN - WR - #18 Receiving Yards")).toEqual([
      "Jonquel Jones | 1.5 | AST",
      "Justin Jefferson | 72.5 | REC_YDS",
    ])
  })

  it("reads the side a person typed, for logging an entry", () => {
    const sides = extractProps(linesFromText("Jordan Addison under 5.5 Recs\nTyler Allgeier over 2.5 Rush Yards\nKiki Iriafen 9 Rebounds"))
      .candidates.map((c) => `${c.player} | ${c.side ?? "?"}`)
      .sort()
    expect(sides).toEqual(["Jordan Addison | UNDER", "Kiki Iriafen | ?", "Tyler Allgeier | OVER"])
  })

  it("does not read a bare three-digit number as a line", () => {
    // A $100 entry or a 250 payout on a board must not become a prop.
    expect(typed("LeBron James 250 Points")).toEqual([])
  })

  it("returns nothing for text with no prop in it", () => {
    expect(typed("hello this is not a prop")).toEqual([])
  })
})

describe("/api/odds", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function stubFeed(events: { id: string; commence_time: string }[]) {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url)
        const body = url.includes("/odds?")
          ? { id: "x", home_team: "H", away_team: "A", commence_time: "", bookmakers: [] }
          : events.map((e) => ({ ...e, home_team: "H", away_team: "A", sport_key: "k" }))
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "x-requests-remaining": "400", "x-requests-used": "100" },
        })
      }),
    )
    return urls
  }

  const post = async (body: object) => {
    const { POST } = await import("@/app/api/odds/route")
    // As the Import page sends it: the route refuses anything that is not JSON.
    return POST(
      new Request("http://t/api/odds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "k", ...body }),
      }),
    )
  }

  it("queries the requested league's feed", async () => {
    const urls = stubFeed([])
    await post({ league: "cfb", markets: ["player_pass_yds"] })
    expect(urls[0]).toContain("/sports/americanfootball_ncaaf/")
  })

  it("prices only games in the window, capped, instead of every game the feed lists", async () => {
    // The regression: with no window, a press priced weeks of games at once.
    const now = Date.parse("2026-10-20T16:00:00Z")
    // The route skips games that have started, so the clock is pinned to the
    // slate rather than left to drift past it.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    const at = (h: number) => new Date(now + h * 3600 * 1000).toISOString()
    const events = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `today-${i}`, commence_time: at(3 + i * 0.25) })),
      ...Array.from({ length: 40 }, (_, i) => ({ id: `later-${i}`, commence_time: at(48 + i * 6) })),
    ]
    const urls = stubFeed(events)
    const res = await post({
      league: "nba",
      markets: ["player_points"],
      from: new Date(now).toISOString(),
      to: at(20),
      maxGames: 5,
    })
    const data = await res.json()
    const oddsCalls = urls.filter((u) => u.includes("/odds?"))
    expect(oddsCalls).toHaveLength(5)
    expect(oddsCalls.every((u) => u.includes("/events/today-"))).toBe(true)
    expect(data.cappedOut).toBe(7)
  })

  it("rejects an unknown league rather than falling back to the NBA", async () => {
    stubFeed([])
    // College basketball was removed; a stale client asking for it must get a
    // clear refusal, not an NBA slate under the wrong heading.
    const res = await post({ league: "ncaab" })
    expect(res.status).toBe(400)
  })
})
