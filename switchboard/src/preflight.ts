import { execFileSync } from 'node:child_process'
import { BREW_DIRS, findOnPath, resolveBin, type Config } from './hub/config.ts'

/**
 * What Switchboard needs on this computer before it can start a session, and
 * the exact command that fixes each thing that is missing. `switchboard up`
 * stops on the blocking ones and prints them all at once; `switchboard doctor`
 * prints everything.
 */
export interface Check {
  label: string
  ok: boolean
  detail: string
  /** Commands (and one-line notes starting with "#") to paste into the terminal, in order. */
  fix: string[]
  /** `switchboard up` refuses to start while this is wrong. */
  blocking: boolean
}

export const MIN_CLAUDE = [2, 1, 80] as const
const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

export interface ToolProbe {
  platform: NodeJS.Platform
  /** Output of `tmux -V`, or null when tmux cannot be run. */
  tmuxVersion: string | null
  /** How to call Homebrew ("brew" or its full path), or null when it is not installed. */
  brew: string | null
  /** How Switchboard will call Claude Code. */
  claudeBin: string
  /** Output of `claude --version`, or null when it cannot be run. */
  claudeVersion: string | null
  /** From `claude auth status`; null when this version cannot say. */
  loggedIn: boolean | null
  /** Whether typing `claude` in the terminal finds it. */
  claudeOnPath: boolean
}

function run(bin: string, args: string[], timeoutMs = 20_000): string | null {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (err) {
    // `claude auth status` exits non-zero when logged out but still prints its JSON.
    const out = (err as { stdout?: string }).stdout
    return typeof out === 'string' && out.trim() ? out.trim() : null
  }
}

export function probeTools(cfg: Config, env: NodeJS.ProcessEnv = process.env): ToolProbe {
  const brewBin = resolveBin('brew', BREW_DIRS, env)
  const brew = run(brewBin, ['--version'], 15_000) ? brewBin : null
  const claudeVersion = run(cfg.claudeBin, ['--version'])
  let loggedIn: boolean | null = null
  if (claudeVersion) {
    const status = run(cfg.claudeBin, ['auth', 'status'])
    try {
      const parsed = JSON.parse(status ?? '') as { loggedIn?: unknown }
      if (typeof parsed.loggedIn === 'boolean') loggedIn = parsed.loggedIn
    } catch {
      loggedIn = null
    }
  }
  return {
    platform: process.platform,
    tmuxVersion: run(cfg.tmuxBin, ['-V'], 10_000),
    brew,
    claudeBin: cfg.claudeBin,
    claudeVersion,
    loggedIn,
    claudeOnPath: Boolean(findOnPath('claude', env)),
  }
}

/** "2.1.322 (Claude Code)" and "tmux 3.5a" alike: the third part is 0 when there is none. */
export function parseVersion(text: string | null): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]
  }
  return true
}

/** Turn what was found into checks, each with the commands that fix it on this kind of computer. */
export function toolChecks(p: ToolProbe): Check[] {
  const checks: Check[] = []
  const mac = p.platform === 'darwin'

  // tmux ---------------------------------------------------------------------
  const tmuxVersion = parseVersion(p.tmuxVersion)
  if (!p.tmuxVersion) {
    checks.push({
      label: 'tmux',
      ok: false,
      blocking: true,
      detail: 'not installed. Switchboard keeps the hub and every session running in it.',
      fix: mac
        ? p.brew
          ? [`${p.brew} install tmux`]
          : [
              '# Install Homebrew first (it asks for your Mac password):',
              HOMEBREW_INSTALL,
              '# When it finishes it prints "Next steps" with two or three lines: paste those too, then:',
              'brew install tmux',
            ]
        : ['sudo apt update && sudo apt install -y tmux'],
    })
  } else if (tmuxVersion && !versionAtLeast(tmuxVersion, [3, 2, 0])) {
    checks.push({
      label: 'tmux',
      ok: false,
      blocking: true,
      detail: `${p.tmuxVersion} is too old (3.2 or newer is needed).`,
      fix: mac ? [`${p.brew ?? 'brew'} upgrade tmux`] : ['sudo apt update && sudo apt install -y tmux'],
    })
  } else {
    checks.push({ label: 'tmux', ok: true, blocking: true, detail: p.tmuxVersion, fix: [] })
  }

  // Claude Code ----------------------------------------------------------------
  const claude = p.claudeOnPath ? 'claude' : p.claudeBin
  const version = parseVersion(p.claudeVersion)
  if (!p.claudeVersion) {
    checks.push({
      label: 'Claude Code',
      ok: false,
      blocking: true,
      detail: 'not installed on this computer. The sessions Switchboard starts are Claude Code running here.',
      fix: [
        CLAUDE_INSTALL,
        '# Then log in once (it opens your browser). When you see its prompt, type /exit and press Return:',
        '~/.local/bin/claude',
      ],
    })
  } else if (version && !versionAtLeast(version, MIN_CLAUDE)) {
    checks.push({
      label: 'Claude Code',
      ok: false,
      blocking: true,
      detail: `${p.claudeVersion} is too old for channels (${MIN_CLAUDE.join('.')} or newer is needed).`,
      fix: [`${claude} update`],
    })
  } else if (p.loggedIn === false) {
    checks.push({
      label: 'Claude Code',
      ok: false,
      blocking: true,
      detail: `${p.claudeVersion} is installed but not logged in.`,
      fix: ['# Log in once (it opens your browser). When you see its prompt, type /exit and press Return:', claude],
    })
  } else {
    checks.push({
      label: 'Claude Code',
      ok: true,
      blocking: true,
      detail: `${p.claudeVersion}${p.loggedIn ? ', logged in' : ''}${p.claudeOnPath ? '' : ` (at ${p.claudeBin})`}`,
      fix: [],
    })
  }
  return checks
}

/** Lines to print for one check: a tick or cross, then the commands to paste. */
export function formatCheck(c: Check): string[] {
  const lines = [`${c.ok ? '✓' : '✗'} ${c.label.padEnd(18)} ${c.detail}`]
  for (const line of c.fix) lines.push(line.startsWith('#') ? `    ${line.slice(1).trim()}` : `      ${line}`)
  return lines
}
