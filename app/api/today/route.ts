import { NextResponse } from "next/server"
import { crossSiteRejection } from "@/lib/odds-feed/same-origin"
import {
  BLOWOUT_MARGIN,
  estimateCredits,
  eventOddsUrl,
  eventsUrl,
  marketsChosen,
  marketsForCompetition,
  normalizeMany,
  marketCoverageNote,
  rankByDepth,
  sportOddsUrl,
  type DepthRanking,
  type NormalizedQuote,
} from "@/lib/odds-feed/theoddsapi"
import {
  PICKEM_BOOKS,
  narrowedMarketsNote,
  normalizeProplineMany,
  unpricedPickemNote,
  usablePickemLines,
  pickemNoteFor,
  pullPropline,
  FeedKeyError,
  resolveProplineKeySource,
  type PickemLine,
  type ProplineNormalizeResult,
} from "@/lib/odds-feed/propline"
import {
  addCost,
  addFreeCost,
  emptyCost,
  feedErrorText,
  fetchOddsApi,
  noneCouldBePriced,
  notStarted,
  sumCosts,
  type MeasuredCost,
} from "@/lib/odds-feed/http"
import { resolveKey as resolveApiKey, type ResolvedKey } from "@/lib/odds-feed/api-key"
import type { FeedEvent, FeedEventOdds } from "@/lib/odds-feed/types"
import {
  DEFAULT_LEAGUE,
  LEAGUE_IDS,
  competitionsFor,
  creditPlan,
  inSeason,
  isLeagueId,
  leagueFor,
  type LeagueConfig,
  type LeagueId,
  maxGamesFor,
} from "@/lib/leagues"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Today's slate with player prop prices attached, for any supported league.
 *
 * This is the endpoint behind the one-screen experience: it works out which
 * games tip today in the caller's own timezone, pulls player props for those
 * games only, and hands back normalised quotes.
 *
 * Cost control matters more here than anywhere else in the app. Player props
 * are billed per market per event, so a careless call across every market and
 * every game will empty a monthly quota in a handful of refreshes. The defaults
 * are four markets, and the response reports what the call cost and what is
 * left.
 *
 * Two feeds can price the slate. The Odds API bills per market per game against
 * a monthly quota. PropLine bills per request against a daily one, and its
 * payload also carries the pick'em apps' own lines, which are split out and
 * returned separately: they say what the apps offer, never what a pick is worth.
 */

interface RequestBody {
  apiKey?: string
  /** "theoddsapi" (default) or "propline": which feed prices the slate. */
  provider?: string
  proplineKey?: string
  /** Also pull the pick'em apps' lines from PropLine when The Odds API prices the slate. */
  pickemLines?: boolean
  /** Which league to pull. Defaults to the NBA. */
  league?: string
  /**
   * Pull this league's companion competitions too (college football inside the
   * NFL section). Off unless asked for: a companion costs credits.
   */
  companions?: boolean
  /** ISO instant for the start of the caller's local day. */
  from?: string
  /** ISO instant for the end of the window. */
  to?: string
  markets?: string[]
  bookmakers?: string[]
  regions?: string
  /** Safety valve so one call cannot burn an entire quota. */
  maxGames?: number
  /** Return the game list only, which costs nothing. */
  eventsOnly?: boolean
}

/** The Odds API key and where it came from, so a refusal can say which key it was. */
function resolveKey(body: RequestBody): ResolvedKey | null {
  return resolveApiKey(process.env.ODDS_API_KEY, body.apiKey, {
    env: "ODDS_API_KEY",
    settings: "Settings \u2192 Odds feed \u2192 The Odds API key",
  })
}

