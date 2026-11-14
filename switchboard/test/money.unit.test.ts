import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cronMatches, describeCron, nextRun, parseCron } from '../src/money/cron.ts'
import { describeOrder, futuresRoot, futuresSpec, multiplierFor, tradePnl, tradeReward, tradeRisk } from '../src/money/instruments.ts'
import { checkOrder, cleanRules, derivedLocks, describeRules, hasLossLimits, loosenedKeys, riskCap, statusOf, type CheckContext, type OrderIntent } from '../src/money/risk.ts'
import { bySetup, dayStateFrom, judge, percentile, tStat, tradeStats, type StatTrade } from '../src/money/stats.ts'
import { addDays, inWindow, localDate, localParts, parseClock, startOfDay, tradingDay, tradingDayBounds, weekStart, zonedTime } from '../src/money/time.ts'
import type { DayState, RiskRules } from '../src/shared/money.ts'
import { money, rText } from '../src/shared/money.ts'

const LA = 'America/Los_Angeles'
const NY = 'America/New_York'

describe('wall clocks in a timezone', () => {
  it('reads the wall clock somewhere else', () => {
    const p = localParts(new Date('2026-11-16T13:45:00Z'), LA)
    assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday], [2026, 11, 16, 5, 45, 1])
    assert.equal(localDate(new Date('2026-11-16T07:59:00Z'), LA), '2026-11-15', 'still Sunday night in Los Angeles')
  })

  it('finds the instant a wall clock reads a time, across both clock changes', () => {
    assert.equal(zonedTime({ year: 2026, month: 11, day: 16, hour: 5, minute: 45 }, LA)?.toISOString(), '2026-11-16T13:45:00.000Z')
    assert.equal(zonedTime({ year: 2026, month: 7, day: 1, hour: 5, minute: 45 }, LA)?.toISOString(), '2026-07-01T12:45:00.000Z', 'summer time')
    // 2026-03-08 02:30 does not exist in Los Angeles: the clock goes from 01:59 to 03:00.
    assert.equal(zonedTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, LA), null)
    // 2026-11-01 01:30 happens twice; the first one is still on summer time.
    assert.equal(zonedTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, LA)?.toISOString(), '2026-11-01T08:30:00.000Z')
    assert.equal(startOfDay('2026-03-08', LA).toISOString(), '2026-03-08T08:00:00.000Z')
  })

  it('does date arithmetic without a timezone', () => {
    assert.equal(addDays('2026-02-28', 1), '2026-03-01')
    assert.equal(addDays('2026-01-01', -1), '2025-12-31')
    assert.equal(weekStart('2026-11-15'), '2026-11-09', 'Sunday belongs to the week that began the Monday before')
    assert.equal(weekStart('2026-11-16'), '2026-11-16')
    assert.equal(parseClock('06:30'), 390)
    assert.equal(parseClock('25:00'), null)
  })

  it('puts an evening session in the next trading day when the day starts in the evening', () => {
    const sundayEvening = new Date('2026-11-15T23:30:00Z') // 6:30pm New York, Sunday
    assert.equal(tradingDay(sundayEvening, NY), '2026-11-15')
    assert.equal(tradingDay(sundayEvening, NY, '18:00'), '2026-11-16', 'the Globex evening is Monday\'s session')
    const b = tradingDayBounds('2026-11-16', NY, '18:00')
    assert.equal(b.start.toISOString(), '2026-11-15T23:00:00.000Z')
    assert.equal(b.end.toISOString(), '2026-11-16T23:00:00.000Z')
    const plain = tradingDayBounds('2026-11-16', LA)
    assert.equal(plain.start.toISOString(), '2026-11-16T08:00:00.000Z')
    assert.equal(plain.end.toISOString(), '2026-11-17T08:00:00.000Z')
  })

  it('knows whether a moment is inside trading hours, including a window past midnight', () => {
    const w = { start: '06:30', end: '11:00', days: [1, 2, 3, 4, 5] }
    assert.ok(inWindow(new Date('2026-11-16T15:00:00Z'), LA, w), '7am Monday')
    assert.ok(!inWindow(new Date('2026-11-16T19:00:00Z'), LA, w), '11am is the end')
    assert.ok(!inWindow(new Date('2026-11-15T15:00:00Z'), LA, w), 'Sunday')
    const night = { start: '18:00', end: '02:00', days: [0, 1, 2, 3, 4] }
    assert.ok(inWindow(new Date('2026-11-16T09:00:00Z'), LA, night), '1am Monday is still Sunday\'s session')
    assert.ok(!inWindow(new Date('2026-11-15T09:00:00Z'), LA, night), '1am Sunday would be Saturday\'s session, which is not a day')
  })
})

