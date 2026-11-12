import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiResponseError, describeNonJson, readApiJson } from "@/lib/api-response"
import { cleanApiKey, describeKey, looksLikeOddsApiKey, usableKey, type ResolvedKey } from "@/lib/odds-feed/api-key"
import { checkOddsApiKey, checkProplineKey, parseKeyCheck } from "@/lib/odds-feed/check"
import { proplineQuota } from "@/lib/odds-feed/propline"

const ODDS_KEY = "0123456789abcdef0123456789abcdef"
const PROPLINE_KEY = "pl_live_Zx81kQ0000000000000000004026"

const typed = (key: string, label = "Settings → Odds feed → The Odds API key"): ResolvedKey => ({
  key,
  source: "settings",
  label,
})
const held = (key: string, label: string): ResolvedKey => ({ key, source: "environment", label })

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

/** Stub the feed, recording what was asked of it. */
function stubFeed(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return answer(url, init)
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("a key copied along with something else", () => {
  it("leaves a key that arrives on its own exactly as it is", () => {
    expect(cleanApiKey(ODDS_KEY)).toBe(ODDS_KEY)
    expect(cleanApiKey(PROPLINE_KEY)).toBe(PROPLINE_KEY)
    expect(cleanApiKey("short")).toBe("short")
    // Base64 padding is part of a key, not an assignment.
    expect(cleanApiKey("QUJDREVGR0hJSktMTU5PUA==")).toBe("QUJDREVGR0hJSktMTU5PUA==")
  })

  it("takes the key out from under the label printed above it", () => {
    // A line break pasted into a one-line field arrives as a space.
    expect(cleanApiKey(`API Key ${ODDS_KEY}`)).toBe(ODDS_KEY)
    expect(cleanApiKey(`API Key\n${ODDS_KEY}\n`)).toBe(ODDS_KEY)
    expect(cleanApiKey(`API key: ${ODDS_KEY}`)).toBe(ODDS_KEY)
    expect(cleanApiKey(`Your API key is ${ODDS_KEY}.`)).toBe(ODDS_KEY)
  })

  it("takes the key out of the request or the settings line it was copied in", () => {
    expect(cleanApiKey(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}`)).toBe(ODDS_KEY)
    expect(cleanApiKey(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}&regions=us`)).toBe(ODDS_KEY)
    expect(cleanApiKey(`ODDS_API_KEY=${ODDS_KEY}`)).toBe(ODDS_KEY)
    expect(cleanApiKey(`PROPLINE_API_KEY="${PROPLINE_KEY}"`)).toBe(PROPLINE_KEY)
    expect(cleanApiKey(`X-API-Key: ${PROPLINE_KEY}`)).toBe(PROPLINE_KEY)
    expect(cleanApiKey(`{"apiKey": "${ODDS_KEY}"}`)).toBe(ODDS_KEY)
  })

  it("drops characters that cannot be seen", () => {
    expect(cleanApiKey(`﻿${ODDS_KEY}​`)).toBe(ODDS_KEY)
    expect(cleanApiKey(` ${ODDS_KEY} `)).toBe(ODDS_KEY)
    expect(cleanApiKey(`${ODDS_KEY.slice(0, 16)}​${ODDS_KEY.slice(16)}`)).toBe(ODDS_KEY)
  })

  it("does not guess when there is no telling which part is the key", () => {
    // Two long parts: either could be it, so the feed is left to refuse the lot.
    const two = `${ODDS_KEY} ${PROPLINE_KEY}`
    expect(cleanApiKey(two)).toBe(two)
    // No part long enough to be a key.
    expect(cleanApiKey("my key")).toBe("my key")
    // A placeholder stays a placeholder.
    expect(usableKey("api_key")).toBeNull()
    expect(usableKey("your_api_key")).toBeNull()
  })

  it("describes a key by its length and ending, and never a short one by its ending", () => {
    expect(describeKey(ODDS_KEY)).toBe('32 characters, ending in "cdef"')
    expect(describeKey("abc")).toBe("3 characters")
    expect(describeKey("a")).toBe("1 character")
  })

  it("knows the shape of an Odds API key", () => {
    expect(looksLikeOddsApiKey(ODDS_KEY)).toBe(true)
    expect(looksLikeOddsApiKey(ODDS_KEY.toUpperCase())).toBe(true)
    expect(looksLikeOddsApiKey(ODDS_KEY + ODDS_KEY)).toBe(false)
    expect(looksLikeOddsApiKey(PROPLINE_KEY)).toBe(false)
  })
})

