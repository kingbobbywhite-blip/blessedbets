import { describe, expect, it } from "vitest"
import {
  cleanPlayerName,
  normalizeProplineEvent,
  proplineEventOddsUrl,
  proplineEventsUrl,
  proplineMarkets,
  proplineQuota,
  proplineSportKey,
  pullPropline,
  type ProplineEventOdds,
} from "@/lib/odds-feed/propline"
import { feedKeyFor } from "@/lib/odds-feed/theoddsapi"

const event: ProplineEventOdds = {
  id: 4821,
  sport_key: "basketball_nba",
  commence_time: "2026-01-16T00:10:00Z",
  home_team: "Oklahoma City Thunder",
  away_team: "Minnesota Timberwolves",
  bookmakers: [
    {
      key: "betonlineag",
      title: "BetOnline",
      markets: [
        {
          key: "player_points",
          outcomes: [
            { name: "Over", description: "Anthony Edwards (MIN)", price: -115, point: 25.5 },
            { name: "Under", description: "Anthony Edwards (MIN)", price: -105, point: 25.5 },
          ],
        },
      ],
    },
    {
      key: "fanduel",
      title: "FanDuel",
      markets: [
        {
          key: "player_points",
          outcomes: [
            { name: "Over", description: "Anthony Edwards", price: -110, point: 25.5 },
            { name: "Under", description: "Anthony Edwards", price: -110, point: 25.5 },
          ],
        },
        {
          key: "player_rebounds",
          suspended_at: "2026-01-15T22:00:00Z",
          outcomes: [
            { name: "Over", description: "Rudy Gobert", price: -110, point: 11.5 },
            { name: "Under", description: "Rudy Gobert", price: -110, point: 11.5 },
          ],
        },
      ],
    },
    {
      key: "prophetx",
      title: "ProphetX",
      markets: [
        {
          key: "player_points",
          outcomes: [
            { name: "Over", description: "Anthony Edwards", price: 120, point: 25.5, liquidity: 4 },
            { name: "Under", description: "Anthony Edwards", price: -150, point: 25.5, liquidity: 300 },
          ],
        },
      ],
    },
    {
      key: "prizepicks",
      title: "PrizePicks",
      markets: [
        {
          key: "player_points",
          outcomes: [
            { name: "Over", description: "Anthony Edwards", price: 100, point: 24.5, dfs_odds_type: "standard" },
            { name: "Under", description: "Anthony Edwards", price: 100, point: 24.5, dfs_odds_type: "standard" },
          ],
        },
        {
          key: "player_points",
          description: "Points (demon 29.5)",
          outcomes: [{ name: "Over", description: "Anthony Edwards", price: 100, point: 29.5, dfs_odds_type: "demon" }],
        },
      ],
    },
    {
      key: "underdog",
      title: "Underdog",
      markets: [
        {
          key: "player_points",
          outcomes: [
            { name: "Higher", description: "Anthony Edwards", price: -120, point: 25.5, payout_multiplier: 1.0 },
            { name: "Lower", description: "Anthony Edwards", price: -105, point: 25.5, payout_multiplier: 0.85 },
          ],
        },
      ],
    },
  ],
}

describe("PropLine requests", () => {
  it("uses PropLine's own sport keys", () => {
    expect(proplineSportKey("nba")).toBe("basketball_nba")
    expect(proplineSportKey("nfl")).toBe("football_nfl")
    expect(proplineSportKey("cfb")).toBe("football_ncaaf")
  })

  it("keeps the key out of the URL", () => {
    const url = proplineEventOddsUrl(4821, { markets: ["player_points"], league: "nba" })
    expect(url).toBe("https://api.prop-line.com/v1/sports/basketball_nba/events/4821/odds?markets=player_points")
    expect(proplineEventsUrl("nfl")).toBe("https://api.prop-line.com/v1/sports/football_nfl/events")
  })

  it("drops duplicate market keys from a request", () => {
    // Nothing is aliased while both feeds name every market Today pulls the
    // same way (hockey's "goalie_saves" was the last one and the NHL is gone),
    // so this is the de-duplication alone.
    expect(proplineMarkets(["player_points", "player_rebounds", "player_points"])).toEqual([
      "player_points",
      "player_rebounds",
    ])
  })

  it("narrows to the requested books when asked", () => {
    const url = proplineEventOddsUrl("9", { markets: ["player_points"], bookmakers: ["prizepicks", "underdog"] })
    expect(url).toContain("bookmakers=prizepicks%2Cunderdog")
  })

  it("still answers The Odds API key for saves", () => {
    expect(feedKeyFor("SAVES")).toBe("player_total_saves")
  })

  it("reads the daily quota headers", () => {
    const h = new Headers({ "X-Daily-Limit": "1000", "X-Daily-Used": "13", "X-Daily-Remaining": "987" })
    expect(proplineQuota(h)).toEqual({ limit: 1000, used: 13, remaining: 987 })
    expect(proplineQuota(new Headers())).toBeNull()
  })
})

