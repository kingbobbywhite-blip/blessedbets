import fs from 'node:fs'
import path from 'node:path'
import type { Session, SessionRole } from '../shared/protocol.ts'
import { SYSTEM, USER, isValidName } from '../shared/protocol.ts'
import { detectDialog, isToolApproval, movesTo, screenStatus } from './dialogs.ts'
import type { Hub } from './hub.ts'
import * as store from './store.ts'
import { BadRequest, Forbidden, NotFound } from './store.ts'
import { Tmux, sleep } from './tmux.ts'
import { expandHome, findClaude } from './config.ts'

export interface SpawnOptions {
  name: string
  cwd?: string | null
  role?: SessionRole
  description?: string
  prompt?: string | null
  model?: string | null
  permission_mode?: string | null
  /** Continue this Claude Code conversation (its session id) instead of starting fresh. */
  resume?: string | null
  extra_args?: string[]
  /** Who asked, for the thread ("user" or a session name). */
  by?: string
  /** Wait for startup to finish before returning. Default true. */
  wait?: boolean
  /** Restarting a session keeps the settings it was first started with, whoever asks. */
  inherited?: boolean
}

export interface SpawnResult {
  session: Session
  ready: boolean
  /** What the hub did or what is in the way, in a sentence. */
  note: string
  screen?: string
}

export const CHANNEL_SERVER_NAME = 'switchboard'

/**
 * Starts, stops and steers Claude Code sessions, each in its own tmux session
 * named <prefix><name> (sb-boss, sb-api, ...). Every session gets the
 * switchboard channel server and the hooks that report its status.
 */
export class SessionManager {
  private poller: NodeJS.Timeout | null = null
  private polling = false
  private readonly spawning = new Set<string>()
  /** Sessions whose startup the hub is watching right now. */
  private readonly starting = new Set<string>()

  readonly hub: Hub
  readonly tmux: Tmux

  constructor(hub: Hub, tmux: Tmux) {
    this.hub = hub
    this.tmux = tmux
    hub.deliverByKeys = s => this.deliverByKeys(s)
  }

  get cfg() {
    return this.hub.cfg
  }

  tmuxName(name: string): string {
    return `${this.cfg.tmuxPrefix}${name}`
  }

  // -------------------------------------------------------------------------
  // Files Claude Code is started with

