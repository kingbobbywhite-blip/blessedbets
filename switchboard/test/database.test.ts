import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/hub/config.ts'
import { openDatabase, runningPostmaster } from '../src/hub/db.ts'
import { freePort } from './helpers.ts'

describe('the built-in database', { skip: process.env.TEST_DATABASE_URL ? 'uses TEST_DATABASE_URL' : false }, () => {
  it('keeps using a Postgres that a crashed hub left running, instead of failing to start another', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-db-'))
    const cfg = loadConfig({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SWITCHBOARD_DATA_DIR: dataDir,
      SWITCHBOARD_PG_PORT: String(await freePort()),
      SWITCHBOARD_TOKEN: 'x',
    })
    const pgDir = path.join(dataDir, 'postgres')
    // The first hub starts Postgres and is then "crashed": never closed.
    const first = await openDatabase(cfg)
    await first.pool.query(`insert into projects (slug, name) values ('kept', 'Kept')`)
    const pid = runningPostmaster(pgDir)
    assert.ok(pid, 'Postgres is running')

    // The next hub finds it and carries on, data and all.
    const said: string[] = []
    const second = await openDatabase(cfg, line => said.push(line))
    assert.match(said.join('\n'), /already running/)
    const { rows } = await second.pool.query(`select name from projects where slug = 'kept'`)
    assert.deepEqual(rows, [{ name: 'Kept' }])

    // Stopping that hub stops the database it adopted.
    await second.close()
    await first.pool.end()
    for (let i = 0; i < 50 && runningPostmaster(pgDir); i++) await new Promise(r => setTimeout(r, 200))
    assert.equal(runningPostmaster(pgDir), null, 'stopped')
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})
