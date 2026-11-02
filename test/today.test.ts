import { describe, expect, it } from "vitest"
import { PARLAY_MIN_LEG_PROB, buildDailyPicks, buildDfsTargets, dfsTargetsFor, summariseGames, valueBetsToCandidates } from "@/lib/today/build"
import { DEFAULT_VALUE_SETTINGS, findValueBets, type FeedQuote } from "@/lib/quant/valuebets"
import { DEFAULT_CORRELATION } from "@/lib/quant/correlation"
import { DEFAULT_CONSTRAINTS } from "@/lib/quant/optimizer"
import { MARKETS, distributionFor } from "@/lib/nba/markets"

const OPTS = {
  value: DEFAULT_VALUE_SETTINGS,
  correlation: DEFAULT_CORRELATION,
  constraints: { ...DEFAULT_CONSTRAINTS, picks: 3, maxPerGame: 3, maxPerTeam: 3 },
  dfsBreakEven: 0.562,
  now: Date.parse("2026-01-15T18:00:00Z"),
}

function q(
  player: string,
  market: FeedQuote["market"],
  book: string,
  line: number,
  over: number | null,
  under: number | null,
  gameId = "MIN@OKC",
): FeedQuote {
  return {
    book, line, overOdds: over, underOdds: under, fetchedAt: null,
    player, market, gameId,
    homeTeam: gameId.split("@")[1], awayTeam: gameId.split("@")[0],
    commenceTime: "2026-01-16T00:10:00Z",
  }
}

describe("summariseGames", () => {
  it("summarises the slate", () => {
    const games = summariseGames([
      q("A Player", "PTS", "pinnacle", 20.5, -110, -110),
      q("B Player", "PTS", "pinnacle", 20.5, -110, -110),
      q("C Player", "PTS", "pinnacle", 20.5, -110, -110, "NYK@BOS"),
    ])
    expect(games).toHaveLength(2)
    expect(games.find((g) => g.gameId === "MIN@OKC")!.propCount).toBe(2)
    expect(games[0].homeTeam).toBeTruthy()
    expect(games[0].awayTeam).toBeTruthy()
  })
})

describe("dfsTargetsFor", () => {
  const dist = distributionFor("PTS", 26)

  it("puts the fair line near the projection", () => {
    const t = dfsTargetsFor(26, dist, 0.562)
    expect(t.fairLine).toBeGreaterThan(24)
    expect(t.fairLine).toBeLessThan(28)
  })

  it("gives an over target below the fair line and an under target above it", () => {
    const t = dfsTargetsFor(26, dist, 0.562)
    expect(t.overAt).not.toBeNull()
    expect(t.underAt).not.toBeNull()
    expect(t.overAt!).toBeLessThan(t.fairLine)
    expect(t.underAt!).toBeGreaterThan(t.fairLine)
    expect(t.overProb!).toBeGreaterThanOrEqual(0.562)
    expect(t.underProb!).toBeGreaterThanOrEqual(0.562)
  })

  it("moves the targets further out as the bar rises", () => {
    const easy = dfsTargetsFor(26, dist, 0.52)
    const hard = dfsTargetsFor(26, dist, 0.62)
    expect(hard.overAt!).toBeLessThan(easy.overAt!)
    expect(hard.underAt!).toBeGreaterThan(easy.underAt!)
  })

  it("returns nothing when the bar cannot be cleared", () => {
    const t = dfsTargetsFor(26, dist, 0.999)
    expect(t.overAt).toBeNull()
    expect(t.underAt).toBeNull()
  })

  it("handles a low-mean stat without going below zero", () => {
    const blocks = distributionFor("BLK", 0.8)
    const t = dfsTargetsFor(0.8, blocks, 0.562)
    if (t.overAt != null) expect(t.overAt).toBeGreaterThan(0)
    if (t.underAt != null) expect(t.underAt).toBeGreaterThan(0)
  })
})

describe("buildDfsTargets", () => {
  it("produces a target from a sharp consensus", () => {
    const targets = buildDfsTargets([q("Anthony Edwards", "PTS", "pinnacle", 25.5, -110, -110)], OPTS)
    expect(targets).toHaveLength(1)
    expect(targets[0].hasSharpBook).toBe(true)
    expect(targets[0].overAt).not.toBeNull()
    expect(targets[0].marketLabel).toBe("Points")
  })

  it("skips props with no sharp reference", () => {
    expect(buildDfsTargets([q("A Player", "PTS", "espnbet", 25.5, -110, -110)], OPTS)).toHaveLength(0)
  })
})

describe("valueBetsToCandidates", () => {
  it("carries the price and game through so parlays can be priced and correlated", () => {
    const bets = findValueBets([
      q("Anthony Edwards", "PTS", "pinnacle", 25.5, -110, -110),
      q("Anthony Edwards", "PTS", "draftkings", 25.5, 130, -150),
    ])
    const c = valueBetsToCandidates(bets)
    expect(c[0].american).toBe(130)
    expect(c[0].status).toBe("priced")
    expect(c[0].gameId).toBe("MIN@OKC")
    expect(c[0].pWin).toBeGreaterThan(0)
  })
})