describe("cleanPlayerName", () => {
  it("strips a trailing team tag", () => {
    expect(cleanPlayerName("Tarik Skubal (DET)")).toBe("Tarik Skubal")
    expect(cleanPlayerName("Shai Gilgeous-Alexander")).toBe("Shai Gilgeous-Alexander")
    expect(cleanPlayerName(undefined)).toBe("")
  })
})

// Before the fixture's tip-off, so its pick'em lines are still open.
const BEFORE = { now: Date.parse("2026-01-15T18:00:00Z") }

describe("normalizeProplineEvent", () => {
  const r = normalizeProplineEvent(event, "basketball", BEFORE)

  it("never lets a pick'em app into the prices", () => {
    const books = new Set(r.quotes.map((q) => q.book))
    expect(books.has("prizepicks")).toBe(false)
    expect(books.has("underdog")).toBe(false)
  })

  it("matches a team-tagged name to the same player as an untagged one", () => {
    const edwards = r.quotes.filter((q) => q.playerKey === "anthony edwards")
    expect(edwards.map((q) => q.book).sort()).toEqual(["betonlineag", "fanduel", "prophetx"])
  })

  it("drops a pulled market and says why", () => {
    expect(r.quotes.some((q) => q.player === "Rudy Gobert")).toBe(false)
    expect(r.dropped.some((d) => d.reason === "market pulled by the book")).toBe(true)
  })

  it("drops a thin exchange side and keeps the deep one", () => {
    const px = r.quotes.find((q) => q.book === "prophetx")!
    expect(px.overOdds).toBeNull()
    expect(px.underOdds).toBe(-150)
    expect(r.dropped.some((d) => d.reason === "exchange offer too thin to bet")).toBe(true)
  })

  it("keeps the event id as a string", () => {
    expect(r.quotes.every((q) => q.gameId === "Minnesota Timberwolves@Oklahoma City Thunder")).toBe(true)
  })

  it("reads PrizePicks standard and demon lines apart", () => {
    const pp = r.pickemLines.filter((l) => l.app === "prizepicks")
    const standard = pp.find((l) => l.pickType === "standard")!
    expect(standard.line).toBe(24.5)
    expect(standard.over).toEqual({ multiplier: null })
    expect(standard.under).toEqual({ multiplier: null })
    const demon = pp.find((l) => l.pickType === "demon")!
    expect(demon.line).toBe(29.5)
    expect(demon.under).toBeNull()
  })

  it("keeps Underdog's per-side multiplier and reads Higher and Lower", () => {
    const ud = r.pickemLines.find((l) => l.app === "underdog")!
    expect(ud.line).toBe(25.5)
    expect(ud.over).toEqual({ multiplier: null })
    expect(ud.under).toEqual({ multiplier: 0.85 })
    expect(ud.market).toBe("PTS")
  })

  it("drops every price from a book frozen on a live game", () => {
    const frozen = normalizeProplineEvent(
      { ...event, bookmakers: [{ ...event.bookmakers[1], pregame_only: true }] },
      "basketball",
      BEFORE,
    )
    expect(frozen.quotes).toHaveLength(0)
    expect(frozen.dropped[0].reason).toBe("book frozen on a live game")
  })

  it("treats a book carrying a pick type as a pick'em app even if unlisted", () => {
    const r2 = normalizeProplineEvent(
      {
        ...event,
        bookmakers: [
          {
            key: "newpickem",
            title: "New Pickem",
            markets: [
              {
                key: "player_points",
                outcomes: [{ name: "Over", description: "Anthony Edwards", price: 100, point: 24.5, dfs_odds_type: "standard" }],
              },
            ],
          },
        ],
      },
      "basketball",
      BEFORE,
    )
    expect(r2.quotes).toHaveLength(0)
    expect(r2.pickemLines).toHaveLength(1)
  })

  it("closes every pick'em line once the game has started, and keeps the prices", () => {
    const live = normalizeProplineEvent(event, "basketball", { now: Date.parse("2026-01-16T01:00:00Z") })
    expect(live.pickemLines).toHaveLength(0)
    expect(live.quotes.length).toBe(r.quotes.length)
    expect(live.dropped.filter((d) => d.reason === "pick'em lines closed: the game has started")).toHaveLength(2)
  })

  it("drops a pick'em app frozen on a live game and a pick'em line the app pulled", () => {
    const pp = event.bookmakers[3]
    const frozen = normalizeProplineEvent({ ...event, bookmakers: [{ ...pp, pregame_only: true }] }, "basketball", BEFORE)
    expect(frozen.pickemLines).toHaveLength(0)
    const pulled = normalizeProplineEvent(
      { ...event, bookmakers: [{ ...pp, markets: [{ ...pp.markets[0], suspended_at: "2026-01-15T17:00:00Z" }, pp.markets[1]] }] },
      "basketball",
      BEFORE,
    )
    expect(pulled.pickemLines.map((l) => l.pickType)).toEqual(["demon"])
    expect(pulled.dropped.some((d) => d.reason === "pick'em line pulled by the app")).toBe(true)
  })

  it("maps PropLine's goalie saves key in hockey", () => {
    const r3 = normalizeProplineEvent(
      {
        id: 1,
        commence_time: "2026-01-16T00:10:00Z",
        home_team: "Boston Bruins",
        away_team: "Toronto Maple Leafs",
        bookmakers: [
          {
            key: "fanduel",
            title: "FanDuel",
            markets: [
              {
                key: "goalie_saves",
                outcomes: [
                  { name: "Over", description: "Jeremy Swayman", price: -115, point: 27.5 },
                  { name: "Under", description: "Jeremy Swayman", price: -105, point: 27.5 },
                ],
              },
            ],
          },
        ],
      },
      "hockey",
    )
    expect(r3.quotes[0].market).toBe("SAVES")
  })
})

