import pg from 'pg'
import type {
  Device,
  Message,
  MessageKind,
  PermissionRequest,
  Project,
  SearchHit,
  Session,
  Task,
  TaskEvent,
  TaskStatus,
} from '../shared/protocol.ts'
import { TASK_STATUSES, USER } from '../shared/protocol.ts'

// Timestamps travel as ISO strings everywhere (JSON, the UI, the app).
const parseTimestamptz = pg.types.getTypeParser(1184)
pg.types.setTypeParser(1184, (v: string) => {
  const d = parseTimestamptz(v) as unknown
  return d instanceof Date ? d.toISOString() : d
})

type Q = pg.Pool | pg.PoolClient

export class NotFound extends Error {
  statusCode = 404
}
export class BadRequest extends Error {
  statusCode = 400
}

// ---------------------------------------------------------------------------
// Sessions

const SESSION_COLUMNS = `s.name, s.role, s.cwd, s.description, s.managed, s.tmux_session, s.status, s.status_text,
  s.delivery, s.claude_session_id, s.transcript_path, s.model, s.permission_mode, s.created_at, s.last_seen_at, s.archived_at`

export async function listSessions(db: Q, opts: { includeArchived?: boolean } = {}): Promise<Session[]> {
  const { rows } = await db.query<Session>(
    `select ${SESSION_COLUMNS},
       (select json_build_object('id', m.id, 'from_id', m.from_id, 'to_id', m.to_id, 'body', left(m.body, 280), 'created_at', m.created_at)
          from messages m where m.from_id = s.name or m.to_id = s.name order by m.id desc limit 1) as last_message,
       (select count(*)::int from messages m where m.from_id = s.name and m.to_id = 'user' and m.read_at is null) as unread
     from sessions s
     where $1 or s.archived_at is null
     order by (s.role = 'orchestrator') desc, coalesce(s.last_seen_at, s.created_at) desc`,
    [Boolean(opts.includeArchived)],
  )
  return rows
}

export async function getSession(db: Q, name: string): Promise<Session | null> {
  const { rows } = await db.query<Session>(`select ${SESSION_COLUMNS} from sessions s where s.name = $1`, [name])
  return rows[0] ?? null
}

export async function requireSession(db: Q, name: string): Promise<Session> {
  const s = await getSession(db, name)
  if (!s) throw new NotFound(`No session named "${name}"`)
  return s
}

const SESSION_FIELDS = [
  'role',
  'cwd',
  'description',
  'managed',
  'tmux_session',
  'status',
  'status_text',
  'delivery',
  'claude_session_id',
  'transcript_path',
  'model',
  'permission_mode',
  'last_seen_at',
  'archived_at',
] as const
type SessionPatch = Partial<Pick<Session, (typeof SESSION_FIELDS)[number]>>

/** Create the session row if it does not exist, then apply the fields given. */
export async function upsertSession(db: Q, name: string, patch: SessionPatch = {}): Promise<Session> {
  await db.query('insert into sessions (name) values ($1) on conflict (name) do nothing', [name])
  return updateSession(db, name, patch)
}

export async function updateSession(db: Q, name: string, patch: SessionPatch): Promise<Session> {
  const sets: string[] = []
  const values: unknown[] = [name]
  for (const key of SESSION_FIELDS) {
    if (key in patch) {
      values.push((patch as Record<string, unknown>)[key])
      sets.push(`${key} = $${values.length}`)
    }
  }
  if (sets.length) await db.query(`update sessions set ${sets.join(', ')} where name = $1`, values)
  return requireSession(db, name)
}

// ---------------------------------------------------------------------------
// Messages

const MESSAGE_COLUMNS = 'id, from_id, to_id, body, kind, meta, speak, created_at, delivered_at, seen_at, read_at'

export interface NewMessage {
  from_id: string
  to_id: string
  body: string
  kind?: MessageKind
  meta?: Record<string, unknown>
  speak?: boolean
}

export async function insertMessage(db: Q, m: NewMessage): Promise<Message> {
  const { rows } = await db.query<Message>(
    `insert into messages (from_id, to_id, body, kind, meta, speak) values ($1, $2, $3, $4, $5, $6) returning ${MESSAGE_COLUMNS}`,
    [m.from_id, m.to_id, m.body, m.kind ?? 'chat', JSON.stringify(m.meta ?? {}), Boolean(m.speak)],
  )
  return rows[0]
}

