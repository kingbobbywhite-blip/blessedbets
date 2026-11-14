/**
 * Postgres access for the money side: accounts, the journal, order proposals,
 * locks, expenses and hours, P&L, reports, routines, the watchlist, alerts and
 * the calendar. Resale and betting are in their own files.
 */
import pg from 'pg'
import type {
  Account,
  Alert,
  CalendarEvent,
  Flow,
  Lock,
  PnlBucket,
  PnlReport,
  Report,
  Routine,
  RoutineRun,
  Setup,
  Snapshot,
  Ticket,
  Trade,
  Watch,
} from '../shared/money.ts'
import { round2 } from './instruments.ts'
import { addDays, localDate, startOfDay } from './time.ts'

// A date column is a calendar date, not an instant: keep it as YYYY-MM-DD.
pg.types.setTypeParser(1082, (v: string) => v)

export type Q = pg.Pool | pg.PoolClient

const JSON_COLUMNS = new Set(['risk', 'risk_pending', 'backtest', 'details', 'violations', 'checks', 'levels', 'data', 'params', 'measurements', 'price_history', 'legs'])
const encode = (column: string, value: unknown) => (JSON_COLUMNS.has(column) && value !== null && value !== undefined ? JSON.stringify(value) : value)

/** Insert one row from an object of column to value. Columns are named by the code, never by a request. */
export async function insertRow<T extends pg.QueryResultRow>(db: Q, table: string, row: Record<string, unknown>): Promise<T> {
  const columns = Object.keys(row).filter(k => row[k] !== undefined)
  const { rows } = await db.query<T>(
    `insert into ${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    columns.map(c => encode(c, row[c])),
  )
  return rows[0]
}

/** Update the given columns of one row; null when there is no such row. */
export async function updateRow<T extends pg.QueryResultRow>(
  db: Q,
  table: string,
  key: string,
  id: unknown,
  patch: Record<string, unknown>,
  opts: { touch?: boolean } = {},
): Promise<T | null> {
  const columns = Object.keys(patch).filter(k => patch[k] !== undefined)
  const sets = columns.map((c, i) => `${c} = $${i + 2}`)
  if (opts.touch !== false) sets.push('updated_at = now()')
  if (!sets.length) {
    const { rows } = await db.query<T>(`select * from ${table} where ${key} = $1`, [id])
    return rows[0] ?? null
  }
  const { rows } = await db.query<T>(`update ${table} set ${sets.join(', ')} where ${key} = $1 returning *`, [id, ...columns.map(c => encode(c, patch[c]))])
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Accounts

export async function listAccounts(db: Q, opts: { includeArchived?: boolean; desk?: string | null } = {}): Promise<Account[]> {
  const { rows } = await db.query<Account>(
    `select * from accounts where ($1 or archived_at is null) and ($2::text is null or desk = $2) order by desk, paper, name`,
    [Boolean(opts.includeArchived), opts.desk ?? null],
  )
  return rows
}

export async function getAccount(db: Q, id: string): Promise<Account | null> {
  const { rows } = await db.query<Account>('select * from accounts where id = $1', [id])
  return rows[0] ?? null
}

/** Starting balance, plus money in and out, plus every closed trade and settled bet. Null when nothing was ever entered. */
export async function accountBalance(db: Q, account: Account): Promise<number | null> {
  const { rows } = await db.query<{ flows: number | null; flow_count: number; trades: number | null; bets: number | null }>(
    `select
       (select sum(amount) from account_flows where account = $1) as flows,
       (select count(*)::int from account_flows where account = $1) as flow_count,
       (select sum(pnl) from trades where account = $1 and status = 'closed') as trades,
       (select sum(pnl) from bets where account = $1 and pnl is not null) as bets`,
    [account.id],
  )
  const r = rows[0]
  if (account.starting_balance === 0 && r.flow_count === 0) return null
  return round2(account.starting_balance + (r.flows ?? 0) + (r.trades ?? 0) + (r.bets ?? 0))
}

export async function listFlows(db: Q, opts: { account?: string | null; kind?: string | null; taxYear?: number | null; limit?: number } = {}): Promise<Flow[]> {
  const { rows } = await db.query<Flow>(
    `select * from account_flows where ($1::text is null or account = $1) and ($2::text is null or kind = $2) and ($3::int is null or tax_year = $3)
     order by occurred_at desc, id desc limit $4`,
    [opts.account ?? null, opts.kind ?? null, opts.taxYear ?? null, Math.min(opts.limit ?? 200, 2000)],
  )
  return rows
}

export async function upsertSnapshot(db: Q, s: { account: string; as_of: string; value: number; cash?: number | null; note?: string; created_by: string }): Promise<Snapshot> {
  const { rows } = await db.query<Snapshot>(
    `insert into account_snapshots (account, as_of, value, cash, note, created_by) values ($1, $2, $3, $4, $5, $6)
     on conflict (account, as_of) do update set value = excluded.value, cash = excluded.cash, note = excluded.note, created_by = excluded.created_by, created_at = now()
     returning *`,
    [s.account, s.as_of, s.value, s.cash ?? null, s.note ?? '', s.created_by],
  )
  return rows[0]
}

export async function listSnapshots(db: Q, account?: string | null, limit = 400): Promise<Snapshot[]> {
  const { rows } = await db.query<Snapshot>(`select * from account_snapshots where ($1::text is null or account = $1) order by as_of desc limit $2`, [account ?? null, limit])
  return rows
}

// ---------------------------------------------------------------------------
// Setups

export async function listSetups(db: Q, opts: { desk?: string | null; status?: string | null } = {}): Promise<Setup[]> {
  const { rows } = await db.query<Setup>(
    `select * from setups where ($1::text is null or desk = $1) and ($2::text is null or status = $2)
     order by case status when 'live' then 0 when 'paper' then 1 when 'backtesting' then 2 when 'idea' then 3 else 4 end, name`,
    [opts.desk ?? null, opts.status ?? null],
  )
  return rows
}

export async function getSetup(db: Q, slug: string): Promise<Setup | null> {
  const { rows } = await db.query<Setup>('select * from setups where slug = $1', [slug])
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Trades

export interface TradeFilter {
  account?: string | null
  status?: string | null
  setup?: string | null
  symbol?: string | null
  /** Closed on or after this instant (open trades are always included when status is not "closed"). */
  from?: string | null
  to?: string | null
  query?: string | null
  /** Leave out trades in paper accounts. */
  real?: boolean
  limit?: number
}

export async function listTrades(db: Q, f: TradeFilter = {}): Promise<Trade[]> {
  const where: string[] = []
  const values: unknown[] = []
  const add = (sql: string, v: unknown) => {
    values.push(v)
    where.push(sql.replaceAll('?', `$${values.length}`))
  }
  if (f.account) add('account = ?', f.account)
  if (f.status) add('status = ?', f.status)
  if (f.setup) add(f.setup === '(none)' ? 'setup is null and ? is not null' : 'setup = ?', f.setup)
  if (f.symbol) add('upper(symbol) like upper(?) || \'%\'', f.symbol)
  if (f.from) add('coalesce(closed_at, opened_at) >= ?', f.from)
  if (f.to) add('coalesce(closed_at, opened_at) < ?', f.to)
  if (f.query) add(`(notes ilike '%' || ? || '%' or symbol ilike '%' || ? || '%' or coalesce(setup, '') ilike '%' || ? || '%')`, f.query)
  if (f.real) where.push('not paper')
  values.push(Math.min(Math.max(f.limit ?? 200, 1), 5000))
  const { rows } = await db.query<Trade>(
    `select * from trades ${where.length ? 'where ' + where.join(' and ') : ''}
     order by (status = 'open') desc, coalesce(closed_at, opened_at) desc, id desc limit $${values.length}`,
    values,
  )
  return rows
}

export async function getTrade(db: Q, id: number): Promise<Trade | null> {
  const { rows } = await db.query<Trade>('select * from trades where id = $1', [id])
  return rows[0] ?? null
}

/** Everything the day's arithmetic needs: open trades, and anything opened or closed since `since`. */
export async function tradesSince(db: Q, account: string, since: Date): Promise<Trade[]> {
  const { rows } = await db.query<Trade>(`select * from trades where account = $1 and (status = 'open' or closed_at >= $2 or opened_at >= $2)`, [account, since.toISOString()])
  return rows
}

export async function closedTradesForSetup(db: Q, setup: string, real: boolean): Promise<Trade[]> {
  const { rows } = await db.query<Trade>(`select * from trades where setup = $1 and status = 'closed' and ($2::boolean is false or not paper) order by closed_at`, [setup, real])
  return rows
}

// ---------------------------------------------------------------------------
// Tickets

export async function listTickets(db: Q, opts: { status?: string[] | null; account?: string | null; limit?: number } = {}): Promise<Ticket[]> {
  const { rows } = await db.query<Ticket>(
    `select * from tickets where ($1::text[] is null or status = any($1)) and ($2::text is null or account = $2)
     order by (status = 'pending') desc, (status = 'approved') desc, id desc limit $3`,
    [opts.status?.length ? opts.status : null, opts.account ?? null, Math.min(opts.limit ?? 100, 1000)],
  )
  return rows
}

export async function getTicket(db: Q, id: number): Promise<Ticket | null> {
  const { rows } = await db.query<Ticket>('select * from tickets where id = $1', [id])
  return rows[0] ?? null
}

/** Proposals nobody answered in time. Returns the ones it expired. */
export async function expireTickets(db: Q, now: Date): Promise<Ticket[]> {
  const { rows } = await db.query<Ticket>(
    `update tickets set status = 'expired', updated_at = now() where status in ('pending', 'approved') and expires_at is not null and expires_at <= $1 returning *`,
    [now.toISOString()],
  )
  return rows
}

// ---------------------------------------------------------------------------
// Locks and guardrail events

interface LockRow {
  id: number
  account: string | null
  kind: 'halt' | 'manual'
  reason: string
  created_by: string
  created_at: string
  until: string | null
}

/** Locks you set that have not been lifted and have not run out. */
export async function storedLocks(db: Q, now: Date): Promise<Lock[]> {
  const { rows } = await db.query<LockRow>(`select id, account, kind, reason, created_by, created_at, until from risk_locks where lifted_at is null and (until is null or until > $1) order by id`, [
    now.toISOString(),
  ])
  return rows
}

export async function liftLock(db: Q, id: number, by: string): Promise<LockRow | null> {
  const { rows } = await db.query<LockRow>(`update risk_locks set lifted_at = now(), lifted_by = $2 where id = $1 and lifted_at is null returning id, account, kind, reason, created_by, created_at, until`, [id, by])
  return rows[0] ?? null
}

export async function liftHalt(db: Q, by: string): Promise<number> {
  const { rowCount } = await db.query(`update risk_locks set lifted_at = now(), lifted_by = $1 where kind = 'halt' and lifted_at is null`, [by])
  return rowCount ?? 0
}

export interface RiskEvent {
  id: number
  account: string | null
  kind: string
  detail: string
  data: Record<string, unknown>
  actor: string
  created_at: string
}

export async function recordRiskEvent(db: Q, e: { account?: string | null; kind: string; detail: string; data?: Record<string, unknown>; actor?: string }): Promise<RiskEvent> {
  return insertRow<RiskEvent>(db, 'risk_events', { account: e.account ?? null, kind: e.kind, detail: e.detail, data: e.data ?? {}, actor: e.actor ?? 'system' })
}

export async function listRiskEvents(db: Q, opts: { from?: string | null; to?: string | null; kinds?: string[] | null; limit?: number } = {}): Promise<RiskEvent[]> {
  const { rows } = await db.query<RiskEvent>(
    `select * from risk_events where ($1::timestamptz is null or created_at >= $1) and ($2::timestamptz is null or created_at < $2)
       and ($3::text[] is null or kind = any($3)) order by id desc limit $4`,
    [opts.from ?? null, opts.to ?? null, opts.kinds?.length ? opts.kinds : null, Math.min(opts.limit ?? 100, 1000)],
  )
  return rows
}

// ---------------------------------------------------------------------------
// Expenses and hours

export interface Expense {
  id: number
  desk: string
  account: string | null
  amount: number
  category: string
  note: string
  spent_at: string
  created_by: string
  created_at: string
}

export interface TimeEntry {
  id: number
  desk: string
  minutes: number
  note: string
  worked_on: string
  created_by: string
  created_at: string
}

export async function listExpenses(db: Q, opts: { desk?: string | null; from?: string | null; to?: string | null; limit?: number } = {}): Promise<Expense[]> {
  const { rows } = await db.query<Expense>(
    `select * from expenses where ($1::text is null or desk = $1) and ($2::timestamptz is null or spent_at >= $2) and ($3::timestamptz is null or spent_at < $3)
     order by spent_at desc, id desc limit $4`,
    [opts.desk ?? null, opts.from ?? null, opts.to ?? null, Math.min(opts.limit ?? 200, 2000)],
  )
  return rows
}

export async function listTime(db: Q, opts: { desk?: string | null; from?: string | null; to?: string | null; limit?: number } = {}): Promise<TimeEntry[]> {
  const { rows } = await db.query<TimeEntry>(
    `select * from time_entries where ($1::text is null or desk = $1) and ($2::date is null or worked_on >= $2) and ($3::date is null or worked_on <= $3)
     order by worked_on desc, id desc limit $4`,
    [opts.desk ?? null, opts.from ?? null, opts.to ?? null, Math.min(opts.limit ?? 200, 2000)],
  )
  return rows
}

// ---------------------------------------------------------------------------
// P&L

interface DayAmount {
  desk: string
  day: string
  amount: number
  n: number
}

/**
 * What every desk made between two local dates (both included): closed trades,
 * settled bets and sold items as realized; accounts tracked by snapshots as the
 * change in their value net of deposits; expenses taken off; hours alongside.
 * Paper accounts are left out.
 */
export async function pnlReport(db: Q, opts: { from: string; to: string; timezone: string }): Promise<PnlReport> {
  const tz = opts.timezone
  const start = startOfDay(opts.from, tz).toISOString()
  const end = startOfDay(addDays(opts.to, 1), tz).toISOString()

  const realized = await db.query<DayAmount>(
    `select a.desk, (t.closed_at at time zone $3)::date as day, sum(t.pnl) as amount, count(*)::int as n
       from trades t join accounts a on a.id = t.account
      where t.status = 'closed' and t.pnl is not null and not a.paper and a.tracking = 'journal' and t.closed_at >= $1 and t.closed_at < $2
      group by 1, 2
     union all
     select a.desk, (b.settled_at at time zone $3)::date, sum(b.pnl), count(*)::int
       from bets b join accounts a on a.id = b.account
      where b.pnl is not null and b.settled_at is not null and not a.paper and b.settled_at >= $1 and b.settled_at < $2
      group by 1, 2
     union all
     select 'resale', (i.sold_at at time zone $3)::date, sum(i.net_profit), count(*)::int
       from items i
      where i.net_profit is not null and i.sold_at is not null and i.status in ('sold', 'shipped') and i.sold_at >= $1 and i.sold_at < $2
      group by 2`,
    [start, end, tz],
  )
  const expenses = await db.query<DayAmount>(
    `select desk, (spent_at at time zone $3)::date as day, sum(amount) as amount, count(*)::int as n from expenses where spent_at >= $1 and spent_at < $2 group by 1, 2`,
    [start, end, tz],
  )
  const hours = await db.query<{ desk: string; minutes: number }>(`select desk, sum(minutes)::int as minutes from time_entries where worked_on >= $1 and worked_on <= $2 group by 1`, [opts.from, opts.to])
  const marked = await markedChanges(db, opts)

  const desks = new Map<string, PnlBucket>()
  const bucket = (desk: string): PnlBucket => {
    let b = desks.get(desk)
    if (!b) {
      b = { desk, realized: 0, marked: 0, expenses: 0, net: 0, count: 0, minutes: 0, per_hour: null }
      desks.set(desk, b)
    }
    return b
  }
  const days = new Map<string, Record<string, number>>()
  const addDay = (day: string, desk: string, amount: number) => {
    const row = days.get(day) ?? {}
    row[desk] = round2((row[desk] ?? 0) + amount)
    days.set(day, row)
  }
  for (const r of realized.rows) {
    const b = bucket(r.desk)
    b.realized = round2(b.realized + r.amount)
    b.count += r.n
    addDay(r.day, r.desk, r.amount)
  }
  for (const r of marked) {
    bucket(r.desk).marked = round2(bucket(r.desk).marked + r.amount)
    addDay(r.day, r.desk, r.amount)
  }
  for (const r of expenses.rows) {
    bucket(r.desk).expenses = round2(bucket(r.desk).expenses + r.amount)
    addDay(r.day, r.desk, -r.amount)
  }
  for (const r of hours.rows) bucket(r.desk).minutes += r.minutes

  const total: PnlBucket = { desk: 'all', realized: 0, marked: 0, expenses: 0, net: 0, count: 0, minutes: 0, per_hour: null }
  for (const b of desks.values()) {
    b.net = round2(b.realized + b.marked - b.expenses)
    b.per_hour = b.minutes > 0 ? round2(b.net / (b.minutes / 60)) : null
    total.realized = round2(total.realized + b.realized)
    total.marked = round2(total.marked + b.marked)
    total.expenses = round2(total.expenses + b.expenses)
    total.count += b.count
    total.minutes += b.minutes
  }
  total.net = round2(total.realized + total.marked - total.expenses)
  total.per_hour = total.minutes > 0 ? round2(total.net / (total.minutes / 60)) : null

  let cumulative = 0
  const series = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, by_desk]) => {
      const net = round2(Object.values(by_desk).reduce((a, b) => a + b, 0))
      cumulative = round2(cumulative + net)
      return { day, net, cumulative, by_desk }
    })
  return {
    from: opts.from,
    to: opts.to,
    timezone: tz,
    desks: [...desks.values()].sort((a, b) => b.net - a.net),
    total,
    days: series,
  }
}

/**
 * For accounts tracked by snapshots: the change between each pair of
 * consecutive snapshots, less what was deposited in between, on the date of the
 * later one. The first snapshot is a starting point, not a gain.
 */
async function markedChanges(db: Q, opts: { from: string; to: string; timezone: string }): Promise<{ desk: string; day: string; amount: number }[]> {
  const { rows: accounts } = await db.query<{ id: string; desk: string }>(`select id, desk from accounts where tracking = 'snapshots' and not paper`)
  if (!accounts.length) return []
  const ids = accounts.map(a => a.id)
  const snaps = await db.query<{ account: string; as_of: string; value: number }>(`select account, as_of, value from account_snapshots where account = any($1) and as_of <= $2 order by account, as_of`, [ids, opts.to])
  const flows = await db.query<{ account: string; day: string; amount: number }>(
    `select account, (occurred_at at time zone $2)::date as day, sum(amount) as amount from account_flows where account = any($1) group by 1, 2`,
    [ids, opts.timezone],
  )
  const out: { desk: string; day: string; amount: number }[] = []
  for (const a of accounts) {
    const list = snaps.rows.filter(s => s.account === a.id)
    const moved = flows.rows.filter(f => f.account === a.id)
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      const cur = list[i]
      if (cur.as_of < opts.from) continue
      const net = moved.filter(f => f.day > prev.as_of && f.day <= cur.as_of).reduce((sum, f) => sum + f.amount, 0)
      out.push({ desk: a.desk, day: cur.as_of, amount: round2(cur.value - prev.value - net) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Reports

export async function listReports(db: Q, opts: { kind?: string | null; limit?: number } = {}): Promise<Omit<Report, 'data'>[]> {
  const { rows } = await db.query<Omit<Report, 'data'>>(
    `select id, kind, title, period_start, period_end, body, spoken, created_by, created_at from reports where ($1::text is null or kind = $1) order by id desc limit $2`,
    [opts.kind ?? null, Math.min(opts.limit ?? 20, 200)],
  )
  return rows
}

export async function getReport(db: Q, id: number): Promise<Report | null> {
  const { rows } = await db.query<Report>('select * from reports where id = $1', [id])
  return rows[0] ?? null
}

export async function latestReport(db: Q, kind: string): Promise<Report | null> {
  const { rows } = await db.query<Report>('select * from reports where kind = $1 order by id desc limit 1', [kind])
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Routines

export async function listRoutines(db: Q): Promise<Routine[]> {
  const { rows } = await db.query<Routine>('select * from routines order by enabled desc, desk nulls first, name')
  return rows
}

export async function getRoutine(db: Q, id: string): Promise<Routine | null> {
  const { rows } = await db.query<Routine>('select * from routines where id = $1', [id])
  return rows[0] ?? null
}

/** Enabled routines whose time has come. */
export async function dueRoutines(db: Q, now: Date): Promise<Routine[]> {
  const { rows } = await db.query<Routine>(`select * from routines where enabled and next_run_at is not null and next_run_at <= $1 order by next_run_at`, [now.toISOString()])
  return rows
}

export async function listRoutineRuns(db: Q, routine: string, limit = 20): Promise<RoutineRun[]> {
  const { rows } = await db.query<RoutineRun>('select * from routine_runs where routine = $1 order by id desc limit $2', [routine, limit])
  return rows
}

// ---------------------------------------------------------------------------
// Watchlist, alerts, calendar

export async function listWatch(db: Q, desk?: string | null): Promise<Watch[]> {
  const { rows } = await db.query<Watch>('select * from watchlist where ($1::text is null or desk = $1) order by desk, symbol', [desk ?? null])
  return rows
}

export async function upsertWatch(db: Q, w: { symbol: string; desk: string; note?: string; levels?: { price: number; label: string }[]; created_by: string }): Promise<Watch> {
  const { rows } = await db.query<Watch>(
    `insert into watchlist (symbol, desk, note, levels, created_by) values ($1, $2, $3, $4, $5)
     on conflict (desk, symbol) do update set note = case when $6 then excluded.note else watchlist.note end,
       levels = case when $7 then excluded.levels else watchlist.levels end
     returning *`,
    [w.symbol, w.desk, w.note ?? '', JSON.stringify(w.levels ?? []), w.created_by, w.note !== undefined, w.levels !== undefined],
  )
  return rows[0]
}

export async function listAlerts(db: Q, opts: { status?: string | null; symbol?: string | null } = {}): Promise<Alert[]> {
  const { rows } = await db.query<Alert>(
    `select * from alerts where ($1::text is null or status = $1) and ($2::text is null or upper(symbol) = upper($2)) order by (status = 'active') desc, id desc limit 500`,
    [opts.status ?? null, opts.symbol ?? null],
  )
  return rows
}

export async function listCalendar(db: Q, opts: { from: string; to: string; kind?: string | null; symbols?: string[] | null }): Promise<CalendarEvent[]> {
  const { rows } = await db.query<CalendarEvent>(
    `select * from calendar_events where starts_at >= $1 and starts_at < $2 and ($3::text is null or kind = $3)
       and ($4::text[] is null or symbol is null or upper(symbol) = any($4))
     order by starts_at, id limit 1000`,
    [opts.from, opts.to, opts.kind ?? null, opts.symbols?.length ? opts.symbols.map(s => s.toUpperCase()) : null],
  )
  return rows
}

export async function upsertCalendarEvent(
  db: Q,
  e: Omit<CalendarEvent, 'id' | 'created_at' | 'all_day' | 'details' | 'symbol' | 'country' | 'impact' | 'external_id'> & Partial<Pick<CalendarEvent, 'all_day' | 'details' | 'symbol' | 'country' | 'impact' | 'external_id'>>,
): Promise<CalendarEvent> {
  const { rows } = await db.query<CalendarEvent>(
    `insert into calendar_events (kind, title, symbol, country, impact, starts_at, all_day, details, source, external_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (source, external_id) do update set kind = excluded.kind, title = excluded.title, symbol = excluded.symbol, country = excluded.country,
       impact = excluded.impact, starts_at = excluded.starts_at, all_day = excluded.all_day, details = excluded.details
     returning *`,
    [e.kind, e.title, e.symbol ?? null, e.country ?? null, e.impact ?? null, e.starts_at, e.all_day ?? false, JSON.stringify(e.details ?? {}), e.source, e.external_id ?? null],
  )
  return rows[0]
}

/** The local date range of "today", for a dashboard. */
export function todayRange(now: Date, timezone: string): { from: string; to: string } {
  const day = localDate(now, timezone)
  return { from: day, to: day }
}
