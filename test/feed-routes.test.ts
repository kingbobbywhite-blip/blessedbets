import { afterEach, describe, expect, it, vi } from "vitest"
import { feedErrorText, headerCount, noneCouldBePriced, notStarted, oddsApiErrorText } from "@/lib/odds-feed/http"
import { narrowedMarketsNote, pullPropline } from "@/lib/odds-feed/propline"
import { marketCoverageNote, marketsChosen } from "@/lib/odds-feed/theoddsapi"
import { LEAGUES } from "@/lib/leagues"
import { upcomingQuotes } from "@/lib/today/build"

const HOUR = 3600 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

const QUOTA = { "x-requests-remaining": "400", "x-requests-used": "100" }

/**
 * The quota headers plus the per-request cost the feed states.
 *
 * QUOTA deliberately stays without x-requests-last, so every existing stub
 * goes on exercising the unmeasured path — a feed that does not itemise is a
 * real case and has to keep reading as "unknown" rather than as "free".
 */
const quota = (last: number) => ({ ...QUOTA, "x-requests-last": String(last) })

/** An odds payload with one player and two books, enough to normalise into quotes. */
function oddsFor(e: { id: string; commence_time: string; home_team: string; away_team: string }) {
  const book = (key: string) => ({
    key,
    title: key,
    last_update: e.commence_time,
    markets: [
      {
        key: "player_points",
        outcomes: [
          { name: "Over", description: "Some Player", price: -110, point: 20.5 },
          { name: "Under", description: "Some Player", price: -110, point: 20.5 },
        ],
      },
    ],
  })
  return { ...e, sport_key: "basketball_nba", bookmakers: [book("pinnacle"), book("fanduel")] }
}

function stubOddsApi(events: { id: string; commence_time: string }[], odds: (id: string) => Response) {
  const listing = events.map((e) => ({ ...e, sport_key: "basketball_nba", home_team: `H${e.id}`, away_team: `A${e.id}` }))
  const urls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url)
      const m = url.match(/\/events\/([^/]+)\/odds/)
      if (m) return odds(m[1])
      return json(listing, 200, QUOTA)
    }),
  )
  return {
    urls,
    oddsCalls: () => urls.filter((u) => u.includes("/odds?")).map((u) => u.match(/\/events\/([^/]+)\//)![1]),
    listing,
  }
}

// As the app's pages send them: the routes refuse anything that is not JSON.
const post = (url: string, body: object) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "k", ...body }),
  })

const today = async (body: object) => {
  const { POST } = await import("@/app/api/today/route")
  return POST(post("http://t/api/today", body))
}

const odds = async (body: object) => {
  const { POST } = await import("@/app/api/odds/route")
  return POST(post("http://t/api/odds", body))
}

describe("feed request helpers", () => {
  it("reads an absent quota header as unknown, not as zero left", () => {
    expect(headerCount(new Headers(), "x-requests-remaining")).toBeNull()
    expect(headerCount(new Headers({ "x-requests-remaining": "" }), "x-requests-remaining")).toBeNull()
    expect(headerCount(new Headers({ "x-requests-remaining": "0" }), "x-requests-remaining")).toBe(0)
    expect(headerCount(new Headers({ "x-requests-remaining": "412" }), "x-requests-remaining")).toBe(412)
  })

  it("names an exhausted Odds API quota rather than echoing the raw body", async () => {
    const quota = json({ message: "Usage quota has been reached.", error_code: "OUT_OF_USAGE_CREDITS" }, 401)
    expect(await oddsApiErrorText(quota)).toBe("The Odds API quota is used up for this period. Usage quota has been reached.")
    const badKey = json({ message: "API key is not valid.", error_code: "INVALID_KEY" }, 401)
    expect(await oddsApiErrorText(badKey)).toBe("The Odds API rejected the API key. API key is not valid.")
    expect(await oddsApiErrorText(new Response("Bad gateway", { status: 503 }))).toBe("The Odds API returned 503. Bad gateway")
  })

  it("says the feed could not be reached instead of 'fetch failed'", () => {
    expect(feedErrorText(new TypeError("fetch failed"), "The Odds API")).toBe(
      "Could not reach The Odds API. Check the internet connection and try again.",
    )
    expect(feedErrorText(new SyntaxError("Unexpected token '<'"), "PropLine")).toBe(
      "PropLine sent a response this app could not read. Try again in a minute.",
    )
    expect(feedErrorText(new Error("PropLine rejected the API key."), "PropLine")).toBe("PropLine rejected the API key.")
  })

  it("treats a game as started once its start time has passed, and keeps an unreadable one", () => {
    const now = Date.parse("2026-10-20T23:00:00Z")
    expect(notStarted("2026-10-20T23:30:00Z", now)).toBe(true)
    expect(notStarted("2026-10-20T23:00:00Z", now)).toBe(false)
    expect(notStarted("2026-10-20T22:00:00Z", now)).toBe(false)
    expect(notStarted(null, now)).toBe(true)
    expect(notStarted("not a date", now)).toBe(true)
  })

  it("calls a pull a failure only when it priced nothing and something failed", () => {
    const failures = [{ error: "The Odds API quota is used up for this period." }]
    expect(noneCouldBePriced(2, 0, [...failures, ...failures])).toBe(
      "None of the 2 games could be priced. The Odds API quota is used up for this period.",
    )
    expect(noneCouldBePriced(2, 1, failures)).toBeNull()
    expect(noneCouldBePriced(0, 0, [])).toBeNull()
    expect(noneCouldBePriced(1, 0, [])).toBeNull()
  })

  it("drops quotes from games that have started since the pull", () => {
    const now = Date.parse("2026-10-20T23:00:00Z")
    const quotes = [
      { gameId: "early", commenceTime: "2026-10-20T22:00:00Z" },
      { gameId: "late", commenceTime: "2026-10-21T01:00:00Z" },
      { gameId: "unknown" },
    ]
    expect(upcomingQuotes(quotes, now).map((q) => q.gameId)).toEqual(["late", "unknown"])
  })
})

