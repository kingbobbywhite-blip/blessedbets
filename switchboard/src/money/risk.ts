/**
 * The guardrails. Everything here is arithmetic on the day's trades and the
 * account's limits: no model decides whether a trade is allowed, and nothing a
 * session says can talk a limit out of applying.
 *
 * Two things follow from the limits. A proposal that breaks one is refused
 * before anyone is asked to approve it. And an account whose day has hit a
 * limit is locked until the next trading day; that lock is worked out from
 * the trades themselves, so the only way to clear it early is for the trades
 * to be wrong (a typo) and corrected.
 */
import type { Asset, DayState, Lock, OrderType, RiskCheck, RiskRules, RiskStatus, Side, Violation } from '../shared/money.ts'
import { RISK_RULE_KEYS, money } from '../shared/money.ts'
import { futuresRoot, round2, tradeReward, tradeRisk } from './instruments.ts'
import { addDays, clockText, inWindow, parseClock, parseDate, startOfDay, tradingDayBounds, weekStart, daysBetween } from './time.ts'

export interface OrderIntent {
  symbol: string
  asset: Asset
  side: Side
  qty: number
  multiplier: number
  /** The price it would get in at: the limit, the stop trigger, or the last price for a market order. */
  entry: number | null
  stop_loss: number | null
  target: number | null
  order_type: OrderType
  setup: string | null
  setup_status: string | null
  /** Dollars at risk, when it is stated rather than worked out from a stop (a cash-secured put, a spread). */
  stated_risk: number | null
  details: Record<string, unknown>
}

