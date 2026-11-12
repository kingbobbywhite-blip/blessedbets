import { MARKETS, marketSport, type MarketKey, type Sport } from "@/lib/nba/markets"
import { DEFAULT_LEAGUE, leagueFor, type LeagueConfig, type LeagueId } from "@/lib/leagues"
import { normalizeName } from "@/lib/quant/correlation"
import { sameGameId } from "./games"
import type { BookQuote } from "@/lib/quant/projection"
import type { FeedEventOdds } from "./types"

/**
 * The Odds API adapter.
 *
 * This is the half of the pipeline that carries the signal. A DFS board tells
 * you what is on offer; a sportsbook price tells you what it is worth. Without
 * the second half the app has nothing to compare against and correctly refuses
 * to price anything.
 *
 * The feed is a paid product. That is the deal: the sportsbook side is the part
 * worth paying for, and scraping the DFS apps instead is both against their
 * terms and the half that carries no information.
 */

export const NBA_SPORT_KEY = "basketball_nba"

/**
 * Feed market keys the API exposes per league.
 *
 * The map below covers every basketball and NFL market we model; the hockey
 * keys have their own map further down. Which of these a given league
 * actually posts is a league question, answered in lib/leagues, because asking
 * for a market a league never posts may cost a credit and return nothing. See
 * UNVERIFIED_EMPTY_MARKET_COST below before leaning on that.
 */

/**
 * UNVERIFIED: does a market that comes back empty cost a credit?
 *
 * This app has told users for a while that it does, and that claim is not
 * established. Two independent transcriptions of The Odds API docs give the
 * per-event cost as "[number of unique markets RETURNED] x [number of
 * regions]", and one worked example says a request for five markets where only
 * two carry data costs two. If that is right, asking a thin college game for
 * four markets and getting two back costs two, and trimming a market list
 * saves nothing in credits at all.
 *
 * It could not be confirmed against the vendor's own documentation, which this
 * environment cannot reach: the egress policy answers 403 for that host, and
 * routing around a policy denial is not on. What IS confirmed, from the
 * vendor's own sample code, is the SHAPE of the cost — markets x regions, with
 * no per-event term on the sport-level endpoint, which is what makes the depth
 * ranking below affordable.
 *
 * The app now MEASURES it rather than speculating: every per-event request's
 * x-requests-last is read and summed, and the Today screen says so when the
 * feed bills less than the estimate, which is this question answering itself.
 * That answer is for one key on one plan on one slate, which is not the same
 * as the vendor documenting it, so this constant stays until the docs do. No
 * decision in the app rests on it either way: market lists are trimmed because
 * an unpriced prop is a worse board, and that is true whatever the billing
 * turns out to be.
 */
export const UNVERIFIED_EMPTY_MARKET_COST =
  "Whether a market that returns no data still costs a credit is unverified: the docs are transcribed both ways."

/** Feed market keys mapped to our own taxonomy. */
export const FEED_MARKET_MAP: Record<string, MarketKey> = {
  player_points: "PTS",
  player_rebounds: "REB",
  player_assists: "AST",
  player_threes: "3PM",
  player_blocks: "BLK",
  player_steals: "STL",
  player_turnovers: "TOV",
  player_points_rebounds_assists: "PRA",
  player_points_rebounds: "PR",
  player_points_assists: "PA",
  player_rebounds_assists: "RA",
  player_blocks_steals: "STL_BLK",
  player_field_goals: "FGM",
  player_frees_made: "FTM",
  // NFL. Only over/under markets: anytime and first touchdown are yes/no
  // prices with no line, which this pipeline does not model.
  player_pass_yds: "PASS_YDS",
  player_pass_tds: "PASS_TDS",
  player_pass_completions: "PASS_COMP",
  player_pass_attempts: "PASS_ATT",
  player_pass_interceptions: "PASS_INT",
  player_rush_yds: "RUSH_YDS",
  player_rush_attempts: "RUSH_ATT",
  player_receptions: "REC",
  player_reception_yds: "REC_YDS",
  player_rush_reception_yds: "RUSH_REC_YDS",
}

export const DEFAULT_FEED_MARKETS = Object.keys(FEED_MARKET_MAP)