  /** The MCP config naming the channel server, one per session so it knows who it is. */
  writeMcpConfig(name: string, role: SessionRole): string {
    const dir = path.join(this.cfg.dataDir, 'sessions')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `${name}.mcp.json`)
    const config = {
      mcpServers: {
        [CHANNEL_SERVER_NAME]: {
          type: 'stdio',
          command: process.execPath,
          args: [path.join(this.cfg.packageRoot, 'src', 'channel', 'main.ts')],
          env: {
            SWITCHBOARD_URL: this.localUrl(),
            SWITCHBOARD_TOKEN: this.cfg.token,
            SWITCHBOARD_SESSION: name,
            SWITCHBOARD_ROLE: role,
          },
        },
      },
    }
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 })
    return file
  }

  /** Hooks that tell the hub when a session starts, works, stops, or needs you. */
  writeSettings(): string {
    const file = path.join(this.cfg.dataDir, 'claude-settings.json')
    const command = `${q(process.execPath)} ${q(path.join(this.cfg.packageRoot, 'src', 'hook.ts'))}`
    const entry = [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
    const settings = {
      // Switchboard's own tools (reply, send_message, the backlog, ...) never ask: a session that had
      // to wait for an approval before it could answer you would be no use on a walk. Everything
      // else it wants to do (Bash, edits, web) still asks, and that question goes to your phone.
      permissions: { allow: [`mcp__${CHANNEL_SERVER_NAME}`] },
      hooks: {
        SessionStart: entry,
        UserPromptSubmit: entry,
        Stop: entry,
        Notification: entry,
        SessionEnd: entry,
      },
    }
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 })
    return file
  }

  localUrl(): string {
    const host = this.cfg.host === '0.0.0.0' || this.cfg.host === '::' ? '127.0.0.1' : this.cfg.host
    return `http://${host.includes(':') ? `[${host}]` : host}:${this.cfg.port}`
  }

  claudeCommand(s: { name: string; role: SessionRole; model?: string | null; permission_mode?: string | null; resume?: string | null; extra_args?: string[] }): string[] {
    const args = [
      findClaude(this.cfg),
      '--mcp-config',
      this.writeMcpConfig(s.name, s.role),
      '--settings',
      this.writeSettings(),
      // The orchestrator looks after Switchboard itself (the phone app, the web UI), wherever it works from.
      ...(s.role === 'orchestrator' ? ['--add-dir', this.cfg.packageRoot] : []),
      '--dangerously-load-development-channels',
      `server:${CHANNEL_SERVER_NAME}`,
      '--name',
      s.name,
      '--append-system-prompt',
      identityPrompt(s.name, s.role, this.cfg.orchestrator),
    ]
    if (s.model) args.push('--model', s.model)
    // "default" is what you get with no flag; Claude Code does not take it as a value.
    if (s.permission_mode && s.permission_mode !== 'default') args.push('--permission-mode', s.permission_mode)
    if (s.resume) args.push('--resume', s.resume)
    args.push(...this.cfg.claudeArgs, ...(s.extra_args ?? []))
    return args
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  async spawn(opts: SpawnOptions): Promise<SpawnResult> {
    const name = opts.name?.trim().toLowerCase()
    if (!name || !isValidName(name)) {
      throw new BadRequest(`"${opts.name}" is not a usable session name: lowercase letters, digits, - and _, up to 40 characters.`)
    }
    if (this.spawning.has(name)) throw new BadRequest(`${name} is already starting`)
    if (opts.by && opts.by !== USER && !opts.inherited) {
      // A session may start other sessions, but not ones that run with no permission checks.
      if (opts.permission_mode === 'bypassPermissions') {
        throw new Forbidden('Only the human can start a session that skips permission checks (from the web UI or the switchboard command).')
      }
      opts = { ...opts, extra_args: undefined }
    }
    const tmuxName = this.tmuxName(name)
    if (await this.tmux.has(tmuxName)) {
      if (!(await this.tmux.paneDead(tmuxName))) {
        throw new BadRequest(`A session named ${name} is already running (tmux ${tmuxName}). Stop it first, or pick another name.`)
      }
      await this.tmux.kill(tmuxName)
    }
    const role: SessionRole = opts.role ?? (name === this.cfg.orchestrator ? 'orchestrator' : 'worker')
    const previous = await store.getSession(this.hub.db, name)
    const cwd = path.resolve(expandHome(opts.cwd?.trim() || previous?.cwd || (role === 'orchestrator' ? this.cfg.orchestratorCwd : process.cwd())))
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new BadRequest(`Directory not found: ${cwd}`)

    this.spawning.add(name)
    try {
      this.hub.ready.delete(name)
      const command = this.claudeCommand({ name, role, model: opts.model, permission_mode: opts.permission_mode, resume: opts.resume, extra_args: opts.extra_args })
      await store.upsertSession(this.hub.db, name, {
        role,
        cwd,
        description: opts.description ?? previous?.description ?? '',
        managed: true,
        tmux_session: tmuxName,
        status: 'starting',
        status_text: '',
        delivery: 'channel',
        model: opts.model ?? null,
        permission_mode: opts.permission_mode ?? null,
        archived_at: null,
      })
      await this.tmux.newSession({
        name: tmuxName,
        cwd,
        command,
        env: {
          // The tmux server may have started long ago with another PATH; make `claude` resolve as it does here.
          PATH: process.env.PATH ?? '',
          SWITCHBOARD_SESSION: name,
          SWITCHBOARD_URL: this.localUrl(),
          SWITCHBOARD_DATA_DIR: this.cfg.dataDir,
          // Channel servers must use the MCP handshake that predates protocol revision 2026-07-28.
          MCP_PROTOCOL_NEGOTIATION: 'legacy',
        },
      })
      await this.hub.publishSession(name)
      if (opts.prompt?.trim()) {
        await store.supersedeSpawnPrompts(this.hub.db, name)
        // The first prompt is from whoever asked: you, or the session that started this one.
        const from = opts.by && opts.by !== name && (await store.getSession(this.hub.db, opts.by)) ? opts.by : USER
        // Queued now, pushed in the moment the session is ready.
        await this.hub.send({ from_id: from, to_id: name, body: opts.prompt.trim(), meta: { via: 'spawn' } })
      }
      this.hub.log(`spawned ${name} in ${cwd} (tmux ${tmuxName})`)
      if (opts.wait === false) {
        void this.awaitStartup(name).catch(err => this.hub.log(`startup ${name}: ${err.message}`))
        return { session: (await this.hub.publishSession(name))!, ready: false, note: 'Starting in the background.' }
      }
      return await this.awaitStartup(name)
    } finally {
      this.spawning.delete(name)
    }
  }

  /**
   * Answer the startup dialogs the hub is allowed to, and wait until the
   * channel connects with nothing left on screen asking a question.
   */
  async awaitStartup(name: string, timeoutMs = 90_000): Promise<SpawnResult> {
    this.starting.add(name)
    try {
      return await this.watchStartup(name, timeoutMs)
    } finally {
      this.starting.delete(name)
    }
  }

  private async watchStartup(name: string, timeoutMs: number): Promise<SpawnResult> {
    const tmuxName = this.tmuxName(name)
    const deadline = Date.now() + timeoutMs
    const answered: string[] = []
    let screen = ''
    let quietSince = 0
    while (Date.now() < deadline) {
      await sleep(600)
      if (!(await this.tmux.has(tmuxName))) {
        await store.updateSession(this.hub.db, name, { status: 'offline' })
        const session = (await this.hub.publishSession(name))!
        return { session, ready: false, note: `The tmux session ${tmuxName} closed during startup.` }
      }
      if (await this.tmux.paneDead(tmuxName)) {
        screen = (await this.tmux.capture(tmuxName, 50).catch(() => '')).replace(/\n{3,}/g, '\n\n')
        const notInstalled = /command not found|No such file or directory|not found: /i.test(screen)
        await store.updateSession(this.hub.db, name, { status: 'exited', status_text: notInstalled ? 'Claude Code is not installed' : 'Exited during startup' })
        const session = (await this.hub.publishSession(name))!
        return {
          session,
          ready: false,
          note: notInstalled
            ? `Claude Code is not installed on this computer (or not where Switchboard looks: ${findClaude(this.cfg)}). ` +
              'In a terminal there, run "switchboard doctor": it prints the command that installs it.'
            : 'Claude Code exited during startup. The last screen is below.',
          screen,
        }
      }
      screen = await this.tmux.capture(tmuxName).catch(() => '')
      const dialog = detectDialog(screen, { autoAccept: this.cfg.autoAcceptDialogs })
      if (dialog) {
        quietSince = 0
        if (dialog.answer) {
          // Move the highlight, look again, and press Enter only once the pointer is seen on the
          // right choice: these dialogs ignore keys for a moment after they open, some take no
          // number keys, and the one that asks about trusting a folder starts on "No, exit".
          const moves = movesTo(dialog.options, dialog.answer)
          if (moves.length) {
            await this.tmux.keys(tmuxName, moves)
            await sleep(350)
            continue
          }
          await this.tmux.keys(tmuxName, ['Enter'])
          const entry = `${dialog.kind}: "${dialog.answer.label}"`
          if (answered.at(-1) !== entry) answered.push(entry)
          await sleep(900)
          continue
        }
        await store.updateSession(this.hub.db, name, { status: 'attention', status_text: `Startup question on screen (${dialog.kind})` })
        const session = (await this.hub.publishSession(name))!
        return {
          session,
          ready: false,
          note: `Claude Code is asking something the hub will not answer for you (${dialog.kind}). Read the screen and answer with send_keys, or attach with: tmux attach -t ${tmuxName}`,
          screen,
        }
      }
      // Ready: the channel is connected and nothing on screen is asking a question. A visible
      // prompt line only shortens the wait; its exact look changes between Claude Code versions.
      const connected = this.hub.bus.isConnected(name)
      const promptVisible = /\? for shortcuts|^\s*[>❯]\s*$|bypass permissions|accept edits|plan mode|auto mode/im.test(screen)
      if (connected) {
        if (!quietSince) quietSince = Date.now()
        if (Date.now() - quietSince >= (promptVisible ? 1200 : 3000)) {
          this.hub.ready.add(name)
          // Claude Code says on screen when it will not take channel messages (the feature is a
          // preview, and an organization can switch it off). The session still works: its tools are
          // connected, and messages are typed into its terminal instead of pushed.
          const problem = channelProblem(screen)
          await store.updateSession(this.hub.db, name, {
            status: 'idle',
            status_text: problem ? 'No channels here: messages are typed into its terminal' : '',
            delivery: problem ? 'keys' : 'channel',
          })
          const session = (await this.hub.publishSession(name))!
          await this.hub.deliver(name)
          const fallback = problem ? ` ${problem} Messages will be typed into its terminal instead; replies come back the same way.` : ''
          if (problem) {
            await this.hub.send({ from_id: SYSTEM, to_id: USER, kind: 'notification', body: `${name}:${fallback}`, meta: { session: name } })
          }
          return {
            session,
            ready: true,
            note: `${answered.length ? `Ready. Answered: ${answered.join('; ')}.` : 'Ready.'}${fallback}`,
          }
        }
      } else {
        quietSince = 0
      }
    }
    const connected = this.hub.bus.isConnected(name)
    await store.updateSession(this.hub.db, name, {
      status: 'attention',
      status_text: connected ? 'Startup did not finish' : 'Channel never connected',
    })
    const session = (await this.hub.publishSession(name))!
    return {
      session,
      ready: false,
      note: connected
        ? 'The channel connected but the prompt never appeared. Check the screen below.'
        : 'The switchboard channel never connected. Check the screen below; run /mcp in the session to see why.',
      screen,
    }
  }

  async stop(name: string, opts: { keepRecord?: boolean } = {}): Promise<Session> {
    const s = await store.requireSession(this.hub.db, name)
    const tmuxName = s.tmux_session || this.tmuxName(name)
    if (await this.tmux.has(tmuxName)) {
      if (!(await this.tmux.paneDead(tmuxName))) {
        // Leave the prompt cleanly so the SessionEnd hook runs; kill the pane if it does not go.
        await this.tmux.keys(tmuxName, ['Escape']).catch(() => {})
        await sleep(200)
        await this.tmux.submit(tmuxName, '/exit').catch(() => {})
        for (let i = 0; i < 20 && !(await this.tmux.paneDead(tmuxName)); i++) await sleep(250)
      }
      await this.tmux.kill(tmuxName)
    }
    this.hub.ready.delete(name)
    await store.updateSession(this.hub.db, name, {
      status: 'offline',
      status_text: '',
      ...(opts.keepRecord === false ? { archived_at: new Date().toISOString() } : {}),
    })
    return (await this.hub.publishSession(name))!
  }

  /** Stop and start again, continuing the same conversation when Claude Code reported its id. */
  async restart(name: string, opts: { fresh?: boolean; by?: string } = {}): Promise<SpawnResult> {
    const s = await store.requireSession(this.hub.db, name)
    await this.stop(name)
    return this.spawn({
      name,
      cwd: s.cwd,
      role: s.role,
      description: s.description,
      model: s.model,
      permission_mode: s.permission_mode,
      resume: opts.fresh ? null : s.claude_session_id,
      by: opts.by,
      inherited: true,
    })
  }

  async interrupt(name: string): Promise<void> {
    await this.tmux.keys(await this.requireTmux(name), ['Escape'])
  }

  async screen(name: string, history = 0): Promise<string> {
    return this.tmux.capture(await this.requireTmux(name), history)
  }

  /** Named keys (Enter, Escape, Up, Down, Tab, C-c, digits) or text typed literally. */
  async sendKeys(name: string, input: { keys?: string[]; text?: string; enter?: boolean }, by: string = USER): Promise<void> {
    const t = await this.requireTmux(name)
    if (by !== USER) {
      // Approving a tool, trusting a folder or accepting a warning is the human's answer to give.
      // Another session may type into this terminal, but not answer those for them.
      const screen = await this.tmux.capture(t).catch(() => '')
      const dialog = detectDialog(screen, { autoAccept: false })
      const what = isToolApproval(screen) ? 'a tool approval' : dialog && dialog.kind !== 'unknown_select' ? `a ${dialog.kind.replace(/_/g, ' ')} question` : null
      if (what) {
        throw new Forbidden(
          `${name} is showing ${what}, and that answer belongs to the human: they get it on their phone and in the web UI. ` +
            `Tell them ${name} is waiting instead of answering it.`,
        )
      }
    }
    if (input.text) {
      if (input.enter) await this.tmux.submit(t, input.text)
      else await this.tmux.typeText(t, input.text)
    } else if (input.enter) {
      await this.tmux.keys(t, ['Enter'])
    }
    if (input.keys?.length) await this.tmux.keys(t, input.keys)
  }

  private async requireTmux(name: string): Promise<string> {
    const s = await store.getSession(this.hub.db, name)
    const t = s?.tmux_session || this.tmuxName(name)
    if (!(await this.tmux.has(t))) throw new NotFound(`${name} is not running in tmux (${t})`)
    return t
  }

  /** For sessions without a channel: type each queued message into the terminal. */
  /**
   * For sessions without a working channel: type each queued message into the terminal, marked so
   * the session can tell who it is from. Nothing is typed while a question is on its screen, where
   * a stray "1" or Enter would answer it; the message waits and the next look at the screen retries.
   */
  private async deliverByKeys(s: Session): Promise<void> {
    if (!s.tmux_session || !(await this.tmux.has(s.tmux_session)) || (await this.tmux.paneDead(s.tmux_session))) return
    for (const m of await store.undeliveredFor(this.hub.db, s.name)) {
      const screen = await this.tmux.capture(s.tmux_session).catch(() => '')
      if (isToolApproval(screen) || detectDialog(screen, { autoAccept: false })) return
      await this.tmux.submit(s.tmux_session, typedForm(m))
      await this.hub.onAck(s.name, m.id)
      await sleep(400)
    }
  }

  // -------------------------------------------------------------------------
  // Watching

  /** Read each managed session's screen every few seconds: busy, waiting on an approval, idle, or gone. */
  startPolling(intervalMs = 2500): void {
    if (this.poller) return
    this.poller = setInterval(() => void this.pollOnce().catch(err => this.hub.log(`poll: ${err.message}`)), intervalMs)
    this.poller.unref()
  }

  stopPolling(): void {
    if (this.poller) clearInterval(this.poller)
    this.poller = null
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const running = new Map((await this.tmux.list()).map(t => [t.name, t]))
      for (const s of await store.listSessions(this.hub.db)) {
        if (!s.managed || !s.tmux_session || this.spawning.has(s.name) || this.starting.has(s.name)) continue
        const t = running.get(s.tmux_session)
        if (!t) {
          if (s.status !== 'offline') {
            this.hub.ready.delete(s.name)
            await this.hub.setStatus(s.name, 'offline')
          }
          continue
        }
        if (t.dead) {
          if (s.status !== 'exited') {
            this.hub.ready.delete(s.name)
            await this.hub.setStatus(s.name, 'exited', 'Claude Code exited')
          }
          continue
        }
        const screen = await this.tmux.capture(s.tmux_session).catch(() => '')
        // Messages typed into a terminal wait while a question is on its screen; try again now.
        if (s.delivery === 'keys' && this.hub.ready.has(s.name)) await this.hub.deliver(s.name)
        if (s.status === 'attention' || s.status === 'starting') {
          // Someone answered the startup question (from the web UI's Screen, or attached),
          // or the hub restarted while this session was starting.
          if (this.hub.bus.isConnected(s.name) && !detectDialog(screen, { autoAccept: false })) {
            this.hub.ready.add(s.name)
            await this.hub.setStatus(s.name, 'idle', '')
            await this.hub.deliver(s.name)
          }
          continue
        }
        const status = screenStatus(screen)
        if (status !== s.status) await this.hub.setStatus(s.name, status)
        if (!this.hub.ready.has(s.name) && this.hub.bus.isConnected(s.name) && !detectDialog(screen, { autoAccept: false })) {
          // e.g. the hub restarted while the session kept running
          this.hub.ready.add(s.name)
          await this.hub.deliver(s.name)
        }
      }
    } finally {
      this.polling = false
    }
  }

  /** Adopt tmux sessions with our prefix that the database does not know (the hub was reset). */
  async adoptRunning(): Promise<void> {
    for (const t of await this.tmux.list()) {
      if (!t.name.startsWith(this.cfg.tmuxPrefix)) continue
      const name = t.name.slice(this.cfg.tmuxPrefix.length)
      if (!isValidName(name)) continue
      const existing = await store.getSession(this.hub.db, name)
      if (!existing) {
        await store.upsertSession(this.hub.db, name, {
          managed: true,
          tmux_session: t.name,
          cwd: t.cwd,
          role: name === this.cfg.orchestrator ? 'orchestrator' : 'worker',
          status: t.dead ? 'exited' : 'idle',
        })
      } else if (!existing.managed || existing.tmux_session !== t.name) {
        await store.updateSession(this.hub.db, name, { managed: true, tmux_session: t.name })
      }
    }
  }
}

