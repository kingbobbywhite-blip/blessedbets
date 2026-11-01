import type { MarketKey } from "@/lib/nba/markets"
import { extractProps, linesFromText, type PropCandidate } from "@/lib/ocr/extract"
import { LOGGED_LEAGUE_IDS, loggedLeagueShort, type LeagueId, type LoggedLeagueId } from "@/lib/leagues"
import { normalizeName } from "@/lib/quant/correlation"
import { resolveLine } from "@/lib/quant/distributions"
import { dfsPayout } from "@/lib/quant/evaluate"
import { breakEvenLegProb, capturedToMode, findApp, findMode, type BookApp, type CapturedPayout, type PayoutMode } from "@/lib/quant/payouts"
import { groupQuotes, referenceProjection, type FeedQuote, type ValueBetSettings } from "@/lib/quant/valuebets"
import type { LegResult, PickType, TrackedLeg, TrackedSlip } from "@/lib/store/schema"

/**
 * Settling, pricing and reading back entries in the tracker.
 *
 * Built from five real settled PrizePicks entries. They showed three things the
 * tracker got wrong or could not do:
 *
 *   - A player who does not play ("Reboot") does not refund the entry. The entry
 *     shrinks to the remaining picks and pays that size's table, so a 3-pick
 *     with one win, one loss and one no-show is a 2-pick with a loss: a loss.
 *     The tracker only knew the 3-pick payout, so it refunded it.
 *   - Entries placed straight in the app could not be logged at all, and they
 *     are most of what gets played.
 *   - The same player sat in two open entries, so one bad game cost both.
 */

/** Results that take a leg out of the entry instead of deciding it. */
export const DROPS_OUT: LegResult[] = ["PUSH", "VOID"]

/**
 * The payout table a slip settles against: the multiple captured for its full
 * size, and the app's stored table for any smaller size a void shrinks it to.
 */
export function settlementMode(
  slip: Pick<TrackedSlip, "appId" | "modeId"> & { capturedPayout: CapturedPayout },
  apps: BookApp[],
): PayoutMode {
  const stored = findMode(findApp(apps, slip.appId), slip.modeId)
  const captured = capturedToMode(slip.capturedPayout)
  return { ...captured, table: { ...(stored?.table ?? {}), ...captured.table } }
}

/**
 * Apply leg results and, once every leg is decided, settle the entry.
 *
 * An entry logged with what the app paid is settled at that, whatever its legs
 * say or whether they are filled in yet. Scoring it from a table instead is
 * how a 6-pick flex that hit five goblins, and paid $5 on $10, would have gone
 * into the tracker as a $10 profit: the stored table pays 2x for 5 of 6, and
 * goblins cut every tier, not just the top one.
 */
export function withResults(slip: TrackedSlip, legs: TrackedLeg[], apps: BookApp[]): TrackedSlip {
  if (slip.paidOut != null) {
    const actualMultiple = slip.stake > 0 ? slip.paidOut / slip.stake : 0
    return { ...slip, legs, status: "SETTLED", actualMultiple, settledAt: slip.settledAt ?? new Date().toISOString() }
  }
  const settledAll = legs.every((l) => l.result !== "PENDING")
  if (!settledAll) return { ...slip, legs, status: "PENDING", actualMultiple: null, settledAt: null }
  const wins = legs.filter((l) => l.result === "WIN").length
  const drops = legs.filter((l) => DROPS_OUT.includes(l.result)).length
  const outcomes = Int8Array.from(legs.map((l) => (l.result === "WIN" ? 1 : DROPS_OUT.includes(l.result) ? 0 : -1)))
  const actualMultiple = slip.capturedPayout
    ? dfsPayout(settlementMode({ ...slip, capturedPayout: slip.capturedPayout }, apps))(wins, drops, legs.length, outcomes)
    : 0
  return { ...slip, legs, status: "SETTLED", actualMultiple, settledAt: slip.settledAt ?? new Date().toISOString() }
}

/** The per-leg hit rate an entry needed to break even at its captured payout. Null without one. */
export function entryBreakEven(slip: TrackedSlip, apps: BookApp[]): number | null {
  if (!slip.capturedPayout) return null
  return breakEvenLegProb(settlementMode({ ...slip, capturedPayout: slip.capturedPayout }, apps), slip.legs.length)
}