describe("asking The Odds API about a key", () => {
  it("says a key was accepted, with what is left on it, from the free sports listing", async () => {
    const calls = stubFeed(() => json([{ key: "basketball_nba" }], 200, { "x-requests-remaining": "487", "x-requests-used": "13" }))
    const r = await checkOddsApiKey(typed(ODDS_KEY))
    expect(r.status).toBe("ok")
    expect(r.message).toBe("The Odds API accepted this key. 487 requests left this month, 13 used.")
    expect(r).toMatchObject({ feed: "theoddsapi", source: "settings", remaining: 487, used: 13, period: "month" })
    expect(r.sent).toBe('32 characters, ending in "cdef"')
    // One request, to the listing the vendor does not bill.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}`)
  })

  it("still says accepted when the feed does not report a quota", async () => {
    stubFeed(() => json([]))
    const r = await checkOddsApiKey(typed(ODDS_KEY))
    expect(r.status).toBe("ok")
    expect(r.message).toBe("The Odds API accepted this key.")
    expect(r.remaining).toBeNull()
  })

  it("names the key the feed refused, in the feed's own words", async () => {
    stubFeed(() =>
      json({ message: "API key is not valid. Get an API key at https://the-odds-api.com", error_code: "INVALID_KEY" }, 401),
    )
    const r = await checkOddsApiKey(typed(ODDS_KEY))
    expect(r.status).toBe("rejected")
    expect(r.message).toBe(
      'The Odds API does not recognise this key (32 characters, ending in "cdef"). It said: "API key is not valid. Get an API key at https://the-odds-api.com" Hold that ending against the key on your the-odds-api.com account.',
    )
    // Described, never returned.
    expect(JSON.stringify(r)).not.toContain(ODDS_KEY)
  })

  it("says when a refused key is not the shape of an Odds API key at all", async () => {
    stubFeed(() => json({ message: "API key is not valid.", error_code: "INVALID_KEY" }, 401))
    // Two keys run together: the paste that used to go in after the old key.
    const r = await checkOddsApiKey(typed(ODDS_KEY + ODDS_KEY))
    expect(r.status).toBe("rejected")
    expect(r.message).toContain('this key (64 characters, ending in "cdef")')
    expect(r.message).toContain("An Odds API key is 32 characters, each 0-9 or a-f, and this is not that shape")
  })

  it("describes nothing about a key the server holds, and sends the reader to the server", async () => {
    stubFeed(() => json({ message: "API key is not valid.", error_code: "INVALID_KEY" }, 401))
    const r = await checkOddsApiKey(held(ODDS_KEY, "ODDS_API_KEY"))
    expect(r.status).toBe("rejected")
    expect(r.source).toBe("environment")
    expect(r.sent).toBeNull()
    expect(r.message).toContain("The Odds API does not recognise the key in ODDS_API_KEY.")
    expect(r.message).toContain("This server sends ODDS_API_KEY instead of anything typed here")
    expect(JSON.stringify(r)).not.toContain("cdef")
  })

  it("says so when the server's own key is the one that was accepted", async () => {
    stubFeed(() => json([], 200, { "x-requests-remaining": "500", "x-requests-used": "0" }))
    const r = await checkOddsApiKey(held(ODDS_KEY, "ODDS_API_KEY"))
    expect(r.message).toBe(
      "The Odds API accepted the key in ODDS_API_KEY, which this server sends on every pull. 500 requests left this month, 0 used.",
    )
  })

  it("tells a used-up month from a bad key, though both come back 401", async () => {
    stubFeed(() => json({ message: "Usage quota has been reached.", error_code: "OUT_OF_USAGE_CREDITS" }, 401))
    const r = await checkOddsApiKey(typed(ODDS_KEY))
    expect(r.status).toBe("quota")
    expect(r.message).toContain("its requests are used up for this period")
    expect(r.message).toContain("Another key from the same account will not help")
  })

  it("does not blame the key for a feed that could not be reached, or that timed out", async () => {
    stubFeed(() => {
      throw new TypeError("fetch failed")
    })
    const down = await checkOddsApiKey(typed(ODDS_KEY))
    expect(down.status).toBe("unreachable")
    expect(down.message).toBe(
      "Could not reach The Odds API. Check the internet connection and try again. That is the connection, not a verdict on the key.",
    )

    stubFeed(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    })
    const slow = await checkOddsApiKey(typed(ODDS_KEY))
    expect(slow.status).toBe("unreachable")
    expect(slow.message).toContain("The Odds API did not answer in time.")
  })

  it("does not blame the key for an outage either", async () => {
    stubFeed(() => new Response("Bad gateway", { status: 502 }))
    const r = await checkOddsApiKey(typed(ODDS_KEY))
    expect(r.status).toBe("error")
    expect(r.message).toBe("The Odds API returned 502. Bad gateway That says nothing about the key itself; try again in a minute.")
  })

  it("asks nothing when there is no key", async () => {
    const calls = stubFeed(() => json([]))
    const r = await checkOddsApiKey(null)
    expect(r.status).toBe("missing")
    expect(r.source).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe("asking PropLine about a key", () => {
  const label = "Settings → Odds feed → PropLine key"
  const DAILY = { "X-Daily-Limit": "1000", "X-Daily-Used": "16", "X-Daily-Remaining": "984" }

  it("says a key was accepted, from the listing a pull starts with, with the key in a header", async () => {
    const calls = stubFeed(() => json([{ id: 1 }, { id: 2 }, { id: 3 }], 200, DAILY))
    const r = await checkProplineKey(typed(PROPLINE_KEY, label), "nba")
    expect(r.status).toBe("ok")
    expect(r.message).toBe("PropLine accepted this key. 984 of 1,000 requests left today. It lists 3 upcoming NBA games.")
    expect(r).toMatchObject({ feed: "propline", remaining: 984, used: 16, period: "day" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://api.prop-line.com/v1/sports/basketball_nba/events")
    // In the header, so it never sits in a URL that might be logged.
    expect(calls[0].url).not.toContain(PROPLINE_KEY)
    expect((calls[0].init?.headers as Record<string, string>)["X-API-Key"]).toBe(PROPLINE_KEY)
  })

  it("asks for the league that is on Today", async () => {
    const calls = stubFeed(() => json([{ id: 1 }], 200, DAILY))
    const r = await checkProplineKey(typed(PROPLINE_KEY, label), "nfl")
    expect(calls[0].url).toBe("https://api.prop-line.com/v1/sports/football_nfl/events")
    expect(r.message).toContain("It lists 1 upcoming NFL game.")
  })

  it("names the key PropLine refused, reading its structured error", async () => {
    stubFeed(() =>
      json({ detail: { error: "invalid_api_key", message: "Invalid API key.", signup_url: "https://prop-line.com/" } }, 401),
    )
    const r = await checkProplineKey(typed(PROPLINE_KEY, label), "nba")
    expect(r.status).toBe("rejected")
    expect(r.message).toBe(
      'PropLine does not recognise this key (36 characters, ending in "4026"). It said: "Invalid API key." Hold that ending against the key on your prop-line.com account.',
    )
    expect(JSON.stringify(r)).not.toContain(PROPLINE_KEY)
  })

  it("says when the key PropLine refused looks like the other feed's", async () => {
    stubFeed(() => json({ detail: { error: "invalid_api_key", message: "Invalid API key." } }, 401))
    const r = await checkProplineKey(typed(ODDS_KEY, label), "nba")
    expect(r.status).toBe("rejected")
    expect(r.message).toContain("It has the shape of an Odds API key, so the two keys may be in each other's fields.")
  })

  it("tells a used-up day from a bad key", async () => {
    stubFeed(() => json({ detail: { error: "daily_limit_exceeded", message: "Daily limit reached." } }, 429))
    const r = await checkProplineKey(typed(PROPLINE_KEY, label), "nba")
    expect(r.status).toBe("quota")
    expect(r.message).toContain("today's requests are used up. They reset at 00:00 UTC")
  })

  it("does not call a burst limit a used-up day, or a refused key", async () => {
    stubFeed(() => json({ detail: { error: "burst_limit_exceeded", message: "Slow down." } }, 429))
    const r = await checkProplineKey(typed(PROPLINE_KEY, label), "nba")
    expect(r.status).toBe("error")
    expect(r.message).toContain("PropLine is limiting requests.")
    expect(r.message).toContain("That says nothing about the key itself.")
  })

  it("does not blame the key when PropLine cannot be reached", async () => {
    stubFeed(() => {
      throw new TypeError("fetch failed")
    })
    const r = await checkProplineKey(typed(PROPLINE_KEY, label), "nba")
    expect(r.status).toBe("unreachable")
    expect(r.message).toContain("Could not reach PropLine.")
  })
})

describe("PropLine's quota headers", () => {
  it("reads its own daily headers first", () => {
    const h = new Headers({
      "X-Daily-Limit": "1000",
      "X-Daily-Used": "13",
      "X-Daily-Remaining": "987",
      "RateLimit-Limit": "60",
      "RateLimit-Remaining": "59",
    })
    expect(proplineQuota(h)).toEqual({ limit: 1000, used: 13, remaining: 987 })
  })

  it("falls back to the standard rate-limit headers when those are all it sent", () => {
    expect(proplineQuota(new Headers({ "RateLimit-Limit": "1000", "RateLimit-Remaining": "984" }))).toEqual({
      limit: 1000,
      used: 16,
      remaining: 984,
    })
    expect(proplineQuota(new Headers({ "X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "1000" }))).toEqual({
      limit: 1000,
      used: 0,
      remaining: 1000,
    })
  })

  it("says nothing when a limit arrives with no count of what is left", () => {
    // What an unauthenticated response carries: a limit and nothing else.
    expect(proplineQuota(new Headers({ "RateLimit-Limit": "1000", "X-RateLimit-Limit": "1000" }))).toBeNull()
    expect(proplineQuota(new Headers())).toBeNull()
  })
})

describe("POST /api/keys/check", () => {
  const post = (body: object, headers: Record<string, string> = {}) =>
    new Request("http://t/api/keys/check", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  const check = async (body: object, headers?: Record<string, string>) => {
    const { POST } = await import("@/app/api/keys/check/route")
    return POST(post(body, headers))
  }

  it("answers about the key from Settings, cleaned the way a pull cleans it", async () => {
    const calls = stubFeed(() => json([], 200, { "x-requests-remaining": "500", "x-requests-used": "0" }))
    const res = await check({ feed: "theoddsapi", apiKey: `  API Key ${ODDS_KEY}\n` })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.sent).toBe('32 characters, ending in "cdef"')
    expect(calls[0].url).toBe(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}`)
  })

  it("answers about the server's own key when it has one, since that is the one a pull sends", async () => {
    vi.stubEnv("ODDS_API_KEY", "ffffffffffffffffffffffffffffffff")
    const calls = stubFeed(() => json({ message: "API key is not valid.", error_code: "INVALID_KEY" }, 401))
    const res = await check({ feed: "theoddsapi", apiKey: ODDS_KEY })
    const text = await res.text()
    const body = JSON.parse(text)
    expect(calls[0].url).toContain("apiKey=ffffffffffffffffffffffffffffffff")
    expect(body).toMatchObject({ status: "rejected", source: "environment", sent: null })
    // Not one character of either key comes back.
    expect(text).not.toContain("ffff")
    expect(text).not.toContain(ODDS_KEY)
  })

  it("asks PropLine with its own key and never the Odds API one", async () => {
    const calls = stubFeed(() => json([], 200))
    const res = await check({ feed: "propline", proplineKey: PROPLINE_KEY, apiKey: ODDS_KEY, league: "nfl" })
    const body = await res.json()
    expect(body).toMatchObject({ feed: "propline", status: "ok" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://api.prop-line.com/v1/sports/football_nfl/events")
    expect((calls[0].init?.headers as Record<string, string>)["X-API-Key"]).toBe(PROPLINE_KEY)
  })

  it("reports no key rather than asking the feed with nothing", async () => {
    const calls = stubFeed(() => json([]))
    const body = await (await check({ feed: "propline" })).json()
    expect(body.status).toBe("missing")
    expect(calls).toHaveLength(0)
  })

  it("refuses a feed it does not know, and a request from another site", async () => {
    const calls = stubFeed(() => json([]))
    expect((await check({ feed: "pinnacle", apiKey: ODDS_KEY })).status).toBe(400)
    expect((await check({ feed: "theoddsapi", apiKey: ODDS_KEY }, { "sec-fetch-site": "cross-site" })).status).toBe(403)
    expect((await check({ feed: "theoddsapi", apiKey: ODDS_KEY }, { origin: "https://evil.example", host: "t" })).status).toBe(403)
    // Nothing reached the feed for any of them.
    expect(calls).toHaveLength(0)
  })
})

describe("reading the check's answer on the page", () => {
  it("reads a well-formed answer and nothing else", () => {
    const ok = { feed: "propline", status: "ok", message: "PropLine accepted this key.", source: "settings", sent: "36 characters", remaining: 984, used: 16, period: "day" }
    expect(parseKeyCheck(ok)).toEqual(ok)
    expect(parseKeyCheck(null)).toBeNull()
    expect(parseKeyCheck({ error: "Request body was not valid JSON." })).toBeNull()
    expect(parseKeyCheck({ ...ok, feed: "pinnacle" })).toBeNull()
    expect(parseKeyCheck({ ...ok, status: "fine" })).toBeNull()
    // Counts that are not numbers are unknown, not zero.
    expect(parseKeyCheck({ ...ok, remaining: "984", used: null })).toMatchObject({ remaining: null, used: null })
  })
})

describe("a response from this app's server that is not JSON", () => {
  it("is named as an expired sign-in when the host answered with its login page", async () => {
    const page = new Response("<!DOCTYPE html><html><title>Authentication Required</title></html>", { status: 401 })
    await expect(readApiJson(page)).rejects.toThrow(/asked for a sign-in instead of answering \(HTTP 401\)/)
    await expect(
      readApiJson(new Response("<!DOCTYPE html>", { status: 401 })),
    ).rejects.toBeInstanceOf(ApiResponseError)
    expect(describeNonJson(200, "<html>Vercel Authentication</html>")).toContain("sign in again")
  })

  it("is named as the server running out of time", () => {
    expect(describeNonJson(504, "An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT")).toContain(
      "ran out of time before the feed finished answering (HTTP 504)",
    )
  })

  it("is named as a server failure otherwise, never as a parser error", () => {
    expect(describeNonJson(500, "Internal Server Error")).toContain("failed before it could answer (HTTP 500)")
    expect(describeNonJson(200, "<html></html>")).toContain("was not data (HTTP 200)")
  })

  it("passes JSON through whatever the status, because the routes report their own failures in it", async () => {
    expect(await readApiJson(json({ error: "No PropLine key." }, 400))).toEqual({ error: "No PropLine key." })
    expect(await readApiJson(json({ quotes: [] }))).toEqual({ quotes: [] })
  })
})
