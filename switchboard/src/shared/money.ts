/**
 * Shapes for the money side of Switchboard: the trade journal and its
 * guardrails, order proposals, the resale pipeline, the betting ledger, the
 * routines that run on a schedule, and the one P&L they all report into.
 * Shared by the hub and by the tools inside each session.
 */

/** The desks. A desk is a kind of work with its own playbook, backlog project and tools. */
export const DESKS = ['trading', 'investing', 'robinhood', 'resale', 'betting'] as const
export type Desk = (typeof DESKS)[number]

export const DESK_LABELS: Record<Desk, string> = {
  trading: 'Futures trading',
  investing: 'Options and Roth',
  robinhood: 'Robinhood rules system',
  resale: 'Bag resale',
  betting: 'Betting',
}

export function isDesk(value: unknown): value is Desk {
  return typeof value === 'string' && (DESKS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Accounts

export type AccountTracking = 'journal' | 'snapshots'

export interface Account {
  id: string
  name: string
  desk: string
  kind: string
  broker: string
  /** Simulated money. Kept out of every real total. */
  paper: boolean
  /** journal: P&L is the sum of closed trades. snapshots: P&L is the change in what the broker says it is worth, net of deposits. */
  tracking: AccountTracking
  starting_balance: number
  risk: RiskRules
  /** Looser limits that were asked for today. They start with the next trading day. */
  risk_pending: { rules: RiskRules; effective_at: string; requested_by: string; requested_at: string } | null
  /** When this account's trading day begins, local time, HH:MM. */
  day_start: string
  notes: string
  created_at: string
  archived_at: string | null
}

export type FlowKind = 'deposit' | 'withdrawal' | 'contribution' | 'fee' | 'interest' | 'dividend' | 'adjustment'
export const FLOW_KINDS: readonly FlowKind[] = ['deposit', 'withdrawal', 'contribution', 'fee', 'interest', 'dividend', 'adjustment']

export interface Flow {
  id: number
  account: string
  kind: FlowKind
  /** Signed: money into the account is positive. */
  amount: number
  tax_year: number | null
  note: string
  occurred_at: string
  created_by: string
  created_at: string
}

export interface Snapshot {
  id: number
  account: string
  as_of: string
  value: number
  cash: number | null
  note: string
  created_by: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Guardrails

export interface TradingWindow {
  /** Local time, HH:MM. */
  start: string
  end: string
  /** 0 Sunday to 6 Saturday. Empty or missing means every day. */
  days?: number[]
}

/**
 * The limits on one account. Every one of them is a refusal: the hub will not
 * create an order proposal that breaks one, whoever asks. A number that is
 * missing means that limit is not set.
 */
export interface RiskRules {
  /** Dollars lost in one trading day that end the day. */
  daily_loss_limit?: number
  /** Dollars lost since Monday that end the week. */
  weekly_loss_limit?: number
  /** Dollars one trade may lose at its stop. */
  max_risk_per_trade?: number
  /** The same, as a percent of the account's balance. The smaller of the two applies. */
  max_risk_pct?: number
  /** Contracts or shares in one order. */
  max_qty?: number
  /** The same per symbol, by futures root or ticker: {"ES": 1, "MES": 5}. */
  max_qty_by_symbol?: Record<string, number>
  /** Dollars of position: quantity times price times multiplier. */
  max_notional?: number
  max_trades_per_day?: number
  /** Losing trades in a row, in one day, that end the day. */
  max_consecutive_losses?: number
  /** Minutes to sit out after any losing trade. */
  cooldown_minutes?: number
  max_open_positions?: number
  /** Dollars at risk across every open trade, this one included. */
  max_open_risk?: number
  /** Only trade inside these hours. */
  window?: TradingWindow
  /** A trade must say where it is wrong. On unless set to false. */
  require_stop?: boolean
  /** A trade must name the setup it is. On unless set to false. */
  require_setup?: boolean
  /** The setup must have been promoted to live (backtested, then approved by you). Paper accounts are exempt. */
  require_live_setup?: boolean
  /** Planned reward divided by planned risk must be at least this. */
  min_reward_risk?: number
  /** Stocks and options: no entry this many days or fewer before earnings. The proposal must state the date. */
  earnings_blackout_days?: number
  allowed_assets?: string[]
  /** Futures roots or tickers this account may trade. */
  allowed_symbols?: string[]
  no_market_orders?: boolean
  /** A trade may not risk more than what is left of the day's loss limit. On unless set to false. */
  cap_risk_to_remaining?: boolean
  /** Betting: dollars on one bet. */
  max_stake?: number
  /** Betting: percent of bankroll on one bet. */
  max_stake_pct?: number
  /** No session may propose orders for this account. For accounts run by another system. */
  proposals_off?: boolean
}

export const RISK_RULE_KEYS = [
  'daily_loss_limit',
  'weekly_loss_limit',
  'max_risk_per_trade',
  'max_risk_pct',
  'max_qty',
  'max_qty_by_symbol',
  'max_notional',
  'max_trades_per_day',
  'max_consecutive_losses',
  'cooldown_minutes',
  'max_open_positions',
  'max_open_risk',
  'window',
  'require_stop',
  'require_setup',
  'require_live_setup',
  'min_reward_risk',
  'earnings_blackout_days',
  'allowed_assets',
  'allowed_symbols',
  'no_market_orders',
  'cap_risk_to_remaining',
  'max_stake',
  'max_stake_pct',
  'proposals_off',
] as const
export type RiskRuleKey = (typeof RISK_RULE_KEYS)[number]

export interface Violation {
  rule: string
  message: string
}

/** Why an account cannot take a new trade right now. */
export interface Lock {
  /** halt: everything, by you. manual: one account, by you. The rest follow from the day's trades. */
  kind: 'halt' | 'manual' | 'daily_loss' | 'weekly_loss' | 'loss_streak' | 'cooldown'
  account: string | null
  reason: string
  /** When it lifts by itself. Null: only when you lift it. */
  until: string | null
  /** Set on locks that are stored (halt, manual). */
  id?: number
  created_by?: string
  created_at?: string
}

export interface DayState {
  /** The trading day, YYYY-MM-DD in the money timezone. */
  day: string
  /** Closed P&L today, after fees. */
  realized: number
  week_realized: number
  /** Trades opened today. */
  trades_today: number
  /** Losing trades in a row, ending with the most recent close today. */
  consecutive_losses: number
  last_loss_at: string | null
  open_positions: number
  open_risk: number
  /** Starting balance plus deposits and withdrawals plus every closed trade. Null when nothing was ever entered. */
  balance: number | null
}

export interface RiskStatus {
  account: string
  name: string
  desk: string
  paper: boolean
  state: DayState
  rules: RiskRules
  pending_rules: Account['risk_pending']
  locks: Lock[]
  /** ok: may trade. caution: close to a limit. locked: may not. unset: no loss limits yet, so nothing may be proposed. */
  light: 'ok' | 'caution' | 'locked' | 'unset'
  /** One sentence, for the phone and for reading aloud. */
  summary: string
  /** What is left before each limit. */
  remaining: { daily_loss: number | null; weekly_loss: number | null; trades: number | null }
}

export interface RiskCheck {
  ok: boolean
  violations: Violation[]
  warnings: Violation[]
  risk_amount: number | null
  reward_amount: number | null
  r_planned: number | null
}

// ---------------------------------------------------------------------------
// Setups, trades, order proposals

export type SetupStatus = 'idea' | 'backtesting' | 'paper' | 'live' | 'retired'
export const SETUP_STATUSES: readonly SetupStatus[] = ['idea', 'backtesting', 'paper', 'live', 'retired']

export interface BacktestSummary {
  symbol: string
  interval: string
  from: string
  to: string
  trades: number
  win_rate: number
  expectancy_r: number
  total_r: number
  profit_factor: number | null
  max_drawdown_r: number
  /** What was assumed: slippage, commission, the data it ran on. */
  assumptions: string
  recorded_at: string
  recorded_by: string
  notes?: string
}

export interface Setup {
  slug: string
  name: string
  desk: string
  /** The playbook: when to take it, where the stop goes, when to stand aside. */
  rules: string
  status: SetupStatus
  backtest: BacktestSummary | null
  promoted_at: string | null
  promoted_by: string | null
  promotion_note: string
  created_by: string
  created_at: string
  updated_at: string
}

export type Asset = 'future' | 'stock' | 'option' | 'crypto' | 'forex' | 'other'
export const ASSETS: readonly Asset[] = ['future', 'stock', 'option', 'crypto', 'forex', 'other']
export type Side = 'long' | 'short'

export interface Trade {
  id: number
  account: string
  symbol: string
  asset: Asset
  side: Side
  qty: number
  /** Dollars per point per unit: 5 for MES, 50 for ES, 100 for an option contract, 1 for a share. */
  multiplier: number
  entry_price: number
  stop_price: number | null
  target_price: number | null
  exit_price: number | null
  fees: number
  /** Dollars at risk when it was opened. */
  risk_amount: number | null
  /** Realized, after fees. Null while open. */
  pnl: number | null
  r_multiple: number | null
  status: 'open' | 'closed'
  setup: string | null
  tags: string[]
  /** What went wrong in the doing, not the result: chased, moved-stop, oversized, revenge. */
  mistakes: string[]
  /** A to F, for how well the plan was followed. Not for whether it made money. */
  grade: string | null
  notes: string
  details: Record<string, unknown>
  /** The guardrails this trade broke when it was taken. */
  violations: Violation[]
  paper: boolean
  ticket_id: number | null
  source: string
  created_by: string
  opened_at: string
  closed_at: string | null
  created_at: string
  updated_at: string
}

export type OrderType = 'limit' | 'stop' | 'stop_limit' | 'market'
export const ORDER_TYPES: readonly OrderType[] = ['limit', 'stop', 'stop_limit', 'market']

/**
 * blocked: the guardrails refused it; nobody was asked. pending: waiting for
 * your tap. approved: you said yes and are placing it yourself. filled: you
 * reported the fill and it is in the journal. Nothing here ever reaches a broker.
 */
export type TicketStatus = 'blocked' | 'pending' | 'approved' | 'rejected' | 'expired' | 'filled' | 'cancelled'
export const TICKET_STATUSES: readonly TicketStatus[] = ['blocked', 'pending', 'approved', 'rejected', 'expired', 'filled', 'cancelled']

export interface Ticket {
  id: number
  account: string
  symbol: string
  asset: Asset
  side: Side
  qty: number
  multiplier: number
  order_type: OrderType
  limit_price: number | null
  stop_trigger: number | null
  stop_loss: number | null
  target: number | null
  tif: string
  setup: string | null
  thesis: string
  details: Record<string, unknown>
  risk_amount: number | null
  reward_amount: number | null
  checks: RiskCheck
  status: TicketStatus
  proposed_by: string
  decided_by: string | null
  decided_at: string | null
  decision_note: string
  expires_at: string | null
  trade_id: number | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Statistics

export interface TradeStats {
  trades: number
  wins: number
  losses: number
  scratches: number
  win_rate: number | null
  pnl: number
  fees: number
  avg_win: number | null
  avg_loss: number | null
  /** Average win divided by average loss. */
  payoff: number | null
  profit_factor: number | null
  /** Trades that had a stop, so an R could be worked out. */
  r_trades: number
  /** Average R per trade: what one trade is worth, in units of what it risked. */
  expectancy_r: number | null
  total_r: number
  max_drawdown: number
  max_drawdown_r: number
  best: number | null
  worst: number | null
  rule_breaks: number
  mistakes: Record<string, number>
}

export type SetupVerdict = 'too_few' | 'makes_money' | 'probably_makes_money' | 'unclear' | 'probably_loses' | 'loses_money'

export interface SetupReport extends TradeStats {
  setup: string
  verdict: SetupVerdict
  /** The verdict in a sentence. */
  line: string
  /** A high win rate with a negative expectancy: the kind that feels good and loses. */
  feels_good_only: boolean
}

// ---------------------------------------------------------------------------
// P&L

export interface PnlBucket {
  desk: string
  /** Realized: closed trades, settled bets, sold items. */
  realized: number
  /** Change in value of accounts tracked by snapshots, net of deposits. */
  marked: number
  expenses: number
  net: number
  count: number
  minutes: number
  /** Net per hour worked, when hours were logged. */
  per_hour: number | null
}

export interface PnlReport {
  from: string
  to: string
  timezone: string
  desks: PnlBucket[]
  total: PnlBucket
  /** One row per day that had anything, oldest first, with the running total. */
  days: { day: string; net: number; cumulative: number; by_desk: Record<string, number> }[]
}

// ---------------------------------------------------------------------------
// Routines and reports

export interface Routine {
  id: string
  name: string
  desk: string | null
  description: string
  /** Five-field cron: minute hour day-of-month month day-of-week. */
  schedule: string
  /** IANA name. Null: the money timezone. */
  timezone: string | null
  /** job: something the hub works out by itself. prompt: a message sent to a session. */
  kind: 'job' | 'prompt'
  job: string | null
  target: string | null
  prompt: string
  params: Record<string, unknown>
  enabled: boolean
  /** A run that was missed (the computer was asleep) still happens if this many minutes or fewer have passed. */
  catch_up_minutes: number
  last_run_at: string | null
  last_status: string | null
  last_note: string
  next_run_at?: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface RoutineRun {
  id: number
  routine: string
  scheduled_for: string | null
  fired_at: string
  status: 'ok' | 'error' | 'skipped' | 'missed'
  note: string
  report_id: number | null
  message_id: number | null
}

export interface Report {
  id: number
  kind: string
  title: string
  period_start: string | null
  period_end: string | null
  /** Written to be read on a phone. */
  body: string
  /** Two or three sentences to say aloud. */
  spoken: string
  data: Record<string, unknown>
  created_by: string
  created_at: string
}

export interface CalendarEvent {
  id: number
  kind: 'economic' | 'earnings' | 'expiry' | 'other'
  title: string
  symbol: string | null
  country: string | null
  impact: string | null
  starts_at: string
  all_day: boolean
  details: Record<string, unknown>
  source: string
  external_id: string | null
  created_at: string
}

export interface Watch {
  id: number
  symbol: string
  desk: string
  note: string
  levels: { price: number; label: string }[]
  created_by: string
  created_at: string
}

export interface Alert {
  id: number
  symbol: string
  condition: 'above' | 'below'
  price: number
  note: string
  desk: string
  status: 'active' | 'fired' | 'cancelled' | 'expired'
  last_price: number | null
  fired_at: string | null
  expires_at: string | null
  created_by: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Resale

export const RESALE_PLATFORMS = ['ebay', 'poshmark', 'depop', 'mercari', 'facebook', 'therealreal', 'fashionphile', 'vestiaire', 'grailed', 'shopgoodwill', 'local', 'other'] as const
export type ResalePlatform = (typeof RESALE_PLATFORMS)[number]

export type AuthStatus = 'none' | 'pending' | 'passed' | 'failed'

export interface ResaleSearch {
  id: number
  name: string
  query: string
  platforms: string[]
  brand: string | null
  max_price: number | null
  min_profit: number | null
  min_roi: number | null
  notes: string
  enabled: boolean
  last_run_at: string | null
  created_by: string
  created_at: string
}

export interface Lead {
  id: number
  url: string | null
  platform: string
  title: string
  brand: string | null
  model: string | null
  condition: string | null
  asking_price: number
  shipping_in: number
  est_resale: number | null
  comp_count: number
  comp_key: string | null
  sell_platform: string | null
  est_fees: number | null
  est_shipping_out: number | null
  est_auth_cost: number | null
  est_profit: number | null
  est_roi: number | null
  auth_required: boolean
  auth_status: AuthStatus
  auth_service: string | null
  auth_ref: string | null
  red_flags: string
  notes: string
  status: 'new' | 'watching' | 'passed' | 'bought' | 'gone'
  search_id: number | null
  item_id: number | null
  found_by: string
  found_at: string
  updated_at: string
}

export interface Comp {
  id: number
  comp_key: string
  source: string
  title: string
  price: number
  sold_at: string | null
  url: string | null
  condition: string | null
  notes: string
  added_by: string
  created_at: string
}

export interface CompSummary {
  comp_key: string
  count: number
  median: number | null
  low: number | null
  high: number | null
  /** The middle half: what it usually sells for. */
  p25: number | null
  p75: number | null
  newest: string | null
  oldest: string | null
  by_source: Record<string, number>
  /** thin: under five sales. stale: the newest is over 120 days old. ok otherwise. */
  quality: 'none' | 'thin' | 'stale' | 'ok'
}

export type ItemStatus = 'sourced' | 'received' | 'authenticating' | 'ready' | 'listed' | 'sold' | 'shipped' | 'returned' | 'kept' | 'written_off'
export const ITEM_STATUSES: readonly ItemStatus[] = ['sourced', 'received', 'authenticating', 'ready', 'listed', 'sold', 'shipped', 'returned', 'kept', 'written_off']

export interface Item {
  id: number
  sku: string | null
  title: string
  brand: string | null
  model: string | null
  category: string
  condition: string | null
  color: string | null
  measurements: Record<string, unknown>
  source: string | null
  source_url: string | null
  lead_id: number | null
  cost: number
  /** Shipping in, authentication, cleaning, repair. */
  extra_costs: number
  purchased_at: string | null
  status: ItemStatus
  auth_required: boolean
  auth_status: AuthStatus
  auth_service: string | null
  auth_ref: string | null
  /** Why the authentication gate was overridden. Only you can write this. */
  auth_override: string | null
  target_price: number | null
  /** The lowest price that still clears your minimum profit. */
  floor_price: number | null
  sold_price: number | null
  sold_platform: string | null
  sold_fees: number | null
  sold_shipping: number | null
  sold_at: string | null
  net_profit: number | null
  comp_key: string | null
  notes: string
  tags: string[]
  location: string | null
  created_by: string
  created_at: string
  updated_at: string
  listings?: Listing[]
  photos?: ItemPhoto[]
}

export interface Listing {
  id: number
  item_id: number
  platform: string
  title: string
  description: string
  price: number | null
  url: string | null
  status: 'draft' | 'active' | 'ended' | 'sold'
  listed_at: string | null
  last_price_change_at: string | null
  price_history: { at: string; price: number }[]
  details: Record<string, unknown>
  created_by: string
  created_at: string
  updated_at: string
}

export interface ItemPhoto {
  id: number
  item_id: number
  file: string
  original_name: string
  content_type: string
  bytes: number
  position: number
  created_at: string
}

export interface FeeQuote {
  platform: string
  sale_price: number
  platform_fee: number
  payment_fee: number
  shipping_out: number
  /** What lands in your account before what the item cost you. */
  payout: number
  /** How the fee was worked out, and when that schedule was last checked. */
  basis: string
}

export interface ProfitQuote extends FeeQuote {
  cost: number
  extra_costs: number
  auth_cost: number
  profit: number
  roi: number | null
  margin: number | null
  /** The sale price at which profit is zero. */
  breakeven: number
}

// ---------------------------------------------------------------------------
// Betting

export type BetResult = 'pending' | 'win' | 'loss' | 'push' | 'void' | 'partial'
export const BET_RESULTS: readonly BetResult[] = ['pending', 'win', 'loss', 'push', 'void', 'partial']

export interface Bet {
  id: number
  account: string
  external_id: string | null
  source: string
  placed_at: string
  settled_at: string | null
  sport: string | null
  league: string | null
  market: string | null
  description: string
  legs: Record<string, unknown>[]
  stake: number
  /** The price taken, as a payout multiple that includes the stake. */
  odds_decimal: number | null
  result: BetResult
  /** Dollars that came back, stake included. */
  returned: number | null
  pnl: number | null
  closing_odds_decimal: number | null
  /** How much better the price taken was than the closing price, in percent. */
  clv_pct: number | null
  /** Pick'em: how many points better the line taken was than the closing line. */
  clv_points: number | null
  beat_close: boolean | null
  ev_at_entry: number | null
  p_at_entry: number | null
  tags: string[]
  notes: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface ClvReport {
  bets: number
  settled: number
  staked: number
  pnl: number
  roi: number | null
  /** Bets with a closing number to compare against. */
  with_close: number
  beat_close: number
  beat_rate: number | null
  avg_clv_pct: number | null
  avg_clv_points: number | null
  /** not_enough: under 200 bets with a close. beating: the closing line is being beaten. not_beating: it is not, so cut stakes. */
  verdict: 'not_enough' | 'beating' | 'not_beating'
  line: string
}

// ---------------------------------------------------------------------------
// Live events for the web UI and the phone

export type MoneyTopic =
  | 'account'
  | 'risk'
  | 'ticket'
  | 'trade'
  | 'setup'
  | 'pnl'
  | 'routine'
  | 'report'
  | 'calendar'
  | 'alert'
  | 'watch'
  | 'lead'
  | 'item'
  | 'bet'
  | 'settings'

/** Something on the money side changed. Screens showing that topic fetch it again. */
export interface MoneyEvent {
  type: 'money'
  topic: MoneyTopic
  id?: number | string
  /** For tickets: the ticket itself, so an approval card can appear at once. */
  ticket?: Ticket
}

/** "$1,234.50", "-$20.00". */
export function money(n: number | null | undefined, opts: { sign?: boolean; cents?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const text = abs.toLocaleString('en-US', { minimumFractionDigits: opts.cents === false ? 0 : 2, maximumFractionDigits: opts.cents === false ? 0 : 2 })
  const sign = n < 0 ? '-' : opts.sign && n > 0 ? '+' : ''
  return `${sign}$${text}`
}

/** "+1.25R", "-0.50R". */
export function rText(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—'
  return `${r > 0 ? '+' : ''}${r.toFixed(2)}R`
}

/** Dollars as words a voice can read: "minus 312 dollars". */
export function spokenMoney(n: number): string {
  const whole = Math.round(Math.abs(n))
  return `${n < 0 ? 'minus ' : ''}${whole.toLocaleString('en-US')} dollar${whole === 1 ? '' : 's'}`
}