export async function getMessage(db: Q, id: number): Promise<Message | null> {
  const { rows } = await db.query<Message>(`select ${MESSAGE_COLUMNS} from messages where id = $1`, [id])
  return rows[0] ?? null
}

/**
 * A thread: every message to or from `participant` (a session name, or "user"
 * for everything you sent or received). Oldest first.
 */
export async function listMessages(
  db: Q,
  opts: { participant?: string | null; before?: number | null; after?: number | null; around?: number | null; limit?: number },
): Promise<Message[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const p = opts.participant ?? null
  const where = `($1::text is null or from_id = $1 or to_id = $1)`
  if (opts.around) {
    const half = Math.max(1, Math.floor(limit / 2))
    const { rows } = await db.query<Message>(
      `(select ${MESSAGE_COLUMNS} from messages where ${where} and id <= $2 order by id desc limit $3)
       union all
       (select ${MESSAGE_COLUMNS} from messages where ${where} and id > $2 order by id asc limit $4)
       order by id asc`,
      [p, opts.around, half + 1, half],
    )
    return rows
  }
  if (opts.after) {
    const { rows } = await db.query<Message>(
      `select ${MESSAGE_COLUMNS} from messages where ${where} and id > $2 order by id asc limit $3`,
      [p, opts.after, limit],
    )
    return rows
  }
  const { rows } = await db.query<Message>(
    `select * from (select ${MESSAGE_COLUMNS} from messages where ${where} and ($2::bigint is null or id < $2)
       order by id desc limit $3) t order by id asc`,
    [p, opts.before ?? null, limit],
  )
  return rows
}

export async function undeliveredFor(db: Q, session: string): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `select ${MESSAGE_COLUMNS} from messages where to_id = $1 and delivered_at is null and not (meta ? 'superseded')
     order by id asc limit 200`,
    [session],
  )
  return rows
}

/** A session is being started again with a new first prompt: earlier first prompts that never landed are dropped. */
export async function supersedeSpawnPrompts(db: Q, session: string): Promise<void> {
  await db.query(
    `update messages set meta = meta || '{"superseded": true}'::jsonb
     where to_id = $1 and delivered_at is null and meta->>'via' = 'spawn'`,
    [session],
  )
}

export async function markDelivered(db: Q, id: number): Promise<string | null> {
  const { rows } = await db.query<{ delivered_at: string }>(
    'update messages set delivered_at = coalesce(delivered_at, now()) where id = $1 returning delivered_at',
    [id],
  )
  return rows[0]?.delivered_at ?? null
}

/** Claude has the message in its context: it was found in the session transcript. */
export async function markSeen(db: Q, ids: number[]): Promise<{ id: number; seen_at: string }[]> {
  if (!ids.length) return []
  const { rows } = await db.query<{ id: number; seen_at: string }>(
    `update messages set seen_at = now(), delivered_at = coalesce(delivered_at, now())
     where id = any($1::bigint[]) and seen_at is null returning id, seen_at`,
    [ids],
  )
  return rows
}

/** You have read everything a session sent you. */
export async function markRead(db: Q, session: string): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `update messages set read_at = now() where from_id = $1 and to_id = 'user' and read_at is null returning id`,
    [session],
  )
  return rows.map(r => r.id)
}

// ---------------------------------------------------------------------------
// Projects and tasks

export async function listProjects(db: Q, opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
  const { rows } = await db.query<Project>(
    `select p.*, (select count(*)::int from tasks t where t.project = p.slug and t.status not in ('done', 'cancelled')) as open_tasks
     from projects p where $1 or p.archived_at is null order by p.slug = 'inbox' desc, p.name`,
    [Boolean(opts.includeArchived)],
  )
  return rows
}

export async function getProject(db: Q, slug: string): Promise<Project | null> {
  const { rows } = await db.query<Project>('select * from projects where slug = $1', [slug])
  return rows[0] ?? null
}

