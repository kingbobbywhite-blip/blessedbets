import { DEFAULT_CORRELATION, type CorrelationSettings } from "@/lib/quant/correlation"
import { DEFAULT_CONSTRAINTS, type OptimizerConstraints } from "@/lib/quant/optimizer"
import { DEFAULT_APPS, validateCapture, type BookApp, type CapturedPayout } from "@/lib/quant/payouts"
import { DEFAULT_PROJECTION_SETTINGS, type ProjectionSettings, type RawPropRow } from "@/lib/quant/projection"
import { MARKETS, type MarketKey } from "@/lib/nba/markets"
import type { FeedQuote } from "@/lib/quant/valuebets"
import type { PickemLine } from "@/lib/odds-feed/propline"
import {
  DEFAULT_LEAGUE,
  LEAGUES,
  isLeagueId,
  leagueFor,
  reseedGameCap,
  type LeagueId,
  type LoggedLeagueId,
} from "@/lib/leagues"
import { PICKEM_MAX_PROB } from "@/lib/today/build"

export const STATE_VERSION = 1

export interface BankrollSettings {
  bankroll: number
  unitSize: number
  /** Fraction of full Kelly to actually stake. Full Kelly is far too volatile. */
  kellyFraction: number
  /** Hard ceiling on any single entry, as a fraction of bankroll. */
  maxStakePct: number
  /** Refuse to surface entries below this expected value. */
  minEvPct: number
}

export const DEFAULT_BANKROLL: BankrollSettings = {
  bankroll: 1000,
  unitSize: 10,
  kellyFraction: 0.25,
  maxStakePct: 0.02,
  minEvPct: 0,
}

/**
 * Which feed prices the slate. The Odds API carries Pinnacle's player props;
 * PropLine bills per request rather than per market, and carries the pick'em
 * apps' own lines in the same payload.
 */
export type OddsProvider = "theoddsapi" | "propline"

export const ODDS_PROVIDERS: OddsProvider[] = ["theoddsapi", "propline"]

export interface OddsFeedSettings {
  /** Which feed prices the slate. */
  provider: OddsProvider
  /** The Odds API key. Stored in this browser only and sent only to that API. */
  apiKey: string
  /** PropLine key. Stored in this browser only and sent only to PropLine. */
  proplineKey: string
  /**
   * Pull the pick'em apps' own lines from PropLine alongside the prices. With
   * PropLine as the provider they come in the same requests for free; with The
   * Odds API pricing the slate it costs one PropLine request per game, against
   * a daily allowance rather than the monthly credit quota.
   */
  pickemLines: boolean
  /** Books to request, in preference order. */
  books: string[]
  /**
   * Books you hold an account at and can actually bet.
   *
   * Every other book is a reference only: it helps judge what a line is worth
   * but is never shown as the place to bet. Pinnacle, BetOnline and LowVig are
   * the sharpest references and none of them takes US customers, so a bet
   * recommended there is a bet you cannot place.
   */
  bettable: string[]
  /** Regions parameter for the feed. */
  regions: string
}

export const DEFAULT_ODDS_FEED: OddsFeedSettings = {
  provider: "theoddsapi",
  apiKey: "",
  proplineKey: "",
  pickemLines: true,
  books: ["pinnacle", "betonlineag", "lowvig", "draftkings", "fanduel"],
  // FanDuel is the only sportsbook in the rotation. The rest of the list
  // above prices the market; nothing is ever recommended there.
  bettable: ["fanduel"],
  regions: "us,us2,eu",
}

/** The bettable list every phone stored before it was narrowed to FanDuel. */
const OLD_DEFAULT_BETTABLE = ["fanduel", "draftkings", "betmgm", "williamhill_us", "espnbet"]

/** Apps once shipped by default and never used, dropped from stored settings. */
const RETIRED_APPS = new Set(["dabble", "chalkboard"])

/**
 * The PrizePicks Power Play table every phone stored before a second real
 * screen showed a standard 3-pick at 5.5x. Settings keep their own copy of the
 * tables, so a new default reaches nobody who already has the app: a copy
 * still exactly this one was never edited and takes the new default, and one
 * that differs anywhere was set by hand and is left alone.
 */
