import { describe, expect, it } from "vitest"
import { DEFAULT_APPS, capturedToMode, type CapturedPayout } from "@/lib/quant/payouts"
import type { LegResult, TrackedLeg, TrackedSlip } from "@/lib/store/schema"
import { summarise } from "@/lib/quant/calibration"
import {
  entryExpectation,
  legClash,
  legsFromText,
  nightReviews,
  openExposure,
  compareSides,
  recordBySide,
  recordByType,
  settlementMode,
  tableMultiple,
  withResults,
} from "@/lib/tracker/entries"

/**
 * The tracker against five real settled PrizePicks entries: four NFL 3-pick
 * power plays and one WNBA 4-pick, stakes and payouts as the app showed them.
 */

function leg(player: string, marketLabel: string, line: number, side: "OVER" | "UNDER", result: LegResult): TrackedLeg {
  return { player, marketKey: null, marketLabel, line, side, pWinAtEntry: null, app: "prizepicks", result, actual: null }
}

function slip(id: string, stake: number, payout: number, legs: TrackedLeg[]): TrackedSlip & { capturedPayout: CapturedPayout } {
  const n = legs.length
  return {
    id, createdAt: "2026-09-27T17:00:00Z", settledAt: null, appId: "prizepicks", modeId: "power", legs, stake,
    capturedPayout: { picks: n, tiers: { [n]: payout / stake }, confirmed: true, capturedAt: "2026-09-27T17:00:00Z" },
    evAtEntry: null, pAllHitAtEntry: null, topMultiple: payout / stake, status: "PENDING", actualMultiple: null,
    notes: "", source: "logged",
  }
}

const settle = (s: TrackedSlip) => withResults(s, s.legs, DEFAULT_APPS)

describe("settling a real entry with a player who did not play", () => {
  it("scores 'win, loss, did not play' as a loss, not a refund", () => {
    // $2 for $12: Addison under 5.5 recs won, Allgeier over 2.5 rush yds lost,
    // Jack Bech did not play (Reboot). PrizePicks shrinks it to a 2-pick with
    // a loss in it. The tracker used to refund the $2.
    const s = settle(slip("a", 2, 12, [
      leg("Jordan Addison", "Receptions", 5.5, "UNDER", "WIN"),
      leg("Tyler Allgeier", "Rushing Yards", 2.5, "OVER", "LOSS"),
      leg("Jack Bech", "Receiving Yards", 0.5, "OVER", "VOID"),
    ]))
    expect(s.status).toBe("SETTLED")
    expect(s.actualMultiple).toBe(0)
  })

  it("pays the smaller entry's table when the rest all hit", () => {
    const s = settle(slip("b", 1, 6, [
      leg("A One", "Receptions", 5.5, "UNDER", "WIN"),
      leg("B Two", "Receptions", 5.5, "UNDER", "WIN"),
      leg("C Three", "Receptions", 5.5, "UNDER", "VOID"),
    ]))
    // A 2-pick power play from the stored table.
    expect(s.actualMultiple).toBe(DEFAULT_APPS[0].modes[0].table[2][2])
  })

  it("refunds when voids leave fewer picks than any entry allows", () => {
    const s = settle(slip("c", 1, 6, [
      leg("A One", "Receptions", 5.5, "UNDER", "VOID"),
      leg("B Two", "Receptions", 5.5, "UNDER", "VOID"),
      leg("C Three", "Receptions", 5.5, "UNDER", "WIN"),
    ]))
    expect(s.actualMultiple).toBe(1)
  })

  it("settles the full entry at the payout captured from the screen, goblins and all", () => {
    // $1 for $5.50: a goblin and a demon moved the 3-pick off the standard table.
    const s = settle(slip("d", 1, 5.5, [
      leg("Cade Otton", "Receiving Yards", 65.5, "UNDER", "WIN"),
      leg("George Pickens", "Receptions", 5.5, "UNDER", "WIN"),
      leg("Brock Bowers", "Receptions", 9.5, "UNDER", "WIN"),
    ]))
    expect(s.actualMultiple).toBe(5.5)
  })

  it("keeps the captured multiple for the full size in the settlement table", () => {
    const mode = settlementMode(slip("e", 4, 26.1, [leg("a", "x", 1, "OVER", "WIN"), leg("b", "x", 1, "OVER", "WIN"), leg("c", "x", 1, "OVER", "WIN"), leg("d", "x", 1, "OVER", "WIN")]), DEFAULT_APPS)
    expect(mode.table[4][4]).toBeCloseTo(6.525, 6)
    expect(mode.table[3]).toBeDefined()
  })
})

