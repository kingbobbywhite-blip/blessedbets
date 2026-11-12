import crypto from 'node:crypto'
import type pg from 'pg'
import type {
  ChannelToHub,
  HubToUi,
  Message,
  PermissionRequest,
  PttAction,
  Session,
  UiToHub,
} from '../shared/protocol.ts'
import { SYSTEM, USER, isValidName } from '../shared/protocol.ts'
import type { Bus, ChannelClient, UiClient } from './bus.ts'
import type { Config } from './config.ts'
import { sendPush, type PushMessage } from './push.ts'
import * as store from './store.ts'
import { BadRequest, NotFound } from './store.ts'
import { readTranscript } from './transcripts.ts'
import { parseUtterance, type Intent } from './voice.ts'

export type Log = (msg: string) => void

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * The hub's behaviour, independent of HTTP: who gets which message, what
 * happens when a session connects, how approvals and phone actions travel.
 */
export class Hub {
  /** Sessions whose startup dialogs are behind them, so pushed messages will land. */
  readonly ready = new Set<string>()
  private readonly calls = new Map<string, PendingCall>()
  private readonly delivering = new Set<string>()
  private readonly lastNotice = new Map<string, number>()
  readonly startedAt = Date.now()

  readonly cfg: Config
  readonly db: pg.Pool
  readonly bus: Bus
  readonly log: Log

  constructor(cfg: Config, db: pg.Pool, bus: Bus, log: Log) {
    this.cfg = cfg
    this.db = db
    this.bus = bus
    this.log = log
  }

  // -------------------------------------------------------------------------
  // Sessions

  withLive(s: Session): Session {
    return { ...s, connected: this.bus.isConnected(s.name) }
  }

  async sessions(includeArchived = false): Promise<Session[]> {
    return (await store.listSessions(this.db, { includeArchived })).map(s => this.withLive(s))
  }

  async publishSession(name: string): Promise<Session | null> {
    const s = (await store.listSessions(this.db, { includeArchived: true })).find(x => x.name === name)
    if (!s) return null
    const live = this.withLive(s)
    this.emit({ type: 'session', session: live })
    return live
  }

  async setStatus(name: string, status: Session['status'], statusText?: string): Promise<void> {
    const before = await store.getSession(this.db, name)
    if (!before) return
    if (before.status === status && (statusText === undefined || statusText === before.status_text)) return
    await store.updateSession(this.db, name, statusText === undefined ? { status } : { status, status_text: statusText })
    if (before.status === 'waiting' && (status === 'idle' || status === 'busy')) {
      // The terminal moved on (someone answered there), so the copy on your phone is stale.
      await this.expireApprovals(name)
    }
    await this.publishSession(name)
  }

  emit(event: HubToUi) {
    this.bus.broadcast(event)
  }

  // -------------------------------------------------------------------------
  // Messages

  /**
   * Store a message, show it everywhere, and push it into the recipient's
   * session (now if its channel is connected, otherwise when it next connects).
   */
  async send(input: store.NewMessage): Promise<Message> {
    const body = input.body?.trim()
    if (!body) throw new BadRequest('Message is empty')
    const to = input.to_id
    if (to === input.from_id) throw new BadRequest('A message needs a different recipient than its sender')
    if (to !== USER) {
      const target = await store.getSession(this.db, to)
      if (!target) throw new NotFound(`No session named "${to}". Running sessions: ${(await this.sessionNames()).join(', ') || 'none'}`)
    }
    if (input.from_id !== USER && input.from_id !== SYSTEM && !(await store.getSession(this.db, input.from_id))) {
      throw new BadRequest(`Unknown sender "${input.from_id}"`)
    }
    const message = await store.insertMessage(this.db, { ...input, body })
    this.emit({ type: 'message', message })
    if (to === USER) {
      if (input.from_id !== USER) void this.notifyUser(message)
    } else {
      await this.deliver(to)
    }
    return message
  }

  async sessionNames(): Promise<string[]> {
    return (await store.listSessions(this.db)).map(s => s.name)
  }

  /** Push every undelivered message for `session` into it, oldest first. */
  async deliver(session: string): Promise<void> {
    if (this.delivering.has(session)) return
    this.delivering.add(session)
    try {
      const s = await store.getSession(this.db, session)
      if (!s) return
      if (s.delivery === 'keys') {
        await this.deliverByKeys?.(s)
        return
      }
      if (!this.bus.isConnected(session) || !this.ready.has(session)) return
      for (const message of await store.undeliveredFor(this.db, session)) {
        if (!this.bus.sendToChannel(session, { type: 'deliver', message })) break
      }
    } finally {
      this.delivering.delete(session)
    }
  }

