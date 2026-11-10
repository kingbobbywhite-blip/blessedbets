import { MARKETS, type Sport, type MarketKey } from "@/lib/nba/markets"
import { DEFAULT_LEAGUE, type LeagueId } from "@/lib/leagues"
import { normalizeName } from "@/lib/quant/correlation"
// Re-exported: both were defined here before the odds adapter needed them too,
// and callers (and tests) still reach for them from this module.
export { sameGameId, teamNickname } from "./games"
import { attributedGames, teamNickname } from "./games"
import type { PickType } from "@/lib/store/schema"
import { feedKeyFor, feedMarketFor, normalizeEventOdds, sportOfFeedKey, type NormalizeResult } from "./theoddsapi"
import { feedErrorText, notStarted } from "./http"
import { FeedKeyError, keySourceHint, resolveKey, type ResolvedKey } from "./api-key"
// Re-exported: it was defined here until The Odds API's refusals needed it
// too, and the routes (and tests) still reach for it from this module.
export { FeedKeyError }
import type { FeedBookmaker, FeedEvent, FeedEventOdds, FeedOutcome } from "./types"

/**
 * PropLine adapter (https://prop-line.com).
 *
 * PropLine serves the same event and odds shape as The Odds API, so sportsbook
 * prices go through the same normaliser and the same engine. What it adds is
 * the half this app could never see: the lines the pick'em apps themselves are
 * posting. PrizePicks and Underdog arrive as bookmakers in the same payload.
 *
 * Those rows are lines, not prices. PrizePicks is served at a synthetic
 * +100/+100 on every pick, because its payout depends on how many legs hit,
 * not on the pick. Letting those into the consensus would drag every fair
 * price toward a coin flip, which is exactly the error this app exists to
 * stop. So pick'em rows are split out here and never reach the pricing path.
 *
 * Billing is per request, not per market, and the free tier is 1,000 requests
 * a day: a twelve-game slate is thirteen requests whatever the market list.
 */

export const PROPLINE_BASE = "https://api.prop-line.com/v1"

/** Free-tier daily request allowance. */
export const PROPLINE_FREE_DAILY = 1000

/**
 * PropLine's own sport keys. It accepts The Odds API names as aliases, but the
 * native keys are the documented ones, so those are what we send.
 */
const SPORT_KEYS: Record<LeagueId, string> = {
  nba: "basketball_nba",
  nfl: "football_nfl",
  cfb: "football_ncaaf",
}

export function proplineSportKey(league: LeagueId = DEFAULT_LEAGUE): string {
  return SPORT_KEYS[league] ?? SPORT_KEYS[DEFAULT_LEAGUE]
}

/**
 * Where PropLine names a market differently from The Odds API.
 *
 * Empty while every league Today pulls is one both feeds name the same way.
 * It stays because the next disagreement belongs here rather than in the
 * request builder: hockey's "goalie_saves" lived here until the NHL was
 * dropped.
 */
const REQUEST_ALIASES: Record<string, string> = {}

/** Translate a market list into PropLine's keys, without duplicates. */
export function proplineMarkets(markets: string[]): string[] {
  return Array.from(new Set(markets.map((m) => REQUEST_ALIASES[m] ?? m)))
}

/**
 * The pick'em apps PropLine carries. Any book whose outcomes carry a DFS pick
 * type or an Underdog payout multiplier is treated as one too, so a pick'em app
 * PropLine adds later is never mistaken for a sportsbook price.
 */
export const PICKEM_BOOKS = ["prizepicks", "underdog", "sleeper", "dabble"]

/** Exchange offers with less than this many dollars behind them are not a price. */
export const MIN_EXCHANGE_LIQUIDITY = 25

// ---------------------------------------------------------------------------
// Payload shape: The Odds API's, plus PropLine's optional extras.
// ---------------------------------------------------------------------------

export interface ProplineOutcome extends FeedOutcome {
  /** PrizePicks pick flavour: "standard" is the market line. Null on sportsbooks. */
  dfs_odds_type?: PickType | null
  /** Underdog's boost (1.5) or discount (0.75); 1.0 is a standard pick. Null off Underdog. */
  payout_multiplier?: number | null
  /** League id such as "nba:1628983". Null when PropLine could not confirm one. */
  player_id?: string | null
  /** Dollars an exchange will take at this price. Null for sportsbooks. */
  liquidity?: number | null
}

export interface ProplineMarket {
  key: string
  description?: string | null
  last_update?: string
  /** Set when the book pulled the market; the prices left behind are stale. */
  suspended_at?: string | null
  outcomes: ProplineOutcome[]
}

export interface ProplineBookmaker {
  key: string
  title: string
  last_update?: string
  /** The event is live and this book does not price it in play: its prices are frozen. */
  pregame_only?: boolean
  markets: ProplineMarket[]
}