describe("buildDailyPicks", () => {
  // Four players across two games. Pinnacle sets each number with the over a
  // modest favourite; DraftKings is soft on all four, offering that over at
  // even money, and FanDuel is soft on one, so a single-book parlay is
  // possible at DraftKings but not at FanDuel. Favourites, because a parlay
  // leg has to be at least a coin flip: see PARLAY_MIN_LEG_PROB.
  const quotes: FeedQuote[] = [
    q("Anthony Edwards", "PTS", "pinnacle", 25.5, -130, 110),
    q("Anthony Edwards", "PTS", "draftkings", 25.5, 100, -120),
    q("Rudy Gobert", "REB", "pinnacle", 11.5, -130, 110),
    q("Rudy Gobert", "REB", "draftkings", 11.5, 100, -120),
    q("Rudy Gobert", "REB", "fanduel", 11.5, 100, -120),
    q("Jalen Brunson", "PTS", "pinnacle", 26.5, -130, 110, "NYK@BOS"),
    q("Jalen Brunson", "PTS", "draftkings", 26.5, 100, -120, "NYK@BOS"),
    q("Jayson Tatum", "REB", "pinnacle", 8.5, -130, 110, "NYK@BOS"),
    q("Jayson Tatum", "REB", "draftkings", 8.5, 100, -120, "NYK@BOS"),
  ]

  const picks = buildDailyPicks(quotes, OPTS)

  it("summarises the slate", () => {
    expect(picks.games).toHaveLength(2)
    expect(picks.stats.props).toBe(4)
    expect(picks.stats.pricedProps).toBe(4)
    expect(picks.stats.booksSeen).toContain("pinnacle")
  })

  it("finds the mispriced retail offers", () => {
    expect(picks.valueBets.length).toBeGreaterThanOrEqual(4)
    for (const b of picks.valueBets) {
      expect(b.edge).toBeGreaterThan(0)
      expect(b.bookTier).not.toBe("market-making")
    }
  })

  it("builds parlays out of the value legs", () => {
    expect(picks.parlays.length).toBeGreaterThan(0)
    for (const p of picks.parlays) {
      expect(p.legs).toHaveLength(3)
      expect(p.evaluation.breakEvenLegProb).not.toBeNull()
    }
  })

  it("keeps every parlay inside a single book", () => {
    // A leg at DraftKings cannot be combined with a leg at FanDuel onto one
    // ticket, so a parlay spanning books is one nobody can actually place.
    for (const p of picks.parlays) {
      expect(new Set(p.legs.map((l) => l.app)).size).toBe(1)
    }
  })

  it("builds no parlay when no single book has enough value legs", () => {
    const spread = buildDailyPicks(
      [
        q("Anthony Edwards", "PTS", "pinnacle", 25.5, -110, -110),
        q("Anthony Edwards", "PTS", "draftkings", 25.5, 135, -155),
        q("Rudy Gobert", "REB", "pinnacle", 11.5, -110, -110),
        q("Rudy Gobert", "REB", "fanduel", 11.5, 130, -150),
        q("Jalen Brunson", "PTS", "pinnacle", 26.5, -110, -110, "NYK@BOS"),
        q("Jalen Brunson", "PTS", "betmgm", 26.5, 128, -148, "NYK@BOS"),
      ],
      OPTS,
    )
    expect(spread.valueBets.length).toBeGreaterThanOrEqual(3)
    expect(spread.parlays).toHaveLength(0)
  })

  it("prices parlays from the legs' own odds", () => {
    const p = picks.parlays[0]
    // Three legs at even money pay exactly 2 x 2 x 2.
    expect(p.evaluation.topMultiple).toBeCloseTo(8, 6)
    for (const l of p.legs) expect(l.pWin).toBeGreaterThanOrEqual(PARLAY_MIN_LEG_PROB)
  })

  it("keeps long-odds legs out of parlays, and still lists them as singles", () => {
    // The parlays this used to build were ones you could see would not hit:
    // three legs that each land about four times in ten, at +160, hit about
    // one time in fifteen. Each is a fine single, and stays listed as one.
    const longshots: FeedQuote[] = [
      q("Anthony Edwards", "PTS", "pinnacle", 25.5, 130, -150),
      q("Anthony Edwards", "PTS", "draftkings", 25.5, 160, -190),
      q("Rudy Gobert", "REB", "pinnacle", 11.5, 130, -150),
      q("Rudy Gobert", "REB", "draftkings", 11.5, 160, -190),
      q("Jalen Brunson", "PTS", "pinnacle", 26.5, 130, -150, "NYK@BOS"),
      q("Jalen Brunson", "PTS", "draftkings", 26.5, 160, -190, "NYK@BOS"),
    ]
    const now = buildDailyPicks(longshots, OPTS)
    expect(now.valueBets.filter((b) => b.side === "OVER" && b.fairProb < 0.5).length).toBeGreaterThanOrEqual(3)
    expect(now.parlays).toHaveLength(0)
    // At the old 30% floor the same slate built a parlay of exactly those legs.
    expect(buildDailyPicks(longshots, { ...OPTS, parlayMinLegProb: 0.3 }).parlays.length).toBeGreaterThan(0)
  })

  it("produces DFS targets alongside the sportsbook bets", () => {
    expect(picks.dfsTargets.length).toBeGreaterThan(0)
    for (const t of picks.dfsTargets) {
      expect(t.overAt != null || t.underAt != null).toBe(true)
    }
  })

  it("returns nothing rather than something when the feed is empty", () => {
    const empty = buildDailyPicks([], OPTS)
    expect(empty.games).toHaveLength(0)
    expect(empty.valueBets).toHaveLength(0)
    expect(empty.parlays).toHaveLength(0)
    expect(empty.dfsTargets).toHaveLength(0)
  })

  it("finds no bets when every book agrees", () => {
    const agreed: FeedQuote[] = [
      q("Anthony Edwards", "PTS", "pinnacle", 25.5, -110, -110),
      q("Anthony Edwards", "PTS", "draftkings", 25.5, -110, -110),
    ]
    const p = buildDailyPicks(agreed, OPTS)
    expect(p.valueBets).toHaveLength(0)
    expect(p.parlays).toHaveLength(0)
    // But the DFS target still exists, because the fair line is still useful.
    expect(p.dfsTargets.length).toBeGreaterThan(0)
  })
})