describe("/api/today", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("skips games already under way before the cap, so they cost nothing and are never picked", async () => {
    // The window opens at the caller's midnight, which in the evening holds
    // games that tipped hours ago. Those used to be priced at live lines, take
    // cap slots ahead of later games, and land in the pick'em entry.
    const now = Date.now()
    const feed = stubOddsApi(
      [
        { id: "live", commence_time: iso(now - 1.5 * HOUR) },
        { id: "later", commence_time: iso(now + 3 * HOUR) },
      ],
      (id) => json(oddsFor({ ...feed.listing.find((e) => e.id === id)! }), 200, QUOTA),
    )
    const res = await today({ league: "nba", markets: ["player_points"], from: iso(now - 12 * HOUR), to: iso(now + 12 * HOUR), maxGames: 1 })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(feed.oddsCalls()).toEqual(["later"])
    expect(data.events.map((e: { id: string }) => e.id)).toEqual(["later"])
    expect(data.startedCount).toBe(1)
    expect(data.cappedOut).toBe(0)
    expect(new Set(data.quotes.map((q: { gameId: string }) => q.gameId)).size).toBe(1)
  })

  it("says every game has started rather than that there are none today", async () => {
    const now = Date.now()
    const feed = stubOddsApi([{ id: "live", commence_time: iso(now - HOUR) }], () => json({}, 500))
    const data = await (await today({ league: "nba", from: iso(now - 12 * HOUR), to: iso(now + 12 * HOUR) })).json()
    expect(feed.oddsCalls()).toEqual([])
    expect(data.quotes).toEqual([])
    expect(data.startedCount).toBe(1)
    expect(data.note).toContain("already started")
  })

  it("answers an error naming the quota when every game fails, so the last good pull is kept", async () => {
    // A 200 with no quotes read as "no props posted yet" and replaced the
    // cached pull, whose prices cannot be re-pulled once the quota is gone.
    const now = Date.now()
    stubOddsApi(
      [
        { id: "a", commence_time: iso(now + HOUR) },
        { id: "b", commence_time: iso(now + 2 * HOUR) },
      ],
      () => json({ message: "Usage quota has been reached.", error_code: "OUT_OF_USAGE_CREDITS" }, 401),
    )
    const res = await today({ league: "nba", from: iso(now), to: iso(now + 12 * HOUR) })
    const data = await res.json()
    expect(res.status).toBe(502)
    expect(data.error).toBe(
      "None of the 2 games could be priced. The Odds API quota is used up for this period. Usage quota has been reached.",
    )
    expect(data.quotes).toBeUndefined()
  })

  it("still answers with the games that priced when only some fail", async () => {
    const now = Date.now()
    const feed = stubOddsApi(
      [
        { id: "a", commence_time: iso(now + HOUR) },
        { id: "b", commence_time: iso(now + 2 * HOUR) },
      ],
      (id) => (id === "a" ? json(oddsFor(feed.listing[0]), 200, QUOTA) : json({ message: "nope" }, 500)),
    )
    const res = await today({ league: "nba", from: iso(now), to: iso(now + 12 * HOUR) })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.quotes.length).toBeGreaterThan(0)
    expect(data.failures).toEqual([{ eventId: "b", matchup: "Ab at Hb", error: "The Odds API returned 500. nope" }])
  })

  it("reports an unknown quota when the feed sends no quota headers", async () => {
    const now = Date.now()
    const listing = [{ id: "a", commence_time: iso(now + HOUR), home_team: "H", away_team: "A", sport_key: "basketball_nba" }]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("/odds?") ? json(oddsFor(listing[0])) : json(listing))),
    )
    const data = await (await today({ league: "nba", from: iso(now), to: iso(now + 12 * HOUR) })).json()
    expect(data.requestsRemaining).toBeNull()
    expect(data.requestsUsed).toBeNull()
  })

  it("says the feed could not be reached when the network is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }),
    )
    const res = await today({ league: "nba" })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("Could not reach The Odds API. Check the internet connection and try again.")
  })
})

