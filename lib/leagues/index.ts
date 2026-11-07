import type { MarketKey, Sport } from "@/lib/nba/markets"

/**
 * League configuration.
 *
 * Everything that differs between leagues lives here, so adding one is mostly
 * a data change rather than a code change. The engine itself is league-agnostic:
 * it prices a distribution against a line, and a line is a line whoever posted it.
 *
 * What genuinely differs is the SHAPE of the distribution, and it differs for
 * reasons worth stating rather than fudging:
 *
 *   Volatility. The same projected mean deserves a wider distribution, and
 *   therefore a probability closer to 50%, in a league where usage is less
 *   predictable. That is dispersionScale.
 *
 *   A different sport (NFL). Football markets are their own stats with their
 *   own spreads (see lib/nba/markets), so the NFL needs no scaling of the
 *   basketball numbers: its scales are 1 and its markets are its own.
 *
 *   Market depth. The NBA has props on every book at every game. The NFL is the
 *   deepest prop market there is, but posts a week ahead and moves hard on
 *   injury news. College football is priced for the games on television and
 *   barely at all for the rest. Asking for markets a league does not post is at
 *   best a wasted request and may be a wasted credit.
 *
 * COMPANIONS. A league can carry other competitions that are pulled in the
 * same press and priced in the same tables, because they are the same sport
 * played the same week: college football sits inside the NFL section. A
 * companion keeps its own priors, caps and game cap, so a CFB prop is never
 * priced with NFL numbers. See `competitionsFor`.
 */

/** The leagues Today can pull and price. */
export type LeagueId = "nba" | "nfl" | "cfb"

/**
 * Leagues that are gone from Today but still have to read back.
 *
 * A league is removed from LEAGUES when it stops being worth pulling, and the
 * NHL was: its markets are thin where a pick'em app will post them, and the
 * effort belongs on the NBA. What CANNOT be removed with it is the ability to
 * read an entry that was already logged. Settled history is the only thing in
 * this app that can tell you the model was wrong, so dropping the hockey
 * reading would quietly destroy the only evidence worth keeping.
 *
 * This matters more for hockey than it did for the WNBA. A WNBA screen's
 * "Points" really is the basketball market, so forgetting the league costs
 * nothing. An NHL screen's "Points", "Assists" and "Blocked Shots" are
 * different stats with different spreads, and read as basketball they would be
 * silently mis-typed. Hence a retired league keeps its sport, and nothing else.
 */
export type RetiredLeagueId = "nhl"

/** A league id that can appear on a logged entry, pullable or retired. */
export type LoggedLeagueId = LeagueId | RetiredLeagueId

export interface RetiredLeague {
  id: RetiredLeagueId
  label: string
  short: string
  sport: Sport
  /** Shown wherever a logged entry still names it, so it reads as retired rather than broken. */
  note: string
}

export const RETIRED_LEAGUES: Record<RetiredLeagueId, RetiredLeague> = {
  nhl: {
    id: "nhl",
    label: "NHL",
    short: "NHL",
    sport: "hockey",
    note: "The NHL is no longer pulled or priced. Logged NHL entries still read and settle, so the tracker can still tell you how they went.",
  },
}