export interface ProplineEvent {
  id: string | number
  sport_key?: string
  commence_time: string
  home_team: string
  away_team: string
}

export interface ProplineEventOdds extends ProplineEvent {
  bookmakers: ProplineBookmaker[]
}

/** One line a pick'em app is posting for a player. */
export interface PickemLine {
  /** The app, by PropLine's book key: "prizepicks", "underdog". Matches the app ids in payouts. */
  app: string
  player: string
  playerKey: string
  market: MarketKey
  gameId: string
  line: number
  pickType: PickType
  /**
   * The sides on offer. Null when the app does not offer that side at this
   * line (PrizePicks goblins and demons are over-only). The multiplier is
   * Underdog's when it is not a standard 1.0 pick, and null otherwise.
   */
  over: { multiplier: number | null } | null
  under: { multiplier: number | null } | null
  fetchedAt: string | null
}

export interface ProplineNormalizeResult extends NormalizeResult {
  pickemLines: PickemLine[]
  /** Games whose pick'em lines were closed because the game had started, by game id. */
  closedGames: string[]
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * "Tarik Skubal (DET)" to "Tarik Skubal". Some books tag the team onto the
 * name, and the name matcher keeps letters, so "DET" would otherwise become
 * part of the player and nothing would match.
 */
export function cleanPlayerName(raw: string | undefined | null): string {
  return (raw ?? "").replace(/\s*\([A-Z]{2,4}\)\s*$/, "").trim()
}

/** Pick'em apps word the sides their own way: Underdog says Higher and Lower. */
const PICKEM_SIDES: Record<string, "over" | "under"> = {
  over: "over",
  under: "under",
  higher: "over",
  lower: "under",
  more: "over",
  less: "under",
}

function isPickemBook(book: ProplineBookmaker): boolean {
  if (PICKEM_BOOKS.includes(book.key.toLowerCase())) return true
  return (book.markets ?? []).some((m) =>
    (m.outcomes ?? []).some((o) => o.dfs_odds_type != null || o.payout_multiplier != null),
  )
}

/**
 * Our market for a PropLine key. PrizePicks goblins and demons can arrive as
 * their own markets; a suffix naming the flavour is stripped before mapping.
 */
function marketFor(key: string, sport: Sport | undefined): MarketKey | null {
  return feedMarketFor(key, sport) ?? feedMarketFor(key.replace(/_(goblin|demon)\b.*$/i, ""), sport)
}

function pickTypeOf(o: ProplineOutcome, m: ProplineMarket): PickType {
  if (o.dfs_odds_type === "goblin" || o.dfs_odds_type === "demon" || o.dfs_odds_type === "standard") {
    return o.dfs_odds_type
  }
  const label = `${m.description ?? ""} ${m.key}`
  if (/goblin/i.test(label)) return "goblin"
  if (/demon/i.test(label)) return "demon"
  return "standard"
}

function multiplierOf(o: ProplineOutcome): number | null {
  const m = o.payout_multiplier
  return m == null || !Number.isFinite(m) || Math.abs(m - 1) < 1e-9 ? null : m
}

/**
 * Split one event into sportsbook quotes, which price the slate, and pick'em
 * lines, which say what the apps are offering.
 *
 * Sportsbook rows are cleaned and then handed to the same normaliser The Odds
 * API uses, so pairing, drop reasons and market mapping are identical. On top
 * of that, a market the book has pulled, a book frozen on a live game, and an
 * exchange offer too thin to bet are all dropped with their reason.
 */
export function normalizeProplineEvent(
  event: ProplineEventOdds,
  sport?: Sport,
  opts: { minLiquidity?: number; now?: number; competition?: LeagueId } = {},
): ProplineNormalizeResult {
  const inSport = sport ?? sportOfFeedKey(event.sport_key)
  const minLiquidity = opts.minLiquidity ?? MIN_EXCHANGE_LIQUIDITY
  // A pick'em app stops taking picks on a game once it starts, and what it
  // leaves behind is the pregame line. Built into an entry against live
  // sportsbook prices, that stale number reads as a near-certain hit.
  const started = Date.parse(event.commence_time) <= (opts.now ?? Date.now())
  let closed = false
  const gameId = `${event.away_team}@${event.home_team}`
  const dropped: NormalizeResult["dropped"] = []
  const books: FeedBookmaker[] = []
  const lines = new Map<string, PickemLine>()

  for (const book of event.bookmakers ?? []) {
    if (isPickemBook(book)) {
      if (started || book.pregame_only) {
        dropped.push({ reason: "pick'em lines closed: the game has started", detail: book.key })
        closed = true
        continue
      }
      for (const market of book.markets ?? []) {
        const mapped = marketFor(market.key, inSport)
        if (!mapped) continue
        if (market.suspended_at) {
          dropped.push({ reason: "pick'em line pulled by the app", detail: `${book.key} ${market.key}` })
          continue
        }
        for (const o of market.outcomes ?? []) {
          const player = cleanPlayerName(o.description)
          const side = PICKEM_SIDES[(o.name ?? "").trim().toLowerCase()]
          if (!player || !side || o.point == null || !Number.isFinite(o.point)) continue
          const pickType = pickTypeOf(o, market)
          const key = `${book.key}|${normalizeName(player)}|${mapped}|${o.point}|${pickType}`
          const entry = lines.get(key) ?? {
            app: book.key.toLowerCase(),
            player,
            playerKey: normalizeName(player),
            market: mapped,
            gameId,
            line: o.point,
            pickType,
            over: null,
            under: null,
            fetchedAt: market.last_update ?? book.last_update ?? null,
          }
          entry[side] = { multiplier: multiplierOf(o) }
          lines.set(key, entry)
        }
      }
      continue
    }

    if (book.pregame_only) {
      dropped.push({ reason: "book frozen on a live game", detail: book.key })
      continue
    }

    const markets: FeedBookmaker["markets"] = []
    for (const market of book.markets ?? []) {
      if (market.suspended_at) {
        dropped.push({ reason: "market pulled by the book", detail: `${book.key} ${market.key}` })
        continue
      }
      const outcomes: FeedOutcome[] = []
      for (const o of market.outcomes ?? []) {
        if (o.liquidity != null && Number.isFinite(o.liquidity) && o.liquidity < minLiquidity) {
          dropped.push({
            reason: "exchange offer too thin to bet",
            detail: `${book.key} ${market.key} ${cleanPlayerName(o.description)} $${o.liquidity}`,
          })
          continue
        }
        outcomes.push({ name: o.name, description: cleanPlayerName(o.description), price: o.price, point: o.point })
      }
      markets.push({ key: market.key, last_update: market.last_update, outcomes })
    }
    books.push({ key: book.key, title: book.title, last_update: book.last_update, markets })
  }

  const feedEvent: FeedEventOdds = {
    id: String(event.id),
    sport_key: event.sport_key,
    commence_time: event.commence_time,
    home_team: event.home_team,
    away_team: event.away_team,
    bookmakers: books,
  }
  const priced = normalizeEventOdds(feedEvent, inSport, opts.competition)

  return {
    quotes: priced.quotes,
    unknownMarkets: priced.unknownMarkets,
    dropped: [...dropped, ...priced.dropped],
    pickemLines: Array.from(lines.values()),
    closedGames: closed ? [gameId] : [],
  }
}

export function normalizeProplineMany(
  events: ProplineEventOdds[],
  sport?: Sport,
  opts?: { minLiquidity?: number; now?: number; competition?: LeagueId },
): ProplineNormalizeResult {
  const all: ProplineNormalizeResult = { quotes: [], unknownMarkets: [], dropped: [], pickemLines: [], closedGames: [] }
  const unknown = new Set<string>()
  for (const e of events) {
    const r = normalizeProplineEvent(e, sport, opts)
    all.quotes.push(...r.quotes)
    all.dropped.push(...r.dropped)
    all.pickemLines.push(...r.pickemLines)
    all.closedGames.push(...r.closedGames)
    for (const m of r.unknownMarkets) unknown.add(m)
  }
  all.unknownMarkets = Array.from(unknown)
  return all
}

// ---------------------------------------------------------------------------
// Matching games across feeds
// ---------------------------------------------------------------------------

type GameRef = { home_team: string; away_team: string; commence_time: string }

/**
 * The same game in two feeds: the same two teams, home and away, starting
 * within twelve hours of each other, which tells tonight's game apart from a
 * rematch later in the week.
 */
export function sameGame(a: GameRef, b: GameRef): boolean {
  if (teamNickname(a.home_team) !== teamNickname(b.home_team)) return false
  if (teamNickname(a.away_team) !== teamNickname(b.away_team)) return false
  const ta = Date.parse(a.commence_time)
  const tb = Date.parse(b.commence_time)
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= 12 * 3600 * 1000
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function proplineEventsUrl(league: LeagueId = DEFAULT_LEAGUE): string {
  return `${PROPLINE_BASE}/sports/${proplineSportKey(league)}/events`
}

export function proplineEventOddsUrl(
  eventId: string | number,
  opts: { markets: string[]; bookmakers?: string[]; league?: LeagueId },
): string {
  const params = new URLSearchParams({ markets: proplineMarkets(opts.markets).join(",") })
  if (opts.bookmakers && opts.bookmakers.length > 0) params.set("bookmakers", opts.bookmakers.join(","))
  const sport = proplineSportKey(opts.league ?? DEFAULT_LEAGUE)
  return `${PROPLINE_BASE}/sports/${sport}/events/${encodeURIComponent(String(eventId))}/odds?${params.toString()}`
}

/**
 * PROPLINE_API_KEY in the environment wins over a key sent from Settings, the
 * same precedence ODDS_API_KEY has, except that a placeholder left in the
 * environment is not a key: it would otherwise shadow the real one in Settings
 * and there is no way to tell from the 401 that it had. Server-side only:
 * never call from the page.
 */
export function resolveProplineKeySource(fromBody: string | undefined | null): ResolvedKey | null {
  return resolveKey(process.env.PROPLINE_API_KEY, fromBody, {
    env: "PROPLINE_API_KEY",
    settings: "Settings \u2192 Odds feed \u2192 PropLine key",
  })
}

/** The key alone, for callers that do not report errors. */
export function resolveProplineKey(fromBody: string | undefined | null): string | null {
  return resolveProplineKeySource(fromBody)?.key ?? null
}

/** The key travels in a header, so it never sits in a URL that might get logged. */
export function proplineHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey }
}

