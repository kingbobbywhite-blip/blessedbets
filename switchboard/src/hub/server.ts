import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import QRCode from 'qrcode'
import type { WebSocket } from 'ws'
import type { ChannelToHub, MessageKind, PttAction, UiToHub } from '../shared/protocol.ts'
import { NAME_RE, PTT_ACTIONS, SYSTEM, USER, isValidName } from '../shared/protocol.ts'
import { tokenMatches } from './config.ts'
import type { Hub } from './hub.ts'
import type { SessionManager } from './sessions.ts'
import * as store from './store.ts'
import { BadRequest, NotFound } from './store.ts'
import { assetFile, latestUpdate, manifestResponse, registerUpdate, type UpdateRow } from './updates.ts'
import { transcribe } from './voice.ts'

export const VERSION = '0.1.0'

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string | undefined>; Body: any }>

export async function buildServer(hub: Hub, sessions: SessionManager, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const cfg = hub.cfg
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024, trustProxy: true })
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } })
  await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } })

  // --- auth ----------------------------------------------------------------
  const tokenOf = (req: FastifyRequest): string | undefined => {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
    const header = req.headers['x-switchboard-token']
    if (typeof header === 'string') return header
    const q = (req.query as Record<string, string | undefined>)?.token
    return q || undefined
  }
  const isPublic = (url: string) =>
    url === '/api/health' ||
    (cfg.updatesPublic && url.startsWith('/updates/')) ||
    (!url.startsWith('/api/') && !url.startsWith('/ws') && !url.startsWith('/updates/') && !url.startsWith('/app/'))
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]
    if (isPublic(url)) return
    if (!tokenMatches(cfg.token, tokenOf(req))) {
      return reply.code(401).send({ error: 'Missing or wrong token. Pair this device again (switchboard pair).' })
    }
  })

  // Security headers. The page may only run its own scripts (plus the inline import map, by
  // hash) and talk to this hub, so even a bug in message rendering could not send data elsewhere.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-frame-options', 'DENY')
    reply.header('permissions-policy', 'microphone=(self), geolocation=(self), camera=(), payment=()')
    const type = String(reply.getHeader('content-type') ?? '')
    if (type.startsWith('text/html')) {
      const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()
      const hosts = [req.headers.host, forwarded, cfg.publicUrl ? new URL(cfg.publicUrl).host : '']
      reply.header('content-security-policy', contentSecurityPolicy(cfg.packageRoot, hosts))
    }
    return payload
  })

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500
    if (status >= 500) hub.log(`${req.method} ${req.url}: ${err.stack || err.message}`)
    reply.code(status).send({ error: err.message })
  })

  // --- web UI ----------------------------------------------------------------
  const vendor: Record<string, string> = {
    'preact.mjs': 'preact/dist/preact.mjs',
    'hooks.mjs': 'preact/hooks/dist/hooks.mjs',
    'htm.mjs': 'htm/dist/htm.mjs',
  }
  app.get('/vendor/:file', async (req: Req, reply) => {
    const rel = vendor[req.params.file]
    if (!rel) throw new NotFound('No such file')
    const file = path.join(cfg.packageRoot, 'node_modules', rel)
    reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'public, max-age=86400')
    return reply.send(fs.createReadStream(file))
  })
  // Added to a phone's home screen, the page gets storage of its own and would open unpaired.
  // A paired page asks for the manifest with its token, and gets back a start address that carries it.
  app.get('/manifest.webmanifest', async (req: Req, reply) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.packageRoot, 'web', 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>
    if (tokenMatches(cfg.token, req.query.token)) manifest.start_url = `./#token=${encodeURIComponent(cfg.token)}`
    reply.header('content-type', 'application/manifest+json; charset=utf-8').header('cache-control', 'no-store')
    return manifest
  })
  await app.register(fastifyStatic, {
    root: path.join(cfg.packageRoot, 'web'),
    prefix: '/',
    index: ['index.html'],
    cacheControl: false,
    setHeaders(res) {
      // The UI updates whenever the files change; never serve a stale copy.
      const r = res as unknown as { setHeader?: (k: string, v: string) => void; header?: (k: string, v: string) => void }
      if (typeof r.setHeader === 'function') r.setHeader('cache-control', 'no-cache')
      else r.header?.('cache-control', 'no-cache')
    },
  })

  // --- basics ----------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, name: 'switchboard', version: VERSION }))

  app.get('/api/info', async (req: Req) => ({
    version: VERSION,
    orchestrator: cfg.orchestrator,
    stt: Boolean(cfg.stt),
    stt_model: cfg.stt?.model ?? null,
    public_url: cfg.publicUrl,
    base_url: baseUrl(req),
    tmux: await sessions.tmux.available(),
    started_at: new Date(hub.startedAt).toISOString(),
  }))

  // --- sessions --------------------------------------------------------------
  app.get('/api/sessions', async (req: Req) => hub.sessions(req.query.archived === '1'))

  app.post('/api/sessions', async (req: Req) => {
    const b = bodyOf(req)
    return sessions.spawn({
      name: String(b.name ?? ''),
      cwd: b.cwd ?? null,
      role: b.role === 'orchestrator' ? 'orchestrator' : b.role === 'worker' ? 'worker' : undefined,
      description: typeof b.description === 'string' ? b.description : undefined,
      prompt: typeof b.prompt === 'string' ? b.prompt : null,
      model: b.model || null,
      permission_mode: b.permission_mode || null,
      extra_args: Array.isArray(b.extra_args) ? b.extra_args.map(String) : undefined,
      by: typeof b.by === 'string' ? b.by : USER,
      wait: b.wait !== false,
    })
  })

  app.get('/api/sessions/:name', async (req: Req) => {
    const s = await store.requireSession(hub.db, req.params.name)
    return hub.withLive(s)
  })

  app.patch('/api/sessions/:name', async (req: Req) => {
    const b = bodyOf(req)
    await store.requireSession(hub.db, req.params.name)
    const patch: Parameters<typeof store.updateSession>[2] = {}
    if (typeof b.description === 'string') patch.description = b.description
    if (b.delivery === 'channel' || b.delivery === 'keys') patch.delivery = b.delivery
    if (b.role === 'orchestrator' || b.role === 'worker') patch.role = b.role
    if (typeof b.status_text === 'string') patch.status_text = b.status_text.slice(0, 200)
    if (typeof b.archived === 'boolean') patch.archived_at = b.archived ? new Date().toISOString() : null
    await store.updateSession(hub.db, req.params.name, patch)
    if (patch.delivery) await hub.deliver(req.params.name)
    return hub.publishSession(req.params.name)
  })

  app.post('/api/sessions/:name/stop', async (req: Req) => sessions.stop(req.params.name, { keepRecord: bodyOf(req).archive !== true }))
  app.post('/api/sessions/:name/restart', async (req: Req) =>
    sessions.restart(req.params.name, { fresh: bodyOf(req).fresh === true, by: bodyOf(req).by }),
  )
  app.post('/api/sessions/:name/interrupt', async (req: Req) => {
    await sessions.interrupt(req.params.name)
    return { ok: true }
  })
  app.get('/api/sessions/:name/screen', async (req: Req) => ({
    screen: await sessions.screen(req.params.name, clampInt(req.query.lines, 0, 0, 5000)),
  }))
  app.post('/api/sessions/:name/keys', async (req: Req) => {
    const b = bodyOf(req)
    await sessions.sendKeys(
      req.params.name,
      {
        keys: Array.isArray(b.keys) ? b.keys.map(String) : undefined,
        text: typeof b.text === 'string' ? b.text : undefined,
        enter: b.enter === true,
      },
      actorOf(b),
    )
    return { ok: true }
  })
  app.post('/api/sessions/:name/read', async (req: Req) => {
    await hub.markRead(req.params.name)
    return { ok: true }
  })

  // --- messages and search ---------------------------------------------------
  app.get('/api/messages', async (req: Req) =>
    store.listMessages(hub.db, {
      participant: req.query.with || null,
      before: req.query.before ? Number(req.query.before) : null,
      after: req.query.after ? Number(req.query.after) : null,
      around: req.query.around ? Number(req.query.around) : null,
      limit: clampInt(req.query.limit, 50, 1, 500),
    }),
  )

  app.post('/api/messages', async (req: Req) => {
    const b = bodyOf(req)
    const from = typeof b.from === 'string' && b.from ? b.from : USER
    if (from !== USER && from !== SYSTEM && !isValidName(from)) throw new BadRequest(`Invalid sender "${from}"`)
    const kinds: MessageKind[] = ['chat', 'voice', 'system', 'notification', 'event']
    return hub.send({
      from_id: from,
      to_id: String(b.to ?? '').trim() || USER,
      body: String(b.body ?? b.text ?? ''),
      kind: kinds.includes(b.kind) ? b.kind : 'chat',
      meta: b.meta && typeof b.meta === 'object' ? b.meta : {},
      speak: b.speak === true,
    })
  })

  app.get('/api/search', async (req: Req) => {
    const q = (req.query.q ?? '').trim()
    if (!q) throw new BadRequest('Add ?q=')
    const sources = (req.query.sources ?? '').split(',').filter(s => s === 'message' || s === 'transcript' || s === 'task') as (
      | 'message'
      | 'transcript'
      | 'task'
    )[]
    return store.search(hub.db, { query: q, session: req.query.session || null, limit: clampInt(req.query.limit, 20, 1, 200), sources })
  })

  // --- projects and tasks ----------------------------------------------------
  app.get('/api/projects', async (req: Req) => store.listProjects(hub.db, { includeArchived: req.query.archived === '1' }))
  app.post('/api/projects', async (req: Req) => {
    const b = bodyOf(req)
    const slug = String(b.slug ?? '').trim().toLowerCase()
    if (!NAME_RE.test(slug)) throw new BadRequest('Project slugs are lowercase letters, digits, - and _ (up to 40)')
    const project = await store.createProject(hub.db, { slug, name: b.name, description: b.description, path: b.path ?? null, color: b.color ?? null })
    hub.emit({ type: 'project', project })
    return project
  })
  app.patch('/api/projects/:slug', async (req: Req) => {
    const project = await store.updateProject(hub.db, req.params.slug, bodyOf(req))
    hub.emit({ type: 'project', project })
    return project
  })

  app.get('/api/tasks', async (req: Req) =>
    store.listTasks(hub.db, {
      project: req.query.project || null,
      status: req.query.status ? req.query.status.split(',').map(s => store.checkStatus(s)!) : null,
      priority: req.query.priority ? req.query.priority.split(',').map(p => store.checkPriority(p)!) : null,
      assignee: req.query.assignee || null,
      query: req.query.q || null,
      includeClosed: req.query.closed === '1',
      parent_id: req.query.parent ? Number(req.query.parent) : null,
      limit: clampInt(req.query.limit, 500, 1, 2000),
    }),
  )
  app.post('/api/tasks', async (req: Req) => {
    const b = bodyOf(req)
    const task = await store.createTask(hub.db, b as store.NewTask, actorOf(b))
    hub.emit({ type: 'task', task })
    return task
  })
  app.get('/api/tasks/:id', async (req: Req) => {
    const task = await store.getTask(hub.db, Number(req.params.id))
    if (!task) throw new NotFound(`No task #${req.params.id}`)
    return task
  })
  app.patch('/api/tasks/:id', async (req: Req) => {
    const b = bodyOf(req)
    const task = await store.updateTask(hub.db, Number(req.params.id), b, actorOf(b), typeof b.comment === 'string' ? b.comment : undefined)
    hub.emit({ type: 'task', task })
    return task
  })
  app.post('/api/tasks/:id/comments', async (req: Req) => {
    const b = bodyOf(req)
    const task = await store.updateTask(hub.db, Number(req.params.id), {}, actorOf(b), String(b.body ?? b.comment ?? ''))
    hub.emit({ type: 'task', task })
    return task
  })
  app.delete('/api/tasks/:id', async (req: Req) => {
    const id = Number(req.params.id)
    if (!(await store.deleteTask(hub.db, id))) throw new NotFound(`No task #${id}`)
    hub.emit({ type: 'task_deleted', id })
    return { ok: true }
  })

  // --- tool approvals --------------------------------------------------------
  app.get('/api/permissions', async () => store.pendingPermissions(hub.db))
  app.post('/api/permissions/:id', async (req: Req) => {
    const behavior = bodyOf(req).behavior
    if (behavior !== 'allow' && behavior !== 'deny') throw new BadRequest('behavior must be "allow" or "deny"')
    return hub.decide(Number(req.params.id), behavior, String(bodyOf(req).by ?? USER))
  })

  // --- phones ----------------------------------------------------------------
  app.get('/api/devices', async () => {
    const online = hub.bus.onlineDeviceIds()
    return (await store.listDevices(hub.db)).map(d => ({ ...d, push_token: d.push_token ? 'set' : null, online: online.has(d.id) }))
  })
  app.post('/api/devices', async (req: Req) => {
    const b = bodyOf(req)
    if (!b.id || !b.name || !b.platform) throw new BadRequest('id, name and platform are required')
    return store.upsertDevice(hub.db, {
      id: String(b.id),
      name: String(b.name),
      platform: String(b.platform),
      push_token: b.push_token ?? null,
      app_version: b.app_version ?? null,
      runtime_version: b.runtime_version ?? null,
      update_id: b.update_id ?? null,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities.map(String) : [],
    })
  })
  app.post('/api/devices/actions', async (req: Req) => {
    const b = bodyOf(req)
    if (!b.action) throw new BadRequest('action is required')
    const result = await hub
      .deviceCall(String(b.action), b.params && typeof b.params === 'object' ? b.params : {}, {
        device: b.device ?? null,
        timeoutMs: typeof b.timeout_ms === 'number' ? b.timeout_ms : undefined,
      })
      .catch((err: Error) => {
        throw Object.assign(new Error(err.message), { statusCode: err instanceof BadRequest ? 409 : 504 })
      })
    return { ok: true, result }
  })

  // Push-to-talk from a Flic button, a Shortcut, or anything that can make a request.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/ptt/:action',
    handler: async (req: Req, reply: FastifyReply) => {
      const action = req.params.action as PttAction
      if (!PTT_ACTIONS.includes(action)) throw new BadRequest(`Use one of: ${PTT_ACTIONS.join(', ')}`)
      const client = hub.ptt(action, { device: req.query.device ?? null, target: req.query.target ?? null })
      if (!client) {
        return reply.code(409).send({ ok: false, error: 'No phone or browser has voice switched on. Open the app in walk mode.' })
      }
      return { ok: true, sent_to: client.name, action }
    },
  })

  app.post('/api/voice', async (req: Req) => {
    const file = await req.file()
    if (!file) throw new BadRequest('Send the recording as multipart field "audio"')
    const fields = Object.fromEntries(
      Object.entries(file.fields).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value) : '']),
    )
    if (!cfg.stt) {
      throw Object.assign(new Error('The hub has no speech-to-text configured (set OPENAI_API_KEY, GROQ_API_KEY or STT_BASE_URL). Use on-device transcription instead.'), {
        statusCode: 503,
      })
    }
    const data = await file.toBuffer()
    const names = await hub.sessionNames()
    const text = await transcribe(cfg.stt, { data, filename: file.filename || 'audio.m4a', mimetype: file.mimetype }, {
      prompt: `Session names: ${names.join(', ')}.`,
    })
    if (!text) return { text: '', intent: { kind: 'empty' } }
    return hub.utterance(text, { to: fields.to || null, device: fields.device || null, via: 'voice' })
  })

  app.post('/api/utterance', async (req: Req) => {
    const b = bodyOf(req)
    return hub.utterance(String(b.text ?? ''), { to: b.to || null, device: b.device || null, via: b.via || 'voice' })
  })

  // --- Claude Code hooks -----------------------------------------------------
  app.post('/api/hooks', async (req: Req) => {
    const b = bodyOf(req)
    await hub.hook(String(b.event ?? b.payload?.hook_event_name ?? ''), String(b.session ?? ''), b.payload ?? {})
    return { ok: true }
  })

  // --- pairing ---------------------------------------------------------------
  app.get('/api/pair', async (req: Req) => {
    const base = cfg.publicUrl ?? baseUrl(req)
    const url = `${base}/#token=${encodeURIComponent(cfg.token)}`
    const app = `switchboard://pair?${new URLSearchParams({ url: base, token: cfg.token }).toString()}`
    return {
      base_url: base,
      web_url: url,
      app_url: app,
      web_qr_svg: await QRCode.toString(url, { type: 'svg', margin: 1 }),
      app_qr_svg: await QRCode.toString(app, { type: 'svg', margin: 1 }),
      flic: {
        toggle: `${base}/api/ptt/toggle?token=${encodeURIComponent(cfg.token)}`,
        start: `${base}/api/ptt/start?token=${encodeURIComponent(cfg.token)}`,
        stop: `${base}/api/ptt/stop?token=${encodeURIComponent(cfg.token)}`,
        cancel: `${base}/api/ptt/cancel?token=${encodeURIComponent(cfg.token)}`,
      },
    }
  })

  // --- phone app updates -----------------------------------------------------
  app.get('/updates/manifest', async (req: Req, reply) => {
    const res = await manifestResponse(
      hub.db,
      { headers: req.headers, query: req.query },
      cfg.publicUrl ?? baseUrl(req),
      cfg.updatesPublic ? undefined : cfg.token,
    )
    reply.code(res.status)
    for (const [k, v] of Object.entries(res.headers)) reply.header(k, v)
    return reply.send(res.body)
  })
  app.get('/updates/assets', async (req: Req, reply) => {
    const asset = await assetFile(hub.db, req.query)
    if (!asset) throw new NotFound('No such asset')
    reply.header('content-type', asset.contentType).header('cache-control', 'public, max-age=31536000, immutable')
    return reply.send(fs.createReadStream(asset.file))
  })
  app.get('/api/app/updates', async () => {
    const { rows } = await hub.db.query<UpdateRow>('select * from app_updates order by created_at desc limit 50')
    return rows
  })
  app.post('/api/app/updates', async (req: Req) => {
    const update = await registerUpdate(hub.db, cfg.dataDir, { dir: String(bodyOf(req).dir ?? ''), message: bodyOf(req).message })
    hub.emit({ type: 'app_update', id: update.id, runtime_version: update.runtime_version, message: update.message })
    hub.log(`published app update ${update.id} (runtime ${update.runtime_version}) ${update.message}`)
    return update
  })
  app.post('/api/app/updates/rollback', async (req: Req) => {
    const rv = String(bodyOf(req).runtime_version ?? '')
    const platform = String(bodyOf(req).platform ?? 'ios')
    const latest = await latestUpdate(hub.db, rv, platform)
    if (!latest) throw new NotFound('Nothing published for that runtime version')
    await hub.db.query('update app_updates set rolled_back_at = now() where id = $1', [latest.id])
    const now = await latestUpdate(hub.db, rv, platform)
    if (now) hub.emit({ type: 'app_update', id: now.id, runtime_version: rv, message: `Rolled back to ${now.message || now.id}` })
    return { rolled_back: latest.id, now_serving: now?.id ?? 'the build installed on the phone' }
  })
  app.get('/api/app/native', async (req: Req) => {
    const platform = req.query.platform ?? 'android'
    const { rows } = await hub.db.query(
      'select id, platform, version, runtime_version, sha256, message, created_at from native_builds where platform = $1 order by created_at desc limit 1',
      [platform],
    )
    const build = rows[0]
    if (!build) return null
    return { ...build, url: `${cfg.publicUrl ?? baseUrl(req)}/app/native/${build.id}/download` }
  })
  app.post('/api/app/native', async (req: Req) => {
    const b = bodyOf(req)
    const file = path.resolve(String(b.file ?? ''))
    const buildsDir = path.join(cfg.dataDir, 'builds')
    if (!file.startsWith(buildsDir + path.sep) || !fs.existsSync(file)) throw new BadRequest(`Put the build under ${buildsDir} first`)
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const { rows } = await hub.db.query(
      `insert into native_builds (platform, version, runtime_version, file, sha256, message) values ($1, $2, $3, $4, $5, $6) returning *`,
      [b.platform ?? 'android', String(b.version ?? ''), String(b.runtime_version ?? ''), file, sha256, String(b.message ?? '')],
    )
    return rows[0]
  })
  app.get('/app/native/:id/download', async (req: Req, reply) => {
    const { rows } = await hub.db.query<{ file: string; version: string }>('select file, version from native_builds where id = $1', [
      Number(req.params.id),
    ])
    if (!rows[0]) throw new NotFound('No such build')
    reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-disposition', `attachment; filename="switchboard-${rows[0].version}.apk"`)
    return reply.send(fs.createReadStream(rows[0].file))
  })

  // --- WebSocket -------------------------------------------------------------
  app.get('/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const q = req.query as Record<string, string | undefined>
    if (q.role === 'channel') handleChannelSocket(hub, socket, q.session ?? '')
    else void handleUiSocket(hub, socket, q)
  })

  // Drop connections that stopped answering (a phone that lost signal).
  const heartbeat = setInterval(() => {
    for (const ws of app.websocketServer.clients) {
      const w = ws as WebSocket & { alive?: boolean }
      if (w.alive === false) {
        w.terminate()
        continue
      }
      w.alive = false
      w.ping()
    }
  }, 25_000)
  heartbeat.unref()
  app.addHook('onClose', async () => clearInterval(heartbeat))

  return app
}