  /** Set by the session manager: types messages into the terminal for sessions without a channel. */
  deliverByKeys?: (s: Session) => Promise<void>

  async onAck(session: string, id: number): Promise<void> {
    const deliveredAt = await store.markDelivered(this.db, id)
    if (deliveredAt) this.emit({ type: 'message_update', id, delivered_at: deliveredAt })
    await store.updateSession(this.db, session, { last_seen_at: new Date().toISOString() }).catch(() => {})
  }

  async markRead(session: string): Promise<void> {
    const ids = await store.markRead(this.db, session)
    const now = new Date().toISOString()
    for (const id of ids) this.emit({ type: 'message_update', id, read_at: now })
    if (ids.length) await this.publishSession(session)
  }

  // -------------------------------------------------------------------------
  // Channel servers (one per Claude Code session)

  async channelHello(ws: ChannelClient['ws'], hello: Extract<ChannelToHub, { type: 'hello' }>): Promise<ChannelClient> {
    if (!isValidName(hello.session)) throw new BadRequest(`Invalid session name "${hello.session}"`)
    const existing = await store.getSession(this.db, hello.session)
    const { client } = this.bus.setChannel(hello.session, ws)
    const session = await store.upsertSession(this.db, hello.session, {
      role: existing?.role === 'orchestrator' || hello.role === 'orchestrator' ? 'orchestrator' : 'worker',
      cwd: hello.cwd || existing?.cwd || null,
      last_seen_at: new Date().toISOString(),
      archived_at: null,
      status: existing && existing.status !== 'offline' && existing.status !== 'exited' ? existing.status : 'idle',
    })
    this.bus.sendToChannel(hello.session, { type: 'welcome', session: this.withLive(session) })
    // Sessions the hub did not start answered their own startup dialogs before the channel could connect.
    if (!session.managed || session.status !== 'starting') this.ready.add(hello.session)
    await this.publishSession(hello.session)
    await this.deliver(hello.session)
    this.log(`channel connected: ${hello.session} (${hello.cwd})`)
    return client
  }

  async channelClosed(client: ChannelClient): Promise<void> {
    if (!this.bus.removeChannel(client)) return
    const s = await store.getSession(this.db, client.session)
    if (s && !s.managed) {
      await store.updateSession(this.db, client.session, { status: 'offline' })
      this.ready.delete(client.session)
    }
    await this.publishSession(client.session)
    this.log(`channel disconnected: ${client.session}`)
  }

  async onChannelEvent(client: ChannelClient, event: ChannelToHub): Promise<void> {
    switch (event.type) {
      case 'ack':
        await this.onAck(client.session, event.id)
        break
      case 'permission_request':
        await this.permissionRequested(client.session, event)
        break
      case 'ping':
        this.bus.sendToChannel(client.session, { type: 'pong' })
        break
      case 'hello':
        break
    }
  }

  // -------------------------------------------------------------------------
  // Tool approvals relayed from a session

  async permissionRequested(
    session: string,
    req: { request_id: string; tool_name: string; description: string; input_preview: string },
  ): Promise<PermissionRequest> {
    const request = await store.insertPermission(this.db, { session, ...req })
    this.emit({ type: 'permission', request })
    await this.setStatus(session, 'waiting')
    const said = `${session} wants to use ${friendlyTool(req.tool_name)}: ${req.description || req.tool_name}.`
    void this.pushToPhones({
      title: `${session} needs approval`,
      body: `${req.tool_name}: ${req.description}`.slice(0, 180),
      data: { kind: 'permission', permission_id: request.id, session, speak: `${said} Approve or deny?` },
      categoryId: 'permission',
    })
    return request
  }

  async decide(id: number, behavior: 'allow' | 'deny', by: string): Promise<PermissionRequest> {
    const request = await store.decidePermission(this.db, id, behavior, by)
    if (!request) {
      const existing = await store.getPermission(this.db, id)
      if (!existing) throw new NotFound(`No approval #${id}`)
      throw new BadRequest(`Approval #${id} was already ${existing.status === 'expired' ? 'answered in the terminal' : existing.status}`)
    }
    const sent = this.bus.sendToChannel(request.session, {
      type: 'permission_verdict',
      request_id: request.request_id,
      behavior,
    })
    this.emit({ type: 'permission', request })
    // Claude Code carries on either way (a denial is reported to the model), so the session is working again.
    const stillOpen = (await store.pendingPermissions(this.db)).some(p => p.session === request.session)
    if (!stillOpen) await this.setStatus(request.session, 'busy')
    await this.send({
      from_id: SYSTEM,
      to_id: USER,
      kind: 'permission',
      body: `${behavior === 'allow' ? 'Allowed' : 'Denied'} ${request.session}: ${request.tool_name} — ${request.description}`,
      meta: { session: request.session, permission_id: request.id, delivered: sent },
    })
    return request
  }

