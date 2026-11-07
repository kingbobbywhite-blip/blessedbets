import { describe, expect, it } from "vitest"
import { buildDailyPicks } from "@/lib/today/build"
import { DEFAULT_VALUE_SETTINGS, type FeedQuote } from "@/lib/quant/valuebets"
import { DEFAULT_CORRELATION } from "@/lib/quant/correlation"
import { DEFAULT_CONSTRAINTS } from "@/lib/quant/optimizer"
import { DEFAULT_SETTINGS } from "@/lib/store/schema"

/**
 * A bet must only ever be recommended at a book the user can place it at.
 *
 * Reported: the app named "Marine Johannès over 4.5" as the best bet and the
 * user could not find that line on FanDuel. Offshore reference books (Pinnacle,
 * BetOnline, LowVig) were eligible to be "the offer", and they are the books
 * whose lines most often differ from US retail. They still judge the price;
 * they are never offered as the bet.
 */

const OPTS = {
  value: DEFAULT_VALUE_SETTINGS,
  correlation: DEFAULT_CORRELATION,
  constraints: { ...DEFAULT_CONSTRAINTS, picks: 2, maxPerGame: 3, maxPerTeam: 3 },
  dfsBreakEven: 0.562,
  now: Date.parse("2026-09-27T12:00:00Z"),
}

function q(player: string, book: string, line: number, over: number, under: number): FeedQuote {
  return {
    book, line, overOdds: over, underOdds: under, fetchedAt: null,
    player, market: "AST", gameId: "MIN@NYL", homeTeam: "NYL", awayTeam: "MIN",
    commenceTime: "2026-09-27T15:00:00Z",
  }
}

// The market agrees on 4.5 at -110 both ways; BetOnline hangs a soft over.
const QUOTES: FeedQuote[] = [
  q("Marine Johannes", "pinnacle", 4.5, -110, -110),
  q("Marine Johannes", "draftkings", 4.5, -112, -108),
  q("Marine Johannes", "fanduel", 4.5, -110, -110),
  q("Marine Johannes", "betonlineag", 4.5, 115, -140),
]

describe("bettable books", () => {
  it("reproduces the report: without a list, the offshore price is the best bet", () => {
    const picks = buildDailyPicks(QUOTES, OPTS)
    expect(picks.valueBets.map((b) => b.book)).toContain("betonlineag")
  })

  it("never recommends a bet at a book outside the list", () => {
    const picks = buildDailyPicks(QUOTES, { ...OPTS, bettableBooks: ["fanduel", "draftkings"] })
    expect(picks.valueBets.every((b) => ["fanduel", "draftkings"].includes(b.book))).toBe(true)
    expect(picks.parlays.every((p) => p.legs.every((l) => ["FanDuel", "DraftKings"].includes(l.app ?? "")))).toBe(true)
  })

  it("counts the hidden edges so the screen can say so", () => {
    const picks = buildDailyPicks(QUOTES, { ...OPTS, bettableBooks: ["fanduel"] })
    expect(picks.stats.hiddenOffers).toBeGreaterThan(0)
    expect(picks.stats.hiddenBooks).toContain("betonlineag")
    expect(picks.stats.hiddenBooks).not.toContain("fanduel")
  })

  it("still uses the offshore books to judge the price", () => {
    // Removing BetOnline from the bettable list must not remove it from the
    // reference: the priced-prop count is the same either way.
    const all = buildDailyPicks(QUOTES, OPTS)
    const mine = buildDailyPicks(QUOTES, { ...OPTS, bettableBooks: ["fanduel"] })
    expect(mine.stats.pricedProps).toBe(all.stats.pricedProps)
  })

  it("defaults to US retail books only", () => {
    const offshore = ["pinnacle", "betonlineag", "lowvig", "bookmaker", "circa"]
    expect(DEFAULT_SETTINGS.oddsFeed.bettable).toContain("fanduel")
    expect(DEFAULT_SETTINGS.oddsFeed.bettable.some((b) => offshore.includes(b))).toBe(false)
  })
})

import { DEFAULT_ODDS_FEED, migrate } from "@/lib/store/schema"
import { LEAGUES, maxGamesFor } from "@/lib/leagues"