describe("dfsTargetsFor line granularity", () => {
  it("only ever suggests half-point lines", () => {
    for (const [market, mean] of [["PTS", 26.4], ["REB", 8.1], ["3PM", 2.8], ["BLK", 0.9], ["AST", 6.2]] as const) {
      const t = dfsTargetsFor(mean, distributionFor(market, mean), 0.56)
      for (const v of [t.fairLine, t.overAt, t.underAt]) {
        if (v == null) continue
        // A whole-number line can push, which these targets do not account for.
        expect(Math.abs(v - Math.floor(v) - 0.5)).toBeLessThan(1e-9)
      }
    }
  })
})

import { dfsVerdict } from "@/lib/today/build"

describe("one verdict per pick'em target", () => {
  // Judkins receiving yards: over worth it at 9.5 or lower, under at 16.5 or
  // higher. Shown as two columns, that read as take both.
  const t = { overAt: 9.5, underAt: 16.5, fairLine: 12.5 }

  it("names the over below its threshold, the under above its own, and passes between", () => {
    expect(dfsVerdict(t, 8.5)).toBe("OVER")
    expect(dfsVerdict(t, 9.5)).toBe("OVER")
    expect(dfsVerdict(t, 12.5)).toBe("PASS")
    expect(dfsVerdict(t, 16.5)).toBe("UNDER")
    expect(dfsVerdict(t, 20.5)).toBe("UNDER")
  })

  it("never returns both sides for any line", () => {
    for (let line = 0.5; line < 30; line += 1) {
      expect(["OVER", "UNDER", "PASS"]).toContain(dfsVerdict(t, line))
    }
    expect(dfsVerdict({ overAt: null, underAt: 16.5, fairLine: 12.5 }, 8.5)).toBe("PASS")
  })
})

import { marketLineOf, probAt } from "@/lib/today/build"

describe("sorting picks by probability", () => {
  // Sharp prices from a coin flip to a heavy favourite, each with a soft book
  // beside it, so both lists have several rows at different probabilities.
  const slateForSort = (): FeedQuote[] => [
    q("Coin Flip", "PTS", "pinnacle", 20.5, -110, -110),
    q("Coin Flip", "PTS", "draftkings", 20.5, 135, -155),
    q("Lean Under", "REB", "pinnacle", 8.5, 115, -135),
    q("Lean Under", "REB", "lowvig", 8.5, 112, -132),
    q("Lean Under", "REB", "fanduel", 8.5, 140, -105),
    q("Big Under", "AST", "pinnacle", 6.5, 140, -165, "NYK@BOS"),
    q("Big Under", "AST", "lowvig", 6.5, 135, -160, "NYK@BOS"),
    q("Big Under", "AST", "draftkings", 6.5, 155, -120, "NYK@BOS"),
    q("Slight Over", "PTS", "pinnacle", 18.5, -125, 105, "NYK@BOS"),
    q("Slight Over", "PTS", "betmgm", 18.5, 110, -135, "NYK@BOS"),
  ]

  it("lists value bets and pick'em targets most likely to hit first", () => {
    const picks = buildDailyPicks(slateForSort(), OPTS)
    const probs = picks.valueBets.map((b) => b.fairProb)
    expect(probs.length).toBeGreaterThan(1)
    expect(probs).toEqual([...probs].sort((a, b) => b - a))
    const chances = picks.dfsTargets.map((t) => t.marketProb)
    expect(chances.length).toBeGreaterThan(1)
    expect(chances).toEqual([...chances].sort((a, b) => b - a))
    for (const t of picks.dfsTargets) expect(t.marketProb).toBeGreaterThanOrEqual(0.5)
  })

  it("takes the line most books hang, and prices any half-point line on the ladder", () => {
    expect(marketLineOf([24.5, 24.5, 25.5, 23.5], 24.9)).toBe(24.5)
    expect(marketLineOf([24.5, 25.5], 25.4)).toBe(25.5)
    const t = { ladder: [{ line: 2.5, over: 0.42, under: 0.58, push: 0 }] }
    expect(probAt(t, 2.5, "UNDER")).toBe(0.58)
    expect(probAt(t, 3, "UNDER")).toBeNull()
  })
})

