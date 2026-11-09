import { distributionFor, MARKETS, type MarketKey } from "@/lib/nba/markets"
import { MAX_SNAPSHOT_ROWS, rankSnapshotRows, type LineSnapshot, type LineSnapshotRow } from "@/lib/store/schema"
import type { LeagueId } from "@/lib/leagues"
import { marketLineOf } from "@/lib/today/build"
import { groupQuotes, referenceProjection, type FeedQuote, type ValueBetSettings } from "./valuebets"

/**
 * Line history, and the one honest way to fit the kickoff widening.
 *
 * A football prop is posted days before kick-off and moves on injury,
 * depth-chart and weather news. The app answers that by widening the
 * distribution by a fixed 4% of variance per day, capped at 12%, which is a
 * number somebody reasoned out rather than measured. What would measure it is
 * the same prop's line seen twice: once days out and once near kick-off. The
 * spread of that movement IS the uncertainty the factor is trying to price,
 * because what the factor really says is "we do not yet know what the line
 * will be when the game starts".
 *
 * Two things this cannot do, and does not pretend to:
 *
 *   It cannot be fitted from the tracker's hit rates. A settled leg's
 *   predicted probability already had the widening applied, so comparing it to
 *   what happened measures what is LEFT after the correction, not the
 *   correction. Only two observations of the same line are independent of it.
 *
 *   It cannot make the second observation happen. Nothing in this app re-pulls
 *   a slate near kick-off: refreshing costs credits and the cache exists to
 *   avoid it. So a pair needs the same slate pulled twice, and the readout
 *   counts its pairs out loud rather than quietly fitting six of them.
 *
 *   And the gap it can see is HOURS, not days. The Today screen pulls from
 *   local midnight to 11am tomorrow, so a Sunday afternoon game cannot be
 *   pulled on Saturday at all: the furthest apart two looks at one prop can be
 *   is a few hours to a day, depending on kick-off. The multi-day drift the
 *   NFL is famous for would need a wider window than Today uses, which means
 *   more games and more credits per press — a choice for whoever is paying,
 *   not a default to slip in. What is measured here is the last day's
 *   movement, extrapolated per day, and it is a lower bound on the week's.
 */

/** Hours from a pull to a game, or null when the start time is unknown. */
function hoursTo(commenceTime: string | null | undefined, now: number): number | null {
  const t = commenceTime ? Date.parse(commenceTime) : NaN
  if (!Number.isFinite(t)) return null
  return (t - now) / 3_600_000
}

/**
 * Compact one pull into one row per prop.
 *
 * Deliberately not a copy of the quotes. A pull's quotes are per book and run
 * to megabytes; this is the consensus line, the implied mean behind it and how
 * many books posted it, which is what a later comparison needs and about a
 * fiftieth of the size.
 */
export function snapshotRows(quotes: FeedQuote[], settings: ValueBetSettings, now: number): LineSnapshotRow[] {
  const rows: LineSnapshotRow[] = []
  for (const group of groupQuotes(quotes)) {
    const lines = group.quotes.map((q) => q.line)
    if (lines.length === 0) continue
    // Only games still ahead of us. Once a game starts its line moves with the
    // score, and pairing a pregame look against a live one would measure the
    // game rather than the market's revision of its own opinion — which is the
    // one thing this is for.
    const hours = hoursTo(group.commenceTime, now)
    if (hours == null || hours <= 0) continue
    const ref = referenceProjection(group, group.quotes, settings, now)
    rows.push({
      // The same identity groupQuotes builds, so a later pull joins on it and
      // inherits the name-and-game key rather than re-deriving it badly.
      key: group.key,
      player: group.player,
      market: group.market,
      competition: group.competition,
      hoursToStart: hours,
      startsAt: group.commenceTime,
      line: marketLineOf(lines, ref?.mean ?? lines[0]),
      mean: ref?.status === "priced" ? ref.mean : null,
      books: new Set(group.quotes.map((q) => q.book)).size,
    })
  }
  return rows
}

export function snapshotFor(
  league: LeagueId,
  quotes: FeedQuote[],
  settings: ValueBetSettings,
  now: number,
  pulledAt: string,
): LineSnapshot {
  // Capped here as well as on load, so a single enormous slate cannot blow the
  // storage budget before anything has a chance to prune it. Ranked first, so
  // the rows that go are the ones worth least and the rows that stay are the
  // same ones the next pull will keep.
  const all = snapshotRows(quotes, settings, now)
  const rows = rankSnapshotRows(all).slice(0, MAX_SNAPSHOT_ROWS)
  const dropped = all.length - rows.length
  // Only when it happened, so an ordinary snapshot carries no extra bytes.
  return { pulledAt, league, rows, ...(dropped > 0 ? { truncated: dropped } : {}) }
}

