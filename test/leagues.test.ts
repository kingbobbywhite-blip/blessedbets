import { describe, it, expect } from "vitest"
import {
  DEFAULT_LEAGUE,
  LEAGUES,
  type LeagueId,
  LEAGUE_IDS,
  TAB_LEAGUE_IDS,
  CONFIRM_PCT_OF_QUOTA,
  competitionsFor,
  companionsOf,
  creditPlan,
  creditWarning,
  plannedGames,
  pullPlan,
  inSeason,
  isLeagueId,
  isRetiredLeagueId,
  LOGGED_LEAGUE_IDS,
  leagueFor,
  loggedLeagueLabel,
  maxGamesFor,
  maxGamesForLeague,
  reseedGameCap,
  scaleMean,
  sportKeyFor,
  sportOfLoggedLeague,
} from "@/lib/leagues"
import { eventOddsUrl, eventsUrl } from "@/lib/odds-feed/theoddsapi"
import { projectProp } from "@/lib/quant/projection"
import { DEFAULT_PROJECTION_SETTINGS } from "@/lib/quant/projection"
import { migrate } from "@/lib/store/schema"
import { resolveLine } from "@/lib/quant/distributions"

describe("league config", () => {
  it("covers the NBA, the NFL and college football with distinct sport keys", () => {
    expect(LEAGUE_IDS).toEqual(["nba", "nfl", "cfb"])
    const keys = LEAGUE_IDS.map((id) => LEAGUES[id].sportKey)
    expect(new Set(keys).size).toBe(3)
    expect(sportKeyFor("nba")).toBe("basketball_nba")
    expect(sportKeyFor("nfl")).toBe("americanfootball_nfl")
    expect(sportKeyFor("cfb")).toBe("americanfootball_ncaaf")
    expect(LEAGUES.nfl.sport).toBe("football")
    expect(LEAGUES.cfb.sport).toBe("football")
    expect(LEAGUES.nba.sport).toBe("basketball")
  })

  it("shows college football inside the NFL section rather than as its own tab", () => {
    // One press pulls both. A separate tab would mean paying for the NFL slate
    // and the college slate in two presses and reading them in two places.
    expect(TAB_LEAGUE_IDS).toEqual(["nba", "nfl"])
    expect(LEAGUES.cfb.companionOnly).toBe(true)
    expect(LEAGUES.nfl.companions).toEqual(["cfb"])
    expect(companionsOf("nfl").map((l) => l.id)).toEqual(["cfb"])
    expect(competitionsFor("nfl", { companions: true }).map((l) => l.id)).toEqual(["nfl", "cfb"])
    // A league with no companion still answers with itself, so callers can loop.
    expect(competitionsFor("nba", { companions: true }).map((l) => l.id)).toEqual(["nba"])
    expect(companionsOf("nba")).toEqual([])
  })

  it("leaves the companion out unless it is asked for", () => {
    // A companion costs credits, so a caller that forgets the flag has to
    // under-pull rather than over-bill. That is the cheaper mistake.
    expect(competitionsFor("nfl").map((l) => l.id)).toEqual(["nfl"])
    expect(competitionsFor("nfl", {}).map((l) => l.id)).toEqual(["nfl"])
    expect(competitionsFor("nfl", { companions: false }).map((l) => l.id)).toEqual(["nfl"])
    expect(plannedGames("nfl", 14)).toBe(14)
  })

  it("asks college football for the same four markets as the NFL", () => {
    // The games this section prices are the televised ones, which is what the
    // depth ranking selects for, and those are the games where receptions and
    // receiving yards exist. Asking for four is asking where the answers are.
    expect(LEAGUES.cfb.markets).toEqual(LEAGUES.nfl.markets)
  })

  it("no longer supports college basketball or the WNBA, and falls back rather than guessing", () => {
    for (const gone of ["ncaab", "wnba"]) {
      expect(isLeagueId(gone)).toBe(false)
      expect(sportKeyFor(gone)).toBeNull()
      // leagueFor is the forgiving one, used where a fallback beats a crash.
      expect(leagueFor(gone).id).toBe(DEFAULT_LEAGUE)
    }
  })

  it("leaves football means unscaled", () => {
    // Football markets carry their own typical means; nothing is scaled across.
    expect(scaleMean("nfl", 235)).toBe(235)
    expect(scaleMean("cfb", 235)).toBe(235)
    expect(LEAGUES.nfl.dispersionScale).toBe(1)
  })

  it("treats college football as more volatile than the NFL", () => {
    // Blowouts, benched starters and an unknowable backfield split all widen
    // the outcome, and a wider outcome means a less confident probability.
    expect(LEAGUES.cfb.dispersionScale).toBeGreaterThan(LEAGUES.nfl.dispersionScale)
  })

  it("keeps the college game cap small, because a Saturday lists fifty games", () => {
    expect(LEAGUES.cfb.maxGames).toBeLessThan(LEAGUES.nfl.maxGames)
    expect(LEAGUES.cfb.typicalSlate).toBeGreaterThan(LEAGUES.nfl.typicalSlate)
  })

  it("asks a per-request feed for the whole NBA board, and a per-market feed for a budget", () => {
    // The Odds API charges markets x games, so its list is a budget. PropLine
    // charges one request per game whatever the list, so the same budget buys
    // nothing there and every market left out is a pick'em line that could
    // have been read and was not.
    const budget = marketsForLeague("nba", null)
    const whole = marketsForLeague("nba", null, { billsPerRequest: true })
    expect(budget).toEqual(LEAGUES.nba.markets)
    expect(whole).toEqual(LEAGUES.nba.deepMarkets)
    expect(whole.length).toBeGreaterThan(budget.length)
    // The budget is a subset: nothing in the narrow list is missing from the
    // wide one, or switching feeds would lose a market rather than add some.
    for (const k of budget) expect(whole, k).toContain(k)
    // The combos are most of a PrizePicks NBA board and the budget leads with
    // the one every app does.
    expect(budget).toContain("player_points_rebounds_assists")
    expect(whole).toContain("player_points_rebounds")
    expect(whole).toContain("player_blocks_steals")
    // A market list set by hand still wins over both.
    expect(marketsForLeague("nba", ["player_threes"], { billsPerRequest: true })).toEqual(["player_threes"])
  })

  it("asks only for markets a sportsbook has been seen to price", () => {
    // Each of these came back from a real pull with pick'em lines and not one
    // sportsbook quote, which makes every line in them unpriceable by
    // construction: turnovers first, then field goals and free throws made.
    for (const k of ["player_turnovers", "player_field_goals", "player_frees_made"]) {
      expect(LEAGUES.nba.deepMarkets, k).not.toContain(k)
      expect(LEAGUES.nba.markets, k).not.toContain(k)
    }
  })

  it("maps and caps every NBA market it asks for", () => {
    // A market the feed map does not know is a credit spent on a response
    // nothing can read; one with no plausibility ceiling can print a
    // nonsense projection with no warning beside it.
    for (const k of LEAGUES.nba.deepMarkets!) {
      const market = FEED_MARKET_MAP[k]
      expect(market, k).toBeDefined()
      expect(LEAGUES.nba.caps[market], `${k} -> ${market}`).toBeGreaterThan(0)
    }
  })

  it("keeps a full NBA night under the share of a month that makes the button ask", () => {
    // The whole point of the budget. A default press that trips the confirm
    // gate every time trains you to click through it, which is worse than no
    // gate at all.
    const credits = LEAGUES.nba.maxGames * LEAGUES.nba.markets.length
    expect(creditWarning("nba", LEAGUES.nba.maxGames, LEAGUES.nba.markets.length).confirm).toBe(false)
    expect(credits / 500).toBeLessThan(CONFIRM_PCT_OF_QUOTA)
  })

  it("pulls the whole NBA slate on a per-request feed, and stays under the gate on a per-market one", () => {
    // 30 teams, so 15 games is the largest night the NBA can have and the cap
    // on a feed that charges by the request. The NBA is not depth-ranked, so a
    // cap below the slate drops the LATEST game rather than the worst one: at
    // 14 that is the late West Coast tip, every night it exists.
    expect(maxGamesFor(LEAGUES.nba, { billsPerRequest: true })).toBe(15)
    expect(maxGamesForLeague("nba", { billsPerRequest: true })).toBe(15)
    // One request per game plus the events listing, against 1,000 a day.
    expect(maxGamesFor(LEAGUES.nba, { billsPerRequest: true }) + 1).toBeLessThan(1000 * 0.02)

    // And the reason it is not simply the one cap: the fifteenth game on The
    // Odds API costs a whole market list. 15 x 5 is 75 credits, which is
    // exactly the 15% of a month that makes the button ask.
    expect(maxGamesFor(LEAGUES.nba)).toBe(14)
    const wide = 15 * LEAGUES.nba.markets.length
    expect(wide / 500).toBe(CONFIRM_PCT_OF_QUOTA)
    expect(creditWarning("nba", 15, LEAGUES.nba.markets.length).confirm).toBe(true)
  })

  it("leaves a league with one cap alone on either feed", () => {
    // deepMaxGames is optional, and a league that never drew the distinction
    // must not read as undefined games on a per-request feed.
    for (const id of LEAGUE_IDS) {
      if (LEAGUES[id].deepMaxGames != null) continue
      expect(maxGamesFor(LEAGUES[id], { billsPerRequest: true }), id).toBe(LEAGUES[id].maxGames)
    }
    expect(maxGamesFor(LEAGUES.nfl, { billsPerRequest: true })).toBe(LEAGUES.nfl.maxGames)
    expect(maxGamesFor(LEAGUES.cfb, { billsPerRequest: true })).toBe(LEAGUES.cfb.maxGames)
  })

  it("counts a per-request pull at the per-request cap, companions included", () => {
    // The preview beside the button has to agree with what the press will ask
    // for, or the gate is computed on a slate nobody pulled.
    expect(plannedGames("nba", maxGamesFor(LEAGUES.nba, { billsPerRequest: true }))).toBe(15)
    expect(
      pullPlan("nfl", LEAGUES.nfl.maxGames, { companions: true, billsPerRequest: true })
        .find((p) => p.league.id === "cfb")!.games,
    ).toBe(LEAGUES.cfb.maxGames)
  })

  it("moves a seeded game cap to the new feed and leaves a chosen one alone", () => {
    const nba = LEAGUES.nba
    // 14 is the credit default and was never a choice on PropLine, so it goes.
    expect(reseedGameCap(nba, 14, { billsPerRequest: true })).toBe(15)
    // 15 is the per-request default and is not a choice on The Odds API.
    expect(reseedGameCap(nba, 15, { billsPerRequest: false })).toBe(14)
    // Anything else somebody typed, and it survives both ways.
    for (const chosen of [1, 5, 8, 20]) {
      expect(reseedGameCap(nba, chosen, { billsPerRequest: true })).toBe(chosen)
      expect(reseedGameCap(nba, chosen, { billsPerRequest: false })).toBe(chosen)
    }
    // A league with one cap has nothing to move, so every value is a choice.
    expect(reseedGameCap(LEAGUES.nfl, LEAGUES.nfl.maxGames, { billsPerRequest: true })).toBe(LEAGUES.nfl.maxGames)
  })

  it("retires the NHL as a league Today prices, while keeping it loggable", () => {
    // The tab is gone and nothing pulls it. What survives is the ability to
    // read a logged NHL entry, because settled history is the only thing that
    // can tell you the model was wrong.
    expect(isLeagueId("nhl")).toBe(false)
    expect(sportKeyFor("nhl")).toBeNull()
    expect(LEAGUE_IDS).not.toContain("nhl")
    expect(TAB_LEAGUE_IDS).not.toContain("nhl")
    // And the forgiving lookup does not quietly price hockey with NBA priors
    // by pretending the id is real: it falls back and says so by its id.
    expect(leagueFor("nhl").id).toBe(DEFAULT_LEAGUE)

    expect(isRetiredLeagueId("nhl")).toBe(true)
    expect(LOGGED_LEAGUE_IDS).toEqual(["nba", "nfl", "cfb", "nhl"])
    expect(loggedLeagueLabel("nhl")).toBe("NHL")
    // The one thing a retired league must still answer, since it decides
    // whether a logged "Points" leg is the basketball market or the hockey one.
    expect(sportOfLoggedLeague("nhl")).toBe("hockey")
    expect(sportOfLoggedLeague("nba")).toBe("basketball")
    expect(sportOfLoggedLeague("cfb")).toBe("football")
  })

  it("pulls NFL markets by default for the NFL, never basketball ones", () => {
    expect(LEAGUES.nfl.markets.length).toBeGreaterThan(0)
    for (const m of LEAGUES.nfl.markets) expect(m).toMatch(/^player_(pass|rush|reception)/)
  })

  it("caps plausible output by league", () => {
    // A 500-yard passing game happens in college football most Saturdays and
    // would be an NFL record. The warning threshold has to know the difference.
    expect(LEAGUES.cfb.caps.PASS_YDS!).toBeGreaterThan(LEAGUES.nfl.caps.PASS_YDS!)
    expect(LEAGUES.cfb.caps.RUSH_YDS!).toBeGreaterThan(LEAGUES.nfl.caps.RUSH_YDS!)
  })
})