/** The empty-slate note, naming games that were skipped for having started. */
function emptyNote(leagueId: LeagueId, started: number, companions: boolean): string {
  // A section that pulled a companion has nothing only when both are empty, so
  // the note names both rather than blaming the parent league alone.
  const label = competitionsFor(leagueId, { companions }).map((l) => l.label).join(" or ")
  if (started > 0) {
    return `${started === 1 ? "The only" : `All ${started}`} ${label} game${started === 1 ? "" : "s"} in this window ${started === 1 ? "has" : "have"} already started. Live games are not priced: their lines move with the score and the pick'em apps have closed them.`
  }
  return inSeason(leagueId, new Date(), { companions })
    ? `No ${label} games tip in this window.`
    : `No ${label} games tip in this window, and ${label} is out of season right now, so an empty slate is expected rather than a fault.`
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

  const provider = body.provider === "propline" ? "propline" : "theoddsapi"
  const proplineKeySource = resolveProplineKeySource(body.proplineKey)
  const proplineKey = proplineKeySource?.key ?? null
  const apiKeySource = resolveKey(body)
  const apiKey = apiKeySource?.key ?? null

  if (provider === "propline" && !proplineKey) {
    return NextResponse.json(
      {
        error:
          "No PropLine key. Add one in Settings, or set PROPLINE_API_KEY in a .env.local file, or switch the provider back to The Odds API.",
        needsKey: true,
      },
      { status: 400 },
    )
  }
  if (provider === "theoddsapi" && !apiKey) {
    return NextResponse.json(
      {
        error:
          "No odds API key. Add one in Settings, or set ODDS_API_KEY in a .env.local file. Without a sportsbook price there is nothing to compare a line against, so the app will not guess.",
        needsKey: true,
      },
      { status: 400 },
    )
  }
  const leagueId = isLeagueId(body.league) ? body.league : DEFAULT_LEAGUE
  const league = leagueFor(leagueId)
  // Opt-in, and only where there is something to opt into.
  const companions = !!body.companions && (league.companions?.length ?? 0) > 0

  // Each league's defaults come from its own config: the markets it actually
  // posts, the books that price it, and a game cap sized to its slate. A market
  // list from settings is kept only where it fits the league's sport, and a
  // companion always uses its own list. Resolved per competition below.
  const bookmakers = body.bookmakers?.length ? body.bookmakers : league.books
  const regions = body.regions || "us,us2,eu"
  // The league default is feed-aware: a game costs a whole market list on The
  // Odds API and a single request on PropLine, so the two feeds do not want
  // the same cap. An explicit cap from the body still wins.
  const maxGames = Math.max(
    1,
    Math.min(body.maxGames ?? maxGamesFor(league, { billsPerRequest: provider === "propline" }), 20),
  )

  // Default window: from now to 30 hours out, which covers a whole slate
  // regardless of the caller's timezone.
  const now = Date.now()
  const fromMs = body.from ? Date.parse(body.from) : now
  const toMs = body.to ? Date.parse(body.to) : fromMs + 30 * 3600 * 1000

  if (provider === "propline") {
    return fromPropline({
      apiKey: proplineKey!,
      keySource: proplineKeySource,
      oddsApiKeyAvailable: apiKey != null,
      leagueId,
      markets: body.markets ?? null,
      maxGames,
      fromMs,
      toMs,
      now,
      companions,
      eventsOnly: !!body.eventsOnly,
    })
  }

  try {
    // One press can cover more than one competition: college football is
    // pulled and priced inside the NFL section. Each is listed, capped and
    // billed separately, then merged into one slate.
    const pulls: CompetitionPull[] = []
    const competitionFailures: { eventId: string; matchup: string; error: string }[] = []
    for (const comp of competitionsFor(leagueId, { companions })) {
      try {
        pulls.push(
          await pullCompetition(apiKeySource!, comp, {
          // The league's own cap is the dial on the Today screen; a companion
          // keeps the cap sized to its own slate, because a Saturday lists
          // fifty college games and only a handful carry real prop pricing.
          maxGames: comp.id === leagueId ? maxGames : maxGamesFor(comp),
          markets: marketsForCompetition(comp, body.markets),
          regions,
          bookmakers,
          fromMs,
          toMs,
          now,
            eventsOnly: !!body.eventsOnly,
          }),
        )
      } catch (err) {
        // The league is pulled first and its per-event odds are billed as they
        // go, so letting a companion's listing throw past here would return a
        // 502 with no quotes and bin a slate that has already been paid for.
        // A competition that cannot be listed is a failure to report, exactly
        // like a game that cannot be priced.
        competitionFailures.push({
          eventId: comp.id,
          matchup: comp.label,
          error: feedErrorText(err, "The Odds API"),
        })
        // With nothing listed at all there is no slate and no pull to protect.
        if (pulls.length === 0 && comp.id === leagueId) throw err
      }
    }

    const selected = pulls.flatMap((p) => p.selected)
    const upcoming = pulls.flatMap((p) => p.upcoming)
    const started = pulls.reduce((a, p) => a + p.started, 0)
    const cappedOut = pulls.reduce((a, p) => a + p.cappedOut, 0)
    // Billed per market per event, and each competition can be asked for a
    // different market list, so the cost is summed per competition.
    const estimatedCredits = pulls.reduce(
      (a, p) => a + estimateCredits(p.selected.length, p.markets.length) + p.depthCredits,
      0,
    )
    const cost = creditPlan(leagueId, estimatedCredits)
    const remaining = lastFinite(pulls.map((p) => p.remaining))
    const used = lastFinite(pulls.map((p) => p.used))
    // What the feed actually charged, against the estimate for the requests
    // that actually completed. The app has told itself for a long while that
    // it does not know whether an empty market still costs a credit; the
    // answer is in a response header it was throwing away.
    const billed = sumCosts(pulls.map((p) => p.billed))
    const pricedEstimate = pulls.reduce((a, p) => a + p.pricedCredits, 0)
    const measuredCredits = billed.measured > 0 ? billed.credits : null
    const creditNote = creditNoteFor(billed, pricedEstimate)

    if (body.eventsOnly) {
      return NextResponse.json({
        league: leagueId,
        provider,
        events: upcoming,
        selected: selected.length,
        cappedOut,
        startedCount: started,
        estimatedCredits,
        costWarning: cost.message,
        costSevere: cost.severe,
        failures: competitionFailures,
        requestsRemaining: remaining,
        requestsUsed: used,
      })
    }

    if (selected.length === 0) {
      // Distinguish "wrong time of year" from "something is broken". An empty
      // NFL slate on a Wednesday is the schedule; an empty one on a Sunday is a
      // problem worth chasing.
      const note = emptyNote(leagueId, started, companions)
      // The listing is already paid for (it is free), so say when the next game
      // is. "Nothing today, next one Tuesday" is an answer; a blank page is not.
      const next = pulls
        .map((p) => p.nextEvent)
        .filter((e): e is FeedEvent => !!e)
        .sort((a, b) => a.commence_time.localeCompare(b.commence_time))[0]
      return NextResponse.json({
        league: leagueId,
        provider,
        events: [],
        quotes: [],
        estimatedCredits: 0,
        requestsRemaining: remaining,
        requestsUsed: used,
        inSeason: inSeason(leagueId, new Date(), { companions }),
        startedCount: started,
        failures: competitionFailures,
        nextEvent: next
          ? { commence_time: next.commence_time, home_team: next.home_team, away_team: next.away_team }
          : null,
        note,
      })
    }

    const failures = [...competitionFailures, ...pulls.flatMap((p) => p.failures)]
    const priced = pulls.reduce((a, p) => a + p.payloads.length, 0)
    const failed = noneCouldBePriced(selected.length, priced, failures)
    if (failed) {
      return NextResponse.json(
        { error: failed, failures, requestsRemaining: remaining, requestsUsed: used },
        { status: 502 },
      )
    }

    // Each competition's quotes are stamped with it, so the engine prices a
    // college prop with college priors and college plausibility ceilings.
    const normalized = pulls.map((p) => normalizeMany(p.payloads, p.comp.sport, p.comp.id))
    const quotes = normalized.flatMap((n) => n.quotes)
    const unknownMarkets = Array.from(new Set(normalized.flatMap((n) => n.unknownMarkets)))
    const droppedCount = normalized.reduce((a, n) => a + n.dropped.length, 0)

    // The pick'em lines are a bonus on this path: a failure there is reported
    // and never costs the prices already pulled.
    const pickem =
      body.pickemLines && proplineKey
        ? await pickemFromPropline({
            apiKey: proplineKey,
            keySource: proplineKeySource,
            leagueId,
            markets: body.markets ?? null,
            maxGames,
            fromMs,
            toMs,
            now,
            companions,
            pulls,
            quotes,
          })
        : { lines: [] as PickemLine[], appsPosted: [] as string[], note: null, remaining: null }

    return NextResponse.json({
      league: leagueId,
      provider,
      events: selected,
      quotes,
      pickemLines: pickem.lines,
      pickemAppsPosted: pickem.appsPosted,
      pickemNote: pickem.note,
      proplineRemaining: pickem.remaining,
      unknownMarkets,
      droppedCount,
      failures,
      estimatedCredits,
      costWarning: cost.message,
      costSevere: cost.severe,
      cappedOut,
      startedCount: started,
      depthNote: depthNote(pulls),
      // Which of the markets this pull paid for came back with nothing behind
      // them. Billed per market per game here, so a market no book prices is
      // not just a gap on the board, it is credits spent on silence.
      marketsNote:
        pulls
          .map((p) =>
            marketCoverageNote(
              p.markets,
              quotes.filter((q) => (q.competition ?? leagueId) === p.comp.id),
              unknownMarkets,
              p.comp.sport,
              { chosen: marketsChosen(p.comp, body.markets) },
            ),
          )
          .filter(Boolean)
          .join(" ") || null,
      inSeason: inSeason(leagueId, new Date(), { companions }),
      requestsRemaining: remaining,
      requestsUsed: used,
      measuredCredits,
      unmeasuredRequests: billed.unmeasured,
      creditNote,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err) {
    // A refused key is not a feed outage: needsKey sends the screen to
    // Settings instead of inviting a retry that will fail the same way. Still
    // a 502, as on the PropLine path: it was the feed that refused.
    return NextResponse.json(
      { error: feedErrorText(err, "The Odds API"), needsKey: err instanceof FeedKeyError },
      { status: 502 },
    )
  }
}

/**
 * What the measurement said that the estimate did not.
 *
 * Null when there is nothing to add, which is most pulls: a measured cost that
 * matches the estimate needs no sentence, and the figure itself is shown
 * either way. Two cases are worth a sentence.
 *
 * The feed billed LESS than was estimated. The estimate charges for every
 * market asked for; the app has carried an explicit note for a long while
 * saying it is unverified whether a market that returns no data still costs a
 * credit (see UNVERIFIED_EMPTY_MARKET_COST). A pull that was billed less than
 * the markets it asked for is that question answering itself, for this key on
 * this plan on this slate — which is not the vendor's documentation, and is
 * why the constant stays.
 *
 * Some billed request reported no cost at all. Then the total is a floor
 * rather than a sum, and quoting it as a sum would be the app presenting a
 * number it cannot stand behind.
 *
 * The comparison is against the estimate for the requests that COMPLETED. A
 * game that failed was estimated and never billed, so comparing against the
 * full estimate would read one 502 as proof that empty markets are free.
 */
function creditNoteFor(billed: MeasuredCost, pricedEstimate: number): string | null {
  if (billed.unmeasured > 0) {
    return billed.measured > 0
      ? `${billed.unmeasured} of this pull's requests did not report what they cost, so the ${billed.credits} credits measured is a floor rather than the total.`
      : null
  }
  if (billed.measured === 0) return null
  if (billed.credits === pricedEstimate) return null
  if (billed.credits < pricedEstimate) {
    return `The feed billed ${billed.credits} credits for what was estimated at ${pricedEstimate}. Player props are estimated at every market asked for, so being billed less is evidence that a market returning no data is not charged for — on this key and this plan, which is not the same as the vendor documenting it.`
  }
  return `The feed billed ${billed.credits} credits against an estimate of ${pricedEstimate}. The estimate is markets times games at one region, so a higher bill means the bookmaker list is being charged as more than one region. Narrow it in Settings if the quota matters.`
}

/**
 * What the depth ranking did, in a sentence, so a thin board reads as expected
 * rather than broken.
 */
function depthNote(pulls: CompetitionPull[]): string | null {
  const parts: string[] = []
  for (const p of pulls) {
    if (p.depthError) {
      parts.push(`${p.comp.label}: ${p.depthError}`)
      continue
    }
    if (!p.depth) continue
    const listed = p.depth.ranked.length + p.depth.blowouts.length + p.depth.unpriced.length
    const bits = [
      `${p.selected.length} of ${listed} ${p.comp.label} games priced, chosen by how many books price the spread`,
    ]
    if (p.depth.blowouts.length > 0) {
      bits.push(
        `${p.depth.blowouts.length} skipped as likely blowouts (over ${BLOWOUT_MARGIN} points), where the starters a prop is on do not finish`,
      )
    }
    if (p.depth.unpriced.length > 0) {
      bits.push(`${p.depth.unpriced.length} had no spread priced at all, so no book is likely to post props`)
    }
    parts.push(`${bits.join("; ")}.`)
  }
  return parts.length > 0 ? parts.join(" ") : null
}

/** The last number in a list of per-competition readings, ignoring absent ones. */
function lastFinite(values: (number | null)[]): number | null {
  let out: number | null = null
  for (const v of values) if (v != null && Number.isFinite(v)) out = v
  return out
}

interface CompetitionPull {
  comp: LeagueConfig
  markets: string[]
  /** Credits this competition spent on choosing which games to price. */
  depthCredits: number
  /** What the depth ranking found, or null when it was not used or failed. */
  depth: DepthRanking | null
  /** Why the ranking is missing, when it was wanted and did not arrive. */
  depthError: string | null
  /** Games in the window that have not started. */
  upcoming: FeedEvent[]
  /** The games actually priced, after the cap. */
  selected: FeedEvent[]
  started: number
  cappedOut: number
  payloads: FeedEventOdds[]
  failures: { eventId: string; matchup: string; error: string }[]
  nextEvent: FeedEvent | null
  remaining: number | null
  used: number | null
  /** What the feed said it charged for this competition's requests. */
  billed: MeasuredCost
  /**
   * The estimate restricted to the requests that actually completed.
   *
   * This, not the estimate over every SELECTED game, is what the measurement
   * is compared against. A request that failed was estimated and never billed,
   * so comparing against the full estimate would read one 502 on one game as
   * the empty-market question answering itself.
   */
  pricedCredits: number
}

/**
 * List one competition's games in the window and price the ones that fit under
 * the cap. The listing is free; the odds are a credit per market per game.
 */
async function pullCompetition(
  key: ResolvedKey,
  comp: LeagueConfig,
  opts: {
    markets: string[]
    regions: string
    bookmakers: string[]
    fromMs: number
    toMs: number
    now: number
    maxGames: number
    eventsOnly: boolean
  },
): Promise<CompetitionPull> {
  const apiKey = key.key
  const billed = emptyCost()
  const events = await fetchOddsApi<FeedEvent[]>(eventsUrl(apiKey, comp.id), key)
  if (!Array.isArray(events.data)) throw new SyntaxError("events listing is not a list")
  // The listing is documented as free and is not in the estimate either, so a
  // listing that reports no cost is not a hole in the measurement.
  addFreeCost(billed, events.last)
  const listed = events.data
    .filter((e) => {
      const t = Date.parse(e.commence_time)
      return Number.isFinite(t) && t >= opts.fromMs && t <= opts.toMs
    })
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time))
  // The window opens at the caller's midnight, so it holds games already
  // under way. Those are skipped before the cap, so a live game never takes
  // a slot from one that can still be played.
  const upcoming = listed.filter((e) => notStarted(e.commence_time, opts.now))
  let remaining: number | null = events.remaining
  let used: number | null = events.used

  // Which games to spend the cap on. A college Saturday lists fifty and only a
  // few are priced deeply enough to be worth a credit, so start time is the
  // wrong order: one sport-level call for spreads costs a single credit and
  // says who the books are actually pricing. It is an enhancement, never a
  // dependency — if it fails, the slate falls back to start order and says so.
  let depth: DepthRanking | null = null
  let depthError: string | null = null
  let depthCredits = 0
  let ordered = upcoming
  if (comp.depthRanked && !opts.eventsOnly && upcoming.length > opts.maxGames) {
    try {
      const bulk = await fetchOddsApi<FeedEventOdds[]>(
        sportOddsUrl(apiKey, comp.id, { markets: ["spreads"], fromMs: opts.fromMs, toMs: opts.toMs }),
        key,
      )
      depthCredits = 1
      addCost(billed, bulk.last)
      if (bulk.remaining != null) remaining = bulk.remaining
      if (bulk.used != null) used = bulk.used
      depth = rankByDepth(Array.isArray(bulk.data) ? bulk.data : [])
      const rank = new Map(depth.ranked.map((g, i) => [g.id, i]))
      ordered = upcoming
        .filter((e) => rank.has(e.id))
        .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
      // A ranking that excluded everything is a ranking that learnt nothing
      // useful; fall back rather than price an empty slate.
      if (ordered.length === 0) {
        ordered = upcoming
        depthError = "No college game in this window had a spread priced, so the slate is in start order."
      }
    } catch (err) {
      depthError = feedErrorText(err, "The Odds API")
      ordered = upcoming
    }
  }
  const selected = opts.eventsOnly ? [] : ordered.slice(0, opts.maxGames)
  const nextEvent =
    events.data
      .filter((e) => Date.parse(e.commence_time) > opts.toMs)
      .sort((a, b) => a.commence_time.localeCompare(b.commence_time))[0] ?? null

  const payloads: FeedEventOdds[] = []
  const failures: CompetitionPull["failures"] = []

  for (const e of selected) {
    try {
      const r = await fetchOddsApi<FeedEventOdds>(
        eventOddsUrl(apiKey, e.id, {
          markets: opts.markets,
          regions: opts.regions,
          bookmakers: opts.bookmakers,
          league: comp.id,
        }),
        key,
      )
      payloads.push(r.data)
      addCost(billed, r.last)
      if (r.remaining != null) remaining = r.remaining
      if (r.used != null) used = r.used
    } catch (err) {
      failures.push({
        eventId: e.id,
        matchup: `${e.away_team} at ${e.home_team}`,
        error: feedErrorText(err, "The Odds API"),
      })
    }
  }

  return {
    comp,
    markets: opts.markets,
    depthCredits,
    depth,
    depthError,
    upcoming,
    selected,
    started: listed.length - upcoming.length,
    cappedOut: opts.eventsOnly ? 0 : Math.max(0, upcoming.length - selected.length),
    payloads,
    failures,
    nextEvent,
    remaining,
    used,
    billed,
    // payloads, not selected: only the games that came back were billed.
    pricedCredits: estimateCredits(payloads.length, opts.markets.length) + depthCredits,
  }
}

