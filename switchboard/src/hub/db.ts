import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import type { Config } from './config.ts'
import { readOrCreateSecret } from './config.ts'
import { MIGRATIONS } from './schema.ts'

// bigint ids come back as strings by default; every id here fits in a double.
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10))
// numeric (task positions are double precision, which already parses; this covers sums)
pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v))

export type Db = pg.Pool

export interface Database {
  pool: pg.Pool
  /** How the database was reached, for `switchboard doctor` and the startup banner. */
  description: string
  close(): Promise<void>
}

/**
 * Connect to DATABASE_URL, or start the Postgres that ships with the
 * `embedded-postgres` package in dataDir/postgres when no URL is set. Either
 * way it is real Postgres; the embedded one just needs no install.
 */
export async function openDatabase(cfg: Config, log: (msg: string) => void = () => {}): Promise<Database> {
  if (cfg.databaseUrl) {
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 })
    await migrate(pool)
    return { pool, description: redactUrl(cfg.databaseUrl), close: () => pool.end() }
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres').catch(() => {
    throw new Error(
      'DATABASE_URL is not set and the embedded Postgres package is missing. Either run `npm install` in switchboard/ ' +
        '(it is an optional dependency) or point DATABASE_URL at a Postgres you run yourself.',
    )
  })
  const dir = path.join(cfg.dataDir, 'postgres')
  const password = readOrCreateSecret(path.join(cfg.dataDir, 'pg-password'))
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (isRoot) {
    // As root (containers, servers) Postgres runs as a separate "postgres" user,
    // which must be able to walk down to its directory. Files stay private (0600).
    fs.chmodSync(cfg.dataDir, 0o711)
    for (let d = path.dirname(cfg.dataDir); d !== path.dirname(d); d = path.dirname(d)) {
      if ((fs.statSync(d).mode & 0o001) === 0) {
        throw new Error(
          `Running as root, the embedded Postgres runs as the "postgres" user and cannot reach ${dir} because ${d} is not ` +
            `traversable by other users. Set SWITCHBOARD_DATA_DIR somewhere it can reach, or set DATABASE_URL.`,
        )
      }
    }
  }
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    port: cfg.embeddedPgPort,
    user: 'switchboard',
    password,
    persistent: true,
    // Postgres refuses to run as root; the package then runs it as a "postgres" user it creates.
    createPostgresUser: isRoot,
    onLog: () => {},
    onError: (e: unknown) => log(`[postgres] ${String(e).trim()}`),
  })
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) {
    log(`Creating the embedded Postgres cluster in ${dir}`)
    await server.initialise()
  }
  removeStalePidFile(dir)
  await server.start()
  try {
    await server.createDatabase('switchboard')
  } catch (err) {
    if (!/already exists/i.test(String((err as Error).message))) throw err
  }
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: cfg.embeddedPgPort,
    user: 'switchboard',
    password,
    database: 'switchboard',
    max: 10,
  })
  await migrate(pool)
  return {
    pool,
    description: `embedded Postgres in ${dir} (port ${cfg.embeddedPgPort})`,
    async close() {
      await pool.end()
      await server.stop()
    },
  }
}

/** A crash leaves postmaster.pid behind and the next start refuses to run. */
function removeStalePidFile(dir: string) {
  const pidFile = path.join(dir, 'postmaster.pid')
  if (!fs.existsSync(pidFile)) return
  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').split('\n')[0] ?? '', 10)
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
      return // still running; let Postgres report it
    } catch {
      // not running
    }
  }
  fs.rmSync(pidFile, { force: true })
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    // One hub at a time applies migrations.
    await client.query('select pg_advisory_lock(72770001)')
    await client.query(
      'create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())',
    )
    const { rows } = await client.query<{ version: number }>('select version from schema_migrations')
    const applied = new Set(rows.map(r => r.version))
    for (const [index, sql] of MIGRATIONS.entries()) {
      const version = index + 1
      if (applied.has(version)) continue
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations (version) values ($1)', [version])
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw new Error(`migration ${version} failed: ${(err as Error).message}`)
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(72770001)').catch(() => {})
    client.release()
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return 'DATABASE_URL'
  }
}