describe("/api/today with a companion competition", () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A feed that answers per sport, so the NFL and college listings differ. */
  function stubFootballFeed(now: number) {
    const bySport: Record<string, { id: string; commence_time: string; home_team: string; away_team: string }[]> = {
      americanfootball_nfl: [
        { id: "nfl1", commence_time: iso(now + 3 * HOUR), home_team: "Chiefs", away_team: "Bills" },
      ],
      americanfootball_ncaaf: [
        { id: "cfb1", commence_time: iso(now + 4 * HOUR), home_team: "Buckeyes", away_team: "Nittany Lions" },
        { id: "cfb2", commence_time: iso(now + 5 * HOUR), home_team: "Tigers", away_team: "Crimson Tide" },
      ],
    }
    const urls: string[] = []
    const book = (key: string) => ({
      key,
      title: key,
      markets: [
        {
          key: "player_pass_yds",
          outcomes: [
            { name: "Over", description: "Some Passer", price: -110, point: 245.5 },
            { name: "Under", description: "Some Passer", price: -110, point: 245.5 },
          ],
        },
      ],
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url)
        const sport = url.match(/\/sports\/([^/]+)\//)![1]
        const ev = url.match(/\/events\/([^/?]+)\/odds/)
        if (ev) {
          const e = bySport[sport].find((x) => x.id === ev[1])!
          return json({ ...e, sport_key: sport, bookmakers: [book("pinnacle"), book("fanduel")] }, 200, QUOTA)
        }
        return json(bySport[sport].map((e) => ({ ...e, sport_key: sport })), 200, QUOTA)
      }),
    )
    return { urls, oddsCalls: () => urls.filter((u) => u.includes("/odds?")) }
  }

  it("leaves college football out unless the press asks for it", async () => {
    const now = Date.now()
    const feed = stubFootballFeed(now)
    const data = await (
      await today({
        league: "nfl",
        markets: ["player_pass_yds"],
        from: iso(now - HOUR),
        to: iso(now + 12 * HOUR),
        maxGames: 5,
      })
    ).json()
    // No college listing was even asked for, so nothing was billed for it.
    expect(feed.urls.some((u) => u.includes("ncaaf"))).toBe(false)
    expect(data.events.map((e: { id: string }) => e.id)).toEqual(["nfl1"])
    expect(data.estimatedCredits).toBe(1)
  })

  it("pulls college football with the NFL in one press and tags its props", async () => {
    const now = Date.now()
    const feed = stubFootballFeed(now)
    const res = await today({
      league: "nfl",
      companions: true,
      markets: ["player_pass_yds"],
      from: iso(now - HOUR),
      to: iso(now + 12 * HOUR),
      maxGames: 5,
    })
    const data = await res.json()
    expect(res.status).toBe(200)
    // Both listings were asked for, and both competitions' games were priced.
    expect(feed.urls.some((u) => u.includes("/sports/americanfootball_nfl/events?"))).toBe(true)
    expect(feed.urls.some((u) => u.includes("/sports/americanfootball_ncaaf/events?"))).toBe(true)
    expect(feed.oddsCalls()).toHaveLength(3)
    expect(data.events.map((e: { id: string }) => e.id).sort()).toEqual(["cfb1", "cfb2", "nfl1"])
    // The NFL game is billed for the one market asked for; the college games
    // ignore that list and use their own four. One plus two fours is nine.
    expect(data.estimatedCredits).toBe(9)
    const cfbCall = feed.oddsCalls().find((u) => u.includes("ncaaf"))!
    expect(cfbCall).toContain("markets=player_pass_yds%2Cplayer_rush_yds")
    const comps = data.quotes.map((q: { competition?: string }) => q.competition ?? "nfl")
    expect(new Set(comps)).toEqual(new Set(["nfl", "cfb"]))
  })

  it("keeps the companion's own game cap rather than the dial on the Today screen", async () => {
    const now = Date.now()
    // One NFL game allowed by the dial; the college cap is the config's, not 1.
    const feed = stubFootballFeed(now)
    await today({
      league: "nfl",
      companions: true,
      markets: ["player_pass_yds"],
      from: iso(now - HOUR),
      to: iso(now + 12 * HOUR),
      maxGames: 1,
    })
    expect(feed.oddsCalls().filter((u) => u.includes("ncaaf"))).toHaveLength(2)
    expect(feed.oddsCalls().filter((u) => u.includes("_nfl"))).toHaveLength(1)
  })

  it("asks the NBA for one listing only, because it has no companion", async () => {
    const now = Date.now()
    const feed = stubOddsApi([{ id: "g1", commence_time: iso(now + 3 * HOUR) }], (id) =>
      json(oddsFor({ ...feed.listing.find((e) => e.id === id)! }), 200, QUOTA),
    )
    await today({ league: "nba", markets: ["player_points"], from: iso(now - HOUR), to: iso(now + 12 * HOUR) })
    expect(feed.urls.filter((u) => u.includes("/events?"))).toHaveLength(1)
  })
})

describe("/api/today ranking a companion slate by market depth", () => {
  afterEach(() => vi.unstubAllGlobals())

  /**
   * Nine college games in the window against a cap of six, which is what makes
   * the ranking worth a credit. Two are routs, one is priced by nobody, and the
   * order the books imply is nothing like the order they kick off in.
   */
  function stubSaturday(now: number) {
    const games = [
      { id: "cfb-early-dead", books: 0, margin: null, at: 1 },
      { id: "cfb-rout", books: 9, margin: 31, at: 2 },
      { id: "cfb-thin", books: 2, margin: 7, at: 3 },
      { id: "cfb-deep", books: 9, margin: 3, at: 4 },
      { id: "cfb-mid", books: 5, margin: 6, at: 5 },
      { id: "cfb-rout-two", books: 8, margin: 24, at: 6 },
      { id: "cfb-b", books: 7, margin: 10, at: 7 },
      { id: "cfb-c", books: 6, margin: 4, at: 8 },
      { id: "cfb-d", books: 3, margin: 9, at: 9 },
    ]
    const listing = games.map((g) => ({
      id: g.id,
      sport_key: "americanfootball_ncaaf",
      commence_time: iso(now + g.at * HOUR),
      home_team: `${g.id} home`,
      away_team: `${g.id} away`,
    }))
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.includes("/sports/americanfootball_nfl/")) return json([], 200, QUOTA)
        const ev = url.match(/\/events\/([^/?]+)\/odds/)
        if (ev) {
          const e = listing.find((x) => x.id === ev[1])!
          return json(
            {
              ...e,
              bookmakers: [
                {
                  key: "pinnacle",
                  title: "pinnacle",
                  markets: [
                    {
                      key: "player_pass_yds",
                      outcomes: [
                        { name: "Over", description: "Some Passer", price: -110, point: 245.5 },
                        { name: "Under", description: "Some Passer", price: -110, point: 245.5 },
                      ],
                    },
                  ],
                },
              ],
            },
            200,
            QUOTA,
          )
        }
        // The sport-level spreads call: one credit, every game at once.
        if (url.includes("/odds?")) {
          return json(
            games.map((g) => ({
              ...listing.find((l) => l.id === g.id)!,
              bookmakers: Array.from({ length: g.books }, (_, i) => ({
                key: `b${i}`,
                title: `b${i}`,
                markets:
                  g.margin == null
                    ? []
                    : [{ key: "spreads", outcomes: [{ name: "home", price: -110, point: -g.margin }] }],
              })),
            })),
            200,
            QUOTA,
          )
        }
        return json(listing, 200, QUOTA)
      }),
    )
    return {
      urls,
      bulkCalls: () => urls.filter((u) => /\/odds\?/.test(u) && !u.includes("/events/")),
      pricedIds: () =>
        urls
          .map((u) => u.match(/\/events\/([^/?]+)\/odds/)?.[1])
          .filter((id): id is string => !!id),
    }
  }

  const saturday = (now: number) =>
    today({
      league: "nfl",
      companions: true,
      markets: ["player_pass_yds"],
      from: iso(now - HOUR),
      to: iso(now + 12 * HOUR),
      maxGames: 5,
    })

  it("spends the cap on the games the books price, not the ones that kick off first", async () => {
    const now = Date.now()
    const feed = stubSaturday(now)
    const data = await (await saturday(now)).json()
    // One sport-level call, pinned to one region so it is one credit.
    expect(feed.bulkCalls()).toHaveLength(1)
    expect(feed.bulkCalls()[0]).toContain("markets=spreads")
    expect(feed.bulkCalls()[0]).toContain("regions=us")
    expect(feed.bulkCalls()[0]).not.toContain("us2")
    // Six games priced, deepest first: the two routs and the game nobody
    // prices are out, and the earliest kick-off is the one nobody prices.
    const order = ["cfb-deep", "cfb-b", "cfb-c", "cfb-mid", "cfb-d", "cfb-thin"]
    expect(feed.pricedIds()).toEqual(order)
    expect(data.events.map((e: { id: string }) => e.id)).toEqual(order)
  })

  it("bills the ranking call and says what it did", async () => {
    const now = Date.now()
    stubSaturday(now)
    const data = await (await saturday(now)).json()
    // Six games at four markets is 24, plus one for the ranking.
    expect(data.estimatedCredits).toBe(6 * 4 + 1)
    expect(data.depthNote).toContain("6 of 9 College football games priced")
    expect(data.depthNote).toContain("2 skipped as likely blowouts")
    expect(data.depthNote).toContain("1 had no spread priced")
  })

  it("keeps the league's paid pull when the companion cannot even be listed", async () => {
    // The league is pulled first and billed as it goes, so a 429 on the
    // companion's free listing used to return a 502 with no quotes and bin a
    // slate that had already cost credits.
    const now = Date.now()
    stubSaturday(now)
    const base = globalThis.fetch as unknown as (u: string) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/sports/americanfootball_ncaaf/events?")) return json({ message: "rate limited" }, 429)
        return base(url)
      }),
    )
    const res = await saturday(now)
    const data = await res.json()
    expect(res.status).toBe(200)
    // The NFL stub lists no games here, so what matters is that the press did
    // not throw and the failure is reported rather than swallowed.
    expect(data.failures.some((f: { matchup: string }) => f.matchup === "College football")).toBe(true)
    expect(data.failures[0].error).toContain("limiting")
  })

  it("falls back to start order and says so when the ranking call fails", async () => {
    const now = Date.now()
    const feed = stubSaturday(now)
    const base = globalThis.fetch as unknown as (u: string) => Promise<Response>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (/\/odds\?/.test(url) && !url.includes("/events/")) return json({ message: "boom" }, 503)
      return base(url)
    }))
    const data = await (await saturday(now)).json()
    // The slate still priced, in start order, and the screen is told why.
    expect(feed.pricedIds().length).toBeGreaterThan(0)
    expect(data.depthNote).toContain("College football")
    expect(data.quotes.length).toBeGreaterThan(0)
  })
})