describe("pullPropline", () => {
  function json(body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } })
  }

  const listing = [
    { id: 1, commence_time: "2026-01-16T00:10:00Z", home_team: "Oklahoma City Thunder", away_team: "Minnesota Timberwolves" },
    { id: 2, commence_time: "2026-01-16T02:30:00Z", home_team: "Los Angeles Lakers", away_team: "Boston Celtics" },
    { id: 3, commence_time: "2026-01-18T00:10:00Z", home_team: "New York Knicks", away_team: "Miami Heat" },
  ]

  it("prices the games in the window, sends the key as a header, and reports the next game", async () => {
    const seen: { url: string; key: string | null }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.push({ url, key: new Headers(init?.headers).get("X-API-Key") })
      if (url.endsWith("/events")) return json(listing, { "X-Daily-Limit": "1000", "X-Daily-Used": "1", "X-Daily-Remaining": "999" })
      if (url.includes("/events/2/")) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
      return json({ ...event, id: 1 }, { "X-Daily-Limit": "1000", "X-Daily-Used": "2", "X-Daily-Remaining": "998" })
    }
    const pull = await pullPropline({
      apiKey: "secret",
      league: "nba",
      fromMs: Date.parse("2026-01-15T05:00:00Z"),
      toMs: Date.parse("2026-01-16T11:00:00Z"),
      markets: ["player_points"],
      maxGames: 10,
      fetcher,
    })
    expect(pull.selected.map((e) => e.id)).toEqual(["1", "2"])
    expect(pull.payloads).toHaveLength(1)
    expect(pull.failures).toEqual([
      { eventId: "2", matchup: "Boston Celtics at Los Angeles Lakers", error: "PropLine returned 500. boom" },
    ])
    expect(pull.nextEvent?.id).toBe("3")
    expect(pull.quota?.remaining).toBe(998)
    expect(pull.requests).toBe(3)
    expect(seen.every((s) => s.key === "secret" && !s.url.includes("secret"))).toBe(true)
  })

  it("throws a readable error when the listing is refused", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ detail: "Invalid API key", error_code: "invalid_api_key" }), { status: 401 })
    await expect(
      pullPropline({ apiKey: "bad", league: "nba", fromMs: 0, toMs: Date.now(), markets: [], maxGames: 1, fetcher }),
    ).rejects.toThrow("PropLine rejected the API key. Invalid API key")
  })

  it("makes no odds requests for an events-only call", async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      return json(listing)
    }
    const pull = await pullPropline({
      apiKey: "k",
      league: "nba",
      fromMs: Date.parse("2026-01-15T05:00:00Z"),
      toMs: Date.parse("2026-01-16T11:00:00Z"),
      markets: ["player_points"],
      maxGames: 10,
      eventsOnly: true,
      fetcher,
    })
    expect(calls).toBe(1)
    expect(pull.selected).toHaveLength(2)
  })
})