describe("season awareness", () => {
  it("knows college football does not play in May", () => {
    expect(inSeason("cfb", new Date("2026-05-15T00:00:00Z"))).toBe(false)
    expect(inSeason("cfb", new Date("2026-09-15T00:00:00Z"))).toBe(true)
  })

  it("counts the NFL section as in season while a companion it pulls is playing", () => {
    // College football starts in August. With the companion on, the NFL
    // section really does have a slate then and the off-season notice would be
    // wrong; with it off there is nothing to pull and the notice is right.
    expect(inSeason("nfl", new Date("2026-08-29T00:00:00Z"), { companions: true })).toBe(true)
    expect(inSeason("nfl", new Date("2026-08-29T00:00:00Z"))).toBe(false)
    expect(inSeason("nfl", new Date("2026-06-15T00:00:00Z"), { companions: true })).toBe(false)
  })

  it("knows the NFL does not play in July but does in October and January", () => {
    expect(inSeason("nfl", new Date("2026-07-15T00:00:00Z"))).toBe(false)
    expect(inSeason("nfl", new Date("2026-10-15T00:00:00Z"))).toBe(true)
    expect(inSeason("nfl", new Date("2027-01-15T00:00:00Z"))).toBe(true)
  })
})

describe("credit warning", () => {
  it("shouts before an NFL pull with every market empties a monthly quota", () => {
    // 14 games x 10 markets = 140 credits, over a quarter of a 500-request month.
    const w = creditWarning("nfl", 14, 10)
    expect(w.credits).toBe(140)
    expect(w.severe).toBe(true)
    expect(w.message).toContain("NFL")
  })

  it("mentions but does not shout about a default full NFL Sunday", () => {
    const w = creditWarning("nfl", LEAGUES.nfl.maxGames, LEAGUES.nfl.markets.length)
    expect(w.credits).toBe(56)
    expect(w.severe).toBe(false)
    expect(w.confirm).toBe(false)
    expect(w.message).toContain("56")
  })

  it("stays quiet about an ordinary NBA pull", () => {
    const w = creditWarning("nba", 8, 4)
    expect(w.credits).toBe(32)
    expect(w.severe).toBe(false)
    expect(w.message).toBeNull()
  })

  it("reports nothing for an empty slate", () => {
    expect(creditWarning("nba", 0, 4).message).toBeNull()
  })

  it("counts the companion's games in what one press will cost", () => {
    // The NFL button also pays for the college games. Discovering that after
    // the press is the single most expensive surprise in the app.
    expect(plannedGames("nfl", 14, { companions: true })).toBe(14 + LEAGUES.cfb.maxGames)
    expect(plannedGames("nba", 14, { companions: true })).toBe(14)
  })

  it("prices each competition's own game cap, not one number for both", () => {
    // 14 NFL games at four markets plus six college games at four is 80.
    const plan = pullPlan("nfl", LEAGUES.nfl.maxGames, { companions: true })
    const credits = plan.reduce((a, p) => a + p.games * p.league.markets.length, 0)
    expect(credits).toBe(56 + 24)
  })

  it("asks before a default NFL press that pulls college football too", () => {
    // This is the press the gate exists for: 80 credits is 16% of a month, so
    // six of them empty it, and it is the one a careless refresh repeats.
    const plan = pullPlan("nfl", LEAGUES.nfl.maxGames, { companions: true })
    const credits = plan.reduce((a, p) => a + p.games * p.league.markets.length, 0)
    const gate = creditPlan("nfl", credits)
    expect(gate.credits).toBe(80)
    expect(gate.confirm).toBe(true)
    expect(gate.prompt).toContain("80")
    // And the NFL alone still does not ask.
    expect(creditPlan("nfl", 56).confirm).toBe(false)
  })

  it("asks before a pull that would empty the month in seven presses", () => {
    // A note beside the button is read after the credits are gone.
    const quiet = creditPlan("nfl", 64)
    expect(quiet.confirm).toBe(false)
    expect(quiet.prompt).toBeNull()
    const gate = creditPlan("nfl", 76)
    expect(gate.pctOfQuota).toBeGreaterThan(CONFIRM_PCT_OF_QUOTA)
    expect(gate.confirm).toBe(true)
    expect(gate.prompt).toContain("76")
    expect(gate.prompt).toContain("Pull anyway?")
    // The boundary itself asks: 15% of 500 is 75.
    expect(creditPlan("nfl", 75).confirm).toBe(true)
    expect(creditPlan("nfl", 74).confirm).toBe(false)
    // And a severe pull is always a confirm, never only a note.
    const severe = creditPlan("nfl", 140)
    expect(severe.severe).toBe(true)
    expect(severe.confirm).toBe(true)
  })

  it("never asks about a free or empty pull", () => {
    expect(creditPlan("nba", 0).confirm).toBe(false)
    expect(creditPlan("nba", 0).message).toBeNull()
  })
})

