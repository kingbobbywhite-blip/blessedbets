import { MARKETS, type MarketKey } from "@/lib/nba/markets"
import type { LeagueId } from "@/lib/leagues"
import { resolveLine, type LineProbabilities } from "@/lib/quant/distributions"
import { linePrices } from "@/lib/quant/projection"
import { probToAmerican } from "@/lib/quant/odds"
import { optimizeSlips, type BuiltSlip, type CandidateLeg, type OptimizerConstraints } from "@/lib/quant/optimizer"
import { normalizeName, playerKeyIn, type CorrelationSettings } from "@/lib/quant/correlation"
import type { PickemLine } from "@/lib/odds-feed/propline"
import { attributedGames, sameGameId } from "@/lib/odds-feed/games"
import { notStarted } from "@/lib/odds-feed/http"
import type { PickType } from "@/lib/store/schema"
import {
  ambiguousPlayers,
  bestPerSelection,
  findValueBets,
  groupQuotes,
  referenceProjection,
  type FeedQuote,
  type ValueBet,
  type ValueBetSettings,
} from "@/lib/quant/valuebets"

/**
 * The daily pipeline: feed quotes in, plays out.
 *
 * Three products come out of the same data, because the three questions a
 * bettor actually has are different:
 *
 *  1. What single bets are mispriced right now, and at which book.
 *  2. What parlay is worth building out of those, once correlation is priced.
 *  3. What numbers to look for on a pick'em app, since the app's own board
 *     cannot be read from here.
 *
 * The third is the honest answer to "just tell me what to play on PrizePicks".
 * Without a pick'em feed nothing here knows what PrizePicks is offering, so it
 * gives you the number at which each side becomes worth taking, and you check
 * that against your screen in a few seconds. With PropLine's pick'em lines
 * attached, each target also carries the apps' actual lines, priced off the
 * same distribution, and the entry is built at the line the app really posts.
 */

/**
 * A line a pick'em app is posting for a target, with the chance of each side
 * at that exact line. The probabilities come from the sportsbook consensus,
 * never from the app: the app's line says what is on offer, not what it is worth.
 */
export interface AppLine {
  app: string
  line: number
  pickType: PickType
  over: number
  under: number
  /** Chance of landing exactly on a whole-number line, which voids the pick. */
  push: number
  /** Null when the app does not offer that side at this line. */
  overMultiplier: number | null | undefined
  underMultiplier: number | null | undefined
  overOffered: boolean
  underOffered: boolean
  /** When the app last posted this line, as the feed reported it. Null when it did not say. */
  fetchedAt: string | null
  /** Minutes since the app posted it, or null when the feed gave no timestamp. */
  ageMinutes: number | null
  /**
   * Older than the stale threshold the sportsbook prices use.
   *
   * A pick'em app moves its lines, and an entry built at a number the app has
   * since changed is an entry you cannot place. The books' prices are already
   * checked for this; the apps' lines were not, which made a line read three
   * hours ago indistinguishable from one read a minute ago.
   */
  isStale: boolean
}

export interface GameSummary {
  gameId: string
  homeTeam: string
  awayTeam: string
  commenceTime: string | null
  propCount: number
}

export interface DfsTarget {
  key: string
  player: string
  market: MarketKey
  marketLabel: string
  gameId: string
  /**
   * The competition the prop belongs to, when its league's section covers more
   * than one: college football priced inside the NFL section arrives as "cfb".
   * Absent on a slate pulled before companions existed.
   */
  competition?: LeagueId
  commenceTime: string | null
  /** Consensus projection for the stat. */
  mean: number
  sd: number
  confidence: number
  /** Fair line: the number at which the market thinks it is a coin flip. */
  fairLine: number
  /** Highest line at which taking the OVER still clears the bar, or null. */
  overAt: number | null
  overProb: number | null
  /** Lowest line at which taking the UNDER still clears the bar, or null. */
  underAt: number | null
  underProb: number | null
  /**
   * The line the books themselves hang, which is the line a pick'em app
   * almost always copies, the side the market favours there, and how often
   * that side hits. This is the number the targets are sorted by.
   */
  marketLine: number
  marketSide: "OVER" | "UNDER"
  marketProb: number
  /**
   * Over, under and push probability at each line on the board.
   *
   * Push is almost always zero, because a half-point line cannot land on
   * itself — but not always, and the exception cost a real entry. A pick'em
   * app does post whole numbers, and a leg that lands exactly on one is voided
   * rather than won: on an all-or-nothing entry that shrinks the entry and the
   * multiplier with it. The ladder used to walk half-points only, so a whole
   * number the books posted could not appear on it at all.
   */
  ladder: { line: number; over: number; under: number; push: number }[]
  referenceBooks: string[]
  hasSharpBook: boolean
  /** Lines the pick'em apps are posting for this prop, when a pick'em feed was pulled. */
  appLines?: AppLine[]
  /**
   * Apps whose lines came through for this target's game AND market, for any
   * player. A prop with no line from an app that covered its game and market
   * is not on offer there; one the app's lines never arrived for at all is
   * simply unknown, and the two are treated differently.
   *
   * Per market rather than per game, because an app covering a game says
   * nothing about which stats it covers in it: PrizePicks can post points for
   * every starter in a game and no rebounds line in it at all. Keyed on the
   * game alone, every one of those rebounds props read as "offered, and this
   * player is not on it", which is a different claim from the truth.
   */
  appCoverage?: string[]
  /**
   * Anything about this row the screen must say out loud, such as another
   * player on the slate normalising to the same name.
   */
  warnings?: string[]
}

