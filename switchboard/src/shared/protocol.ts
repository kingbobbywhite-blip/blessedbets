/**
 * Shapes shared by the hub, the channel server that runs inside each Claude
 * Code session, the web UI and the phone app. Everything that crosses a socket
 * or an HTTP body is described here, so a change to one side shows up as a
 * type error on the other.
 */

/** The human. Every other participant is a session name. */
export const USER = 'user'
/** Messages the hub itself writes into a thread (approvals, spawn results). */
export const SYSTEM = 'system'

/** Lowercase letters, digits, dash and underscore; starts with a letter or digit. */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
export const RESERVED_NAMES = new Set([USER, SYSTEM, 'all', 'hub', 'switchboard'])

export type SessionRole = 'orchestrator' | 'worker'
export type SessionStatus =
  | 'offline' // no channel connected, nothing running that we know of
  | 'starting' // tmux session created, Claude Code still booting
  | 'idle' // waiting for the next message
  | 'busy' // working on a turn
  | 'waiting' // a permission prompt or question is open in the terminal
  | 'attention' // stuck on a startup dialog the hub would not answer for you
  | 'exited' // the claude process ended; the tmux pane is kept for inspection

export interface Session {
  name: string
  role: SessionRole
  cwd: string | null
  description: string
  managed: boolean
  tmux_session: string | null
  status: SessionStatus
  status_text: string
  delivery: 'channel' | 'keys'
  claude_session_id: string | null
  transcript_path: string | null
  model: string | null
  permission_mode: string | null
  created_at: string
  last_seen_at: string | null
  archived_at: string | null
  /** Live: whether the session's channel server has a socket open to the hub. */
  connected?: boolean
  unread?: number
  last_message?: Pick<Message, 'id' | 'from_id' | 'to_id' | 'body' | 'created_at'> | null
}

export type MessageKind = 'chat' | 'voice' | 'system' | 'notification' | 'permission' | 'event'

export interface Message {
  id: number
  from_id: string
  to_id: string
  body: string
  kind: MessageKind
  meta: Record<string, unknown>
  speak: boolean
  created_at: string
  delivered_at: string | null
  seen_at: string | null
  read_at: string | null
}

export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
/** 0 is urgent, 3 is low. Shown as P0..P3. */
export const PRIORITY_LABELS = ['urgent', 'high', 'medium', 'low'] as const

export interface Project {
  slug: string
  name: string
  description: string
  path: string | null
  color: string | null
  created_at: string
  archived_at: string | null
  open_tasks?: number
}

export interface Task {
  id: number
  project: string
  title: string
  body: string
  status: TaskStatus
  priority: number
  assignee: string | null
  tags: string[]
  parent_id: number | null
  due_at: string | null
  created_by: string
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  position: number
}

export interface TaskEvent {
  id: number
  task_id: number
  actor: string
  kind: 'created' | 'updated' | 'comment'
  body: string
  data: Record<string, unknown>
  created_at: string
}

export interface PermissionRequest {
  id: number
  session: string
  request_id: string
  tool_name: string
  description: string
  input_preview: string
  status: 'pending' | 'allow' | 'deny' | 'expired'
  decided_by: string | null
  created_at: string
  decided_at: string | null
}

export interface Device {
  id: string
  name: string
  platform: string
  push_token: string | null
  app_version: string | null
  runtime_version: string | null
  update_id: string | null
  capabilities: string[]
  last_seen_at: string | null
  created_at: string
  online?: boolean
}

export interface SearchHit {
  source: 'message' | 'transcript' | 'task'
  ref: number
  session: string | null
  from_id: string | null
  to_id: string | null
  title: string | null
  snippet: string
  created_at: string
  rank: number
}

// ---------------------------------------------------------------------------
// WebSocket events

/** Hub -> channel server inside a Claude Code session. */
export type HubToChannel =
  | { type: 'welcome'; session: Session }
  | { type: 'deliver'; message: Message }
  | { type: 'permission_verdict'; request_id: string; behavior: 'allow' | 'deny' }
  | { type: 'pong' }

/** Channel server -> hub. */
export type ChannelToHub =
  | { type: 'hello'; session: string; role: SessionRole; cwd: string; pid: number; claude_pid?: number; version: string }
  | { type: 'ack'; id: number }
  | { type: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  | { type: 'ping' }

/** Hub -> web UI and phone app. */
export type HubToUi =
  | { type: 'hello'; sessions: Session[]; pending_permissions: PermissionRequest[]; server_time: string; orchestrator: string }
  | { type: 'message'; message: Message }
  | { type: 'message_update'; id: number; delivered_at?: string | null; seen_at?: string | null; read_at?: string | null }
  | { type: 'session'; session: Session }
  | { type: 'session_removed'; name: string }
  | { type: 'task'; task: Task }
  | { type: 'task_deleted'; id: number }
  | { type: 'project'; project: Project }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'ptt'; action: PttAction; target?: string }
  | { type: 'device_command'; id: string; action: string; params: Record<string, unknown> }
  | { type: 'app_update'; id: string; runtime_version: string; message: string }
  | { type: 'pong' }

/** Web UI and phone app -> hub. */
export type UiToHub =
  | { type: 'device_result'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'state'; voice?: boolean; foreground?: boolean; walk?: boolean; target?: string }
  | { type: 'ping' }

export type PttAction = 'start' | 'stop' | 'toggle' | 'cancel'
export const PTT_ACTIONS: readonly PttAction[] = ['start', 'stop', 'toggle', 'cancel']

/** Phone actions the app can perform when Claude asks. The app reports which it supports. */
export const PHONE_ACTIONS = [
  'speak',
  'notify',
  'vibrate',
  'open_url',
  'get_location',
  'get_battery',
  'get_device_info',
  'clipboard_get',
  'clipboard_set',
  'calendar_list',
  'calendar_create',
  'compose_sms',
  'compose_email',
  'stop_speaking',
] as const
export type PhoneAction = (typeof PHONE_ACTIONS)[number]

export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED_NAMES.has(name)
}