/** The same prop seen twice, at two distances from kick-off. */
export interface LineMove {
  key: string
  player: string
  market: MarketKey
  competition?: LeagueId
  /** Hours to kick-off at the earlier look. */
  fromHours: number
  /** Hours to kick-off at the later look. */
  toHours: number
  /** Days between the two looks. */
  days: number
  /** How far the line moved, in the stat's own units. */
  delta: number
  /** The implied mean at the later look, for scaling the move against the outcome. */
  mean: number | null
}

/**
 * Every prop that was seen at two different distances from kick-off.
 *
 * Joined on the snapshot key, so a prop only pairs with itself: same player,
 * same game, same market. The pair is the widest gap available for that prop,
 * since what is being measured is how much a line moves over time and the
 * longest interval carries the most signal.
 */
export function lineMoves(snapshots: LineSnapshot[]): LineMove[] {
  const byKey = new Map<string, LineSnapshotRow[]>()
  for (const snap of snapshots) {
    for (const row of snap.rows) {
      if (row.hoursToStart == null || !Number.isFinite(row.line)) continue
      // The fixture's own start time joins the key, because a game id is two
      // team names: the same two teams meeting again later in the season would
      // otherwise pair with this one, and a season's drift would be reported
      // as one game's pre-kickoff move.
      const arr = byKey.get(`${row.key}|${row.startsAt ?? ""}`)
      if (arr) arr.push(row)
      else byKey.set(`${row.key}|${row.startsAt ?? ""}`, [row])
    }
  }

  const out: LineMove[] = []
  for (const rows of byKey.values()) {
    if (rows.length < 2) continue
    // Furthest from kick-off against closest to it.
    const sorted = [...rows].sort((a, b) => (b.hoursToStart ?? 0) - (a.hoursToStart ?? 0))
    const early = sorted[0]
    const late = sorted[sorted.length - 1]
    const days = ((early.hoursToStart ?? 0) - (late.hoursToStart ?? 0)) / 24
    // Two looks within an hour of each other say nothing about a day's drift.
    if (!(days > 1 / 24)) continue
    out.push({
      key: early.key,
      player: late.player,
      market: late.market,
      competition: late.competition ?? early.competition,
      fromHours: early.hoursToStart ?? 0,
      toHours: late.hoursToStart ?? 0,
      days,
      delta: late.line - early.line,
      mean: late.mean ?? early.mean,
    })
  }
  return out
}

export interface MovementFit {
  market: MarketKey
  marketLabel: string
  pairs: number
  /** Median days between the two looks. */
  days: number
  /** Standard deviation of the move, in the stat's own units. */
  sd: number
  /**
   * Variance the move adds per day, as a fraction of the outcome's own
   * variance. Directly comparable with the 0.04 the app currently assumes.
   * Null when no pair carried a priced mean to scale against.
   */
  variancePerDay: number | null
}

/**
 * How much a line actually moves per day, per market.
 *
 * The move's spread is squared and divided by the outcome's own variance,
 * which puts it in the same units as the factor it would replace: a variance
 * multiplier per day. Measured about the mean move rather than about zero, so
 * a market that drifts one way all week (a line that always climbs) is not
 * counted as uncertainty — a predictable drift is a bias to correct, not noise
 * to widen for, and conflating the two would overstate the factor.
 */