export interface DailyPicks {
  games: GameSummary[]
  valueBets: ValueBet[]
  parlays: BuiltSlip[]
  dfsTargets: DfsTarget[]
  /**
   * Props left out of the targets because no posted line was one a pick'em
   * board would show. Shown on screen, never only dropped.
   */
  lopsided: LopsidedProp[]
  stats: {
    quotes: number
    props: number
    booksSeen: string[]
    pricedProps: number
    /** Edges found only at books outside the bettable list, and so not shown. */
    hiddenOffers: number
    /** The books those hidden edges were at. */
    hiddenBooks: string[]
  }
}

/**
 * The hit rate each side has to show to be a pick'em play.
 *
 * Normally both are the bar: a leg is a leg, and the payout table does not
 * care which way it points. The under can carry a margin on top, set in
 * Settings per league, for one reason: the person playing these has found
 * unders hitting below what they were priced at, in the NBA in particular.
 * It was raised over an entry of four NBA unders on 1 November 2026, where
 * Jeremiah Fears went for 13 assists against 3.5 and Donovan Clingan passed
 * 10.5 points with four minutes left in a 21-point game.
 *
 * Two of four is not evidence, and nothing here pretends it is. What makes the
 * margin safe to have is its direction. It cannot invent an edge — it only
 * ever turns a play into a pass — and it moves no probability: every chance on
 * screen is still the market's. The tracker's overs-and-unders record is where
 * it gets tested, against the bar those legs actually needed.
 */
export interface SideBars {
  over: number
  under: number
}

/** The bar for each side, with the under's margin added. A negative margin is treated as none. */
export function sideBars(bar: number, underMargin = 0): SideBars {
  return { over: bar, under: Math.min(0.99, bar + Math.max(0, underMargin)) }
}

const asBars = (b: number | SideBars): SideBars => (typeof b === "number" ? { over: b, under: b } : b)

/** The bar the given side has to clear. */
export function barFor(bars: SideBars, side: "OVER" | "UNDER"): number {
  return side === "OVER" ? bars.over : bars.under
}

export interface BuildOptions {
  value: ValueBetSettings
  correlation: CorrelationSettings
  constraints: OptimizerConstraints
  /** Per-leg hit rate a pick'em entry needs, used to place the DFS targets. */
  dfsBreakEven: number
  /**
   * How much more an UNDER has to clear, on top of the bar. See SideBars.
   * Zero or absent leaves both sides at the bar.
   */
  underMargin?: number
  /**
   * The most lopsided a pick'em pick can be and still be assumed to exist.
   * See PICKEM_MAX_PROB, which is the default. 1 keeps everything.
   */
  pickemMaxProb?: number
  /**
   * Minimum leg probability for parlay construction. See PARLAY_MIN_LEG_PROB.
   */
  parlayMinLegProb?: number
  /** Commission charged on parlay winnings, for exchanges. */
  parlayCommission?: number
  /** How many parlays to return. */
  parlayCount?: number
  /**
   * Books a bet may be recommended at. Quotes from every other book still count
   * toward the reference price, but are never offered as the bet. Omit to allow
   * any book.
   */
  bettableBooks?: string[]
  /** Lines the pick'em apps are posting, matched onto targets by player and market. */
  pickemLines?: PickemLine[]
  now?: number
}

/**
 * The least likely a parlay leg may be: a coin flip.
 *
 * It was 30%, on the reasoning that a sportsbook's price carries the value, so
 * a +160 leg that hits 45% of the time is a good bet. Alone it is. Three of
 * them hit about one time in eleven, and the parlays this built were ones you
 * could see would not hit. Worse, a long-odds leg is exactly where the edge is
 * least believable: its fair chance comes from the consensus's tail, where
 * the devig method and the dispersion prior matter most, and a parlay
 * multiplies that error once per leg. So a leg has to be at least as likely
 * to land as not. Singles at longer prices are still listed as value bets,
 * one at a time, which is where a long-odds edge belongs.
 */
export const PARLAY_MIN_LEG_PROB = 0.5