describe("/api/odds", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("answers an error when every game fails, so Capture keeps the prices it already attached", async () => {
    const now = Date.now()
    stubOddsApi([{ id: "a", commence_time: iso(now + HOUR) }], () =>
      json({ message: "Usage quota has been reached.", error_code: "OUT_OF_USAGE_CREDITS" }, 401),
    )
    const res = await odds({ league: "nba", markets: ["player_points"], from: iso(now), to: iso(now + 12 * HOUR) })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("quota is used up")
  })

  it("skips games already under way", async () => {
    const now = Date.now()
    const feed = stubOddsApi(
      [
        { id: "live", commence_time: iso(now - HOUR) },
        { id: "later", commence_time: iso(now + HOUR) },
      ],
      (id) => json(oddsFor(feed.listing.find((e) => e.id === id)!), 200, QUOTA),
    )
    const data = await (await odds({ league: "nba", markets: ["player_points"], from: iso(now - 12 * HOUR), to: iso(now + 12 * HOUR) })).json()
    expect(feed.oddsCalls()).toEqual(["later"])
    expect(data.startedCount).toBe(1)
  })
})

describe("pullPropline with a clock", () => {
  it("leaves out games that have started and counts them", async () => {
    const now = Date.parse("2026-01-16T01:00:00Z")
    const listing = [
      { id: 1, commence_time: "2026-01-16T00:10:00Z", home_team: "Oklahoma City Thunder", away_team: "Minnesota Timberwolves" },
      { id: 2, commence_time: "2026-01-16T02:30:00Z", home_team: "Los Angeles Lakers", away_team: "Boston Celtics" },
    ]
    const asked: string[] = []
    const fetcher = async (url: string) => {
      asked.push(url)
      return url.endsWith("/events") ? json(listing) : json({ ...listing[1], bookmakers: [] })
    }
    const pull = await pullPropline({
      apiKey: "k",
      league: "nba",
      fromMs: Date.parse("2026-01-15T05:00:00Z"),
      toMs: Date.parse("2026-01-16T11:00:00Z"),
      markets: ["player_points"],
      maxGames: 1,
      now,
      fetcher,
    })
    expect(pull.selected.map((e) => e.id)).toEqual(["2"])
    expect(pull.started).toBe(1)
    expect(pull.cappedOut).toBe(0)
    expect(asked.filter((u) => !u.endsWith("/events"))).toHaveLength(1)
  })
})

/**
 * A market list must never be able to take a league offline.
 *
 * This is a regression. Widening the NBA to its full board on PropLine made
 * every game's odds request fail, and with every game failing the pull
 * reported that nothing could be priced — the NBA simply stopped working on
 * PropLine, with nothing on screen naming the market list as the cause.
 */
