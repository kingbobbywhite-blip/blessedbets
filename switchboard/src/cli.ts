#!/usr/bin/env node
/**
 * switchboard: run the hub, start and steer Claude Code sessions, pair your
 * phone, publish app updates. `switchboard help` lists everything.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import QRCode from 'qrcode'
import { loadConfig, PACKAGE_ROOT, type Config } from './hub/config.ts'
import { Tmux, shellQuote } from './hub/tmux.ts'
import { updateIdFor, updatesRoot } from './hub/updates.ts'
import type { Message, SearchHit, Session, Task } from './shared/protocol.ts'

const HELP = `switchboard <command>

Running it
  up                      Start the hub (in tmux) and the orchestrator session
  start                   Run the hub in this terminal
  down                    Stop the hub (sessions keep running; --all stops them too)
  doctor                  Check tmux, claude, Node, the database, speech, the phone address
  pair                    QR codes for the phone app and for a browser
  flic                    The Flic button links (push to talk)
  install-mcp             Add the Switchboard channel to every Claude Code session you start by hand

Sessions
  ls                      List sessions
  spawn <name> [--cwd DIR] [--prompt TEXT] [--model M] [--role worker|orchestrator]
                          [--permission-mode MODE] [--description TEXT]
  send <name> <text...>   Message a session (it is pushed straight in)
  screen <name> [--lines N]
  keys <name> <key...>    Press keys in its terminal (Enter, Escape, Down, 1, ...)
  interrupt <name>        Press Escape
  restart <name> [--fresh]
  stop <name>
  attach <name>           Open its terminal (tmux attach)
  log [--with NAME] [--limit N]

Backlog
  tasks [--project P] [--status s1,s2] [--assignee A] [--all]
  task add <title...> [--project P] [--priority P0-P3] [--status S] [--assignee A] [--body TEXT]
  task <id> [status=S] [priority=P] [assignee=A] [title=T] [comment=TEXT]
  projects
  project add <slug> [--name N] [--path DIR] [--description TEXT]

History
  search <words...> [--session NAME]

Phone app
  app setup               Point the app's builds (mobile/eas.json) at SWITCHBOARD_PUBLIC_URL
  app publish [--message TEXT] [--platform ios,android]   Over-the-air update every paired phone picks up by itself
  app list
  app rollback [--platform ios|android]
  app native <file.apk> --version X.Y.Z [--message TEXT]   Offer a new Android build
`

const cfg = loadConfig(process.env, { quiet: true })
const base = `http://${cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host}:${cfg.port}`
const tmux = new Tmux(process.env.SWITCHBOARD_TMUX_SOCKET || '')
const HUB_TMUX = `${cfg.tmuxPrefix}hub`

async function api<T = any>(method: string, p: string, body?: unknown, timeoutMs = 160_000): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${p}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    fail(`The hub is not running at ${base}. Start it with: switchboard up`)
  }
  const text = await res.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : null
  if (!res.ok) fail((data && (data as { error?: string }).error) || `${res.status} ${res.statusText}`)
  return data as T
}

function fail(msg: string): never {
  console.error(`switchboard: ${msg}`)
  process.exit(1)
}

async function hubUp(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

function flags(argv: string[], options: Record<string, { type: 'string' | 'boolean'; short?: string }>) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: false })
}

function statusLine(s: Session): string {
  const live = s.connected ? '' : s.status === 'offline' || s.status === 'exited' ? '' : ' (channel not connected)'
  return `${s.role === 'orchestrator' ? '★' : ' '} ${s.name.padEnd(16)} ${s.status.padEnd(9)}${live} ${s.status_text ? `"${s.status_text}" ` : ''}${s.cwd ?? ''}`
}

function fmtTask(t: Task): string {
  return `#${String(t.id).padEnd(4)} P${t.priority} ${t.status.padEnd(11)} ${t.title}  (${t.project}${t.assignee ? ` @${t.assignee}` : ''})`
}

const [cmd = 'help', ...rest] = process.argv.slice(2)

switch (cmd) {
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP)
    break

  case 'start':
    await import('./hub/main.ts').then(m => m.startHub())
    break

  case 'up': {
    if (!(await tmux.available())) fail('tmux is not installed (brew install tmux / apt install tmux)')
    if (!(await hubUp())) {
      if (await tmux.has(HUB_TMUX)) await tmux.kill(HUB_TMUX)
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v && (/^(SWITCHBOARD_|STT_|DATABASE_URL$|OPENAI_API_KEY$|GROQ_API_KEY$|CLAUDE_BIN$|EXPO_ACCESS_TOKEN$|PATH$|HOME$|LANG$)/.test(k))) env[k] = v
      }
      await tmux.newSession({ name: HUB_TMUX, cwd: PACKAGE_ROOT, command: [process.execPath, path.join(PACKAGE_ROOT, 'src/hub/main.ts')], env })
      process.stdout.write('Starting the hub')
      for (let i = 0; i < 120 && !(await hubUp()); i++) {
        await new Promise(r => setTimeout(r, 500))
        process.stdout.write('.')
      }
      console.log('')
      if (!(await hubUp())) {
        console.log(await tmux.capture(HUB_TMUX, 40).catch(() => ''))
        fail(`The hub did not start. Its terminal is above (tmux attach -t ${HUB_TMUX}).`)
      }
    }
    const sessions = await api<Session[]>('GET', '/api/sessions')
    const boss = sessions.find(s => s.name === cfg.orchestrator)
    if (!boss || !['idle', 'busy', 'waiting', 'starting'].includes(boss.status) || !(await tmux.has(`${cfg.tmuxPrefix}${cfg.orchestrator}`))) {
      console.log(`Starting the orchestrator session "${cfg.orchestrator}" in ${cfg.orchestratorCwd} ...`)
      const r = await api('POST', '/api/sessions', { name: cfg.orchestrator, role: 'orchestrator', cwd: cfg.orchestratorCwd })
      console.log(`${r.session.name}: ${r.note}`)
      if (r.screen) console.log(r.screen)
    }
    console.log(`\nWeb UI: ${base}/#token=${cfg.token}`)
    console.log(`Orchestrator terminal: switchboard attach ${cfg.orchestrator}`)
    console.log(cfg.publicUrl ? `Phone: switchboard pair` : `Phone: set SWITCHBOARD_PUBLIC_URL first (see README), then switchboard pair`)
    break
  }

  case 'down': {
    const { values } = flags(rest, { all: { type: 'boolean' } })
    if (values.all && (await hubUp())) {
      for (const s of await api<Session[]>('GET', '/api/sessions')) {
        if (s.managed && s.status !== 'offline') {
          await api('POST', `/api/sessions/${s.name}/stop`, {})
          console.log(`stopped ${s.name}`)
        }
      }
    }
    if (await tmux.has(HUB_TMUX)) {
      await tmux.keys(HUB_TMUX, ['C-c'])
      for (let i = 0; i < 20 && (await hubUp()); i++) await new Promise(r => setTimeout(r, 250))
      await tmux.kill(HUB_TMUX)
      console.log('Hub stopped.')
    } else console.log('The hub is not running under switchboard up.')
    break
  }

  case 'ls':
  case 'status': {
    const sessions = await api<Session[]>('GET', '/api/sessions')
    if (!sessions.length) console.log('No sessions. Start one: switchboard spawn <name> --cwd <dir>')
    for (const s of sessions) console.log(statusLine(s))
    break
  }

  case 'spawn': {
    const { values, positionals } = flags(rest, {
      cwd: { type: 'string' },
      prompt: { type: 'string' },
      model: { type: 'string' },
      role: { type: 'string' },
      'permission-mode': { type: 'string' },
      description: { type: 'string' },
    })
    const name = positionals[0] ?? fail('spawn needs a name')
    const r = await api('POST', '/api/sessions', {
      name,
      cwd: values.cwd ? path.resolve(String(values.cwd)) : process.cwd(),
      prompt: values.prompt,
      model: values.model,
      role: values.role,
      permission_mode: values['permission-mode'],
      description: values.description,
    })
    console.log(`${r.session.name}: ${r.note}`)
    if (r.screen) console.log(r.screen)
    break
  }

  case 'send': {
    const [name, ...words] = rest
    if (!name || !words.length) fail('usage: switchboard send <name> <text...>')
    const m = await api<Message>('POST', '/api/messages', { to: name, body: words.join(' '), meta: { via: 'cli' } })
    console.log(`sent (#${m.id})${m.delivered_at ? '' : ', queued until the session connects'}`)
    break
  }

  case 'screen': {
    const { values, positionals } = flags(rest, { lines: { type: 'string' } })
    const r = await api('GET', `/api/sessions/${positionals[0] ?? fail('screen needs a name')}/screen?lines=${values.lines ?? 0}`)
    console.log(r.screen)
    break
  }

  case 'keys': {
    const [name, ...keys] = rest
    if (!name || !keys.length) fail('usage: switchboard keys <name> <key...>')
    await api('POST', `/api/sessions/${name}/keys`, { keys })
    break
  }

  case 'interrupt':
  case 'stop':
  case 'restart': {
    const { values, positionals } = flags(rest, { fresh: { type: 'boolean' } })
    const name = positionals[0] ?? fail(`${cmd} needs a name`)
    const r = await api('POST', `/api/sessions/${name}/${cmd}`, cmd === 'restart' ? { fresh: Boolean(values.fresh) } : {})
    console.log(r?.note ? `${name}: ${r.note}` : `${cmd}: ${name}`)
    if (r?.screen) console.log(r.screen)
    break
  }

  case 'attach': {
    const name = rest[0] ?? cfg.orchestrator
    const target = name === 'hub' ? HUB_TMUX : `${cfg.tmuxPrefix}${name}`
    const args = [...(process.env.SWITCHBOARD_TMUX_SOCKET ? ['-L', process.env.SWITCHBOARD_TMUX_SOCKET] : []), process.env.TMUX ? 'switch-client' : 'attach', '-t', target]
    const r = spawnSync('tmux', args, { stdio: 'inherit' })
    process.exit(r.status ?? 0)
  }

  case 'log': {
    const { values } = flags(rest, { with: { type: 'string' }, limit: { type: 'string' } })
    const q = new URLSearchParams({ limit: String(values.limit ?? 30) })
    if (values.with) q.set('with', String(values.with))
    for (const m of await api<Message[]>('GET', `/api/messages?${q}`)) {
      console.log(`${m.created_at.slice(5, 16).replace('T', ' ')} ${m.from_id} → ${m.to_id}: ${m.body}`)
    }
    break
  }

  case 'tasks': {
    const { values } = flags(rest, { project: { type: 'string' }, status: { type: 'string' }, assignee: { type: 'string' }, all: { type: 'boolean' } })
    const q = new URLSearchParams()
    if (values.project) q.set('project', String(values.project))
    if (values.status) q.set('status', String(values.status))
    if (values.assignee) q.set('assignee', String(values.assignee))
    if (values.all) q.set('closed', '1')
    const tasks = await api<Task[]>('GET', `/api/tasks?${q}`)
    if (!tasks.length) console.log('No open tasks.')
    for (const t of tasks) console.log(fmtTask(t))
    break
  }

  case 'task': {
    if (rest[0] === 'add') {
      const { values, positionals } = flags(rest.slice(1), {
        project: { type: 'string' },
        priority: { type: 'string' },
        status: { type: 'string' },
        assignee: { type: 'string' },
        body: { type: 'string' },
      })
      const t = await api<Task>('POST', '/api/tasks', {
        title: positionals.join(' '),
        project: values.project,
        priority: values.priority,
        status: values.status,
        assignee: values.assignee,
        body: values.body,
        by: 'user',
      })
      console.log(fmtTask(t))
      break
    }
    const id = Number(rest[0])
    if (!id) fail('usage: switchboard task <id> [status=S] [priority=P] [assignee=A] [comment=TEXT]')
    if (rest.length === 1) {
      const t = await api('GET', `/api/tasks/${id}`)
      console.log(fmtTask(t))
      if (t.body) console.log(`\n${t.body}`)
      for (const e of t.events) console.log(`  ${e.created_at.slice(0, 16).replace('T', ' ')} ${e.actor}: ${e.kind === 'comment' ? e.body : e.kind === 'created' ? 'created' : JSON.stringify(e.data)}`)
      break
    }
    const patch: Record<string, string> = {}
    for (const kv of rest.slice(1)) {
      const i = kv.indexOf('=')
      if (i > 0) patch[kv.slice(0, i)] = kv.slice(i + 1)
    }
    console.log(fmtTask(await api<Task>('PATCH', `/api/tasks/${id}`, { ...patch, by: 'user' })))
    break
  }

  case 'projects': {
    for (const p of await api<{ slug: string; name: string; open_tasks: number; path: string | null }[]>('GET', '/api/projects')) {
      console.log(`${p.slug.padEnd(18)} ${String(p.open_tasks).padStart(3)} open  ${p.name}${p.path ? `  ${p.path}` : ''}`)
    }
    break
  }

  case 'project': {
    if (rest[0] !== 'add' || !rest[1]) fail('usage: switchboard project add <slug> [--name N] [--path DIR] [--description TEXT]')
    const { values } = flags(rest.slice(2), { name: { type: 'string' }, path: { type: 'string' }, description: { type: 'string' } })
    const p = await api('POST', '/api/projects', { slug: rest[1], name: values.name, path: values.path ? path.resolve(String(values.path)) : null, description: values.description })
    console.log(`project ${p.slug} ready`)
    break
  }

  case 'search': {
    const { values, positionals } = flags(rest, { session: { type: 'string' } })
    const q = new URLSearchParams({ q: positionals.join(' '), limit: '25' })
    if (values.session) q.set('session', String(values.session))
    const hits = await api<SearchHit[]>('GET', `/api/search?${q}`)
    if (!hits.length) console.log('Nothing found.')
    for (const h of hits) {
      const head = h.source === 'task' ? `task #${h.ref} ${h.title}` : `${h.source} ${h.from_id} → ${h.to_id}`
      console.log(`${String(h.created_at).slice(0, 16).replace('T', ' ')} ${head}\n    ${h.snippet.replace(/\[\[/g, '\x1b[1m').replace(/\]\]/g, '\x1b[0m')}`)
    }
    break
  }

  case 'pair': {
    const p = await api('GET', '/api/pair')
    if (!cfg.publicUrl) {
      console.log('Note: SWITCHBOARD_PUBLIC_URL is not set, so this uses the local address, which a phone off this computer cannot reach.\n')
    }
    console.log('Phone app: open Switchboard and scan this\n')
    console.log(await QRCode.toString(p.app_url, { type: 'terminal', small: true }))
    console.log(`Browser (add to home screen): ${p.web_url}\n`)
    console.log(await QRCode.toString(p.web_url, { type: 'terminal', small: true }))
    console.log('Both codes carry your token: do not share them.')
    break
  }

  case 'flic': {
    const p = await api('GET', '/api/pair')
    console.log(`In the Flic app, add an "Internet Request" action (GET) to your button for each gesture:\n`)
    console.log(`  Click         toggle talking   ${p.flic.toggle}`)
    console.log(`  Double click  cancel / hush    ${p.flic.cancel}`)
    console.log(`  Hold          start talking    ${p.flic.start}`)
    console.log(`\nThe press is sent to the phone that has walk mode on. With a Flic Hub, flic/hub-sdk-ptt.js gives true hold-to-talk.`)
    break
  }

  case 'install-mcp': {
    const args = ['mcp', 'add', '--scope', 'user', 'switchboard', '-e', `SWITCHBOARD_URL=${base}`, '-e', `SWITCHBOARD_DATA_DIR=${cfg.dataDir}`, '--', process.execPath, path.join(PACKAGE_ROOT, 'src/channel/main.ts')]
    console.log(`Running: ${cfg.claudeBin} ${args.map(shellQuote).join(' ')}`)
    const r = spawnSync(cfg.claudeBin, args, { stdio: 'inherit' })
    if (r.status !== 0) fail('claude mcp add failed')
    console.log(`\nNow start any session with the channel switched on:\n\n  claude --dangerously-load-development-channels server:switchboard\n`)
    console.log('It names itself after its tmux session or folder; set SWITCHBOARD_SESSION=<name> to choose.')
    break
  }

  case 'doctor':
    await doctor(cfg)
    break

  case 'app':
    await appCommand(rest)
    break

  default:
    console.log(HELP)
    fail(`unknown command "${cmd}"`)
}

async function doctor(c: Config) {
  const ok = (label: string, good: boolean, detail: string) => console.log(`${good ? '✓' : '✗'} ${label.padEnd(18)} ${detail}`)
  const nodeOk = Number(process.versions.node.split('.')[0]) > 22 || (process.versions.node.startsWith('22.') && Number(process.versions.node.split('.')[1]) >= 18)
  ok('Node', nodeOk, process.versions.node + (nodeOk ? '' : ' (need 22.18 or newer)'))
  const t = await tmux.available()
  ok('tmux', Boolean(t), t ?? 'not found')
  let claudeVersion = ''
  try {
    claudeVersion = execFileSync(c.claudeBin, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim()
  } catch {
    claudeVersion = ''
  }
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(claudeVersion)
  const channelsOk = Boolean(m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && (Number(m[2]) > 1 || Number(m[3]) >= 80))))
  ok('Claude Code', channelsOk, claudeVersion ? `${claudeVersion}${channelsOk ? '' : ' (channels need 2.1.80+)'}` : `${c.claudeBin} not found`)
  const up = await hubUp()
  ok('Hub', up, up ? base : `not running at ${base} (switchboard up)`)
  if (up) {
    const info = await api('GET', '/api/info')
    ok('Speech to text', true, info.stt ? `hub: ${info.stt_model}` : 'on-device only (set OPENAI_API_KEY, GROQ_API_KEY or STT_BASE_URL for hub transcription)')
    const sessions = await api<Session[]>('GET', '/api/sessions')
    ok('Sessions', true, `${sessions.length} (${sessions.filter(s => s.connected).length} connected)`)
    const devices = await api<{ name: string; online: boolean; push_token: string | null }[]>('GET', '/api/devices')
    ok('Phones', devices.length > 0, devices.length ? devices.map(d => `${d.name}${d.online ? ' (online)' : ''}${d.push_token ? ' push' : ''}`).join(', ') : 'none paired (switchboard pair)')
  }
  ok('Phone address', Boolean(c.publicUrl), c.publicUrl ?? 'SWITCHBOARD_PUBLIC_URL not set (see README: Tailscale)')
  if (c.publicUrl) {
    try {
      const r = await fetch(`${c.publicUrl}/api/health`, { signal: AbortSignal.timeout(5000) })
      ok('  reachable', r.ok, r.ok ? 'yes' : `HTTP ${r.status}`)
    } catch (err) {
      ok('  reachable', false, (err as Error).message)
    }
  }
  ok('Data', true, c.dataDir)
}

async function appCommand(args: string[]) {
  const sub = args[0]
  const mobile = path.join(PACKAGE_ROOT, 'mobile')
  if (sub === 'setup') {
    // EAS builds run on Expo's servers, which never see switchboard/.env: the address goes in eas.json.
    const url = cfg.publicUrl ?? fail('Set SWITCHBOARD_PUBLIC_URL in switchboard/.env first (README, step 4).')
    const file = path.join(mobile, 'eas.json')
    const eas = JSON.parse(fs.readFileSync(file, 'utf8')) as { build: Record<string, { env?: Record<string, string> }> }
    for (const profile of Object.keys(eas.build)) {
      eas.build[profile].env = { ...(eas.build[profile].env ?? {}), SWITCHBOARD_PUBLIC_URL: url }
    }
    fs.writeFileSync(file, JSON.stringify(eas, null, 2) + '\n')
    console.log(`The phone app will be built for ${url} (mobile/eas.json).`)
    console.log(`Next: cd ${mobile} && npm install && npx eas-cli build --platform android --profile preview`)
    return
  }
  if (sub === 'publish') {
    const { values } = flags(args.slice(1), { message: { type: 'string' }, platform: { type: 'string' } })
    if (!fs.existsSync(path.join(mobile, 'node_modules'))) fail(`Install the app's dependencies first: cd ${mobile} && npm install`)
    const platforms = String(values.platform ?? 'ios,android').split(',').map(s => s.trim()).filter(Boolean)
    if (!cfg.publicUrl) console.warn('Warning: SWITCHBOARD_PUBLIC_URL is not set. Phones fetch updates from the address their build was made with.')
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-export-'))
    const env = { ...process.env, SWITCHBOARD_PUBLIC_URL: cfg.publicUrl ?? process.env.SWITCHBOARD_PUBLIC_URL ?? '', EXPO_OFFLINE: '1', CI: '1' }
    console.log(`Bundling the app for ${platforms.join(' and ')} ...`)
    const exp = spawnSync('npx', ['expo', 'export', ...platforms.flatMap(p => ['--platform', p]), '--output-dir', out], { cwd: mobile, env, stdio: 'inherit' })
    if (exp.status !== 0) fail('expo export failed (see above)')
    const config = spawnSync('npx', ['expo', 'config', '--type', 'public', '--json'], { cwd: mobile, env, encoding: 'utf8' })
    if (config.status !== 0) fail(`expo config failed: ${config.stderr}`)
    const expoConfig = JSON.parse(config.stdout)
    if (typeof expoConfig.runtimeVersion !== 'string') fail('mobile/app.config.ts must set runtimeVersion to a string')
    fs.writeFileSync(path.join(out, 'expoConfig.json'), JSON.stringify(expoConfig))
    const id = updateIdFor(fs.readFileSync(path.join(out, 'metadata.json')))
    const dest = path.join(updatesRoot(cfg.dataDir), expoConfig.runtimeVersion, id)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(out, dest, { recursive: true })
    fs.rmSync(out, { recursive: true, force: true })
    const message = String(values.message ?? gitSummary())
    const u = await api('POST', '/api/app/updates', { dir: dest, message })
    console.log(`Published update ${u.id} for runtime ${u.runtime_version} (${u.platforms.join(', ')}). Paired phones pick it up on their own.`)
    return
  }
  if (sub === 'list') {
    for (const u of await api<{ id: string; runtime_version: string; platforms: string[]; message: string; created_at: string; rolled_back_at: string | null }[]>('GET', '/api/app/updates')) {
      console.log(`${u.created_at.slice(0, 16).replace('T', ' ')} ${u.id.slice(0, 8)} runtime ${u.runtime_version} ${u.platforms.join(',')}${u.rolled_back_at ? ' (rolled back)' : ''} ${u.message}`)
    }
    return
  }
  if (sub === 'rollback') {
    const { values } = flags(args.slice(1), { platform: { type: 'string' }, runtime: { type: 'string' } })
    const mobileConfig = fs.readFileSync(path.join(mobile, 'app.config.ts'), 'utf8')
    const runtime = String(values.runtime ?? /RUNTIME_VERSION = '([^']+)'/.exec(mobileConfig)?.[1] ?? '1')
    for (const platform of String(values.platform ?? 'ios,android').split(',')) {
      const r = await api('POST', '/api/app/updates/rollback', { runtime_version: runtime, platform })
      console.log(`${platform}: rolled back ${r.rolled_back}; now serving ${r.now_serving}`)
    }
    return
  }
  if (sub === 'native') {
    const { values, positionals } = flags(args.slice(1), { version: { type: 'string' }, message: { type: 'string' }, runtime: { type: 'string' } })
    const file = positionals[0] ?? fail('usage: switchboard app native <file.apk> --version X.Y.Z')
    if (!values.version) fail('--version is required')
    const dir = path.join(cfg.dataDir, 'builds')
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, `switchboard-${values.version}-${crypto.randomBytes(3).toString('hex')}.apk`)
    fs.copyFileSync(path.resolve(file), dest)
    const mobileConfig = fs.readFileSync(path.join(mobile, 'app.config.ts'), 'utf8')
    const runtime = String(values.runtime ?? /RUNTIME_VERSION = '([^']+)'/.exec(mobileConfig)?.[1] ?? '1')
    const b = await api('POST', '/api/app/native', { file: dest, version: values.version, runtime_version: runtime, message: values.message ?? '', platform: 'android' })
    console.log(`Offered Android build ${b.version} (sha256 ${b.sha256.slice(0, 12)}…). Phones see it under Settings → App updates.`)
    return
  }
  fail('usage: switchboard app setup|publish|list|rollback|native')
}

function gitSummary(): string {
  try {
    return execFileSync('git', ['log', '-1', '--format=%h %s'], { cwd: PACKAGE_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