export function fitMovement(moves: LineMove[], opts: { minPairs?: number } = {}): MovementFit[] {
  const minPairs = opts.minPairs ?? 8
  const byMarket = new Map<MarketKey, LineMove[]>()
  for (const m of moves) {
    const arr = byMarket.get(m.market)
    if (arr) arr.push(m)
    else byMarket.set(m.market, [m])
  }

  const out: MovementFit[] = []
  for (const [market, group] of byMarket) {
    if (group.length < minPairs) continue
    const deltas = group.map((m) => m.delta)
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
    const variance = deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / Math.max(1, deltas.length - 1)
    const sd = Math.sqrt(variance)
    const days = median(group.map((m) => m.days))

    // Scale against the outcome's spread at the observed mean, so a 12-yard
    // move on a 250-yard line and a half-shot move on a 3-shot line are
    // comparable numbers.
    const means = group.map((m) => m.mean).filter((v): v is number => v != null && v > 0)
    let variancePerDay: number | null = null
    if (means.length > 0 && days > 0) {
      const outcomeVariance = distributionFor(market, median(means)).variance
      if (outcomeVariance > 0) variancePerDay = variance / outcomeVariance / days
    }
    out.push({ market, marketLabel: MARKETS[market].label, pairs: group.length, days, sd, variancePerDay })
  }
  return out.sort((a, b) => b.pairs - a.pairs)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** What the line history holds, for a readout that has to be honest about its sample. */
export interface LineHistorySummary {
  snapshots: number
  props: number
  /** Props seen at two useful distances from kick-off. */
  paired: number
  /** The widest gap any pair covers, in days. */
  widestDays: number
  /**
   * Rows the storage cap dropped across every snapshot held.
   *
   * Surfaced because a thin pair count has two very different causes -- no
   * game-day pull, or a slate too big to store whole -- and only one of them
   * is fixed by pulling again.
   */
  truncated: number
}

export function summariseHistory(snapshots: LineSnapshot[]): LineHistorySummary {
  const keys = new Set<string>()
  for (const s of snapshots) for (const r of s.rows) keys.add(r.key)
  const moves = lineMoves(snapshots)
  return {
    snapshots: snapshots.length,
    props: keys.size,
    paired: moves.length,
    widestDays: moves.reduce((a, m) => Math.max(a, m.days), 0),
    truncated: snapshots.reduce((a, s) => a + (s.truncated ?? 0), 0),
  }
}

/**
 * How a prop's consensus line moved between an earlier pull and this one.
 *
 * The books' line, not any app's: snapshots record the consensus the books
 * agree on, which is what moves when the market learns something.
 */
export interface LineChange {
  /** The consensus line at the earlier look. */
  from: number
  /** The consensus line now. */
  to: number
  /** to - from, in the stat's own units. Never zero: an unmoved line is absent. */
  delta: number
  /** When the earlier look was taken (ISO). */
  since: string
}

/**
 * Every prop in the pull on screen that the books have moved since an earlier
 * pull of the same game, keyed by `${key}|${startsAt}`.
 *
 * This is the reason the history is worth showing outside the tracker. The
 * edge the app's own limitations name as real is a stale line -- a number an
 * operator has not moved yet -- and the cleanest sign of one is the books
 * moving while an app's line stays where they used to be. The snapshots have
 * recorded the books' consensus on every pull all along; this reads it back.
 *
 * Anchored on the pull actually displayed, by its exact timestamp. Anything
 * else risks comparing two older pulls and presenting their difference as
 * today's movement, so when that pull's snapshot is missing -- not saved, or
 * shed to fit storage -- the answer is nothing rather than something wrong.
 * The join is the one lineMoves uses, so the same game played again later in
 * the season never pairs with this one.
 */
export function lineChanges(
  snapshots: LineSnapshot[],
  league: LeagueId,
  currentPulledAt: string | null | undefined,
): Map<string, LineChange> {
  const out = new Map<string, LineChange>()
  if (!currentPulledAt) return out
  const current = snapshots.find((s) => s.league === league && s.pulledAt === currentPulledAt)
  if (!current) return out

  // The most recent earlier look at each prop: walk earlier pulls newest
  // first and keep the first row seen for each join key.
  const prior = new Map<string, { line: number; pulledAt: string }>()
  const earlier = snapshots
    .filter((s) => s.league === league && s.pulledAt < currentPulledAt)
    .sort((a, b) => b.pulledAt.localeCompare(a.pulledAt))
  for (const snap of earlier) {
    for (const row of snap.rows) {
      if (!Number.isFinite(row.line)) continue
      const join = `${row.key}|${row.startsAt ?? ""}`
      if (!prior.has(join)) prior.set(join, { line: row.line, pulledAt: snap.pulledAt })
    }
  }

  for (const row of current.rows) {
    if (!Number.isFinite(row.line)) continue
    const join = `${row.key}|${row.startsAt ?? ""}`
    const before = prior.get(join)
    if (!before) continue
    const delta = row.line - before.line
    if (Math.abs(delta) < 1e-9) continue
    out.set(join, { from: before.line, to: row.line, delta, since: before.pulledAt })
  }
  return out
}

/**
 * Whether an app's line sits nearer where the books WERE than where they are.
 *
 * That is the shape of a stale line: the market moved and this number has not
 * followed. It says nothing about whether the app moved at all -- only the
 * books are recorded -- just that its current line is behind the books' move.
 * The chance on the row already prices the gap; this says why it is there and
 * that it may not stay.
 */
export function appIsBehind(move: LineChange, appLine: number | null | undefined): boolean {
  if (appLine == null || !Number.isFinite(appLine)) return false
  return Math.abs(appLine - move.from) < Math.abs(appLine - move.to)
}

/** "20m ago", "3h ago", "2d ago": how long since the earlier look. */
export function sinceLabel(since: string, now: number): string {
  const mins = Math.max(0, (now - Date.parse(since)) / 60_000)
  if (!Number.isFinite(mins)) return ""
  if (mins < 60) return `${Math.round(mins)}m ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / (24 * 60))}d ago`
}
