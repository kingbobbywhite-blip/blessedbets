import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { Tmux } from '../src/hub/tmux.ts'
import { ensureUsableTmux, probeTmux } from '../src/tmuxcheck.ts'

/**
 * On a Mac, a tmux server started from somewhere with less access than the terminal
 * (a sandboxed app, an assistant's command) passes that on to every program it starts:
 * they crash with "EPERM: operation not permitted, uv_cwd" as soon as they ask which
 * folder they are in. A server started with this preloaded into node behaves the same.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tmuxcheck-'))
const poison = path.join(tmp, 'eperm.cjs')
fs.writeFileSync(
  poison,
  "process.cwd = () => { const e = new Error('EPERM: operation not permitted, uv_cwd'); e.code = 'EPERM'; e.syscall = 'uv_cwd'; throw e }\n",
)
const servers: Tmux[] = []
after(async () => {
  for (const t of servers) await t.killServer()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function server(label: string): Tmux {
  const t = new Tmux(`sbcheck-${process.pid}-${label}`)
  servers.push(t)
  return t
}

/** Start a tmux server the way a restricted app would, with these sessions in it. */
async function restrictedServer(t: Tmux, sessions: string[]) {
  const saved = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--require ${poison}`
  try {
    for (const name of sessions) await t.newSession({ name, cwd: tmp, command: ['sleep', '600'] })
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = saved
  }
}

describe('checking that tmux can work in the Switchboard folder', () => {
  it('passes for a tmux started from this terminal', async () => {
    const t = server('healthy')
    assert.deepEqual(await probeTmux(t, tmp, 'sb-'), { ok: true, detail: 'ok' })
    assert.deepEqual(await t.list(), [], 'the probe cleans up after itself')
  })

  it('catches a restricted tmux, and restarts it when every session in it is Switchboard\'s', async () => {
    const t = server('restricted')
    await restrictedServer(t, ['sb-boss', 'sb-api'])
    const probe = await probeTmux(t, tmp, 'sb-')
    assert.equal(probe.ok, false)
    assert.match(probe.detail, /EPERM: operation not permitted, uv_cwd/)

    const said: string[] = []
    const result = await ensureUsableTmux(t, tmp, 'sb-', line => said.push(line))
    assert.deepEqual(result, { ok: true, restarted: true })
    assert.match(said.join('\n'), /Restarting tmux from this terminal/)
    assert.deepEqual(await t.list(), [], 'the restricted server and its sessions are gone')
    assert.equal((await probeTmux(t, tmp, 'sb-')).ok, true, 'and programs it starts now work')
  })

  it('leaves a tmux alone when it also holds sessions that are not Switchboard\'s', async () => {
    const t = server('shared')
    await restrictedServer(t, ['sb-boss', 'my-notes'])
    const result = await ensureUsableTmux(t, tmp, 'sb-', () => {})
    assert.equal(result.ok, false)
    assert.equal(result.restarted, false)
    const message = result.ok ? '' : result.message.join('\n')
    assert.match(message, /my-notes/)
    assert.match(message, /tmux kill-server/)
    assert.ok((await t.list()).some(s => s.name === 'my-notes'), 'your session is still there')
  })

  it('says what to do next when even a fresh tmux cannot get in', async () => {
    const t = server('blocked')
    const missing = path.join(tmp, 'not-there')
    const result = await ensureUsableTmux(t, missing, 'sb-', () => {})
    assert.equal(result.ok, false)
    assert.equal(result.restarted, true)
    const message = result.ok ? '' : result.message.join('\n')
    assert.match(message, /not-there/)
    assert.match(message, /switchboard up/)
  })
})