/**
 * What the payout table says an entry should have returned, from its leg
 * results: the captured table where there is one, the app's stored table
 * otherwise. Null until every leg is decided, or when no table covers it.
 *
 * Beside what the app actually paid, this is how a stored table is caught
 * being wrong for an entry, which for goblins and demons it usually is.
 */
export function tableMultiple(slip: TrackedSlip, apps: BookApp[]): number | null {
  if (slip.legs.some((l) => l.result === "PENDING")) return null
  const mode = slip.capturedPayout
    ? settlementMode({ ...slip, capturedPayout: slip.capturedPayout }, apps)
    : findMode(findApp(apps, slip.appId), slip.modeId)
  if (!mode || !mode.table[slip.legs.length]) return null
  const wins = slip.legs.filter((l) => l.result === "WIN").length
  const drops = slip.legs.filter((l) => DROPS_OUT.includes(l.result)).length
  const outcomes = Int8Array.from(slip.legs.map((l) => (l.result === "WIN" ? 1 : DROPS_OUT.includes(l.result) ? 0 : -1)))
  return dfsPayout(mode)(wins, drops, slip.legs.length, outcomes)
}

/**
 * Expected return of an entry from its legs' probabilities, assuming the legs
 * are independent. Exact over every win/loss combination, so partial-pay flex
 * tiers count. Null when any leg was never priced: an EV built on a guess for
 * one leg is a guess.
 */
export function entryExpectation(ps: (number | null)[], mode: PayoutMode): { ev: number; pAllHit: number } | null {
  if (ps.length === 0 || ps.some((p) => p == null)) return null
  const probs = ps as number[]
  const n = probs.length
  const pay = dfsPayout(mode)
  let ev = 0
  for (let mask = 0; mask < 1 << n; mask++) {
    let p = 1
    let wins = 0
    const outcomes = new Int8Array(n)
    for (let i = 0; i < n; i++) {
      const hit = (mask >> i) & 1
      p *= hit ? probs[i] : 1 - probs[i]
      wins += hit
      outcomes[i] = hit ? 1 : -1
    }
    ev += p * pay(wins, 0, n, outcomes)
  }
  return { ev: ev - 1, pAllHit: probs.reduce((a, b) => a * b, 1) }
}

/**
 * What the app's last pull said about a leg: the probability that side hits at
 * that line, from the same sharp-weighted reference the Today screen uses.
 * Null when the pull does not include the player and stat, which for an entry
 * placed before a pull is the usual case.
 */
export function priceLeg(
  quotes: FeedQuote[] | undefined,
  leg: { player: string; marketKey: MarketKey | null; line: number; side: "OVER" | "UNDER" },
  settings: ValueBetSettings,
  now = Date.now(),
): number | null {
  return matchLeg(quotes, leg, settings, now)?.pWin ?? null
}

/**
 * The same match, with what it was matched against.
 *
 * The competition matters at log time: it is the only moment anything knows
 * whether a leg was a college prop pulled inside the NFL section, and a leg
 * stores no game, so it can never be worked out later. The ambiguity is worth
 * naming too — two players on the slate normalising to one name means this
 * price may be the other one's.
 */
export function matchLeg(
  quotes: FeedQuote[] | undefined,
  leg: { player: string; marketKey: MarketKey | null; line: number; side: "OVER" | "UNDER" },
  settings: ValueBetSettings,
  now = Date.now(),
): { pWin: number; competition?: LeagueId; gameId: string; ambiguous: boolean } | null {
  if (!quotes?.length || !leg.marketKey || !Number.isFinite(leg.line)) return null
  const who = normalizeName(leg.player)
  const groups = groupQuotes(quotes).filter((g) => g.market === leg.marketKey && normalizeName(g.player) === who)
  const group = groups[0]
  if (!group) return null
  const ref = referenceProjection(group, group.quotes, settings, now)
  if (!ref || ref.status !== "priced") return null
  const r = resolveLine(ref.distribution, leg.line)
  return {
    pWin: leg.side === "OVER" ? r.over : r.under,
    competition: group.competition,
    gameId: group.gameId,
    // An entry screen gives a name and a stat, never a fixture, so when the
    // slate holds two players of that name there is nothing here to choose
    // between them.
    ambiguous: groups.length > 1,
  }
}