import { buildPickemEntry, type DfsTarget } from "@/lib/today/build"

describe("a pick'em entry to play", () => {
  // `market` defaults to PTS so the cases below keep the meaning they had: the
  // helper used to set no market at all, which made every target's market
  // undefined and so identical, and a dedup keyed on player AND market would
  // have passed those cases unchanged.
  const t = (
    player: string,
    gameId: string,
    marketProb: number,
    marketSide: "OVER" | "UNDER" = "UNDER",
    market: DfsTarget["market"] = "PTS",
  ): DfsTarget =>
    ({
      key: `${player}|${gameId}|${market}`,
      player,
      gameId,
      marketProb,
      marketSide,
      market,
      marketLine: 1.5,
      marketLabel: MARKETS[market].label,
    }) as DfsTarget

  it("takes the likeliest legs that clear the bar, one per player, two per game", () => {
    const entry = buildPickemEntry(
      [
        t("A", "g1", 0.7),
        t("A", "g1", 0.69, "OVER"),
        t("B", "g1", 0.68),
        t("C", "g1", 0.66),
        t("D", "g2", 0.6),
        t("E", "g3", 0.5),
      ],
      3,
      0.55,
    )!
    // A's second prop in the same game would be the same player twice; C is a
    // third leg in g1; E is below the bar.
    expect(entry.map((l) => l.target.player)).toEqual(["A", "B", "D"])
  })

  it("treats the same name in two different games as two different people", () => {
    // One person cannot play two games in a day, so a name in two fixtures is
    // two people — ordinary across 130 college teams. Excluding the second as
    // a duplicate would silently drop a playable leg, and pooling them would
    // be worse: it would enter one player at the other's line.
    const entry = buildPickemEntry([t("A", "g1", 0.7), t("A", "g2", 0.65, "OVER")], 2, 0.55)!
    expect(entry).toHaveLength(2)
    expect(entry.map((l) => l.target.gameId)).toEqual(["g1", "g2"])
  })

  it("never puts a combo and one of its own components in the same entry", () => {
    // One leg per player is keyed on the player and blind to the market, which
    // is what stops a man's points riding beside his pts+reb+ast — two legs
    // that are about 0.92 correlated and close to the same bet. The cases
    // above could not catch this: they all shared one market, so a dedup keyed
    // on player and market would have passed them unchanged.
    const entry = buildPickemEntry(
      [
        t("Jokic", "g1", 0.7, "OVER", "PRA"),
        t("Jokic", "g1", 0.69, "OVER", "PTS"),
        t("Murray", "g1", 0.66, "OVER", "PTS"),
      ],
      2,
      0.55,
    )!
    expect(entry.map((l) => [l.target.player, l.target.market])).toEqual([
      ["Jokic", "PRA"],
      ["Murray", "PTS"],
    ])
  })

  it("refuses to pad an entry with legs below the bar", () => {
    expect(buildPickemEntry([t("A", "g1", 0.7), t("B", "g2", 0.52)], 2, 0.577)).toBeNull()
  })
})

import { appPlay, hasAppLines, pickemPlays, priceAppLines, type AppLine } from "@/lib/today/build"
import { usablePickemLines } from "@/lib/odds-feed/propline"
import type { PickemLine } from "@/lib/odds-feed/propline"

