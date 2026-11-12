import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Bus } from '../src/hub/bus.ts'
import { loadConfig } from '../src/hub/config.ts'
import { openDatabase } from '../src/hub/db.ts'
import { Hub } from '../src/hub/hub.ts'
import { buildServer } from '../src/hub/server.ts'
import { SessionManager } from '../src/hub/sessions.ts'
import { Tmux } from '../src/hub/tmux.ts'

export const FIXTURES = path.join(import.meta.dirname, 'fixtures')

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

export type TestHub = Awaited<ReturnType<typeof startTestHub>>

/**
 * A complete hub on a random port with its own Postgres (embedded, or
 * TEST_DATABASE_URL) and its own tmux server, so tests never touch yours.
 */
export async function startTestHub(extraEnv: Record<string, string> = {}) {
  // Under /tmp so the embedded Postgres can reach it even when tests run as root.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-'))
  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SWITCHBOARD_DATA_DIR: dataDir,
    SWITCHBOARD_PORT: String(port),
    SWITCHBOARD_PG_PORT: String(await freePort()),
    SWITCHBOARD_TOKEN: 'test-token-123',
    ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
    ...extraEnv,
  }
  const cfg = loadConfig(env)
  const logs: string[] = []
  const log = (m: string) => logs.push(m)
  const db = await openDatabase(cfg, log)
  if (process.env.TEST_DATABASE_URL) {
    await db.pool.query(
      'truncate messages, sessions, tasks, task_events, permission_requests, devices, transcript_entries, transcript_files, app_updates, native_builds restart identity cascade',
    )
  }
  const bus = new Bus()
  const hub = new Hub(cfg, db.pool, bus, log)
  const tmux = new Tmux(`sbtest-${process.pid}-${port}`)
  const sessions = new SessionManager(hub, tmux)
  const app = await buildServer(hub, sessions)
  await app.listen({ port, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${port}`
  async function api<T = any>(method: string, p: string, body?: unknown, token = cfg.token): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: any = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // keep text
    }
    return { status: res.status, data }
  }
  return {
    cfg,
    hub,
    bus,
    sessions,
    tmux,
    app,
    db,
    base,
    api,
    logs,
    dataDir,
    async close() {
      sessions.stopPolling()
      for (const t of await tmux.list()) await tmux.kill(t.name)
      await app.close()
      await db.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (err) {
      last = err
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`)
}