describe("PropLine refusing the market list", () => {
  const WIDE = ["player_points", "player_rebounds", "player_blocks_steals", "player_frees_made"]
  const CORE = ["player_points", "player_rebounds"]
  const listing = [
    { id: 1, commence_time: "2026-01-16T02:00:00Z", home_team: "Oklahoma City Thunder", away_team: "Minnesota Timberwolves" },
    { id: 2, commence_time: "2026-01-16T02:30:00Z", home_team: "Los Angeles Lakers", away_team: "Boston Celtics" },
  ]
  const WINDOW = { fromMs: Date.parse("2026-01-15T05:00:00Z"), toMs: Date.parse("2026-01-16T11:00:00Z") }

  /** Refuses any request naming a market outside `serves`, the way a feed that does not carry one would. */
  function stubServing(serves: string[], asked: string[]) {
    return async (url: string) => {
      asked.push(url)
      if (url.endsWith("/events")) return json(listing)
      const wanted = decodeURIComponent(new URL(url).searchParams.get("markets") ?? "").split(",")
      const bad = wanted.filter((m) => !serves.includes(m))
      if (bad.length > 0) {
        return json({ detail: { error: "invalid_market", message: `Unknown market: ${bad[0]}` } }, 422)
      }
      const e = listing.find((l) => url.includes(`/events/${l.id}/`))!
      return json({ ...e, bookmakers: [] })
    }
  }

  it("falls back to the core markets rather than failing the whole pull", async () => {
    const asked: string[] = []
    const pull = await pullPropline({
      apiKey: "k", league: "nba", ...WINDOW,
      markets: WIDE, coreMarkets: CORE, maxGames: 2,
      fetcher: stubServing(CORE, asked),
    })
    // Both games priced, nothing failed: the league still works.
    expect(pull.payloads).toHaveLength(2)
    expect(pull.failures).toEqual([])
    expect(pull.narrowed).toEqual({
      from: WIDE,
      to: CORE,
      because: expect.stringContaining("player_blocks_steals"),
    })
  })

  it("pays for the discovery once, not once per game", async () => {
    // PropLine bills per request, so the first game pays to find out and every
    // game after it goes straight to the list that works.
    const asked: string[] = []
    await pullPropline({
      apiKey: "k", league: "nba", ...WINDOW,
      markets: WIDE, coreMarkets: CORE, maxGames: 2,
      fetcher: stubServing(CORE, asked),
    })
    const odds = asked.filter((u) => !u.endsWith("/events"))
    // Game 1 wide (refused) then core, game 2 core only.
    expect(odds).toHaveLength(3)
    expect(odds.filter((u) => u.includes("player_blocks_steals"))).toHaveLength(1)
  })

  it("names the markets that went, because the list is what the user can change", async () => {
    const asked: string[] = []
    const pull = await pullPropline({
      apiKey: "k", league: "nba", ...WINDOW,
      markets: WIDE, coreMarkets: CORE, maxGames: 1,
      fetcher: stubServing(CORE, asked),
    })
    const note = narrowedMarketsNote(pull.narrowed)!
    expect(note).toContain("player_blocks_steals")
    expect(note).toContain("player_frees_made")
    expect(note).not.toContain("player_points")
    expect(narrowedMarketsNote(null)).toBeNull()
  })

  it("reports the real failure when the core list fails too", async () => {
    // Then the market list is not the problem, and blaming it would send the
    // user to change the one thing that is not wrong.
    const asked: string[] = []
    const pull = await pullPropline({
      apiKey: "k", league: "nba", ...WINDOW,
      markets: WIDE, coreMarkets: CORE, maxGames: 1,
      fetcher: stubServing([], asked),
    })
    expect(pull.narrowed).toBeNull()
    expect(pull.failures).toHaveLength(1)
    expect(pull.failures[0].error).toContain("player_points")
  })

  it("does not retry a rejected key game by game", async () => {
    // A key PropLine refused will refuse the narrow list too, and every retry
    // spends quota to be told the same thing.
    const asked: string[] = []
    const fetcher = async (url: string) => {
      asked.push(url)
      if (url.endsWith("/events")) return json(listing)
      return json({ detail: { error: "invalid_api_key", message: "Invalid API key." } }, 401)
    }
    await expect(
      pullPropline({
        apiKey: "k", league: "nba", ...WINDOW,
        markets: WIDE, coreMarkets: CORE, maxGames: 2, fetcher,
      }),
    ).rejects.toThrow(/rejected the API key/)
    expect(asked.filter((u) => !u.endsWith("/events"))).toHaveLength(1)
  })
})

describe("markets that came back with nothing behind them", () => {
  it("names a market no sportsbook priced, because that is the one thing the user can fix", () => {
    // A real pull asked for turnovers because PrizePicks posts it heavily, and
    // got back 85 PrizePicks lines and not one sportsbook quote. The app knew
    // and said nothing, so a market-list problem read as "the app does not
    // work" and diagnosing it meant reading source.
    const quotes = [{ market: "PTS" as const }, { market: "REB" as const }]
    const note = marketCoverageNote(["player_points", "player_rebounds", "player_turnovers"], quotes)!
    expect(note).toContain("player_turnovers")
    expect(note).toContain("Settings → Markets")
    expect(note).not.toContain("player_points")
  })

  it("says nothing when every market asked for came back priced", () => {
    const quotes = [{ market: "PTS" as const }, { market: "REB" as const }]
    expect(marketCoverageNote(["player_points", "player_rebounds"], quotes)).toBeNull()
  })

  it("does not tell you to drop a market you never asked for", () => {
    // The report: a PropLine NBA pull with the Markets box blank, so on this
    // app's own list, warned "drop player_field_goals, player_frees_made from
    // Settings → Markets" on every pull. Nobody had typed them, nobody could
    // drop them without typing out the rest of the list, and on a feed billed
    // per request they cost nothing. A warning nobody can act on is noise.
    const quotes = [{ market: "PTS" as const }, { market: "REB" as const }]
    const asked = ["player_points", "player_rebounds", "player_field_goals", "player_frees_made"]
    expect(marketCoverageNote(asked, quotes, [], "basketball", { chosen: false, billsPerRequest: true })).toBeNull()
    // A list typed into Settings is the user's to trim, whatever the feed.
    const typed = marketCoverageNote(asked, quotes, [], "basketball", { chosen: true, billsPerRequest: true })!
    expect(typed).toContain("Settings → Markets")
    // Where every market is billed per game, credits are being spent on it,
    // so it is said — with the list to type rather than an order to edit a
    // blank box.
    const billed = marketCoverageNote(asked, quotes, [], "basketball", { chosen: false })!
    expect(billed).toContain("set Settings → Markets to player_points, player_rebounds")
    expect(billed).not.toContain("Drop")
  })

  it("names markets in words, and keys only where a key is what to type", () => {
    const note = marketCoverageNote(["player_points", "player_frees_made"], [{ market: "PTS" as const }])!
    expect(note).toContain("priced Free Throws Made,")
    expect(note).toContain("Drop player_frees_made from Settings → Markets")
  })

  it("knows a typed list from this app's own", () => {
    expect(marketsChosen(LEAGUES.nba, null)).toBe(false)
    expect(marketsChosen(LEAGUES.nba, [])).toBe(false)
    expect(marketsChosen(LEAGUES.nba, ["player_points"])).toBe(true)
    // A basketball list does not reach the NFL, so the NFL is on its own list.
    expect(marketsChosen(LEAGUES.nfl, ["player_points"])).toBe(false)
    // And a companion ignores the box entirely.
    expect(marketsChosen(LEAGUES.cfb, ["player_pass_yds"])).toBe(false)
  })

  it("tells a gap in this app's market map apart from a gap in the book's coverage", () => {
    // They look identical from the outside and the fixes are opposites: one is
    // a line to delete from the Markets box, the other is a key to add here.
    const note = marketCoverageNote(["player_points"], [{ market: "PTS" as const }], ["player_double_double"])!
    expect(note).toContain("does not recognise")
    expect(note).toContain("player_double_double")
    expect(note).toContain("this app's market map")
  })
})