const OLD_PRIZEPICKS_POWER: Record<number, Record<number, number>> = {
  2: { 2: 3 },
  3: { 3: 6 },
  4: { 4: 10 },
  5: { 5: 20 },
  6: { 6: 37.5 },
}

function sameTable(a: Record<number, Record<number, number>>, b: Record<number, Record<number, number>>): boolean {
  const flat = (t: Record<number, Record<number, number>>) =>
    JSON.stringify(
      Object.entries(t)
        .flatMap(([n, tiers]) => Object.entries(tiers ?? {}).map(([k, v]) => [Number(n), Number(k), v]))
        .sort((x, y) => x[0] - y[0] || x[1] - y[1]),
    )
  return flat(a) === flat(b)
}

function migrateApps(stored: BookApp[]): BookApp[] {
  const current = DEFAULT_APPS.find((a) => a.id === "prizepicks")?.modes.find((m) => m.id === "power")
  return stored
    .filter((a) => !RETIRED_APPS.has(a.id))
    .map((a) =>
      a.id !== "prizepicks" || !current || !Array.isArray(a.modes)
        ? a
        : {
            ...a,
            modes: a.modes.map((m) =>
              m.id === "power" && m.table && sameTable(m.table, OLD_PRIZEPICKS_POWER) ? { ...m, table: current.table } : m,
            ),
          },
    )
}

export interface DailySettings {
  /** Which league the Today screen is showing. */
  league: LeagueId
  /** Ignore value bets below this edge. */
  minEdge: number
  /** Require a market-making book in every reference price. */
  requireSharpReference: boolean
  /** Legs per parlay. */
  parlayLegs: number
  /** Cap on games pulled in one refresh, to protect the feed quota. */
  maxGames: number
  /**
   * Pull the selected league's companion competitions too: college football
   * inside the NFL section.
   *
   * Off by default, because a companion costs feed credits on top of the
   * league's own slate and the default for anything that spends money is not
   * to. With it off, a companion's games from an earlier pull are kept in the
   * cache but left out of the picks, so turning it back on costs nothing.
   */
  companions: boolean
  /**
   * The most lopsided a pick'em pick can be and still be assumed to exist.
   *
   * A pick'em app makes its money on a flat payout table, which only works if
   * both sides of every pick are plausible, so it does not post a prop whose
   * favoured side is a near-certainty however happily a sportsbook prices one.
   * Props above this are left out of the targets and listed under them, so the
   * judgement is visible and yours to move. 1 keeps everything.
   */
  pickemMaxProb: number
  /**
   * How much more an under has to clear in pick'em, on top of the bar, per
   * league: 0.03 means a 56% bar asks 59% of an under. It only ever turns a
   * play into a pass and moves no probability, so it cannot invent an edge.
   *
   * The NBA's default is the user's own prior — that NBA unders have not
   * worked as well as they were priced — not a measured number. The tracker's
   * overs-and-unders record is where it gets tested. See SideBars.
   */
  underMargin: Partial<Record<LeagueId, number>>
  /**
   * Feed market keys to request. Fewer markets means fewer credits.
   *
   * Null means "use whatever this league posts", which is almost always the
   * right answer: basketball and the NFL post entirely different markets, and
   * asking for one a league never posts buys nothing and may cost a credit.
   * Entries from the wrong sport for a league are ignored.
   */
  markets: string[] | null
}

/**
 * The NBA's default margin on unders: three points. A prior, stated by the
 * person this app is for — NBA unders have not hit for them as priced — and
 * small enough that an under the market really likes still gets through.
 */
export const NBA_UNDER_MARGIN = 0.03

/**
 * A stored margin map, kept to leagues that exist and numbers a slider can
 * show. A league absent from what was stored keeps its default, so an install
 * from before this existed gets the NBA's.
 */
function cleanMargins(stored: unknown): Partial<Record<LeagueId, number>> {
  const out: Partial<Record<LeagueId, number>> = { ...DEFAULT_DAILY.underMargin }
  if (!stored || typeof stored !== "object") return out
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (isLeagueId(k) && typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(0.2, Math.max(0, v))
  }
  return out
}

