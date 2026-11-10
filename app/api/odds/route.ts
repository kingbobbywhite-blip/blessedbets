import { NextResponse } from "next/server"
import { crossSiteRejection } from "@/lib/odds-feed/same-origin"
import {
  marketsForLeague,
  estimateCredits,
  eventOddsUrl,
  eventsUrl,
  normalizeMany,
} from "@/lib/odds-feed/theoddsapi"
import { FeedKeyError, normalizeProplineMany, pullPropline, resolveProplineKeySource } from "@/lib/odds-feed/propline"
import { resolveKey as resolveApiKey, type ResolvedKey } from "@/lib/odds-feed/api-key"
import { feedErrorText, fetchOddsApi, noneCouldBePriced, notStarted } from "@/lib/odds-feed/http"
import type { FeedEvent, FeedEventOdds } from "@/lib/odds-feed/types"
import { DEFAULT_LEAGUE, LEAGUE_IDS, isLeagueId, leagueFor, maxGamesFor } from "@/lib/leagues"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Server-side proxy for The Odds API.
 *
 * Two reasons this is not called from the browser directly: the feed does not
 * promise CORS headers, and an API key in page JavaScript is a key you have
 * given away. The key is read from ODDS_API_KEY when set, otherwise taken from
 * the request body, which is how the settings screen supplies it on a local
 * install. It is never logged and never returned.
 *
 * With PropLine as the provider the same request goes to PropLine instead
 * (PROPLINE_API_KEY, or the key from Settings), and its pick'em rows are
 * dropped here: this route only attaches prices.
 */

interface RequestBody {
  apiKey?: string
  /** "theoddsapi" (default) or "propline". */
  provider?: string
  proplineKey?: string
  markets?: string[]
  regions?: string
  bookmakers?: string[]
  /** Limit to these event ids. */
  eventIds?: string[]
  /** Return the event list only, without pulling any odds. */
  eventsOnly?: boolean
  /** Which league's feed to query. Defaults to the NBA. */
  league?: string
  /** ISO instant: only games starting at or after this. Defaults to now. */
  from?: string
  /** ISO instant: only games starting at or before this. Defaults to 30 hours after `from`. */
  to?: string
  /** Hard cap on games priced in one call, to protect the feed quota. */
  maxGames?: number
}

/** The Odds API key and where it came from, so a refusal can say which key it was. */
function resolveKey(body: RequestBody): ResolvedKey | null {
  return resolveApiKey(process.env.ODDS_API_KEY, body.apiKey, {
    env: "ODDS_API_KEY",
    settings: "Settings \u2192 Odds feed \u2192 The Odds API key",
  })
}

