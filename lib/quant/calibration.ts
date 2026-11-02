import { clamp, normalCdf, normalInvCdf } from "./math"
import type { MarketKey } from "@/lib/nba/markets"
import type { LeagueId, LoggedLeagueId } from "@/lib/leagues"

/**
 * Did the model tell the truth?
 *
 * A betting model is not judged by its win rate. It is judged by calibration:
 * when it says 60%, do those legs land 60% of the time? A model that says 70%
 * and hits 55% will bankrupt you slowly while looking like bad luck. This is the
 * only part of the app that can tell you the projections are wrong, so it
 * matters more than any single recommendation.
 *
 * It needs volume. Fifty legs tell you almost nothing; several hundred start to
 * be informative. The sample size is reported alongside every number for that
 * reason.
 */

export interface Observation {
  /** Probability the model gave before the game. */
  p: number
  /** Did it actually cash? Pushes should be excluded by the caller. */
  win: boolean
  /**
   * What the leg was, so the same legs can be read along a second axis.
   * Absent on legs logged before any of this was recorded, which report in
   * their own bucket rather than being folded into a guess.
   */
  competition?: LeagueId
  /** Wider than competition: a retired league's legs still have to report. */
  league?: LoggedLeagueId
  market?: MarketKey | null
  marketLabel?: string
  /** Over or under, so a side that the model flatters shows up as its own row. */
  side?: "OVER" | "UNDER"
}

export interface CalibrationBucket {
  lo: number
  hi: number
  count: number
  /** Average probability the model predicted in this bucket. */
  predicted: number
  /** Fraction that actually won. */
  actual: number
  /** Standard error on the actual rate, for judging whether a gap is real. */
  stderr: number
}

export function calibrationBuckets(obs: Observation[], edges = [0.5, 0.55, 0.6, 0.65, 0.7, 1.01]): CalibrationBucket[] {
  const lows = [0, ...edges.slice(0, -1)]
  const out: CalibrationBucket[] = []
  for (let i = 0; i < edges.length; i++) {
    const lo = lows[i]
    const hi = edges[i]
    const inBucket = obs.filter((o) => o.p >= lo && o.p < hi)
    if (inBucket.length === 0) {
      out.push({ lo, hi, count: 0, predicted: 0, actual: 0, stderr: 0 })
      continue
    }
    const predicted = inBucket.reduce((a, o) => a + o.p, 0) / inBucket.length
    const wins = inBucket.filter((o) => o.win).length
    const actual = wins / inBucket.length
    out.push({
      lo,
      hi,
      count: inBucket.length,
      predicted,
      actual,
      stderr: Math.sqrt(Math.max(actual * (1 - actual), 1e-9) / inBucket.length),
    })
  }
  return out
}

/** Mean squared error of the probabilities. Lower is better; 0.25 is a coin flip. */
export function brierScore(obs: Observation[]): number | null {
  if (obs.length === 0) return null
  return obs.reduce((a, o) => a + Math.pow(o.p - (o.win ? 1 : 0), 2), 0) / obs.length
}

/** Average negative log likelihood. Punishes confident mistakes hard. */
export function logLoss(obs: Observation[]): number | null {
  if (obs.length === 0) return null
  return (
    -obs.reduce((a, o) => {
      const p = clamp(o.p, 1e-6, 1 - 1e-6)
      return a + (o.win ? Math.log(p) : Math.log(1 - p))
    }, 0) / obs.length
  )
}

/**
 * Overall bias: positive means the model is overconfident, i.e. it predicted a
 * higher hit rate than it delivered.
 */
export function calibrationBias(obs: Observation[]): number | null {
  if (obs.length === 0) return null
  const predicted = obs.reduce((a, o) => a + o.p, 0) / obs.length
  const actual = obs.filter((o) => o.win).length / obs.length
  return predicted - actual
}

export interface Performance {
  entries: number
  settled: number
  staked: number
  returned: number
  profit: number
  /** Profit divided by amount staked. */
  roi: number | null
  /** What the model said the return should have been. */
  expectedRoi: number | null
  wins: number
  losses: number
}

export function summarise(
  slips: { stake: number; actualMultiple: number | null; evAtEntry: number | null; status: string }[],
): Performance {
  const settled = slips.filter((s) => s.status === "SETTLED" && s.actualMultiple != null)
  const staked = settled.reduce((a, s) => a + s.stake, 0)
  const returned = settled.reduce((a, s) => a + s.stake * (s.actualMultiple ?? 0), 0)
  // Only entries the model priced have an expectation to compare against.
  const modelled = settled.filter((s) => s.evAtEntry != null)
  const modelledStake = modelled.reduce((a, s) => a + s.stake, 0)
  const expectedReturn = modelled.reduce((a, s) => a + s.stake * (1 + (s.evAtEntry ?? 0)), 0)
  return {
    entries: slips.length,
    settled: settled.length,
    staked,
    returned,
    profit: returned - staked,
    roi: staked > 0 ? (returned - staked) / staked : null,
    expectedRoi: modelledStake > 0 ? (expectedReturn - modelledStake) / modelledStake : null,
    wins: settled.filter((s) => (s.actualMultiple ?? 0) > 1).length,
    losses: settled.filter((s) => (s.actualMultiple ?? 0) <= 1).length,
  }
}

// ---------------------------------------------------------------------------
// Reading the same legs along a second axis
// ---------------------------------------------------------------------------