describe('schedules', () => {
  it('reads lists, ranges, steps and names', () => {
    const s = parseCron('0,30 8-22/2 * * MON-FRI')
    assert.deepEqual(s.minutes, [0, 30])
    assert.deepEqual(s.hours, [8, 10, 12, 14, 16, 18, 20, 22])
    assert.deepEqual([...s.daysOfWeek], [1, 2, 3, 4, 5])
    assert.ok(s.domAny && !s.dowAny)
    assert.deepEqual([...parseCron('0 9 1 JAN,jul *').months], [1, 7])
    assert.deepEqual([...parseCron('0 9 * * 7').daysOfWeek], [0], '7 is Sunday')
  })

  it('takes the timezone from a CRON_TZ prefix', () => {
    const s = parseCron('CRON_TZ=America/Los_Angeles 30 7 1,15 * *')
    assert.equal(s.timezone, LA)
    assert.deepEqual([...s.daysOfMonth], [1, 15])
    assert.throws(() => parseCron('CRON_TZ=Mars/Olympus 0 9 * * *'), /not a timezone/)
  })

  it('says what is wrong with a schedule it cannot read', () => {
    assert.throws(() => parseCron('5 * * *'), /five fields/)
    assert.throws(() => parseCron('61 * * * *'), /outside 0-59/)
    assert.throws(() => parseCron('* * * * funday'), /not a day of the week/)
    assert.throws(() => parseCron('*/0 * * * *'), /step/)
  })

  it('finds the next run on the wall clock, whatever zone the machine is in', () => {
    const weekdays = parseCron('45 5 * * 1-5')
    // Friday 6am in Los Angeles: the next one is Monday.
    assert.equal(nextRun(weekdays, LA, new Date('2026-11-13T14:00:00Z'))?.toISOString(), '2026-11-16T13:45:00.000Z')
    // One second before it fires, and exactly when it fires.
    assert.equal(nextRun(weekdays, LA, new Date('2026-11-16T13:44:59Z'))?.toISOString(), '2026-11-16T13:45:00.000Z')
    assert.equal(nextRun(weekdays, LA, new Date('2026-11-16T13:45:00Z'))?.toISOString(), '2026-11-17T13:45:00.000Z')
    assert.equal(nextRun(parseCron('0 9 1 * *'), LA, new Date('2026-11-14T00:00:00Z'))?.toISOString(), '2026-12-01T17:00:00.000Z')
    assert.equal(nextRun(parseCron('0 0 30 2 *'), LA, new Date('2026-01-01T00:00:00Z')), null, 'February 30th never comes')
  })

  it('keeps the same wall-clock time through a clock change, and skips a time that does not exist', () => {
    const daily = parseCron('30 6 * * *')
    // Before and after the US change on 2026-03-08: 6:30am both days, an hour apart in UTC.
    assert.equal(nextRun(daily, LA, new Date('2026-03-07T00:00:00Z'))?.toISOString(), '2026-03-07T14:30:00.000Z')
    assert.equal(nextRun(daily, LA, new Date('2026-03-08T00:00:00Z'))?.toISOString(), '2026-03-08T13:30:00.000Z')
    // 2:30am does not exist on 2026-03-08, so that day is skipped.
    assert.equal(nextRun(parseCron('30 2 * * *'), LA, new Date('2026-03-08T00:00:00Z'))?.toISOString(), '2026-03-09T09:30:00.000Z')
  })

  it('matches either day field when both are restricted, as cron does', () => {
    const s = parseCron('0 9 13 * 5') // the 13th, or any Friday
    assert.ok(cronMatches(s, localParts(new Date('2026-11-13T17:00:00Z'), LA)), 'Friday the 13th')
    assert.ok(cronMatches(s, localParts(new Date('2026-11-20T17:00:00Z'), LA)), 'a Friday')
    assert.ok(cronMatches(s, localParts(new Date('2026-10-13T16:00:00Z'), LA)), 'a 13th that is a Tuesday')
    assert.ok(!cronMatches(s, localParts(new Date('2026-11-17T17:00:00Z'), LA)))
  })

  it('says a schedule in words', () => {
    assert.equal(describeCron('45 5 * * 1-5'), 'Weekdays at 5:45 AM')
    assert.equal(describeCron('0 17 * * 0'), 'Sundays at 5:00 PM')
    assert.equal(describeCron('0 9 1 * *'), 'On the 1st at 9:00 AM')
    assert.equal(describeCron('0 8-22/2 * * *'), 'Every day, every 2 hours from 8:00 AM to 10:00 PM')
    assert.equal(describeCron('*/15 * * * *'), 'Every day, every 15 minutes')
    assert.equal(describeCron('CRON_TZ=America/New_York 30 9 * * 1-5'), 'Weekdays at 9:30 AM (America/New_York)')
    assert.equal(describeCron('nonsense'), 'nonsense')
  })
})