import { pickemNoteFor } from "@/lib/odds-feed/propline"

describe("pickemNoteFor", () => {
  it("names a failed request before blaming the apps for not posting", () => {
    const limit = { error: "PropLine's daily request limit is used up." }
    expect(pickemNoteFor(0, [limit, limit])).toBe(
      "Pick'em lines for 2 games could not be read: PropLine's daily request limit is used up.",
    )
    expect(pickemNoteFor(12, [limit])).toContain("1 game could not be read")
  })

  it("says the apps have not posted only when every request succeeded", () => {
    expect(pickemNoteFor(0, [])).toContain("no pick'em lines for these games yet")
    expect(pickemNoteFor(5, [])).toBeNull()
  })
})

describe("pullPropline cap accounting", () => {
  const listing = [1, 2, 3, 4].map((id) => ({
    id,
    commence_time: `2026-01-16T0${id}:00:00Z`,
    home_team: `Home ${id}`,
    away_team: `Away ${id}`,
  }))
  const fetcher = async () => new Response(JSON.stringify(listing), { status: 200 })
  const window = { fromMs: Date.parse("2026-01-15T00:00:00Z"), toMs: Date.parse("2026-01-17T00:00:00Z") }

  it("counts only games asked for when an event list narrows the pull", async () => {
    const pull = await pullPropline({ apiKey: "k", league: "nba", ...window, markets: [], maxGames: 10, eventIds: ["2", "3"], eventsOnly: true, fetcher })
    expect(pull.selected.map((e) => e.id)).toEqual(["2", "3"])
    expect(pull.cappedOut).toBe(0)
  })

  it("counts the games the cap left out", async () => {
    const pull = await pullPropline({ apiKey: "k", league: "nba", ...window, markets: [], maxGames: 3, eventsOnly: true, fetcher })
    expect(pull.cappedOut).toBe(1)
  })
})

import { sameGame, teamNickname } from "@/lib/odds-feed/propline"

describe("matching games across feeds", () => {
  it("reads the nickname, which survives LA against Los Angeles", () => {
    expect(teamNickname("LA Clippers")).toBe(teamNickname("Los Angeles Clippers"))
    expect(teamNickname("Portland Trail Blazers")).toBe("blazers")
    expect(teamNickname("Philadelphia 76ers")).toBe(teamNickname("Philadelphia 76ers"))
  })

  const odds = { home_team: "Los Angeles Clippers", away_team: "Denver Nuggets", commence_time: "2026-01-16T03:30:00Z" }

  it("matches the same game and refuses a swapped home team or a later rematch", () => {
    expect(sameGame({ ...odds, home_team: "LA Clippers", commence_time: "2026-01-16T03:40:00Z" }, odds)).toBe(true)
    expect(sameGame({ ...odds, home_team: "Denver Nuggets", away_team: "LA Clippers" }, odds)).toBe(false)
    expect(sameGame({ ...odds, commence_time: "2026-01-18T03:30:00Z" }, odds)).toBe(false)
  })

  it("pulls exactly the games another feed priced, whatever the cap and window", async () => {
    const listing = [
      { id: 7, commence_time: "2026-01-16T03:40:00Z", home_team: "LA Clippers", away_team: "Denver Nuggets" },
      { id: 8, commence_time: "2026-01-16T00:10:00Z", home_team: "Boston Celtics", away_team: "New York Knicks" },
    ]
    const fetcher = async () => new Response(JSON.stringify(listing), { status: 200 })
    const pull = await pullPropline({
      apiKey: "k",
      league: "nba",
      fromMs: Date.parse("2026-01-16T04:00:00Z"),
      toMs: Date.parse("2026-01-16T05:00:00Z"),
      markets: [],
      maxGames: 1,
      games: [odds],
      eventsOnly: true,
      fetcher,
    })
    expect(pull.selected.map((e) => e.id)).toEqual(["7"])
  })
})

