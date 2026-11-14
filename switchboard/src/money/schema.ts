/**
 * Tables for the money side: accounts and their limits, the trade journal,
 * order proposals, the resale pipeline, the betting ledger, routines, reports.
 * This is migration 2 in src/hub/schema.ts; once it has shipped, changes go in
 * a new migration, never here.
 */
export const MONEY_SCHEMA = `
-- A stream of P&L: a futures account, a Roth, a sportsbook, the resale business.
create table accounts (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name text not null,
  desk text not null,
  kind text not null default 'other',
  broker text not null default '',
  paper boolean not null default false,
  tracking text not null default 'journal' check (tracking in ('journal', 'snapshots')),
  starting_balance numeric not null default 0,
  risk jsonb not null default '{}',
  -- Looser limits wait here until the next trading day begins.
  risk_pending jsonb,
  day_start text not null default '00:00',
  notes text not null default '',
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- Money in and out of an account that is not a gain or a loss.
create table account_flows (
  id bigserial primary key,
  account text not null references accounts (id) on update cascade on delete cascade,
  kind text not null check (kind in ('deposit', 'withdrawal', 'contribution', 'fee', 'interest', 'dividend', 'adjustment')),
  amount numeric not null,
  tax_year integer,
  note text not null default '',
  occurred_at timestamptz not null default now(),
  created_by text not null default 'user',
  created_at timestamptz not null default now()
);
create index account_flows_idx on account_flows (account, occurred_at);

-- What the broker says an account is worth, for accounts not journaled trade by trade.
create table account_snapshots (
  id bigserial primary key,
  account text not null references accounts (id) on update cascade on delete cascade,
  as_of date not null,
  value numeric not null,
  cash numeric,
  note text not null default '',
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  unique (account, as_of)
);

-- The playbook. A setup earns its way from idea to live.
create table setups (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name text not null,
  desk text not null default 'trading',
  rules text not null default '',
  status text not null default 'idea' check (status in ('idea', 'backtesting', 'paper', 'live', 'retired')),
  backtest jsonb,
  promoted_at timestamptz,
  promoted_by text,
  promotion_note text not null default '',
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The journal.
create table trades (
  id bigserial primary key,
  account text not null references accounts (id) on update cascade,
  symbol text not null,
  asset text not null default 'future' check (asset in ('future', 'stock', 'option', 'crypto', 'forex', 'other')),
  side text not null check (side in ('long', 'short')),
  qty numeric not null check (qty > 0),
  multiplier numeric not null default 1 check (multiplier > 0),
  entry_price numeric not null,
  stop_price numeric,
  target_price numeric,
  exit_price numeric,
  fees numeric not null default 0,
  risk_amount numeric,
  pnl numeric,
  r_multiple numeric,
  status text not null default 'open' check (status in ('open', 'closed')),
  setup text references setups (slug) on update cascade on delete set null,
  tags text[] not null default '{}',
  mistakes text[] not null default '{}',
  grade text check (grade in ('A', 'B', 'C', 'D', 'F')),
  notes text not null default '',
  details jsonb not null default '{}',
  violations jsonb not null default '[]',
  paper boolean not null default false,
  ticket_id bigint,
  source text not null default 'manual',
  created_by text not null default 'user',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index trades_account_closed_idx on trades (account, closed_at desc);
create index trades_account_opened_idx on trades (account, opened_at desc);
create index trades_open_idx on trades (account) where status = 'open';
create index trades_setup_idx on trades (setup) where setup is not null;

-- Order proposals. A session proposes, the guardrails check, you approve and place it yourself.
create table tickets (
  id bigserial primary key,
  account text not null references accounts (id) on update cascade,
  symbol text not null,
  asset text not null default 'stock',
  side text not null check (side in ('long', 'short')),
  qty numeric not null check (qty > 0),
  multiplier numeric not null default 1,
  order_type text not null default 'limit' check (order_type in ('limit', 'stop', 'stop_limit', 'market')),
  limit_price numeric,
  stop_trigger numeric,
  stop_loss numeric,
  target numeric,
  tif text not null default 'day',
  setup text references setups (slug) on update cascade on delete set null,
  thesis text not null default '',
  details jsonb not null default '{}',
  risk_amount numeric,
  reward_amount numeric,
  checks jsonb not null default '{}',
  status text not null default 'pending'
    check (status in ('blocked', 'pending', 'approved', 'rejected', 'expired', 'filled', 'cancelled')),
  proposed_by text not null,
  decided_by text,
  decided_at timestamptz,
  decision_note text not null default '',
  expires_at timestamptz,
  trade_id bigint references trades (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tickets_open_idx on tickets (created_at) where status in ('pending', 'approved');

-- Locks you set: HALT ALL (account is null) or one account. Locks that follow
-- from the day's trades are worked out, not stored.
create table risk_locks (
  id bigserial primary key,
  account text references accounts (id) on update cascade on delete cascade,
  kind text not null check (kind in ('halt', 'manual')),
  reason text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  until timestamptz,
  lifted_at timestamptz,
  lifted_by text
);
create index risk_locks_active_idx on risk_locks (created_at) where lifted_at is null;

-- What the guardrails did: refused a proposal, locked a day, stopped an order tool, had a limit changed.
create table risk_events (
  id bigserial primary key,
  account text,
  kind text not null,
  detail text not null default '',
  data jsonb not null default '{}',
  actor text not null default 'system',
  created_at timestamptz not null default now()
);
create index risk_events_idx on risk_events (created_at desc);

create table expenses (
  id bigserial primary key,
  desk text not null,
  account text references accounts (id) on update cascade on delete set null,
  amount numeric not null check (amount >= 0),
  category text not null default 'other',
  note text not null default '',
  spent_at timestamptz not null default now(),
  created_by text not null default 'user',
  created_at timestamptz not null default now()
);
create index expenses_idx on expenses (spent_at);

-- Hours, so each desk can be read as dollars an hour.
create table time_entries (
  id bigserial primary key,
  desk text not null,
  minutes integer not null check (minutes > 0),
  note text not null default '',
  worked_on date not null default current_date,
  created_by text not null default 'user',
  created_at timestamptz not null default now()
);
create index time_entries_idx on time_entries (worked_on);

create table watchlist (
  id bigserial primary key,
  symbol text not null,
  desk text not null default 'trading',
  note text not null default '',
  levels jsonb not null default '[]',
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  unique (desk, symbol)
);

create table alerts (
  id bigserial primary key,
  symbol text not null,
  condition text not null check (condition in ('above', 'below')),
  price numeric not null,
  note text not null default '',
  desk text not null default 'trading',
  status text not null default 'active' check (status in ('active', 'fired', 'cancelled', 'expired')),
  last_price numeric,
  fired_at timestamptz,
  expires_at timestamptz,
  created_by text not null default 'user',
  created_at timestamptz not null default now()
);
create index alerts_active_idx on alerts (symbol) where status = 'active';

-- Economic releases, earnings, expirations.
create table calendar_events (
  id bigserial primary key,
  kind text not null check (kind in ('economic', 'earnings', 'expiry', 'other')),
  title text not null,
  symbol text,
  country text,
  impact text,
  starts_at timestamptz not null,
  all_day boolean not null default false,
  details jsonb not null default '{}',
  source text not null default 'manual',
  external_id text,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create index calendar_events_idx on calendar_events (starts_at);

-- Briefs, weekly reviews, backtests: anything written once and read later.
create table reports (
  id bigserial primary key,
  kind text not null,
  title text not null,
  period_start date,
  period_end date,
  body text not null default '',
  spoken text not null default '',
  data jsonb not null default '{}',
  created_by text not null default 'system',
  created_at timestamptz not null default now()
);
create index reports_kind_idx on reports (kind, created_at desc);

-- Work that happens on a schedule.
create table routines (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name text not null,
  desk text,
  description text not null default '',
  schedule text not null,
  timezone text,
  kind text not null check (kind in ('job', 'prompt')),
  job text,
  target text,
  prompt text not null default '',
  params jsonb not null default '{}',
  enabled boolean not null default false,
  catch_up_minutes integer not null default 90,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_note text not null default '',
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table routine_runs (
  id bigserial primary key,
  routine text not null references routines (id) on delete cascade,
  scheduled_for timestamptz,
  fired_at timestamptz not null default now(),
  status text not null check (status in ('ok', 'error', 'skipped', 'missed')),
  note text not null default '',
  report_id bigint,
  message_id bigint
);
create index routine_runs_idx on routine_runs (routine, id desc);

-- Resale ---------------------------------------------------------------------

-- What the sourcing scan looks for.
create table resale_searches (
  id bigserial primary key,
  name text not null,
  query text not null,
  platforms text[] not null default '{}',
  brand text,
  max_price numeric,
  min_profit numeric,
  min_roi numeric,
  notes text not null default '',
  enabled boolean not null default true,
  last_run_at timestamptz,
  created_by text not null default 'user',
  created_at timestamptz not null default now()
);

create table items (
  id bigserial primary key,
  sku text unique,
  title text not null,
  brand text,
  model text,
  category text not null default 'handbag',
  condition text,
  color text,
  measurements jsonb not null default '{}',
  source text,
  source_url text,
  lead_id bigint,
  cost numeric not null default 0 check (cost >= 0),
  extra_costs numeric not null default 0 check (extra_costs >= 0),
  purchased_at date,
  status text not null default 'sourced'
    check (status in ('sourced', 'received', 'authenticating', 'ready', 'listed', 'sold', 'shipped', 'returned', 'kept', 'written_off')),
  auth_required boolean not null default false,
  auth_status text not null default 'none' check (auth_status in ('none', 'pending', 'passed', 'failed')),
  auth_service text,
  auth_ref text,
  auth_override text,
  target_price numeric,
  floor_price numeric,
  sold_price numeric,
  sold_platform text,
  sold_fees numeric,
  sold_shipping numeric,
  sold_at timestamptz,
  net_profit numeric,
  comp_key text,
  notes text not null default '',
  tags text[] not null default '{}',
  location text,
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index items_status_idx on items (status);
create index items_sold_idx on items (sold_at) where sold_at is not null;

-- Something for sale somewhere that may be worth buying.
create table leads (
  id bigserial primary key,
  url text unique,
  platform text not null,
  title text not null,
  brand text,
  model text,
  condition text,
  asking_price numeric not null check (asking_price >= 0),
  shipping_in numeric not null default 0,
  est_resale numeric,
  comp_count integer not null default 0,
  comp_key text,
  sell_platform text,
  est_fees numeric,
  est_shipping_out numeric,
  est_auth_cost numeric,
  est_profit numeric,
  est_roi numeric,
  auth_required boolean not null default false,
  auth_status text not null default 'none' check (auth_status in ('none', 'pending', 'passed', 'failed')),
  auth_service text,
  auth_ref text,
  red_flags text not null default '',
  notes text not null default '',
  status text not null default 'new' check (status in ('new', 'watching', 'passed', 'bought', 'gone')),
  search_id bigint references resale_searches (id) on delete set null,
  item_id bigint references items (id) on delete set null,
  found_by text not null default 'user',
  found_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_status_idx on leads (status, found_at desc);

-- Sold prices, kept so every estimate can be traced to the sales behind it.
create table comps (
  id bigserial primary key,
  comp_key text not null,
  source text not null,
  title text not null,
  price numeric not null check (price > 0),
  sold_at date,
  url text,
  condition text,
  notes text not null default '',
  added_by text not null default 'user',
  created_at timestamptz not null default now()
);
create index comps_key_idx on comps (comp_key, sold_at desc);
create unique index comps_url_idx on comps (comp_key, url) where url is not null;

create table listings (
  id bigserial primary key,
  item_id bigint not null references items (id) on delete cascade,
  platform text not null,
  title text not null default '',
  description text not null default '',
  price numeric,
  url text,
  status text not null default 'draft' check (status in ('draft', 'active', 'ended', 'sold')),
  listed_at timestamptz,
  last_price_change_at timestamptz,
  price_history jsonb not null default '[]',
  details jsonb not null default '{}',
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, platform)
);
create index listings_active_idx on listings (listed_at) where status = 'active';

create table item_photos (
  id bigserial primary key,
  item_id bigint not null references items (id) on delete cascade,
  file text not null,
  original_name text not null default '',
  content_type text not null default 'image/jpeg',
  bytes integer not null default 0,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index item_photos_idx on item_photos (item_id, position, id);

-- Betting ----------------------------------------------------------------------

create table bets (
  id bigserial primary key,
  account text not null references accounts (id) on update cascade,
  external_id text,
  source text not null default 'manual',
  placed_at timestamptz not null default now(),
  settled_at timestamptz,
  sport text,
  league text,
  market text,
  description text not null,
  legs jsonb not null default '[]',
  stake numeric not null check (stake >= 0),
  odds_decimal numeric,
  result text not null default 'pending' check (result in ('pending', 'win', 'loss', 'push', 'void', 'partial')),
  returned numeric,
  pnl numeric,
  closing_odds_decimal numeric,
  clv_pct numeric,
  clv_points numeric,
  beat_close boolean,
  ev_at_entry numeric,
  p_at_entry numeric,
  tags text[] not null default '{}',
  notes text not null default '',
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index bets_placed_idx on bets (placed_at desc);
create index bets_settled_idx on bets (settled_at) where settled_at is not null;

-- Which desk a session works for, so it gets that desk's tools and playbook.
alter table sessions add column desk text;

-- One backlog project per desk, so voice notes and desk work have somewhere to land.
insert into projects (slug, name, description) values
  ('trading', 'Futures trading', 'Day trading futures: journal, guardrails, setups, the pre-market brief.'),
  ('investing', 'Options and Roth', 'Covered calls and cash-secured puts, the Roth IRA, long-term stocks.'),
  ('robinhood', 'Robinhood rules system', 'The rules-based investing system that lives in the Cowork project "robinhood strictly".'),
  ('resale', 'Bag resale', 'Luxury bag reselling: sourcing, comps, authentication, listings, inventory.'),
  ('betting', 'Betting', 'BlessedBets, the bet ledger and closing line value.')
on conflict (slug) do nothing;
`