describe("pick'em lines from the apps", () => {
  const pp = (player: string, line: number, extra: Partial<PickemLine> = {}): PickemLine => ({
    app: "prizepicks",
    player,
    playerKey: player.toLowerCase(),
    market: "PTS",
    gameId: "MIN@OKC",
    line,
    pickType: "standard",
    over: { multiplier: null },
    under: { multiplier: null },
    fetchedAt: null,
    ...extra,
  })

  // Pinnacle and BetOnline both hang 25.5 with the over juiced: a projection above 25.5.
  const quotes = [
    q("Anthony Edwards", "PTS", "pinnacle", 25.5, -135, 115),
    q("Anthony Edwards", "PTS", "betonlineag", 25.5, -140, 118),
  ]

  it("prices each app line off the books' distribution, not the app", () => {
    const [t] = buildDfsTargets(quotes, {
      ...OPTS,
      pickemLines: [pp("Anthony Edwards", 23.5), pp("Anthony Edwards", 29.5, { pickType: "demon", under: null })],
    })
    expect(t.appLines).toHaveLength(2)
    const standard = t.appLines!.find((l) => l.pickType === "standard")!
    const demon = t.appLines!.find((l) => l.pickType === "demon")!
    // Two points below the books' line, the over is likelier than at the books' line.
    const atBooks = t.ladder.find((r) => r.line === 25.5)!.over
    expect(standard.over).toBeGreaterThan(atBooks)
    expect(standard.over + standard.under).toBeCloseTo(1, 9)
    expect(demon.over).toBeLessThan(atBooks)
    expect(demon.underOffered).toBe(false)
  })

  it("matches lines on player and market even when the game is spelled differently", () => {
    const [t] = buildDfsTargets(quotes, { ...OPTS, pickemLines: [pp("Anthony Edwards", 24.5, { gameId: "Wolves@Thunder" })] })
    expect(t.appLines).toHaveLength(1)
  })

  it("never matches another market or player", () => {
    const [t] = buildDfsTargets(quotes, {
      ...OPTS,
      pickemLines: [pp("Anthony Edwards", 6.5, { market: "REB" }), pp("Rudy Gobert", 12.5)],
    })
    expect(t.appLines).toEqual([])
  })

  const line = (over: number, extra: Partial<AppLine> = {}): AppLine => ({
    app: "prizepicks",
    line: 24.5,
    pickType: "standard",
    over,
    under: 1 - over,
    push: 0,
    overMultiplier: null,
    underMultiplier: null,
    overOffered: true,
    underOffered: true,
    fetchedAt: null,
    ageMinutes: null,
    isStale: false,
    ...extra,
  })

  it("says how old an app's line is, and flags one the app has probably moved", () => {
    // A pick'em app moves its lines. The books' prices were already checked
    // for age; the apps' were not, so a line read three hours ago was
    // indistinguishable from one read a minute ago.
    const now = Date.parse("2026-01-15T18:00:00Z")
    const at = (mins: number) => new Date(now - mins * 60_000).toISOString()
    const dist = distributionFor("PTS", 25)
    const [fresh, old, undated] = priceAppLines(
      [
        pp("A Fresh", 24.5, { fetchedAt: at(5) }),
        pp("B Old", 24.5, { fetchedAt: at(200) }),
        pp("C Undated", 24.5, { fetchedAt: null }),
      ],
      dist,
      { now, staleMinutes: 45 },
    )
    expect(fresh.ageMinutes).toBeCloseTo(5, 6)
    expect(fresh.isStale).toBe(false)
    expect(old.ageMinutes).toBeCloseTo(200, 6)
    expect(old.isStale).toBe(true)
    // No timestamp is not the same as a fresh one, and must not read as one.
    expect(undated.ageMinutes).toBeNull()
    expect(undated.isStale).toBe(false)
  })

  it("plays the likelier side of the app's standard line", () => {
    expect(appPlay({ appLines: [line(0.62)] }, "prizepicks")).toEqual({ line: 24.5, side: "OVER", prob: 0.62 })
    expect(appPlay({ appLines: [line(0.3)] }, "prizepicks")).toEqual({ line: 24.5, side: "UNDER", prob: 0.7 })
  })

  it("never plays a goblin, a demon, a boosted side, or another app's line", () => {
    expect(appPlay({ appLines: [line(0.8, { pickType: "goblin" })] }, "prizepicks")).toBeNull()
    expect(appPlay({ appLines: [line(0.8, { app: "underdog" })] }, "prizepicks")).toBeNull()
    // Underdog discounts the over: only the under is a standard pick.
    expect(appPlay({ appLines: [line(0.8, { app: "underdog", overMultiplier: 0.85 })] }, "underdog")).toEqual({
      line: 24.5,
      side: "UNDER",
      prob: expect.closeTo(0.2, 9),
    })
  })

  const target = (
    player: string,
    gameId: string,
    marketProb: number,
    appLines?: AppLine[],
    appCoverage: string[] = appLines?.length ? ["prizepicks"] : [],
  ): DfsTarget =>
    ({ key: player, player, gameId, marketProb, marketSide: "OVER", marketLine: 24.5, marketLabel: "Points", appLines, appCoverage }) as DfsTarget

  it("builds the entry at the app's real lines and leaves out props it is not offering", () => {
    const targets = [
      target("A", "g1", 0.7, [line(0.58, { line: 26.5 })]),
      // PrizePicks posted lines for B's game, but none for B.
      target("B", "g2", 0.68, undefined, ["prizepicks"]),
      target("C", "g3", 0.6, [line(0.64, { line: 22.5 })]),
    ]
    expect(hasAppLines(targets, "prizepicks")).toBe(true)
    const entry = buildPickemEntry(targets, 2, 0.55, 2, "prizepicks")!
    expect(entry.map((l) => [l.target.player, l.line, l.source])).toEqual([
      ["C", 22.5, "app"],
      ["A", 26.5, "app"],
    ])
  })

  it("re-checks the bar at the app's line, which can be harder than the books'", () => {
    const targets = [target("A", "g1", 0.7, [line(0.52)]), target("C", "g3", 0.66, [line(0.6)])]
    expect(buildPickemEntry(targets, 2, 0.55, 2, "prizepicks")).toBeNull()
  })

  it("never mixes the books' line into an entry at the app's own lines", () => {
    // The old behaviour put B in at the books' 24.5 and labelled it, reasoning
    // that a game the app's lines never reached is unknown rather than absent.
    // It is, and it is still not a line anyone can place: the card is headed
    // with PrizePicks and a payout table, and its expectation multiplies every
    // leg's chance at the line beside it. In practice half a card's lines were
    // not the app's, with no way to tell which half.
    const targets = [
      target("A", "g1", 0.7, [line(0.58, { line: 26.5 })]),
      // No PrizePicks line came through for g2 at all: unknown, not absent.
      target("B", "g2", 0.68),
    ]
    expect(buildPickemEntry(targets, 2, 0.55, 2, "prizepicks")).toBeNull()
    const one = buildPickemEntry(targets, 1, 0.55, 2, "prizepicks")!
    expect(one.map((l) => [l.target.player, l.line, l.source])).toEqual([["A", 26.5, "app"]])
  })

  it("counts what it left out, and why, rather than dropping it silently", () => {
    const targets = [
      target("A", "g1", 0.7, [line(0.58, { line: 26.5 })]),
      // Covered for this game and market, and no line for B: not offered.
      target("B", "g2", 0.68, undefined, ["prizepicks"]),
      // Never heard about C at all.
      target("C", "g3", 0.66),
    ]
    const plays = pickemPlays(targets, "prizepicks")
    expect(plays.live).toBe(true)
    expect(plays.plays.map((p) => p.target.player)).toEqual(["A"])
    expect(plays.notOffered).toBe(1)
    expect(plays.unknown).toBe(1)
    expect(plays.started).toBe(0)
  })

  it("marks a game and market covered when the app posted any player in it", () => {
    const targets = buildDfsTargets(
      [...quotes, q("Rudy Gobert", "PTS", "pinnacle", 12.5, -135, 115), q("Rudy Gobert", "PTS", "betonlineag", 12.5, -140, 118)],
      { ...OPTS, pickemLines: [pp("Anthony Edwards", 24.5)] },
    )
    const gobert = targets.find((t) => t.player === "Rudy Gobert")!
    expect(gobert.appLines).toEqual([])
    expect(gobert.appCoverage).toEqual(["prizepicks"])
  })

  it("keeps a line for a player the books skipped, because it is what gets another row's verdict right", () => {
    // The filter and the coverage pass are the two halves of one decision, and
    // neither module's own tests see both. PrizePicks posts rebounds for
    // Edwards; the books price rebounds only for Gobert. Edwards' rebounds
    // line is unplayable — nothing can ever price it — and it is the only
    // evidence that PrizePicks covers rebounds in this game, which is what
    // decides whether GOBERT's rebounds row reads as "not offered" or as
    // "never heard". A filter keyed on player and market alone sheds it and
    // the screen then says no PrizePicks line reached a game and market where
    // one did.
    const slate = [
      ...quotes,
      q("Rudy Gobert", "REB", "pinnacle", 11.5, -125, 105),
      q("Rudy Gobert", "REB", "betonlineag", 11.5, -128, 108),
    ]
    const lines = [pp("Anthony Edwards", 24.5), pp("Anthony Edwards", 8.5, { market: "REB" })]
    const usable = usablePickemLines(lines, slate)
    expect(usable.dropped).toHaveLength(0)

    const targets = buildDfsTargets(slate, { ...OPTS, pickemLines: usable.lines })
    const gobert = targets.find((t) => t.player === "Rudy Gobert" && t.market === "REB")!
    expect(gobert.appLines).toEqual([])
    expect(gobert.appCoverage).toEqual(["prizepicks"])
    const plays = pickemPlays(targets, "prizepicks", OPTS.now)
    expect(plays.notOffered).toBeGreaterThan(0)
    expect(plays.unknown).toBe(0)
  })

  it("does not read a points line as covering the rebounds market in the same game", () => {
    // PrizePicks posts points for Edwards and no rebounds line anywhere in the
    // game. Keyed on the game alone, Gobert's rebounds read as "offered, and
    // he is not on it", which is a different claim from the truth.
    const targets = buildDfsTargets(
      [
        ...quotes,
        q("Rudy Gobert", "REB", "pinnacle", 11.5, -125, 105),
        q("Rudy Gobert", "REB", "betonlineag", 11.5, -128, 108),
      ],
      { ...OPTS, pickemLines: [pp("Anthony Edwards", 24.5)] },
    )
    const rebounds = targets.find((t) => t.market === "REB")!
    expect(rebounds.appLines).toEqual([])
    expect(rebounds.appCoverage).toEqual([])
    // So it is unknown rather than not offered, and the entry still leaves it
    // out: an entry is never built at a line the app may not be posting.
    const plays = pickemPlays(targets, "prizepicks", OPTS.now)
    expect(plays.unknown).toBeGreaterThan(0)
    expect(plays.notOffered).toBe(0)
  })

  it("falls back to the books' line when the pull had nothing from that app", () => {
    const entry = buildPickemEntry([target("A", "g1", 0.7), target("B", "g2", 0.68)], 2, 0.55, 2, "prizepicks")!
    expect(entry.every((l) => l.source === "books" && l.line === 24.5)).toBe(true)
    expect(hasAppLines([target("A", "g1", 0.7)], "prizepicks")).toBe(false)
  })
})