function handleChannelSocket(hub: Hub, socket: WebSocket, sessionHint: string) {
  const s = socket as WebSocket & { alive?: boolean }
  s.alive = true
  socket.on('pong', () => (s.alive = true))
  let client: Awaited<ReturnType<Hub['channelHello']>> | null = null
  const helloTimer = setTimeout(() => {
    if (!client) socket.close(4001, 'hello expected')
  }, 15_000)
  socket.on('message', async raw => {
    let event: ChannelToHub
    try {
      event = JSON.parse(String(raw))
    } catch {
      return
    }
    try {
      if (event.type === 'hello') {
        clearTimeout(helloTimer)
        client = await hub.channelHello(socket, { ...event, session: event.session || sessionHint })
      } else if (client) {
        await hub.onChannelEvent(client, event)
      }
    } catch (err) {
      hub.log(`channel ${sessionHint}: ${(err as Error).message}`)
      if (!client) socket.close(4002, (err as Error).message.slice(0, 100))
    }
  })
  socket.on('close', () => {
    clearTimeout(helloTimer)
    if (client) void hub.channelClosed(client).catch(err => hub.log(`channel close: ${err.message}`))
  })
  socket.on('error', () => {})
}

async function handleUiSocket(hub: Hub, socket: WebSocket, q: Record<string, string | undefined>) {
  const s = socket as WebSocket & { alive?: boolean }
  s.alive = true
  socket.on('pong', () => (s.alive = true))
  const client = hub.bus.addUi(socket, { deviceId: q.device || null, platform: q.platform || 'web', name: q.name || q.platform || 'browser' })
  socket.on('message', raw => {
    try {
      hub.onUiEvent(client, JSON.parse(String(raw)) as UiToHub)
    } catch {
      // ignore malformed frames
    }
  })
  socket.on('close', () => hub.bus.removeUi(client))
  socket.on('error', () => {})
  if (client.deviceId) await store.touchDevice(hub.db, client.deviceId).catch(() => {})
  hub.bus.sendToUi(client, {
    type: 'hello',
    sessions: await hub.sessions(),
    pending_permissions: await store.pendingPermissions(hub.db),
    server_time: new Date().toISOString(),
    orchestrator: hub.cfg.orchestrator,
  })
}