describe("feed urls", () => {
  it("targets the right sport per league", () => {
    expect(eventsUrl("KEY", "cfb")).toContain("/sports/americanfootball_ncaaf/events")
    expect(eventsUrl("KEY", "nfl")).toContain("/sports/americanfootball_nfl/events")
    // Default stays the NBA so existing callers are unaffected.
    expect(eventsUrl("KEY")).toContain("/sports/basketball_nba/events")
  })

  it("targets the right sport on the odds endpoint too", () => {
    const url = eventOddsUrl("KEY", "evt1", { markets: ["player_pass_yds"], regions: "us", league: "cfb" })
    expect(url).toContain("/sports/americanfootball_ncaaf/events/evt1/odds")
    expect(url).toContain("markets=player_pass_yds")
  })
})

describe("league-aware pricing", () => {
  const row = {
    player: "Test Player",
    market: "Passing Yards",
    line: 245.5,
    overOdds: -110,
    underOdds: -110,
  }

  it("widens the distribution for college football", () => {
    const nfl = projectProp(row, { ...DEFAULT_PROJECTION_SETTINGS, league: "nfl" })
    const cfb = projectProp(row, { ...DEFAULT_PROJECTION_SETTINGS, league: "cfb" })
    expect(nfl).not.toBeNull()
    expect(cfb).not.toBeNull()
    // Same line, same price, same implied mean, but a college projection is
    // less knowable, so the spread must be wider.
    expect(cfb!.sd).toBeGreaterThan(nfl!.sd)
  })

  it("leaves the probability at the priced line to the market, not the league", () => {
    // This is the property that matters most. When a book has priced the prop,
    // the devigged price IS the probability; the league prior must not move it.
    // A league that nudged a priced number would be inventing an edge.
    const priced = { ...row, overOdds: -200, underOdds: 160 }
    const nfl = projectProp(priced, { ...DEFAULT_PROJECTION_SETTINGS, league: "nfl" })!
    const cfb = projectProp(priced, { ...DEFAULT_PROJECTION_SETTINGS, league: "cfb" })!
    expect(Math.abs(cfb.pWin - nfl.pWin)).toBeLessThan(0.005)
  })

  it("pulls probabilities toward a coin flip away from the priced line", () => {
    // Off the priced line — which is exactly where a pick'em target sits — a
    // wider distribution must be less confident. This is where the league
    // volatility prior earns its keep.
    const priced = { ...row, overOdds: -200, underOdds: 160 }
    const nfl = projectProp(priced, { ...DEFAULT_PROJECTION_SETTINGS, league: "nfl" })!
    const cfb = projectProp(priced, { ...DEFAULT_PROJECTION_SETTINGS, league: "cfb" })!
    const target = 300.5
    const nflOver = resolveLine(nfl.distribution, target).over
    const cfbOver = resolveLine(cfb.distribution, target).over
    expect(Math.abs(cfbOver - 0.5)).toBeLessThan(Math.abs(nflOver - 0.5))
  })

  it("names the league in an implausible-projection warning, with college ceilings", () => {
    // 600 passing yards is implausible in the NFL and merely a huge college
    // afternoon, so the same projection must warn in one league and not the other.
    const huge = { player: "X", market: "Passing Yards", line: 600.5, overOdds: -110, underOdds: -110 }
    const nfl = projectProp(huge, { ...DEFAULT_PROJECTION_SETTINGS, league: "nfl" })!
    const cfb = projectProp(huge, { ...DEFAULT_PROJECTION_SETTINGS, league: "cfb" })!
    const warning = nfl.warnings.find((w) => w.includes("plausible"))
    expect(warning).toBeDefined()
    expect(warning).toContain("NFL")
    expect(cfb.warnings.find((w) => w.includes("plausible"))).toBeUndefined()
  })
})