describe("closed games", () => {
  it("reports the games whose pick'em lines closed because they started", () => {
    const live = normalizeProplineEvent(event, "basketball", { now: Date.parse("2026-01-16T01:00:00Z") })
    expect(live.closedGames).toEqual(["Minnesota Timberwolves@Oklahoma City Thunder"])
    expect(normalizeProplineEvent(event, "basketball", BEFORE).closedGames).toEqual([])
  })

  it("says the games have started rather than that the apps have not posted", () => {
    expect(pickemNoteFor(0, [], 2)).toBe(
      "2 games have already started, so the pick'em apps have closed their lines and they are left out of the entry.",
    )
    expect(pickemNoteFor(10, [], 1)).toContain("1 game has already started")
    expect(pickemNoteFor(0, [], 0)).toContain("no pick'em lines for these games yet")
  })
})

import { unpricedPickemNote, usablePickemLines } from "@/lib/odds-feed/propline"

const GAME = "Minnesota Timberwolves@Oklahoma City Thunder"
const priced = (player: string, market: "PTS" | "REB", gameId = GAME) => ({
  player,
  playerKey: player.toLowerCase(),
  market: market as never,
  gameId,
})

/**
 * Which lines are worth keeping, and the one that looks like dead weight and
 * is not.
 *
 * A line reaches a board row only through `player|market`, so a line whose own
 * prop nobody priced can never be played. But it is also the evidence that an
 * app covers a game and market, and that evidence is read for OTHER players'
 * rows. Keeping only the playable half is what makes the screen say "no
 * PrizePicks line reached at all" about a game and market where PrizePicks did
 * post one.
 */