export async function createProject(
  db: Q,
  p: { slug: string; name?: string; description?: string; path?: string | null; color?: string | null },
): Promise<Project> {
  const { rows } = await db.query<Project>(
    `insert into projects (slug, name, description, path, color) values ($1, $2, $3, $4, $5)
     on conflict (slug) do update set
       name = coalesce(nullif($2, ''), projects.name),
       description = case when $3 = '' then projects.description else $3 end,
       path = coalesce($4, projects.path),
       color = coalesce($5, projects.color),
       archived_at = null
     returning *`,
    [p.slug, p.name || p.slug, p.description ?? '', p.path ?? null, p.color ?? null],
  )
  return rows[0]
}

export async function updateProject(
  db: Q,
  slug: string,
  patch: { name?: string; description?: string; path?: string | null; color?: string | null; archived?: boolean },
): Promise<Project> {
  const sets: string[] = []
  const values: unknown[] = [slug]
  for (const key of ['name', 'description', 'path', 'color'] as const) {
    if (key in patch) {
      values.push(patch[key])
      sets.push(`${key} = $${values.length}`)
    }
  }
  if ('archived' in patch) sets.push(`archived_at = ${patch.archived ? 'now()' : 'null'}`)
  if (sets.length) await db.query(`update projects set ${sets.join(', ')} where slug = $1`, values)
  const p = await getProject(db, slug)
  if (!p) throw new NotFound(`No project "${slug}"`)
  return p
}

export interface TaskFilter {
  project?: string | null
  status?: string[] | null
  priority?: number[] | null
  assignee?: string | null
  query?: string | null
  includeClosed?: boolean
  parent_id?: number | null
  limit?: number
}

const TASK_COLUMNS = `id, project, title, body, status, priority, assignee, tags, parent_id, due_at, created_by,
  created_at, updated_at, started_at, completed_at, position`

export async function listTasks(db: Q, f: TaskFilter = {}): Promise<Task[]> {
  const where: string[] = []
  const values: unknown[] = []
  const add = (sql: string, v: unknown) => {
    values.push(v)
    where.push(sql.replace('?', `$${values.length}`))
  }
  if (f.project) add('project = ?', f.project)
  if (f.status?.length) add('status = any(?::text[])', f.status)
  else if (!f.includeClosed) where.push(`status not in ('done', 'cancelled')`)
  if (f.priority?.length) add('priority = any(?::smallint[])', f.priority)
  if (f.assignee) add('assignee = ?', f.assignee)
  if (f.parent_id) add('parent_id = ?', f.parent_id)
  if (f.query) {
    values.push(f.query)
    const i = values.length
    where.push(`(search @@ websearch_to_tsquery('english', $${i}) or title ilike '%' || $${i} || '%')`)
  }
  values.push(Math.min(Math.max(f.limit ?? 500, 1), 2000))
  const { rows } = await db.query<Task>(
    `select ${TASK_COLUMNS} from tasks ${where.length ? 'where ' + where.join(' and ') : ''}
     order by priority asc, case status when 'in_progress' then 0 when 'blocked' then 1 when 'review' then 2
       when 'todo' then 3 when 'backlog' then 4 else 5 end, position asc, id asc
     limit $${values.length}`,
    values,
  )
  return rows
}

export async function getTask(db: Q, id: number): Promise<(Task & { events: TaskEvent[]; subtasks: Task[] }) | null> {
  const { rows } = await db.query<Task>(`select ${TASK_COLUMNS} from tasks where id = $1`, [id])
  if (!rows[0]) return null
  const events = await db.query<TaskEvent>('select * from task_events where task_id = $1 order by id asc', [id])
  const subtasks = await db.query<Task>(`select ${TASK_COLUMNS} from tasks where parent_id = $1 order by id`, [id])
  return { ...rows[0], events: events.rows, subtasks: subtasks.rows }
}

export interface NewTask {
  project?: string
  title: string
  body?: string
  status?: string
  priority?: number
  assignee?: string | null
  tags?: string[]
  parent_id?: number | null
  due_at?: string | null
}

export function checkStatus(status: string | undefined): TaskStatus | undefined {
  if (status === undefined) return undefined
  const s = status.trim().toLowerCase().replace(/[\s-]+/g, '_') as TaskStatus
  if (!(TASK_STATUSES as readonly string[]).includes(s)) {
    throw new BadRequest(`Unknown status "${status}". Use one of: ${TASK_STATUSES.join(', ')}`)
  }
  return s
}