describe("a PropLine key the feed rejects", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  /** PropLine's own body on a bad key: `detail` is an object, not a sentence. */
  const REJECTED = {
    detail: { error: "invalid_api_key", message: "Invalid API key.", signup_url: "https://prop-line.com/" },
  }

  /** Every PropLine request answers 401, and the keys it was sent are recorded. */
  function stubRejecting() {
    const sent: (string | null)[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("X-API-Key"))
        return json(REJECTED, 401)
      }),
    )
    return sent
  }

  for (const [name, call] of [
    ["/api/today", today],
    ["/api/odds", odds],
  ] as const) {
    it(`${name} sends the screen to Settings with PropLine's sentence, not its JSON`, async () => {
      vi.stubEnv("PROPLINE_API_KEY", "")
      stubRejecting()
      const res = await call({ provider: "propline", proplineKey: "wrong-key", league: "nba" })
      const body = (await res.json()) as { error: string; needsKey?: boolean }
      // This server's credential was refused upstream, not the caller's: 502, with needsKey.
      expect(res.status).toBe(502)
      expect(body.needsKey).toBe(true)
      expect(body.error).toContain("PropLine rejected the API key. Invalid API key.")
      expect(body.error).toContain("Settings")
      expect(body.error).not.toContain("{")
    })
  }

  it("offers the other feed when a refused PropLine key stopped the whole slate", async () => {
    // PropLine PRICING the slate and refusing the key means nothing was
    // pulled, which the key's own sentence cannot say: it is written for the
    // pick'em-lines call too, where the slate survives. And the offer is only
    // made when there is an Odds API key to go back to.
    vi.stubEnv("PROPLINE_API_KEY", "")
    vi.stubEnv("ODDS_API_KEY", "")
    stubRejecting()
    const withKey = (await (
      await today({ provider: "propline", proplineKey: "wrong-key", apiKey: "odds-key", league: "nba" })
    ).json()) as { error: string }
    expect(withKey.error).toContain("PropLine is pricing the slate, so nothing was pulled.")
    expect(withKey.error).toContain("Switch the provider back to The Odds API")

    // apiKey must be cleared explicitly: the helper above injects one into
    // every body, so omitting it is not the same as not having one.
    stubRejecting()
    const withoutKey = (await (
      await today({ provider: "propline", proplineKey: "wrong-key", apiKey: "", league: "nba" })
    ).json()) as { error: string }
    expect(withoutKey.error).toContain("PropLine is pricing the slate, so nothing was pulled.")
    // No Odds API key, so no advice that leads nowhere.
    expect(withoutKey.error).not.toContain("Switch the provider back")
  })

  it("names the environment when that is where the rejected key came from", async () => {
    vi.stubEnv("PROPLINE_API_KEY", "stale-env-key")
    const sent = stubRejecting()
    const body = (await (await today({ provider: "propline", proplineKey: "settings-key", league: "nba" })).json()) as {
      error: string
    }
    expect(sent[0]).toBe("stale-env-key")
    expect(body.error).toContain("PROPLINE_API_KEY in the environment, which takes precedence")
  })

  it("never sends a placeholder left in the environment, and uses the Settings key instead", async () => {
    vi.stubEnv("PROPLINE_API_KEY", "your_api_key")
    const sent = stubRejecting()
    await today({ provider: "propline", proplineKey: ' "settings-key"\n', league: "nba" })
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((k) => k === "settings-key")).toBe(true)
  })

  it("does not reach PropLine at all when the only key is a placeholder", async () => {
    vi.stubEnv("PROPLINE_API_KEY", "changeme")
    const sent = stubRejecting()
    const res = await today({ provider: "propline", proplineKey: "your_api_key", league: "nba" })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { needsKey?: boolean }).needsKey).toBe(true)
    expect(sent).toHaveLength(0)
  })
})

/**
 * The report: "The Odds API rejected the API key. API key is not valid."
 * for a key that had just been generated, and again for the one generated
 * after it. The sentence does not say which key was sent, and the key just
 * typed is the one everybody assumes. PropLine's rejection has named its key
 * since the same thing happened there; this one never did.
 */