export const DEFAULT_DAILY: DailySettings = {
  league: DEFAULT_LEAGUE,
  minEdge: 0.02,
  requireSharpReference: true,
  parlayLegs: 3,
  // The per-market cap, because DEFAULT_ODDS_FEED is The Odds API and these
  // defaults are one static object that cannot see the feed. Selecting
  // PropLine reseeds it, and migrate() lifts an install that predates the
  // split, both via reseedGameCap.
  maxGames: LEAGUES[DEFAULT_LEAGUE].maxGames,
  markets: null,
  companions: false,
  pickemMaxProb: PICKEM_MAX_PROB,
  underMargin: { nba: NBA_UNDER_MARGIN },
}

export interface AppSettings {
  bankroll: BankrollSettings
  daily: DailySettings
  oddsFeed: OddsFeedSettings
  projection: ProjectionSettings
  correlation: CorrelationSettings
  constraints: OptimizerConstraints
  apps: BookApp[]
  defaultAppId: string
  defaultModeId: string
  /**
   * Payouts read off the app's own screen and confirmed, filed by payoutKey.
   *
   * The stored tables are every one of them unverified, and four real settled
   * entries showed what that costs: 4-pick Power Plays that paid 8x and 8.5x
   * against a stored 10x, and 3-picks that paid 4.5x and 3.75x against a
   * stored 6x. The bar those tables produced was 55-56% where the real one was
   * 59-64% — the app calling a losing leg a target, by up to nine points. The
   * number on your own screen is the only fix, and this is where it lives so
   * it survives the reload the Today screen gets constantly.
   *
   * Only confirmed captures are stored: an unconfirmed one is a half-typed
   * table and this app does not price against those.
   */
  capturedPayouts: Record<string, CapturedPayout>
}

export const DEFAULT_SETTINGS: AppSettings = {
  bankroll: DEFAULT_BANKROLL,
  daily: DEFAULT_DAILY,
  oddsFeed: DEFAULT_ODDS_FEED,
  projection: DEFAULT_PROJECTION_SETTINGS,
  correlation: DEFAULT_CORRELATION,
  constraints: DEFAULT_CONSTRAINTS,
  apps: DEFAULT_APPS,
  defaultAppId: "prizepicks",
  defaultModeId: "power",
  capturedPayouts: {},
}

export interface Slate {
  id: string
  label: string
  importedAt: string
  rows: RawPropRow[]
  /** Free-text note about where the data came from. */
  source: string
  /**
   * League the props belong to. Sets the dispersion prior and plausibility
   * ceilings the board prices with. Absent on slates captured before leagues
   * existed, which were all NBA.
   */
  league?: LeagueId
}

/** VOID: the player did not play ("Reboot" on PrizePicks). The leg drops out, like a push. */
export type LegResult = "PENDING" | "WIN" | "LOSS" | "PUSH" | "VOID"

/**
 * What kind of pick a leg was. Goblins are easier lines that pay less, demons
 * harder ones that pay more, so each needs a different hit rate to be worth
 * it and their records only mean something kept apart.
 */
export type PickType = "standard" | "goblin" | "demon"
export type SlipStatus = "PENDING" | "SETTLED" | "VOID"



export interface TrackedLeg {
  player: string
  marketKey: MarketKey | null
  marketLabel: string
  line: number
  side: "OVER" | "UNDER"
  /**
   * Probability the model gave this leg at the moment the bet was placed. Null
   * for a leg the app never priced, such as one logged from an entry placed
   * straight in the pick'em app; those count toward profit but not calibration.
   */
  pWinAtEntry: number | null
  app: string | null
  result: LegResult
  actual: number | null
  /** Absent on legs logged before pick types were recorded. */
  pickType?: PickType
  /**
   * The section the entry was played in, and the competition this leg's prop
   * actually belongs to. They are not the same field: a pick'em board mixes
   * NFL and college legs on one entry, so the section says "nfl" while the leg
   * says "cfb", and reporting the college ones as NFL calibration is the same
   * class of wrong attribution as fusing two players by name.
   *
   * Both absent on legs logged before this was recorded, and they cannot be
   * backfilled: a leg stores no game and no start time, so nothing identifies
   * the pull it came from. The nearest inference is the stat's sport, which
   * separates basketball from hockey and cannot separate the NFL from college
   * — exactly the split this exists to show. Those legs report in their own
   * bucket rather than being folded into a guess.
   */
  league?: LoggedLeagueId
  competition?: LeagueId
}

