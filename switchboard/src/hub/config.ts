import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The switchboard package root (the directory holding package.json). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface SttConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface Config {
  port: number
  host: string
  dataDir: string
  token: string
  /** null means: run Postgres embedded in dataDir/postgres. */
  databaseUrl: string | null
  embeddedPgPort: number
  /** The address phones and the Flic button use to reach the hub, e.g. https://mac.tailnet.ts.net */
  publicUrl: string | null
  tmuxPrefix: string
  /** `tmux`, or its full path when it is installed somewhere the shell's PATH does not cover. */
  tmuxBin: string
  /** `claude`, or its full path (same reason). */
  claudeBin: string
  claudeArgs: string[]
  /** Name of the session that runs everything else. */
  orchestrator: string
  orchestratorCwd: string
  stt: SttConfig | null
  /** Answer Claude Code's development-channel and folder-trust dialogs when the hub starts a session. */
  autoAcceptDialogs: boolean
  /** Serve the phone app's over-the-air update manifest without a token. The bundle holds no secrets. */
  updatesPublic: boolean
  expoAccessToken: string | null
  packageRoot: string
}

/**
 * Settings come from the environment, after loading switchboard/.env and
 * ~/.switchboard/.env if they exist (the shell wins over both).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { quiet?: boolean } = {}): Config {
  for (const file of [path.join(PACKAGE_ROOT, '.env'), path.join(defaultDataDir(env), '.env')]) {
    if (env === process.env && fs.existsSync(file)) {
      try {
        process.loadEnvFile(file)
      } catch (err) {
        if (!opts.quiet) console.warn(`[switchboard] could not read ${file}: ${(err as Error).message}`)
      }
    }
  }

  const dataDir = path.resolve(expandHome(env.SWITCHBOARD_DATA_DIR || defaultDataDir(env)))
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  const sttKey = env.STT_API_KEY || env.OPENAI_API_KEY || env.GROQ_API_KEY || ''
  const sttBase =
    env.STT_BASE_URL ||
    (env.STT_API_KEY || env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : env.GROQ_API_KEY ? 'https://api.groq.com/openai/v1' : '')
  const sttModel =
    env.STT_MODEL || (sttBase.includes('groq.com') ? 'whisper-large-v3-turbo' : sttBase.includes('openai.com') ? 'gpt-4o-mini-transcribe' : 'whisper-1')

  return {
    port: intEnv(env.SWITCHBOARD_PORT, 7700),
    host: env.SWITCHBOARD_HOST || '127.0.0.1',
    dataDir,
    token: env.SWITCHBOARD_TOKEN || readOrCreateSecret(path.join(dataDir, 'token')),
    databaseUrl: env.DATABASE_URL || env.SWITCHBOARD_DATABASE_URL || null,
    embeddedPgPort: intEnv(env.SWITCHBOARD_PG_PORT, 54329),
    publicUrl: env.SWITCHBOARD_PUBLIC_URL ? env.SWITCHBOARD_PUBLIC_URL.replace(/\/+$/, '') : null,
    tmuxPrefix: env.SWITCHBOARD_TMUX_PREFIX || 'sb-',
    tmuxBin: resolveBin(env.TMUX_BIN || 'tmux', TMUX_DIRS, env),
    claudeBin: resolveBin(env.CLAUDE_BIN || 'claude', CLAUDE_DIRS, env),
    claudeArgs: splitArgs(env.SWITCHBOARD_CLAUDE_ARGS || ''),
    orchestrator: env.SWITCHBOARD_ORCHESTRATOR || 'boss',
    orchestratorCwd: path.resolve(expandHome(env.SWITCHBOARD_ORCHESTRATOR_CWD || path.join(PACKAGE_ROOT, 'orchestrator'))),
    stt: sttBase && (sttKey || env.STT_BASE_URL) ? { baseUrl: sttBase.replace(/\/+$/, ''), apiKey: sttKey, model: sttModel } : null,
    autoAcceptDialogs: env.SWITCHBOARD_AUTO_ACCEPT_DIALOGS !== '0',
    updatesPublic: env.SWITCHBOARD_UPDATES_PUBLIC !== '0',
    expoAccessToken: env.EXPO_ACCESS_TOKEN || null,
    packageRoot: PACKAGE_ROOT,
  }
}

/** Where Homebrew puts things on Apple-silicon and Intel Macs; neither is on the PATH until Homebrew's "Next steps" are run. */
export const BREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']
const TMUX_DIRS = [...BREW_DIRS, '/usr/bin']
/** Claude Code's own installer uses ~/.local/bin, which a new Mac does not have on its PATH. */
const CLAUDE_DIRS = ['~/.local/bin', '~/.claude/local', ...BREW_DIRS]

/**
 * Find a command the way the shell would, then in the places installers put it
 * that the shell may not look. Returns the bare name when the PATH has it (or
 * when it is nowhere, so the caller's "not found" still names it), and the full
 * path when it only exists in one of `dirs`.
 */
export function resolveBin(name: string, dirs: string[], env: NodeJS.ProcessEnv = process.env): string {
  if (name.includes('/')) return expandHome(name)
  if (findOnPath(name, env)) return name
  for (const dir of dirs) {
    const full = path.join(expandHome(dir), name)
    if (isExecutable(full)) return full
  }
  return name
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const full = path.join(dir, name)
    if (isExecutable(full)) return full
  }
  return null
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SWITCHBOARD_DATA_DIR ? expandHome(env.SWITCHBOARD_DATA_DIR) : path.join(os.homedir(), '.switchboard')
}

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

/** A random secret kept in a file only this user can read, created on first use. */
export function readOrCreateSecret(file: string): string {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // first run
  }
  const secret = crypto.randomBytes(24).toString('base64url')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 })
  return secret
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

/** Split a flag string the way a shell would for simple cases: spaces, with single or double quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (const m of input.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]))
  return out
}

/** The placeholder address from the instructions, pasted as-is. */
export function isExampleUrl(url: string | null | undefined): boolean {
  return Boolean(url && /your-mac\.tail1234|REPLACE-ME|your-tailnet|PASTE/i.test(url))
}

/** Set one KEY=value line in switchboard/.env, replacing any earlier line for that key. */
export function setEnvVar(key: string, value: string, file = path.join(PACKAGE_ROOT, '.env')): void {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []
  const kept = lines.filter(l => !new RegExp(`^\\s*${key}\\s*=`).test(l))
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  kept.push(`${key}=${value}`)
  fs.writeFileSync(file, kept.join('\n') + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/** Constant-time token check. */
export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