export interface GroupedCalibration {
  /** What this row is: a competition id, a market key, or the absent bucket. */
  key: string
  label: string
  count: number
  predicted: number
  actual: number
  stderr: number
  /**
   * The gap, with the sign that matters: positive means the model was more
   * confident than the results. Negative is not good news either; it means the
   * distribution is wider than it needs to be and edges are being missed.
   */
  bias: number
  /**
   * The variance multiplier that would reconcile the two, or null when the
   * sample is too small or the arithmetic degenerate. See impliedDispersion.
   */
  impliedDispersion: number | null
  /**
   * True when the answer is the end of the dial's range rather than a value
   * inside it: the gap is bigger than the dial can express, and the honest
   * reading is "as far as it goes, and it still will not be enough".
   */
  dispersionPegged: boolean
  /** True when the gap is larger than two standard errors on this sample. */
  significant: boolean
}

/**
 * The range of the outcome-spread dial in Settings, which is what this number
 * is for. A multiplier outside it is not advice anyone can take.
 */
export const DISPERSION_DIAL_RANGE = { min: 0.7, max: 1.8 }

/**
 * How much wider the distribution would have to be for the predictions to
 * match the results.
 *
 * Under a normal approximation a prediction p sits z = Phi^-1(p) standard
 * deviations from the line. The dial multiplies VARIANCE, so a multiplier k
 * scales sd by sqrt(k) and z by 1/sqrt(k): the k that would have turned these
 * predictions into this hit rate is the one solving mean_i Phi(z_i / sqrt(k)) =
 * actual. Above 1 means the model was overconfident and the dial should go up.
 *
 * Solved over the individual legs rather than on the group's average
 * probability, because Phi^-1 of a mean is not the mean of Phi^-1: a group
 * holding a 55% leg and an 85% leg does not behave like two 70% legs, and
 * inverting the average silently claimed it did.
 *
 * Four honest limits, all of which belong next to the number on screen:
 *
 *   It is a normal approximation to count distributions, so it is a direction
 *   and a rough size, not a fitted parameter.
 *
 *   It measures what is LEFT after every correction the app already applies,
 *   including the kickoff widening, because the stored probability had those
 *   baked in. It cannot be used to fit them; it says whether the total was
 *   enough.
 *
 *   A realised rate near a coin flip needs an enormous width to explain, and
 *   predictions already near one say nothing about width at all. Both come
 *   back null rather than as a number nobody can act on.
 *
 *   Beyond the dial's own range there is no advice to give, so it reports the
 *   limit it exceeded rather than a figure like 25 that would send someone to
 *   pin a slider that stops at 1.8.
 */
export function impliedDispersion(legs: Observation[], minCount = 25): number | null {
  const count = legs.length
  if (count < minCount) return null

  const actual = clamp(legs.filter((o) => o.win).length / count, 1e-4, 1 - 1e-4)
  const zs = legs.map((o) => normalInvCdf(clamp(o.p, 1e-4, 1 - 1e-4)))
  const meanZ = zs.reduce((a, z) => a + z, 0) / zs.length
  const zActual = normalInvCdf(actual)
  // Predictions sitting on a coin flip carry no information about width: every
  // width gives 50% at the line.
  if (Math.abs(meanZ) < 0.1) return null
  // A realised rate on the coin flip needs an infinite width to explain, and a
  // rate on the other side of it is the wrong SIDE rather than the wrong width.
  if (Math.abs(zActual) < 0.1 || meanZ * zActual < 0) return null

  // Monotone in k, so a bisection over the dial's range answers whether the
  // dial can express it at all.
  const hit = (k: number) => zs.reduce((a, z) => a + normalCdf(z / Math.sqrt(k)), 0) / zs.length
  const { min, max } = DISPERSION_DIAL_RANGE
  // hit() falls as k rises: more spread pulls every leg toward 50%.
  if (hit(max) > actual) return max
  if (hit(min) < actual) return min
  let lo = min
  let hi = max
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (hit(mid) > actual) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The same settled legs, grouped along whichever axis is passed.
 *
 * Deliberately one axis at a time rather than a cross-product. Competition by
 * market by probability band is thirty or more cells, and with a hundred-odd
 * settled legs almost every one of them would render a number built on five
 * results. Two separate tables, each with a floor under it, say something; a
 * grid of noise says less than nothing because it invites a reaction.
 */
export function groupedCalibration(
  obs: Observation[],
  axis: (o: Observation) => { key: string; label: string } | null,
  opts: { minCount?: number } = {},
): GroupedCalibration[] {
  const minCount = opts.minCount ?? 25
  const groups = new Map<string, { label: string; obs: Observation[] }>()
  for (const o of obs) {
    const at = axis(o)
    const key = at?.key ?? "unrecorded"
    const label = at?.label ?? "Before this was recorded"
    const g = groups.get(key)
    if (g) g.obs.push(o)
    else groups.set(key, { label, obs: [o] })
  }

  const out: GroupedCalibration[] = []
  for (const [key, g] of groups) {
    const count = g.obs.length
    const predicted = g.obs.reduce((a, o) => a + o.p, 0) / count
    const actual = g.obs.filter((o) => o.win).length / count
    const stderr = Math.sqrt(Math.max(actual * (1 - actual), 1e-9) / count)
    const implied = impliedDispersion(g.obs, minCount)
    out.push({
      key,
      label: g.label,
      count,
      predicted,
      actual,
      stderr,
      bias: predicted - actual,
      impliedDispersion: implied,
      dispersionPegged:
        implied != null && (implied >= DISPERSION_DIAL_RANGE.max || implied <= DISPERSION_DIAL_RANGE.min),
      significant: Math.abs(predicted - actual) > 2 * stderr && count >= 20,
    })
  }
  return out.sort((a, b) => b.count - a.count)
}