export interface ProplineQuota {
  limit: number
  used: number
  remaining: number
}

/** Daily quota from the X-Daily-* headers, or null when they are absent. */
export function proplineQuota(headers: Headers): ProplineQuota | null {
  if (!headers.has("X-Daily-Limit")) return null
  const limit = Number(headers.get("X-Daily-Limit"))
  const used = Number(headers.get("X-Daily-Used"))
  const remaining = Number(headers.get("X-Daily-Remaining"))
  if (![limit, used, remaining].every(Number.isFinite)) return null
  return { limit, used, remaining }
}

/**
 * PropLine's structured error body. `detail` is a plain sentence on some
 * errors and an object on the ones worth acting on, which is why reading only
 * the string form put raw JSON in front of the user on a bad key.
 */
export interface ProplineErrorBody {
  /** Stable code: invalid_api_key, missing_api_key, daily_limit_exceeded, burst_limit_exceeded, upgrade_required. */
  code: string | null
  /** PropLine's own sentence, when it sent one. */
  message: string | null
  /** Whichever of signup_url, upgrade_url or docs_url it sent, in that order. */
  url: string | null
}

function stringAt(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/** Read a PropLine error body, whether `detail` is a sentence or an object. */
export function parseProplineError(text: string): ProplineErrorBody {
  const empty: ProplineErrorBody = { code: null, message: null, url: null }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return empty
  }
  if (!body || typeof body !== "object") return empty
  const top = body as Record<string, unknown>
  const detail = top.detail
  // A string detail carries the sentence; an object carries the code and links too.
  const info: Record<string, unknown> =
    detail && typeof detail === "object" ? (detail as Record<string, unknown>) : top
  return {
    code: stringAt(info, "error") ?? stringAt(info, "error_code") ?? stringAt(top, "error_code"),
    message: (typeof detail === "string" ? detail.trim() : null) || stringAt(info, "message"),
    url: stringAt(info, "signup_url") ?? stringAt(info, "upgrade_url") ?? stringAt(info, "docs_url"),
  }
}