interface PullArgs {
  apiKey: string
  /** Where the PropLine key came from, so a rejected key says where to correct it. */
  keySource?: ResolvedKey | null
  /**
   * Whether an Odds API key is available, so a refused PropLine key can offer
   * the other feed instead of advice that leads nowhere.
   */
  oddsApiKeyAvailable?: boolean
  leagueId: LeagueId
  /** The market list from Settings, or null to follow each competition's own. */
  markets: string[] | null
  maxGames: number
  fromMs: number
  toMs: number
  now: number
  companions: boolean
}

/** The whole slate from PropLine: prices and pick'em lines in the same requests. */
async function fromPropline(args: PullArgs & { eventsOnly: boolean }) {
  try {
    // Every book: PropLine bills per request, not per book, so narrowing the
    // list saves nothing and loses prices. One pull per competition, since the
    // NFL section covers college football too.
    const comps = competitionsFor(args.leagueId, { companions: args.companions })
    const pulls = await Promise.all(
      comps.map(async (comp) => ({
        comp,
        pull: await pullPropline({
          ...args,
          league: comp.id,
          // PropLine bills per request, one per game whatever the market
          // list, so the whole board costs what four markets would — but only
          // if PropLine serves it. The narrower per-market-billed list is the
          // fallback, because asking for a market a feed does not carry must
          // not be able to take the league offline.
          markets: marketsForCompetition(comp, args.markets, { billsPerRequest: true }),
          coreMarkets: marketsForCompetition(comp, args.markets),
          maxGames: comp.id === args.leagueId ? args.maxGames : maxGamesFor(comp, { billsPerRequest: true }),
        }),
      })),
    )
    const pull = {
      inWindow: pulls.flatMap((p) => p.pull.inWindow),
      started: pulls.reduce((a, p) => a + p.pull.started, 0),
      selected: pulls.flatMap((p) => p.pull.selected),
      cappedOut: pulls.reduce((a, p) => a + p.pull.cappedOut, 0),
      nextEvent:
        pulls
          .map((p) => p.pull.nextEvent)
          .filter((e): e is FeedEvent => !!e)
          .sort((a, b) => a.commence_time.localeCompare(b.commence_time))[0] ?? null,
      payloads: pulls.flatMap((p) => p.pull.payloads),
      failures: pulls.flatMap((p) => p.pull.failures),
      quota: pulls.map((p) => p.pull.quota).filter((q) => q != null).pop() ?? null,
      requests: pulls.reduce((a, p) => a + p.pull.requests, 0),
    }
    const cappedOut = pull.cappedOut
    const base = {
      league: args.leagueId,
      provider: "propline" as const,
      // The Odds API's monthly credits are untouched; PropLine counts requests per day.
      estimatedCredits: 0,
      proplineRequests: pull.requests,
      // PropLine bills one request per game against a daily quota and sends no
      // per-request cost, so there is nothing here to measure and the honest
      // answer is to say so rather than to report a zero.
      measuredCredits: null,
      requestsRemaining: pull.quota?.remaining ?? null,
      requestsUsed: pull.quota?.used ?? null,
      quotaPeriod: "day" as const,
      inSeason: inSeason(args.leagueId, new Date(), { companions: args.companions }),
      startedCount: pull.started,
    }

    if (args.eventsOnly) {
      return NextResponse.json({ ...base, events: pull.inWindow, selected: pull.selected.length, cappedOut })
    }

    if (pull.selected.length === 0) {
      const note = emptyNote(args.leagueId, pull.started, args.companions)
      const next = pull.nextEvent
      return NextResponse.json({
        ...base,
        events: [],
        quotes: [],
        pickemLines: [],
        nextEvent: next ? { commence_time: next.commence_time, home_team: next.home_team, away_team: next.away_team } : null,
        note,
      })
    }

    const failed = noneCouldBePriced(pull.selected.length, pull.payloads.length, pull.failures)
    if (failed) return NextResponse.json({ ...base, error: failed, failures: pull.failures }, { status: 502 })

    // Normalised per competition, so each prop carries the one it came from.
    const normalized = mergeProplineResults(
      pulls.map((p) => normalizeProplineMany(p.pull.payloads, p.comp.sport, { competition: p.comp.id })),
    )
    const usable = usablePickemLines(normalized.pickemLines, normalized.quotes)
    return NextResponse.json({
      ...base,
      events: pull.selected,
      quotes: normalized.quotes,
      // The lines something on this slate can read, and a sentence about the
      // ones it cannot: a shorter list with no explanation is indistinguishable
      // from an app posting less.
      pickemLines: usable.lines,
      // Which apps POSTED, counted before the filter. Shedding a line must not
      // change what the page says about which apps turned up; see the third
      // consumer named in usablePickemLines.
      pickemAppsPosted: Array.from(new Set(normalized.pickemLines.map((l) => l.app))).sort(),
      pickemNote:
        [
          pickemNoteFor(normalized.pickemLines.length, pull.failures, normalized.closedGames.length),
          unpricedPickemNote(usable.dropped, { chosen: marketsChosen(leagueFor(args.leagueId), args.markets) }),
        ]
          .filter(Boolean)
          .join(" ") || null,
      // Which markets PropLine refused, if any. Named rather than silently
      // absent: the market list is the one thing the user can change about it.
      marketsNote:
        [
          ...pulls.map((p) => narrowedMarketsNote(p.pull.narrowed)),
          ...pulls.map((p) =>
            marketCoverageNote(
              // The list the slate was priced at: a market PropLine refused
              // is already named in the sentence above, and is not also a
              // market the books declined to price.
              p.pull.narrowed?.to ?? marketsForCompetition(p.comp, args.markets, { billsPerRequest: true }),
              normalized.quotes.filter((q) => (q.competition ?? args.leagueId) === p.comp.id),
              normalized.unknownMarkets,
              p.comp.sport,
              { chosen: marketsChosen(p.comp, args.markets), billsPerRequest: true },
            ),
          ),
        ]
          .filter(Boolean)
          .join(" ") || null,
      unknownMarkets: normalized.unknownMarkets,
      droppedCount: normalized.dropped.length,
      failures: pull.failures,
      cappedOut,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err) {
    // A rejected key is not a feed outage: needsKey sends the screen to
    // Settings instead of inviting a retry that will fail the same way. The
    // status stays 502: it was this server's credential PropLine refused, not
    // the caller's, so a 401 would say the wrong party is unauthenticated.
    // Where PropLine is PRICING the slate, a refused key means nothing was
    // pulled at all, and the message that describes the key cannot know that:
    // it is written for the pick'em-lines call too, where the slate survives.
    // So the route, which does know, names the way out -- and only when there
    // is an Odds API key to go back to, since otherwise it is advice that
    // leads nowhere.
    const keyRefused = err instanceof FeedKeyError
    const canFallBack = keyRefused && !!args.oddsApiKeyAvailable
    return NextResponse.json(
      {
        error: [
          feedErrorText(err, "PropLine"),
          keyRefused
            ? "PropLine is pricing the slate, so nothing was pulled."
            : null,
          canFallBack
            ? "Switch the provider back to The Odds API under Settings to price this slate with your Odds API key instead."
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        needsKey: keyRefused,
      },
      { status: 502 },
    )
  }
}

/**
 * Only the pick'em apps' lines, from PropLine, to sit beside The Odds API's
 * prices, for exactly the games The Odds API priced.
 */
async function pickemFromPropline(
  args: PullArgs & { pulls: CompetitionPull[]; quotes: NormalizedQuote[] },
): Promise<{ lines: PickemLine[]; appsPosted: string[]; note: string | null; remaining: number | null }> {
  try {
    // One PropLine pull per competition, each asking only for the games that
    // competition actually priced, and only for the markets it priced. Not the
    // whole board, although PropLine would charge the same for it: a pick'em
    // line for a market no sportsbook priced has no target to attach to and
    // nothing that could price it, so pulling it only fills this browser's
    // storage. Width is worth paying nothing for when PropLine prices the
    // slate itself, which is where it is asked for.
    const results = await Promise.all(
      args.pulls
        .filter((p) => p.selected.length > 0)
        .map(async (p) => {
          const pull = await pullPropline({
            ...args,
            league: p.comp.id,
            markets: p.markets,
            maxGames: p.selected.length,
            games: p.selected,
            bookmakers: PICKEM_BOOKS,
          })
          return {
            comp: p.comp,
            pull,
            normalized: normalizeProplineMany(pull.payloads, p.comp.sport, { competition: p.comp.id }),
            unlisted: p.selected.length - pull.selected.length,
          }
        }),
    )
    const normalized = mergeProplineResults(results.map((r) => r.normalized))
    const failures = results.flatMap((r) => r.pull.failures)
    const usable = usablePickemLines(normalized.pickemLines, args.quotes)
    const unlisted = results.reduce((a, r) => a + r.unlisted, 0)
    // The shed lines are an extra sentence, appended after the existing chain
    // rather than folded into it: a failed request and a closed game are
    // reasons to go and look at something, and they keep their precedence.
    const note =
      [
        pickemNoteFor(normalized.pickemLines.length, failures, normalized.closedGames.length) ??
          (unlisted > 0
            ? `PropLine did not list ${unlisted} of the priced game${unlisted === 1 ? "" : "s"}, so props there are at the books' line.`
            : null),
        unpricedPickemNote(usable.dropped, { chosen: marketsChosen(leagueFor(args.leagueId), args.markets) }),
      ]
        .filter(Boolean)
        .join(" ") || null
    return {
      lines: usable.lines,
      appsPosted: Array.from(new Set(normalized.pickemLines.map((l) => l.app))).sort(),
      note,
      remaining: results.map((r) => r.pull.quota?.remaining).filter((q) => q != null).pop() ?? null,
    }
  } catch (err) {
    // On this path The Odds API priced the slate and PropLine only supplies the
    // pick'em apps' lines, so a refused key here is the PROPLINE key and
    // nothing else. "PropLine rejected the API key" does not say that, and read
    // quickly it says "your key is broken": a real install regenerated its Odds
    // API key twice in answer to it, which cannot help, because the two keys
    // never cross. So a refused key names which key it is, says the slate is
    // untouched, and gives both ways out. Other failures -- a rate limit, an
    // outage -- are not about the key and keep PropLine's sentence alone.
    const which =
      err instanceof FeedKeyError
        ? " This is the PropLine key, not your Odds API key: the slate's prices come from The Odds API and are unaffected. Replace the PropLine key under Settings → Odds feed, or switch off \"Pick'em apps' own lines\" there to stop asking PropLine at all."
        : ""
    return {
      lines: [],
      appsPosted: [],
      note: `Pick'em lines unavailable: ${feedErrorText(err, "PropLine")}${which}`,
      remaining: null,
    }
  }
}

/** Fold several PropLine normalisations, one per competition, into one. */
function mergeProplineResults(parts: ProplineNormalizeResult[]): ProplineNormalizeResult {
  return {
    quotes: parts.flatMap((p) => p.quotes),
    unknownMarkets: Array.from(new Set(parts.flatMap((p) => p.unknownMarkets))),
    dropped: parts.flatMap((p) => p.dropped),
    pickemLines: parts.flatMap((p) => p.pickemLines),
    closedGames: parts.flatMap((p) => p.closedGames),
  }
}