/** Accepts 0-3, "p0".."p3", or urgent/high/medium/low. */
export function checkPriority(priority: unknown): number | undefined {
  if (priority === undefined || priority === null || priority === '') return undefined
  if (typeof priority === 'number' && Number.isInteger(priority) && priority >= 0 && priority <= 3) return priority
  const s = String(priority).trim().toLowerCase()
  const named: Record<string, number> = { urgent: 0, critical: 0, high: 1, medium: 2, normal: 2, low: 3 }
  if (s in named) return named[s]
  const m = /^p?([0-3])$/.exec(s)
  if (m) return Number(m[1])
  throw new BadRequest(`Unknown priority "${priority}". Use P0 (urgent), P1 (high), P2 (medium) or P3 (low).`)
}

export async function createTask(db: Q, t: NewTask, actor: string): Promise<Task> {
  const title = t.title?.trim()
  if (!title) throw new BadRequest('A task needs a title')
  const project = t.project?.trim() || 'inbox'
  if (!(await getProject(db, project))) {
    throw new BadRequest(`No project "${project}". Create it first (projects are lowercase slugs).`)
  }
  const status = checkStatus(t.status) ?? 'backlog'
  const priority = checkPriority(t.priority) ?? 2
  const { rows } = await db.query<Task>(
    `insert into tasks (project, title, body, status, priority, assignee, tags, parent_id, due_at, created_by, position,
       started_at, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       coalesce((select max(position) + 1 from tasks where project = $1 and status = $4), 0),
       case when $4 = 'in_progress' then now() end, case when $4 in ('done', 'cancelled') then now() end)
     returning ${TASK_COLUMNS}`,
    [project, title, t.body ?? '', status, priority, t.assignee || null, t.tags ?? [], t.parent_id ?? null, t.due_at ?? null, actor],
  )
  await db.query(`insert into task_events (task_id, actor, kind, data) values ($1, $2, 'created', $3)`, [
    rows[0].id,
    actor,
    JSON.stringify({ status, priority, project }),
  ])
  return rows[0]
}

export interface TaskPatch {
  title?: string
  body?: string
  status?: string
  priority?: number | string
  assignee?: string | null
  tags?: string[]
  project?: string
  parent_id?: number | null
  due_at?: string | null
  position?: number
}

export async function updateTask(db: Q, id: number, patch: TaskPatch, actor: string, comment?: string): Promise<Task> {
  const before = await getTask(db, id)
  if (!before) throw new NotFound(`No task #${id}`)
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const sets: string[] = []
  const values: unknown[] = [id]
  const set = (col: string, value: unknown) => {
    if (JSON.stringify((before as unknown as Record<string, unknown>)[col]) === JSON.stringify(value)) return
    changes[col] = { from: (before as unknown as Record<string, unknown>)[col], to: value }
    values.push(value)
    sets.push(`${col} = $${values.length}`)
  }
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new BadRequest('A task needs a title')
    set('title', patch.title.trim())
  }
  if (patch.body !== undefined) set('body', patch.body)
  if (patch.project !== undefined) {
    if (!(await getProject(db, patch.project))) throw new BadRequest(`No project "${patch.project}"`)
    set('project', patch.project)
  }
  if (patch.status !== undefined) {
    const status = checkStatus(patch.status)!
    set('status', status)
    if (status !== before.status) {
      if (status === 'in_progress' && !before.started_at) sets.push('started_at = now()')
      if (status === 'done' || status === 'cancelled') sets.push('completed_at = now()')
      else sets.push('completed_at = null')
    }
  }
  if (patch.priority !== undefined) set('priority', checkPriority(patch.priority))
  if (patch.assignee !== undefined) set('assignee', patch.assignee || null)
  if (patch.tags !== undefined) set('tags', patch.tags)
  if (patch.parent_id !== undefined) {
    if (patch.parent_id === id) throw new BadRequest('A task cannot be its own parent')
    set('parent_id', patch.parent_id)
  }
  if (patch.due_at !== undefined) set('due_at', patch.due_at)
  if (patch.position !== undefined) set('position', patch.position)

  if (sets.length) {
    sets.push('updated_at = now()')
    await db.query(`update tasks set ${sets.join(', ')} where id = $1`, values)
    await db.query(`insert into task_events (task_id, actor, kind, data) values ($1, $2, 'updated', $3)`, [
      id,
      actor,
      JSON.stringify(changes),
    ])
  }
  if (comment?.trim()) {
    await db.query(`insert into task_events (task_id, actor, kind, body) values ($1, $2, 'comment', $3)`, [id, actor, comment.trim()])
    if (!sets.length) await db.query('update tasks set updated_at = now() where id = $1', [id])
  }
  const after = await getTask(db, id)
  const { events: _e, subtasks: _s, ...task } = after!
  return task
}