export interface TrackedSlip {
  id: string
  createdAt: string
  settledAt: string | null
  appId: string
  modeId: string
  legs: TrackedLeg[]
  stake: number
  /**
   * The payout the app actually displayed when the entry was built, captured
   * rather than read back from a stored table. Stored tables drift; the number
   * on screen at build time is ground truth. Null for a logged flex entry that
   * had already paid out: its screen shows what it paid, not what it would have.
   */
  capturedPayout: CapturedPayout | null
  /** Snapshot of what the model believed when the bet went in. Null when any leg was never priced. */
  evAtEntry: number | null
  pAllHitAtEntry: number | null
  /** "built" in the app, or "logged" from an entry placed elsewhere. Absent on older entries, which were all built. */
  source?: "built" | "logged"
  /** Null when the entry was logged after it paid out and its all-hit payout was never shown. */
  topMultiple: number | null
  status: SlipStatus
  /** Gross multiple actually returned, once settled. */
  actualMultiple: number | null
  /**
   * Dollars the app actually returned, read off the settled entry ("$10 paid
   * $5", or nothing for one marked Loss). When known it IS the result: it
   * already reflects goblins, demons, reboots and whatever table the app
   * really used, none of which a stored table gets right. Absent on entries
   * settled from their legs.
   */
  paidOut?: number | null
  notes: string
}

/**
 * The last pull from the odds feed.
 *
 * Cached in local storage on purpose. Player props are billed per market per
 * event, so a page refresh that silently re-pulls the slate is a refresh that
 * costs money. Nothing refetches without an explicit press.
 */
export interface DailyCache {
  /** The league this cache belongs to. A cache is never shown for another one. */
  league: LeagueId
  fetchedAt: string
  quotes: FeedQuote[]
  events: { id: string; commence_time: string; home_team: string; away_team: string }[]
  requestsRemaining: number | null
  /**
   * What the pull cost: the feed's own billed figure when it reported one,
   * and the pre-pull estimate when it did not. `creditsMeasured` says which,
   * because a forecast and a measurement are not the same claim and this field
   * used to hold the first while its name promised the second.
   */
  creditsSpent: number
  /** True when creditsSpent is the feed's own figure rather than an estimate. */
  creditsMeasured?: boolean
  /** What the measurement said that the estimate did not, when the two differ. */
  creditNote?: string | null
  /**
   * When today's window had no games: the next game the feed lists, or null if
   * it lists none at all. Tells "no game today" apart from "season over".
   */
  nextEvent?: { commence_time: string; home_team: string; away_team: string } | null
  /** Games in today's window that had already started at pull time, and so were not priced. */
  startedCount?: number
  /** The feed that priced this pull. Absent on pulls from before there was a choice. */
  provider?: OddsProvider
  /** Lines the pick'em apps were posting at pull time, from PropLine. Absent when not pulled. */
  pickemLines?: PickemLine[]
  /**
   * Which pick'em apps posted anything in this pull, counted BEFORE the lines
   * nothing could price were shed.
   *
   * Derived from the kept lines instead, an app whose every line was shed read
   * as "posted none in this pull" — false, and contradicted by the shed-lines
   * note in the same paragraph. Absent on pulls from before this was recorded,
   * where the kept lines are the only evidence there is.
   */
  pickemAppsPosted?: string[]
  /** Why the pick'em lines are missing or partial, when they are. */
  pickemNote?: string | null
  /** Which markets the feed refused to serve, when it refused any. */
  marketsNote?: string | null
  /**
   * What choosing which games to price did, when a competition's slate was
   * bigger than its cap and the games were ranked by market depth rather than
   * start time. A thin board has to read as expected rather than broken.
   */
  depthNote?: string | null
}

/**
 * One prop's line as it stood at one moment, compacted.
 *
 * Not a copy of the quotes: a pull's quotes are per book and run to megabytes,
 * and storage is already tight enough that a full NFL Sunday can fail to save.
 * This is one row per prop — the consensus line, the two best prices and how
 * many books posted it — which is about 175 bytes, so a season of pulls fits
 * in the space a single verbatim copy would take.
 *
 * The point of keeping it is the only thing that can fit the kickoff widening
 * honestly: the same prop's line pulled days out and again near kickoff. That
 * needs a pull on game day for games already pulled midweek; nothing here can
 * manufacture one, so the readout says how many pairs it actually has.
 */
