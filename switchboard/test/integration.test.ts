import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { codeStamp } from '../src/hub/config.ts'
import { updatesRoot } from '../src/hub/updates.ts'
import { FIXTURES, startTestHub, waitFor, type TestHub } from './helpers.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
let t: TestHub

before(async () => {
  t = await startTestHub({ CLAUDE_BIN: path.join(FIXTURES, 'fake-claude.mjs') })
})
after(async () => {
  await t?.close()
})

/** A Claude Code stand-in: runs the real channel server over stdio and records what it pushes. */
async function fakeClaude(session: string, role = 'worker') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src/channel/main.ts')],
    env: { ...(process.env as Record<string, string>), SWITCHBOARD_URL: t.base, SWITCHBOARD_TOKEN: t.cfg.token, SWITCHBOARD_SESSION: session, SWITCHBOARD_ROLE: role },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'claude-code', version: 'test' }, { capabilities: {} })
  const events: { content: string; meta?: Record<string, string> }[] = []
  const verdicts: { request_id: string; behavior: string }[] = []
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) }),
    n => void events.push(n.params),
  )
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel/permission'), params: z.object({ request_id: z.string(), behavior: z.string() }) }),
    n => void verdicts.push(n.params),
  )
  await client.connect(transport)
  await waitFor(() => t.bus.isConnected(session), `${session} to connect`)
  const text = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    if (r.isError) throw new Error(r.content[0].text)
    return r.content[0].text
  }
  return { client, events, verdicts, text, close: () => client.close() }
}

