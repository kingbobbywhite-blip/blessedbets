/**
 * Postgres schema, as an append-only list of migrations. Never edit an entry
 * that has shipped; add a new one.
 */
export const MIGRATIONS: string[] = [
  /* 1: everything */ `
create table sessions (
  name text primary key check (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  role text not null default 'worker' check (role in ('orchestrator', 'worker')),
  cwd text,
  description text not null default '',
  managed boolean not null default false,
  tmux_session text,
  status text not null default 'offline',
  status_text text not null default '',
  delivery text not null default 'channel' check (delivery in ('channel', 'keys')),
  claude_session_id text,
  transcript_path text,
  model text,
  permission_mode text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  archived_at timestamptz
);

-- Every message between you and the sessions, and between sessions, kept for good.
create table messages (
  id bigserial primary key,
  from_id text not null,
  to_id text not null,
  body text not null,
  kind text not null default 'chat',
  meta jsonb not null default '{}',
  speak boolean not null default false,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  seen_at timestamptz,
  read_at timestamptz,
  search tsvector generated always as (to_tsvector('english', body)) stored
);
create index messages_search_idx on messages using gin (search);
create index messages_from_idx on messages (from_id, id desc);
create index messages_to_idx on messages (to_id, id desc);
create index messages_undelivered_idx on messages (to_id, id) where delivered_at is null;

create table projects (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name text not null,
  description text not null default '',
  path text,
  color text,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
insert into projects (slug, name, description) values ('inbox', 'Inbox', 'Anything not yet filed under a project.');

-- The backlog: by project, status and priority.
create table tasks (
  id bigserial primary key,
  project text not null references projects (slug) on update cascade,
  title text not null,
  body text not null default '',
  status text not null default 'backlog'
    check (status in ('backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled')),
  priority smallint not null default 2 check (priority between 0 and 3),
  assignee text,
  tags text[] not null default '{}',
  parent_id bigint references tasks (id) on delete set null,
  due_at timestamptz,
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  position double precision not null default 0,
  search tsvector generated always as (
    setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
  ) stored
);
create index tasks_board_idx on tasks (project, status, priority, position);
create index tasks_search_idx on tasks using gin (search);
create index tasks_assignee_idx on tasks (assignee) where status not in ('done', 'cancelled');

create table task_events (
  id bigserial primary key,
  task_id bigint not null references tasks (id) on delete cascade,
  actor text not null,
  kind text not null,
  body text not null default '',
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index task_events_task_idx on task_events (task_id, id);

-- Tool approvals relayed from a session's terminal to your phone.
create table permission_requests (
  id bigserial primary key,
  session text not null,
  request_id text not null,
  tool_name text not null,
  description text not null default '',
  input_preview text not null default '',
  status text not null default 'pending' check (status in ('pending', 'allow', 'deny', 'expired')),
  decided_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (session, request_id)
);
create index permission_pending_idx on permission_requests (created_at) where status = 'pending';

create table devices (
  id text primary key,
  name text not null,
  platform text not null,
  push_token text,
  app_version text,
  runtime_version text,
  update_id text,
  capabilities text[] not null default '{}',
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- What was said in each Claude Code session's own transcript, including what
-- you typed straight into a terminal, so history search covers that too.
create table transcript_entries (
  id bigserial primary key,
  session text,
  claude_session_id text not null,
  uuid text not null unique,
  role text not null,
  body text not null,
  created_at timestamptz not null,
  search tsvector generated always as (to_tsvector('english', body)) stored
);
create index transcript_search_idx on transcript_entries using gin (search);
create index transcript_session_idx on transcript_entries (session, created_at desc);

create table transcript_files (
  path text primary key,
  session text,
  bytes_read bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Over-the-air updates of the phone app's JavaScript, served by the hub.
create table app_updates (
  id uuid primary key,
  runtime_version text not null,
  platforms text[] not null,
  message text not null default '',
  dir text not null,
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz
);
create index app_updates_runtime_idx on app_updates (runtime_version, created_at desc);

-- Installable Android builds, for changes an over-the-air update cannot carry.
create table native_builds (
  id bigserial primary key,
  platform text not null,
  version text not null,
  runtime_version text not null,
  file text not null,
  sha256 text not null,
  message text not null default '',
  created_at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
`,
]