  async expireApprovals(session: string): Promise<void> {
    for (const request of await store.expirePermissions(this.db, session)) this.emit({ type: 'permission', request })
  }

  // -------------------------------------------------------------------------
  // The phone: push-to-talk, phone actions, notifications

  /** A Flic press (or any HTTP call) asking the phone to start or stop listening. */
  ptt(action: PttAction, opts: { device?: string | null; target?: string | null } = {}): UiClient | null {
    const client = this.bus.voiceClient(opts.device)
    if (!client) return null
    this.bus.sendToUi(client, { type: 'ptt', action, ...(opts.target ? { target: opts.target } : {}) })
    return client
  }

  /** Ask the phone app to do something (speak, get the location, open a link...) and wait for the answer. */
  async deviceCall(
    action: string,
    params: Record<string, unknown>,
    opts: { device?: string | null; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const client = this.bus.actionClient(opts.device)
    if (!client) {
      if (action === 'notify' || action === 'speak') {
        const delivered = await this.pushToPhones({
          title: String(params.title ?? 'Claude'),
          body: String(params.body ?? params.text ?? ''),
          data: { kind: 'notify', speak: action === 'speak' ? String(params.text ?? '') : undefined },
        })
        if (delivered) return { delivered: 'push notification (app not connected)' }
      }
      throw new BadRequest('No phone is connected. Open the Switchboard app (walk mode keeps it connected in your pocket).')
    }
    const id = crypto.randomUUID()
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30_000, 1000), 120_000)
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id)
        reject(new Error(`The phone did not answer within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.calls.set(id, { resolve, reject, timer })
    })
    this.bus.sendToUi(client, { type: 'device_command', id, action, params })
    return result
  }

  onUiEvent(client: UiClient, event: UiToHub): void {
    client.lastActive = Date.now()
    if (event.type === 'device_result') {
      const call = this.calls.get(event.id)
      if (!call) return
      clearTimeout(call.timer)
      this.calls.delete(event.id)
      if (event.ok) call.resolve(event.result ?? null)
      else call.reject(new Error(event.error || 'The phone could not do that'))
    } else if (event.type === 'state') {
      if (event.voice !== undefined) client.voice = event.voice
      if (event.foreground !== undefined) client.foreground = event.foreground
      if (event.walk !== undefined) client.walk = event.walk
      if (event.target !== undefined) client.target = event.target
      if (client.deviceId) void store.touchDevice(this.db, client.deviceId).catch(() => {})
    } else if (event.type === 'ping') {
      this.bus.sendToUi(client, { type: 'pong' })
    }
  }

  /**
   * A session wrote to you. Connected screens already have it; a phone that is
   * asleep or closed gets a push notification instead.
   */
  async notifyUser(message: Message): Promise<void> {
    const awake = new Set(
      [...this.bus.ui].filter(c => c.deviceId && c.ws.readyState === 1 && (c.foreground || c.walk)).map(c => c.deviceId!),
    )
    await this.pushToPhones(
      {
        title: message.from_id === SYSTEM ? 'Switchboard' : message.from_id,
        body: message.body.slice(0, 240),
        data: { kind: 'message', message_id: message.id, session: message.from_id },
        categoryId: 'message',
      },
      awake,
    )
  }

  /** Returns whether any phone had a push token to send to. */
  async pushToPhones(push: Omit<PushMessage, 'to'>, skip: Set<string> = new Set()): Promise<boolean> {
    const devices = (await store.listDevices(this.db)).filter(d => d.push_token && !skip.has(d.id))
    if (!devices.length) return false
    await sendPush(
      devices.map(d => ({ ...push, to: d.push_token! })),
      this.cfg.expoAccessToken,
      this.log,
    )
    return true
  }

  // -------------------------------------------------------------------------
  // Voice

  /**
   * Something you said. Approve/deny answers a waiting tool approval, "switch to
   * X" changes who you're talking to, anything else becomes a message.
   */
  async utterance(
    text: string,
    opts: { to?: string | null; device?: string | null; via?: string },
  ): Promise<{ intent: Intent; message?: Message; permission?: PermissionRequest; text: string }> {
    const target = opts.to || this.cfg.orchestrator
    const sessions = await this.sessionNames()
    const pending = await store.pendingPermissions(this.db, 15)
    const intent = parseUtterance(text, { target, sessions, permissionPending: pending.length > 0 })
    if (intent.kind === 'permission') {
      // "Approve" answers the approval you heard last.
      const latest = pending.at(-1)!
      const permission = await this.decide(latest.id, intent.behavior, `voice${opts.device ? ':' + opts.device : ''}`)
      return { intent, permission, text }
    }
    if (intent.kind === 'message') {
      const message = await this.send({
        from_id: USER,
        to_id: intent.to,
        body: intent.body,
        kind: 'voice',
        meta: { via: opts.via ?? 'voice', ...(opts.device ? { device: opts.device } : {}) },
      })
      return { intent, message, text }
    }
    return { intent, text }
  }

  // -------------------------------------------------------------------------
  // Claude Code hooks and transcripts

  async hook(event: string, session: string, payload: Record<string, unknown>): Promise<void> {
    if (!isValidName(session)) return
    const existing = await store.getSession(this.db, session)
    if (!existing) await store.upsertSession(this.db, session, { cwd: String(payload.cwd ?? '') || null })
    const patch: Parameters<typeof store.updateSession>[2] = { last_seen_at: new Date().toISOString() }
    if (typeof payload.session_id === 'string') patch.claude_session_id = payload.session_id
    if (typeof payload.transcript_path === 'string') patch.transcript_path = payload.transcript_path
    await store.updateSession(this.db, session, patch)

    switch (event) {
      case 'SessionStart':
        await this.setStatus(session, 'idle')
        break
      case 'UserPromptSubmit':
        await this.setStatus(session, 'busy')
        break
      case 'Stop':
      case 'SubagentStop':
        if (event === 'Stop') await this.setStatus(session, 'idle')
        if (typeof payload.transcript_path === 'string') await this.ingest(session, payload.transcript_path)
        break
      case 'Notification': {
        const text = String(payload.message ?? '').trim()
        if (/permission/i.test(text)) {
          await this.setStatus(session, 'waiting')
          // With a channel connected the approval itself arrives through it, with the details.
          if (this.bus.isConnected(session)) break
        } else if (/waiting for your input/i.test(text)) {
          break // Claude Code says this every time a session sits idle; the reply already told you.
        }
        const key = `${session}:${text}`
        const last = this.lastNotice.get(key) ?? 0
        if (text && Date.now() - last > 5 * 60_000) {
          this.lastNotice.set(key, Date.now())
          await this.send({ from_id: SYSTEM, to_id: USER, kind: 'notification', body: `${session}: ${text}`, meta: { session } })
        }
        break
      }
      case 'SessionEnd':
        if (typeof payload.transcript_path === 'string') await this.ingest(session, payload.transcript_path)
        await this.setStatus(session, existing?.managed ? 'exited' : 'offline')
        this.ready.delete(session)
        break
    }
    await this.publishSession(session)
  }

  /** Copy new lines of a session's transcript into Postgres, and mark pushed messages Claude has seen. */
  async ingest(session: string | null, file: string): Promise<number> {
    const { rows } = await this.db.query<{ bytes_read: number }>('select bytes_read from transcript_files where path = $1', [file])
    const offset = rows[0]?.bytes_read ?? 0
    let chunk
    try {
      chunk = await readTranscript(file, offset)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`transcript ${file}: ${(err as Error).message}`)
      return 0
    }
    if (chunk.consumed === offset) return 0
    const client = await this.db.connect()
    let inserted = 0
    try {
      await client.query('begin')
      for (const e of chunk.entries) {
        const r = await client.query(
          `insert into transcript_entries (session, claude_session_id, uuid, role, body, created_at)
           values ($1, $2, $3, $4, $5, $6) on conflict (uuid) do nothing`,
          [session, e.claude_session_id, e.uuid, e.role, e.body, e.created_at],
        )
        inserted += r.rowCount ?? 0
      }
      await client.query(
        `insert into transcript_files (path, session, bytes_read, updated_at) values ($1, $2, $3, now())
         on conflict (path) do update set bytes_read = excluded.bytes_read, session = coalesce(excluded.session, transcript_files.session),
           updated_at = now()`,
        [file, session, chunk.consumed],
      )
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
    for (const { id, seen_at } of await store.markSeen(this.db, chunk.seenMessageIds)) {
      this.emit({ type: 'message_update', id, seen_at })
    }
    return inserted
  }

  /** Re-read the transcripts of sessions that were active recently (catches what you typed in a terminal). */
  async ingestRecent(): Promise<void> {
    const { rows } = await this.db.query<{ name: string; transcript_path: string }>(
      `select name, transcript_path from sessions where transcript_path is not null and archived_at is null
         and coalesce(last_seen_at, created_at) > now() - interval '2 days'`,
    )
    for (const r of rows) await this.ingest(r.name, r.transcript_path).catch(err => this.log(`ingest ${r.name}: ${err.message}`))
  }
}

function friendlyTool(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  return m ? `${m[2]} from ${m[1]}` : name
}