/**
 * What a failed PropLine response means, read once: the sentence to show and
 * whether the key was what it refused.
 *
 * A rejected key names the place the key came from. The environment beats
 * Settings, so without that the obvious fix (retype it in Settings) changes
 * nothing and the same error comes back.
 */
function describeFailure(
  text: string,
  status: number,
  key: ResolvedKey | null,
): { message: string; keyRejected: boolean } {
  const parsed = parseProplineError(text)
  // Fall back to the raw body only when nothing could be read out of it, and
  // never to raw JSON: an unparsed object is noise to whoever reads the screen.
  const raw = text.trim().startsWith("{") ? "" : text.trim().slice(0, 300)
  const said = parsed.message ?? raw
  const sentence = (...s: (string | null | undefined)[]) =>
    s
      .map((x) => (x ?? "").trim())
      .filter(Boolean)
      .join(" ")
  /** PropLine's own words, with the link it sent, when it sent either. */
  const detail = sentence(said, parsed.url ? `(${parsed.url})` : null)
  const where = keySourceHint(key)

  if (parsed.code === "missing_api_key") {
    return { message: sentence("PropLine received no API key.", detail, where), keyRejected: true }
  }
  if (status === 401 || parsed.code === "invalid_api_key") {
    return {
      // Without PropLine's link: on this error it is the signup page, and the
      // closing sentence already says where a key comes from.
      message: sentence(
        "PropLine rejected the API key.",
        said,
        where,
        "A key is free at prop-line.com and gives 1,000 requests a day; check the one in use against it.",
      ),
      keyRejected: true,
    }
  }
  // A 404 names the path, and every path this adapter builds starts with a
  // sport key. Reported as a bare "PropLine returned 404" it reads as an
  // outage, which sends nobody to the one line of configuration that is wrong.
  if (status === 404) {
    return {
      message: sentence(
        "PropLine does not recognise that sport.",
        detail,
        "Its sport keys are its own, not The Odds API's: check the key this league sends in lib/odds-feed/propline.ts against prop-line.com's documented list.",
      ),
      keyRejected: false,
    }
  }
  const message =
    parsed.code === "burst_limit_exceeded"
      ? sentence("PropLine is limiting requests. Wait a few seconds and try again.", detail)
      : parsed.code === "upgrade_required"
        ? sentence("This needs a paid PropLine plan.", detail)
        : status === 429 || parsed.code === "daily_limit_exceeded"
          ? sentence("PropLine's daily request limit is used up. It resets at 00:00 UTC.", detail)
          : sentence(`PropLine returned ${status}.`, detail)
  return { message, keyRejected: false }
}