export interface LeagueConfig {
  id: LeagueId
  label: string
  /** Badge text. */
  short: string
  /** The Odds API sport key. */
  sportKey: string
  /** Which family of markets the league uses. */
  sport: Sport
  /** Regulation length in minutes. */
  gameMinutes: number
  /**
   * Multiplier on each market's league-wide typical mean.
   *
   * Used only where no market price exists, as a prior and for plausibility
   * warnings.
   */
  meanScale: number
  /** Multiplier on each market's variance/mean ratio. See the note above. */
  dispersionScale: number
  /**
   * Feed market keys this league posts often enough to be worth asking for,
   * when the feed bills per market per game.
   *
   * This list is a budget, not an opinion about what exists. The Odds API
   * charges markets x games, so every entry here multiplies the cost of a
   * press by the size of the slate.
   */
  markets: string[]
  /**
   * The markets to ask for when the feed bills per REQUEST instead.
   *
   * PropLine charges one request per game whatever the market list, so the
   * budget above buys nothing there and breadth is free. Asking narrowly on a
   * feed that does not charge for width is pure loss: every market left out is
   * a pick'em line that could have been read and was not, and the entry is
   * built only at lines an app is really posting, so a market nobody asked for
   * is a leg that cannot be played.
   *
   * Omit where the league has nothing more worth asking for.
   */
  deepMarkets?: string[]
  /** Books that reliably post player props for this league. */
  books: string[]
  /** Default cap on games per pull, sized to the league's slate and the credit cost. */
  maxGames: number
  /**
   * The default game cap when the feed bills per REQUEST instead.
   *
   * Same split as `markets` / `deepMarkets`, and for the same reason. The Odds
   * API charges markets x games, so the cap above is half of a credit budget:
   * raising it raises the bill by a whole market list per game. PropLine
   * charges one request per game, so a game costs a single request out of
   * 1,000 a day and the budget buys nothing — the only sensible cap there is
   * the whole slate.
   *
   * This matters more than it looks, because the cap is not a quality filter.
   * Only a depth-ranked competition picks which games to spend it on; everyone
   * else takes them in start order, so a cap below the slate size drops the
   * latest game rather than the worst one. On a 15-game NBA night that is the
   * late West Coast tip, every time.
   *
   * Omit where the league's own cap already covers its biggest slate.
   */
  deepMaxGames?: number
  /** Rough games on a busy in-season day, used for the quota warning. */
  typicalSlate: number
  /** Months (1-12) the league is normally in season, for the off-season notice. */
  season: number[]
  /** Plausibility ceilings for the "this projection is not believable" warning. */
  caps: Partial<Record<MarketKey, number>>
  /** Shown in the UI so the league's specific caveat is never hidden. */
  note: string
  /**
   * Other competitions pulled and priced alongside this one, in the same
   * press. Never a tab of its own: a companion appears inside this league's
   * section. Each is priced with its own config.
   */
  companions?: LeagueId[]
  /** True when this league is only ever shown inside another league's section. */
  companionOnly?: boolean
  /**
   * Choose which games to price by how deep their market is, rather than by
   * who starts first.
   *
   * Worth one extra credit only where the slate is far bigger than the cap and
   * the games differ wildly in whether anyone prices them: a college Saturday
   * lists fifty games and a handful carry real props. On a 13-game NFL Sunday
   * the cap takes nearly everything anyway, so there is nothing to rank.
   */
  depthRanked?: boolean
}

const NBA_BOOKS = ["pinnacle", "betonlineag", "lowvig", "draftkings", "fanduel", "betmgm", "caesars", "espnbet"]

/**
 * The NBA markets to ask a per-request feed for.
 *
 * THE TEST IS WHETHER A SPORTSBOOK PRICES IT, not whether a pick'em app posts
 * it. That is the opposite of how this list was first written, and the
 * difference is the whole app: a pick'em line with no book behind it cannot be
 * priced, cannot become a target, and cannot be bet on with any more
 * information than the app had before it was pulled. Asking for one produces
 * lines that are unusable by construction.
 *
 * Turnovers is why this comment exists. It was on this list because PrizePicks
 * posts it heavily — a fade-the-star market DFS apps love — and a real pull
 * came back with 85 PrizePicks turnovers lines and not one sportsbook
 * turnovers quote. Every one of those 85 was dropped, correctly and uselessly.
 * It is off the list until there is evidence a book prices it.
 *
 * Field goals made and free throws made went the same way, on the same kind
 * of evidence: a real PropLine NBA pull priced every other market on this
 * list and came back with not one sportsbook quote for either. They are off
 * until a book is shown to price them, and can be typed into Settings →
 * Markets by anyone whose books do.
 *
 * Points, rebounds, assists and threes are the board's spine and every book
 * posts them. The four combos are most of the rest of a PrizePicks NBA board
 * and are widely posted; they are modelled with their own correlation between
 * the components, so they price properly rather than as a sum of independent
 * parts. Steals, blocks and steals+blocks are thinner, and came back priced
 * in that same pull.
 */