export interface Exposure {
  player: string
  entries: number
  /** Each distinct bet on the player: side, line, stat, how many entries carried it, and how it went. */
  bets: string[]
  /** Over in one entry and under in another, on the same stat. */
  conflicting: boolean
  /**
   * An over at or above an under on the same stat, so the two cannot both hit:
   * over 1.5 and under 1.5 rebounds is one guaranteed miss. Over 0.5 and under
   * 4.5 is not; both hit if it lands in between.
   */
  cannotBothHit: boolean
  /** The identical leg, same side, line and stat, in more than one entry. */
  repeated: boolean
}

const RESULT_WORD: Record<LegResult, string> = { PENDING: "", WIN: "hit", LOSS: "missed", VOID: "did not play", PUSH: "push" }

/**
 * Players who appear in more than one of these entries. Each extra entry on
 * the same player is the same bet again: one quiet game, or one blowout,
 * settles all of them together, which multiplies the swing without adding any
 * edge.
 */
export function entryOverlap(entries: { id: string; legs: TrackedLeg[] }[]): Exposure[] {
  const byPlayer = new Map<string, { player: string; slips: Set<string>; legs: { slip: string; leg: TrackedLeg }[] }>()
  for (const s of entries) {
    for (const l of s.legs) {
      const k = normalizeName(l.player)
      const e = byPlayer.get(k) ?? { player: l.player, slips: new Set<string>(), legs: [] }
      e.slips.add(s.id)
      e.legs.push({ slip: s.id, leg: l })
      byPlayer.set(k, e)
    }
  }
  return Array.from(byPlayer.values())
    .filter((e) => e.slips.size > 1)
    .map((e) => {
      const bets = new Map<string, { label: string; slips: Set<string>; results: Set<LegResult> }>()
      const sides = new Map<string, { over: number[]; under: number[] }>()
      for (const { slip, leg } of e.legs) {
        const market = leg.marketKey ?? leg.marketLabel
        const key = `${market}|${leg.side}|${leg.line}`
        const b = bets.get(key) ?? {
          label: `${leg.side === "OVER" ? "over" : "under"} ${leg.line} ${leg.marketLabel}`,
          slips: new Set<string>(),
          results: new Set<LegResult>(),
        }
        b.slips.add(slip)
        b.results.add(leg.result)
        bets.set(key, b)
        const m = sides.get(market) ?? { over: [], under: [] }
        ;(leg.side === "OVER" ? m.over : m.under).push(leg.line)
        sides.set(market, m)
      }
      const markets = Array.from(sides.values())
      return {
        player: e.player,
        entries: e.slips.size,
        bets: Array.from(bets.values()).map((b) => {
          const outcome = Array.from(b.results).map((r) => RESULT_WORD[r]).filter(Boolean).join("/")
          return `${b.label}${b.slips.size > 1 ? ` \u00d7${b.slips.size}` : ""}${outcome ? `, ${outcome}` : ""}`
        }),
        conflicting: markets.some((m) => m.over.length > 0 && m.under.length > 0),
        cannotBothHit: markets.some((m) => m.over.some((o) => m.under.some((u) => o >= u))),
        repeated: Array.from(bets.values()).some((b) => b.slips.size > 1),
      }
    })
    .sort((a, b) => Number(b.cannotBothHit) - Number(a.cannotBothHit) || Number(b.repeated) - Number(a.repeated) || b.entries - a.entries)
}

export interface LegClash {
  /** Other entries with this player in them. */
  entries: number
  /** Other entries holding this exact leg: same stat, side and line. */
  repeated: number
  /** Another entry takes the other side of this stat. */
  oppositeSide: boolean
  /** ...at a line where the two cannot both hit. */
  cannotBothHit: boolean
}