describe("usablePickemLines", () => {
  it("drops a pick'em line in a market no sportsbook priced anywhere, and says it is the market", () => {
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    // Rebounds is suspended on the only book that posts it, so no rebounds
    // quote survives anywhere in this fixture: that is a fact about the market
    // list, not about this line's game.
    const rebounds = { ...r.pickemLines[0], market: "REB" as never, line: 11.5 }
    const { lines, dropped } = usablePickemLines([...r.pickemLines, rebounds], r.quotes)
    expect(lines).toHaveLength(r.pickemLines.length)
    expect(dropped.map((d) => d.line.market)).toEqual(["REB"])
    expect(dropped.map((d) => d.reason)).toEqual(["market-unpriced-slate"])
  })

  it("tells a market nothing prices apart from one this game happens to miss", () => {
    // The same market, priced in a DIFFERENT game. Now the market list is
    // fine and this one game is thin, which is a different fact with no
    // action attached — so it must not read as the market-list problem.
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    const rebounds = { ...r.pickemLines[0], market: "REB" as never, line: 11.5 }
    const elsewhere = [...r.quotes, priced("Someone Else", "REB", "BOS@NYK")]
    const { dropped } = usablePickemLines([rebounds], elsewhere)
    expect(dropped.map((d) => d.reason)).toEqual(["market-unpriced"])
    expect(unpricedPickemNote(dropped)!).not.toContain("Settings")
  })

  it("keeps a line for a player the books skipped when it is the app's only evidence of that market", () => {
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    // PrizePicks posts rebounds for Edwards; the books price rebounds only for
    // Gobert. Edwards' rebounds line is unplayable and is the one thing that
    // says PrizePicks covers rebounds in this game, which is what decides
    // whether GOBERT's rebounds row reads as "not offered" or "never heard".
    const rebounds = { ...r.pickemLines[0], market: "REB" as never, line: 11.5 }
    const quotes = [...r.quotes, priced("Rudy Gobert", "REB")]
    const { lines, dropped } = usablePickemLines([rebounds], quotes)
    expect(lines).toHaveLength(1)
    expect(dropped).toHaveLength(0)
  })

  it("still drops a line for a player nobody priced at all", () => {
    // The evidence clause must not rescue a stranger: with no quotes in any
    // market there is no game to attribute the line to.
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    const stranger = { ...r.pickemLines[0], player: "Nobody Priced", playerKey: "nobody priced" }
    const { lines, dropped } = usablePickemLines([...r.pickemLines, stranger], r.quotes)
    expect(lines).toHaveLength(r.pickemLines.length)
    expect(dropped.map((d) => d.line.playerKey)).toEqual(["nobody priced"])
    // And for the RIGHT reason: nobody priced the player, which is a different
    // fact from nobody pricing the market.
    expect(dropped.map((d) => d.reason)).toEqual(["player-unpriced"])
  })

  it("matches the player on the normalised name, team tag and all", () => {
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    expect(usablePickemLines(r.pickemLines, [priced("Anthony Edwards", "PTS")]).lines).toHaveLength(
      r.pickemLines.length,
    )
    // "(MIN)" is stripped from a description, never from a quote's player, so a
    // quote that still carries it is a different person as far as this is
    // concerned — and nothing rescues it, because nothing priced the market.
    expect(usablePickemLines(r.pickemLines, [priced("Anthony Edwards (MIN)", "PTS")]).lines).toHaveLength(0)
  })

  it("reports a market no book prices as one fact with one fix, not as N casualties", () => {
    // What a real pull produced: 85 PrizePicks Turnovers lines and not one
    // sportsbook turnovers quote, reported as "85 because no sportsbook priced
    // Turnovers in the game they cover" — the same sentence eighty-five times
    // about a market no book posts at all, with no action attached. Pick'em
    // apps post markets the books do not, and turnovers is the archetype.
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    const turnovers = Array.from({ length: 85 }, (_, i) => ({
      ...r.pickemLines[0],
      player: `Player ${i}`,
      playerKey: `player ${i}`,
      market: "TOV" as never,
      line: 2.5,
    }))
    const { dropped } = usablePickemLines(turnovers, r.quotes)
    expect(dropped).toHaveLength(85)
    expect(new Set(dropped.map((d) => d.reason))).toEqual(new Set(["market-unpriced-slate"]))

    const note = unpricedPickemNote(dropped)!
    expect(note).toContain("Turnovers")
    expect(note).toContain("no sportsbook on this slate prices at all")
    // The whole point: it names the one setting that stops it.
    expect(note).toContain("Settings → Markets")
    // And it does not blame the game, which is not what is wrong.
    expect(note).not.toContain("in the game they cover")
    expect(unpricedPickemNote([])).toBeNull()
  })

  it("does not blame a market for a player the books never priced", () => {
    // The commonest drop by far is a bench player an app posts and the books
    // do not. Telling that user "no sportsbook priced Points in the game it
    // covers" is false on its face, with a table of Points targets for that
    // very game directly underneath it — the books priced Points there, just
    // not for him.
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    const bench = { ...r.pickemLines[0], player: "Josh Minott", playerKey: "josh minott" }
    const { dropped } = usablePickemLines([bench], r.quotes)
    const note = unpricedPickemNote(dropped)!
    expect(note).toContain("Josh Minott")
    expect(note).toContain("at all")
    expect(note).not.toContain("in the game it covers")
  })

  it("keeps the two reasons apart when a pull hits both", () => {
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    const bench = { ...r.pickemLines[0], player: "Josh Minott", playerKey: "josh minott" }
    const rebounds = { ...r.pickemLines[0], market: "REB" as never, line: 11.5 }
    const { dropped } = usablePickemLines([bench, rebounds], r.quotes)
    expect(dropped.map((d) => d.reason).sort()).toEqual(["market-unpriced-slate", "player-unpriced"])
    const note = unpricedPickemNote(dropped)!
    // One clause per reason, never one sentence covering both: they are
    // different facts and the loudest one is false about the other.
    expect(note).toContain("2 pick'em lines")
    expect(note).toContain("1 because no sportsbook priced Josh Minott at all")
    expect(note).toContain("1 for Rebounds, which no sportsbook on this slate prices at all")
  })

  it("only says to drop a market from Settings when the list there is yours", () => {
    // Settings → Markets left blank follows this app's own list. Telling that
    // user to drop a market from it is an instruction to edit an empty box.
    const r = normalizeProplineEvent(event, "basketball", BEFORE)
    const rebounds = { ...r.pickemLines[0], market: "REB" as never, line: 11.5 }
    const { dropped } = usablePickemLines([rebounds], r.quotes)
    const own = unpricedPickemNote(dropped, { chosen: false })!
    expect(own).toContain("no sportsbook on this slate prices at all")
    expect(own).not.toContain("Settings")
    // On a typed list it names the key, which is what the box takes.
    expect(unpricedPickemNote(dropped)!).toContain("Drop player_rebounds from Settings → Markets")
  })
})

import { parseProplineError, proplineErrorText, resolveProplineKeySource } from "@/lib/odds-feed/propline"

