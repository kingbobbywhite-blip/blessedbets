import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findOnPath } from './hub/config.ts'
import { sleep, type Tmux } from './hub/tmux.ts'

/**
 * Everything Switchboard runs (the hub, every Claude Code session) is started by
 * the tmux server, not by the terminal you type in. A tmux server that was
 * started from somewhere with less access than your terminal (a sandboxed app,
 * an assistant's command, a login item) passes that on to everything it
 * starts, and on a Mac the result is "operation not permitted" the moment a
 * program asks which folder it is in. These checks catch that before anything
 * is started, and restart the tmux server from your terminal when it is safe to.
 */

export interface ProbeResult {
  ok: boolean
  /** "ok", or what went wrong, in the words of the program that tried. */
  detail: string
}

/** Start a throwaway program through the tmux server in `dir` and ask it whether it can work there. */
export async function probeTmux(tmux: Tmux, dir: string, prefix: string, node = process.execPath): Promise<ProbeResult> {
  const stamp = `${process.pid}-${Date.now()}`
  const name = `${prefix}probe-${stamp}`
  const out = path.join(os.tmpdir(), `switchboard-probe-${stamp}.txt`)
  const script = [
    "const fs = require('fs')",
    `const out = ${JSON.stringify(out)}, want = ${JSON.stringify(dir)}`,
    'let r',
    'try {',
    '  const here = process.cwd()',
    "  fs.readdirSync('.')",
    "  r = fs.realpathSync(here) === fs.realpathSync(want) ? 'ok' : 'tmux could not go into ' + want + ' and started in ' + here + ' instead'",
    '} catch (e) {',
    '  r = String((e && e.message) || e)',
    '}',
    'fs.writeFileSync(out, r)',
  ].join('\n')
  try {
    await tmux.newSession({ name, cwd: dir, command: [node, '-e', script] })
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
  try {
    for (let i = 0; i < 80 && !fs.existsSync(out); i++) await sleep(100)
    if (fs.existsSync(out)) {
      const detail = fs.readFileSync(out, 'utf8').trim()
      return { ok: detail === 'ok', detail }
    }
    const screen = (await tmux.capture(name, 30).catch(() => '')).replace(/\n{2,}/g, '\n').trim()
    return { ok: false, detail: `no answer${screen ? `: ${screen.slice(-500)}` : ''}` }
  } finally {
    await tmux.kill(name)
    fs.rmSync(out, { force: true })
  }
}

export type EnsureResult = { ok: true; restarted: boolean } | { ok: false; restarted: boolean; message: string[] }

/**
 * Make sure the tmux server can run programs in `dir`. When it cannot and every
 * session in it is Switchboard's, restart it (from the terminal running this) and
 * check again. Sessions in it stop; their conversations are saved and the hub can
 * resume them. tmux sessions of your own are never touched.
 */
export async function ensureUsableTmux(
  tmux: Tmux,
  dir: string,
  prefix: string,
  log: (line: string) => void,
  node = process.execPath,
): Promise<EnsureResult> {
  const first = await probeTmux(tmux, dir, prefix, node)
  if (first.ok) return { ok: true, restarted: false }
  const theirs = (await tmux.list()).map(s => s.name).filter(n => !n.startsWith(prefix))
  if (theirs.length) {
    return {
      ok: false,
      restarted: false,
      message: [
        ...whatHappened(first.detail, dir),
        '',
        `tmux is also running sessions that are not Switchboard's (${theirs.join(', ')}), so Switchboard will not restart it.`,
        'Close those sessions, then run these two commands:',
        '  tmux kill-server',
        '  switchboard up',
      ],
    }
  }
  log(`tmux cannot work in the Switchboard folder (${oneLine(first.detail)}).`)
  log('Restarting tmux from this terminal. Switchboard sessions in it stop and start again; their conversations are kept.')
  await tmux.killServer()
  const second = await probeTmux(tmux, dir, prefix, node)
  if (second.ok) return { ok: true, restarted: true }
  return { ok: false, restarted: true, message: [...whatHappened(second.detail, dir), '', ...macFix(dir)] }
}

/** The tmux program's real location, which is what macOS's privacy settings need. */
export function tmuxPath(bin: string): string {
  const found = bin.includes('/') ? bin : findOnPath(bin)
  if (!found) return bin
  try {
    return fs.realpathSync(found)
  } catch {
    return found
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 160)
}

export function isPermissionProblem(detail: string): boolean {
  return /EPERM|EACCES|operation not permitted|permission denied/i.test(detail)
}

function whatHappened(detail: string, dir: string): string[] {
  if (isPermissionProblem(detail)) {
    return [
      `Programs that tmux starts are not allowed into ${dir}:`,
      `  ${oneLine(detail)}`,
      'Your terminal can open that folder, but tmux, which runs the hub and every session, cannot.',
    ]
  }
  return [`tmux could not run a program in ${dir}:`, `  ${oneLine(detail)}`]
}

/** What to do when even a tmux server started from this terminal is kept out. */
export function macFix(dir: string, tmuxBin = 'tmux'): string[] {
  const where = tmuxPath(tmuxBin)
  const inProtected = /\/(Desktop|Documents|Downloads|Library\/Mobile Documents)(\/|$)/.test(dir)
  return [
    process.platform === 'darwin' ? 'macOS is keeping tmux out of that folder. Let it in, once:' : 'Let tmux into that folder:',
    ...(process.platform === 'darwin'
      ? [
          '  1. Open System Settings, then Privacy & Security, then Full Disk Access.',
          '  2. Click +, then press Command-Shift-G and paste this, then press Return and click Open:',
          `       ${where}`,
          '  3. Make sure the switch next to tmux is on.',
          '  4. Run: switchboard up',
          ...(inProtected
            ? ['', 'Or move the repository out of Desktop, Documents, Downloads or iCloud Drive (into your home folder, for example) and run npm link again.']
            : []),
        ]
      : ['  Check the folder and its parents can be read by your user, then run: switchboard up']),
  ]
}