describe('auth', () => {
  it('rejects a wrong token and serves health without one', async () => {
    assert.equal((await t.api('GET', '/api/sessions', undefined, 'wrong')).status, 401)
    const health = await fetch(`${t.base}/api/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).stamp, codeStamp('hub'), 'the hub says which code it was started from')
    assert.equal((await fetch(`${t.base}/`)).status, 200) // the web UI shell
  })
})

describe('channel: messages pushed into a session', () => {
  it('declares itself a channel with permission relay', async () => {
    const c = await fakeClaude('alpha')
    try {
      const caps = c.client.getServerCapabilities() as { experimental?: Record<string, unknown>; tools?: unknown }
      assert.ok(caps.experimental?.['claude/channel'])
      assert.ok(caps.experimental?.['claude/channel/permission'])
      assert.match(c.client.getInstructions() ?? '', /<channel source="switchboard"/)
      const tools = (await c.client.listTools()).tools.map(x => x.name)
      for (const name of ['reply', 'send_message', 'search_history', 'task_create', 'phone']) assert.ok(tools.includes(name), name)
      assert.ok(!tools.includes('spawn_session'), 'workers do not get session control')
    } finally {
      await c.close()
    }
  })

  it('pushes your message in, records delivery, and carries the reply back', async () => {
    const c = await fakeClaude('alpha')
    try {
      const sent = await t.api('POST', '/api/messages', { to: 'alpha', body: 'run the tests', kind: 'voice', meta: { via: 'voice' } })
      assert.equal(sent.status, 200)
      const ev = await waitFor(() => c.events.find(e => e.content === 'run the tests'), 'the channel event')
      assert.deepEqual({ from: ev.meta?.from, via: ev.meta?.via, id: ev.meta?.message_id }, { from: 'user', via: 'voice', id: String(sent.data.id) })
      await waitFor(async () => (await t.api('GET', `/api/messages?with=alpha`)).data.find((m: any) => m.id === sent.data.id)?.delivered_at, 'delivered_at')

      assert.match(await c.text('reply', { text: 'All green.' }), /Sent to the user/)
      const thread = (await t.api('GET', '/api/messages?with=alpha')).data
      assert.deepEqual(thread.slice(-2).map((m: any) => `${m.from_id}->${m.to_id}:${m.body}`), ['user->alpha:run the tests', 'alpha->user:All green.'])
    } finally {
      await c.close()
    }
  })

  it('queues messages for a session that is offline and delivers them when it connects', async () => {
    await t.api('POST', '/api/messages', { from: 'alpha', to: 'user', body: 'make sure alpha exists' })
    const queued = await t.api('POST', '/api/messages', { to: 'alpha', body: 'while you were away' })
    assert.equal(queued.data.delivered_at, null)
    const c = await fakeClaude('alpha')
    try {
      await waitFor(() => c.events.find(e => e.content === 'while you were away'), 'the queued message')
    } finally {
      await c.close()
    }
  })

  it('lets sessions message each other', async () => {
    const a = await fakeClaude('alpha')
    const b = await fakeClaude('beta')
    try {
      await a.text('send_message', { to: 'beta', text: 'can you review my diff?' })
      const ev = await waitFor(() => b.events.find(e => e.content === 'can you review my diff?'), 'the message in beta')
      assert.equal(ev.meta?.from, 'alpha')
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('relays a tool approval to the phone and the verdict back', async () => {
    const c = await fakeClaude('alpha')
    const phone = new WebSocket(`${t.base.replace('http', 'ws')}/ws?token=${t.cfg.token}&platform=ios&device=phone-1&name=Phone`)
    const seen: any[] = []
    phone.on('message', d => seen.push(JSON.parse(String(d))))
    try {
      await waitFor(() => seen.some(e => e.type === 'hello'), 'hello')
      await c.client.notification({
        method: 'notifications/claude/channel/permission_request',
        params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run the test suite', input_preview: '{"command":"npm test"}' },
      })
      const req = await waitFor(() => seen.find(e => e.type === 'permission' && e.request.request_id === 'abcde')?.request, 'the approval on the phone')
      assert.equal(req.session, 'alpha')
      const decided = await t.api('POST', `/api/permissions/${req.id}`, { behavior: 'allow' })
      assert.equal(decided.data.status, 'allow')
      await waitFor(() => c.verdicts.find(v => v.request_id === 'abcde' && v.behavior === 'allow'), 'the verdict in the session')
      assert.equal((await t.api('POST', `/api/permissions/${req.id}`, { behavior: 'deny' })).status, 400, 'cannot answer twice')
    } finally {
      phone.close()
      await c.close()
    }
  })

  it('answers an approval by voice ("approve")', async () => {
    const c = await fakeClaude('alpha')
    try {
      await c.client.notification({
        method: 'notifications/claude/channel/permission_request',
        params: { request_id: 'fghij', tool_name: 'Write', description: 'Create notes.md', input_preview: '{}' },
      })
      await waitFor(async () => (await t.api('GET', '/api/permissions')).data.length, 'pending approval')
      const r = await t.api('POST', '/api/utterance', { text: 'Approve.', to: 'alpha' })
      assert.equal(r.data.intent.kind, 'permission')
      await waitFor(() => c.verdicts.find(v => v.request_id === 'fghij' && v.behavior === 'allow'), 'voice verdict')
    } finally {
      await c.close()
    }
  })

  it('reconnects after the hub drops the connection', async () => {
    const c = await fakeClaude('alpha')
    try {
      t.bus.channels.get('alpha')!.ws.terminate()
      await waitFor(() => !t.bus.isConnected('alpha'), 'disconnect')
      await waitFor(() => t.bus.isConnected('alpha'), 'reconnect', 15_000)
    } finally {
      await c.close()
    }
  })
})

describe('backlog', () => {
  it('creates, updates and searches tasks with history', async () => {
    const c = await fakeClaude('gamma', 'orchestrator')
    try {
      await c.text('project_create', { slug: 'bets', name: 'BlessedBets', path: '/code/bets' })
      assert.match(await c.text('task_create', { title: 'Fix stale odds cache', project: 'bets', priority: 'p0', status: 'todo' }), /#\d+ \[P0 urgent\] \[todo\]/)
      const [task] = (await t.api('GET', '/api/tasks?project=bets')).data
      await c.text('task_update', { id: task.id, status: 'in_progress', assignee: 'gamma', comment: 'Reproduced it' })
      const got = (await t.api('GET', `/api/tasks/${task.id}`)).data
      assert.equal(got.status, 'in_progress')
      assert.ok(got.started_at)
      assert.deepEqual(got.events.map((e: any) => e.kind), ['created', 'updated', 'comment'])
      assert.match(await c.text('tasks_list', { project: 'bets' }), /Fix stale odds cache/)
      const bad = await t.api('POST', '/api/tasks', { title: 'x', priority: 'p9' })
      assert.equal(bad.status, 400)
    } finally {
      await c.close()
    }
  })
})

describe('history', () => {
  it('searches messages, transcripts and tasks, and marks messages Claude has seen', async () => {
    await t.api('POST', '/api/messages', { from: 'alpha', to: 'user', body: 'The flaky test was a timezone bug in the settlement code.' })
    const pushed = await t.api('POST', '/api/messages', { to: 'alpha', body: 'thanks' })
    const transcript = path.join(t.dataDir, 'alpha.jsonl')
    fs.writeFileSync(
      transcript,
      [
        { type: 'user', uuid: crypto.randomUUID(), sessionId: 'sid', timestamp: new Date().toISOString(), message: { role: 'user', content: 'what about the zebra migration?' } },
        { type: 'user', uuid: crypto.randomUUID(), sessionId: 'sid', message: { content: `<channel source="switchboard" from="user" message_id="${pushed.data.id}">thanks</channel>` } },
      ]
        .map(x => JSON.stringify(x))
        .join('\n') + '\n',
    )
    await t.api('POST', '/api/hooks', { event: 'Stop', session: 'alpha', payload: { hook_event_name: 'Stop', session_id: 'sid', transcript_path: transcript } })
    const hits = (await t.api('GET', '/api/search?q=timezone settlement')).data
    assert.equal(hits[0].source, 'message')
    assert.match(hits[0].snippet, /\[\[timezone\]\]/)
    assert.equal((await t.api('GET', '/api/search?q=zebra')).data[0].source, 'transcript')
    const seen = (await t.api('GET', '/api/messages?with=alpha')).data.find((m: any) => m.id === pushed.data.id)
    assert.ok(seen.seen_at, 'seen_at set from the transcript')
  })
})

describe('the phone', () => {
  it('runs a phone action on the connected app and returns its answer', async () => {
    const phone = new WebSocket(`${t.base.replace('http', 'ws')}/ws?token=${t.cfg.token}&platform=android&device=phone-2&name=Pixel`)
    phone.on('message', d => {
      const ev = JSON.parse(String(d))
      if (ev.type === 'device_command') phone.send(JSON.stringify({ type: 'device_result', id: ev.id, ok: true, result: { level: '81%', action: ev.action } }))
    })
    await new Promise(r => phone.on('open', r))
    try {
      const r = await t.api('POST', '/api/devices/actions', { action: 'get_battery', params: {} })
      assert.deepEqual(r.data, { ok: true, result: { level: '81%', action: 'get_battery' } })
    } finally {
      phone.close()
    }
  })

  it('sends a Flic press to the device in walk mode', async () => {
    const phone = new WebSocket(`${t.base.replace('http', 'ws')}/ws?token=${t.cfg.token}&platform=ios&device=phone-3&name=iPhone`)
    const got: any[] = []
    phone.on('message', d => got.push(JSON.parse(String(d))))
    await new Promise(r => phone.on('open', r))
    try {
      assert.equal((await t.api('GET', '/api/ptt/toggle')).status, 409, 'nobody listening yet')
      phone.send(JSON.stringify({ type: 'state', voice: true, walk: true, foreground: false }))
      await new Promise(r => setTimeout(r, 100))
      const r = await fetch(`${t.base}/api/ptt/toggle?token=${t.cfg.token}`, { method: 'POST' })
      assert.equal(r.status, 200)
      await waitFor(() => got.find(e => e.type === 'ptt' && e.action === 'toggle'), 'the ptt event')
    } finally {
      phone.close()
    }
  })
})

describe('phone app updates', () => {
  it('serves a published update over the Expo Updates protocol', async () => {
    const dir = path.join(updatesRoot(t.cfg.dataDir), '1', 'test-update')
    fs.mkdirSync(path.join(dir, 'bundles'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'bundles', 'ios.hbc'), 'ios bundle')
    fs.writeFileSync(path.join(dir, 'assets', 'abc'), 'png bytes')
    fs.writeFileSync(
      path.join(dir, 'metadata.json'),
      JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { ios: { bundle: 'bundles/ios.hbc', assets: [{ path: 'assets/abc', ext: 'png' }] } } }),
    )
    fs.writeFileSync(path.join(dir, 'expoConfig.json'), JSON.stringify({ name: 'Switchboard', runtimeVersion: '1' }))
    const reg = await t.api('POST', '/api/app/updates', { dir, message: 'test' })
    assert.equal(reg.status, 200, JSON.stringify(reg.data))

    const res = await fetch(`${t.base}/updates/manifest`, { headers: { 'expo-protocol-version': '1', 'expo-platform': 'ios', 'expo-runtime-version': '1' } })
    assert.equal(res.headers.get('expo-protocol-version'), '1')
    const body = await res.text()
    const json = JSON.parse(/name="manifest"\r\nContent-Type: [^\r]+\r\n\r\n(.+)\r\n/.exec(body)![1])
    assert.equal(json.id, reg.data.id)
    assert.equal(json.launchAsset.contentType, 'application/javascript')
    assert.equal(json.launchAsset.hash, crypto.createHash('sha256').update('ios bundle').digest('base64url'))
    assert.equal(json.assets[0].contentType, 'image/png')
    const asset = await fetch(json.assets[0].url)
    assert.equal(await asset.text(), 'png bytes')

    const again = await fetch(`${t.base}/updates/manifest`, {
      headers: { 'expo-protocol-version': '1', 'expo-platform': 'ios', 'expo-runtime-version': '1', 'expo-current-update-id': json.id },
    })
    assert.match(await again.text(), /noUpdateAvailable/)
    assert.equal((await fetch(`${t.base}/updates/assets?update=${json.id}&path=../../token`)).status, 404, 'no path escapes')
  })
})

describe('pairing a phone', () => {
  it('gives out a short link that opens Switchboard signed in, typed or scanned, and tells the app the token', async () => {
    assert.equal((await t.api('POST', '/api/pair/codes', {}, 'wrong')).status, 401, 'only a paired device can make a link')
    const { data } = await t.api('POST', '/api/pair/codes', {})
    assert.match(data.code, /^[A-HJKMNP-Z2-9]{8}$/, 'no letters or digits that look alike')
    assert.equal(data.url, `${t.base}/p/${data.code}`)
    assert.equal(data.qr_text, data.url.toUpperCase())
    assert.match(data.qr_svg, /<svg/)
    assert.ok(new Date(data.expires_at).getTime() - Date.now() > 14 * 60_000)

    for (const path of [`/p/${data.code}`, `/P/${data.code}`, `/p/${data.code.toLowerCase()}`]) {
      const res = await fetch(`${t.base}${path}`, { redirect: 'manual' })
      assert.equal(res.status, 302, path)
      assert.equal(res.headers.get('location'), `/#token=${t.cfg.token}`)
    }
    const forApp = await fetch(data.url, { headers: { accept: 'application/json' } })
    assert.deepEqual(await forApp.json(), { url: t.base, token: t.cfg.token })

    const wrong = await fetch(`${t.base}/p/ZZZZZZZZ`, { redirect: 'manual' })
    assert.equal(wrong.status, 410)
    assert.match(await wrong.text(), /expired/)
    const info = (await t.api('GET', '/api/pair')).data
    assert.ok(info.flic.toggle.includes('/api/ptt/toggle'))
    assert.equal(JSON.stringify(info).includes('qr'), false, 'the long-lived token is no longer put in a QR code')
  })
})