describe("a sport PropLine does not recognise", () => {
  it("names the sport key rather than reading as an outage", async () => {
    // Every path this adapter builds starts with a sport key, and PropLine's
    // keys are its own ("football_nfl", not "americanfootball_nfl"). Reported
    // as a bare 404 it reads as PropLine being down, which sends nobody to the
    // one line of configuration that is actually wrong.
    const res = new Response(JSON.stringify({ detail: "Sport not found" }), { status: 404 })
    const text = await proplineErrorText(res)
    expect(text).toContain("does not recognise that sport")
    expect(text).toContain("sport keys are its own")
    expect(text).not.toContain("returned 404")
  })
})
import { cleanApiKey, isPlaceholderKey, keyEnding, keySourceHint, resolveKey, usableKey } from "@/lib/odds-feed/api-key"

/** The body PropLine actually sends on a bad key: `detail` is an object, not a sentence. */
const INVALID_KEY = JSON.stringify({
  detail: {
    error: "invalid_api_key",
    message: "Invalid API key.",
    signup_url: "https://prop-line.com/",
    docs_url: "https://prop-line.com/docs#authentication",
  },
})

describe("parseProplineError", () => {
  it("reads the code, sentence and link out of an object detail", () => {
    expect(parseProplineError(INVALID_KEY)).toEqual({
      code: "invalid_api_key",
      message: "Invalid API key.",
      url: "https://prop-line.com/",
    })
  })

  it("still reads a plain string detail", () => {
    expect(parseProplineError(JSON.stringify({ detail: "Daily limit reached" })).message).toBe("Daily limit reached")
  })

  it("gives up quietly on a body that is not JSON", () => {
    expect(parseProplineError("<html>502</html>")).toEqual({ code: null, message: null, url: null })
  })
})

describe("proplineErrorText", () => {
  const res = (body: string, status: number) => new Response(body, { status })

  it("says what PropLine said, never raw JSON", async () => {
    const text = await proplineErrorText(res(INVALID_KEY, 401))
    expect(text).toContain("PropLine rejected the API key.")
    expect(text).toContain("Invalid API key.")
    expect(text).not.toContain("{")
    expect(text).not.toContain("signup_url")
  })

  it("names the environment when the key it rejected came from there, since Settings cannot override it", async () => {
    const key = { key: "k", source: "environment" as const, label: "PROPLINE_API_KEY" }
    const text = await proplineErrorText(res(INVALID_KEY, 401), key)
    expect(text).toContain("PROPLINE_API_KEY")
    expect(text).toContain("takes precedence")
  })

  it("points at Settings when that is where the key came from", async () => {
    const key = { key: "k", source: "settings" as const, label: "Settings → Odds feed → PropLine key" }
    expect(await proplineErrorText(res(INVALID_KEY, 401), key)).toContain("Settings → Odds feed → PropLine key")
    expect(await proplineErrorText(res(INVALID_KEY, 401), key)).not.toContain("takes precedence")
  })

  it("tells the daily cap apart from a burst and from a paywall", async () => {
    const daily = JSON.stringify({ detail: { error: "daily_limit_exceeded", message: "1000/1000 used." } })
    expect(await proplineErrorText(res(daily, 429))).toContain("resets at 00:00 UTC")
    const burst = JSON.stringify({ detail: { error: "burst_limit_exceeded", message: "Slow down." } })
    expect(await proplineErrorText(res(burst, 429))).toContain("Wait a few seconds")
    const gated = JSON.stringify({ detail: { error: "upgrade_required", message: "Hobby and up." } })
    expect(await proplineErrorText(res(gated, 403))).toContain("paid PropLine plan")
  })

  it("falls back to the status for a body it cannot read", async () => {
    expect(await proplineErrorText(res("", 503))).toBe("PropLine returned 503.")
  })

  it("carries the rejected key's error through a pull", async () => {
    const fetcher = async () => new Response(INVALID_KEY, { status: 401 })
    await expect(
      pullPropline({
        apiKey: "wrong",
        keySource: { key: "wrong", source: "environment", label: "PROPLINE_API_KEY" },
        league: "nba",
        fromMs: 0,
        toMs: 1,
        markets: [],
        maxGames: 1,
        fetcher,
      }),
    ).rejects.toThrow(/rejected the API key[\s\S]*PROPLINE_API_KEY/)
  })
})

