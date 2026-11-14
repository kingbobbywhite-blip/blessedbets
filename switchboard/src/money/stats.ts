/**
 * What the journal says, as numbers. The one that matters is expectancy in R:
 * what a trade of a given setup is worth in units of what it risked. A setup
 * can win most of the time and still lose money, which is the difference
 * between a setup that feels good and one that pays.
 */
import type { DayState, SetupReport, SetupVerdict, Trade, TradeStats } from '../shared/money.ts'
import { rText } from '../shared/money.ts'
import { round2, round4 } from './instruments.ts'
import { tradingDay, tradingDayBounds, weekStart } from './time.ts'

/** Trades before an average means anything. */
export const MIN_SAMPLE = 20

export type StatTrade = Pick<Trade, 'pnl' | 'r_multiple' | 'fees' | 'setup' | 'symbol' | 'closed_at' | 'opened_at' | 'violations' | 'mistakes' | 'status'>

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

function drawdown(series: number[]): number {
  let peak = 0
  let running = 0
  let worst = 0
  for (const x of series) {
    running += x
    if (running > peak) peak = running
    if (peak - running > worst) worst = peak - running
  }
  return worst
}

/** Statistics over closed trades. Open trades are ignored. */
export function tradeStats(trades: StatTrade[]): TradeStats {
  const closed = trades
    .filter(t => t.status === 'closed' && t.pnl !== null)
    .sort((a, b) => String(a.closed_at ?? '').localeCompare(String(b.closed_at ?? '')))
  const pnls = closed.map(t => t.pnl as number)
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p < 0)
  const rs = closed.filter(t => t.r_multiple !== null).map(t => t.r_multiple as number)
  const grossWin = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
  const avgWin = mean(wins)
  const avgLoss = mean(losses)
  const mistakes: Record<string, number> = {}
  for (const t of closed) for (const m of t.mistakes ?? []) mistakes[m] = (mistakes[m] ?? 0) + 1
  const expectancy = mean(rs)
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    scratches: closed.length - wins.length - losses.length,
    win_rate: closed.length ? round4(wins.length / closed.length) : null,
    pnl: round2(pnls.reduce((a, b) => a + b, 0)),
    fees: round2(closed.reduce((a, t) => a + (t.fees ?? 0), 0)),
    avg_win: avgWin === null ? null : round2(avgWin),
    avg_loss: avgLoss === null ? null : round2(avgLoss),
    payoff: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? round2(avgWin / Math.abs(avgLoss)) : null,
    profit_factor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    r_trades: rs.length,
    expectancy_r: expectancy === null ? null : round4(expectancy),
    total_r: round2(rs.reduce((a, b) => a + b, 0)),
    max_drawdown: round2(drawdown(pnls)),
    max_drawdown_r: round2(drawdown(rs)),
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
    rule_breaks: closed.filter(t => (t.violations ?? []).length > 0).length,
    mistakes,
  }
}

/** How many standard errors the average is from zero. Null with fewer than two values or no spread. */
export function tStat(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs) as number
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)
  if (variance === 0) return m === 0 ? 0 : m > 0 ? Infinity : -Infinity
  return m / Math.sqrt(variance / xs.length)
}

/**
 * Whether a set of trades makes money, said as plainly as the evidence allows.
 * Judged on R when enough trades had a stop, on dollars otherwise.
 */
export function judge(trades: StatTrade[], stats: TradeStats = tradeStats(trades)): { verdict: SetupVerdict; line: string; feels_good_only: boolean } {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl !== null)
  const rs = closed.filter(t => t.r_multiple !== null).map(t => t.r_multiple as number)
  const useR = rs.length >= MIN_SAMPLE
  const sample = useR ? rs : closed.map(t => t.pnl as number)
  const n = sample.length
  if (n < MIN_SAMPLE) {
    const each = n === 0 ? 'No closed trades yet' : `${n} trade${n === 1 ? '' : 's'}`
    return { verdict: 'too_few', line: `${each}: too few to judge. It takes about ${MIN_SAMPLE} before an average means anything.`, feels_good_only: false }
  }
  const avg = mean(sample) as number
  const t = tStat(sample) ?? 0
  const each = useR ? `${rText(avg)} a trade` : `${avg >= 0 ? '+' : '-'}$${Math.abs(avg).toFixed(2)} a trade`
  const winners = stats.win_rate === null ? '' : ` (${Math.round(stats.win_rate * 100)}% winners)`
  let verdict: SetupVerdict
  let line: string
  if (avg > 0 && t >= 2) {
    verdict = 'makes_money'
    line = `Makes money: ${each} over ${n} trades${winners}.`
  } else if (avg > 0 && t >= 1) {
    verdict = 'probably_makes_money'
    line = `Probably makes money: ${each} over ${n} trades${winners}, but that is not yet clear of luck.`
  } else if (avg < 0 && t <= -2) {
    verdict = 'loses_money'
    line = `Loses money: ${each} over ${n} trades${winners}.`
  } else if (avg < 0 && t <= -1) {
    verdict = 'probably_loses'
    line = `Probably loses money: ${each} over ${n} trades${winners}.`
  } else {
    verdict = 'unclear'
    line = `Not clear either way: ${each} over ${n} trades${winners}.`
  }
  const feelsGood = avg < 0 && stats.win_rate !== null && stats.win_rate >= 0.55
  if (feelsGood && stats.payoff !== null && stats.payoff > 0) {
    line += ` It wins ${Math.round((stats.win_rate as number) * 100)}% of the time, and the losers are ${(1 / stats.payoff).toFixed(1)} times the size of the winners.`
  }
  return { verdict, line, feels_good_only: feelsGood }
}