let importMapHash: { mtimeMs: number; hash: string } | null = null

/** The policy for the web UI, with the hash of index.html's inline import map. */
export function contentSecurityPolicy(packageRoot: string, hosts: (string | undefined)[]): string {
  const index = path.join(packageRoot, 'web', 'index.html')
  const stat = fs.statSync(index)
  if (!importMapHash || importMapHash.mtimeMs !== stat.mtimeMs) {
    const html = fs.readFileSync(index, 'utf8')
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    importMapHash = { mtimeMs: stat.mtimeMs, hash: crypto.createHash('sha256').update(map).digest('base64') }
  }
  // Older Safari does not count this page's own WebSocket address as 'self', so name it: as the
  // browser asked for it, as a proxy in front (tailscale serve) reports it, and as configured.
  const names = [...new Set(hosts.filter((h): h is string => Boolean(h) && /^[a-z0-9.:[\]-]+$/i.test(h!)))]
  const self = names.map(h => ` ws://${h} wss://${h}`).join('')
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${importMapHash.hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self'${self}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

function baseUrl(req: FastifyRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() || req.headers.host
  return `${proto}://${host}`
}

function bodyOf(req: FastifyRequest): Record<string, any> {
  const b = req.body
  return b && typeof b === 'object' ? (b as Record<string, any>) : {}
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

function actorOf(body: Record<string, unknown>): string {
  const by = typeof body.by === 'string' ? body.by : USER
  return by === USER || isValidName(by) ? by : USER
}