describe("store migration", () => {
  it("keeps a pre-league NBA cache instead of discarding a paid-for slate", () => {
    const legacy = {
      version: 1,
      settings: {},
      slate: null,
      slips: [],
      daily: { fetchedAt: "2026-01-01T00:00:00Z", quotes: [{ book: "pinnacle" }], events: [], requestsRemaining: 400, creditsSpent: 44 },
    }
    const migrated = migrate(legacy)
    expect(migrated.daily.nba).toBeDefined()
    expect(migrated.daily.nba!.league).toBe("nba")
    expect(migrated.daily.nba!.quotes).toHaveLength(1)
  })

  it("keeps per-league caches and drops junk keys", () => {
    const stored = {
      version: 1,
      settings: { daily: { league: "nhl" } },
      slate: null,
      slips: [],
      daily: {
        nba: { fetchedAt: "x", quotes: [], events: [], requestsRemaining: null, creditsSpent: 0 },
        nhl: { fetchedAt: "y", quotes: [], events: [], requestsRemaining: null, creditsSpent: 0 },
        nfl: { fetchedAt: "z", quotes: [], events: [], requestsRemaining: null, creditsSpent: 0 },
        ncaab: { fetchedAt: "w", quotes: [], events: [] },
        mlb: { fetchedAt: "v", quotes: [], events: [] },
      },
    }
    const migrated = migrate(stored)
    // The NHL cache goes the way college basketball's did: the league is gone,
    // so a cache filed under it can never be shown and only takes up storage.
    expect(Object.keys(migrated.daily).sort()).toEqual(["nba", "nfl"])
    // And a phone that had the NHL tab selected opens on the NBA rather than
    // on a league that no longer exists.
    expect(migrated.settings.daily.league).toBe("nba")
  })

  it("moves someone who had the WNBA selected back to the NBA", () => {
    // The WNBA was removed. A phone that still has it stored, and the slate it
    // paid for, must not leave the app on a league that no longer exists.
    const migrated = migrate({
      version: 1,
      settings: { daily: { league: "wnba" }, projection: { league: "wnba" } },
      slate: { id: "s", createdAt: "x", league: "wnba", props: [] },
      daily: { wnba: { fetchedAt: "w", quotes: [], events: [] } },
    })
    expect(migrated.settings.daily.league).toBe("nba")
    expect(migrated.settings.projection.league).toBe("nba")
    expect(migrated.slate?.league).toBeUndefined()
    expect(migrated.daily).toEqual({})
  })

  it("moves someone who had college basketball selected back to the NBA", () => {
    // College basketball was removed. A phone that still has it stored must
    // open on a working league, not a blank or broken one.
    const migrated = migrate({
      version: 1,
      settings: { daily: { league: "ncaab" }, projection: { league: "ncaab" } },
      slate: { id: "s", createdAt: "x", league: "ncaab", props: [] },
      daily: { ncaab: { fetchedAt: "w", quotes: [], events: [] } },
    })
    expect(migrated.settings.daily.league).toBe("nba")
    expect(migrated.settings.projection.league).toBe("nba")
    expect(migrated.slate?.league).toBeUndefined()
    expect(migrated.daily).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// End-to-end: an NFL slate, and a college slate inside it, through the whole
// daily pipeline.
//
// The feed cannot be reached from CI, so these use fixtures shaped like a real
// response. They prove the pipeline is genuinely league-agnostic: the same
// engine that prices an NBA slate prices an NFL one at NFL numbers with its own
// markets and spreads, and a college prop in the same slate at college numbers.
// ---------------------------------------------------------------------------

import { buildDailyPicks } from "@/lib/today/build"
import { DEFAULT_VALUE_SETTINGS, type FeedQuote } from "@/lib/quant/valuebets"
import { DEFAULT_CORRELATION } from "@/lib/quant/correlation"
import { DEFAULT_CONSTRAINTS } from "@/lib/quant/optimizer"

function quote(
  player: string,
  market: FeedQuote["market"],
  book: string,
  line: number,
  over: number | null,
  under: number | null,
  gameId: string,
): FeedQuote {
  return {
    book, line, overOdds: over, underOdds: under, fetchedAt: null,
    player, market, gameId,
    homeTeam: gameId.split("@")[1], awayTeam: gameId.split("@")[0],
    commenceTime: "2026-02-16T00:10:00Z",
  }
}

function optsFor(league: LeagueId) {
  return {
    value: { ...DEFAULT_VALUE_SETTINGS, projection: { ...DEFAULT_PROJECTION_SETTINGS, league } },
    correlation: DEFAULT_CORRELATION,
    constraints: { ...DEFAULT_CONSTRAINTS, picks: 2, maxPerGame: 2, maxPerTeam: 2 },
    dfsBreakEven: 0.577,
    now: Date.parse("2026-02-15T18:00:00Z"),
  }
}

/**
 * College games as they arrive inside an NFL pull: the same markets, tagged
 * with the competition they came from so the engine prices them as college.
 */
const CFB_QUOTES: FeedQuote[] = [
  cfb(quote("Drew Allar", "PASS_YDS", "pinnacle", 245.5, -110, -110, "PSU@OSU")),
  cfb(quote("Drew Allar", "PASS_YDS", "draftkings", 245.5, -105, -115, "PSU@OSU")),
  cfb(quote("Drew Allar", "PASS_YDS", "fanduel", 244.5, -110, -110, "PSU@OSU")),
  cfb(quote("Quinshon Judkins", "RUSH_YDS", "pinnacle", 88.5, -112, -108, "PSU@OSU")),
  cfb(quote("Quinshon Judkins", "RUSH_YDS", "draftkings", 88.5, -110, -110, "PSU@OSU")),
  cfb(quote("Quinshon Judkins", "RUSH_YDS", "fanduel", 87.5, -108, -112, "PSU@OSU")),
]

function cfb(q: FeedQuote): FeedQuote {
  return { ...q, competition: "cfb" }
}

/** An NFL slate at NFL-sized lines, Pinnacle plus two retail books. */
const NFL_QUOTES: FeedQuote[] = [
  quote("Josh Allen", "PASS_YDS", "pinnacle", 245.5, -112, -108, "BUF@KC"),
  quote("Josh Allen", "PASS_YDS", "draftkings", 244.5, -110, -110, "BUF@KC"),
  quote("Josh Allen", "PASS_YDS", "fanduel", 245.5, 105, -125, "BUF@KC"),
  quote("Isiah Pacheco", "RUSH_YDS", "pinnacle", 62.5, -110, -110, "BUF@KC"),
  quote("Isiah Pacheco", "RUSH_YDS", "draftkings", 62.5, -115, -105, "BUF@KC"),
  quote("Isiah Pacheco", "RUSH_YDS", "fanduel", 61.5, -110, -110, "BUF@KC"),
  quote("Travis Kelce", "REC_YDS", "pinnacle", 58.5, -108, -112, "BUF@KC"),
  quote("Travis Kelce", "REC_YDS", "draftkings", 58.5, 110, -130, "BUF@KC"),
  quote("Travis Kelce", "REC_YDS", "fanduel", 58.5, -110, -110, "BUF@KC"),
  quote("Travis Kelce", "REC", "pinnacle", 5.5, -125, 105, "BUF@KC"),
  quote("Travis Kelce", "REC", "draftkings", 5.5, -120, 100, "BUF@KC"),
  quote("Travis Kelce", "REC", "fanduel", 5.5, -118, -102, "BUF@KC"),
  quote("Justin Jefferson", "REC_YDS", "pinnacle", 82.5, -110, -110, "MIN@DET"),
  quote("Justin Jefferson", "REC_YDS", "draftkings", 82.5, -105, -115, "MIN@DET"),
  quote("Justin Jefferson", "REC_YDS", "fanduel", 81.5, -110, -110, "MIN@DET"),
]

describe("end-to-end daily pipeline per league", () => {
  it("prices NFL and college games in one slate, each with its own numbers", () => {
    const picks = buildDailyPicks([...NFL_QUOTES, ...CFB_QUOTES], optsFor("nfl"))
    expect(picks.games.map((g) => g.gameId).sort()).toEqual(["BUF@KC", "MIN@DET", "PSU@OSU"])
    expect(picks.stats.pricedProps).toBe(7)

    const allar = picks.dfsTargets.find((t) => t.player === "Drew Allar")!
    const allen = picks.dfsTargets.find((t) => t.player === "Josh Allen")!
    // The same posted line in both competitions: the college one is tagged, and
    // its spread is wider because its priors say it is less knowable.
    expect(allar.competition).toBe("cfb")
    expect(allen.competition).toBeUndefined()
    expect(Math.abs(allar.mean - allen.mean)).toBeLessThan(6)
    expect(allar.sd).toBeGreaterThan(allen.sd)
  })

  it("carries the competition onto a value bet, so a mixed table can say which", () => {
    const soft = CFB_QUOTES.map((q) => (q.book === "fanduel" ? { ...q, overOdds: 140 } : q))
    const picks = buildDailyPicks(soft, { ...optsFor("nfl"), bettableBooks: ["fanduel"] })
    for (const b of picks.valueBets) expect(b.competition).toBe("cfb")
  })

  it("prices an NFL slate at NFL numbers", () => {
    const picks = buildDailyPicks(NFL_QUOTES, optsFor("nfl"))
    expect(picks.games.map((g) => g.gameId).sort()).toEqual(["BUF@KC", "MIN@DET"])
    expect(picks.stats.props).toBe(5)
    expect(picks.stats.pricedProps).toBe(5)
    // Projections land on the posted lines, with football-sized spreads: a
    // quarterback's yards swing by tens of yards, not a handful.
    const allen = picks.dfsTargets.find((t) => t.player === "Josh Allen")
    expect(allen).toBeDefined()
    expect(allen!.mean).toBeGreaterThan(225)
    expect(allen!.mean).toBeLessThan(270)
    expect(allen!.sd).toBeGreaterThan(40)
    expect(allen!.sd).toBeLessThan(100)
  })

  it("finds pick'em targets on yardage props, well away from the posted line", () => {
    // The target walk used to stop 15 either side of the projection. With a
    // passing-yards spread near 70 the break-even line sits further out than
    // that, and every yardage prop came back as a pass.
    const picks = buildDailyPicks(NFL_QUOTES, optsFor("nfl"))
    const allen = picks.dfsTargets.find((t) => t.player === "Josh Allen")!
    expect(allen.overAt).not.toBeNull()
    expect(allen.underAt).not.toBeNull()
    expect(allen.overAt!).toBeLessThan(allen.fairLine)
    expect(allen.underAt!).toBeGreaterThan(allen.fairLine)
    // A 57.7% hit rate on a 70-yard spread is roughly 14 yards off fair, not 1.
    expect(allen.fairLine - allen.overAt!).toBeGreaterThan(5)
  })

  it("refuses to price a slate with no sportsbook odds, in every league", () => {
    for (const lg of LEAGUE_IDS) {
      const naked = [...CFB_QUOTES, ...NFL_QUOTES].map((q) => ({ ...q, overOdds: null, underOdds: null }))
      const picks = buildDailyPicks(naked, optsFor(lg))
      expect(picks.stats.pricedProps).toBe(0)
      expect(picks.valueBets).toHaveLength(0)
      expect(picks.parlays).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// NFL market plumbing
// ---------------------------------------------------------------------------

import { normalizeMarket, distributionFor } from "@/lib/nba/markets"
import {
  FEED_MARKET_MAP,
  HOCKEY_FEED_MARKET_MAP,
  marketsForCompetition,
  marketsForLeague,
} from "@/lib/odds-feed/theoddsapi"

describe("NFL markets", () => {
  it("reads the ways boards and books write football stats", () => {
    const cases: [string, string][] = [
      ["Pass Yards", "PASS_YDS"],
      ["Passing Yards", "PASS_YDS"],
      ["Pass TDs", "PASS_TDS"],
      ["Pass Completions", "PASS_COMP"],
      ["Pass Attempts", "PASS_ATT"],
      ["Interceptions", "PASS_INT"],
      ["Rush Yards", "RUSH_YDS"],
      ["Rushing Yards", "RUSH_YDS"],
      ["Rush Attempts", "RUSH_ATT"],
      ["Receptions", "REC"],
      ["Receiving Yards", "REC_YDS"],
      ["Rec Yds", "REC_YDS"],
      ["Rush + Rec Yds", "RUSH_REC_YDS"],
      ["NFL Passing Yards O/U", "PASS_YDS"],
    ]
    for (const [raw, key] of cases) expect(normalizeMarket(raw).key, raw).toBe(key)
  })

  it("leaves every basketball market where it was", () => {
    const cases: [string, string][] = [
      ["Points", "PTS"],
      ["Rebounds", "REB"],
      ["Assists", "AST"],
      ["3-Pointers Made", "3PM"],
      ["Pts+Rebs+Asts", "PRA"],
      ["FG Attempted", "FGA"],
      ["3PT Attempted", "3PA"],
      ["Blocked Shots", "BLK"],
      ["Turnovers", "TOV"],
      ["Free Throws Made", "FTM"],
    ]
    for (const [raw, key] of cases) expect(normalizeMarket(raw).key, raw).toBe(key)
  })

  it("maps every default NFL feed market", () => {
    for (const k of LEAGUES.nfl.markets) expect(FEED_MARKET_MAP[k], k).toBeDefined()
    // College football asks for the same keys, so the same map has to cover it.
    for (const k of LEAGUES.cfb.markets) expect(FEED_MARKET_MAP[k], k).toBeDefined()
  })

  it("still resolves hockey feed keys, which nothing pulls and logged entries need", () => {
    // No league asks for these any more. The map stays so a stored or imported
    // payload naming them still reads, rather than being silently typed as
    // basketball. See RETIRED_LEAGUES.
    expect(HOCKEY_FEED_MARKET_MAP.player_shots_on_goal).toBe("SOG")
    expect(HOCKEY_FEED_MARKET_MAP.player_total_saves).toBe("SAVES")
    expect(HOCKEY_FEED_MARKET_MAP.player_points).toBe("HKY_PTS")
    // And no league's market list can ask for one, which is what stops a
    // credit being spent on a response nothing will price.
    for (const id of LEAGUE_IDS) {
      for (const k of marketsForLeague(id, null)) {
        expect(FEED_MARKET_MAP[k], `${id} ${k}`).toBeDefined()
      }
    }
  })

  it("never bills a basketball market list against an NFL slate", () => {
    expect(marketsForLeague("nfl", ["player_points", "player_rebounds"])).toEqual(LEAGUES.nfl.markets)
    expect(marketsForLeague("nfl", ["player_points", "player_pass_tds"])).toEqual(["player_pass_tds"])
    expect(marketsForLeague("nba", ["player_pass_yds"])).toEqual(LEAGUES.nba.markets)
    expect(marketsForLeague("nba", null)).toEqual(LEAGUES.nba.markets)
    // College football is football: an NFL market list is kept for it, and a
    // basketball one falls back to its own defaults rather than being billed.
    expect(marketsForLeague("cfb", ["player_pass_yds"])).toEqual(["player_pass_yds"])
    expect(marketsForLeague("cfb", ["player_points"])).toEqual(LEAGUES.cfb.markets)
    // But a companion ignores the Markets box entirely: that box belongs to
    // the league you selected, and letting a four-market NFL list travel
    // across would undo the saving college football's own list exists for.
    expect(marketsForCompetition(LEAGUES.cfb, ["player_pass_yds", "player_receptions"])).toEqual(LEAGUES.cfb.markets)
    expect(marketsForCompetition(LEAGUES.nfl, ["player_receptions"])).toEqual(["player_receptions"])
  })

  it("holds the whole of a passing-yards distribution, not a truncated one", () => {
    // The support used to stop at 400. A 265-yard projection with a 70-yard
    // spread has real mass out there, and cutting it off shifted every
    // probability toward the under.
    const d = distributionFor("PASS_YDS", 265)
    expect(d.support).toBeGreaterThan(265 + 6 * d.sd)
    let total = 0
    let mean = 0
    for (let k = 0; k <= d.support; k++) {
      total += d.pmf(k)
      mean += k * d.pmf(k)
    }
    expect(total).toBeCloseTo(1, 6)
    expect(mean).toBeCloseTo(265, 0)
  })

  it("models passing touchdowns as under-dispersed", () => {
    const d = distributionFor("PASS_TDS", 1.6)
    expect(d.family).toBe("binomial")
    expect(d.variance).toBeLessThan(1.6)
  })
})

// ---------------------------------------------------------------------------
// NHL
// ---------------------------------------------------------------------------

import { marketForSport } from "@/lib/nba/markets"
import { normalizeEventOdds } from "@/lib/odds-feed/theoddsapi"
import type { FeedEventOdds } from "@/lib/odds-feed/types"

// Hockey is no longer pulled. These pin the read path a logged NHL entry
// depends on: see RETIRED_LEAGUES.
describe("hockey markets, for logged entries", () => {
  it("reads hockey labels as hockey markets, and keeps basketball's own", () => {
    expect(normalizeMarket("Shots On Goal").key).toBe("SOG")
    expect(normalizeMarket("Goalie Saves").key).toBe("SAVES")
    expect(normalizeMarket("Hockey Points").key).toBe("HKY_PTS")
    expect(normalizeMarket("Power Play Points").key).toBe("HKY_PPP")
    expect(normalizeMarket("Goals").key).toBe("HKY_GOALS")
    // Unchanged for basketball: the bare words stay basketball, and
    // "field goals" never becomes hockey goals.
    expect(normalizeMarket("Points").key).toBe("PTS")
    expect(normalizeMarket("Field Goals").key).toBe("FGM")
    expect(normalizeMarket("Field Goals Made").key).toBe("FGM")
  })

  it("swaps points, assists and blocked shots between the sports", () => {
    expect(marketForSport("PTS", "hockey")).toBe("HKY_PTS")
    expect(marketForSport("AST", "hockey")).toBe("HKY_AST")
    expect(marketForSport("BLK", "hockey")).toBe("HKY_BLK")
    expect(marketForSport("SOG", "hockey")).toBe("SOG")
    expect(marketForSport("HKY_PTS", "basketball")).toBe("PTS")
    expect(marketForSport("REB", "hockey")).toBe("REB")
  })

  it("maps the feed's player_points to hockey points on an NHL game, and basketball points otherwise", () => {
    const event = (sport_key?: string): FeedEventOdds => ({
      id: "e1",
      sport_key,
      commence_time: "2026-10-08T23:00:00Z",
      home_team: "Toronto Maple Leafs",
      away_team: "Montreal Canadiens",
      bookmakers: [
        {
          key: "pinnacle",
          title: "Pinnacle",
          markets: [
            { key: "player_points", outcomes: [
              { name: "Over", description: "Auston Matthews", price: 105, point: 0.5 },
              { name: "Under", description: "Auston Matthews", price: -125, point: 0.5 },
            ] },
            { key: "player_shots_on_goal", outcomes: [
              { name: "Over", description: "Auston Matthews", price: -160, point: 3.5 },
              { name: "Under", description: "Auston Matthews", price: 130, point: 3.5 },
            ] },
          ],
        },
      ],
    })
    const asked = normalizeEventOdds(event(), "hockey").quotes.map((q) => q.market).sort()
    expect(asked).toEqual(["HKY_PTS", "SOG"])
    const fromPayload = normalizeEventOdds(event("icehockey_nhl")).quotes.map((q) => q.market).sort()
    expect(fromPayload).toEqual(["HKY_PTS", "SOG"])
    // A basketball payload: player_points is basketball, and shots on goal is not a market there.
    const nba = normalizeEventOdds(event("basketball_nba"))
    expect(nba.quotes.map((q) => q.market)).toEqual(["PTS"])
    expect(nba.unknownMarkets).toEqual(["player_shots_on_goal"])
  })

  it("never bills a hockey market against a basketball slate", () => {
    expect(marketsForLeague("nba", ["player_shots_on_goal"])).toEqual(LEAGUES.nba.markets)
  })
})

