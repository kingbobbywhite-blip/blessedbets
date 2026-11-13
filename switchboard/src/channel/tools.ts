import type { Message, SearchHit, Session, Task } from '../shared/protocol.ts'
import { PHONE_ACTIONS, PRIORITY_LABELS, TASK_STATUSES } from '../shared/protocol.ts'

export interface ToolContext {
  hubUrl: string
  token: string
  session: string
  role: 'orchestrator' | 'worker'
  api(method: string, path: string, body?: unknown): Promise<unknown>
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

const str = (description: string) => ({ type: 'string', description })
const int = (description: string) => ({ type: 'integer', description })
const bool = (description: string) => ({ type: 'boolean', description })
const priority = {
  description: 'P0 urgent, P1 high, P2 medium (default), P3 low. Accepts 0-3, "p1", or "high".',
  anyOf: [{ type: 'integer', minimum: 0, maximum: 3 }, { type: 'string' }],
}
const status = { type: 'string', enum: [...TASK_STATUSES], description: 'Task status' }

export const TOOLS: ToolDef[] = [
  {
    name: 'reply',
    description:
      'Send a message to your human. This is how they see and hear you when away from the terminal: it appears in the Switchboard web UI and phone app, and is read aloud when they are listening by voice. Keep it short and plain when their message came via="voice".',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('The message'),
        speak: bool('Read it aloud on the phone even if they are not in voice mode (for something that needs attention now).'),
      },
      required: ['text'],
    },
  },
  {
    name: 'send_message',
    description:
      'Message another Claude Code session by name (it arrives in that session as a channel event), or the human with to="user". Use list_sessions to see names.',
    inputSchema: {
      type: 'object',
      properties: { to: str('Session name, or "user"'), text: str('The message') },
      required: ['to', 'text'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List the Claude Code sessions Switchboard knows about: name, role, status (idle/busy/waiting/offline), folder, and what each is doing.',
    inputSchema: { type: 'object', properties: { include_archived: bool('Include archived sessions') } },
  },
  {
    name: 'search_history',
    description:
      'Search the permanent history: every message between the human and every session, between sessions, every session transcript (including what was typed straight into a terminal), and the task backlog. Use it whenever you are missing context ("what did we decide about X", "which session fixed Y", "what was that error"). Supports quotes, OR and -exclusions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Words to look for'),
        session: str('Only results involving this session'),
        sources: { type: 'array', items: { type: 'string', enum: ['message', 'transcript', 'task'] }, description: 'Limit to these kinds' },
        limit: int('Max results (default 15)'),
      },
      required: ['query'],
    },
  },
  {
    name: 'read_conversation',
    description:
      'Read messages in order: the thread with a session (or with="user" for everything the human sent or received). Use around_message_id to see the context of a search hit.',
    inputSchema: {
      type: 'object',
      properties: {
        with: str('Session name or "user"; omit for every message'),
        around_message_id: int('Center on this message id'),
        before_message_id: int('Older than this id'),
        limit: int('How many (default 30)'),
      },
    },
  },
  {
    name: 'tasks_list',
    description: 'List backlog tasks, by default the open ones, sorted by priority. Filter by project, status, priority, assignee or words.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project slug'),
        status: { type: 'array', items: status, description: 'Statuses to include' },
        priority: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 3 } },
        assignee: str('Session name or "user"'),
        query: str('Words in the title or body'),
        include_closed: bool('Include done and cancelled'),
      },
    },
  },
  {
    name: 'task_create',
    description: `Add a task to the backlog. Projects group tasks (default "inbox"); statuses: ${TASK_STATUSES.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: str('Short imperative title'),
        body: str('Details, acceptance criteria, links'),
        project: str('Project slug (create it with project_create first if new)'),
        priority,
        status,
        assignee: str('Session name that owns it, or "user"'),
        tags: { type: 'array', items: { type: 'string' } },
        parent_id: int('Make it a subtask of this task'),
      },
      required: ['title'],
    },
  },
  {
    name: 'task_update',
    description: 'Change a task (status, priority, assignee, title, body, project, tags) and/or add a comment to its history.',
    inputSchema: {
      type: 'object',
      properties: {
        id: int('Task id'),
        status,
        priority,
        assignee: str('Session name, "user", or "" to clear'),
        title: str('New title'),
        body: str('New body (replaces it)'),
        project: str('Move to this project'),
        tags: { type: 'array', items: { type: 'string' } },
        comment: str('A note for the history: what changed, what you found, why it is blocked'),
      },
      required: ['id'],
    },
  },
  {
    name: 'task_get',
    description: 'One task with its subtasks and full history of changes and comments.',
    inputSchema: { type: 'object', properties: { id: int('Task id') }, required: ['id'] },
  },
  {
    name: 'projects_list',
    description: 'List projects in the backlog with their open task counts and folders.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_create',
    description: 'Create (or update) a backlog project.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: str('lowercase-id'),
        name: str('Display name'),
        description: str('What it is'),
        path: str('Folder on disk where its code lives'),
      },
      required: ['slug'],
    },
  },
  {
    name: 'set_status',
    description: 'One short line of what you are doing right now ("running the test suite"); shown next to your name in the UI and app. Empty string clears it.',
    inputSchema: { type: 'object', properties: { text: str('Status line, under 100 characters') }, required: ['text'] },
  },
  {
    name: 'phone',
    description: [
      "Do something on the human's phone through the Switchboard app. Actions and their params:",
      'speak {text} - say it aloud now; stop_speaking {};',
      'notify {title, body} - a notification (falls back to a push when the app is closed);',
      'vibrate {pattern?: "short"|"long"|"success"|"warning"};',
      'open_url {url} - opens a link or app deep link (maps, tel:, sms:, a trading app...);',
      'get_location {} - current coordinates and address; get_battery {}; get_device_info {};',
      'clipboard_get {} / clipboard_set {text};',
      'calendar_list {days?} - upcoming events; calendar_create {title, start, end?, notes?, location?} (ISO times);',
      'compose_sms {to?, body} / compose_email {to?, subject?, body} - opens a draft for them to send.',
      'Reading location, clipboard or calendar only works if the human allowed it in the app settings.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...PHONE_ACTIONS] },
        params: { type: 'object', description: 'Parameters for the action' },
        device: str('Device id, if more than one phone is paired'),
      },
      required: ['action'],
    },
  },
]

export const ORCHESTRATOR_TOOLS: ToolDef[] = [
  {
    name: 'spawn_session',
    description:
      'Start a new Claude Code session in its own tmux session, with Switchboard connected. Waits for it to boot (answering the development-channel and folder-trust prompts) and returns when it can take messages, or shows the screen if something needs an answer. The optional prompt is its first message.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('lowercase-name (letters, digits, - and _)'),
        cwd: str('Folder to work in (absolute, or ~/...)'),
        prompt: str('First message to send it once ready'),
        description: str('What this session is for, shown in the UI'),
        model: str('Model alias or id, e.g. sonnet, opus, haiku'),
        permission_mode: { type: 'string', enum: ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions', 'manual'] },
        role: { type: 'string', enum: ['worker', 'orchestrator'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'stop_session',
    description: 'Exit a session (/exit, then close its tmux session). Its history stays searchable.',
    inputSchema: { type: 'object', properties: { name: str('Session name'), archive: bool('Also hide it from the session list') }, required: ['name'] },
  },
  {
    name: 'restart_session',
    description: 'Stop and start a session again, continuing the same conversation (or fresh=true for a new one). Use after changing its MCP servers or settings, or when it is wedged.',
    inputSchema: { type: 'object', properties: { name: str('Session name'), fresh: bool('Start a new conversation') }, required: ['name'] },
  },
  {
    name: 'interrupt_session',
    description: 'Press Escape in a session: stops what it is doing so it can take a new instruction.',
    inputSchema: { type: 'object', properties: { name: str('Session name') }, required: ['name'] },
  },
  {
    name: 'read_screen',
    description: "Read a session's terminal screen (what you would see attached to its tmux pane), plus `lines` of scrollback.",
    inputSchema: { type: 'object', properties: { name: str('Session name'), lines: int('Scrollback lines to include (default 0)') }, required: ['name'] },
  },
  {
    name: 'send_keys',
    description:
      'Type into a session\'s terminal: `text` literally (with enter=true to submit it), and/or `keys` by name (Enter, Escape, Up, Down, Tab, BSpace, C-c, or a digit to pick a menu option). For menus and questions on its screen; to give it work, prefer send_message. Tool approvals and safety questions (trust this folder, development channels) are refused: those are the human\'s to answer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Session name'),
        text: str('Text to type'),
        enter: bool('Press Enter after the text'),
        keys: { type: 'array', items: { type: 'string' }, description: 'Named keys, pressed in order after the text' },
      },
      required: ['name'],
    },
  },
]

type Args = Record<string, unknown>

const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : undefined)

export async function runTool(ctx: ToolContext, name: string, a: Args): Promise<string> {
  switch (name) {
    case 'reply': {
      const text = s(a.text).trim()
      if (!text) throw new Error('text is empty')
      const m = (await ctx.api('POST', '/api/messages', { from: ctx.session, to: 'user', body: text, speak: a.speak === true })) as Message
      return `Sent to the user (message ${m.id}).`
    }
    case 'send_message': {
      const to = s(a.to).trim()
      if (!to) throw new Error('to is required')
      if (to === ctx.session) throw new Error('That is you. Use reply to answer the user.')
      const m = (await ctx.api('POST', '/api/messages', { from: ctx.session, to, body: s(a.text) })) as Message
      if (to === 'user') return `Sent to the user (message ${m.id}).`
      const target = (await ctx.api('GET', `/api/sessions/${to}`)) as Session
      return `Sent to ${to} (message ${m.id}).${target.connected ? '' : ` ${to} is not connected right now; it gets the message as soon as it is.`}`
    }
    case 'list_sessions': {
      const sessions = (await ctx.api('GET', `/api/sessions${a.include_archived ? '?archived=1' : ''}`)) as Session[]
      if (!sessions.length) return 'No sessions yet.'
      return sessions
        .map(x => {
          const live = x.connected ? 'connected' : 'not connected'
          const bits = [`${x.name}${x.name === ctx.session ? ' (you)' : ''}`, x.role, `${x.status}, ${live}`]
          if (x.status_text) bits.push(`"${x.status_text}"`)
          if (x.cwd) bits.push(x.cwd)
          if (x.description) bits.push(`- ${x.description}`)
          return bits.join(' | ')
        })
        .join('\n')
    }
    case 'search_history': {
      const q = new URLSearchParams({ q: s(a.query), limit: String(n(a.limit) ?? 15) })
      if (a.session) q.set('session', s(a.session))
      if (Array.isArray(a.sources) && a.sources.length) q.set('sources', a.sources.join(','))
      const hits = (await ctx.api('GET', `/api/search?${q}`)) as SearchHit[]
      if (!hits.length) return `Nothing found for "${s(a.query)}". Try fewer or different words.`
      return hits.map(formatHit).join('\n\n')
    }
    case 'read_conversation': {
      const q = new URLSearchParams({ limit: String(n(a.limit) ?? 30) })
      if (a.with) q.set('with', s(a.with))
      if (n(a.around_message_id)) q.set('around', String(n(a.around_message_id)))
      if (n(a.before_message_id)) q.set('before', String(n(a.before_message_id)))
      const messages = (await ctx.api('GET', `/api/messages?${q}`)) as Message[]
      if (!messages.length) return 'No messages.'
      return messages.map(m => `#${m.id} ${m.created_at.slice(0, 16).replace('T', ' ')} ${m.from_id} → ${m.to_id}: ${m.body}`).join('\n')
    }
    case 'tasks_list': {
      const q = new URLSearchParams()
      if (a.project) q.set('project', s(a.project))
      if (Array.isArray(a.status) && a.status.length) q.set('status', a.status.join(','))
      if (Array.isArray(a.priority) && a.priority.length) q.set('priority', a.priority.join(','))
      if (a.assignee) q.set('assignee', s(a.assignee))
      if (a.query) q.set('q', s(a.query))
      if (a.include_closed) q.set('closed', '1')
      const tasks = (await ctx.api('GET', `/api/tasks?${q}`)) as Task[]
      if (!tasks.length) return 'No matching tasks.'
      return tasks.map(formatTask).join('\n')
    }
    case 'task_create': {
      const t = (await ctx.api('POST', '/api/tasks', { ...a, by: ctx.session })) as Task
      return `Created ${formatTask(t)}`
    }
    case 'task_update': {
      const { id, ...patch } = a
      if (!n(id)) throw new Error('id is required')
      const t = (await ctx.api('PATCH', `/api/tasks/${n(id)}`, { ...patch, by: ctx.session })) as Task
      return `Updated ${formatTask(t)}`
    }
    case 'task_get': {
      const t = (await ctx.api('GET', `/api/tasks/${n(a.id)}`)) as Task & {
        events: { actor: string; kind: string; body: string; data: Record<string, unknown>; created_at: string }[]
        subtasks: Task[]
      }
      const lines = [formatTask(t), t.body ? `\n${t.body}` : '']
      if (t.subtasks.length) lines.push('\nSubtasks:', ...t.subtasks.map(x => '  ' + formatTask(x)))
      if (t.events.length) {
        lines.push('\nHistory:')
        for (const e of t.events) {
          const what = e.kind === 'comment' ? e.body : e.kind === 'created' ? 'created' : Object.entries(e.data).map(([k, v]) => `${k}: ${JSON.stringify((v as { to: unknown }).to)}`).join(', ')
          lines.push(`  ${e.created_at.slice(0, 16).replace('T', ' ')} ${e.actor}: ${what}`)
        }
      }
      return lines.filter(Boolean).join('\n')
    }
    case 'projects_list': {
      const projects = (await ctx.api('GET', '/api/projects')) as { slug: string; name: string; description: string; path: string | null; open_tasks: number }[]
      return projects.map(p => `${p.slug} (${p.name}) - ${p.open_tasks} open${p.path ? ` - ${p.path}` : ''}${p.description ? ` - ${p.description}` : ''}`).join('\n')
    }
    case 'project_create': {
      const p = (await ctx.api('POST', '/api/projects', a)) as { slug: string }
      return `Project ${p.slug} is ready.`
    }
    case 'set_status': {
      await ctx.api('PATCH', `/api/sessions/${ctx.session}`, { status_text: s(a.text).slice(0, 100) })
      return 'Status updated.'
    }
    case 'phone': {
      const r = (await ctx.api('POST', '/api/devices/actions', {
        action: s(a.action),
        params: a.params && typeof a.params === 'object' ? a.params : {},
        device: a.device || undefined,
      })) as { result: unknown }
      return typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? 'done', null, 2)
    }
    // --- orchestrator ---------------------------------------------------------
    case 'spawn_session': {
      const r = (await ctx.api('POST', '/api/sessions', { ...a, by: ctx.session })) as { session: Session; ready: boolean; note: string; screen?: string }
      return [`${r.session.name}: ${r.note}`, r.screen ? `\nScreen:\n${r.screen}` : ''].join('')
    }
    case 'stop_session': {
      const x = (await ctx.api('POST', `/api/sessions/${s(a.name)}/stop`, { archive: a.archive === true })) as Session
      return `${x.name} stopped.`
    }
    case 'restart_session': {
      const r = (await ctx.api('POST', `/api/sessions/${s(a.name)}/restart`, { fresh: a.fresh === true, by: ctx.session })) as {
        session: Session
        note: string
        screen?: string
      }
      return [`${r.session.name}: ${r.note}`, r.screen ? `\nScreen:\n${r.screen}` : ''].join('')
    }
    case 'interrupt_session':
      await ctx.api('POST', `/api/sessions/${s(a.name)}/interrupt`, {})
      return `Pressed Escape in ${s(a.name)}.`
    case 'read_screen': {
      const r = (await ctx.api('GET', `/api/sessions/${s(a.name)}/screen?lines=${n(a.lines) ?? 0}`)) as { screen: string }
      return r.screen || '(blank screen)'
    }
    case 'send_keys': {
      await ctx.api('POST', `/api/sessions/${s(a.name)}/keys`, {
        text: a.text === undefined ? undefined : s(a.text),
        enter: a.enter === true,
        keys: Array.isArray(a.keys) ? a.keys.map(String) : undefined,
        by: ctx.session,
      })
      return 'Done. Use read_screen to see the result.'
    }
  }
  throw new Error(`Unknown tool ${name}`)
}

function formatTask(t: Task): string {
  const bits = [`#${t.id} [P${t.priority} ${PRIORITY_LABELS[t.priority] ?? ''}] [${t.status}] ${t.title}`, `(${t.project}`]
  if (t.assignee) bits.push(`@${t.assignee}`)
  if (t.tags?.length) bits.push(t.tags.map(x => `#${x}`).join(' '))
  return bits.join(' ') + ')'
}

function formatHit(h: SearchHit): string {
  const when = String(h.created_at).slice(0, 16).replace('T', ' ')
  const snippet = h.snippet.replace(/\[\[/g, '«').replace(/\]\]/g, '»')
  if (h.source === 'task') return `task #${h.ref} ${when} "${h.title}": ${snippet}`
  const who = `${h.from_id ?? '?'} → ${h.to_id ?? '?'}`
  const ref = h.source === 'message' ? `message #${h.ref}` : `transcript of ${h.session ?? '?'}`
  return `${ref} ${when} ${who}: ${snippet}`
}