export async function POST(request: Request) {
  // Before any key is read: another site's page must not spend this server's quota.
  const refused = crossSiteRejection(request)
  if (refused) return refused

  let body: RequestBody
  try {
    body = (await request.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: "Request body was not valid JSON." }, { status: 400 })
  }

  if (body.league != null && !isLeagueId(body.league)) {
    return NextResponse.json(
      { error: `Unsupported league "${body.league}". Supported: ${LEAGUE_IDS.join(", ")}.` },
      { status: 400 },
    )
  }

  const usePropline = body.provider === "propline"
  const proplineKeySource = usePropline ? resolveProplineKeySource(body.proplineKey) : null
  const proplineKey = proplineKeySource?.key ?? null
  const apiKeySource = usePropline ? null : resolveKey(body)
  const apiKey = apiKeySource?.key ?? null
  if (usePropline && !proplineKey) {
    return NextResponse.json(
      { error: "No PropLine key. Add one in Settings, or set PROPLINE_API_KEY in the environment." },
      { status: 400 },
    )
  }
  if (!usePropline && !apiKey) {
    return NextResponse.json(
      { error: "No odds API key. Add one in Settings, or set ODDS_API_KEY in the environment." },
      { status: 400 },
    )
  }
  const leagueId = isLeagueId(body.league) ? body.league : DEFAULT_LEAGUE
  const league = leagueFor(leagueId)

  const markets = marketsForLeague(leagueId, body.markets)
  const regions = body.regions || "us,us2,eu"
  // Feed-aware default: a game costs a market list on The Odds API and one
  // request on PropLine. An explicit cap from the body still wins.
  const maxGames = Math.max(1, Math.min(body.maxGames ?? maxGamesFor(league, { billsPerRequest: usePropline }), 20))

  // Only today's games. Without a window this used to price every event the
  // feed listed, which during the season is weeks of games, and props are
  // billed per market per game: one press could spend a month's free quota.
  const now = Date.now()
  const fromMs = body.from ? Date.parse(body.from) : now
  const toMs = body.to ? Date.parse(body.to) : fromMs + 30 * 3600 * 1000

  if (usePropline) {
    try {
      const pull = await pullPropline({
        apiKey: proplineKey!,
        keySource: proplineKeySource,
        league: leagueId,
        fromMs,
        toMs,
        markets,
        maxGames,
        eventIds: body.eventIds,
        eventsOnly: body.eventsOnly,
        now,
      })
      const cappedOut = pull.cappedOut
      if (body.eventsOnly) {
        return NextResponse.json({
          league: leagueId,
          cappedOut,
          startedCount: pull.started,
          events: pull.selected,
          estimatedCredits: 0,
          requestsRemaining: pull.quota?.remaining ?? null,
          requestsUsed: pull.quota?.used ?? null,
        })
      }
      const failed = noneCouldBePriced(pull.selected.length, pull.payloads.length, pull.failures)
      if (failed) {
        return NextResponse.json(
          {
            error: failed,
            failures: pull.failures,
            requestsRemaining: pull.quota?.remaining ?? null,
            requestsUsed: pull.quota?.used ?? null,
          },
          { status: 502 },
        )
      }
      const normalized = normalizeProplineMany(pull.payloads, league.sport)
      return NextResponse.json({
        league: leagueId,
        cappedOut,
        startedCount: pull.started,
        events: pull.selected,
        quotes: normalized.quotes,
        unknownMarkets: normalized.unknownMarkets,
        dropped: normalized.dropped.slice(0, 50),
        droppedCount: normalized.dropped.length,
        failures: pull.failures,
        requestsRemaining: pull.quota?.remaining ?? null,
        requestsUsed: pull.quota?.used ?? null,
      })
    } catch (err) {
      // A rejected key is not a feed outage: send the screen to Settings
    // instead of inviting a retry that will fail the same way.
    return NextResponse.json(
      { error: feedErrorText(err, "PropLine"), needsKey: err instanceof FeedKeyError },
      { status: 502 },
    )
    }
  }

  try {
    const events = await fetchOddsApi<FeedEvent[]>(eventsUrl(apiKey!, leagueId), apiKeySource)
    if (!Array.isArray(events.data)) throw new SyntaxError("events listing is not a list")
    const listed = events.data
      .filter((e) => {
        const t = Date.parse(e.commence_time)
        return Number.isFinite(t) && t >= fromMs && t <= toMs
      })
      .sort((a, b) => a.commence_time.localeCompare(b.commence_time))
    // A game under way is priced live and its pick'em lines are closed, so it
    // is skipped before the cap rather than spending a slot and quota.
    const inWindow = listed.filter((e) => notStarted(e.commence_time, now))
    const started = listed.length - inWindow.length
    const chosen = body.eventIds?.length ? inWindow.filter((e) => body.eventIds!.includes(e.id)) : inWindow
    const wanted = chosen.slice(0, maxGames)
    const cappedOut = chosen.length - wanted.length

    if (body.eventsOnly) {
      return NextResponse.json({
        league: leagueId,
        cappedOut,
        startedCount: started,
        events: wanted,
        estimatedCredits: estimateCredits(wanted.length, markets.length),
        requestsRemaining: events.remaining,
        requestsUsed: events.used,
      })
    }

    // Player props are billed per market per event, so this loop is the
    // expensive part of the whole app. The client is expected to narrow the
    // event list and the market list before calling.
    const payloads: FeedEventOdds[] = []
    const failures: { eventId: string; error: string }[] = []
    let remaining: number | null = events.remaining
    let used: number | null = events.used

    for (const e of wanted) {
      try {
        const r = await fetchOddsApi<FeedEventOdds>(
          eventOddsUrl(apiKey!, e.id, { markets, regions, bookmakers: body.bookmakers, league: leagueId }),
          apiKeySource,
        )
        payloads.push(r.data)
        if (r.remaining != null) remaining = r.remaining
        if (r.used != null) used = r.used
      } catch (err) {
        failures.push({ eventId: e.id, error: feedErrorText(err, "The Odds API") })
      }
    }

    const failed = noneCouldBePriced(wanted.length, payloads.length, failures)
    if (failed) {
      return NextResponse.json(
        { error: failed, failures, requestsRemaining: remaining, requestsUsed: used },
        { status: 502 },
      )
    }

    const normalized = normalizeMany(payloads, league.sport)

    return NextResponse.json({
      league: leagueId,
      cappedOut,
      startedCount: started,
      events: wanted,
      quotes: normalized.quotes,
      unknownMarkets: normalized.unknownMarkets,
      dropped: normalized.dropped.slice(0, 50),
      droppedCount: normalized.dropped.length,
      failures,
      requestsRemaining: remaining,
      requestsUsed: used,
    })
  } catch (err) {
    // As on the PropLine path above: a refused key sends the screen to Settings.
    return NextResponse.json(
      { error: feedErrorText(err, "The Odds API"), needsKey: err instanceof FeedKeyError },
      { status: 502 },
    )
  }
}