describe('what a point is worth', () => {
  it('reads a futures root however the platform writes the symbol', () => {
    for (const s of ['MES', '/MES', 'MESZ6', 'MESZ26', 'mes=f', 'MES 12-26', 'MESZ6.CME']) assert.equal(futuresRoot(s), 'MES', s)
    assert.equal(futuresRoot('ESH27'), 'ES')
    assert.equal(futuresRoot('6EZ6'), '6E')
    assert.equal(futuresRoot('M2KZ6'), 'M2K')
    assert.equal(futuresSpec('NQZ6')?.multiplier, 20)
    assert.equal(futuresSpec('MNQ')?.tick_value, 0.5)
    assert.equal(futuresSpec('ES')?.tick_value, 12.5)
    assert.equal(futuresSpec('CL')?.tick_value, 10)
    assert.equal(futuresSpec('ZZZZ'), null)
  })

  it('has no default for a futures contract it does not know, 100 for an option and 1 for a share', () => {
    assert.equal(multiplierFor('future', 'MGC'), 10)
    assert.equal(multiplierFor('future', 'XYZZ9'), null)
    assert.equal(multiplierFor('option', 'AAPL 2026-12-18 200 P'), 100)
    assert.equal(multiplierFor('stock', 'AAPL'), 1)
  })

  it('works out P&L, risk and reward for longs and shorts', () => {
    // Long 2 MES from 5912.25 to 5924.25: 12 points x $5 x 2 = $120, less $2.48 fees.
    assert.equal(tradePnl({ side: 'long', qty: 2, multiplier: 5, entry: 5912.25, exit: 5924.25, fees: 2.48 }), 117.52)
    assert.equal(tradePnl({ side: 'short', qty: 1, multiplier: 20, entry: 21000, exit: 21010 }), -200)
    assert.equal(tradeRisk({ side: 'long', qty: 2, multiplier: 5, entry: 5912.25, stop: 5906.25 }), 60)
    assert.equal(tradeRisk({ side: 'short', qty: 1, multiplier: 20, entry: 21000, stop: 21012.5 }), 250)
    assert.equal(tradeReward({ side: 'long', qty: 2, multiplier: 5, entry: 5912.25, target: 5924.25 }), 120)
    // A short option: sold a put for 2.10, bought back at 0.40.
    assert.equal(tradePnl({ side: 'short', qty: 1, multiplier: 100, entry: 2.1, exit: 0.4, fees: 1.3 }), 168.7)
  })

  it('refuses a stop or target on the wrong side of the entry', () => {
    assert.throws(() => tradeRisk({ side: 'long', qty: 1, multiplier: 5, entry: 5900, stop: 5910 }), /wrong side/)
    assert.throws(() => tradeRisk({ side: 'short', qty: 1, multiplier: 5, entry: 5900, stop: 5890 }), /wrong side/)
    assert.throws(() => tradeReward({ side: 'long', qty: 1, multiplier: 5, entry: 5900, target: 5890 }), /wrong side/)
  })

  it('says an order the way it is placed', () => {
    assert.equal(describeOrder({ side: 'long', qty: 2, symbol: 'MES', order_type: 'limit', limit_price: 5912.25 }), 'BUY 2 MES at 5912.25 limit')
    assert.equal(describeOrder({ side: 'short', qty: 1, symbol: 'NQ', order_type: 'market' }), 'SELL 1 NQ at market')
    assert.equal(describeOrder({ side: 'long', qty: 1, symbol: 'ES', order_type: 'stop', stop_trigger: 5920 }), 'BUY 1 ES on a stop at 5920')
  })
})