/**
 * NHL feed markets, kept for reading rather than for pulling.
 *
 * No league Today prices is hockey any more (see RETIRED_LEAGUES), so nothing
 * requests these. They stay because a stored or imported payload can still
 * name them, and because feedKeyFor has to answer for a hockey market on a
 * logged entry. Several share a key with basketball ("player_points",
 * "player_assists", "player_blocked_shots") but mean a different stat with a
 * different spread, so hockey has its own map rather than entries in the one
 * above.
 */
export const HOCKEY_FEED_MARKET_MAP: Record<string, MarketKey> = {
  player_shots_on_goal: "SOG",
  player_total_saves: "SAVES",
  // PropLine's key for the same market. Listed after the Odds API key so
  // feedKeyFor("SAVES") still answers with the one that feed understands.
  goalie_saves: "SAVES",
  player_points: "HKY_PTS",
  player_assists: "HKY_AST",
  player_goals: "HKY_GOALS",
  player_blocked_shots: "HKY_BLK",
  player_power_play_points: "HKY_PPP",
}

/** Our market for a feed key, in a sport. Unknown keys come back null. */
export function feedMarketFor(key: string, sport?: Sport): MarketKey | null {
  if (sport === "hockey") return HOCKEY_FEED_MARKET_MAP[key] ?? null
  return FEED_MARKET_MAP[key] ?? null
}

/** The sport of a feed sport key: "icehockey_nhl" is hockey. */
export function sportOfFeedKey(sportKey: string | undefined): Sport | undefined {
  if (!sportKey) return undefined
  if (sportKey.startsWith("icehockey")) return "hockey"
  if (sportKey.startsWith("americanfootball")) return "football"
  if (sportKey.startsWith("basketball")) return "basketball"
  return undefined
}

/**
 * The feed markets to request for a league.
 *
 * A requested list is kept only where it belongs to the league's sport, so a
 * basketball market list left in settings never gets billed against an NFL
 * slate (it would come back empty, and may still cost a credit per game: see
 * UNVERIFIED_EMPTY_MARKET_COST). Nothing
 * left, or nothing asked for, means the league's own defaults.
 */
export function marketsForLeague(
  league: LeagueId,
  requested?: string[] | null,
  opts: MarketBreadth = {},
): string[] {
  const config = leagueFor(league)
  const kept = keptForSport(config.sport, requested)
  if (kept.length > 0) return kept
  return opts.billsPerRequest ? (config.deepMarkets ?? config.markets) : config.markets
}

/** The keys of a typed market list that belong to a sport. */
function keptForSport(sport: Sport, requested?: string[] | null): string[] {
  return (requested ?? []).filter((k) => {
    const m = feedMarketFor(k, sport)
    return !!m && marketSport(m) === sport
  })
}

/**
 * True when a competition is asked for the market list typed into Settings,
 * and false when it follows this app's own. Only the first is the user's to
 * trim, so only the first can be the subject of "drop it from Settings".
 */
export function marketsChosen(competition: LeagueConfig, requested?: string[] | null): boolean {
  return !competition.companionOnly && keptForSport(competition.sport, requested).length > 0
}

/**
 * How the feed bills, which is the only thing that decides how wide to ask.
 *
 * The Odds API charges markets x games, so a market list is a budget. PropLine
 * charges one request per game whatever the list, so the same budget buys
 * nothing and every market left out is a pick'em line that could have been
 * read and was not.
 */
export interface MarketBreadth {
  /** True for a feed billed per request rather than per market per game. */
  billsPerRequest?: boolean
}

/**
 * The markets to ask a competition for.
 *
 * A companion always uses its own list and ignores the Markets box in
 * Settings. That box belongs to the league you selected, and the whole reason
 * college football asks for two markets rather than four is that the other two
 * come back empty there: letting a four-market NFL list travel across would
 * quietly undo the saving and bill for the empty responses again.
 */
export function marketsForCompetition(
  competition: LeagueConfig,
  requested?: string[] | null,
  opts: MarketBreadth = {},
): string[] {
  if (competition.companionOnly) {
    return opts.billsPerRequest ? (competition.deepMarkets ?? competition.markets) : competition.markets
  }
  return marketsForLeague(competition.id, requested, opts)
}