/**
 * Why Claude Code will not push channel messages into this session, read off its startup screen
 * (the wording is Claude Code's own), or null when nothing there says so.
 */
export function channelProblem(screen: string): string | null {
  if (/blocked by org(anization)? policy|channelsEnabled|silently dropped/i.test(screen)) {
    return 'Channels are switched off for your organization (an Owner can turn them on under Organization settings > Claude Code > Channels).'
  }
  if (/Channels are not (currently )?available/i.test(screen)) {
    return 'Claude Code channels are not available on this account yet (they are a preview that is rolling out gradually).'
  }
  if (/no MCP server configured with that name|not on the approved channels allowlist|not on your org.s approved channels list|entries need --dangerously-load-development-channels/i.test(screen)) {
    return 'Claude Code did not accept Switchboard as a channel in this session.'
  }
  if (/messages are dropped/i.test(screen)) return 'Claude Code is not taking channel messages in this session.'
  return null
}

/** A message as typed into a session's terminal: `[switchboard from="user" via="voice" id="12"] text`. */
export function typedForm(m: { id: number; from_id: string; body: string; kind: string; meta?: Record<string, unknown> }): string {
  const via = typeof m.meta?.via === 'string' && /^[a-z0-9_-]+$/i.test(m.meta.via) ? m.meta.via : m.kind === 'voice' ? 'voice' : ''
  return `[switchboard from="${m.from_id}"${via ? ` via="${via}"` : ''} id="${m.id}"] ${m.body.replace(/\s*\n+\s*/g, ' ')}`
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function identityPrompt(name: string, role: SessionRole, orchestrator: string): string {
  const common =
    `You are the Claude Code session named "${name}", connected to Switchboard. ` +
    `Your human reaches you through the switchboard channel, often by voice from their phone while away from the desk, ` +
    `and other sessions can message you the same way. Messages arrive as <channel source="switchboard" from="..." message_id="...">, ` +
    `or typed in as a line starting [switchboard from="..." id="..."]; treat both the same. ` +
    `Answer the human with the switchboard reply tool (not plain text, which they cannot see when away), and other sessions with send_message. ` +
    `Keep the shared backlog current with the task tools, and use search_history when you need context you no longer have.`
  if (role === 'orchestrator') {
    return (
      common +
      ` You are the orchestrator: you start, steer and stop the other sessions (spawn_session, read_screen, send_keys, ` +
      `interrupt_session, stop_session), delegate work to them, and keep the human informed. Follow the CLAUDE.md in your working directory.`
    )
  }
  return common + ` The orchestrator session is "${orchestrator}"; tell it (send_message) when you finish, get blocked, or need a decision.`
}