const NBA_DEEP_MARKETS = [
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_threes",
  "player_points_rebounds_assists",
  "player_points_rebounds",
  "player_points_assists",
  "player_rebounds_assists",
  "player_steals",
  "player_blocks",
  "player_blocks_steals",
  // "player_turnovers", "player_field_goals" and "player_frees_made" are
  // deliberately absent: see above.
]

const FOOTBALL_MARKETS = ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions"]

export const LEAGUES: Record<LeagueId, LeagueConfig> = {
  nba: {
    id: "nba",
    label: "NBA",
    short: "NBA",
    sportKey: "basketball_nba",
    sport: "basketball",
    gameMinutes: 48,
    meanScale: 1,
    dispersionScale: 1,
    // The spine of the board, plus the combo every pick'em app leads with.
    // Five markets across a full 14-game night is about 70 credits, under the
    // share of a month that makes the button stop and ask. The rest of the
    // board is in NBA_DEEP_MARKETS and costs nothing on a per-request feed.
    markets: [
      "player_points",
      "player_rebounds",
      "player_assists",
      "player_threes",
      "player_points_rebounds_assists",
    ],
    deepMarkets: NBA_DEEP_MARKETS,
    books: NBA_BOOKS,
    // 30 teams, so 15 games is the largest night the NBA can have, and that is
    // the cap on a per-request feed: 16 requests of PropLine's 1,000 a day.
    // The Odds API cap stays at 14 because the fifteenth game there costs a
    // whole market list — 15 x 5 is 75 credits, exactly the 15% of a month
    // that makes the button ask, and a default press that asks every time
    // trains you to click through the one gate that protects the quota.
    maxGames: 14,
    deepMaxGames: 15,
    typicalSlate: 11,
    season: [10, 11, 12, 1, 2, 3, 4, 5, 6],
    // Ceilings on a plausible projected mean, not on a plausible game. They
    // sit above anything a real starter projects at and below arithmetic that
    // has gone wrong, which is all a "this is not believable" warning can do.
    caps: {
      PTS: 60, REB: 30, AST: 25, "3PM": 14, STL: 8, BLK: 10, TOV: 12,
      FGM: 25, FTM: 25, PRA: 80, PR: 70, PA: 70, RA: 40, STL_BLK: 15,
    },
    note: "Deepest basketball prop market, and the league this board is built for. Every game is priced by every book, so the consensus is meaningful and stale lines are rare. On PropLine the whole board is pulled, because width costs nothing there; on The Odds API it is the five markets with the deepest pick'em interest, and the rest can be added under Settings.",
  },
  nfl: {
    id: "nfl",
    label: "NFL",
    short: "NFL",
    sportKey: "americanfootball_nfl",
    sport: "football",
    gameMinutes: 60,
    // NFL markets carry their own typical means and spreads, so nothing from
    // basketball is scaled across.
    meanScale: 1,
    dispersionScale: 1,
    // The four markets with the deepest pricing and the most pick'em interest,
    // and the four every pick'em app and FanDuel post. Touchdowns, completions,
    // attempts, carries and interceptions are mapped too; add their feed keys
    // under Settings to pull them.
    markets: FOOTBALL_MARKETS,
    books: NBA_BOOKS,
    // A full Sunday is 13 or 14 games. Four markets across all of them is about
    // 56 credits, the same as a full NBA night.
    maxGames: 14,
    typicalSlate: 13,
    season: [9, 10, 11, 12, 1, 2],
    caps: {
      PASS_YDS: 550, PASS_TDS: 7, PASS_COMP: 45, PASS_ATT: 65, PASS_INT: 5,
      RUSH_YDS: 300, RUSH_ATT: 40, REC: 18, REC_YDS: 300, RUSH_REC_YDS: 350,
    },
    // College football rides along: same sport, same markets, same Saturday-to-
    // Monday week, and the pick'em apps post both on one board.
    companions: ["cfb"],
    note: "Games are mostly Sunday, plus Thursday and Monday nights, so most days have nothing to pull. College football is pulled with it and priced with its own numbers. Props post days ahead and move hard on injury news: a line pulled days out is widened for that, but refresh on game day. The feed does not say which team a player is on, so a quarterback and his own receiver are only linked as same-game, not as a stack.",
  },
  cfb: {
    id: "cfb",
    label: "College football",
    short: "CFB",
    sportKey: "americanfootball_ncaaf",
    sport: "football",
    gameMinutes: 60,
    meanScale: 1,
    // Wider than the NFL at the same projected mean, and this is the single
    // most important thing to get right about college football. The talent gap
    // between the two rosters is often enormous, starters sit out the fourth
    // quarter of a blowout, and the backfield split is far less knowable than
    // in the NFL. All three widen the outcome and pull every probability back
    // toward a coin flip, which is the honest answer here.
    //
    // UNFITTED: 1.2 is reasoned from those three facts, not measured against
    // realised results. The tracker's per-competition calibration is where it
    // gets checked once there are enough settled college legs to check it
    // with; until then it is a prior and is labelled as one on screen.
    dispersionScale: 1.2,
    // The NFL's four. Receptions and receiving yards are thin away from the
    // televised games, but the games this section actually prices are the
    // televised ones — that is what the depth ranking selects for — so asking
    // for all four is asking where the answers are.
    markets: FOOTBALL_MARKETS,
    books: NBA_BOOKS,
    // A Saturday has 50 or more games and only the televised ones carry real
    // prop pricing, so the cap stays small: six games at four markets is 24
    // credits on top of the NFL pull, which takes a full Sunday press to 80 —
    // past the point where the button asks before spending.
    maxGames: 6,
    typicalSlate: 45,
    season: [8, 9, 10, 11, 12, 1],
    // A 500-yard passing game and a 300-yard rushing game both happen in
    // college football, so NFL ceilings would flag real outcomes as implausible.
    caps: {
      PASS_YDS: 650, PASS_TDS: 9, PASS_COMP: 55, PASS_ATT: 75, PASS_INT: 6,
      RUSH_YDS: 400, RUSH_ATT: 45, REC: 20, REC_YDS: 350, RUSH_REC_YDS: 450,
    },
    companionOnly: true,
    depthRanked: true,
    note: "Priced inside the NFL section with its own, wider numbers. Only the games on television carry real prop pricing, so most of a Saturday slate comes back unpriced and is correctly left out. Blowouts are routine and starters sit: treat a projection here as less certain than the same number in the NFL.",
  },
}