describe("the books in the rotation", () => {
  it("recommends bets at FanDuel only by default; the sharp books stay references", () => {
    expect(DEFAULT_SETTINGS.oddsFeed.bettable).toEqual(["fanduel"])
    expect(DEFAULT_SETTINGS.oddsFeed.books).toContain("pinnacle")
  })

  it("moves a phone still on the old five-book default to FanDuel, and keeps a list someone chose", () => {
    const old = migrate({ settings: { oddsFeed: { bettable: ["fanduel", "draftkings", "betmgm", "williamhill_us", "espnbet"] } } })
    expect(old.settings.oddsFeed.bettable).toEqual(["fanduel"])
    const chosen = migrate({ settings: { oddsFeed: { bettable: ["fanduel", "draftkings"] } } })
    expect(chosen.settings.oddsFeed.bettable).toEqual(["fanduel", "draftkings"])
  })

  it("drops Dabble and Chalkboard, which are not in the rotation", () => {
    expect(DEFAULT_SETTINGS.apps.map((a) => a.id)).toEqual(["prizepicks", "underdog", "sleeper", "winible", "real", "prophetx", "polymarket"])
    const stored = migrate({ settings: { apps: [...DEFAULT_SETTINGS.apps, { ...DEFAULT_SETTINGS.apps[0], id: "dabble" }] } })
    expect(stored.settings.apps.some((a) => a.id === "dabble")).toBe(false)
  })
})

import { isSharp, bookProfile, bookConsensus } from "@/lib/quant/books"

