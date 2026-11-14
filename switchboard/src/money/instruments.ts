/**
 * What one point is worth. A journal that gets this wrong reports the wrong
 * P&L for every futures trade, so the multiplier used is stored on each trade
 * and shown, and a trade may always state its own.
 */
import type { Asset, Side } from '../shared/money.ts'

export interface FuturesSpec {
  root: string
  name: string
  /** Dollars per one point of price, per contract. */
  multiplier: number
  tick: number
  /** Dollars per tick. */
  tick_value: number
  exchange: string
}

const spec = (root: string, name: string, multiplier: number, tick: number, exchange: string): FuturesSpec => ({
  root,
  name,
  multiplier,
  tick,
  tick_value: Math.round(multiplier * tick * 1e6) / 1e6,
  exchange,
})

/** Contract specifications as published by CME Group. Check a contract you have not traded before against cmegroup.com. */
export const FUTURES: FuturesSpec[] = [
  spec('ES', 'E-mini S&P 500', 50, 0.25, 'CME'),
  spec('MES', 'Micro E-mini S&P 500', 5, 0.25, 'CME'),
  spec('NQ', 'E-mini Nasdaq-100', 20, 0.25, 'CME'),
  spec('MNQ', 'Micro E-mini Nasdaq-100', 2, 0.25, 'CME'),
  spec('YM', 'E-mini Dow', 5, 1, 'CBOT'),
  spec('MYM', 'Micro E-mini Dow', 0.5, 1, 'CBOT'),
  spec('RTY', 'E-mini Russell 2000', 50, 0.1, 'CME'),
  spec('M2K', 'Micro E-mini Russell 2000', 5, 0.1, 'CME'),
  spec('CL', 'Crude Oil', 1000, 0.01, 'NYMEX'),
  spec('MCL', 'Micro Crude Oil', 100, 0.01, 'NYMEX'),
  spec('NG', 'Natural Gas', 10000, 0.001, 'NYMEX'),
  spec('GC', 'Gold', 100, 0.1, 'COMEX'),
  spec('MGC', 'Micro Gold', 10, 0.1, 'COMEX'),
  spec('SI', 'Silver', 5000, 0.005, 'COMEX'),
  spec('SIL', 'Micro Silver', 1000, 0.005, 'COMEX'),
  spec('HG', 'Copper', 25000, 0.0005, 'COMEX'),
  spec('ZB', '30-Year Treasury Bond', 1000, 1 / 32, 'CBOT'),
  spec('ZN', '10-Year Treasury Note', 1000, 1 / 64, 'CBOT'),
  spec('ZF', '5-Year Treasury Note', 1000, 1 / 128, 'CBOT'),
  spec('6E', 'Euro FX', 125000, 0.00005, 'CME'),
  spec('MBT', 'Micro Bitcoin', 0.1, 5, 'CME'),
]

const BY_ROOT = new Map(FUTURES.map(f => [f.root, f]))
const MONTH_CODES = 'FGHJKMNQUVXZ'

/**
 * The root of a futures symbol however a platform writes it: MES, /MES, MESZ6,
 * MESZ26, MES=F, "MES 12-26", MESZ6.CME.
 */
export function futuresRoot(symbol: string): string {
  let s = symbol.trim().toUpperCase().replace(/^\//, '').replace(/=F$/, '')
  s = s.replace(/\.[A-Z]+$/, '') // an exchange suffix
  s = s.replace(/\s+\d{1,2}-\d{2,4}$/, '') // "MES 12-26"
  if (BY_ROOT.has(s)) return s
  const m = new RegExp(`^([A-Z0-9]{1,4})[${MONTH_CODES}]\\d{1,4}$`).exec(s)
  if (m) return m[1]
  return s
}

export function futuresSpec(symbol: string): FuturesSpec | null {
  return BY_ROOT.get(futuresRoot(symbol)) ?? null
}

/** The asset a new trade is, when it does not say: from the kind of account it is in. */
export function defaultAsset(accountKind: string): Asset {
  if (accountKind === 'futures') return 'future'
  if (accountKind === 'options') return 'option'
  if (accountKind === 'crypto') return 'crypto'
  return 'stock'
}

/**
 * Dollars per point per unit. A futures contract nobody has listed here has no
 * safe default, so it must be given.
 */
export function multiplierFor(asset: Asset, symbol: string): number | null {
  if (asset === 'future') return futuresSpec(symbol)?.multiplier ?? null
  if (asset === 'option') return 100
  return 1
}

const direction = (side: Side) => (side === 'long' ? 1 : -1)

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
export const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000

/** Realized dollars, after fees. */
export function tradePnl(t: { side: Side; qty: number; multiplier: number; entry: number; exit: number; fees?: number }): number {
  return round2((t.exit - t.entry) * direction(t.side) * t.qty * t.multiplier - (t.fees ?? 0))
}

/**
 * Dollars lost if the stop is hit. Throws when the stop is on the winning side
 * of the entry, which is a typo far more often than a plan.
 */
export function tradeRisk(t: { side: Side; qty: number; multiplier: number; entry: number; stop: number }): number {
  const perUnit = (t.entry - t.stop) * direction(t.side)
  if (perUnit < 0) {
    throw new Error(`The stop (${t.stop}) is on the wrong side of the entry (${t.entry}) for a ${t.side}: a ${t.side} is stopped ${t.side === 'long' ? 'below' : 'above'} where it got in.`)
  }
  return round2(perUnit * t.qty * t.multiplier)
}

/** Dollars made if the target is hit. Throws when the target is on the losing side. */
export function tradeReward(t: { side: Side; qty: number; multiplier: number; entry: number; target: number }): number {
  const perUnit = (t.target - t.entry) * direction(t.side)
  if (perUnit < 0) {
    throw new Error(`The target (${t.target}) is on the wrong side of the entry (${t.entry}) for a ${t.side}.`)
  }
  return round2(perUnit * t.qty * t.multiplier)
}

/** One line a person can check a ticket against: "BUY 2 MES at 5912.25 limit". */
export function describeOrder(t: {
  side: Side
  qty: number
  symbol: string
  order_type?: string
  limit_price?: number | null
  stop_trigger?: number | null
  entry_price?: number | null
}): string {
  const verb = t.side === 'long' ? 'BUY' : 'SELL'
  const price = t.limit_price ?? t.entry_price ?? t.stop_trigger
  const type = t.order_type ?? 'limit'
  if (type === 'market') return `${verb} ${t.qty} ${t.symbol} at market`
  if (type === 'stop') return `${verb} ${t.qty} ${t.symbol} on a stop at ${t.stop_trigger ?? price}`
  if (type === 'stop_limit') return `${verb} ${t.qty} ${t.symbol} stop ${t.stop_trigger}, limit ${t.limit_price}`
  return `${verb} ${t.qty} ${t.symbol} at ${price} limit`
}
