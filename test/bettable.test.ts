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

import { DEFAULT_ODDS_FEED, marketsFor, migrate, withMarketsFor } from "@/lib/store/schema"
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
    // And no market list for either feed, so each pulls its league's own:
    // the whole board on PropLine, the five-market budget on The Odds API.
    expect(DEFAULT_SETTINGS.daily.markets).toEqual({})
    expect(marketsFor(DEFAULT_SETTINGS.daily, "propline")).toBeNull()
    expect(marketsFor(DEFAULT_SETTINGS.daily, "theoddsapi")).toBeNull()
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

  it("flags a move the app made, so a refused key can undo it", () => {
    // The move is guarded on a stored PropLine key, and a key being present
    // is not the same as PropLine accepting it -- nothing offline can tell
    // those apart. So the move is marked, and the Today screen puts the
    // provider back when PropLine refuses the key. Only the app's own guess
    // is ever undone.
    const moved = migrate({
      settings: { oddsFeed: { provider: "theoddsapi", apiKey: "abc", proplineKey: "pk" } },
    })
    expect(moved.settings.oddsFeed.provider).toBe("propline")
    expect(moved.settings.oddsFeed.autoMovedToPropline).toBe(true)

    // A provider nobody moved carries no flag, so nothing can undo it.
    const chosen = migrate({
      settings: { oddsFeed: { provider: "propline", proplineKey: "pk" } },
    })
    expect(chosen.settings.oddsFeed.provider).toBe("propline")
    expect(chosen.settings.oddsFeed.autoMovedToPropline).toBeFalsy()

    // Nor does an install left where it was for want of a PropLine key.
    const stayed = migrate({ settings: { oddsFeed: { provider: "theoddsapi", apiKey: "abc" } } })
    expect(stayed.settings.oddsFeed.provider).toBe("theoddsapi")
    expect(stayed.settings.oddsFeed.autoMovedToPropline).toBeFalsy()

    // And once spent it stays spent, so a later refusal is the user's to fix.
    const spent = migrate({
      version: 3,
      settings: {
        oddsFeed: { provider: "propline", apiKey: "abc", proplineKey: "pk", autoMovedToPropline: false },
      },
    })
    expect(spent.settings.oddsFeed.autoMovedToPropline).toBe(false)
  })

  it("files a legacy market list under the feed it was typed for", () => {
    const LIST = ["player_points", "player_rebounds"]

    // Typed on The Odds API, where it is a credit budget. It stays there, and
    // PropLine starts blank so it pulls the whole free board.
    const onOddsApi = migrate({
      settings: {
        oddsFeed: { provider: "theoddsapi", apiKey: "abc" },
        daily: { league: "nba", markets: LIST },
      },
    })
    expect(marketsFor(onOddsApi.settings.daily, "theoddsapi")).toEqual(LIST)
    expect(marketsFor(onOddsApi.settings.daily, "propline")).toBeNull()

    // The regression this shape removes. Same install, but holding a PropLine
    // key, so the upgrade moves it to PropLine. The budget must not follow it
    // across and must not be thrown away: blank on The Odds API is the
    // five-market default, so clearing it takes a 14-game press from 56
    // credits to 70 -- a bill raised by a migration, under the share that
    // makes the button ask, so silently.
    const moved = migrate({
      settings: {
        oddsFeed: { provider: "theoddsapi", apiKey: "abc", proplineKey: "pk" },
        daily: { league: "nba", maxGames: 14, markets: LIST },
      },
    })
    expect(moved.settings.oddsFeed.provider).toBe("propline")
    expect(marketsFor(moved.settings.daily, "theoddsapi")).toEqual(LIST)
    expect(marketsFor(moved.settings.daily, "propline")).toBeNull()

    // Typed ON PropLine it was never a budget, and narrowing the free board
    // only loses pick'em lines, so it goes. Clearing cannot raise a bill on a
    // feed that charges per request whatever is asked for.
    const onPropline = migrate({
      settings: {
        oddsFeed: { provider: "propline", proplineKey: "pk" },
        daily: { league: "nba", markets: LIST },
      },
    })
    expect(marketsFor(onPropline.settings.daily, "propline")).toBeNull()
    expect(marketsFor(onPropline.settings.daily, "theoddsapi")).toBeNull()
  })

  it("keeps each feed's market list independent once stored per feed", () => {
    const perFeed = migrate({
      version: 3,
      settings: {
        oddsFeed: { provider: "propline", proplineKey: "pk" },
        daily: {
          league: "nba",
          markets: { theoddsapi: ["player_points"], propline: ["player_points", "player_threes"] },
        },
      },
    })
    expect(marketsFor(perFeed.settings.daily, "theoddsapi")).toEqual(["player_points"])
    expect(marketsFor(perFeed.settings.daily, "propline")).toEqual(["player_points", "player_threes"])

    // Writing one feed's slot leaves the other alone, which is the whole point.
    const next = withMarketsFor(perFeed.settings.daily.markets, "propline", null)
    expect(marketsFor({ markets: next }, "propline")).toBeNull()
    expect(marketsFor({ markets: next }, "theoddsapi")).toEqual(["player_points"])

    // Junk in a slot reads as blank rather than being asked for.
    const junk = migrate({
      version: 3,
      settings: { oddsFeed: { provider: "propline", proplineKey: "pk" },
                  daily: { league: "nba", markets: { propline: [1, null, ""], theoddsapi: "nope" } } },
    })
    expect(marketsFor(junk.settings.daily, "propline")).toBeNull()
    expect(marketsFor(junk.settings.daily, "theoddsapi")).toBeNull()
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