/** One report per setup, best expectancy first; trades with no setup come last as "(none)". */
export function bySetup(trades: StatTrade[]): SetupReport[] {
  const groups = new Map<string, StatTrade[]>()
  for (const t of trades) {
    if (t.status !== 'closed') continue
    const key = t.setup ?? '(none)'
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  const out: SetupReport[] = []
  for (const [setup, list] of groups) {
    const stats = tradeStats(list)
    out.push({ setup, ...stats, ...judge(list, stats) })
  }
  return out.sort((a, b) => Number(a.setup === '(none)') - Number(b.setup === '(none)') || (b.expectancy_r ?? -Infinity) - (a.expectancy_r ?? -Infinity) || b.pnl - a.pnl)
}

/** Statistics per group, by any key: symbol, weekday, hour. */
export function groupStats(trades: StatTrade[], key: (t: StatTrade) => string): Record<string, TradeStats> {
  const groups = new Map<string, StatTrade[]>()
  for (const t of trades) {
    if (t.status !== 'closed') continue
    const k = key(t)
    groups.set(k, [...(groups.get(k) ?? []), t])
  }
  return Object.fromEntries([...groups].map(([k, list]) => [k, tradeStats(list)]))
}

type DayTrade = Pick<Trade, 'status' | 'pnl' | 'risk_amount' | 'opened_at' | 'closed_at'>

/**
 * Where an account stands in its trading day, from its trades: what it has
 * made or lost, how many it has taken, how many losses in a row.
 */
export function dayStateFrom(trades: DayTrade[], opts: { now: Date; timezone: string; dayStart: string; balance: number | null }): DayState {
  const day = tradingDay(opts.now, opts.timezone, opts.dayStart)
  const { start, end } = tradingDayBounds(day, opts.timezone, opts.dayStart)
  const weekBegin = tradingDayBounds(weekStart(day), opts.timezone, opts.dayStart).start
  const within = (iso: string | null, from: Date, to: Date) => {
    if (!iso) return false
    const t = new Date(iso).getTime()
    return t >= from.getTime() && t < to.getTime()
  }
  const closedToday = trades
    .filter(t => t.status === 'closed' && t.pnl !== null && within(t.closed_at, start, end))
    .sort((a, b) => new Date(a.closed_at as string).getTime() - new Date(b.closed_at as string).getTime())
  let streak = 0
  for (let i = closedToday.length - 1; i >= 0; i--) {
    const pnl = closedToday[i].pnl as number
    if (pnl < 0) streak++
    else if (pnl > 0) break
    // A scratch neither counts nor resets the run.
  }
  const lastLoss = [...closedToday].reverse().find(t => (t.pnl as number) < 0)
  const open = trades.filter(t => t.status === 'open')
  return {
    day,
    realized: round2(closedToday.reduce((a, t) => a + (t.pnl as number), 0)),
    week_realized: round2(trades.filter(t => t.status === 'closed' && t.pnl !== null && within(t.closed_at, weekBegin, end)).reduce((a, t) => a + (t.pnl as number), 0)),
    trades_today: trades.filter(t => within(t.opened_at, start, end)).length,
    consecutive_losses: streak,
    last_loss_at: lastLoss?.closed_at ?? null,
    open_positions: open.length,
    open_risk: round2(open.reduce((a, t) => a + (t.risk_amount ?? 0), 0)),
    balance: opts.balance,
  }
}

/** Percentile by linear interpolation, on a sorted list. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const i = (sorted.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return round2(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo))
}