export interface LineSnapshotRow {
  /**
   * The same identity groupQuotes builds: player, game and market. Joining on
   * it inherits the name-collision fix rather than re-deriving it badly.
   */
  key: string
  player: string
  market: MarketKey
  competition?: LeagueId
  /** Hours from this pull to kick-off, which is the variable being fitted. */
  hoursToStart: number | null
  /**
   * When the game starts.
   *
   * The key holds the two teams and not the date, because a game id is built
   * as "away@home". Two meetings of the same teams a month apart therefore
   * share a key, and pairing them would report a whole season's line drift as
   * one game's pre-kickoff move. This is what tells them apart.
   */
  startsAt: string | null
  /** Consensus line across the books that posted it. */
  line: number
  /** The implied mean behind that line, when the prop could be priced. */
  mean: number | null
  books: number
}

export interface LineSnapshot {
  pulledAt: string
  league: LeagueId
  rows: LineSnapshotRow[]
  /**
   * Rows the storage cap dropped from this pull, when it dropped any.
   *
   * Absent on a snapshot that fitted, which is the ordinary case. Kept
   * because a pair count that looks thin has two causes and only one of them
   * is "pull again on game day".
   */
  truncated?: number
}

/**
 * Pulls kept, and rows kept within them. The oldest go on load, so storage
 * cannot creep.
 *
 * Sized against the quota rather than guessed. A full NFL pull is about 1,100
 * props at roughly 190 bytes a row, so one snapshot is around 200KB and eight
 * is 1.6MB — which browsers meter in UTF-16, so 3.2MiB of a ~5MiB budget that
 * the slate cache is already most of the way through. Twenty-four, the first
 * number here, was about twice the whole quota: the history would have been
 * what triggered the shed loop it is first in line to be shed by.
 *
 * Eight pulls is still a month of weekends, which is what the comparison
 * needs. The row cap is the backstop for a slate far bigger than the NFL's.
 */
export const MAX_LINE_SNAPSHOTS = 8

/**
 * Rows kept per snapshot. A full NFL pull is about 1,100, so the NFL fits
 * whole; a 15-game NBA night across eleven markets does not, and the rows
 * that go are chosen by rankSnapshotRows rather than by arrival order -- see
 * there for why the choice decides whether the history is worth keeping at
 * all. This is the backstop for a slate far bigger than the NFL's.
 */
export const MAX_SNAPSHOT_ROWS = 1500

/**
 * A stable 32-bit hash (FNV-1a) of a prop's identity.
 *
 * Stable is the whole requirement: the same prop must sort to the same place
 * in a pull taken on Tuesday and a pull taken on Saturday, with no state
 * carried between them.
 */
function stableHash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * How deep a row's market is, in tiers coarse enough to be stable.
 *
 * A prop's exact book count moves from night to night; whether it has a real
 * consensus, a thin one, or a single book does not. Tiers rather than the raw
 * number keep the kept set from churning on noise.
 */
function depthTier(books: number): number {
  if (books >= 4) return 0
  if (books >= 2) return 1
  return 2
}

/**
 * Which rows to keep when a slate carries more props than storage allows.
 *
 * Truncation is not a detail here, it is the entire value of the history. A
 * pair needs the SAME prop to survive in TWO snapshots, so dropping rows in
 * whatever order the quotes happened to arrive loses pairs far faster than it
 * loses rows: two snapshots that each keep a different 60% of a slate share
 * only about 36% of it, and the fit is built on what they share. Slicing an
 * unordered list is therefore close to the worst available policy, and it is
 * what this did.
 *
 * So the order is stable across pulls and independent of how big the slate
 * was. Depth first, in tiers a prop does not cross on noise, because a line
 * only one book posts says little about the market revising its own opinion.
 * Within a tier a hash of the prop's own identity decides: arbitrary, but
 * identical in every pull, so a midweek look and a game-day look keep the
 * same props and actually pair.
 */
