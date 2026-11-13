#!/usr/bin/env node
/**
 * The Switchboard channel: an MCP server Claude Code starts inside each
 * session. It keeps a WebSocket open to the hub, so anything you send from the
 * web UI, the phone, or another session is pushed straight into the session as
 * a <channel source="switchboard"> event (no polling, no tool call needed),
 * and it gives Claude the tools to answer, message other sessions, search the
 * history, keep the backlog, use your phone, and (for the orchestrator) run
 * the other sessions.
 *
 * stdout belongs to MCP. Log to stderr only.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ChannelToHub, HubToChannel, Message } from '../shared/protocol.ts'
import { NAME_RE } from '../shared/protocol.ts'
import { TOOLS, ORCHESTRATOR_TOOLS, runTool, type ToolContext } from './tools.ts'

const VERSION = '0.1.0'
const env = process.env
const log = (...args: unknown[]) => console.error('[switchboard-channel]', ...args)

const HUB_URL = (env.SWITCHBOARD_URL || 'http://127.0.0.1:7700').replace(/\/+$/, '')
const TOKEN = env.SWITCHBOARD_TOKEN || readToken()
const SESSION = env.SWITCHBOARD_SESSION || deriveSessionName()
const ORCHESTRATOR = env.SWITCHBOARD_ORCHESTRATOR || 'boss'
const ROLE: 'orchestrator' | 'worker' =
  env.SWITCHBOARD_ROLE === 'orchestrator' || (!env.SWITCHBOARD_ROLE && SESSION === ORCHESTRATOR) ? 'orchestrator' : 'worker'
const RELAY_PERMISSIONS = env.SWITCHBOARD_PERMISSION_RELAY !== '0'

function readToken(): string {
  const dir = env.SWITCHBOARD_DATA_DIR || path.join(os.homedir(), '.switchboard')
  try {
    return fs.readFileSync(path.join(dir, 'token'), 'utf8').trim()
  } catch {
    return ''
  }
}

/** A session started by hand: name it after its tmux session, else its project folder. */
function deriveSessionName(): string {
  const prefix = env.SWITCHBOARD_TMUX_PREFIX || 'sb-'
  if (env.TMUX) {
    try {
      const name = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8', timeout: 2000 }).trim()
      const bare = name.startsWith(prefix) ? name.slice(prefix.length) : name
      const slug = slugify(bare)
      if (NAME_RE.test(slug)) return slug
    } catch {
      // not reachable; fall through
    }
  }
  return slugify(path.basename(env.CLAUDE_PROJECT_DIR || process.cwd())) || 'session'
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40)
}

const instructions = [
  `You are connected to Switchboard as the Claude Code session "${SESSION}" (${ROLE}).`,
  `Messages arrive as <channel source="switchboard" from="..." message_id="..." kind="..." via="...">text</channel>.`,
  `Where channels are not available they are typed in instead, as a line starting [switchboard from="..." via="..." id="..."]. Treat that exactly like a channel message from that sender.`,
  `- from="user" is your human. They are often away from the terminal (walking, on their phone) and cannot see your terminal output: always answer them with the reply tool. Text you only write in the terminal never reaches them.`,
  `- via="voice" means they spoke it and will hear your reply read aloud: answer in a few plain spoken sentences, with no markdown, tables, code blocks, file paths or long lists; offer details if they want them.`,
  `- from="<session name>" is another Claude Code session. Answer it with send_message(to="<that name>"), not reply.`,
  `- from="system" is the hub itself (startup results, approvals); no answer needed.`,
  `For anything that takes more than a minute, reply first with a one-line acknowledgement, then reply again when it is done or blocked.`,
  `Before saying you don't know or don't remember something, call search_history: it holds every message between the human and every session, and every session's transcript.`,
  `Keep the shared backlog current: task_create for new work, task_update when you start, get blocked, or finish (with a comment).`,
  `Use set_status for a short line of what you are doing right now; it shows next to your name on the human's phone.`,
  ROLE === 'orchestrator'
    ? `You are the orchestrator: start, steer and stop the other sessions with spawn_session, send_message, read_screen, send_keys, interrupt_session, restart_session and stop_session.`
    : `The orchestrator is "${ORCHESTRATOR}": tell it with send_message when you finish a task, get blocked, or need a decision.`,
].join('\n')

const mcp = new Server(
  { name: 'switchboard', version: VERSION },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        ...(RELAY_PERMISSIONS ? { 'claude/channel/permission': {} } : {}),
      },
      tools: {},
    },
    instructions,
  },
)