export async function deleteTask(db: Q, id: number): Promise<boolean> {
  const { rowCount } = await db.query('delete from tasks where id = $1', [id])
  return (rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Permission requests

export async function insertPermission(
  db: Q,
  p: { session: string; request_id: string; tool_name: string; description: string; input_preview: string },
): Promise<PermissionRequest> {
  const { rows } = await db.query<PermissionRequest>(
    `insert into permission_requests (session, request_id, tool_name, description, input_preview)
     values ($1, $2, $3, $4, $5)
     on conflict (session, request_id) do update set tool_name = excluded.tool_name, description = excluded.description,
       input_preview = excluded.input_preview, status = 'pending', decided_at = null, decided_by = null, created_at = now()
     returning *`,
    [p.session, p.request_id, p.tool_name, p.description, p.input_preview],
  )
  return rows[0]
}

export async function getPermission(db: Q, id: number): Promise<PermissionRequest | null> {
  const { rows } = await db.query<PermissionRequest>('select * from permission_requests where id = $1', [id])
  return rows[0] ?? null
}

export async function decidePermission(
  db: Q,
  id: number,
  behavior: 'allow' | 'deny',
  by: string,
): Promise<PermissionRequest | null> {
  const { rows } = await db.query<PermissionRequest>(
    `update permission_requests set status = $2, decided_by = $3, decided_at = now()
     where id = $1 and status = 'pending' returning *`,
    [id, behavior, by],
  )
  return rows[0] ?? null
}

export async function pendingPermissions(db: Q, maxAgeMinutes = 60): Promise<PermissionRequest[]> {
  const { rows } = await db.query<PermissionRequest>(
    `select * from permission_requests where status = 'pending' and created_at > now() - make_interval(mins => $1)
     order by id asc`,
    [maxAgeMinutes],
  )
  return rows
}

/** A turn ended or the terminal answered: anything still open for that session is no longer waiting on you. */
export async function expirePermissions(db: Q, session: string, olderThanSeconds = 3): Promise<PermissionRequest[]> {
  const { rows } = await db.query<PermissionRequest>(
    `update permission_requests set status = 'expired', decided_at = now(), decided_by = 'terminal'
     where session = $1 and status = 'pending' and created_at < now() - make_interval(secs => $2) returning *`,
    [session, olderThanSeconds],
  )
  return rows
}

// ---------------------------------------------------------------------------
// Devices

export async function upsertDevice(
  db: Q,
  d: Pick<Device, 'id' | 'name' | 'platform'> & Partial<Omit<Device, 'id' | 'name' | 'platform'>>,
): Promise<Device> {
  const { rows } = await db.query<Device>(
    `insert into devices (id, name, platform, push_token, app_version, runtime_version, update_id, capabilities, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (id) do update set name = excluded.name, platform = excluded.platform,
       push_token = coalesce(excluded.push_token, devices.push_token),
       app_version = coalesce(excluded.app_version, devices.app_version),
       runtime_version = coalesce(excluded.runtime_version, devices.runtime_version),
       update_id = coalesce(excluded.update_id, devices.update_id),
       capabilities = case when cardinality(excluded.capabilities) > 0 then excluded.capabilities else devices.capabilities end,
       last_seen_at = now()
     returning *`,
    [
      d.id,
      d.name,
      d.platform,
      d.push_token ?? null,
      d.app_version ?? null,
      d.runtime_version ?? null,
      d.update_id ?? null,
      d.capabilities ?? [],
    ],
  )
  return rows[0]
}

export async function listDevices(db: Q): Promise<Device[]> {
  const { rows } = await db.query<Device>('select * from devices order by last_seen_at desc nulls last')
  return rows
}

export async function touchDevice(db: Q, id: string): Promise<void> {
  await db.query('update devices set last_seen_at = now() where id = $1', [id])
}

// ---------------------------------------------------------------------------
// Search across every message, every session transcript, and the backlog

export async function search(
  db: Q,
  opts: { query: string; session?: string | null; limit?: number; sources?: SearchHit['source'][] },
): Promise<SearchHit[]> {
  const query = opts.query.trim()
  if (!query) return []
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200)
  const sources = opts.sources?.length ? opts.sources : ['message', 'transcript', 'task']
  const session = opts.session || null
  const headline = `'StartSel=[[, StopSel=]], MaxWords=35, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "'`
  const { rows } = await db.query<SearchHit>(
    `with q as (select websearch_to_tsquery('english', $1) as tsq)
     select * from (
       select 'message' as source, m.id as ref,
         case when m.from_id = 'user' then m.to_id else m.from_id end as session,
         m.from_id, m.to_id, null::text as title,
         ts_headline('english', m.body, q.tsq, ${headline}) as snippet, m.created_at, ts_rank_cd(m.search, q.tsq) as rank
       from messages m, q
       where 'message' = any($4) and m.search @@ q.tsq and ($2::text is null or m.from_id = $2 or m.to_id = $2)
       union all
       select 'transcript', t.id, t.session, case when t.role = 'user' then 'user' else t.session end,
         case when t.role = 'user' then t.session else 'user' end, null,
         ts_headline('english', t.body, q.tsq, ${headline}), t.created_at, ts_rank_cd(t.search, q.tsq)
       from transcript_entries t, q
       where 'transcript' = any($4) and t.search @@ q.tsq and ($2::text is null or t.session = $2)
       union all
       select 'task', k.id, k.assignee, k.created_by, null, k.title,
         ts_headline('english', k.title || '. ' || k.body, q.tsq, ${headline}), k.updated_at, ts_rank_cd(k.search, q.tsq)
       from tasks k, q
       where 'task' = any($4) and k.search @@ q.tsq and ($2::text is null or k.assignee = $2)
     ) hits
     order by rank desc, created_at desc
     limit $3`,
    [query, session, limit, sources],
  )
  if (rows.length >= limit || query.length < 3) return rows

  // Words the English dictionary drops (or partial words, file names, error codes): match the raw text too.
  const like = '%' + query.replace(/[\\%_]/g, c => '\\' + c) + '%'
  const seen = new Set(rows.map(r => `${r.source}:${r.ref}`))
  const extra = await db.query<SearchHit>(
    `select * from (
       select 'message' as source, m.id as ref, case when m.from_id = 'user' then m.to_id else m.from_id end as session,
         m.from_id, m.to_id, null::text as title, left(m.body, 300) as snippet, m.created_at, 0::real as rank
       from messages m where 'message' = any($4) and m.body ilike $1 and ($2::text is null or m.from_id = $2 or m.to_id = $2)
       union all
       select 'transcript', t.id, t.session, case when t.role = 'user' then 'user' else t.session end,
         case when t.role = 'user' then t.session else 'user' end, null, left(t.body, 300), t.created_at, 0
       from transcript_entries t where 'transcript' = any($4) and t.body ilike $1 and ($2::text is null or t.session = $2)
       union all
       select 'task', k.id, k.assignee, k.created_by, null, k.title, left(k.title || '. ' || k.body, 300), k.updated_at, 0
       from tasks k where 'task' = any($4) and (k.title ilike $1 or k.body ilike $1) and ($2::text is null or k.assignee = $2)
     ) hits order by created_at desc limit $3`,
    [like, session, limit, sources],
  )
  for (const hit of extra.rows) {
    if (rows.length >= limit) break
    if (!seen.has(`${hit.source}:${hit.ref}`)) rows.push(hit)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Settings

export async function getSetting<T>(db: Q, key: string, fallback: T): Promise<T> {
  const { rows } = await db.query<{ value: T }>('select value from settings where key = $1', [key])
  return rows[0] ? rows[0].value : fallback
}

export async function setSetting(db: Q, key: string, value: unknown): Promise<void> {
  await db.query(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  )
}

export { USER }