describe("PropLine settings", () => {
  it("keeps a phone from before the provider choice on The Odds API, with its key", () => {
    const old = migrate({ settings: { oddsFeed: { apiKey: "abc", bettable: ["fanduel"] } } })
    expect(old.settings.oddsFeed.provider).toBe("theoddsapi")
    expect(old.settings.oddsFeed.apiKey).toBe("abc")
    expect(old.settings.oddsFeed.proplineKey).toBe("")
    expect(old.settings.oddsFeed.pickemLines).toBe(true)
  })

  it("falls back by the keys it holds for a provider it does not know", () => {
    // An unknown name is not a choice, so the keys decide. Only an install
    // holding neither key gets the bare default -- which is the point: the
    // default must never move a phone onto a feed it cannot call.
    const neither = migrate({ settings: { oddsFeed: { provider: "pinnwire" as never } } })
    expect(neither.settings.oddsFeed.provider).toBe(DEFAULT_ODDS_FEED.provider)

    const oddsApiOnly = migrate({ settings: { oddsFeed: { provider: "pinnwire" as never, apiKey: "abc" } } })
    expect(oddsApiOnly.settings.oddsFeed.provider).toBe("theoddsapi")

    const proplineOnly = migrate({ settings: { oddsFeed: { provider: "pinnwire" as never, proplineKey: "abc" } } })
    expect(proplineOnly.settings.oddsFeed.provider).toBe("propline")

    // A placeholder left in a copied example file is not a key, so it cannot
    // select a feed that will 401.
    const placeholder = migrate({
      settings: { oddsFeed: { provider: "pinnwire" as never, apiKey: "abc", proplineKey: "xxxx" } },
    })
    expect(placeholder.settings.oddsFeed.provider).toBe("theoddsapi")

    // A name it knows is honoured whatever the keys say.
    expect(migrate({ settings: { oddsFeed: { provider: "propline" } } }).settings.oddsFeed.provider).toBe("propline")
    expect(
      migrate({ settings: { oddsFeed: { provider: "theoddsapi", apiKey: "abc" } }, version: 2 }).settings.oddsFeed
        .provider,
    ).toBe("theoddsapi")
  })

  it("ships a game cap that matches the feed it ships", () => {
    // The two defaults are set in different places and nothing but this test
    // ties them together. A fresh install on PropLine with the credit cap
    // would leave the last game of a 15-game night unpulled to save credits
    // PropLine does not charge, which is the mismatch the split removes --
    // and no other test would notice, because each default is valid alone.
    expect(DEFAULT_SETTINGS.daily.maxGames).toBe(
      maxGamesFor(LEAGUES[DEFAULT_SETTINGS.daily.league], {
        billsPerRequest: DEFAULT_ODDS_FEED.provider === "propline",
      }),
    )
    // Stated concretely too, so a change to either default has to come here
    // and say what it meant rather than quietly tracking a formula.
    expect(DEFAULT_ODDS_FEED.provider).toBe("propline")
    expect(DEFAULT_SETTINGS.daily.maxGames).toBe(15)
    // And a blank market list, so the per-request board is pulled whole.
    expect(DEFAULT_SETTINGS.daily.markets).toBeNull()
  })

  it("moves an install that never chose a feed onto PropLine, once, and only with a key", () => {
    // The upgrade to STATE_VERSION 2. Guarded on a stored PropLine key,
    // because moving a phone onto a feed it cannot call does not cost a
    // preference, it stops the app pulling.
    const withKey = migrate({
      settings: { oddsFeed: { provider: "theoddsapi", apiKey: "abc", proplineKey: "pk" } },
    })
    expect(withKey.settings.oddsFeed.provider).toBe("propline")

    // No PropLine key: left where it is, to switch in Settings in one click.
    const without = migrate({ settings: { oddsFeed: { provider: "theoddsapi", apiKey: "abc" } } })
    expect(without.settings.oddsFeed.provider).toBe("theoddsapi")

    // Already upgraded, so a deliberate return to The Odds API sticks.
    const again = migrate({
      version: 2,
      settings: { oddsFeed: { provider: "theoddsapi", apiKey: "abc", proplineKey: "pk" } },
    })
    expect(again.settings.oddsFeed.provider).toBe("theoddsapi")
  })

  it("clears a stored market list that was narrowing a per-request feed, once", () => {
    // Four NBA markets on PropLine is four of eleven for the same requests,
    // and on a feed that bills per request it was never a budget, so it goes.
    const narrowed = migrate({
      settings: {
        oddsFeed: { provider: "propline", proplineKey: "pk" },
        daily: { league: "nba", markets: ["player_points", "player_rebounds"] },
      },
    })
    expect(narrowed.settings.daily.markets).toBeNull()

    // The same list on The Odds API is a credit budget somebody meant.
    const budget = migrate({
      settings: {
        oddsFeed: { provider: "theoddsapi", apiKey: "abc" },
        daily: { league: "nba", markets: ["player_points", "player_rebounds"] },
      },
    })
    expect(budget.settings.daily.markets).toEqual(["player_points", "player_rebounds"])

    // And it is STILL a budget when the same upgrade moves that install to
    // PropLine, which is the case the first version of this got wrong: the
    // list is judged against the feed it was typed for, not the one the move
    // lands on. Clearing it here raises the bill on the feed they came from --
    // blank is the five-market default there, so a 14-game press goes 56 -> 70
    // credits, under the 15% that makes the button ask, so silently.
    const moved = migrate({
      settings: {
        oddsFeed: { provider: "theoddsapi", apiKey: "abc", proplineKey: "pk" },
        daily: { league: "nba", maxGames: 14, markets: ["player_points", "player_rebounds"] },
      },
    })
    expect(moved.settings.oddsFeed.provider).toBe("propline")
    expect(moved.settings.daily.markets).toEqual(["player_points", "player_rebounds"])

    // Already upgraded: a list typed after the change is a choice and stays.
    const after = migrate({
      version: 2,
      settings: {
        oddsFeed: { provider: "propline", proplineKey: "pk" },
        daily: { league: "nba", markets: ["player_points"] },
      },
    })
    expect(after.settings.daily.markets).toEqual(["player_points"])
  })

  it("keeps the pick'em lines on a cached pull", () => {
    const line = {
      app: "prizepicks", player: "A", playerKey: "a", market: "PTS", gameId: "X@Y", line: 20.5,
      pickType: "standard", over: { multiplier: null }, under: { multiplier: null }, fetchedAt: null,
    }
    const m = migrate({
      daily: { nba: { league: "nba", fetchedAt: "", quotes: [], events: [], requestsRemaining: 900, creditsSpent: 0, provider: "propline", pickemLines: [line] } },
    })
    expect(m.daily.nba!.pickemLines).toHaveLength(1)
    expect(m.daily.nba!.provider).toBe("propline")
  })
})

describe("exchanges and offshore books from PropLine", () => {
  it("never treats an exchange as a sharp reference", () => {
    for (const id of ["prophetx", "polymarket", "kalshi", "novig", "bovada"]) {
      expect(isSharp(id)).toBe(false)
      expect(bookProfile(id).tier).not.toBe("unknown")
    }
  })

  it("keeps a room full of exchanges from outvoting one sharp book", () => {
    const c = bookConsensus([
      { book: "betonlineag", value: 0.5 },
      { book: "prophetx", value: 0.7 },
      { book: "polymarket", value: 0.7 },
      { book: "kalshi", value: 0.7 },
      { book: "novig", value: 0.7 },
      { book: "bovada", value: 0.7 },
    ])!
    // BetOnline weighs 0.5; the five others share a 0.45 cap.
    expect(c.value).toBeLessThan(0.6)
  })
})