const ctx: ToolContext = {
  hubUrl: HUB_URL,
  token: TOKEN,
  session: SESSION,
  role: ROLE,
  async api(method, pathname, body) {
    const res = await fetch(`${HUB_URL}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(pathname.startsWith('/api/sessions') && method === 'POST' ? 150_000 : 60_000),
    })
    const text = await res.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // plain text
    }
    if (!res.ok) {
      const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : text
      throw new Error(msg || `${res.status} ${res.statusText}`)
    }
    return data
  },
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...TOOLS, ...(ROLE === 'orchestrator' ? ORCHESTRATOR_TOOLS : [])].map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name
  const allowed = [...TOOLS, ...(ROLE === 'orchestrator' ? ORCHESTRATOR_TOOLS : [])].some(t => t.name === name)
  if (!allowed) return { content: [{ type: 'text' as const, text: `Unknown tool ${name}` }], isError: true }
  try {
    const text = await runTool(ctx, name, (req.params.arguments ?? {}) as Record<string, unknown>)
    return { content: [{ type: 'text' as const, text }] }
  } catch (err) {
    const hint = /fetch failed|ECONNREFUSED/i.test(String((err as Error).message))
      ? ` (the Switchboard hub at ${HUB_URL} is not reachable; start it with "switchboard up")`
      : ''
    return { content: [{ type: 'text' as const, text: `${(err as Error).message}${hint}` }], isError: true }
  }
})

// Claude Code asks the human to approve a tool call: relay it to the phone.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})
if (RELAY_PERMISSIONS) {
  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    hubSend({ type: 'permission_request', ...params })
  })
}

// ---------------------------------------------------------------------------
// Hub connection

let ws: WebSocket | null = null
let backoff = 1000
let closed = false
const outbox: ChannelToHub[] = []
const delivered = new Set<number>()

function hubSend(event: ChannelToHub) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
  else if (event.type === 'permission_request') outbox.push(event)
}

async function onHubEvent(event: HubToChannel) {
  if (event.type === 'deliver') {
    const m = event.message
    if (!delivered.has(m.id)) {
      await pushToClaude(m)
      delivered.add(m.id)
      if (delivered.size > 5000) delivered.clear()
    }
    hubSend({ type: 'ack', id: m.id })
  } else if (event.type === 'permission_verdict') {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: event.request_id, behavior: event.behavior },
    })
  }
}

async function pushToClaude(m: Message) {
  const meta: Record<string, string> = {
    from: m.from_id,
    message_id: String(m.id),
    kind: m.kind,
    sent_at: m.created_at,
  }
  const via = typeof m.meta?.via === 'string' ? m.meta.via : m.kind === 'voice' ? 'voice' : ''
  if (via && /^[a-z0-9_-]+$/i.test(via)) meta.via = via
  await mcp.notification({ method: 'notifications/claude/channel', params: { content: m.body, meta } })
}

function connect() {
  if (closed) return
  const url = new URL('/ws', HUB_URL.replace(/^http/, 'ws'))
  url.searchParams.set('role', 'channel')
  url.searchParams.set('session', SESSION)
  url.searchParams.set('token', TOKEN)
  const socket = new WebSocket(url)
  ws = socket
  let pingTimer: NodeJS.Timeout | null = null
  let retrying = false
  // Node's WebSocket reports a refused connection with "error" and no "close",
  // so either one schedules the next attempt (once per socket).
  const retry = (code?: number) => {
    if (pingTimer) clearInterval(pingTimer)
    if (ws === socket) ws = null
    if (closed || retrying) return
    retrying = true
    if (code === 4000) log('another connection took over this session name')
    // Short ceiling: the hub restarts whenever it is updated, and sessions should be back within seconds.
    const delay = Math.min(backoff, 5_000)
    backoff = Math.min(backoff * 2, 5_000)
    setTimeout(connect, delay)
  }
  socket.addEventListener('open', () => {
    backoff = 1000
    socket.send(
      JSON.stringify({
        type: 'hello',
        session: SESSION,
        role: ROLE,
        cwd: env.CLAUDE_PROJECT_DIR || process.cwd(),
        pid: process.pid,
        claude_pid: process.ppid,
        version: VERSION,
      } satisfies ChannelToHub),
    )
    while (outbox.length) socket.send(JSON.stringify(outbox.shift()))
    pingTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'ping' })), 30_000)
    log(`connected to ${HUB_URL} as ${SESSION}`)
  })
  socket.addEventListener('message', ev => {
    let event: HubToChannel
    try {
      event = JSON.parse(String(ev.data))
    } catch {
      return
    }
    onHubEvent(event).catch(err => log('handling hub event:', err))
  })
  socket.addEventListener('close', ev => retry(ev.code))
  socket.addEventListener('error', () => {
    retry()
    try {
      socket.close()
    } catch {
      // already closed
    }
  })
}

// Only start taking messages once Claude Code has finished the MCP handshake.
mcp.oninitialized = () => connect()

/**
 * Leave with the session. The MCP stdio transport does not notice its pipe
 * closing, so watch stdin (and the parent process) ourselves: a channel that
 * outlived its Claude Code session would keep showing it as online.
 */
function shutdown() {
  if (closed) return
  closed = true
  try {
    ws?.close()
  } catch {
    // already closed
  }
  setTimeout(() => process.exit(0), 50)
}
mcp.onclose = shutdown
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
const parentPid = process.ppid
setInterval(() => {
  if (process.ppid !== parentPid) shutdown()
}, 3000)

await mcp.connect(new StdioServerTransport())
if (!TOKEN) log('no token found: set SWITCHBOARD_TOKEN or run the hub once so ~/.switchboard/token exists')