/** How one leg overlaps a set of other entries, for warning before it is logged. */
export function legClash(
  leg: Pick<TrackedLeg, "player" | "marketKey" | "marketLabel" | "line" | "side">,
  others: { id: string; legs: TrackedLeg[] }[],
): LegClash {
  const who = normalizeName(leg.player)
  const market = leg.marketKey ?? leg.marketLabel
  const out: LegClash = { entries: 0, repeated: 0, oppositeSide: false, cannotBothHit: false }
  for (const e of others) {
    const same = e.legs.filter((l) => normalizeName(l.player) === who)
    if (same.length === 0) continue
    out.entries++
    const onStat = same.filter((l) => (l.marketKey ?? l.marketLabel) === market)
    if (onStat.some((l) => l.side === leg.side && l.line === leg.line)) out.repeated++
    for (const l of onStat) {
      if (l.side === leg.side) continue
      out.oppositeSide = true
      const [over, under] = leg.side === "OVER" ? [leg.line, l.line] : [l.line, leg.line]
      if (over >= under) out.cannotBothHit = true
    }
  }
  return out
}

/** Players riding in more than one open entry, counting only legs still to be decided. */
export function openExposure(slips: TrackedSlip[]): Exposure[] {
  return entryOverlap(
    slips
      .filter((s) => s.status === "PENDING")
      .map((s) => ({ id: s.id, legs: s.legs.filter((l) => l.result === "PENDING") })),
  )
}

/** The local calendar day of a timestamp, as yyyy-mm-dd. */
export function localDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export interface NightReview {
  /** The day the entries were logged or built, yyyy-mm-dd. */
  day: string
  entries: number
  staked: number
  returned: number
  exposure: Exposure[]
}

/**
 * Settled entries grouped by the day they went in, with the players who ran
 * through more than one of them.
 *
 * The open-entry warning only helps before the games. Entries logged from
 * screenshots arrive already settled, where it never fires, and that is when
 * a doubled-up leg or an over-and-under pair is worth seeing: it shows what
 * the habit cost. Newest day first; only days with two or more entries.
 */