/** A readable sentence from a failed PropLine response, saying what to do about it. */
export async function proplineErrorText(res: Response, key?: ResolvedKey | null): Promise<string> {
  const text = await res.text().catch(() => "")
  return describeFailure(text, res.status, key ?? null).message
}

/** The error to throw for a failed PropLine response, typed so a bad key is recognisable. */
export async function proplineFailure(res: Response, key?: ResolvedKey | null): Promise<Error> {
  const text = await res.text().catch(() => "")
  const { message, keyRejected } = describeFailure(text, res.status, key ?? null)
  return keyRejected ? new FeedKeyError(message) : new Error(message)
}

/** The quote fields this filter reads. A NormalizedQuote satisfies it. */
interface PricedProp {
  player: string
  playerKey?: string
  market: MarketKey
  gameId: string
}

/**
 * The pick'em lines something on this slate can actually read, and the ones
 * nothing can.
 *
 * Every pull is kept in this browser's storage, which is the app's binding
 * constraint, so a line no code path can ever reach is worth shedding. The
 * trap is that "can ever reach" is two different things, and keeping only the
 * first loses real information:
 *
 *   A line is PLAYABLE only if its own player and market were priced. A line
 *   reaches a board row through one key, `player|market` (see
 *   indexPickemLines), so a PrizePicks rebounds line for a player the books
 *   priced only for points can never attach to a target. It used to be kept
 *   anyway, on the strength of the points quote.
 *
 *   But a line is also EVIDENCE that the app covers a game and market, read
 *   under `game|market` (see pickemCoverage), and that evidence decides
 *   whether a prop with no line reads as "the app is not offering it" or as
 *   "we never heard". That reading is made for OTHER players' props, so a line
 *   can be unplayable itself and still be the only thing that gets another
 *   row's verdict right. Drop it and the screen says "no PrizePicks line
 *   reached at all" about a game and market where PrizePicks did post one and
 *   this app threw it away — the one failure this codebase exists to refuse.
 *
 * So: keep a line when its own player and market are priced, OR when its
 * market is priced for anyone in a game the line can be attributed to. The
 * second clause is exact rather than cautious for both paths above: coverage
 * for `game|market` is only ever read by a target at that same game and
 * market, so a line whose market is priced nowhere in its game is unreachable
 * by either.
 *
 * It is NOT lossless for a third consumer, and that is worth stating rather
 * than glossing. The Today screen reads the stored lines once more, keyed on
 * the app alone, to say which apps turned up in a pull; by that key a shed
 * line is a line the app never posted, and an app whose every line was shed
 * read as "posted none in this pull" — contradicted by the shed-lines note in
 * the same paragraph. The route therefore reports the apps that posted BEFORE
 * this filter runs (pickemAppsPosted), which is what that question actually
 * asks. Any new consumer keyed on something other than `player|market` or
 * `game|market` has to be checked against this the same way.
 */
export type PickemDropReason =
  /** No sportsbook priced this player at all, in any market, anywhere on the slate. */
  | "player-unpriced"
  /**
   * No sportsbook priced this MARKET anywhere on the slate.
   *
   * A different kind of fact from the others, and the only one that is about
   * the market list rather than about a player or a game. Pick'em apps post
   * markets the sportsbooks do not — turnovers is the archetype, loved by DFS
   * as a fade-the-star pick and rarely hung by a book — and asking for one
   * produces lines nothing can ever price, by construction. Reported per line
   * it reads as eighty-five separate failures; it is one fact with one fix.
   */
  | "market-unpriced-slate"
  /** The market is priced somewhere on the slate, just not in this line's game. */
  | "market-unpriced"
  /** The player is priced in more than one game and the line names neither of them. */
  | "game-unmatched"