describe('the home-screen icon', () => {
  it('hands a paired page a start address that carries the pairing, and nobody else', async () => {
    const plain = await (await fetch(`${t.base}/manifest.webmanifest`)).json()
    assert.equal(plain.start_url, './#/')
    const paired = await (await fetch(`${t.base}/manifest.webmanifest?token=${t.cfg.token}`)).json()
    assert.equal(paired.start_url, `./#token=${t.cfg.token}`)
    const wrong = await (await fetch(`${t.base}/manifest.webmanifest?token=nope`)).json()
    assert.equal(wrong.start_url, './#/')
  })
})

describe('what a session is started with', () => {
  it('lets Switchboard tools run without asking, and nothing else', async () => {
    const settings = JSON.parse(fs.readFileSync(t.sessions.writeSettings(), 'utf8'))
    assert.deepEqual(settings.permissions, { allow: ['mcp__switchboard'] })
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']) assert.ok(settings.hooks[event], event)
  })

  it('gives only the orchestrator access to the Switchboard folder', async () => {
    const boss = t.sessions.claudeCommand({ name: 'boss', role: 'orchestrator' })
    const worker = t.sessions.claudeCommand({ name: 'w', role: 'worker' })
    assert.equal(boss[boss.indexOf('--add-dir') + 1], ROOT)
    assert.ok(!worker.includes('--add-dir'))
    for (const cmd of [boss, worker]) {
      assert.equal(cmd[cmd.indexOf('--dangerously-load-development-channels') + 1], 'server:switchboard')
      // --add-dir and --mcp-config take several values: each must be followed by another flag.
      for (const flag of ['--add-dir', '--mcp-config']) {
        const i = cmd.indexOf(flag)
        if (i !== -1) assert.match(cmd[i + 2], /^--/, `${flag} is followed by a flag`)
      }
    }
  })

  it('refuses a session asking for another session with no permission checks', async () => {
    await t.api('POST', '/api/messages', { from: 'alpha', to: 'user', body: 'alpha exists' })
    const r = await t.api('POST', '/api/sessions', { name: 'sneaky', cwd: t.dataDir, permission_mode: 'bypassPermissions', by: 'alpha' })
    assert.equal(r.status, 403)
    assert.match(r.data.error, /Only the human/)
  })
})