export const LEAGUE_IDS = Object.keys(LEAGUES) as LeagueId[]

/**
 * Leagues that get a tab of their own. A companion competition is pulled and
 * priced inside its parent's section, so it is not one of these.
 */
export const TAB_LEAGUE_IDS = LEAGUE_IDS.filter((id) => !LEAGUES[id].companionOnly)

/**
 * Every league id a logged entry may carry: the pullable ones, then the
 * retired ones. The log form offers these, so an NHL entry can still be typed
 * in or read off a screenshot.
 */
export const LOGGED_LEAGUE_IDS: LoggedLeagueId[] = [
  ...LEAGUE_IDS,
  ...(Object.keys(RETIRED_LEAGUES) as RetiredLeagueId[]),
]

export const DEFAULT_LEAGUE: LeagueId = "nba"

export function isLeagueId(v: unknown): v is LeagueId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(LEAGUES, v)
}

/** Resolve a league id, falling back to the NBA rather than throwing. */
export function leagueFor(id: unknown): LeagueConfig {
  return isLeagueId(id) ? LEAGUES[id] : LEAGUES[DEFAULT_LEAGUE]
}

/** Sport key for the feed, or null if the id is not one we support. */
export function sportKeyFor(id: unknown): string | null {
  return isLeagueId(id) ? LEAGUES[id].sportKey : null
}

export function isRetiredLeagueId(v: unknown): v is RetiredLeagueId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(RETIRED_LEAGUES, v)
}

/** True for any league a logged entry may name, pullable or retired. */
export function isLoggedLeagueId(v: unknown): v is LoggedLeagueId {
  return isLeagueId(v) || isRetiredLeagueId(v)
}

/** "NBA", "College football", "NHL" — whichever kind of league id this is. */
export function loggedLeagueLabel(id: LoggedLeagueId): string {
  return isRetiredLeagueId(id) ? RETIRED_LEAGUES[id].label : LEAGUES[id].label
}