export function nightReviews(slips: TrackedSlip[], dayOf: (iso: string) => string = localDay): NightReview[] {
  const days = new Map<string, TrackedSlip[]>()
  for (const s of slips) {
    if (s.status !== "SETTLED") continue
    const d = dayOf(s.createdAt)
    days.set(d, [...(days.get(d) ?? []), s])
  }
  return Array.from(days.entries())
    .filter(([, list]) => list.length > 1)
    .map(([day, list]) => ({
      day,
      entries: list.length,
      staked: list.reduce((a, s) => a + s.stake, 0),
      returned: list.reduce((a, s) => a + s.stake * (s.actualMultiple ?? 0), 0),
      exposure: entryOverlap(list.map((s) => ({ id: s.id, legs: s.legs }))),
    }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

const PICK_LABEL: Record<PickType, string> = { standard: "Standard picks", goblin: "Goblins", demon: "Demons" }

export interface LegRecord {
  label: string
  wins: number
  losses: number
}

/**
 * Settled legs grouped by stat and side, plus whether the app had priced them.
 * The point is the pattern, not the headline: "receptions unders 1-4" says more
 * about what to stop doing than an overall record does. Voids and pushes are
 * left out; they decided nothing.
 */
export function recordByType(slips: TrackedSlip[]): {
  byType: LegRecord[]
  /** Goblins, demons and standard picks apart; empty until some legs carry a pick type. */
  byPick: LegRecord[]
  priced: LegRecord
  unpriced: LegRecord
} {
  const map = new Map<string, LegRecord>()
  const picks = new Map<PickType, LegRecord>()
  const priced: LegRecord = { label: "Legs the app priced", wins: 0, losses: 0 }
  const unpriced: LegRecord = { label: "Legs the app never priced", wins: 0, losses: 0 }
  for (const s of slips) {
    for (const l of s.legs) {
      if (l.result !== "WIN" && l.result !== "LOSS") continue
      const label = `${l.marketLabel} ${l.side === "OVER" ? "overs" : "unders"}`
      const r = map.get(label) ?? { label, wins: 0, losses: 0 }
      const bucket = l.pWinAtEntry == null ? unpriced : priced
      if (l.result === "WIN") {
        r.wins++
        bucket.wins++
      } else {
        r.losses++
        bucket.losses++
      }
      map.set(label, r)
      if (l.pickType) {
        const p = picks.get(l.pickType) ?? { label: PICK_LABEL[l.pickType], wins: 0, losses: 0 }
        if (l.result === "WIN") p.wins++
        else p.losses++
        picks.set(l.pickType, p)
      }
    }
  }
  return {
    byType: Array.from(map.values()).sort((a, b) => b.wins + b.losses - (a.wins + a.losses)),
    byPick: (["standard", "goblin", "demon"] as const).flatMap((k) => (picks.has(k) ? [picks.get(k)!] : [])),
    priced,
    unpriced,
  }
}

export interface SideRecord extends LegRecord {
  /** "nba|UNDER"; the league half is "unrecorded" for legs logged before leagues were. */
  key: string
  league: LoggedLeagueId | null
  side: "OVER" | "UNDER"
  /**
   * The per-leg hit rate these legs' entries needed to break even, averaged
   * over the legs whose entry had a payout to work it from. A record means
   * nothing without it: 60% is a winning rate on a standard 2-pick and a
   * losing one on a four-goblin 4-pick paying 4x, which needs 70.7%.
   */
  needed: number | null
  /** How many of the decided legs that average covers. */
  neededLegs: number
}

/**
 * Settled legs split by league and side: NBA overs, NBA unders, NFL overs...
 *
 * This is the record that answers "unders don't work in the NBA", and it is
 * built from every decided leg, priced or not, because most of what gets
 * played is logged straight off the app and never priced. The stat-and-side
 * rows above it split the same legs too finely to say anything about a side
 * as a whole: "Assists unders 0-1" and "Points unders 1-1" are both too small
 * to read, where "NBA unders 1-2" at least starts a count.
 *
 * The league is the leg's competition where one was recorded — a college leg
 * in an NFL entry is a college leg — and the section it was played in
 * otherwise. Legs logged before either was recorded get their own row rather
 * than a guess.
 */
export function recordBySide(slips: TrackedSlip[], apps: BookApp[]): SideRecord[] {
  const map = new Map<string, SideRecord & { neededSum: number }>()
  for (const s of slips) {
    const be = entryBreakEven(s, apps)
    for (const l of s.legs) {
      if (l.result !== "WIN" && l.result !== "LOSS") continue
      const league = l.competition ?? l.league ?? null
      const key = `${league ?? "unrecorded"}|${l.side}`
      const sides = l.side === "OVER" ? "overs" : "unders"
      const r =
        map.get(key) ??
        {
          key,
          league,
          side: l.side,
          label: league ? `${loggedLeagueShort(league)} ${sides}` : `${sides[0].toUpperCase()}${sides.slice(1)}, league not recorded`,
          wins: 0,
          losses: 0,
          needed: null,
          neededLegs: 0,
          neededSum: 0,
        }
      if (l.result === "WIN") r.wins++
      else r.losses++
      if (be != null) {
        r.neededSum += be
        r.neededLegs++
      }
      map.set(key, r)
    }
  }
  const order = (r: SideRecord) => (r.league ? LOGGED_LEAGUE_IDS.indexOf(r.league) : LOGGED_LEAGUE_IDS.length)
  return Array.from(map.values())
    .map(({ neededSum, ...r }) => ({ ...r, needed: r.neededLegs > 0 ? neededSum / r.neededLegs : null }))
    .sort((a, b) => order(a) - order(b) || (a.side === b.side ? 0 : a.side === "OVER" ? -1 : 1))
}

export interface SideComparison {
  /** Hit rate of the overs minus the unders'. Positive: the overs are doing better. */
  gap: number
  /** Standard error of that gap, pooled under the hypothesis that the sides hit alike. */
  stderr: number
  /** True only when the gap is over two standard errors and both sides have twenty legs. */
  significant: boolean
}

/**
 * Whether one league's overs and unders really are hitting at different rates.
 *
 * Two proportions and the standard error of their difference: the simplest
 * honest test, and the only one a few dozen legs can support. It says nothing
 * about WHY — a side can trail because of the lines chosen, the goblins on it
 * or the payouts it was played at — only whether the gap is bigger than the
 * coin would make on its own. Null until both sides have a leg.
 */
export function compareSides(overs: LegRecord, unders: LegRecord): SideComparison | null {
  const n1 = overs.wins + overs.losses
  const n2 = unders.wins + unders.losses
  if (n1 === 0 || n2 === 0) return null
  const p1 = overs.wins / n1
  const p2 = unders.wins / n2
  // Pooled, as the test of "no difference" should be: under that hypothesis
  // both sides share one rate. Unpooled, a 3-0 against a 0-3 has a variance of
  // zero on each side and six legs would read as proof.
  const pooled = (overs.wins + unders.wins) / (n1 + n2)
  const stderr = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  const gap = p1 - p2
  return { gap, stderr, significant: Math.abs(gap) > 2 * stderr && n1 >= 20 && n2 >= 20 }
}

export interface DraftLeg {
  player: string
  marketKey: MarketKey | null
  marketLabel: string
  line: number
  side: "OVER" | "UNDER" | null
  result: LegResult
  /** Read off the screenshot's colours or typed; unknown when neither said. */
  pickType?: PickType
  /** Why this row needs a look before it is saved. */
  note: string | null
}

const RESULT_WORDS: [RegExp, LegResult][] = [
  [/^(win|won|w|hit|cashed)$/i, "WIN"],
  [/^(loss|lost|l|miss|missed)$/i, "LOSS"],
  [/^(dnp|void|reboot|voided)$/i, "VOID"],
  [/^push$/i, "PUSH"],
]

/**
 * Legs typed one per line, the way you would read them off the entry:
 *
 *   Jordan Addison under 5.5 Recs win
 *   Tyler Allgeier over 2.5 Rush Yards loss
 *   Jack Bech over 0.5 Rec Yards dnp
 *
 * The result word at the end is optional. A line that does not read as a leg
 * is kept with a note rather than dropped, so nothing typed disappears.
 */
export function legsFromText(text: string): DraftLeg[] {
  const out: DraftLeg[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const tokens = line.split(/\s+/)
    let result: LegResult = "PENDING"
    let pickType: PickType | undefined
    // "goblin" or "demon" anywhere in the line: "Jerry Jeudy over 0.5 Recs goblin win".
    for (let i = tokens.length - 1; i >= 0; i--) {
      const w = tokens[i].toLowerCase().replace(/[^a-z]/g, "")
      if (w === "goblin" || w === "demon") {
        pickType = w
        tokens.splice(i, 1)
      }
    }
    const last = tokens[tokens.length - 1].replace(/[^A-Za-z]/g, "")
    const hit = RESULT_WORDS.find(([re]) => re.test(last))
    if (hit && tokens.length > 1) {
      result = hit[1]
      tokens.pop()
    }
    const c = extractProps(linesFromText(tokens.join(" "))).candidates[0]
    if (!c) {
      out.push({ player: line, marketKey: null, marketLabel: "", line: Number.NaN, side: null, result, pickType, note: "Could not read a player, line and stat from this line." })
      continue
    }
    const d = draftFromCandidate(c, result)
    out.push(pickType ? { ...d, pickType } : d)
  }
  return out
}

export function draftFromCandidate(c: PropCandidate, result: LegResult = "PENDING"): DraftLeg {
  // A stat the extractor could not model already carries its own note.
  const notes = [c.side ? null : "Pick over or under.", ...c.issues.filter((i) => !i.startsWith("Marked Reboot"))].filter(Boolean)
  return {
    player: c.player,
    marketKey: c.marketKey,
    marketLabel: c.marketLabel,
    line: c.line,
    side: c.side ?? null,
    // A Reboot outranks the ring: the player did not play, whatever colour
    // the screen draws. A result typed beside the leg outranks it too.
    result: c.dnp ? "VOID" : result !== "PENDING" ? result : (c.outcome ?? "PENDING"),
    // Read in colour: a face means a goblin or demon, none a standard pick.
    // Not read in colour (typed text): unknown.
    pickType: c.boost === undefined ? undefined : (c.boost ?? "standard"),
    note: notes.length ? notes.join(" ") : null,
  }
}