import { appVerdict } from "@/lib/today/build"
import { sideEdge } from "@/lib/quant/valuebets"

describe("games that have already started", () => {
  const started = (player: string, gameId: string, prob: number, commenceTime: string) =>
    ({ key: player, player, gameId, marketProb: prob, marketSide: "OVER", marketLine: 20.5, marketLabel: "Points", commenceTime, appLines: [], appCoverage: [] }) as unknown as DfsTarget

  it("never puts a leg from a started game in the entry, however likely it looks", () => {
    const now = Date.parse("2026-01-16T01:30:00Z")
    const targets = [
      started("Live", "g1", 0.78, "2026-01-16T00:10:00Z"),
      started("Later A", "g2", 0.62, "2026-01-16T03:00:00Z"),
      started("Later B", "g3", 0.6, "2026-01-16T03:30:00Z"),
    ]
    const entry = buildPickemEntry(targets, 2, 0.55, 2, "prizepicks", now)!
    expect(entry.map((l) => l.target.player)).toEqual(["Later A", "Later B"])
    expect(buildPickemEntry(targets, 3, 0.55, 2, "prizepicks", now)).toBeNull()
  })
})

describe("appVerdict: the target row's answer at the app's own line", () => {
  const ud = (over: number, extra: Partial<AppLine> = {}): Pick<DfsTarget, "appLines"> => ({
    appLines: [
      {
        app: "underdog", line: 25.5, pickType: "standard", over, under: 1 - over, push: 0,
        overMultiplier: null, underMultiplier: null, overOffered: true, underOffered: true,
        fetchedAt: null, ageMinutes: null, isStale: false, ...extra,
      },
    ],
  })

  it("names a standard side that clears the bar", () => {
    expect(appVerdict(ud(0.58), "underdog", 0.55)).toEqual({ line: 25.5, side: "OVER", prob: 0.58, reason: null })
  })

  it("passes on a favoured side the app discounts, and says why", () => {
    const v = appVerdict(ud(0.58, { overMultiplier: 0.85 }), "underdog", 0.55)!
    expect(v.side).toBeNull()
    expect(v.reason).toBe("the over pays ×0.85, which needs its own bar")
  })

  it("passes on a favoured side the app does not offer", () => {
    expect(appVerdict(ud(0.58, { overOffered: false }), "underdog", 0.55)!.reason).toBe("the over is not offered")
  })

  it("says neither clears when the standard sides fall short, and is null without a standard line", () => {
    expect(appVerdict(ud(0.52), "underdog", 0.55)!.reason).toBe("neither side clears")
    expect(appVerdict(ud(0.6, { pickType: "goblin" }), "underdog", 0.55)).toBeNull()
    expect(appVerdict(ud(0.6), "prizepicks", 0.55)).toBeNull()
  })
})