/** Badge text for either kind of league id. */
export function loggedLeagueShort(id: LoggedLeagueId): string {
  return isRetiredLeagueId(id) ? RETIRED_LEAGUES[id].short : LEAGUES[id].short
}

/**
 * The sport a logged league's stats belong to.
 *
 * This is the whole reason retired leagues are kept: it decides whether the
 * "Points" on a logged entry is the basketball market or the hockey one.
 */
export function sportOfLoggedLeague(id: LoggedLeagueId): Sport {
  return isRetiredLeagueId(id) ? RETIRED_LEAGUES[id].sport : LEAGUES[id].sport
}

/**
 * Every competition one press of this league's button pulls: the league itself
 * first, then its companions. One entry for a league with no companions, so
 * callers can always loop.
 *
 * Companions are OPT-IN and off unless asked for. A companion costs real feed
 * credits, and the default for anything that spends money is not to. A caller
 * that forgets the flag therefore under-pulls rather than over-bills, which is
 * the cheaper mistake of the two.
 */
export function competitionsFor(id: LeagueId, opts: { companions?: boolean } = {}): LeagueConfig[] {
  const league = LEAGUES[id]
  if (!opts.companions) return [league]
  return [league, ...(league.companions ?? []).map((c) => LEAGUES[c])]
}

/** The companions this league would add, which is nothing unless it has any. */
export function companionsOf(id: LeagueId): LeagueConfig[] {
  return (LEAGUES[id].companions ?? []).map((c) => LEAGUES[c])
}

/**
 * Is the league plausibly in season on this date?
 *
 * Used only to explain an empty slate. An empty response in July from the NBA
 * is the off-season; the same response in January is a real problem worth
 * looking at. Telling the two apart saves a pointless debugging session. A
 * league whose companion is in season counts as in season, because the press
 * will still return a slate.
 */
export function inSeason(id: LeagueId, when: Date = new Date(), opts: { companions?: boolean } = {}): boolean {
  const month = when.getUTCMonth() + 1
  return competitionsFor(id, opts).some((l) => l.season.includes(month))
}

/**
 * What a full pull of this league would cost, and whether that is reckless.
 *
 * Player props are billed per market per event. The free tier is 500 requests a
 * month. A full NFL Sunday is 14 games, plus six college games pulled with it;
 * at four markets that is 80 credits in one press, and a handful of careless
 * refreshes empties the month. This is the single most expensive mistake
 * available in the app, so it is computed up front and shown before the button
 * is pressed rather than discovered afterwards.
 */
export interface CompetitionPlan {
  league: LeagueConfig
  /** Games this competition would be asked for. */
  games: number
}

/**
 * What one press of this league's button would pull, per competition.
 *
 * The league's own cap is the dial on the Today screen; a companion keeps the
 * cap sized to its own slate. Returned per competition rather than as a single
 * number because each competition can be asked for a different market list,
 * and credits are billed per market per game: multiplying a combined game
 * count by one market count overstates the cheap competition and understates
 * the expensive one.
 */
export function pullPlan(id: LeagueId, primaryCap: number, opts: PullBreadth = {}): CompetitionPlan[] {
  return competitionsFor(id, opts).map((league) => ({
    league,
    games: league.id === id ? Math.max(0, primaryCap) : maxGamesFor(league, opts),
  }))
}

/** Games one press would pull, across every competition in the plan. */
export function plannedGames(id: LeagueId, primaryCap: number, opts: PullBreadth = {}): number {
  return pullPlan(id, primaryCap, opts).reduce((a, p) => a + p.games, 0)
}

/**
 * How wide a press asks, which on both axes is a question about billing.
 *
 * `billsPerRequest` is the same flag the market list resolves against (see
 * MarketBreadth in lib/odds-feed/theoddsapi), named the same way on purpose:
 * games and markets are the two factors of The Odds API's bill and neither is
 * a factor of PropLine's.
 */
export interface PullBreadth {
  companions?: boolean
  /** True for a feed billed per request rather than per market per game. */
  billsPerRequest?: boolean
}

/**
 * The default game cap for a competition on this feed.
 *
 * A league with no per-request cap of its own keeps the one cap it has, so
 * this is safe to call for every competition rather than only the ones that
 * drew the distinction.
 */