describe('sessions in tmux', () => {
  it('starts a session, answers its startup dialogs, delivers the first prompt, and stops it', async () => {
    const work = fs.mkdtempSync(path.join(t.dataDir, 'work-'))
    const events = path.join(t.dataDir, 'fake-events.log')
    process.env.FAKE_CLAUDE_STATE = t.dataDir
    process.env.FAKE_CLAUDE_EVENTS = events
    const r = await t.api('POST', '/api/sessions', { name: 'worker1', cwd: work, prompt: 'Read the README and summarize it' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.ready, true, r.data.note + '\n' + (r.data.screen ?? ''))
    assert.match(r.data.note, /dev_channels/)
    assert.match(r.data.note, /trust_folder/)
    await waitFor(() => fs.existsSync(events) && fs.readFileSync(events, 'utf8').includes('Read the README and summarize it'), 'the first prompt in the session')

    await t.api('POST', '/api/sessions/worker1/keys', { text: 'typed from the phone', enter: true })
    await waitFor(() => fs.readFileSync(events, 'utf8').includes('TYPED typed from the phone'), 'keys typed into the terminal')
    const screen = (await t.api('GET', '/api/sessions/worker1/screen')).data.screen
    assert.match(screen, /Fake Claude Code/)

    // A tool approval on its screen is the human's to answer: another session's keys are refused, yours are not.
    await t.api('POST', '/api/sessions/worker1/keys', { text: '/approve-me', enter: true })
    await waitFor(async () => /Do you want to proceed/.test((await t.api('GET', '/api/sessions/worker1/screen')).data.screen), 'the approval on screen')
    const refused = await t.api('POST', '/api/sessions/worker1/keys', { keys: ['1'], by: 'alpha' })
    assert.equal(refused.status, 403)
    assert.match(refused.data.error, /tool approval/)
    assert.equal((await t.api('POST', '/api/sessions/worker1/keys', { keys: ['Enter'] })).status, 200)

    const dup = await t.api('POST', '/api/sessions', { name: 'worker1', cwd: work })
    assert.equal(dup.status, 400, 'no second session with the same name')

    const stopped = await t.api('POST', '/api/sessions/worker1/stop', {})
    assert.equal(stopped.data.status, 'offline')
    assert.equal(await t.tmux.has(`${t.cfg.tmuxPrefix}worker1`), false)
  })

  it('never passes "default" as a permission mode, which Claude Code rejects', () => {
    assert.ok(!t.sessions.claudeCommand({ name: 'w', role: 'worker', permission_mode: 'default' }).includes('--permission-mode'))
    const edits = t.sessions.claudeCommand({ name: 'w', role: 'worker', permission_mode: 'acceptEdits' })
    assert.equal(edits[edits.indexOf('--permission-mode') + 1], 'acceptEdits')
  })

  it('types messages into the terminal when Claude Code says channels are not available, and never over a question', async () => {
    const work = fs.mkdtempSync(path.join(t.dataDir, 'work2-'))
    const events = path.join(t.dataDir, 'fake-events.log')
    const typed = () => fs.readFileSync(events, 'utf8')
    const r = await t.api('POST', '/api/sessions', { name: 'worker2', cwd: work, prompt: 'first job', extra_args: ['--fake-no-channels'] })
    assert.equal(r.data.ready, true, r.data.note + '\n' + (r.data.screen ?? ''))
    assert.match(r.data.note, /not available on this account.*typed into its terminal/)
    assert.equal(r.data.session.delivery, 'keys')
    await waitFor(() => /TYPED \[switchboard from="user" via="spawn" id="\d+"\] first job/.test(typed()), 'the first prompt, typed')

    const next = await t.api('POST', '/api/messages', { to: 'worker2', body: 'second job', kind: 'voice', meta: { via: 'voice' } })
    await waitFor(() => typed().includes(`[switchboard from="user" via="voice" id="${next.data.id}"] second job`), 'a later message, typed')
    await waitFor(async () => (await t.api('GET', '/api/messages?with=worker2')).data.find((m: any) => m.id === next.data.id)?.delivered_at, 'delivery recorded')

    // With an approval on its screen, typing would answer it: the message waits.
    await t.api('POST', '/api/sessions/worker2/keys', { text: '/approve-me', enter: true })
    await waitFor(async () => /Do you want to proceed/.test((await t.api('GET', '/api/sessions/worker2/screen')).data.screen), 'the approval on screen')
    const held = await t.api('POST', '/api/messages', { to: 'worker2', body: 'third job' })
    await new Promise(r => setTimeout(r, 1200))
    assert.ok(!typed().includes('third job'), 'nothing typed over the approval')
    await t.api('POST', '/api/sessions/worker2/keys', { keys: ['Enter'] }) // you answer it
    await waitFor(async () => !/Do you want to proceed/.test((await t.api('GET', '/api/sessions/worker2/screen')).data.screen), 'the approval gone')
    await t.sessions.pollOnce()
    await waitFor(() => typed().includes(`id="${held.data.id}"] third job`), 'the held message, typed once the screen is clear')
    await t.api('POST', '/api/sessions/worker2/stop', {})
  })
})
