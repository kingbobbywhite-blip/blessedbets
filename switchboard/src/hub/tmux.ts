import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SEP = '@@sb@@'

export interface TmuxSession {
  name: string
  created: number
  attached: boolean
  dead: boolean
  pid: number | null
  cwd: string
  command: string
}

/**
 * A thin wrapper over the tmux CLI. `socket` picks a separate tmux server
 * (tmux -L); empty means your default one, so `tmux ls` and `tmux attach` work
 * as you would expect.
 */
export class Tmux {
  readonly socket: string
  readonly bin: string

  constructor(socket = '', bin = 'tmux') {
    this.socket = socket
    this.bin = bin
  }

  private args(rest: string[]): string[] {
    return this.socket ? ['-L', this.socket, ...rest] : rest
  }

  async exec(rest: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
    try {
      const { stdout } = await run(this.bin, this.args(rest), { maxBuffer: 16 * 1024 * 1024, env: process.env })
      return stdout
    } catch (err) {
      if (opts.allowFail) return ''
      const e = err as { stderr?: string; message: string }
      throw new Error(`tmux ${rest[0]} failed: ${(e.stderr || e.message).trim()}`)
    }
  }

  async available(): Promise<string | null> {
    try {
      const { stdout } = await run(this.bin, ['-V'])
      return stdout.trim()
    } catch {
      return null
    }
  }

  async list(): Promise<TmuxSession[]> {
    // tmux turns tabs and other control characters in its output into "_", so use a printable separator.
    const fmt = ['#{session_name}', '#{session_created}', '#{session_attached}', '#{pane_dead}', '#{pane_pid}', '#{pane_current_path}', '#{pane_current_command}'].join(SEP)
    const out = await this.exec(['list-panes', '-a', '-F', fmt], { allowFail: true })
    const seen = new Map<string, TmuxSession>()
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const [name, created, attached, dead, pid, cwd, command] = line.split(SEP)
      if (seen.has(name)) continue // first pane of each session is the one we start
      seen.set(name, {
        name,
        created: Number(created) * 1000,
        attached: attached !== '0',
        dead: dead === '1',
        pid: pid ? Number(pid) : null,
        cwd,
        command,
      })
    }
    return [...seen.values()]
  }

  async has(name: string): Promise<boolean> {
    return (await this.list()).some(s => s.name === name)
  }

  /**
   * Start a detached session running `command` (an argv array, quoted for the
   * shell tmux uses). The pane stays after the command exits so a crash can be
   * read: the session starts on a placeholder, gets remain-on-exit, and only
   * then is the real command started in its place.
   */
  async newSession(opts: { name: string; cwd: string; command: string[]; env?: Record<string, string>; width?: number; height?: number }) {
    const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    await this.exec([
      'new-session',
      '-d',
      '-s',
      opts.name,
      '-x',
      String(opts.width ?? 200),
      '-y',
      String(opts.height ?? 50),
      '-c',
      opts.cwd,
      ...envArgs,
      'sleep 86400',
    ])
    await this.exec(['set-option', '-t', pane(opts.name), 'remain-on-exit', 'on'], { allowFail: true })
    await this.exec(['respawn-pane', '-k', '-t', pane(opts.name), '-c', opts.cwd, ...envArgs, opts.command.map(shellQuote).join(' ')])
  }

  /** Stop this tmux server and every session in it. */
  async killServer(): Promise<void> {
    await this.exec(['kill-server'], { allowFail: true })
    // The server takes a moment to go; a command sent before then would reach the old one.
    for (let i = 0; i < 20 && (await this.exec(['list-sessions'], { allowFail: true })).trim(); i++) await sleep(100)
  }

  async kill(name: string): Promise<void> {
    await this.exec(['kill-session', '-t', exact(name)], { allowFail: true })
  }

  /** The visible screen plus `history` lines of scrollback, with wrapped lines joined. */
  async capture(name: string, history = 0): Promise<string> {
    const args = ['capture-pane', '-p', '-J', '-t', pane(name)]
    if (history > 0) args.push('-S', `-${history}`)
    const out = await this.exec(args)
    return out.replace(/\s+$/, '')
  }

  /** Type text literally (no key-name interpretation). */
  async typeText(name: string, text: string): Promise<void> {
    // send-keys -l still treats a leading "-" as a flag unless "--" ends the options.
    await this.exec(['send-keys', '-t', pane(name), '-l', '--', text])
  }

  /** Press named keys: Enter, Escape, Up, Down, C-c, BSpace, Tab, or single characters. */
  async keys(name: string, keys: string[]): Promise<void> {
    if (!keys.length) return
    await this.exec(['send-keys', '-t', pane(name), ...keys])
  }

  /**
   * Type a message into Claude Code's prompt and submit it. A pause between the
   * text and Enter stops the terminal treating the Enter as part of a paste.
   */
  async submit(name: string, text: string, pauseMs = 250): Promise<void> {
    await this.typeText(name, text)
    await sleep(pauseMs)
    await this.keys(name, ['Enter'])
  }

  async paneDead(name: string): Promise<boolean> {
    const out = await this.exec(['display-message', '-p', '-t', pane(name), '#{pane_dead}'], { allowFail: true })
    return out.trim() === '1'
  }

  async respawn(name: string, command: string[], cwd: string): Promise<void> {
    await this.exec(['respawn-pane', '-k', '-t', pane(name), '-c', cwd, command.map(shellQuote).join(' ')])
  }
}

/** "=name" makes tmux match the session name exactly instead of by prefix. */
function exact(name: string): string {
  return `=${name}`
}
function pane(name: string): string {
  return `=${name}:`
}

export function shellQuote(arg: string): string {
  if (arg === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