describe("an Odds API key the feed rejects", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  /** The Odds API's own body on a key it does not know, link and all. */
  const REJECTED = {
    message: "API key is not valid. Get an API key at https://the-odds-api.com",
    error_code: "INVALID_KEY",
  }
  /** Made up, the length of a real one. */
  const TYPED = "0123456789abcdef0123456789ab4026"
  const ON_THE_SERVER = "an-older-key-left-on-the-server-9999"

  /** Every Odds API request answers 401 with `body`, and the keys it was sent are recorded. */
  function stubRejecting(body: object = REJECTED) {
    const sent: (string | null)[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        sent.push(new URL(url).searchParams.get("apiKey"))
        return json(body, 401)
      }),
    )
    return sent
  }

  for (const [name, call] of [
    ["/api/today", today],
    ["/api/odds", odds],
  ] as const) {
    it(`${name} says which key was refused: the one from Settings, by its ending`, async () => {
      vi.stubEnv("ODDS_API_KEY", "")
      const sent = stubRejecting()
      const res = await call({ provider: "theoddsapi", apiKey: TYPED, league: "nba" })
      const body = (await res.json()) as { error: string; needsKey?: boolean }
      expect(res.status).toBe(502)
      expect(sent[0]).toBe(TYPED)
      expect(body.error).toBe(
        'The Odds API rejected the API key. API key is not valid. Get an API key at https://the-odds-api.com. The key came from Settings → Odds feed → The Odds API key and ends in "4026".',
      )
      // Settings is where that key lives, so that is where the screen points.
      expect(body.needsKey).toBe(true)
      // The ending tells keys apart. The key itself is not sent back.
      expect(body.error).not.toContain(TYPED)
    })

    it(`${name} names the environment when its key outranked the one typed in Settings`, async () => {
      // The case no amount of retyping fixes: the key in Settings is new and
      // right, and is not the key that was sent.
      vi.stubEnv("ODDS_API_KEY", ON_THE_SERVER)
      const sent = stubRejecting()
      const res = await call({ provider: "theoddsapi", apiKey: TYPED, league: "nba" })
      const body = (await res.json()) as { error: string; needsKey?: boolean }
      expect(sent[0]).toBe(ON_THE_SERVER)
      expect(body.error).toContain("The Odds API rejected the API key.")
      expect(body.error).toContain("ODDS_API_KEY in the environment, which takes precedence over the one in Settings")
      // Not one character of a key the server holds, nor of the one that was not sent.
      expect(body.error).not.toContain("9999")
      expect(body.error).not.toContain("4026")
      // Nothing typed in Settings changes which key is sent, so it is the wrong door.
      expect(body.needsKey).toBeUndefined()
    })
  }

  it("does not blame the key for a used-up quota, which comes back with the same status", async () => {
    vi.stubEnv("ODDS_API_KEY", "")
    stubRejecting({ message: "Usage quota has been reached.", error_code: "OUT_OF_USAGE_CREDITS" })
    const res = await today({ provider: "theoddsapi", apiKey: TYPED, league: "nba" })
    const body = (await res.json()) as { error: string; needsKey?: boolean }
    expect(body.error).toBe("The Odds API quota is used up for this period. Usage quota has been reached.")
    expect(body.needsKey).toBeUndefined()
  })

  it("leaves any other failure exactly as it read before", async () => {
    vi.stubEnv("ODDS_API_KEY", "")
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad gateway", { status: 503 })))
    const body = (await (await today({ provider: "theoddsapi", apiKey: TYPED, league: "nba" })).json()) as {
      error: string
      needsKey?: boolean
    }
    expect(body).toEqual({ error: "The Odds API returned 503. Bad gateway" })
  })
})


// ---------------------------------------------------------------------------
// What a pull actually cost
// ---------------------------------------------------------------------------

import { addCost, addFreeCost, emptyCost, sumCosts } from "@/lib/odds-feed/http"

/**
 * The app estimated what a pull cost and never measured it, while the feed
 * stated the cost of every request in a header it was throwing away. Two
 * things have to hold for the measurement to be worth printing: silence must
 * not read as free, and a request that failed must not read as a request that
 * was cheap.
 */
describe("folding up what the feed charged", () => {
  it("counts a response with no per-request cost as unmeasured rather than as a free request", () => {
    // Number(null) is 0, which is the whole reason headerCount exists. A feed
    // that omits the header would otherwise make every pull look free.
    const c = emptyCost()
    addCost(c, 2)
    addCost(c, null)
    addCost(c, 1)
    expect(c).toEqual({ credits: 3, measured: 2, unmeasured: 1 })
  })

  it("does not count the free listing as a gap in the total", () => {
    // The listing is documented as free and is not in the estimate either, so
    // a listing that reports nothing is not a hole in the measurement — it is
    // a request that was never in the total being compared against. Counting
    // it would make every single pull read as impossible to total.
    const c = emptyCost()
    addFreeCost(c, null)
    expect(c).toEqual({ credits: 0, measured: 0, unmeasured: 0 })
    addFreeCost(c, 1)
    expect(c).toEqual({ credits: 1, measured: 0, unmeasured: 0 })
  })

  it("sums across competitions, because one press can pull more than one", () => {
    expect(sumCosts([
      { credits: 4, measured: 2, unmeasured: 0 },
      { credits: 24, measured: 6, unmeasured: 1 },
    ])).toEqual({ credits: 28, measured: 8, unmeasured: 1 })
    expect(sumCosts([])).toEqual({ credits: 0, measured: 0, unmeasured: 0 })
  })
})