/**
 * Which markets a pull asked for and got no sportsbook price back for.
 *
 * The app knew this all along and never said it. A market with no book behind
 * it cannot produce a target, cannot price a pick'em line, and is the one
 * cause of an empty-looking board that the user can actually fix — it is a
 * line in the Markets box. Leaving it unsaid turned a market-list problem into
 * "the app does not work", and turned diagnosing it into reading source.
 *
 * Unknown keys are reported beside them because they look identical from the
 * outside and are not: a market the feed served under a name this app does not
 * map is a mapping bug here, not a gap in the book's coverage, and the fix is
 * the opposite one.
 *
 * And it is said only where somebody can act on it. A list typed into
 * Settings is the user's to trim. This app's own list is not, and on a feed
 * billed per request an empty market costs nothing either, so there the
 * sentence was a warning on every pull with nothing anybody could do about
 * it: a real NBA pull on PropLine told the user to drop field goals and free
 * throws made from a Markets box they had left blank. A market in this app's
 * list that no book prices is this app's bug, and is fixed in the list.
 */
export function marketCoverageNote(
  requested: string[],
  quotes: { market: MarketKey }[],
  unknown: string[] = [],
  sport: Sport = "basketball",
  opts: { chosen?: boolean; billsPerRequest?: boolean } = {},
): string | null {
  const { chosen = true, billsPerRequest = false } = opts
  const priced = new Set(quotes.map((q) => q.market))
  const bare = requested.filter((k) => {
    const m = feedMarketFor(k, sport)
    return m != null && !priced.has(m)
  })
  const parts: string[] = []
  if (bare.length > 0 && (chosen || !billsPerRequest)) {
    const one = bare.length === 1
    const names = bare.map((k) => MARKETS[feedMarketFor(k, sport)!]?.label ?? k)
    // The box takes feed keys, so the action names keys and the sentence
    // before it names markets.
    const rest = requested.filter((k) => !bare.includes(k))
    const action = chosen
      ? ` Drop ${bare.join(", ")} from Settings → Markets unless a book you use posts ${one ? "it" : "them"}.`
      : rest.length > 0
        ? ` Each is billed per game; to stop paying for ${one ? "it" : "them"}, set Settings → Markets to ${rest.join(", ")}.`
        : ""
    parts.push(
      `No sportsbook in this pull priced ${names.join(", ")}, so nothing can be built on ${one ? "that market" : "those markets"}.${action}`,
    )
  }
  if (unknown.length > 0) {
    parts.push(
      `The feed also sent ${unknown.length} market${unknown.length === 1 ? "" : "s"} this app does not recognise and discarded ${unknown.length === 1 ? "it" : "them"}: ${unknown.join(", ")}. That is a gap in this app's market map rather than in the feed's coverage.`,
    )
  }
  return parts.join(" ") || null
}

/** Reverse lookup, used when requesting only the markets on your board. */
export function feedKeyFor(market: MarketKey): string | null {
  for (const [k, v] of Object.entries(FEED_MARKET_MAP)) if (v === market) return k
  for (const [k, v] of Object.entries(HOCKEY_FEED_MARKET_MAP)) if (v === market) return k
  return null
}

export interface NormalizedQuote extends BookQuote {
  player: string
  playerKey: string
  market: MarketKey
  gameId: string
  homeTeam: string
  awayTeam: string
  commenceTime: string
  /**
   * Which competition the quote came from, set when a league's section covers
   * more than one. The pricing engine reads it to pick the right priors.
   */
  competition?: LeagueId
}

export interface NormalizeResult {
  quotes: NormalizedQuote[]
  /** Feed markets present in the payload that we do not model. */
  unknownMarkets: string[]
  /** Outcomes dropped, with the reason, so a silent gap is impossible. */
  dropped: { reason: string; detail: string }[]
}

/**
 * Flatten one event's odds payload into per-book, per-player, per-market quotes.
 *
 * Over and Under arrive as separate outcomes at the same point, so they are
 * paired back up here. An unpaired side is still emitted, because a one-sided
 * price is worth something, but the projection layer marks it as having an
 * assumed rather than measured margin.
 */