export interface DroppedPickemLine {
  line: PickemLine
  reason: PickemDropReason
}

export function usablePickemLines(
  lines: PickemLine[],
  quotes: PricedProp[],
): { lines: PickemLine[]; dropped: DroppedPickemLine[] } {
  const gamesByPlayer = new Map<string, Set<string>>()
  const pricedProps = new Set<string>()
  const pricedGameMarkets = new Set<string>()
  // Every market any sportsbook priced anywhere on this slate. A market
  // missing from here is missing from the whole pull, which is a statement
  // about what was asked for rather than about any one line.
  const pricedMarkets = new Set<MarketKey>()
  for (const q of quotes) {
    // The same derivation pickemCoverage uses, deliberately: if the two ever
    // disagreed this filter would shed a line that pass would have counted.
    const who = q.playerKey || normalizeName(q.player)
    const set = gamesByPlayer.get(who) ?? new Set<string>()
    set.add(q.gameId)
    gamesByPlayer.set(who, set)
    pricedProps.add(`${who}|${q.market}`)
    pricedGameMarkets.add(`${q.gameId}|${q.market}`)
    pricedMarkets.add(q.market)
  }

  const kept: PickemLine[] = []
  const dropped: DroppedPickemLine[] = []
  for (const l of lines) {
    const who = l.playerKey || normalizeName(l.player)
    const playable = pricedProps.has(`${who}|${l.market}`)
    const games = attributedGames(l.gameId, gamesByPlayer.get(who))
    const evidence = !playable && games.some((g) => pricedGameMarkets.has(`${g}|${l.market}`))
    if (playable || evidence) {
      kept.push(l)
      continue
    }
    // WHICH clause failed has to travel with the line. The commonest drop by
    // far is a player no sportsbook priced in anything — a bench player an app
    // posts and the books do not — and telling that user "no sportsbook priced
    // that market in the game it covers" is false on its face, with a table of
    // that very market for that very game directly underneath it.
    dropped.push({
      line: l,
      reason: !pricedMarkets.has(l.market)
        ? "market-unpriced-slate"
        : !gamesByPlayer.has(who)
          ? "player-unpriced"
          : games.length === 0
            ? "game-unmatched"
            : "market-unpriced",
    })
  }
  return { lines: kept, dropped }
}

/**
 * What to say about the lines that were shed, because a shorter list with no
 * explanation is indistinguishable from an app posting less.
 *
 * One clause per reason, never one sentence covering all of them. The reasons
 * are different facts about different things — a player the books ignore, a
 * market they did not post in that game, a name that fits two fixtures — and
 * collapsing them into the loudest one states something false about the rest.
 *
 * `chosen` says whether the market list was typed into Settings. Only then is
 * dropping a market from it something the user can do; on this app's own list
 * the fact is still said, without an instruction to edit a box left blank.
 */
export function unpricedPickemNote(
  dropped: DroppedPickemLine[],
  opts: { chosen?: boolean } = {},
): string | null {
  const { chosen = true } = opts
  if (dropped.length === 0) return null
  const apps = Array.from(new Set(dropped.map((d) => d.line.app))).sort()
  const of = (reason: PickemDropReason) => dropped.filter((d) => d.reason === reason)
  const names = (ds: DroppedPickemLine[]) => Array.from(new Set(ds.map((d) => d.line.player))).sort()
  const marketsOf = (ds: DroppedPickemLine[]) =>
    Array.from(new Set(ds.map((d) => MARKETS[d.line.market]?.label ?? d.line.market))).sort()

  const clauses: string[] = []
  // The market-list fact first, and phrased as one: it is the only clause here
  // with an action attached, and the only one whose count says nothing useful.
  // "85 because no sportsbook priced Turnovers in the game they cover" is the
  // same sentence eighty-five times about a market no book posts at all.
  const slate = of("market-unpriced-slate")
  const slateMarkets = marketsOf(slate)
  if (slate.length > 0) {
    clauses.push(
      `${slate.length} for ${slateMarkets.join(", ")}, which no sportsbook on this slate prices at all — the apps post ${slateMarkets.length === 1 ? "it" : "them"} and the books do not, so nothing here can ever price ${slateMarkets.length === 1 ? "that market" : "those markets"}`,
    )
  }
  const strangers = of("player-unpriced")
  if (strangers.length > 0) {
    const who = names(strangers)
    clauses.push(
      `${strangers.length} because no sportsbook priced ${who.length === 1 ? who[0] : `${who.length} of the players`} at all`,
    )
  }
  const markets = of("market-unpriced")
  if (markets.length > 0) {
    const m = marketsOf(markets)
    clauses.push(
      `${markets.length} because no sportsbook priced ${m.join(", ")} in the game ${markets.length === 1 ? "it covers" : "they cover"}`,
    )
  }
  const unmatched = of("game-unmatched")
  if (unmatched.length > 0) {
    clauses.push(
      `${unmatched.length} because ${unmatched.length === 1 ? "its player appears" : "their players appear"} in more than one game on this slate and the line names neither`,
    )
  }

  // The action belongs with the only clause that has one, and only when that
  // clause is there: nobody can do anything about a bench player the books
  // ignore, but a market the books never post is a line in the Markets box —
  // when the box has a list in it. The box takes feed keys, so it names keys.
  const slateKeys = Array.from(new Set(slate.map((d) => feedKeyFor(d.line.market) ?? d.line.market))).sort()
  const fix =
    slate.length > 0 && chosen
      ? ` Drop ${slateKeys.join(", ")} from Settings → Markets to stop pulling ${slateKeys.length === 1 ? "it" : "them"}.`
      : ""
  return `${dropped.length} pick'em line${dropped.length === 1 ? "" : "s"} from ${apps.join(", ")} ${
    dropped.length === 1 ? "was" : "were"
  } left out: ${clauses.join("; ")}. Nothing on this slate could price ${dropped.length === 1 ? "it" : "them"}.${fix}`
}