export interface CheckContext {
  now: Date
  timezone: string
  dayStart: string
  paper: boolean
  /** Locks that are stored: HALT ALL, or a manual lock on this account. */
  storedLocks: Lock[]
  /** What this setup has done so far, when it has been traded. */
  setupStats?: { trades: number; expectancy_r: number | null } | null
  /** Whether the setup has a backtest on record. */
  setupBacktested?: boolean
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/** Whether an account has the two limits without which nothing may be proposed. */
export function hasLossLimits(rules: RiskRules): boolean {
  return positive(rules.daily_loss_limit) && (positive(rules.max_risk_per_trade) || positive(rules.max_risk_pct))
}

/** The most one trade may risk, from the dollar cap and the percent cap, whichever is smaller. */
export function riskCap(rules: RiskRules, balance: number | null): number | null {
  const caps: number[] = []
  if (positive(rules.max_risk_per_trade)) caps.push(rules.max_risk_per_trade)
  if (positive(rules.max_risk_pct) && balance !== null && balance > 0) caps.push(round2((balance * rules.max_risk_pct) / 100))
  return caps.length ? Math.min(...caps) : null
}

/**
 * The locks that follow from the day's trades: the daily and weekly loss
 * limits, a run of losses, and the sit-out after a loss.
 */
export function derivedLocks(account: string, rules: RiskRules, state: DayState, ctx: { now: Date; timezone: string; dayStart: string }): Lock[] {
  const locks: Lock[] = []
  const dayEnd = tradingDayBounds(state.day, ctx.timezone, ctx.dayStart).end
  if (positive(rules.daily_loss_limit) && state.realized <= -rules.daily_loss_limit) {
    locks.push({
      kind: 'daily_loss',
      account,
      reason: `Down ${money(-state.realized)} today against a ${money(rules.daily_loss_limit)} daily loss limit.`,
      until: dayEnd.toISOString(),
    })
  }
  if (positive(rules.weekly_loss_limit) && state.week_realized <= -rules.weekly_loss_limit) {
    const nextMonday = addDays(weekStart(state.day), 7)
    locks.push({
      kind: 'weekly_loss',
      account,
      reason: `Down ${money(-state.week_realized)} this week against a ${money(rules.weekly_loss_limit)} weekly loss limit.`,
      until: tradingDayBounds(nextMonday, ctx.timezone, ctx.dayStart).start.toISOString(),
    })
  }
  if (positive(rules.max_consecutive_losses) && state.consecutive_losses >= rules.max_consecutive_losses) {
    locks.push({
      kind: 'loss_streak',
      account,
      reason: `${state.consecutive_losses} losing trades in a row; the limit is ${rules.max_consecutive_losses}.`,
      until: dayEnd.toISOString(),
    })
  }
  if (positive(rules.cooldown_minutes) && state.last_loss_at) {
    const until = new Date(new Date(state.last_loss_at).getTime() + rules.cooldown_minutes * 60_000)
    if (until.getTime() > ctx.now.getTime() && until.getTime() < dayEnd.getTime() + 1) {
      locks.push({
        kind: 'cooldown',
        account,
        reason: `Sitting out ${rules.cooldown_minutes} minutes after a losing trade.`,
        until: until.toISOString(),
      })
    }
  }
  return locks
}

/** Stored locks (HALT ALL, a manual lock) that apply to this account right now. */
export function activeStoredLocks(locks: Lock[], account: string, now: Date): Lock[] {
  return locks.filter(l => (l.account === null || l.account === account) && (!l.until || new Date(l.until).getTime() > now.getTime()))
}

/**
 * Check an order against an account's limits. Used both for a proposal (where
 * a violation refuses it) and for a trade being written into the journal
 * after the fact (where a violation is recorded against it, since it happened).
 */
export function checkOrder(account: string, rules: RiskRules, state: DayState, order: OrderIntent, ctx: CheckContext): RiskCheck {
  const violations: Violation[] = []
  const warnings: Violation[] = []
  const fail = (rule: string, message: string) => violations.push({ rule, message })
  const warn = (rule: string, message: string) => warnings.push({ rule, message })

  // --- what the order risks and could make ----------------------------------
  let risk: number | null = null
  let reward: number | null = null
  if (order.stop_loss !== null && order.entry !== null) {
    try {
      risk = tradeRisk({ side: order.side, qty: order.qty, multiplier: order.multiplier, entry: order.entry, stop: order.stop_loss })
    } catch (err) {
      fail('stop', (err as Error).message)
    }
  }
  if (risk === null && positive(order.stated_risk)) risk = round2(order.stated_risk)
  if (order.target !== null && order.entry !== null) {
    try {
      reward = tradeReward({ side: order.side, qty: order.qty, multiplier: order.multiplier, entry: order.entry, target: order.target })
    } catch (err) {
      fail('target', (err as Error).message)
    }
  }
  const rPlanned = risk !== null && risk > 0 && reward !== null ? Math.round((reward / risk) * 100) / 100 : null

  // --- locks -----------------------------------------------------------------
  for (const lock of [...activeStoredLocks(ctx.storedLocks, account, ctx.now), ...derivedLocks(account, rules, state, ctx)]) {
    fail(lock.kind, lock.kind === 'halt' ? `HALT ALL is on: ${lock.reason || 'everything is stopped until you lift it.'}` : lock.reason)
  }

  // --- limits that must exist ------------------------------------------------
  if (rules.proposals_off) fail('proposals_off', 'Orders for this account are not proposed here; it is run by its own system.')
  if (!hasLossLimits(rules)) {
    fail('limits_unset', 'This account has no daily loss limit and no maximum risk per trade yet. Set both before anything is proposed for it.')
  }

  // --- the order itself -------------------------------------------------------
  if (rules.require_stop !== false && risk === null) {
    fail('require_stop', 'No stop, and no stated risk: a trade has to say where it is wrong and what that costs.')
  }
  if (rules.require_setup !== false && !order.setup) fail('require_setup', 'No setup named. Every trade is one of your setups or it is not taken.')
  if (rules.require_live_setup && !ctx.paper && order.setup && order.setup_status !== 'live') {
    fail(
      'require_live_setup',
      `"${order.setup}" is ${order.setup_status ?? 'not in the playbook'}, not live. Backtest it, trade it on paper, then promote it yourself before real money goes on it.`,
    )
  }
  if (rules.no_market_orders && order.order_type === 'market') fail('no_market_orders', 'Market orders are off for this account. Use a limit.')
  if (rules.allowed_assets?.length && !rules.allowed_assets.includes(order.asset)) {
    fail('allowed_assets', `This account trades ${rules.allowed_assets.join(', ')} only, not ${order.asset}s.`)
  }
  const root = order.asset === 'future' ? futuresRoot(order.symbol) : order.symbol.trim().toUpperCase().split(/\s+/)[0]
  if (rules.allowed_symbols?.length && !rules.allowed_symbols.map(s => s.toUpperCase()).includes(root)) {
    fail('allowed_symbols', `${root} is not on this account's list (${rules.allowed_symbols.join(', ')}).`)
  }

  // --- size --------------------------------------------------------------------
  const cap = riskCap(rules, state.balance)
  if (cap !== null && risk !== null && risk > cap) {
    fail('max_risk', `This risks ${money(risk)}; the most one trade may risk is ${money(cap)}.`)
  }
  if (positive(rules.max_risk_pct) && !positive(rules.max_risk_per_trade) && (state.balance === null || state.balance <= 0)) {
    fail('max_risk', 'The risk limit is a percent of the balance, and this account has no balance entered.')
  }
  const symbolCap = rules.max_qty_by_symbol ? Object.entries(rules.max_qty_by_symbol).find(([k]) => k.toUpperCase() === root)?.[1] : undefined
  const qtyCap = positive(symbolCap) ? symbolCap : positive(rules.max_qty) ? rules.max_qty : null
  if (qtyCap !== null && order.qty > qtyCap) {
    fail('max_qty', `${order.qty} ${root} is over the limit of ${qtyCap} an order.`)
  }
  if (positive(rules.max_notional) && order.entry !== null) {
    const notional = round2(order.qty * order.entry * order.multiplier)
    if (notional > rules.max_notional) fail('max_notional', `A ${money(notional)} position is over the ${money(rules.max_notional)} limit.`)
  }
  if (positive(rules.min_reward_risk)) {
    if (rPlanned === null) fail('min_reward_risk', `No target, so the reward cannot be compared with the risk. This account needs at least ${rules.min_reward_risk} to 1.`)
    else if (rPlanned < rules.min_reward_risk) fail('min_reward_risk', `This pays ${rPlanned} to 1; the minimum is ${rules.min_reward_risk} to 1.`)
  }

  // --- the day ------------------------------------------------------------------
  if (positive(rules.max_trades_per_day) && state.trades_today >= rules.max_trades_per_day) {
    fail('max_trades_per_day', `${state.trades_today} trades taken today; the limit is ${rules.max_trades_per_day}.`)
  }
  if (positive(rules.max_open_positions) && state.open_positions >= rules.max_open_positions) {
    fail('max_open_positions', `${state.open_positions} positions are open; the limit is ${rules.max_open_positions}.`)
  }
  if (positive(rules.max_open_risk) && risk !== null && round2(state.open_risk + risk) > rules.max_open_risk) {
    fail('max_open_risk', `With this, ${money(state.open_risk + risk)} would be at risk across open trades; the limit is ${money(rules.max_open_risk)}.`)
  }
  if (positive(rules.daily_loss_limit) && rules.cap_risk_to_remaining !== false && risk !== null) {
    const left = round2(rules.daily_loss_limit + state.realized)
    if (left > 0 && risk > left) {
      fail('daily_loss_remaining', `Only ${money(left)} of today's ${money(rules.daily_loss_limit)} loss limit is left, and this risks ${money(risk)}.`)
    } else if (left > 0 && risk > left / 2) {
      warn('daily_loss_remaining', `This risks ${money(risk)} of the ${money(left)} left before today's loss limit.`)
    }
  }
  if (rules.window && !inWindow(ctx.now, ctx.timezone, rules.window)) {
    const start = parseClock(rules.window.start)
    const end = parseClock(rules.window.end)
    fail('window', `Outside this account's trading hours (${start === null ? rules.window.start : clockText(start)} to ${end === null ? rules.window.end : clockText(end)}).`)
  }

  // --- earnings ------------------------------------------------------------------
  if (positive(rules.earnings_blackout_days) && (order.asset === 'stock' || order.asset === 'option')) {
    const date = typeof order.details.earnings_date === 'string' ? order.details.earnings_date.slice(0, 10) : null
    const none = order.details.earnings_date === 'none'
    const today = state.day
    if (!none && (!date || !parseDate(date))) {
      fail('earnings', `State the next earnings date (earnings_date: "YYYY-MM-DD", or "none" for a fund): no entries within ${rules.earnings_blackout_days} days of earnings.`)
    } else if (date && parseDate(date)) {
      const days = daysBetween(today, date)
      if (days >= 0 && days <= rules.earnings_blackout_days) {
        fail('earnings', `${root} reports on ${date}, ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} away`}; no entries within ${rules.earnings_blackout_days} days of earnings.`)
      }
    }
  }

  // --- things worth knowing that do not refuse it -----------------------------
  if (positive(rules.max_trades_per_day) && state.trades_today === rules.max_trades_per_day - 1) {
    warn('max_trades_per_day', `This is the last trade today's limit of ${rules.max_trades_per_day} allows.`)
  }
  if (ctx.setupStats && ctx.setupStats.trades >= 20 && ctx.setupStats.expectancy_r !== null && ctx.setupStats.expectancy_r < 0) {
    warn('setup_record', `"${order.setup}" has lost ${Math.abs(ctx.setupStats.expectancy_r).toFixed(2)}R a trade over ${ctx.setupStats.trades} trades.`)
  }
  if (order.setup && ctx.setupBacktested === false && !rules.require_live_setup) {
    warn('setup_untested', `"${order.setup}" has no backtest on record.`)
  }
  if (order.target === null) warn('no_target', 'No target, so there is no planned reward to compare with the risk.')

  return { ok: violations.length === 0, violations, warnings, risk_amount: risk, reward_amount: reward, r_planned: rPlanned }
}

/**
 * Whether new limits are looser than the current ones anywhere, and where.
 * Looser limits wait for the next trading day: a limit that can be raised in
 * the middle of a losing day is not a limit.
 */
export function loosenedKeys(before: RiskRules, after: RiskRules): string[] {
  const out: string[] = []
  // A larger number allows more.
  const larger = ['daily_loss_limit', 'weekly_loss_limit', 'max_risk_per_trade', 'max_risk_pct', 'max_qty', 'max_notional', 'max_trades_per_day', 'max_consecutive_losses', 'max_open_positions', 'max_open_risk', 'max_stake', 'max_stake_pct'] as const
  for (const key of larger) {
    const a = before[key]
    const b = after[key]
    if (positive(a) && (!positive(b) || b > a)) out.push(key)
  }
  // A smaller number allows more.
  for (const key of ['cooldown_minutes', 'min_reward_risk', 'earnings_blackout_days'] as const) {
    const a = before[key]
    const b = after[key]
    if (positive(a) && (!positive(b) || b < a)) out.push(key)
  }
  // On unless switched off.
  for (const key of ['require_stop', 'require_setup', 'cap_risk_to_remaining'] as const) {
    if (before[key] !== false && after[key] === false) out.push(key)
  }
  // Off unless switched on.
  for (const key of ['require_live_setup', 'no_market_orders', 'proposals_off'] as const) {
    if (before[key] === true && after[key] !== true) out.push(key)
  }
  // Lists: dropping the list, or adding to it, allows more.
  for (const key of ['allowed_assets', 'allowed_symbols'] as const) {
    const a = before[key]
    const b = after[key]
    if (a?.length && (!b?.length || b.some(x => !a.map(s => s.toUpperCase()).includes(x.toUpperCase())))) out.push(key)
  }
  const a = before.max_qty_by_symbol ?? {}
  const b = after.max_qty_by_symbol ?? {}
  for (const [symbol, cap] of Object.entries(a)) {
    const next = Object.entries(b).find(([k]) => k.toUpperCase() === symbol.toUpperCase())?.[1]
    if (positive(cap) && (!positive(next) || next > cap)) {
      out.push('max_qty_by_symbol')
      break
    }
  }
  if (before.window) {
    const w = after.window
    const bs = parseClock(before.window.start)
    const be = parseClock(before.window.end)
    const as = w ? parseClock(w.start) : null
    const ae = w ? parseClock(w.end) : null
    const beforeDays = before.window.days?.length ? before.window.days : [0, 1, 2, 3, 4, 5, 6]
    const afterDays = w?.days?.length ? w.days : [0, 1, 2, 3, 4, 5, 6]
    if (!w || as === null || ae === null || bs === null || be === null || as < bs || ae > be || afterDays.some(d => !beforeDays.includes(d))) out.push('window')
  }
  return [...new Set(out)]
}

/** Keep only fields that are real limits, with the right types. Throws on a value that makes no sense. */
export function cleanRules(input: unknown): RiskRules {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const numeric = ['daily_loss_limit', 'weekly_loss_limit', 'max_risk_per_trade', 'max_risk_pct', 'max_qty', 'max_notional', 'max_trades_per_day', 'max_consecutive_losses', 'cooldown_minutes', 'max_open_positions', 'max_open_risk', 'min_reward_risk', 'earnings_blackout_days', 'max_stake', 'max_stake_pct']
  const booleans = ['require_stop', 'require_setup', 'require_live_setup', 'no_market_orders', 'cap_risk_to_remaining', 'proposals_off']
  for (const key of Object.keys(raw)) {
    if (!(RISK_RULE_KEYS as readonly string[]).includes(key)) throw new Error(`"${key}" is not a limit. The limits are: ${RISK_RULE_KEYS.join(', ')}.`)
    const v = raw[key]
    if (v === null || v === undefined || v === '') continue
    if (numeric.includes(key)) {
      const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : v
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`${key} must be a number of zero or more, not "${String(v)}".`)
      if ((key === 'max_risk_pct' || key === 'max_stake_pct') && n > 100) throw new Error(`${key} is a percent, so it cannot be over 100.`)
      if (n > 0) out[key] = n
    } else if (booleans.includes(key)) {
      if (typeof v !== 'boolean') throw new Error(`${key} is true or false.`)
      out[key] = v
    } else if (key === 'allowed_assets' || key === 'allowed_symbols') {
      const list = (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean)
      if (list.length) out[key] = key === 'allowed_symbols' ? list.map(s => s.toUpperCase()) : list.map(s => s.toLowerCase())
    } else if (key === 'max_qty_by_symbol') {
      if (typeof v !== 'object' || Array.isArray(v)) throw new Error('max_qty_by_symbol is a map of symbol to quantity, like {"ES": 1, "MES": 5}.')
      const map: Record<string, number> = {}
      for (const [symbol, qty] of Object.entries(v as Record<string, unknown>)) {
        const n = Number(qty)
        if (!Number.isFinite(n) || n <= 0) throw new Error(`max_qty_by_symbol.${symbol} must be a number above zero.`)
        map[symbol.toUpperCase()] = n
      }
      if (Object.keys(map).length) out[key] = map
    } else if (key === 'window') {
      const w = v as { start?: unknown; end?: unknown; days?: unknown }
      if (parseClock(w.start) === null || parseClock(w.end) === null) throw new Error('window needs a start and an end as HH:MM, like {"start": "06:30", "end": "11:00"}.')
      const days = Array.isArray(w.days) ? w.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : []
      out[key] = { start: String(w.start).trim(), end: String(w.end).trim(), ...(days.length ? { days } : {}) }
    }
  }
  return out as RiskRules
}

/** The limits in sentences, for the phone and for a session to read back. */
export function describeRules(rules: RiskRules): string[] {
  const out: string[] = []
  if (positive(rules.daily_loss_limit)) out.push(`Stop for the day at ${money(rules.daily_loss_limit)} down`)
  if (positive(rules.weekly_loss_limit)) out.push(`Stop for the week at ${money(rules.weekly_loss_limit)} down`)
  if (positive(rules.max_risk_per_trade)) out.push(`Risk at most ${money(rules.max_risk_per_trade)} a trade`)
  if (positive(rules.max_risk_pct)) out.push(`Risk at most ${rules.max_risk_pct}% of the account a trade`)
  if (positive(rules.max_qty)) out.push(`At most ${rules.max_qty} an order`)
  if (rules.max_qty_by_symbol) out.push(`Size by symbol: ${Object.entries(rules.max_qty_by_symbol).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  if (positive(rules.max_notional)) out.push(`Positions up to ${money(rules.max_notional)}`)
  if (positive(rules.max_trades_per_day)) out.push(`At most ${rules.max_trades_per_day} trades a day`)
  if (positive(rules.max_consecutive_losses)) out.push(`Stop for the day after ${rules.max_consecutive_losses} losses in a row`)
  if (positive(rules.cooldown_minutes)) out.push(`Sit out ${rules.cooldown_minutes} minutes after a loss`)
  if (positive(rules.max_open_positions)) out.push(`At most ${rules.max_open_positions} positions open`)
  if (positive(rules.max_open_risk)) out.push(`At most ${money(rules.max_open_risk)} at risk across open trades`)
  if (rules.window) {
    const s = parseClock(rules.window.start)
    const e = parseClock(rules.window.end)
    out.push(`Trade only ${s === null ? rules.window.start : clockText(s)} to ${e === null ? rules.window.end : clockText(e)}`)
  }
  if (rules.require_stop !== false) out.push('Every trade has a stop')
  if (rules.require_setup !== false) out.push('Every trade names its setup')
  if (rules.require_live_setup) out.push('Only setups promoted to live')
  if (positive(rules.min_reward_risk)) out.push(`At least ${rules.min_reward_risk} to 1`)
  if (positive(rules.earnings_blackout_days)) out.push(`No entries within ${rules.earnings_blackout_days} days of earnings`)
  if (rules.allowed_assets?.length) out.push(`Only ${rules.allowed_assets.join(', ')}`)
  if (rules.allowed_symbols?.length) out.push(`Only ${rules.allowed_symbols.join(', ')}`)
  if (rules.no_market_orders) out.push('No market orders')
  if (positive(rules.max_stake)) out.push(`At most ${money(rules.max_stake)} a bet`)
  if (positive(rules.max_stake_pct)) out.push(`At most ${rules.max_stake_pct}% of bankroll a bet`)
  if (rules.proposals_off) out.push('No orders are proposed for this account here')
  return out
}

/** The traffic light and the sentence that goes with it. */
export function statusOf(
  account: { id: string; name: string; desk: string; paper: boolean; risk: RiskRules; risk_pending: RiskStatus['pending_rules'] },
  state: DayState,
  locks: Lock[],
): RiskStatus {
  const rules = account.risk
  const dailyLeft = positive(rules.daily_loss_limit) ? round2(rules.daily_loss_limit + state.realized) : null
  const weeklyLeft = positive(rules.weekly_loss_limit) ? round2(rules.weekly_loss_limit + state.week_realized) : null
  const tradesLeft = positive(rules.max_trades_per_day) ? Math.max(0, rules.max_trades_per_day - state.trades_today) : null
  let light: RiskStatus['light'] = 'ok'
  let summary: string
  const blocking = locks.filter(l => l.kind !== 'cooldown')
  if (locks.length) {
    light = 'locked'
    const first = blocking[0] ?? locks[0]
    summary = first.kind === 'halt' ? `HALT ALL is on. ${first.reason}`.trim() : `${account.name} is locked. ${first.reason}`
  } else if (!hasLossLimits(rules) && !rules.proposals_off) {
    light = 'unset'
    summary = `${account.name} has no loss limits yet, so nothing can be proposed for it.`
  } else {
    const close = (dailyLeft !== null && positive(rules.daily_loss_limit) && dailyLeft <= rules.daily_loss_limit * 0.34) || tradesLeft === 0 || tradesLeft === 1
    if (close) light = 'caution'
    const bits = [`${state.realized >= 0 ? 'Up' : 'Down'} ${money(Math.abs(state.realized))} today`]
    if (dailyLeft !== null) bits.push(`${money(Math.max(0, dailyLeft))} left before the daily limit`)
    if (tradesLeft !== null) bits.push(`${tradesLeft} trade${tradesLeft === 1 ? '' : 's'} left`)
    summary = `${account.name}: ${bits.join(', ')}.`
  }
  return {
    account: account.id,
    name: account.name,
    desk: account.desk,
    paper: account.paper,
    state,
    rules,
    pending_rules: account.risk_pending,
    locks,
    light,
    summary,
    remaining: { daily_loss: dailyLeft, weekly_loss: weeklyLeft, trades: tradesLeft },
  }
}

/** When looser limits take effect: the start of the next trading day. */
export function nextDayStart(now: Date, day: string, timezone: string, dayStart: string): Date {
  const end = tradingDayBounds(day, timezone, dayStart).end
  return end.getTime() > now.getTime() ? end : startOfDay(addDays(day, 1), timezone)
}