export function maxGamesFor(competition: LeagueConfig, opts: PullBreadth = {}): number {
  return opts.billsPerRequest ? (competition.deepMaxGames ?? competition.maxGames) : competition.maxGames
}

/** The same, from a league id, falling back to the NBA rather than throwing. */
export function maxGamesForLeague(id: unknown, opts: PullBreadth = {}): number {
  return maxGamesFor(leagueFor(id), opts)
}

/**
 * The cap to store for a league when the feed changes under it.
 *
 * A cap the user chose is theirs and travels unchanged -- someone who set five
 * games meant five, and a feed switch is not permission to overrule them. A
 * cap that is only the OTHER feed's default was never a choice, it is a seed,
 * and leaving it stranded is how a PropLine slate ends up capped for credits
 * that PropLine does not charge. So the seed follows the feed and a choice
 * does not, which needs no flag recording whether the slider was ever touched.
 */
export function reseedGameCap(competition: LeagueConfig, stored: number, opts: PullBreadth = {}): number {
  const seeded = maxGamesFor(competition, { ...opts, billsPerRequest: !opts.billsPerRequest })
  return stored === seeded ? maxGamesFor(competition, opts) : stored
}

/**
 * Share of a month one pull may spend before the button has to ask first.
 *
 * Seven presses at this size empty the month, which is a fortnight of casual
 * refreshing. Above it the spend stops being a note beside the button and
 * becomes a question the button asks, because a note is read after the credits
 * are gone and a question is answered before.
 */
export const CONFIRM_PCT_OF_QUOTA = 0.15

export interface CreditPlan {
  credits: number
  pctOfQuota: number
  /** Worth shouting about: a quarter of the month in one press. */
  severe: boolean
  /** The button must ask before spending this. */
  confirm: boolean
  /** Shown beside the button. Null when the spend is unremarkable. */
  message: string | null
  /** Shown in the confirm dialog. Null when no confirm is needed. */
  prompt: string | null
}

/** The cost of a pull whose credits are already totted up across competitions. */
export function creditPlan(id: LeagueId, credits: number, monthlyQuota = 500): CreditPlan {
  const spend = Math.max(0, Math.round(credits))
  const pctOfQuota = monthlyQuota > 0 ? spend / monthlyQuota : 0
  const pct = Math.round(pctOfQuota * 100)
  const confirm = pctOfQuota >= CONFIRM_PCT_OF_QUOTA
  const prompt = confirm
    ? `This pull spends about ${spend} feed credits, ${pct}% of a 500-request month, and ${Math.ceil(1 / Math.max(pctOfQuota, 1e-9))} presses like it would empty the month. Lower the game cap or the market count in Settings to spend less. Pull anyway?`
    : null
  if (spend === 0) return { credits: spend, pctOfQuota, severe: false, confirm: false, message: null, prompt: null }
  if (pctOfQuota >= 0.25) {
    return {
      credits: spend,
      pctOfQuota,
      severe: true,
      confirm,
      message: `This pull costs about ${spend} feed credits, roughly ${pct}% of a 500-request month. ${LEAGUES[id].label} slates are large; lower the game cap or the market count before refreshing often.`,
      prompt,
    }
  }
  if (pctOfQuota >= 0.1) {
    return {
      credits: spend,
      pctOfQuota,
      severe: false,
      confirm,
      message: `About ${spend} feed credits, ${pct}% of a 500-request month.`,
      prompt,
    }
  }
  return { credits: spend, pctOfQuota, severe: false, confirm: false, message: null, prompt: null }
}

/** The same, for a pull whose every competition shares one market list. */
export function creditWarning(id: LeagueId, games: number, markets: number, monthlyQuota = 500): CreditPlan {
  return creditPlan(id, Math.max(0, games) * Math.max(0, markets), monthlyQuota)
}

/**
 * Scale a market's league-wide prior mean into this league.
 *
 * Only ever a fallback. If a sportsbook has priced the prop, the market's own
 * implied mean is used and this never runs.
 */
export function scaleMean(id: LeagueId, typicalMean: number): number {
  return typicalMean * LEAGUES[id].meanScale
}