describe("/api/today reporting what the feed charged", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reports the feed's own figure, and says so when it bills less than the estimate", async () => {
    // Two games at two markets is estimated at four credits; the feed charges
    // one per game because only one of the two markets came back. That is the
    // empty-market question this app has carried an open note about for a
    // while, answering itself.
    const now = Date.now()
    const feed = stubOddsApi(
      [
        { id: "a", commence_time: iso(now + HOUR) },
        { id: "b", commence_time: iso(now + 2 * HOUR) },
      ],
      (id) => json(oddsFor({ ...feed.listing.find((e) => e.id === id)! }), 200, quota(1)),
    )
    const res = await today({
      league: "nba",
      markets: ["player_points", "player_rebounds"],
      from: iso(now),
      to: iso(now + 12 * HOUR),
    })
    const data = await res.json()
    expect(data.estimatedCredits).toBe(4)
    expect(data.measuredCredits).toBe(2)
    expect(data.unmeasuredRequests).toBe(0)
    expect(data.creditNote).toContain("billed 2 credits")
    expect(data.creditNote).toContain("estimated at 4")
    expect(data.creditNote).toContain("not charged for")
  })

  it("says nothing extra when the feed bills exactly what was estimated", async () => {
    const now = Date.now()
    const feed = stubOddsApi(
      [{ id: "a", commence_time: iso(now + HOUR) }],
      (id) => json(oddsFor({ ...feed.listing.find((e) => e.id === id)! }), 200, quota(1)),
    )
    const res = await today({ league: "nba", markets: ["player_points"], from: iso(now), to: iso(now + 12 * HOUR) })
    const data = await res.json()
    expect(data.estimatedCredits).toBe(1)
    expect(data.measuredCredits).toBe(1)
    // The figure is still reported; only the sentence is withheld, because a
    // measurement that agrees with the estimate needs no explanation.
    expect(data.creditNote).toBeNull()
  })

  it("does not read a failed game as proof that empty markets are free", async () => {
    // This is the regression the comparator design exists for. One game of two
    // 500s: it was estimated and never billed, so the measured total is below
    // the estimate for a reason that has nothing to do with empty markets.
    const now = Date.now()
    const feed = stubOddsApi(
      [
        { id: "a", commence_time: iso(now + HOUR) },
        { id: "b", commence_time: iso(now + 2 * HOUR) },
      ],
      (id) => (id === "a" ? json(oddsFor(feed.listing[0]), 200, quota(1)) : json({ message: "nope" }, 500)),
    )
    const res = await today({ league: "nba", markets: ["player_points"], from: iso(now), to: iso(now + 12 * HOUR) })
    const data = await res.json()
    expect(data.failures).toHaveLength(1)
    expect(data.estimatedCredits).toBe(2)
    expect(data.measuredCredits).toBe(1)
    expect(data.creditNote).toBeNull()
  })

  it("calls the total a floor when only some billed responses said what they cost", async () => {
    const now = Date.now()
    const feed = stubOddsApi(
      [
        { id: "a", commence_time: iso(now + HOUR) },
        { id: "b", commence_time: iso(now + 2 * HOUR) },
      ],
      (id) =>
        json(oddsFor({ ...feed.listing.find((e) => e.id === id)! }), 200, id === "a" ? quota(1) : QUOTA),
    )
    const res = await today({ league: "nba", markets: ["player_points"], from: iso(now), to: iso(now + 12 * HOUR) })
    const data = await res.json()
    expect(data.measuredCredits).toBe(1)
    expect(data.unmeasuredRequests).toBe(1)
    expect(data.creditNote).toContain("floor")
  })

  it("leaves the cost unknown rather than zero when the feed itemises nothing", async () => {
    // The existing stubs, which send quota headers and no per-request cost.
    const now = Date.now()
    const feed = stubOddsApi(
      [{ id: "a", commence_time: iso(now + HOUR) }],
      (id) => json(oddsFor({ ...feed.listing.find((e) => e.id === id)! }), 200, QUOTA),
    )
    const res = await today({ league: "nba", markets: ["player_points"], from: iso(now), to: iso(now + 12 * HOUR) })
    const data = await res.json()
    expect(data.measuredCredits).toBeNull()
    expect(data.unmeasuredRequests).toBe(1)
    // Nothing was measured, so there is nothing to call a floor either.
    expect(data.creditNote).toBeNull()
  })
})

describe("a refused PropLine key on a slate The Odds API priced", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  /** The Odds API answers normally; PropLine answers with the status given. */
  function stubBoth(propline: () => Response) {
    const now = Date.now()
    const listing = [{ id: "g1", commence_time: iso(now + 3 * HOUR), sport_key: "basketball_nba", home_team: "H", away_team: "A" }]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("prop-line.com")) return propline()
        if (/\/events\/[^/]+\/odds/.test(url)) return json(oddsFor(listing[0]), 200, QUOTA)
        return json(listing, 200, QUOTA)
      }),
    )
    return now
  }

  const pull = (now: number) =>
    today({
      provider: "theoddsapi",
      apiKey: "odds-key",
      proplineKey: "dud-key",
      pickemLines: true,
      league: "nba",
      markets: ["player_points"],
      from: iso(now - HOUR),
      to: iso(now + 12 * HOUR),
      maxGames: 1,
    })

  it("says which key was refused, because the message used to read as the Odds API key", async () => {
    // A real install regenerated its Odds API key twice in answer to
    // "PropLine rejected the API key". The two keys never cross, so that could
    // not help; the note now says so in as many words.
    vi.stubEnv("PROPLINE_API_KEY", "")
    vi.stubEnv("ODDS_API_KEY", "")
    const now = stubBoth(() =>
      json({ detail: { error: "invalid_api_key", message: "Invalid API key." } }, 401),
    )
    const res = await pull(now)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pickemNote: string | null; quotes: unknown[] }
    // The slate itself survived: pick'em lines are a bonus on this path.
    expect(body.quotes.length).toBeGreaterThan(0)
    expect(body.pickemNote).toContain("PropLine rejected the API key.")
    expect(body.pickemNote).toContain("This is the PropLine key, not your Odds API key")
    expect(body.pickemNote).toContain("unaffected")
    expect(body.pickemNote).toContain("Pick'em apps' own lines")
  })

  it("leaves a failure that is not about the key alone", async () => {
    // A rate limit says nothing about which key is wrong, because none is.
    vi.stubEnv("PROPLINE_API_KEY", "")
    vi.stubEnv("ODDS_API_KEY", "")
    const now = stubBoth(() => json({ detail: { error: "burst_limit_exceeded", message: "Slow down." } }, 429))
    const body = (await (await pull(now)).json()) as { pickemNote: string | null }
    expect(body.pickemNote).toContain("Pick'em lines unavailable")
    expect(body.pickemNote).not.toContain("not your Odds API key")
  })
})