/**
 * What to tell the user about the pick'em lines of a pull. A failed request is
 * named before anything else: when the daily limit runs out mid-pull, "the apps
 * have not posted yet" would send someone to wait for lines that are coming.
 */
export function pickemNoteFor(lineCount: number, failures: { error: string }[], closedGames = 0): string | null {
  if (failures.length > 0) {
    return `Pick'em lines for ${failures.length} game${failures.length === 1 ? "" : "s"} could not be read: ${failures[0].error}`
  }
  const closed =
    closedGames > 0
      ? `${closedGames} game${closedGames === 1 ? " has" : "s have"} already started, so the pick'em apps have closed ${closedGames === 1 ? "its" : "their"} lines and ${closedGames === 1 ? "it is" : "they are"} left out of the entry.`
      : null
  if (lineCount === 0) {
    return closed ?? "PropLine returned no pick'em lines for these games yet. The apps usually post a few hours before the start."
  }
  return closed
}

/**
 * What to say when PropLine would not serve the market list.
 *
 * A board that quietly came back narrower reads as the apps posting less, and
 * before the fallback existed it did not come back at all. Either way the
 * market list is the cause and the screen has to name it, because it is the
 * one thing the user can change.
 */
export function narrowedMarketsNote(narrowed: ProplinePull["narrowed"]): string | null {
  if (!narrowed) return null
  const gone = narrowed.from.filter((m) => !narrowed.to.includes(m))
  if (gone.length === 0) return null
  return `PropLine would not serve ${gone.length} of the ${narrowed.from.length} markets asked for, so this slate is priced at the ${narrowed.to.length} it does serve rather than not at all. Missing: ${gone.join(", ")}. Set the market list under Settings → Markets to stop asking for them. PropLine said: ${narrowed.because}`
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface ProplinePull {
  /** Every game in the window, sorted by start, less any that had started by `now`. */
  inWindow: FeedEvent[]
  /** Games in the window left out because they had already started. */
  started: number
  /** The games actually priced, after the cap. */
  selected: FeedEvent[]
  /** Games wanted (in the window, and in eventIds when given) but left out by the cap. */
  cappedOut: number
  /** Earliest game after the window, for "next game is Tuesday". */
  nextEvent: FeedEvent | null
  payloads: ProplineEventOdds[]
  failures: { eventId: string; matchup: string; error: string }[]
  /**
   * Set when PropLine refused the market list and the pull fell back to the
   * core one, naming what went and what PropLine said. Null when the wide list
   * was served, which is the ordinary case.
   */
  narrowed: { from: string[]; to: string[]; because: string } | null
  quota: ProplineQuota | null
  /** Requests this pull made, the events listing included. */
  requests: number
}

/**
 * Pull a league's slate from PropLine: the events listing, then one odds
 * request per game in the window, up to the cap. A game that fails is reported
 * and skipped; a listing that fails throws, because without it there is no slate.
 */
export async function pullPropline(opts: {
  apiKey: string
  /** Where `apiKey` came from, so a rejected key says where to correct it. */
  keySource?: ResolvedKey | null
  league: LeagueId
  fromMs: number
  toMs: number
  markets: string[]
  /**
   * The markets to fall back to if PropLine will not serve `markets`.
   *
   * Asking a feed for a market it does not carry must never be able to take a
   * whole league offline, and it did: widening the NBA to its full board on
   * PropLine made every game's request fail, and with every game failing the
   * pull reported that nothing could be priced. The league simply stopped
   * working, with nothing on screen naming the market list as the cause.
   *
   * Omit to disable the fallback, which is right where the wide list IS the
   * core list and a retry would just fail the same way.
   */
  coreMarkets?: string[]
  bookmakers?: string[]
  maxGames: number
  /** Only these games, by PropLine event id. */
  eventIds?: string[]
  /**
   * Only these games, as another feed listed them, matched on teams and start
   * time. Used when The Odds API priced the slate, so the pick'em lines cover
   * exactly the games that were priced rather than PropLine's own pick of them.
   */
  games?: GameRef[]
  /** Return after the listing, without pulling odds. */
  eventsOnly?: boolean
  /** When given, games that started by this instant are left out of the window and counted in `started`. */
  now?: number
  fetcher?: Fetcher
}): Promise<ProplinePull> {
  const doFetch: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init))
  const init: RequestInit = { headers: proplineHeaders(opts.apiKey), cache: "no-store" }

  const res = await doFetch(proplineEventsUrl(opts.league), init)
  if (!res.ok) throw await proplineFailure(res, opts.keySource)
  let quota = proplineQuota(res.headers)
  const raw = (await res.json()) as ProplineEvent[]
  const events: FeedEvent[] = (Array.isArray(raw) ? raw : []).map((e) => ({
    id: String(e.id),
    sport_key: e.sport_key ?? proplineSportKey(opts.league),
    commence_time: e.commence_time,
    home_team: e.home_team,
    away_team: e.away_team,
  }))

  const listed = events
    .filter((e) => {
      const t = Date.parse(e.commence_time)
      return Number.isFinite(t) && t >= opts.fromMs && t <= opts.toMs
    })
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time))
  const inWindow = opts.now == null ? listed : listed.filter((e) => notStarted(e.commence_time, opts.now!))
  const nextEvent =
    events
      .filter((e) => Date.parse(e.commence_time) > opts.toMs)
      .sort((a, b) => a.commence_time.localeCompare(b.commence_time))[0] ?? null
  const chosen = opts.games
    ? events
        .filter((e) => opts.games!.some((g) => sameGame(e, g)))
        .sort((a, b) => a.commence_time.localeCompare(b.commence_time))
    : opts.eventIds?.length
      ? inWindow.filter((e) => opts.eventIds!.includes(e.id))
      : inWindow
  const selected = chosen.slice(0, Math.max(1, opts.maxGames))

  const payloads: ProplineEventOdds[] = []
  const failures: ProplinePull["failures"] = []
  let narrowed: ProplinePull["narrowed"] = null
  let requests = 1

  if (!opts.eventsOnly) {
    // The list in use, which narrows the first time PropLine refuses the wide
    // one. Narrowing once rather than per game costs a single extra request on
    // a feed billed per request: the first game pays to find out, the rest go
    // straight to the list that works.
    let asking = proplineMarkets(opts.markets)
    const core = opts.coreMarkets ? proplineMarkets(opts.coreMarkets) : null
    const canNarrow = () => core != null && core.length > 0 && core.length < asking.length

    const fetchOdds = async (e: FeedEvent, markets: string[]) => {
      const r = await doFetch(
        proplineEventOddsUrl(e.id, { markets, bookmakers: opts.bookmakers, league: opts.league }),
        init,
      )
      if (!r.ok) throw await proplineFailure(r, opts.keySource)
      quota = proplineQuota(r.headers) ?? quota
      const body = (await r.json()) as ProplineEventOdds
      // The event block can come back without its teams; the listing has them.
      return { ...e, ...body, home_team: body.home_team ?? e.home_team, away_team: body.away_team ?? e.away_team }
    }

    for (const e of selected) {
      requests++
      try {
        payloads.push(await fetchOdds(e, asking))
      } catch (err) {
        // A key PropLine rejected will refuse the narrow list too, and every
        // further request spends quota to be told the same thing. Give up on
        // the pull rather than retrying it game by game.
        if (err instanceof FeedKeyError) throw err
        if (canNarrow()) {
          const wide = asking
          try {
            requests++
            const payload = await fetchOdds(e, core!)
            // It was the market list, not the game. Say which markets went,
            // and ask for the narrow list from here on.
            narrowed = { from: wide, to: core!, because: feedErrorText(err, "PropLine") }
            asking = core!
            payloads.push(payload)
            continue
          } catch {
            // The narrow list failed too, so the market list is not the
            // problem; report the original failure, which is the honest one.
          }
        }
        failures.push({
          eventId: e.id,
          matchup: `${e.away_team} at ${e.home_team}`,
          error: feedErrorText(err, "PropLine"),
        })
      }
    }
  }

  return {
    inWindow,
    started: listed.length - inWindow.length,
    selected,
    cappedOut: chosen.length - selected.length,
    nextEvent,
    payloads,
    failures,
    narrowed,
    quota,
    requests,
  }
}