import { sideBars } from "@/lib/today/build"
import { migrate } from "@/lib/store/schema"

describe("a margin on unders", () => {
  // The NBA's under margin is the user's prior, from entries like the four
  // NBA unders of 1 November 2026: Fears went for 13 assists against 3.5 and
  // Clingan cleared 10.5 points with four minutes left. It may only ever turn
  // a play into a pass, and it may never move a probability.
  const bars = sideBars(0.562, 0.03)

  it("asks the margin of an under and nothing extra of an over", () => {
    expect(bars.over).toBeCloseTo(0.562, 9)
    expect(bars.under).toBeCloseTo(0.592, 9)
    expect(sideBars(0.562, -0.05).under).toBeCloseTo(0.562, 9)
    expect(sideBars(0.98, 0.1).under).toBeLessThan(1)
  })

  it("moves the under threshold out and leaves the over threshold and every chance alone", () => {
    const dist = distributionFor("PTS", 18)
    const flat = dfsTargetsFor(18, dist, 0.562, { postedLines: [17.5, 18.5] })
    const held = dfsTargetsFor(18, dist, bars, { postedLines: [17.5, 18.5] })
    expect(held.overAt).toBe(flat.overAt)
    expect(held.ladder).toEqual(flat.ladder)
    expect(held.fairLine).toBe(flat.fairLine)
    expect(held.underAt!).toBeGreaterThan(flat.underAt!)
    expect(held.underProb!).toBeGreaterThanOrEqual(0.592)
  })

  it("keeps an under between the two bars out of the entry, and an over at the same chance in", () => {
    const t = (player: string, gameId: string, marketProb: number, marketSide: "OVER" | "UNDER"): DfsTarget =>
      ({ key: player, player, gameId, marketProb, marketSide, market: "PTS", marketLine: 10.5, marketLabel: "Points" }) as DfsTarget
    const targets = [t("Clingan", "g1", 0.58, "UNDER"), t("Johnson", "g2", 0.58, "OVER"), t("Zion", "g3", 0.6, "UNDER"), t("Fears", "g4", 0.57, "OVER")]
    expect(buildPickemEntry(targets, 3, 0.562)!.map((l) => l.target.player)).toEqual(["Zion", "Clingan", "Johnson"])
    // Clingan's 58% under is a pass at 59.2%; the over beneath it is not.
    expect(buildPickemEntry(targets, 3, bars)!.map((l) => l.target.player)).toEqual(["Zion", "Johnson", "Fears"])
    expect(buildPickemEntry(targets, 4, bars)).toBeNull()
  })

  it("says the margin is why a row passes, rather than claiming neither side clears", () => {
    const ud = (over: number): Pick<DfsTarget, "appLines"> => ({
      appLines: [
        {
          app: "prizepicks", line: 10.5, pickType: "standard", over, under: 1 - over, push: 0,
          overMultiplier: null, underMultiplier: null, overOffered: true, underOffered: true,
          fetchedAt: null, ageMinutes: null, isStale: false,
        },
      ],
    })
    expect(appVerdict(ud(0.42), "prizepicks", 0.562)!.side).toBe("UNDER")
    const held = appVerdict(ud(0.42), "prizepicks", bars)!
    expect(held.side).toBeNull()
    expect(held.reason).toMatch(/clears the bar but not your margin for unders \(needs 59.2%\)/)
    expect(appVerdict(ud(0.58), "prizepicks", bars)!.side).toBe("OVER")
    expect(appVerdict(ud(0.5), "prizepicks", bars)!.reason).toBe("neither side clears")
  })

  it("starts the NBA at three points, keeps a stored choice, and drops nonsense", () => {
    const fresh = migrate({})
    expect(fresh.settings.daily.underMargin).toEqual({ nba: 0.03 })
    const kept = migrate({ settings: { daily: { underMargin: { nba: 0, nfl: 0.02 } } } } as never)
    expect(kept.settings.daily.underMargin).toEqual({ nba: 0, nfl: 0.02 })
    const junk = migrate({ settings: { daily: { underMargin: { nba: "lots", nhl: 0.05, nfl: 9 } } } } as never)
    expect(junk.settings.daily.underMargin).toEqual({ nba: 0.03, nfl: 0.2 })
  })
})

describe("exchange commission", () => {
  it("judges an exchange price on what comes back after commission", () => {
    expect(sideEdge(0.51, 100).edge).toBeCloseTo(0.02, 9)
    const net = sideEdge(0.51, 100, 0.02)
    expect(net.edge).toBeCloseTo(0.51 * 1.98 - 1, 9)
    expect(net.kelly).toBeCloseTo((0.51 * 1.98 - 1) / 0.98, 9)
  })

  it("drops a ProphetX edge that only clears the bar before commission", () => {
    const quotes = [
      q("A Player", "PTS", "pinnacle", 20.5, -110, -110),
      q("A Player", "PTS", "betonlineag", 20.5, -110, -110),
      q("A Player", "PTS", "prophetx", 20.5, 106, -125),
    ]
    const value = { ...OPTS.value, minEdge: 0.02 }
    const gross = findValueBets(quotes, value, OPTS.now).filter((b) => b.book === "prophetx")
    const net = findValueBets(quotes, { ...value, commission: { prophetx: 0.02 } }, OPTS.now).filter((b) => b.book === "prophetx")
    expect(gross.length).toBe(1)
    expect(net.length).toBe(0)
  })
})