export function rankSnapshotRows(rows: LineSnapshotRow[]): LineSnapshotRow[] {
  return [...rows].sort((a, b) => {
    const tier = depthTier(a.books) - depthTier(b.books)
    if (tier !== 0) return tier
    return stableHash(`${a.key}|${a.market}`) - stableHash(`${b.key}|${b.market}`)
  })
}

export interface AppState {
  version: number
  settings: AppSettings
  slate: Slate | null
  slips: TrackedSlip[]
  /** Last pull per league, so switching leagues does not discard a paid-for slate. */
  daily: Partial<Record<LeagueId, DailyCache>>
  /**
   * Line history, newest first, across pulls and leagues. Capped and pruned on
   * load; the first thing dropped when storage runs out.
   */
  lines: LineSnapshot[]
}

export const EMPTY_STATE: AppState = {
  version: STATE_VERSION,
  settings: DEFAULT_SETTINGS,
  slate: null,
  slips: [],
  daily: {},
  lines: [],
}

/**
 * Merge a stored blob into the current shape.
 * Settings gain fields as the engine grows, and a user who imported a slate six
 * weeks ago should not lose it to a schema change.
 */
export function migrate(raw: unknown): AppState {
  if (!raw || typeof raw !== "object") return EMPTY_STATE
  const o = raw as Partial<AppState>
  const s = (o.settings ?? {}) as Partial<AppSettings>
  const oddsFeed = migrateOddsFeed(s.oddsFeed)
  const dailyLeague = isLeagueId(s.daily?.league) ? s.daily.league : DEFAULT_LEAGUE
  const storedCap = typeof s.daily?.maxGames === "number" ? s.daily.maxGames : DEFAULT_DAILY.maxGames
  return {
    version: STATE_VERSION,
    settings: {
      bankroll: { ...DEFAULT_BANKROLL, ...(s.bankroll ?? {}) },
      daily: {
        ...DEFAULT_DAILY,
        ...(s.daily ?? {}),
        league: dailyLeague,
        // A cap stored before the per-request default existed is the credit
        // default, which on PropLine leaves part of the slate unpulled to save
        // credits PropLine never charges. Lifted only when it is exactly the
        // other feed's default, so a cap anyone chose survives the upgrade.
        maxGames: reseedGameCap(leagueFor(dailyLeague), storedCap, {
          billsPerRequest: oddsFeed.provider === "propline",
        }),
        underMargin: cleanMargins(s.daily?.underMargin),
      },
      oddsFeed,
      projection: {
        ...DEFAULT_PROJECTION_SETTINGS,
        ...(s.projection ?? {}),
        dispersion: { ...DEFAULT_PROJECTION_SETTINGS.dispersion, ...(s.projection?.dispersion ?? {}) },
        // A league that no longer exists (college basketball) falls back to the NBA.
        league: isLeagueId(s.projection?.league) ? s.projection.league : DEFAULT_PROJECTION_SETTINGS.league,
      },
      correlation: { ...DEFAULT_CORRELATION, ...(s.correlation ?? {}) },
      constraints: { ...DEFAULT_CONSTRAINTS, ...(s.constraints ?? {}) },
      apps: Array.isArray(s.apps) && s.apps.length > 0 ? migrateApps(s.apps) : DEFAULT_APPS,
      defaultAppId: s.defaultAppId ?? DEFAULT_SETTINGS.defaultAppId,
      defaultModeId: s.defaultModeId ?? DEFAULT_SETTINGS.defaultModeId,
      capturedPayouts: migrateCapturedPayouts(s.capturedPayouts),
    },
    slate: o.slate ? { ...o.slate, league: isLeagueId(o.slate.league) ? o.slate.league : undefined } : null,
    slips: Array.isArray(o.slips) ? o.slips : [],
    daily: migrateDaily(o.daily),
    lines: migrateLines(o.lines),
  }
}

/**
 * Bring stored captures forward, re-validating every one.
 *
 * Settings travel through Export and Restore as a JSON file a human can edit,
 * and that is the one route by which a payout table can arrive here without
 * ever having been through the capture form. It is checked on the way in
 * rather than trusted because it was once ours: this is the number that sets
 * the bar deciding what gets recommended.
 */