// ---------------------------------------------------------------------------

const RULES: RiskRules = { daily_loss_limit: 300, max_risk_per_trade: 100, max_trades_per_day: 4, max_consecutive_losses: 3, max_qty_by_symbol: { MES: 4, ES: 1 } }
const NOW = new Date('2026-11-16T15:00:00Z') // 7am Monday in Los Angeles
const fresh = (patch: Partial<DayState> = {}): DayState => ({
  day: '2026-11-16',
  realized: 0,
  week_realized: 0,
  trades_today: 0,
  consecutive_losses: 0,
  last_loss_at: null,
  open_positions: 0,
  open_risk: 0,
  balance: 5000,
  ...patch,
})
const order = (patch: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: 'MES',
  asset: 'future',
  side: 'long',
  qty: 2,
  multiplier: 5,
  entry: 5912.25,
  stop_loss: 5906.25,
  target: 5924.25,
  order_type: 'limit',
  setup: 'orb',
  setup_status: 'live',
  stated_risk: null,
  details: {},
  ...patch,
})
const ctx = (patch: Partial<CheckContext> = {}): CheckContext => ({ now: NOW, timezone: LA, dayStart: '00:00', paper: false, storedLocks: [], ...patch })
const rulesOf = (c: { violations: { rule: string }[] }) => c.violations.map(v => v.rule)

