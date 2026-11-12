import { Bus } from './bus.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { Hub } from './hub.ts'
import { buildServer, VERSION } from './server.ts'
import { SessionManager } from './sessions.ts'
import { Tmux } from './tmux.ts'

/** Start the hub: database, HTTP + WebSocket server, tmux watcher. */
export async function startHub(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env)
  const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`)
  const db = await openDatabase(cfg, log)
  const bus = new Bus()
  const hub = new Hub(cfg, db.pool, bus, log)
  const tmux = new Tmux(env.SWITCHBOARD_TMUX_SOCKET || '')
  const sessions = new SessionManager(hub, tmux)
  const app = await buildServer(hub, sessions)

  // Nothing is connected yet: sessions the hub did not start come back online when their channel reconnects.
  await db.pool.query(`update sessions set status = 'offline' where not managed and status <> 'offline'`)
  await sessions.adoptRunning().catch(err => log(`adopting tmux sessions: ${err.message}`))
  await app.listen({ port: cfg.port, host: cfg.host })
  sessions.startPolling()
  const ingest = setInterval(() => void hub.ingestRecent().catch(err => log(`ingest: ${err.message}`)), 30_000)
  ingest.unref()

  const local = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`
  console.log(
    [
      '',
      `  Switchboard ${VERSION}`,
      `  Web UI:     ${local}/#token=${cfg.token}`,
      cfg.publicUrl ? `  Phone:      ${cfg.publicUrl}  (run "switchboard pair" for a QR code)` : `  Phone:      set SWITCHBOARD_PUBLIC_URL (e.g. your Tailscale https address), then "switchboard pair"`,
      `  Database:   ${db.description}`,
      `  tmux:       ${(await tmux.available()) ?? 'NOT FOUND - install tmux to start sessions'}`,
      `  Speech:     ${cfg.stt ? `${cfg.stt.baseUrl} (${cfg.stt.model})` : 'on-device only (set OPENAI_API_KEY or STT_BASE_URL for hub transcription)'}`,
      `  Orchestrator session: ${cfg.orchestrator}`,
      '',
    ].join('\n'),
  )

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    log(`${signal}: shutting down (sessions in tmux keep running)`)
    clearInterval(ingest)
    sessions.stopPolling()
    await app.close().catch(() => {})
    await db.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  return { cfg, app, hub, sessions, db }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHub().catch(err => {
    console.error(`switchboard: ${err.stack || err.message}`)
    process.exit(1)
  })
}