describe("key hygiene", () => {
  it("strips the quotes and whitespace a .env line or a copy-paste leaves behind", () => {
    expect(cleanApiKey('  "abc123"  ')).toBe("abc123")
    expect(cleanApiKey("'abc123'")).toBe("abc123")
    expect(cleanApiKey("abc123\n")).toBe("abc123")
    expect(cleanApiKey('"abc123",')).toBe("abc123")
    expect(cleanApiKey(undefined)).toBe("")
  })

  it("refuses the placeholders that ship in example files", () => {
    for (const v of ["your_api_key", "YOUR-API-KEY", "changeme", "xxxx", "TODO"]) {
      expect(isPlaceholderKey(v)).toBe(true)
      expect(usableKey(v)).toBeNull()
    }
    expect(usableKey("abc123")).toBe("abc123")
  })

  it("lets a real environment key win, but never a placeholder one", () => {
    const labels = { env: "PROPLINE_API_KEY", settings: "Settings" }
    expect(resolveKey("env-key", "settings-key", labels)).toEqual({
      key: "env-key",
      source: "environment",
      label: "PROPLINE_API_KEY",
    })
    // The trap this fixes: a placeholder in .env.local silently beat the real
    // key in Settings, so retyping the key in Settings changed nothing.
    expect(resolveKey("your_api_key", "settings-key", labels)?.key).toBe("settings-key")
    expect(resolveKey("  ", "settings-key", labels)?.source).toBe("settings")
    expect(resolveKey(undefined, undefined, labels)).toBeNull()
  })

  it("resolves the PropLine key from the environment and from Settings", () => {
    const before = process.env.PROPLINE_API_KEY
    try {
      process.env.PROPLINE_API_KEY = ' "env-key" '
      expect(resolveProplineKeySource("settings-key")).toEqual({
        key: "env-key",
        source: "environment",
        label: "PROPLINE_API_KEY",
      })
      process.env.PROPLINE_API_KEY = "your_api_key_here"
      expect(resolveProplineKeySource("settings-key")?.key).toBe("settings-key")
      delete process.env.PROPLINE_API_KEY
      expect(resolveProplineKeySource(" ")).toBeNull()
    } finally {
      if (before === undefined) delete process.env.PROPLINE_API_KEY
      else process.env.PROPLINE_API_KEY = before
    }
  })

  it("says nothing when there is no key to name", () => {
    expect(keySourceHint(null)).toBe("")
  })

  it("names a key from Settings by its ending, and a key from the environment not at all", () => {
    // "Rejected the API key" was being answered by generating a new key, when
    // the key that had been sent was a different one. The ending says which.
    const typed = { key: "0123456789abcdef0123456789ab4026", source: "settings" as const, label: "Settings → Odds feed" }
    expect(keySourceHint(typed)).toBe('The key came from Settings → Odds feed and ends in "4026".')
    // A key the server holds never leaves it, not even four characters of it.
    const held = keySourceHint({ ...typed, source: "environment", label: "ODDS_API_KEY" })
    expect(held).toContain("ODDS_API_KEY in the environment")
    expect(held).not.toContain("4026")
    // Four characters of a short key would be a real part of it.
    expect(keySourceHint({ ...typed, key: "short-4026" })).toBe("The key came from Settings → Odds feed.")
    expect(keyEnding("0123456789ab")).toBe("89ab")
    expect(keyEnding("0123456789a")).toBeNull()
    // With no key to describe, the place is still named.
    expect(keySourceHint({ source: "settings", label: "Settings → Odds feed" })).toBe("The key came from Settings → Odds feed.")
  })
})

import { FeedKeyError, proplineFailure } from "@/lib/odds-feed/propline"

describe("proplineFailure", () => {
  it("marks a rejected key as a key problem, and nothing else", async () => {
    const rejected = await proplineFailure(new Response(INVALID_KEY, { status: 401 }))
    expect(rejected).toBeInstanceOf(FeedKeyError)
    expect(rejected.message).toContain("rejected the API key")

    const missing = JSON.stringify({ detail: { error: "missing_api_key", message: "No API key." } })
    expect(await proplineFailure(new Response(missing, { status: 403 }))).toBeInstanceOf(FeedKeyError)

    const limit = JSON.stringify({ detail: { error: "daily_limit_exceeded", message: "1000/1000 used." } })
    const capped = await proplineFailure(new Response(limit, { status: 429 }))
    expect(capped).not.toBeInstanceOf(FeedKeyError)
    expect(capped).toBeInstanceOf(Error)
    expect(await proplineFailure(new Response("", { status: 503 }))).not.toBeInstanceOf(FeedKeyError)
  })
})