function migrateCapturedPayouts(raw: unknown): Record<string, CapturedPayout> {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, CapturedPayout> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue
    const c = v as CapturedPayout
    if (c.confirmed !== true) continue
    if (!Number.isFinite(c.picks) || !c.tiers || typeof c.tiers !== "object") continue
    if (validateCapture(c).length > 0) continue
    out[k] = c
  }
  return out
}

/**
 * A bettable list still at the old five-book default was never chosen, so it
 * moves to the new one. A list someone edited is theirs and is kept.
 */
function migrateOddsFeed(stored: Partial<OddsFeedSettings> | undefined): OddsFeedSettings {
  const base = { ...DEFAULT_ODDS_FEED, ...(stored ?? {}) }
  const merged = { ...base, provider: ODDS_PROVIDERS.includes(base.provider) ? base.provider : DEFAULT_ODDS_FEED.provider }
  const b = stored?.bettable
  const untouched =
    Array.isArray(b) && b.length === OLD_DEFAULT_BETTABLE.length && OLD_DEFAULT_BETTABLE.every((id) => b.includes(id))
  return untouched ? { ...merged, bettable: DEFAULT_ODDS_FEED.bettable } : merged
}

/**
 * Bring the daily cache forward.
 *
 * Before leagues existed this was a single object holding an NBA pull. Anyone
 * upgrading has one of those in local storage, and it is a slate they paid feed
 * credits for, so it is kept and filed under the NBA rather than dropped.
 */
function migrateDaily(raw: unknown): Partial<Record<LeagueId, DailyCache>> {
  if (!raw || typeof raw !== "object") return {}
  const o = raw as Record<string, unknown>

  // Old shape: a bare DailyCache with quotes at the top level.
  if (Array.isArray(o.quotes)) {
    const legacy = raw as DailyCache
    return { [DEFAULT_LEAGUE]: { ...legacy, league: DEFAULT_LEAGUE } }
  }

  const out: Partial<Record<LeagueId, DailyCache>> = {}
  for (const [k, v] of Object.entries(o)) {
    if (!isLeagueId(k) || !v || typeof v !== "object") continue
    const cache = v as DailyCache
    if (!Array.isArray(cache.quotes)) continue
    out[k] = { ...cache, league: k }
  }
  return out
}

/**
 * Bring the line history forward, and prune it.
 *
 * Pruning here rather than in the UI means it runs on every load and every
 * import, is covered by the schema tests, and cannot be skipped by a component
 * that forgets. This is already where legacy storage shapes are normalised, so
 * it is where a reader will look for the cap.
 */
function migrateLines(raw: unknown): LineSnapshot[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is LineSnapshot => {
      if (!s || typeof s !== "object") return false
      const snap = s as Partial<LineSnapshot>
      return (
        typeof snap.pulledAt === "string" &&
        Number.isFinite(Date.parse(snap.pulledAt)) &&
        isLeagueId(snap.league) &&
        Array.isArray(snap.rows)
      )
    })
    .map((snap) => {
      const rows = snap.rows.filter(isLineSnapshotRow)
      const kept = rankSnapshotRows(rows).slice(0, MAX_SNAPSHOT_ROWS)
      // A snapshot written before the cap, or by an older build that sliced in
      // arrival order, is re-chosen by the same stable ranking as a fresh one,
      // so an upgraded install's old pulls still pair with its new ones.
      const dropped = (snap.truncated ?? 0) + (rows.length - kept.length)
      return { ...snap, rows: kept, ...(dropped > 0 ? { truncated: dropped } : {}) }
    })
    .sort((a, b) => b.pulledAt.localeCompare(a.pulledAt))
    .slice(0, MAX_LINE_SNAPSHOTS)
}

/**
 * A stored row worth reading. The market has to be one we model, because the
 * readouts index the market table by it, and an imported file is arbitrary
 * JSON: nothing between a hand-edited export and a crash but this.
 */
function isLineSnapshotRow(row: unknown): row is LineSnapshotRow {
  if (!row || typeof row !== "object") return false
  const r = row as Partial<LineSnapshotRow>
  return (
    typeof r.key === "string" &&
    r.key.length > 0 &&
    typeof r.player === "string" &&
    typeof r.market === "string" &&
    Object.prototype.hasOwnProperty.call(MARKETS, r.market) &&
    typeof r.line === "number" &&
    Number.isFinite(r.line)
  )
}