describe("expected value of an entry", () => {
  it("matches the closed form for an all-or-nothing 3-pick", () => {
    const mode = capturedToMode({ picks: 3, tiers: { 3: 6 }, confirmed: true, capturedAt: "" })
    const r = entryExpectation([0.55, 0.55, 0.55], mode)!
    expect(r.pAllHit).toBeCloseTo(0.55 ** 3, 9)
    expect(r.ev).toBeCloseTo(6 * 0.55 ** 3 - 1, 9)
  })

  it("refuses to guess when any leg was never priced", () => {
    const mode = capturedToMode({ picks: 3, tiers: { 3: 6 }, confirmed: true, capturedAt: "" })
    expect(entryExpectation([0.55, null, 0.6], mode)).toBeNull()
  })
})

describe("exposure across open entries", () => {
  it("flags the same player in two open entries", () => {
    // Brock Bowers under 9.5 receptions was in two of the four NFL entries.
    const one = slip("x", 1, 5.5, [leg("Brock Bowers", "Receptions", 9.5, "UNDER", "PENDING"), leg("Cade Otton", "Receiving Yards", 65.5, "UNDER", "PENDING")])
    const two = slip("y", 1, 6, [leg("Brock Bowers", "Receptions", 9.5, "UNDER", "PENDING"), leg("Kaelon Black", "Rushing Yards", 14.5, "OVER", "PENDING")])
    const e = openExposure([one, two])
    expect(e).toHaveLength(1)
    expect(e[0].player).toBe("Brock Bowers")
    expect(e[0].entries).toBe(2)
    expect(e[0].conflicting).toBe(false)
  })

  it("calls out an over in one entry and an under in another", () => {
    const one = slip("x", 1, 6, [leg("Jack Bech", "Receiving Yards", 0.5, "OVER", "PENDING")])
    const two = slip("y", 1, 6, [leg("Jack Bech", "Receiving Yards", 4.5, "UNDER", "PENDING")])
    expect(openExposure([one, two])[0].conflicting).toBe(true)
  })

  it("ignores settled entries", () => {
    const one = settle(slip("x", 1, 6, [leg("Brock Bowers", "Receptions", 9.5, "UNDER", "LOSS")]))
    const two = slip("y", 1, 6, [leg("Brock Bowers", "Receptions", 9.5, "UNDER", "PENDING")])
    expect(openExposure([one, two])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// One night: five PrizePicks entries on two WNBA games and one baseball game,
// logged from their settled screens. $30 in, $7 back.
// ---------------------------------------------------------------------------

/** A logged entry settled at what the app paid, with no payout table captured for a flex that paid. */
function paidSlip(id: string, modeId: "power" | "flex", stake: number, top: number | null, paid: number, legs: TrackedLeg[]): TrackedSlip {
  const n = legs.length
  return settle({
    id, createdAt: "2026-09-29T23:30:00Z", settledAt: null, appId: "prizepicks", modeId, legs, stake,
    capturedPayout: top ? { picks: n, tiers: { [n]: top / stake }, confirmed: modeId === "power", capturedAt: "" } : null,
    evAtEntry: null, pAllHitAtEntry: null, topMultiple: top ? top / stake : null, status: "PENDING", actualMultiple: null,
    paidOut: paid, notes: "", source: "logged",
  })
}

const night = [
  paidSlip("three", "power", 5, 30, 0, [
    leg("Breanna Stewart", "Assists", 3.5, "UNDER", "LOSS"),
    leg("Courtney Williams", "Assists", 4, "UNDER", "LOSS"),
    leg("Marine Johannes", "Points", 4.5, "UNDER", "LOSS"),
  ]),
  paidSlip("flexA", "flex", 10, null, 5, [
    leg("Jewell Loyd", "3-Pointers Made", 0.5, "OVER", "WIN"),
    leg("Kelsey Mitchell", "Rebounds", 1.5, "UNDER", "WIN"),
    leg("Jonquel Jones", "3-Pointers Made", 1.5, "OVER", "LOSS"),
    leg("Kayla McBride", "Rebounds", 1.5, "OVER", "WIN"),
    leg("Leonie Fiebich", "3-Pointers Made", 0.5, "OVER", "WIN"),
    leg("Olivia Miles", "3-Pointers Made", 0.5, "OVER", "WIN"),
  ]),
  paidSlip("two", "power", 5, 15, 0, [
    leg("Courtney Williams", "Assists", 4, "UNDER", "LOSS"),
    leg("Marine Johannes", "Points", 4.5, "UNDER", "LOSS"),
  ]),
  paidSlip("flexB", "flex", 5, null, 2, [
    leg("Kelsey Mitchell", "Rebounds", 1.5, "OVER", "LOSS"),
    leg("Lexie Hull", "Rebounds", 2.5, "UNDER", "LOSS"),
    leg("Jonquel Jones", "Assists", 2.5, "UNDER", "WIN"),
    leg("Leonie Fiebich", "Rebounds", 3.5, "UNDER", "WIN"),
    leg("Napheesa Collier", "Assists", 2.5, "UNDER", "WIN"),
    leg("Olivia Miles", "Assists", 6.5, "UNDER", "WIN"),
  ]),
  paidSlip("six", "power", 5, 305, 0, [
    leg("Chase Meidroth", "Hitter Fantasy Score", 4.5, "OVER", "WIN"),
    leg("Christian Walker", "Hits + Runs + RBIs", 1.5, "OVER", "LOSS"),
    leg("A'ja Wilson", "Pts + Reb + Ast", 42.5, "OVER", "LOSS"),
    leg("Jackie Young", "Assists", 7.5, "OVER", "LOSS"),
    leg("Breanna Stewart", "Pts + Reb", 33, "OVER", "LOSS"),
    leg("Pauline Astier", "Reb + Ast", 7.5, "OVER", "WIN"),
  ]),
]

describe("settling at what the app paid", () => {
  it("scores a flex that hit five of six goblins at the half-stake it paid, not the table's 2x", () => {
    const flex = night[1]
    expect(flex.status).toBe("SETTLED")
    expect(flex.actualMultiple).toBe(0.5)
    // The stored table would have booked a $10 profit on a $5 loss.
    expect(tableMultiple(flex, DEFAULT_APPS)).toBe(2)
  })

  it("settles at what was paid before any leg is filled in", () => {
    const s = paidSlip("p", "flex", 5, null, 2, [leg("A One", "Assists", 2.5, "UNDER", "PENDING"), leg("B Two", "Assists", 2.5, "UNDER", "PENDING")])
    expect(s.status).toBe("SETTLED")
    expect(s.actualMultiple).toBeCloseTo(0.4, 9)
    expect(tableMultiple(s, DEFAULT_APPS)).toBeNull()
  })

  it("keeps the paid result when a leg is changed afterwards", () => {
    const s = withResults(night[0], night[0].legs.map((l, i) => (i === 0 ? { ...l, result: "WIN" as const } : l)), DEFAULT_APPS)
    expect(s.actualMultiple).toBe(0)
  })

  it("adds the night up to $30 in and $7 back, with neither Win badge a profit", () => {
    const p = summarise(night)
    expect(p.staked).toBe(30)
    expect(p.returned).toBe(7)
    expect(p.profit).toBe(-23)
    expect(p.wins).toBe(0)
  })
})

describe("reviewing a settled night for overlap", () => {
  const review = nightReviews(night, () => "2026-09-29")

  it("groups the night and totals it", () => {
    expect(review).toHaveLength(1)
    expect(review[0]).toMatchObject({ day: "2026-09-29", entries: 5, staked: 30, returned: 7 })
  })

  it("puts the both-sides pair first: over and under 1.5 rebounds cannot both hit", () => {
    const [first] = review[0].exposure
    expect(first.player).toBe("Kelsey Mitchell")
    expect(first.cannotBothHit).toBe(true)
  })

  it("names the legs that were played twice, and how they went", () => {
    const williams = review[0].exposure.find((e) => e.player === "Courtney Williams")!
    expect(williams.repeated).toBe(true)
    expect(williams.bets).toEqual(["under 4 Assists \u00d72, missed"])
    expect(review[0].exposure.find((e) => e.player === "Marine Johannes")!.repeated).toBe(true)
  })

  it("lists a player on different stats without calling it a conflict", () => {
    const jones = review[0].exposure.find((e) => e.player === "Jonquel Jones")!
    expect(jones.conflicting).toBe(false)
    expect(jones.repeated).toBe(false)
  })

  it("leaves out a day with only one entry", () => {
    expect(nightReviews([night[0]], () => "2026-09-29")).toHaveLength(0)
  })
})

describe("checking a leg against entries already logged", () => {
  const others = night.map((s) => ({ id: s.id, legs: s.legs }))

  it("catches the other side of the same line", () => {
    const c = legClash({ player: "Kelsey Mitchell", marketKey: null, marketLabel: "Rebounds", line: 1.5, side: "OVER" }, [others[1]])
    expect(c).toEqual({ entries: 1, repeated: 0, oppositeSide: true, cannotBothHit: true })
  })

  it("counts the same leg already played", () => {
    const c = legClash({ player: "Courtney Williams", marketKey: null, marketLabel: "Assists", line: 4, side: "UNDER" }, others)
    expect(c.repeated).toBe(2)
  })

  it("does not call a middle impossible: over 0.5 and under 4.5 can both hit", () => {
    const c = legClash(
      { player: "Jack Bech", marketKey: null, marketLabel: "Receiving Yards", line: 0.5, side: "OVER" },
      [{ id: "x", legs: [leg("Jack Bech", "Receiving Yards", 4.5, "UNDER", "PENDING")] }],
    )
    expect(c.oppositeSide).toBe(true)
    expect(c.cannotBothHit).toBe(false)
  })
})

describe("record by pick type", () => {
  it("keeps goblins, demons and standard picks apart, and leaves unmarked legs out", () => {
    const typedLeg = (pickType: "standard" | "goblin" | "demon" | undefined, result: LegResult): TrackedLeg => ({
      ...leg("X Y", "Receptions", 2.5, "OVER", result),
      pickType,
    })
    const s = settle(slip("p", 5, 28.75, [
      typedLeg("goblin", "WIN"), typedLeg("goblin", "WIN"), typedLeg("goblin", "WIN"),
      typedLeg("standard", "LOSS"), typedLeg("standard", "WIN"), typedLeg("demon", "LOSS"), typedLeg(undefined, "WIN"),
    ]))
    expect(recordByType([s]).byPick).toEqual([
      { label: "Standard picks", wins: 1, losses: 1 },
      { label: "Goblins", wins: 3, losses: 0 },
      { label: "Demons", wins: 0, losses: 1 },
    ])
  })

  it("reads goblin and demon typed into a leg", () => {
    const legs = legsFromText("Jerry Jeudy over 0.5 Recs goblin win\nMichael Pittman Jr. over 3.5 Recs demon loss\nAaron Rodgers over 1.5 Rush Yards loss")
    expect(legs.map((l) => `${l.player} | ${l.pickType ?? "-"} | ${l.result}`)).toEqual([
      "Jerry Jeudy | goblin | WIN",
      "Michael Pittman Jr. | demon | LOSS",
      "Aaron Rodgers | - | LOSS",
    ])
  })
})

describe("typing NHL legs", () => {
  it("reads shots on goal, goalie saves and goals as hockey stats", () => {
    const legs = legsFromText("Auston Matthews over 2.5 Shots On Goal win\nJoseph Woll under 27.5 Goalie Saves loss\nWilliam Nylander over 0.5 Goals goblin")
    expect(legs.map((l) => `${l.player} | ${l.marketKey} | ${l.side} | ${l.line} | ${l.result}`)).toEqual([
      "Auston Matthews | SOG | OVER | 2.5 | WIN",
      "Joseph Woll | SAVES | UNDER | 27.5 | LOSS",
      "William Nylander | HKY_GOALS | OVER | 0.5 | PENDING",
    ])
  })

  it("keeps hits and faceoffs as legs the app does not price", () => {
    const [hits] = legsFromText("Ryan Reaves over 2.5 Hits")
    expect(hits.marketKey).toBeNull()
    expect(hits.note).toMatch(/Hits is not a stat this app models/)
  })
})

describe("record by leg type", () => {
  it("groups settled legs by stat and side, and leaves out voids", () => {
    const s = [
      settle(slip("a", 1, 6, [leg("Addison", "Receptions", 5.5, "UNDER", "WIN"), leg("Pickens", "Receptions", 5.5, "UNDER", "LOSS"), leg("Bech", "Receiving Yards", 0.5, "OVER", "VOID")])),
      settle(slip("b", 1, 6, [leg("Bowers", "Receptions", 9.5, "UNDER", "LOSS"), leg("Wilson", "Receptions", 7.5, "UNDER", "LOSS"), leg("Black", "Rushing Yards", 14.5, "OVER", "WIN")])),
    ]
    const r = recordByType(s)
    expect(r.byType[0]).toEqual({ label: "Receptions unders", wins: 1, losses: 3 })
    expect(r.byType.find((x) => x.label === "Receiving Yards overs")).toBeUndefined()
    expect(r.unpriced.wins + r.unpriced.losses).toBe(5)
    expect(r.priced.wins + r.priced.losses).toBe(0)
  })
})


describe("overs and unders by league", () => {
  // The two power plays of 1 November 2026, as logged: four NFL goblins at
  // "$10 for $40", and four NBA unders, two of them goblins, at "$3.75 to win
  // $24.38" — all of them read off the screenshots, results included.
  const inLeague = (l: TrackedLeg, league: "nba" | "nfl"): TrackedLeg => ({ ...l, league, pickType: "goblin" })
  const nfl = settle({
    ...slip("nfl", 10, 40, [
      inLeague(leg("Darren Waller", "Receptions", 2.5, "UNDER", "WIN"), "nfl"),
      inLeague(leg("MarShawn Lloyd", "Receptions", 0.5, "OVER", "WIN"), "nfl"),
      inLeague(leg("Mitchell Evans", "Receptions", 1.5, "UNDER", "LOSS"), "nfl"),
      inLeague(leg("Tommy Tremble", "Receptions", 1.5, "OVER", "LOSS"), "nfl"),
    ]),
    paidOut: 0,
  })
  const nba = settle(slip("nba", 3.75, 24.38, [
    inLeague(leg("Jalen Johnson", "Points", 21.5, "UNDER", "WIN"), "nba"),
    inLeague(leg("Jeremiah Fears", "Assists", 3.5, "UNDER", "LOSS"), "nba"),
    inLeague(leg("Zion Williamson", "Assists", 3.5, "UNDER", "WIN"), "nba"),
    inLeague(leg("Donovan Clingan", "Points", 10.5, "UNDER", "LOSS"), "nba"),
  ]))

  it("splits every decided leg by league and side, with the bar its entry needed", () => {
    const r = recordBySide([nfl, nba], DEFAULT_APPS)
    expect(r.map((x) => `${x.label} ${x.wins}-${x.losses}`)).toEqual(["NBA unders 2-2", "NFL overs 1-1", "NFL unders 1-1"])
    // 6.5x on four legs is 62.6% a leg; four goblins at 4x is 70.7%.
    expect(r[0].needed).toBeCloseTo(Math.pow(1 / 6.5, 1 / 4), 3)
    expect(r[1].needed).toBeCloseTo(Math.pow(1 / 4, 1 / 4), 3)
    expect(r[1].needed!).toBeGreaterThan(0.7)
  })

  it("prefers the leg's competition to the section it was played in", () => {
    const college = settle(slip("cfb", 1, 6, [
      { ...leg("A", "Receptions", 4.5, "OVER", "WIN"), league: "nfl", competition: "cfb" },
      { ...leg("B", "Receptions", 4.5, "OVER", "LOSS"), league: "nfl" },
      leg("C", "Receptions", 4.5, "UNDER", "LOSS"),
    ]))
    expect(recordBySide([college], DEFAULT_APPS).map((x) => x.label)).toEqual([
      "NFL overs",
      "CFB overs",
      "Unders, league not recorded",
    ])
  })

  it("does not call a handful of legs a difference between the sides", () => {
    // 2-2 against 0-4 is a 50-point gap, and eight legs.
    const small = compareSides({ label: "o", wins: 2, losses: 2 }, { label: "u", wins: 0, losses: 4 })!
    expect(small.gap).toBeCloseTo(0.5)
    expect(small.significant).toBe(false)
    // The same rates over a season are a real difference.
    expect(compareSides({ label: "o", wins: 30, losses: 30 }, { label: "u", wins: 18, losses: 42 })!.significant).toBe(true)
    // And a small gap over a season is not.
    expect(compareSides({ label: "o", wins: 31, losses: 29 }, { label: "u", wins: 29, losses: 31 })!.significant).toBe(false)
    expect(compareSides({ label: "o", wins: 0, losses: 0 }, { label: "u", wins: 1, losses: 0 })).toBeNull()
  })
})

describe("typing an entry's legs", () => {
  it("reads player, line, stat, side and result from each line", () => {
    const legs = legsFromText(
      "Jordan Addison under 5.5 Recs win\nTyler Allgeier over 2.5 Rush Yards loss\nJack Bech over 0.5 Rec Yards dnp\nKiki Iriafen more 9 Rebounds",
    )
    expect(legs.map((l) => `${l.player} | ${l.side} | ${l.line} | ${l.marketKey} | ${l.result}`)).toEqual([
      "Jordan Addison | UNDER | 5.5 | REC | WIN",
      "Tyler Allgeier | OVER | 2.5 | RUSH_YDS | LOSS",
      "Jack Bech | OVER | 0.5 | REC_YDS | VOID",
      "Kiki Iriafen | OVER | 9 | REB | PENDING",
    ])
  })

  it("keeps a line it cannot read, with a note, instead of dropping it", () => {
    const legs = legsFromText("something unreadable")
    expect(legs).toHaveLength(1)
    expect(legs[0].note).toMatch(/Could not read/)
  })
})