describe('guardrails', () => {
  it('passes an order inside every limit and works out its risk and reward', () => {
    const c = checkOrder('futures', RULES, fresh(), order(), ctx())
    assert.ok(c.ok, JSON.stringify(c.violations))
    assert.deepEqual([c.risk_amount, c.reward_amount, c.r_planned], [60, 120, 2])
  })

  it('refuses everything for an account with no loss limits', () => {
    assert.ok(!hasLossLimits({}))
    assert.ok(!hasLossLimits({ daily_loss_limit: 300 }), 'a daily limit alone does not size a trade')
    assert.ok(hasLossLimits({ daily_loss_limit: 300, max_risk_pct: 1 }))
    assert.deepEqual(rulesOf(checkOrder('futures', {}, fresh(), order(), ctx())), ['limits_unset'])
  })

  it('refuses a trade with no stop, no setup, or over its size', () => {
    assert.deepEqual(rulesOf(checkOrder('futures', RULES, fresh(), order({ stop_loss: null }), ctx())), ['require_stop'])
    assert.deepEqual(rulesOf(checkOrder('futures', RULES, fresh(), order({ setup: null }), ctx())), ['require_setup'])
    assert.deepEqual(rulesOf(checkOrder('futures', RULES, fresh(), order({ qty: 4 }), ctx())), ['max_risk'], '4 MES with a 6 point stop is $120')
    assert.deepEqual(rulesOf(checkOrder('futures', RULES, fresh(), order({ qty: 5, stop_loss: 5911.25 }), ctx())), ['max_qty'])
    const es = order({ symbol: 'ESZ6', multiplier: 50, qty: 2, stop_loss: 5911.75 })
    assert.deepEqual(rulesOf(checkOrder('futures', RULES, fresh(), es, ctx())), ['max_qty'], 'the cap is by root, so ESZ6 counts as ES')
  })

  it('takes a stated risk in place of a stop, for trades that have none', () => {
    const csp = order({ symbol: 'AAPL 2026-12-18 200 P', asset: 'option', side: 'short', qty: 1, multiplier: 100, entry: 2.1, stop_loss: null, target: null, stated_risk: 90 })
    const c = checkOrder('options', RULES, fresh(), csp, ctx())
    assert.ok(c.ok, JSON.stringify(c.violations))
    assert.equal(c.risk_amount, 90)
  })

  it('uses the smaller of the dollar cap and the percent cap', () => {
    assert.equal(riskCap({ max_risk_per_trade: 100, max_risk_pct: 1 }, 5000), 50)
    assert.equal(riskCap({ max_risk_per_trade: 100, max_risk_pct: 1 }, 50000), 100)
    assert.equal(riskCap({ max_risk_pct: 1 }, null), null)
    const pct: RiskRules = { daily_loss_limit: 300, max_risk_pct: 1 }
    assert.deepEqual(rulesOf(checkOrder('futures', pct, fresh({ balance: null }), order(), ctx())), ['max_risk'], 'a percent of nothing cannot size a trade')
    assert.deepEqual(rulesOf(checkOrder('futures', pct, fresh({ balance: 5000 }), order(), ctx())), ['max_risk'], '$60 is over 1% of $5,000')
  })

  it('will not let the last trade of the day risk more than is left of the daily limit', () => {
    const c = checkOrder('futures', RULES, fresh({ realized: -260 }), order(), ctx())
    assert.deepEqual(rulesOf(c), ['daily_loss_remaining'])
    assert.match(c.violations[0].message, /Only \$40\.00 of today's \$300\.00 loss limit is left, and this risks \$60\.00/)
    const warned = checkOrder('futures', RULES, fresh({ realized: -200 }), order(), ctx())
    assert.ok(warned.ok)
    assert.ok(warned.warnings.some(w => w.rule === 'daily_loss_remaining'))
  })

  it('locks the day at the loss limit, and the lock lifts at the next trading day', () => {
    const state = fresh({ realized: -312.5 })
    const locks = derivedLocks('futures', RULES, state, ctx())
    assert.deepEqual(locks.map(l => l.kind), ['daily_loss'])
    assert.equal(locks[0].until, '2026-11-17T08:00:00.000Z')
    assert.match(locks[0].reason, /Down \$312\.50 today against a \$300\.00 daily loss limit/)
    const c = checkOrder('futures', RULES, state, order(), ctx())
    assert.ok(rulesOf(c).includes('daily_loss'))
    assert.equal(statusOf({ id: 'futures', name: 'Futures', desk: 'trading', paper: false, risk: RULES, risk_pending: null }, state, locks).light, 'locked')
  })

  it('locks after a run of losses, the week at the weekly limit, and sits out after a loss', () => {
    assert.deepEqual(derivedLocks('f', RULES, fresh({ consecutive_losses: 3 }), ctx()).map(l => l.kind), ['loss_streak'])
    const week = derivedLocks('f', { ...RULES, weekly_loss_limit: 600 }, fresh({ week_realized: -640 }), ctx())
    assert.deepEqual(week.map(l => l.kind), ['weekly_loss'])
    assert.equal(week[0].until, '2026-11-23T08:00:00.000Z', 'next Monday')
    const cool = { ...RULES, cooldown_minutes: 15 }
    const tenAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString()
    assert.deepEqual(derivedLocks('f', cool, fresh({ last_loss_at: tenAgo }), ctx()).map(l => l.kind), ['cooldown'])
    const twentyAgo = new Date(NOW.getTime() - 20 * 60_000).toISOString()
    assert.deepEqual(derivedLocks('f', cool, fresh({ last_loss_at: twentyAgo }), ctx()), [])
  })

  it('refuses everything while HALT ALL is on, and a manual lock only for its own account', () => {
    const halt = { kind: 'halt' as const, account: null, reason: 'Stepping away', until: null }
    assert.ok(rulesOf(checkOrder('futures', RULES, fresh(), order(), ctx({ storedLocks: [halt] }))).includes('halt'))
    const manual = { kind: 'manual' as const, account: 'options', reason: 'No options this week', until: null }
    assert.ok(checkOrder('futures', RULES, fresh(), order(), ctx({ storedLocks: [manual] })).ok)
    assert.ok(rulesOf(checkOrder('options', RULES, fresh(), order(), ctx({ storedLocks: [manual] }))).includes('manual'))
    const lapsed = { ...manual, account: 'futures', until: new Date(NOW.getTime() - 1000).toISOString() }
    assert.ok(checkOrder('futures', RULES, fresh(), order(), ctx({ storedLocks: [lapsed] })).ok, 'a lock past its time no longer applies')
  })

  it('holds the trade count, the trading hours and the setup gate', () => {
    assert.ok(rulesOf(checkOrder('futures', RULES, fresh({ trades_today: 4 }), order(), ctx())).includes('max_trades_per_day'))
    assert.ok(checkOrder('futures', RULES, fresh({ trades_today: 3 }), order(), ctx()).warnings.some(w => w.rule === 'max_trades_per_day'))
    const hours: RiskRules = { ...RULES, window: { start: '06:30', end: '11:00', days: [1, 2, 3, 4, 5] } }
    assert.ok(checkOrder('futures', hours, fresh(), order(), ctx()).ok)
    assert.ok(rulesOf(checkOrder('futures', hours, fresh(), order(), ctx({ now: new Date('2026-11-16T20:00:00Z') }))).includes('window'))
    const gated: RiskRules = { ...RULES, require_live_setup: true }
    assert.ok(rulesOf(checkOrder('futures', gated, fresh(), order({ setup_status: 'paper' }), ctx())).includes('require_live_setup'))
    assert.ok(checkOrder('futures', gated, fresh(), order({ setup_status: 'paper' }), ctx({ paper: true })).ok, 'a paper account is how a setup earns its way to live')
  })

  it('asks for the earnings date on stocks and options and refuses inside the blackout', () => {
    const rules: RiskRules = { ...RULES, earnings_blackout_days: 5 }
    const stock = order({ symbol: 'AAPL', asset: 'stock', multiplier: 1, qty: 10, entry: 200, stop_loss: 195, target: 215 })
    assert.ok(rulesOf(checkOrder('roth', rules, fresh(), stock, ctx())).includes('earnings'), 'no date given')
    assert.ok(rulesOf(checkOrder('roth', rules, fresh(), { ...stock, details: { earnings_date: '2026-11-19' } }, ctx())).includes('earnings'))
    assert.ok(checkOrder('roth', rules, fresh(), { ...stock, details: { earnings_date: '2026-12-20' } }, ctx()).ok)
    assert.ok(checkOrder('roth', rules, fresh(), { ...stock, details: { earnings_date: 'none' } }, ctx()).ok, 'a fund has none')
    assert.ok(checkOrder('futures', rules, fresh(), order(), ctx()).ok, 'futures do not report earnings')
  })

  it('warns about a setup that has been losing, without refusing it', () => {
    const c = checkOrder('futures', RULES, fresh(), order(), ctx({ setupStats: { trades: 31, expectancy_r: -0.18 } }))
    assert.ok(c.ok)
    assert.match(c.warnings.find(w => w.rule === 'setup_record')!.message, /lost 0\.18R a trade over 31 trades/)
  })

  it('tells looser limits from tighter ones', () => {
    assert.deepEqual(loosenedKeys(RULES, { ...RULES, daily_loss_limit: 500 }), ['daily_loss_limit'])
    assert.deepEqual(loosenedKeys(RULES, { ...RULES, daily_loss_limit: 200, max_trades_per_day: 3 }), [], 'tighter everywhere')
    assert.deepEqual(loosenedKeys(RULES, { daily_loss_limit: 300, max_risk_per_trade: 100 }).sort(), ['max_consecutive_losses', 'max_qty_by_symbol', 'max_trades_per_day'], 'dropping a limit loosens it')
    assert.deepEqual(loosenedKeys(RULES, { ...RULES, require_stop: false }), ['require_stop'])
    assert.deepEqual(loosenedKeys({ ...RULES, max_qty_by_symbol: { MES: 4 } }, { ...RULES, max_qty_by_symbol: { MES: 6 } }), ['max_qty_by_symbol'])
    assert.deepEqual(loosenedKeys({ ...RULES, window: { start: '06:30', end: '11:00' } }, { ...RULES, window: { start: '06:30', end: '13:00' } }), ['window'])
    assert.deepEqual(loosenedKeys({ ...RULES, window: { start: '06:30', end: '11:00' } }, { ...RULES, window: { start: '07:00', end: '10:00' } }), [])
    assert.deepEqual(loosenedKeys({}, RULES), [], 'first limits on an account are all tightening')
    assert.deepEqual(loosenedKeys({ ...RULES, cooldown_minutes: 15 }, { ...RULES, cooldown_minutes: 5 }), ['cooldown_minutes'])
  })

  it('reads limits as typed or spoken and refuses nonsense', () => {
    assert.deepEqual(cleanRules({ daily_loss_limit: '$300', max_risk_pct: '1%', allowed_symbols: 'mes, mnq', require_stop: true, max_trades_per_day: 0 }), {
      daily_loss_limit: 300,
      max_risk_pct: 1,
      allowed_symbols: ['MES', 'MNQ'],
      require_stop: true,
    })
    assert.throws(() => cleanRules({ daily_loss: 300 }), /not a limit/)
    assert.throws(() => cleanRules({ daily_loss_limit: -5 }), /zero or more/)
    assert.throws(() => cleanRules({ max_risk_pct: 250 }), /cannot be over 100/)
    assert.throws(() => cleanRules({ window: { start: '6am', end: '11:00' } }), /HH:MM/)
    assert.ok(describeRules(RULES).includes('Stop for the day at $300.00 down'))
  })

  it('summarizes an account in one sentence with a traffic light', () => {
    const acct = { id: 'futures', name: 'Futures', desk: 'trading', paper: false, risk: RULES, risk_pending: null }
    const ok = statusOf(acct, fresh({ realized: 85, trades_today: 1 }), [])
    assert.equal(ok.light, 'ok')
    assert.equal(ok.summary, 'Futures: Up $85.00 today, $385.00 left before the daily limit, 3 trades left.')
    assert.equal(statusOf(acct, fresh({ realized: -220 }), []).light, 'caution')
    assert.equal(statusOf({ ...acct, risk: {} }, fresh(), []).light, 'unset')
  })
})

// ---------------------------------------------------------------------------

const closed = (pnl: number, r: number | null, setup = 'orb', at = '2026-11-16T15:00:00Z', extra: Partial<StatTrade> = {}): StatTrade => ({
  pnl,
  r_multiple: r,
  fees: 1,
  setup,
  symbol: 'MES',
  closed_at: at,
  opened_at: at,
  violations: [],
  mistakes: [],
  status: 'closed',
  ...extra,
})

describe('journal statistics', () => {
  it('counts wins, losses, expectancy in R, profit factor and drawdown', () => {
    const s = tradeStats([closed(100, 2, 'orb', '2026-11-16T15:00:00Z'), closed(-50, -1, 'orb', '2026-11-16T16:00:00Z'), closed(-50, -1, 'orb', '2026-11-16T17:00:00Z'), closed(0, 0, 'orb', '2026-11-16T18:00:00Z'), closed(150, 3, 'orb', '2026-11-16T19:00:00Z', { mistakes: ['chased'], violations: [{ rule: 'window', message: '' }] })])
    assert.deepEqual([s.trades, s.wins, s.losses, s.scratches], [5, 2, 2, 1])
    assert.equal(s.win_rate, 0.4)
    assert.equal(s.pnl, 150)
    assert.equal(s.expectancy_r, 0.6)
    assert.equal(s.total_r, 3)
    assert.equal(s.profit_factor, 2.5)
    assert.equal(s.payoff, 2.5)
    assert.equal(s.max_drawdown, 100, 'from +100 down to 0')
    assert.equal(s.max_drawdown_r, 2)
    assert.equal(s.rule_breaks, 1)
    assert.deepEqual(s.mistakes, { chased: 1 })
    assert.equal(s.fees, 5)
  })

  it('will not judge a setup on too few trades', () => {
    const j = judge([closed(100, 2), closed(100, 2), closed(100, 2)])
    assert.equal(j.verdict, 'too_few')
    assert.match(j.line, /3 trades: too few to judge/)
  })

  it('says when a setup makes money and when it only feels good', () => {
    const good = Array.from({ length: 30 }, (_, i) => closed(i % 3 === 0 ? -50 : 60, i % 3 === 0 ? -1 : 1.2))
    assert.equal(judge(good).verdict, 'makes_money')
    // Wins two times in three, and each loss is four winners: it feels good and loses.
    const feelsGood = Array.from({ length: 60 }, (_, i) => closed(i % 3 === 0 ? -150 : 37.5, i % 3 === 0 ? -2 : 0.5, 'fade'))
    const j = judge(feelsGood)
    assert.equal(j.verdict, 'loses_money')
    assert.ok(j.feels_good_only)
    assert.match(j.line, /^Loses money: -0\.33R a trade over 60 trades \(67% winners\)\. It wins 67% of the time, and the losers are 4\.0 times the size of the winners\.$/)
    // The same record over 30 trades is not yet clear of luck, and it says so rather than guessing.
    const early = judge(feelsGood.slice(0, 30))
    assert.equal(early.verdict, 'probably_loses')
    assert.ok(early.feels_good_only)
    const coin = Array.from({ length: 30 }, (_, i) => closed(i % 2 ? 50 : -50, i % 2 ? 1 : -1))
    assert.equal(judge(coin).verdict, 'unclear')
    assert.equal(tStat([1, 1, 1]), Infinity)
    assert.equal(tStat([1]), null)
  })

  it('ranks setups by what a trade is worth, with untagged trades last', () => {
    const trades = [...Array.from({ length: 20 }, () => closed(40, 0.8, 'orb')), ...Array.from({ length: 20 }, (_, i) => closed(i % 2 ? 30 : -60, i % 2 ? 0.5 : -1, 'fade')), closed(500, 5, null as unknown as string)]
    const report = bySetup(trades)
    assert.deepEqual(report.map(r => r.setup), ['orb', 'fade', '(none)'])
    assert.equal(report[0].expectancy_r, 0.8)
    assert.equal(report[1].verdict, 'probably_loses', 'twenty trades is enough to lean, not to be sure')
  })

  it('works out where the day stands from the trades', () => {
    const trades = [
      { status: 'closed' as const, pnl: 80, risk_amount: 50, opened_at: '2026-11-16T14:35:00Z', closed_at: '2026-11-16T14:50:00Z' },
      { status: 'closed' as const, pnl: -50, risk_amount: 50, opened_at: '2026-11-16T15:05:00Z', closed_at: '2026-11-16T15:20:00Z' },
      { status: 'closed' as const, pnl: 0, risk_amount: 50, opened_at: '2026-11-16T15:30:00Z', closed_at: '2026-11-16T15:40:00Z' },
      { status: 'closed' as const, pnl: -45, risk_amount: 50, opened_at: '2026-11-16T16:00:00Z', closed_at: '2026-11-16T16:10:00Z' },
      { status: 'open' as const, pnl: null, risk_amount: 60, opened_at: '2026-11-16T16:30:00Z', closed_at: null },
      // Friday of last week: outside this week.
      { status: 'closed' as const, pnl: -400, risk_amount: 50, opened_at: '2026-11-13T15:00:00Z', closed_at: '2026-11-13T15:30:00Z' },
    ]
    const s = dayStateFrom(trades, { now: new Date('2026-11-16T17:00:00Z'), timezone: LA, dayStart: '00:00', balance: 5000 })
    assert.equal(s.day, '2026-11-16')
    assert.equal(s.realized, -15)
    assert.equal(s.week_realized, -15)
    assert.equal(s.trades_today, 5)
    assert.equal(s.consecutive_losses, 2, 'the scratch between two losses does not reset the run')
    assert.equal(s.last_loss_at, '2026-11-16T16:10:00Z')
    assert.deepEqual([s.open_positions, s.open_risk], [1, 60])
  })

  it('formats money and R for a screen', () => {
    assert.equal(money(1234.5), '$1,234.50')
    assert.equal(money(-20), '-$20.00')
    assert.equal(money(85, { sign: true }), '+$85.00')
    assert.equal(money(null), '—')
    assert.equal(rText(1.25), '+1.25R')
    assert.equal(rText(-0.5), '-0.50R')
    assert.equal(percentile([100, 200, 300, 400], 0.5), 250)
  })
})