export function normalizeEventOdds(event: FeedEventOdds, sport?: Sport, competition?: LeagueId): NormalizeResult {
  // The league asked for decides what "player_points" means; failing that, the payload's own sport.
  const inSport = sport ?? sportOfFeedKey(event.sport_key)
  const quotes: NormalizedQuote[] = []
  const unknownMarkets = new Set<string>()
  const dropped: NormalizeResult["dropped"] = []

  const gameId = `${event.away_team}@${event.home_team}`

  for (const book of event.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      const mapped = feedMarketFor(market.key, inSport)
      if (!mapped) {
        unknownMarkets.add(market.key)
        continue
      }

      // Group outcomes by player and line, then pair over with under.
      const grouped = new Map<string, { player: string; point: number; over?: number; under?: number }>()
      for (const o of market.outcomes ?? []) {
        const player = (o.description ?? "").trim()
        if (!player) {
          dropped.push({ reason: "no player on outcome", detail: `${book.key} ${market.key} ${o.name}` })
          continue
        }
        if (o.point == null || !Number.isFinite(o.point)) {
          dropped.push({ reason: "no line on outcome", detail: `${book.key} ${market.key} ${player}` })
          continue
        }
        if (!Number.isFinite(o.price)) {
          dropped.push({ reason: "no price on outcome", detail: `${book.key} ${market.key} ${player}` })
          continue
        }
        const key = `${normalizeName(player)}|${o.point}`
        const entry = grouped.get(key) ?? { player, point: o.point }
        const side = o.name.trim().toLowerCase()
        if (side === "over") entry.over = o.price
        else if (side === "under") entry.under = o.price
        else {
          dropped.push({ reason: `unexpected outcome name "${o.name}"`, detail: `${book.key} ${market.key} ${player}` })
          continue
        }
        grouped.set(key, entry)
      }

      for (const g of grouped.values()) {
        if (g.over == null && g.under == null) continue
        quotes.push({
          book: book.key,
          line: g.point,
          overOdds: g.over ?? null,
          underOdds: g.under ?? null,
          fetchedAt: market.last_update ?? book.last_update ?? null,
          player: g.player,
          playerKey: normalizeName(g.player),
          market: mapped,
          gameId,
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          commenceTime: event.commence_time,
          competition,
        })
      }
    }
  }

  return { quotes, unknownMarkets: Array.from(unknownMarkets), dropped }
}

export function normalizeMany(events: FeedEventOdds[], sport?: Sport, competition?: LeagueId): NormalizeResult {
  const all: NormalizeResult = { quotes: [], unknownMarkets: [], dropped: [] }
  const unknown = new Set<string>()
  for (const e of events) {
    const r = normalizeEventOdds(e, sport, competition)
    all.quotes.push(...r.quotes)
    all.dropped.push(...r.dropped)
    for (const m of r.unknownMarkets) unknown.add(m)
  }
  all.unknownMarkets = Array.from(unknown)
  return all
}

// ---------------------------------------------------------------------------
// Matching feed quotes onto board props
// ---------------------------------------------------------------------------

export interface MatchTarget {
  player: string
  market: MarketKey | null
}

export interface QuoteIndex {
  /**
   * Prices for a player's market. Given the row's fixture, prices from that
   * fixture win; without one, everything the name returns comes back and
   * `ambiguous` says whether that spans more than one game.
   */
  get(player: string, market: MarketKey | null, gameId?: string | null): NormalizedQuote[]
  /**
   * True when the name and market match prices from more than one game and the
   * row gave nothing to tell them apart. An imported board carries a name and
   * a stat, often with no fixture, so this is the one place the ambiguity
   * cannot be resolved — only reported.
   */
  ambiguous(player: string, market: MarketKey | null, gameId?: string | null): boolean
  size: number
  players: string[]
}

export function indexQuotes(quotes: NormalizedQuote[]): QuoteIndex {
  const byKey = new Map<string, NormalizedQuote[]>()
  for (const q of quotes) {
    const k = `${q.playerKey}|${q.market}`
    const arr = byKey.get(k)
    if (arr) arr.push(q)
    else byKey.set(k, [q])
  }
  const lookup = (player: string, market: MarketKey | null): NormalizedQuote[] => {
    if (!market) return []
    return byKey.get(`${normalizeName(player)}|${market}`) ?? []
  }
  const narrow = (found: NormalizedQuote[], gameId?: string | null): NormalizedQuote[] => {
    if (!gameId) return found
    const same = found.filter((q) => sameGameId(q.gameId, gameId))
    return same.length > 0 ? same : found
  }
  return {
    get(player, market, gameId) {
      return narrow(lookup(player, market), gameId)
    },
    ambiguous(player, market, gameId) {
      const found = narrow(lookup(player, market), gameId)
      return new Set(found.map((q) => q.gameId)).size > 1
    },
    size: quotes.length,
    players: Array.from(new Set(quotes.map((q) => q.playerKey))),
  }
}