export function summariseGames(quotes: FeedQuote[]): GameSummary[] {
  const map = new Map<string, GameSummary>()
  for (const q of quotes) {
    const g = map.get(q.gameId)
    if (g) {
      g.propCount++
    } else {
      const [away, home] = q.gameId.split("@")
      map.set(q.gameId, {
        gameId: q.gameId,
        homeTeam: q.homeTeam ?? home ?? "",
        awayTeam: q.awayTeam ?? away ?? "",
        commenceTime: q.commenceTime ?? null,
        propCount: 1,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.commenceTime ?? "").localeCompare(b.commenceTime ?? ""))
}

/**
 * Find the softest line still worth taking on each side.
 *
 * Walks half-point lines outward from the projection and reports the last one
 * that clears the required hit rate. If nothing clears, both sides come back
 * null, which is the correct answer far more often than people expect.
 */
export function dfsTargetsFor(
  mean: number,
  distribution: { pAtLeast(k: number): number; pmf(k: number): number; variance?: number },
  breakEven: number | SideBars,
  opts: {
    /**
     * The lines the books are actually hanging for this prop. Given these, the
     * search covers the board rather than the whole number line: see below.
     */
    postedLines?: number[]
    /**
     * Each side's chance at a line, when that is not simply the distribution's:
     * a prop the retail books have to agree on too (see linePrices). The fair
     * line is still read off the distribution, which is the market's centre.
     */
    prices?: (line: number) => LineProbabilities
  } = {},
): {
  fairLine: number
  overAt: number | null
  overProb: number | null
  underAt: number | null
  underProb: number | null
  ladder: { line: number; over: number; under: number; push: number }[]
} {
  // Walk the half-point grid, PLUS any whole number the books are actually
  // posting. Pick'em apps post x.5 most of the time and not always: a real
  // settled entry held "under 7 rebounds" and landed on 7, which voids the leg
  // rather than winning it. A ladder that could not represent that line could
  // not warn about it either.
  //
  // WHICH half-point lines matters as much as the maths. Sweeping a fixed
  // window around the projection produces numbers no board has ever shown:
  // a hockey assist market whose mean is 0.4 got lines up to 16.5, a goalie
  // whose mean is 27 got 11.5, and a 250-yard passing line got two hundred
  // rows at one-yard steps. Every one of those is a line you cannot find on
  // PrizePicks, Underdog or FanDuel, so a threshold placed there is advice
  // nobody can act on.
  //
  // So the search covers the BOARD: the lines the books are posting, widened
  // by half a standard deviation to allow for a pick'em app hanging a slightly
  // different number, and capped at 25 units so a yardage market stays a
  // readable ladder. Without posted lines (a caller pricing a hypothetical)
  // it falls back to the old fixed window.
  const bars = asBars(breakEven)
  const sd = Math.sqrt(Math.max(distribution.variance ?? 0, 0))
  const posted = (opts.postedLines ?? []).filter((l) => Number.isFinite(l))
  let lo: number
  let hi: number
  if (posted.length > 0) {
    const pad = Math.min(25, Math.max(1, Math.ceil(0.5 * sd)))
    lo = Math.min(...posted) - pad
    hi = Math.max(...posted) + pad
  } else {
    const reach = Math.max(15, Math.ceil(1.5 * sd))
    lo = mean - reach
    hi = mean + reach
  }
  const start = Math.max(0.5, Math.floor(lo) + 0.5)
  // Snap to the half-point grid without reaching past the window: a posted
  // line is already an x.5, so an unconditional round up added a line nobody
  // hangs on the far end of every ladder.
  const end = Math.ceil(hi - 0.5) + 0.5

  let fairLine = Math.round(mean - 0.5) + 0.5
  let bestGap = Infinity
  let overAt: number | null = null
  let overProb: number | null = null
  let underAt: number | null = null
  let underProb: number | null = null
  const ladder: { line: number; over: number; under: number; push: number }[] = []

  // The grid, then the posted lines that are not on it — a whole number the
  // books hang is a line you can be asked to take, so it belongs here even
  // though the grid would never generate it.
  const steps: number[] = []
  for (let half = start; half <= end; half += 1) if (half > 0) steps.push(half)
  for (const l of posted) {
    if (l > 0 && !steps.some((x) => Math.abs(x - l) < 1e-9)) steps.push(l)
  }
  steps.sort((a, b) => a - b)

  for (const step of steps) {
    const centre = resolveLine(distribution as never, step)
    const { over, under, push } = opts.prices ? opts.prices(step) : centre
    ladder.push({ line: step, over, under, push })

    const gap = Math.abs(centre.over - 0.5)
    if (gap < bestGap) {
      bestGap = gap
      fairLine = step
    }
    // Highest line where the over still clears. A push is neither side, so it
    // is already excluded from both probabilities and a whole number therefore
    // has to clear the bar on strictly beating the number — which is the
    // honest bar for a leg that can be voided.
    if (over >= bars.over && (overAt == null || step > overAt)) {
      overAt = step
      overProb = over
    }
    // Lowest line where the under still clears — its own bar, which may carry
    // a margin the over's does not.
    if (under >= bars.under && (underAt == null || step < underAt)) {
      underAt = step
      underProb = under
    }
  }

  return { fairLine, overAt, overProb, underAt, underProb, ladder }
}

/**
 * The most lopsided a pick'em pick can be and still exist.
 *
 * A pick'em app makes its money on the payout table, which only works if both
 * sides of every pick are plausible. It therefore does not post a prop whose
 * favoured side is a near-certainty: there is no NHL "goals 0.5" on PrizePicks
 * for a player who scores 0.25 a game, no matter that a sportsbook will happily
 * price that at -400.
 *
 * Without this bar the targets sorted by hit rate, so those were exactly the
 * props that came out on top, and the NHL board filled with 80-90% unders on
 * goals, power-play points and third-line assists: correct arithmetic, and not
 * a single one of them a pick you could place anywhere. The sportsbook side of
 * the app is untouched by this; it is a fact about pick'em boards, not about
 * the price being wrong.
 */
export const PICKEM_MAX_PROB = 0.8

/**
 * A prop the pick'em ceiling left out, named so it can be shown.
 *
 * The brief is that nothing disappears without being counted. A prop dropped
 * for being too lopsided is a judgement about what a board offers, and a
 * judgement the user can check is worth more than a silently shorter list —
 * particularly since the dial that made it is theirs to move.
 */
export interface LopsidedProp {
  key: string
  player: string
  market: MarketKey
  marketLabel: string
  gameId: string
  competition?: LeagueId
  /** The posted line that came closest to a coin flip. */
  line: number
  /** The favoured side's chance at that line, which is above the ceiling. */
  prob: number
}

/**
 * The line most of the books are hanging: the one a pick'em app copies. Ties
 * go to the line nearest the projection.
 */
export function marketLineOf(lines: number[], mean: number): number {
  const counts = new Map<number, number>()
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1)
  let best = lines[0]
  let bestCount = -1
  for (const [line, n] of counts) {
    if (n > bestCount || (n === bestCount && Math.abs(line - mean) < Math.abs(best - mean))) {
      best = line
      bestCount = n
    }
  }
  return best
}

/**
 * Index pick'em lines by player and market, with the game kept to one side.
 *
 * The key cannot be the game, because the lines come from a different feed
 * than the prices and two feeds rarely spell a team the same way. So the
 * lookup is still by name, and the game is used to CHOOSE among what the name
 * returns: see pickemLinesFor.
 */
function indexPickemLines(lines: PickemLine[] | undefined): Map<string, PickemLine[]> {
  const map = new Map<string, PickemLine[]>()
  for (const l of lines ?? []) {
    const k = `${l.playerKey || normalizeName(l.player)}|${l.market}`
    const arr = map.get(k)
    if (arr) arr.push(l)
    else map.set(k, [l])
  }
  return map
}

/**
 * The app lines that belong to THIS prop, and anything the row must say.
 *
 * A line from the same fixture always wins, matched on team nicknames so the
 * two feeds' spellings still meet. Failing that, a name that is unique on the
 * slate can only mean one person, so the line is used and the mismatch is the
 * feeds disagreeing about a team's name rather than a doubt about who played.
 *
 * When the name is NOT unique and no line can be tied to this fixture, nothing
 * is shown. Guessing there is how one player's entry gets built at another
 * player's line, which is a wrong price rather than a missing one, and the row
 * says so instead.
 */
export function pickemLinesFor(
  candidates: PickemLine[],
  gameId: string,
  nameIsAmbiguous: boolean,
): { lines: PickemLine[]; warning: string | null } {
  if (candidates.length === 0) return { lines: [], warning: null }
  const sameGame = candidates.filter((l) => sameGameId(l.gameId, gameId))
  // More than one FIXTURE matching is not a match, it is a collision: two
  // college teams can share a nickname, so "bulldogs at tigers" names several
  // games. Taking the union would hand this row the other player's line and
  // price it as a near-certainty, which is how an entry gets built at a number
  // that belongs to somebody else.
  const matchedGames = new Set(sameGame.map((l) => l.gameId))
  if (matchedGames.size > 1) {
    return {
      lines: [],
      warning:
        "Two games on this slate could be this player's, so no pick'em line can be tied to this one. Check the app yourself before entering it.",
    }
  }
  if (sameGame.length > 0) return { lines: sameGame, warning: null }
  if (nameIsAmbiguous) {
    return {
      lines: [],
      warning:
        "Another player on this slate has the same name, and no pick'em line could be tied to this game, so none is shown. Check the app yourself before entering this one.",
    }
  }
  return { lines: candidates, warning: null }
}

/**
 * Price each app line off the target's own distribution, and say how old it is.
 *
 * The age is the point of the timestamp. A pick'em app's line is only worth
 * acting on while the app is still posting it, and the feed's own timestamp is
 * the only evidence of that this app has. It was read and thrown away before,
 * so a line pulled three hours ago read exactly like one pulled a minute ago.
 */
export function priceAppLines(
  lines: PickemLine[],
  distribution: { pAtLeast(k: number): number; pmf(k: number): number },
  opts: { now?: number; staleMinutes?: number; prices?: (line: number) => LineProbabilities } = {},
): AppLine[] {
  const now = opts.now ?? Date.now()
  const staleAfter = opts.staleMinutes ?? DEFAULT_PICKEM_STALE_MINUTES
  return lines
    .map((l) => {
      const p = opts.prices ? opts.prices(l.line) : resolveLine(distribution as never, l.line)
      const posted = l.fetchedAt ? Date.parse(l.fetchedAt) : Number.NaN
      const ageMinutes = Number.isFinite(posted) ? Math.max(0, (now - posted) / 60_000) : null
      return {
        app: l.app,
        line: l.line,
        pickType: l.pickType,
        over: p.over,
        under: p.under,
        push: p.push,
        overMultiplier: l.over?.multiplier,
        underMultiplier: l.under?.multiplier,
        overOffered: l.over != null,
        underOffered: l.under != null,
        fetchedAt: l.fetchedAt,
        ageMinutes,
        isStale: ageMinutes != null && ageMinutes > staleAfter,
      }
    })
    .sort((a, b) => a.app.localeCompare(b.app) || a.line - b.line)
}

/**
 * How old a pick'em line may be before the row says so.
 *
 * The same default the sportsbook prices use, and for the same reason: past
 * about three quarters of an hour a posted number is a guess about the present
 * rather than a reading of it. Callers pass the user's own setting.
 */
export const DEFAULT_PICKEM_STALE_MINUTES = 45

/** The key coverage is recorded under: one game, one market. */
function coverageKey(gameId: string, market: MarketKey): string {
  return `${gameId}|${market}`
}

/**
 * Which apps' lines arrived for each game AND market, read off every prop on
 * the slate rather than only the targets.
 *
 * Coverage is the difference between "the app is not offering this prop" and
 * "we never heard", and the two lead to opposite decisions: the first leaves
 * the prop out of that app's entry, the second cannot. So getting it wrong in
 * either direction is expensive, and it was wrong in both.
 *
 * Per MARKET, because an app covering a game says nothing about which stats it
 * covers in it. PrizePicks will post points for every starter in a game and no
 * rebounds line in it at all; keyed on the game alone, every rebounds prop in
 * that game read as "offered, and this player is not on it". The game is still
 * matched on player, because two feeds spelling a team differently would
 * otherwise never agree on the fixture — but a name that belongs to two games
 * on the slate is attributed to the fixture its line actually names, and to
 * neither when that cannot be established.
 */
function pickemCoverage(quotes: FeedQuote[], lines: PickemLine[] | undefined): Map<string, Set<string>> {
  const gamesByPlayer = new Map<string, Set<string>>()
  for (const q of quotes) {
    const who = normalizeName(q.player)
    const set = gamesByPlayer.get(who) ?? new Set<string>()
    set.add(q.gameId)
    gamesByPlayer.set(who, set)
  }
  const byGameMarket = new Map<string, Set<string>>()
  for (const l of lines ?? []) {
    const games = gamesByPlayer.get(l.playerKey || normalizeName(l.player))
    if (!games) continue
    for (const g of attributedGames(l.gameId, games)) {
      const key = coverageKey(g, l.market)
      const set = byGameMarket.get(key) ?? new Set<string>()
      set.add(l.app)
      byGameMarket.set(key, set)
    }
  }
  return byGameMarket
}

/**
 * The posted line a pick'em app would actually copy, or null when none of them
 * is a line a board would show. See PICKEM_MAX_PROB.
 */
export function boardLine(
  postedLines: number[],
  mean: number,
  distribution: { pAtLeast(k: number): number; pmf(k: number): number },
  ceiling: number = PICKEM_MAX_PROB,
  prices?: (line: number) => LineProbabilities,
): { line: number; prob: number; overCeiling: boolean } | null {
  if (postedLines.length === 0) return null
  const probOf = (line: number) => {
    const p = prices ? prices(line) : resolveLine(distribution as never, line)
    return Math.max(p.over, p.under)
  }
  const modal = marketLineOf(postedLines, mean)
  const atModal = probOf(modal)
  if (atModal <= ceiling) return { line: modal, prob: atModal, overCeiling: false }
  // The modal line is one no app would post. Fall back to the posted line
  // closest to a coin flip, which is the one a board would choose.
  let best = modal
  let bestProb = atModal
  for (const line of postedLines) {
    const p = probOf(line)
    if (p < bestProb) {
      best = line
      bestProb = p
    }
  }
  return { line: best, prob: bestProb, overCeiling: bestProb > ceiling }
}

/** The pick'em board: the targets, and what the ceiling left out of them. */
export interface DfsBoard {
  targets: DfsTarget[]
  lopsided: LopsidedProp[]
}

/** The targets alone, for callers that do not care what was left out. */
export function buildDfsTargets(quotes: FeedQuote[], opts: BuildOptions): DfsTarget[] {
  return buildDfsBoard(quotes, opts).targets
}

export function buildDfsBoard(quotes: FeedQuote[], opts: BuildOptions): DfsBoard {
  const now = opts.now ?? Date.now()
  const ceiling = opts.pickemMaxProb ?? PICKEM_MAX_PROB
  const out: DfsTarget[] = []
  const lopsided: LopsidedProp[] = []
  const appIndex = indexPickemLines(opts.pickemLines)
  const coverage = pickemCoverage(quotes, opts.pickemLines)
  const ambiguous = ambiguousPlayers(quotes)

  for (const group of groupQuotes(quotes)) {
    const ref = referenceProjection(group, group.quotes, opts.value, now)
    if (!ref || ref.status !== "priced") continue

    const postedLines = Array.from(new Set(group.quotes.map((q) => q.line)))
    // Every chance on this row, at every line, by every opinion that has to
    // agree: with no market-making book, the retail books' as well as the
    // consensus's. See linePrices.
    const prices = (line: number) => linePrices(ref, line)
    const t = dfsTargetsFor(ref.mean, ref.distribution, sideBars(opts.dfsBreakEven, opts.underMargin), {
      postedLines,
      prices,
    })
    // A prop where neither side clears is not a target, it is a pass.
    if (t.overAt == null && t.underAt == null) continue

    const nameIsAmbiguous = ambiguous.has(normalizeName(group.player))
    const resolved = pickemLinesFor(
      appIndex.get(`${normalizeName(group.player)}|${group.market}`) ?? [],
      group.gameId,
      nameIsAmbiguous,
    )
    const appLines = priceAppLines(resolved.lines, ref.distribution, {
      now,
      staleMinutes: opts.value.projection.staleQuoteMinutes,
      prices,
    })
    const warnings = [
      nameIsAmbiguous
        ? `Another player on this slate normalises to the same name. This row is ${group.gameId.replace("@", " at ")} only.`
        : null,
      resolved.warning,
      // The books splitting is why a row's chance can sit below what its mean
      // suggests, so the row says so rather than leaving it to be guessed.
      ref.retailCheck?.warning ?? null,
    ].filter((w): w is string => !!w)

    // The line a pick'em app would hang: the one the books post most often,
    // unless that one is so lopsided no app would offer the prop at all, in
    // which case the best-balanced posted line is the one they would copy.
    // If no posted line is one a board could plausibly show, this is not a
    // pick'em target at any line — unless an app is demonstrably posting one,
    // because a real line beats a prior about what the line would be.
    const board = boardLine(postedLines, ref.mean, ref.distribution, ceiling, prices)
    if (board?.overCeiling && appLines.length === 0) {
      // Counted and named rather than quietly missing: see LopsidedProp.
      lopsided.push({
        key: group.key,
        player: group.player,
        market: group.market,
        marketLabel: MARKETS[group.market].label,
        gameId: group.gameId,
        competition: group.competition,
        line: board.line,
        prob: board.prob,
      })
      continue
    }
    const marketLine = board?.line ?? marketLineOf(postedLines, ref.mean)
    const atMarket = prices(marketLine)
    const marketSide = atMarket.over >= atMarket.under ? "OVER" : "UNDER"

    out.push({
      key: group.key,
      player: group.player,
      market: group.market,
      marketLabel: MARKETS[group.market].label,
      gameId: group.gameId,
      competition: group.competition,
      commenceTime: group.commenceTime,
      mean: ref.mean,
      sd: ref.sd,
      confidence: ref.confidence,
      referenceBooks: ref.books.map((b) => b.book),
      hasSharpBook: ref.hasSharpBook,
      marketLine,
      marketSide,
      marketProb: Math.max(atMarket.over, atMarket.under),
      appLines,
      warnings: warnings.length > 0 ? warnings : undefined,
      appCoverage: Array.from(coverage.get(coverageKey(group.gameId, group.market)) ?? []).sort(),
      ...t,
    })
  }

  // Most likely to hit first, at the line the app is most likely showing.
  return {
    targets: out.sort((a, b) => b.marketProb - a.marketProb),
    lopsided: lopsided.sort((a, b) => b.prob - a.prob),
  }
}

export interface PickemLeg {
  target: DfsTarget
  side: "OVER" | "UNDER"
  line: number
  prob: number
  /**
   * "app" when the line is the one the app is actually posting; "books" when
   * it is the sportsbooks' line, which only happens when the pull carried no
   * lines from the app at all. An entry never mixes the two: see pickemPlays.
   */
  source: "app" | "books"
}

/**
 * Everything on the slate that could be played on an app, and what the rest
 * fell at.
 *
 * The counts exist so nothing disappears silently. A target the app is not
 * offering and a target the app's lines never reached are both absent from the
 * entry and are not the same thing, and the screen can only say which if the
 * difference is carried out of here.
 */
export interface PickemPlays {
  plays: PickemLeg[]
  /**
   * True when the pull carried this app's own lines, so every play is at a
   * line the app is really posting. False when it carried none, so every play
   * is at the books' line and the screen says so.
   */
  live: boolean
  /** Targets the app covers in that game and market and is not posting: not playable there. */
  notOffered: number
  /** Targets the app's lines never arrived for at all. Unknown, not absent. */
  unknown: number
  /** Targets whose game had already started. */
  started: number
}

/**
 * The plays available on an app, each at a line that app is really posting.
 *
 * THE RULE: an entry is built at the app's own lines, or at the books' lines,
 * never at a mixture. When the pull carried the app's lines, a target without
 * one is left out — including one the app's lines simply never reached.
 *
 * It used to fall back to the books' line for exactly that case, reasoning
 * that unknown is not the same as absent. That is true, and it is still not a
 * line anyone can place: the card is headed with an app's name and a payout
 * table, and the expectation printed under it multiplies every leg's chance at
 * the line beside it. A leg at a number the app may not be posting makes that
 * number fiction, which is the one thing this app exists to refuse. In
 * practice it was most of the entry — half the lines on a PrizePicks card were
 * not PrizePicks lines — and there is no way to tell from the card which half.
 *
 * So the honest answer is a shorter entry, or none, and a count of what was
 * left out and why. Without any lines from the app, the books' line is all
 * there is and is still useful: it is the number to go and look for, and the
 * screen says that rather than claiming the app posts it.
 */
export function pickemPlays(
  targets: DfsTarget[],
  app?: string | null,
  now: number = Date.now(),
): PickemPlays {
  const live = hasAppLines(targets, app)
  const plays: PickemLeg[] = []
  let notOffered = 0
  let unknown = 0
  let started = 0
  for (const t of targets) {
    // A pick'em app stops taking picks once a game starts. The books may still
    // be pricing it in play, but no line from a started game can be entered.
    const starts = t.commenceTime ? Date.parse(t.commenceTime) : NaN
    if (Number.isFinite(starts) && starts <= now) {
      started++
      continue
    }
    if (!live) {
      plays.push({ target: t, side: t.marketSide, line: t.marketLine, prob: t.marketProb, source: "books" })
      continue
    }
    const p = appPlay(t, app!)
    if (p) {
      plays.push({ target: t, ...p, source: "app" })
    } else if ((t.appCoverage ?? []).includes(app!)) {
      notOffered++
    } else {
      unknown++
    }
  }
  return { plays, live, notOffered, unknown, started }
}

/**
 * The standard pick to make on a given app for a target: the side with the
 * better chance at the app's own line, among the sides the app offers at a
 * plain 1.0 payout. Goblins, demons and Underdog's boosted or discounted sides
 * pay differently and need their own bar, so they are never the entry's pick.
 * Null when the app has no standard line for this prop.
 */
export function appPlay(
  t: Pick<DfsTarget, "appLines">,
  app: string,
): { line: number; side: "OVER" | "UNDER"; prob: number } | null {
  let best: { line: number; side: "OVER" | "UNDER"; prob: number } | null = null
  for (const l of t.appLines ?? []) {
    if (l.app !== app || l.pickType !== "standard") continue
    if (l.overOffered && l.overMultiplier == null && (!best || l.over > best.prob)) {
      best = { line: l.line, side: "OVER", prob: l.over }
    }
    if (l.underOffered && l.underMultiplier == null && (!best || l.under > best.prob)) {
      best = { line: l.line, side: "UNDER", prob: l.under }
    }
  }
  return best
}

/**
 * The answer for a target at an app's own line, by the same rule the entry
 * uses: a side is named only if the app offers it as a standard 1.0 pick and
 * it clears the bar. Otherwise it is a pass, with the reason, because a side
 * Underdog discounts to 0.85x needs a far higher hit rate than the standard
 * bar, and a side the app does not offer cannot be played at all. Null when
 * the app has no standard line for this prop.
 */
export function appVerdict(
  t: Pick<DfsTarget, "appLines">,
  app: string,
  bar: number | SideBars,
): { line: number; side: "OVER" | "UNDER" | null; prob: number | null; reason: string | null } | null {
  const bars = asBars(bar)
  const lines = (t.appLines ?? []).filter((l) => l.app === app && l.pickType === "standard")
  if (lines.length === 0) return null
  const play = appPlay(t, app)
  if (play && play.prob >= barFor(bars, play.side)) return { line: play.line, side: play.side, prob: play.prob, reason: null }
  const l = lines.find((x) => x.line === play?.line) ?? lines[0]
  const favoured = l.over >= l.under ? "over" : "under"
  const offered = favoured === "over" ? l.overOffered : l.underOffered
  const multiplier = favoured === "over" ? l.overMultiplier : l.underMultiplier
  // An under that clears the bar and not the margin on top of it is a pass
  // for a reason of your own making, and the row should say that rather than
  // "neither side clears", which would be false at the bar itself.
  const heldBack = play?.side === "UNDER" && play.prob >= bars.over && play.prob < bars.under
  const reason = !offered
    ? `the ${favoured} is not offered`
    : multiplier != null
      ? `the ${favoured} pays ×${multiplier}, which needs its own bar`
      : heldBack
        ? `the under clears the bar but not your margin for unders (needs ${Math.round(bars.under * 1000) / 10}%)`
        : "neither side clears"
  return { line: l.line, side: null, prob: null, reason }
}

/** True when the pull carried any lines from this app, so a missing line means "not offered". */
export function hasAppLines(targets: Pick<DfsTarget, "appLines">[], app: string | null | undefined): boolean {
  return !!app && targets.some((t) => (t.appLines ?? []).some((l) => l.app === app))
}

/**
 * A pick'em entry to play: the likeliest plays that clear the bar.
 *
 * One leg per player, so it never holds both sides of anything, and at most
 * two per game, so one blowout cannot sink the whole entry. Null when fewer
 * plays clear the bar than the entry needs: a short entry padded with coin
 * flips is the bet the bar exists to stop.
 *
 * Every leg is at a line the named app is really posting, or — when the pull
 * carried none of that app's lines — every leg is at the books' line. Never a
 * mixture of the two. See pickemPlays for why, and for what gets left out.
 */
export function buildPickemEntry(
  targets: DfsTarget[],
  size: number,
  bar: number | SideBars,
  maxPerGame = 2,
  app?: string | null,
  now: number = Date.now(),
): PickemLeg[] | null {
  const { plays } = pickemPlays(targets, app, now)
  const bars = asBars(bar)

  const legs: PickemLeg[] = []
  const players = new Set<string>()
  const games = new Map<string, number>()
  for (const play of plays.sort((a, b) => b.prob - a.prob)) {
    if (legs.length >= size) break
    // Sorted by chance, so below the lower of the two bars nothing further
    // can clear; between them, only an over can.
    if (play.prob < Math.min(bars.over, bars.under)) break
    if (play.prob < barFor(bars, play.side)) continue
    const t = play.target
    // Per player, not per name: two same-named players in different games are
    // two people, and the second must not be excluded as a duplicate.
    const who = playerKeyIn(t.player, t.gameId)
    if (players.has(who) || (games.get(t.gameId) ?? 0) >= maxPerGame) continue
    players.add(who)
    games.set(t.gameId, (games.get(t.gameId) ?? 0) + 1)
    legs.push(play)
  }
  return legs.length === size ? legs : null
}

/** The chance a side hits at a given line, if the line is one the target priced. */
export function probAt(t: Pick<DfsTarget, "ladder">, line: number, side: "OVER" | "UNDER"): number | null {
  const step = t.ladder.find((r) => Math.abs(r.line - line) < 1e-9)
  return step ? (side === "OVER" ? step.over : step.under) : null
}

/**
 * The chance a line lands exactly on itself, voiding the leg.
 *
 * Zero on a half-point line, which is most of them. On a whole number it is
 * the single most important thing about the line and the app used to have no
 * way to say it: a voided leg does not lose an all-or-nothing entry, it
 * shrinks it, and the multiplier shrinks with it.
 */
export function pushAt(t: Pick<DfsTarget, "ladder">, line: number): number | null {
  const step = t.ladder.find((r) => Math.abs(r.line - line) < 1e-9)
  return step ? step.push : null
}

/**
 * Turn value bets into optimizer legs.
 *
 * The odds feed does not say which team a player is on, so team-level
 * correlation cannot be detected here. The game id can, and same-game is the
 * dominant effect for a parlay, so that is what the correlation model sees.
 */
export function valueBetsToCandidates(bets: ValueBet[]): CandidateLeg[] {
  return bets.map((b) => ({
    id: b.id,
    player: b.player,
    team: null,
    opponent: null,
    gameId: b.gameId,
    market: b.market,
    marketLabel: b.marketLabel,
    line: b.line,
    side: b.side,
    pWin: b.fairProb,
    pPush: 0,
    american: b.price,
    status: "priced" as const,
    competition: b.competition,
    confidence: b.confidence,
    lineEdge: b.side === "OVER" ? b.consensusMean - b.line : b.line - b.consensusMean,
    lineEdgeZ:
      (b.side === "OVER" ? b.consensusMean - b.line : b.line - b.consensusMean) / Math.max(b.consensusSd, 1e-9),
    app: b.bookName,
  }))
}

/**
 * The quotes from games that have not started. A cached pull outlives tip-off,
 * and once a game is live its pregame prices are stale and the pick'em apps have
 * closed it, so nothing from it should still be offered as a pick.
 */
export function upcomingQuotes<Q extends { commenceTime?: string | null }>(quotes: Q[], now: number): Q[] {
  return quotes.filter((q) => notStarted(q.commenceTime, now))
}

export function buildDailyPicks(quotes: FeedQuote[], opts: BuildOptions): DailyPicks {
  const now = opts.now ?? Date.now()
  const games = summariseGames(quotes)
  const groups = groupQuotes(quotes)

  const everyValue = findValueBets(quotes, opts.value, now)
  // References judge the price; only books you can use are offered as the bet.
  const bettable = opts.bettableBooks ? new Set(opts.bettableBooks) : null
  const allValue = bettable ? everyValue.filter((b) => bettable.has(b.book)) : everyValue
  // One decision per prop, then most likely to hit first. Edge is still on
  // every row; probability is what the list is read by.
  const valueBets = bestPerSelection(allValue).sort((a, b) => b.fairProb - a.fairProb)

  // Parlays are built only from legs that are individually +EV. Stacking legs
  // that are each a small loss into a parlay multiplies the loss; there is no
  // combination of bad bets that becomes a good one.
  const parlayConstraints: OptimizerConstraints = {
    ...opts.constraints,
    minLegProb: opts.parlayMinLegProb ?? PARLAY_MIN_LEG_PROB,
  }

  // Parlays are built one book at a time, because you cannot combine a leg at
  // one sportsbook with a leg at another into a single ticket. Taking the best
  // price for each leg across books produces a parlay nobody can actually
  // place. Within a book, every leg is priced at that book's own number, and
  // the best parlay across all books wins.
  const perBook = new Map<string, ValueBet[]>()
  for (const b of allValue) {
    const arr = perBook.get(b.book)
    if (arr) arr.push(b)
    else perBook.set(b.book, [b])
  }

  const parlays: BuiltSlip[] = []
  for (const [book, bets] of perBook) {
    const candidates = valueBetsToCandidates(bestPerSelection(bets))
    if (candidates.length < parlayConstraints.picks) continue
    parlays.push(
      ...optimizeSlips(candidates, {
        // Each ticket is placed at one book, so it pays that book's commission.
        parlay: { commission: opts.value.commission?.[book] ?? opts.parlayCommission ?? 0 },
        constraints: parlayConstraints,
        correlation: opts.correlation,
        objectives: ["ev", "growth"],
        count: 2,
      }),
    )
  }
  parlays.sort((a, b) => b.evaluation.ev - a.evaluation.ev)
  const topParlays = parlays.slice(0, opts.parlayCount ?? 4)

  const board = buildDfsBoard(quotes, opts)

  const booksSeen = Array.from(new Set(quotes.map((q) => q.book))).sort()
  let pricedProps = 0
  for (const g of groups) {
    const ref = referenceProjection(g, g.quotes, opts.value, now)
    if (ref?.status === "priced") pricedProps++
  }

  return {
    games,
    valueBets,
    parlays: topParlays,
    dfsTargets: board.targets,
    lopsided: board.lopsided,
    stats: {
      quotes: quotes.length,
      props: groups.length,
      booksSeen,
      pricedProps,
      hiddenOffers: everyValue.length - allValue.length,
      hiddenBooks: Array.from(new Set(everyValue.filter((b) => !allValue.includes(b)).map((b) => b.book))).sort(),
    },
  }
}

/**
 * The one thing to do with a target, given the line your pick'em app is
 * showing: take the over, take the under, or pass.
 *
 * A target carries both thresholds, an over at or below one number and an
 * under at or above a higher one. Printed side by side they read as two
 * picks, and people played both. Against a real line only one can apply,
 * and between the two thresholds neither does.
 */
export function dfsVerdict(t: Pick<DfsTarget, "overAt" | "underAt" | "fairLine">, appLine: number): "OVER" | "UNDER" | "PASS" {
  if (!Number.isFinite(appLine)) return "PASS"
  const over = t.overAt != null && appLine <= t.overAt
  const under = t.underAt != null && appLine >= t.underAt
  // Both can only hold if the bar sits below a coin flip, which no payout
  // table does; if it ever happens, the side further from fair wins.
  if (over && under) return appLine < t.fairLine ? "OVER" : "UNDER"
  return over ? "OVER" : under ? "UNDER" : "PASS"
}

/** Fair price for a target line, for display beside the DFS numbers. */
export function fairPriceAt(prob: number | null): number | null {
  return prob == null ? null : probToAmerican(prob)
}