export interface AttachResult<T> {
  rows: T[]
  matched: number
  unmatched: { player: string; market: string }[]
  /**
   * Rows whose name and stat matched prices from more than one game, so the
   * prices attached may belong to a different player of the same name. Named
   * rather than guessed at: a wrong price is worse than no price, and this is
   * the whole reason the app refuses to match approximately.
   */
  ambiguous: { player: string; market: string; games: string[] }[]
}

/**
 * Attach feed quotes to slate rows.
 *
 * Matching is on normalised player name plus market. Names that do not match are
 * reported rather than fuzzily guessed: attaching Jalen Williams' price to
 * Jaylin Williams would be worse than leaving the prop unpriced.
 */
export function attachQuotes<
  T extends { player: string; marketKey: MarketKey | null; marketLabel?: string; gameId?: string | null },
>(rows: T[], index: QuoteIndex): AttachResult<T & { quotes: BookQuote[] }> {
  const out: (T & { quotes: BookQuote[] })[] = []
  const unmatched: { player: string; market: string }[] = []
  const ambiguous: AttachResult<T>["ambiguous"] = []
  let matched = 0

  for (const row of rows) {
    const found = index.get(row.player, row.marketKey, row.gameId)
    const market = row.marketLabel ?? String(row.marketKey)
    if (found.length > 0) matched++
    else unmatched.push({ player: row.player, market })
    if (index.ambiguous(row.player, row.marketKey, row.gameId)) {
      ambiguous.push({ player: row.player, market, games: Array.from(new Set(found.map((q) => q.gameId))).sort() })
    }
    out.push({
      ...row,
      quotes: found.map((q) => ({ book: q.book, line: q.line, overOdds: q.overOdds, underOdds: q.underOdds, fetchedAt: q.fetchedAt })),
    })
  }

  return { rows: out, matched, unmatched, ambiguous }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

const BASE = "https://api.the-odds-api.com/v4"

/**
 * The sports listing, which the vendor documents as not counting against the
 * usage quota. It is the request that answers "does the feed accept this key"
 * without spending anything, and it answers the same in and out of season,
 * which a league's own events listing is not promised to.
 */
export function sportsUrl(apiKey: string): string {
  return `${BASE}/sports/?apiKey=${encodeURIComponent(apiKey)}`
}

export function eventsUrl(apiKey: string, league: LeagueId = DEFAULT_LEAGUE): string {
  const sport = leagueFor(league).sportKey
  return `${BASE}/sports/${sport}/events?apiKey=${encodeURIComponent(apiKey)}`
}

export function eventOddsUrl(
  apiKey: string,
  eventId: string,
  opts: { markets: string[]; regions: string; bookmakers?: string[]; league?: LeagueId },
): string {
  const params = new URLSearchParams({
    apiKey,
    regions: opts.regions,
    markets: opts.markets.join(","),
    oddsFormat: "american",
  })
  if (opts.bookmakers && opts.bookmakers.length > 0) params.set("bookmakers", opts.bookmakers.join(","))
  const sport = leagueFor(opts.league ?? DEFAULT_LEAGUE).sportKey
  return `${BASE}/sports/${sport}/events/${encodeURIComponent(eventId)}/odds?${params.toString()}`
}

/**
 * The sport-level odds endpoint: every upcoming game at once, with the books
 * that price the market asked for.
 *
 * Billed per market per region, NOT per event: one market in one region is a
 * single credit whether it returns four games or sixty. That is what makes the
 * depth ranking below affordable, and it is why `regions` is pinned to one
 * here rather than following the app's three-region default, which would make
 * the same call cost three.
 *
 * Verified from the vendor's own sample code — "The usage quota cost =
 * [number of markets specified] x [number of regions specified]", in the
 * comment directly above this endpoint's GET in the-odds-api/samples-python,
 * samples-nodejs and samples-php — rather than from the docs page, which this
 * environment cannot reach. The window parameters do not change the cost but
 * are passed anyway, because without them a Saturday ranking is computed over
 * next week's games too.
 */
export function sportOddsUrl(
  apiKey: string,
  league: LeagueId,
  opts: { markets: string[]; regions?: string; fromMs?: number; toMs?: number },
): string {
  const params = new URLSearchParams({
    apiKey,
    regions: opts.regions ?? DEPTH_REGION,
    markets: opts.markets.join(","),
    oddsFormat: "american",
  })
  if (opts.fromMs != null) params.set("commenceTimeFrom", isoSeconds(opts.fromMs))
  if (opts.toMs != null) params.set("commenceTimeTo", isoSeconds(opts.toMs))
  const sport = leagueFor(league).sportKey
  return `${BASE}/sports/${sport}/odds?${params.toString()}`
}

/** One region, so the ranking call stays a single credit. */
export const DEPTH_REGION = "us"

/** The feed wants whole seconds with no milliseconds. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * How deep a game's market is, read off who prices its spread.
 *
 * A book that cannot be bothered to hang a spread on a game will not be
 * hanging player props on it either, so the number of books pricing the spread
 * is the cheapest available proxy for whether that game's props are worth
 * paying for. It is a proxy and not a measurement: the only direct answer is
 * one credit per game, which defeats the purpose.
 */
export interface GameDepth {
  id: string
  commence_time: string
  home_team: string
  away_team: string
  /** Books pricing the spread. */
  books: number
  /** Consensus spread, as a margin in points. Null when nobody priced one. */
  spread: number | null
}

export interface DepthRanking {
  /** Worth paying for, best first. */
  ranked: GameDepth[]
  /** Skipped: the favourite is so far ahead that the starters will not finish. */
  blowouts: GameDepth[]
  /** Skipped: no book priced the game at all. */
  unpriced: GameDepth[]
}

/**
 * Above this margin a game is not worth pricing props on.
 *
 * A four-touchdown favourite benches the quarterback and the lead back in the
 * fourth quarter, which is exactly where a yardage prop is decided. The number
 * is judgement rather than a fit: 21 is three scores, the point where the
 * second string is a plan rather than an accident.
 */
export const BLOWOUT_MARGIN = 21

export function rankByDepth(events: FeedEventOdds[], opts: { maxMargin?: number } = {}): DepthRanking {
  const maxMargin = opts.maxMargin ?? BLOWOUT_MARGIN
  const measured: GameDepth[] = (events ?? []).map((e) => {
    const margins: number[] = []
    let books = 0
    for (const b of e.bookmakers ?? []) {
      const spreads = (b.markets ?? []).find((m) => m.key === "spreads")
      if (!spreads) continue
      books++
      for (const o of spreads.outcomes ?? []) {
        if (o.point != null && Number.isFinite(o.point)) margins.push(Math.abs(o.point))
      }
    }
    margins.sort((a, b) => a - b)
    return {
      id: String(e.id),
      commence_time: e.commence_time,
      home_team: e.home_team,
      away_team: e.away_team,
      books,
      spread: margins.length > 0 ? margins[Math.floor(margins.length / 2)] : null,
    }
  })

  const unpriced = measured.filter((g) => g.books === 0)
  const priced = measured.filter((g) => g.books > 0)
  const blowouts = priced.filter((g) => g.spread != null && g.spread > maxMargin)
  const ranked = priced
    .filter((g) => !(g.spread != null && g.spread > maxMargin))
    // Most books first, then the closest game, then the earliest.
    .sort(
      (a, b) =>
        b.books - a.books ||
        (a.spread ?? maxMargin) - (b.spread ?? maxMargin) ||
        a.commence_time.localeCompare(b.commence_time),
    )
  return { ranked, blowouts, unpriced }
}

/**
 * Player-prop markets are billed per market per event, so requesting fourteen
 * markets across a twelve-game slate is a hundred and sixty-eight credits.
 * Requesting only the markets actually on your board is the difference between
 * a usable quota and an exhausted one.
 */
export function estimateCredits(events: number, markets: number, bookmakerRegions = 1): number {
  return events * markets * bookmakerRegions
}
