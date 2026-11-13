import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codeStamp, isExampleUrl, resolveBin, setEnvVar, splitArgs, tokenMatches } from '../src/hub/config.ts'
import jsQRModule from 'jsqr'
import { formatCheck, toolChecks, type ToolProbe } from '../src/preflight.ts'
import { pairingPage, terminalQr, terminalQrFor } from '../src/qr.ts'
import { detectDialog, isToolApproval, keysToChoose, parseOptions, screenStatus } from '../src/hub/dialogs.ts'
import { channelWarning } from '../src/hub/sessions.ts'
import { shellQuote } from '../src/hub/tmux.ts'
import { parseTranscriptLines } from '../src/hub/transcripts.ts'
import { multipart, updateIdFor } from '../src/hub/updates.ts'
import { matchSession, parseUtterance } from '../src/hub/voice.ts'
import { isValidName } from '../src/shared/protocol.ts'

const DEV_DIALOG = `
╭──────────────────────────────────────────────╮
│ WARNING: Loading development channels         │
│ Channels: server:switchboard                  │
│                                               │
│ ❯ 1. I am using this for local development    │
│   2. Exit                                     │
╰──────────────────────────────────────────────╯`

describe('startup dialogs', () => {
  it('reads numbered options and which one is focused', () => {
    const opts = parseOptions(DEV_DIALOG)
    assert.deepEqual(
      opts.map(o => [o.number, o.label, o.focused]),
      [
        [1, 'I am using this for local development', true],
        [2, 'Exit', false],
      ],
    )
  })

  it('answers the development-channels warning only when allowed', () => {
    const d = detectDialog(DEV_DIALOG, { autoAccept: true })!
    assert.equal(d.kind, 'dev_channels')
    assert.equal(d.answer?.label, 'I am using this for local development')
    assert.deepEqual(keysToChoose(d.options, d.answer!), ['Enter'])
    assert.equal(detectDialog(DEV_DIALOG, { autoAccept: false })!.answer, null)
  })

  it('moves the highlight to the wanted option', () => {
    const screen = `Do you trust the files in this folder?\n ❯ 1. No, exit\n   2. Yes, proceed`
    const d = detectDialog(screen, { autoAccept: true })!
    assert.equal(d.kind, 'trust_folder')
    assert.deepEqual(keysToChoose(d.options, d.answer!), ['Down', 'Enter'])
  })

  it('never answers a project MCP server consent prompt', () => {
    const d = detectDialog('New MCP server found in .mcp.json: evil\n❯ 1. Use this MCP server\n  2. Continue without using this MCP server', { autoAccept: true })!
    assert.equal(d.kind, 'mcp_consent')
    assert.equal(d.answer, null)
  })

  it('leaves the no-permission-checks warning for the human, always', () => {
    const d = detectDialog('WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept', { autoAccept: true })!
    assert.equal(d.kind, 'bypass_permissions')
    assert.equal(d.answer, null)
  })

  it('reads the development-channels warning even when its choices are not numbered', () => {
    const screen = 'WARNING: Loading development channels\nChannels: server:switchboard\n\n ❯ I am using this for local development\n   Exit'
    const d = detectDialog(screen, { autoAccept: true })!
    assert.equal(d.kind, 'dev_channels')
    assert.deepEqual(keysToChoose(d.options, d.answer!), ['Enter'])
    const onExit = detectDialog(screen.replace(' ❯ I am', '   I am').replace('   Exit', ' ❯ Exit'), { autoAccept: true })!
    assert.deepEqual(keysToChoose(onExit.options, onExit.answer!), ['Up', 'Enter'])
  })

  it('tells a tool approval from other menus', () => {
    const approval = `Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for rm commands\n  3. No, and tell Claude what to do differently (esc)`
    assert.ok(isToolApproval(approval))
    assert.ok(isToolApproval('Edit file\n❯ 1. Yes\n  2. Yes, allow all edits during this session (shift+tab)\n  3. No, and tell Claude what to do differently (esc)'))
    assert.ok(!isToolApproval('Which model?\n❯ 1. Opus\n  2. Sonnet'))
    assert.ok(!isToolApproval('Do you want to proceed with the refactor? I can also wait.'), 'a question in the conversation is not an approval')
  })

  it('ignores numbered lists in the conversation', () => {
    assert.equal(detectDialog('Plan:\n1. Fix the bug\n3. Ship it\n> ', { autoAccept: true }), null)
  })

  it('notices when Claude Code refuses to register the channel', () => {
    assert.match(channelWarning('Channels blocked by org policy: ask an admin')!, /Owner can enable/)
    assert.equal(channelWarning('Channels (experimental) messages from server:switchboard inject directly in this session'), null)
  })

  it('reads busy, waiting and idle off the screen', () => {
    assert.equal(screenStatus('✻ Thinking… (esc to interrupt)'), 'busy')
    assert.equal(screenStatus('Do you want to proceed?\n❯ 1. Yes\n  2. No'), 'waiting')
    assert.equal(screenStatus('> \n  ? for shortcuts'), 'idle')
  })
})

describe('voice', () => {
  const sessions = ['boss', 'api-worker', 'research']
  it('matches spoken session names loosely', () => {
    assert.equal(matchSession('API worker', sessions), 'api-worker')
    assert.equal(matchSession('res', sessions), 'research')
    assert.equal(matchSession('nobody', sessions), null)
  })

  it('routes an utterance', () => {
    const ctx = { target: 'boss', sessions, permissionPending: false }
    assert.deepEqual(parseUtterance('run the tests', ctx), { kind: 'message', to: 'boss', body: 'run the tests' })
    assert.deepEqual(parseUtterance('Switch to research.', ctx), { kind: 'switch', target: 'research' })
    assert.deepEqual(parseUtterance('API worker, run the tests', ctx), { kind: 'message', to: 'api-worker', body: 'run the tests' })
    assert.deepEqual(parseUtterance('@research what did you find', ctx), { kind: 'message', to: 'research', body: 'what did you find' })
    assert.deepEqual(parseUtterance('Okay, so what is next', ctx), { kind: 'message', to: 'boss', body: 'Okay, so what is next' })
    assert.deepEqual(parseUtterance('   ', ctx), { kind: 'empty' })
  })

  it('treats yes/no as an approval only when one is waiting', () => {
    assert.deepEqual(parseUtterance('Approve.', { target: 'boss', sessions, permissionPending: true }), { kind: 'permission', behavior: 'allow' })
    assert.deepEqual(parseUtterance('deny it', { target: 'boss', sessions, permissionPending: true }), { kind: 'permission', behavior: 'deny' })
    assert.equal(parseUtterance('yes', { target: 'boss', sessions, permissionPending: false }).kind, 'message')
  })
})

describe('transcripts', () => {
  it('keeps text, skips tools, and finds pushed message ids', () => {
    const lines = [
      { type: 'user', uuid: 'u1', sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'typed in the terminal' } },
      { type: 'assistant', uuid: 'a1', sessionId: 's', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }, { type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', uuid: 'u2', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] } },
      { type: 'user', uuid: 'u3', sessionId: 's', message: { role: 'user', content: '<channel source="switchboard" from="user" message_id="42" kind="voice">hello</channel>' } },
      { type: 'assistant', uuid: 'a2', isSidechain: true, sessionId: 's', message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
      'not json',
    ]
    const text = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
    const r = parseTranscriptLines(text)
    assert.deepEqual(r.entries.map(e => [e.uuid, e.role, e.body]), [
      ['u1', 'user', 'typed in the terminal'],
      ['a1', 'assistant', 'Sure.'],
    ])
    assert.deepEqual(r.seenMessageIds, [42])
  })
})

describe('updates protocol', () => {
  it('derives a UUID from metadata.json', () => {
    assert.match(updateIdFor('{"a":1}'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(updateIdFor('x'), updateIdFor('x'))
  })

  it('writes multipart/mixed parts with names and JSON bodies', () => {
    const { body, contentType } = multipart([{ name: 'directive', json: { type: 'noUpdateAvailable' } }])
    const boundary = /boundary=(.+)$/.exec(contentType)![1]
    const s = body.toString()
    assert.ok(s.startsWith(`--${boundary}\r\n`))
    assert.ok(s.includes('Content-Disposition: form-data; name="directive"\r\n'))
    assert.ok(s.includes('{"type":"noUpdateAvailable"}\r\n'))
    assert.ok(s.endsWith(`--${boundary}--\r\n`))
  })
})

describe('small helpers', () => {
  it('validates session names', () => {
    assert.ok(isValidName('api-2'))
    assert.ok(!isValidName('user'))
    assert.ok(!isValidName('Has Space'))
    assert.ok(!isValidName('-dash'))
  })
  it('splits and quotes arguments', () => {
    assert.deepEqual(splitArgs(`--model opus --append "two words" 'single quoted'`), ['--model', 'opus', '--append', 'two words', 'single quoted'])
    assert.equal(shellQuote("it's"), `'it'\\''s'`)
    assert.equal(shellQuote('/plain/path'), '/plain/path')
  })
  it('replaces the example address in .env instead of adding a second one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-env-')), '.env')
    fs.writeFileSync(file, 'OPENAI_API_KEY=x\nSWITCHBOARD_PUBLIC_URL=https://your-mac.tail1234.ts.net\n')
    assert.ok(isExampleUrl('https://your-mac.tail1234.ts.net'))
    setEnvVar('SWITCHBOARD_PUBLIC_URL', 'https://bobs-mac.tail9f2c.ts.net', file)
    assert.equal(fs.readFileSync(file, 'utf8'), 'OPENAI_API_KEY=x\nSWITCHBOARD_PUBLIC_URL=https://bobs-mac.tail9f2c.ts.net\n')
    assert.ok(!isExampleUrl('https://bobs-mac.tail9f2c.ts.net'))
  })
  it('finds a command the shell cannot, where installers put it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bin-'))
    const tool = path.join(dir, 'sometool')
    fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 })
    assert.equal(resolveBin('sometool', [dir], { PATH: '/nonexistent' }), tool, 'full path when only an installer directory has it')
    assert.equal(resolveBin('sometool', [], { PATH: dir }), 'sometool', 'bare name when the PATH has it')
    assert.equal(resolveBin('sometool', [], { PATH: '/nonexistent' }), 'sometool', 'bare name when it is nowhere')
    assert.equal(resolveBin('/abs/tool', [dir], { PATH: dir }), '/abs/tool')
  })
  it('fingerprints the code, separately for the hub and for what runs inside sessions', () => {
    assert.match(codeStamp('hub'), /^[0-9a-f]{12}$/)
    assert.equal(codeStamp('hub'), codeStamp('hub'))
    assert.notEqual(codeStamp('hub'), codeStamp('channel'))
  })
  it('compares tokens', () => {
    assert.ok(tokenMatches('abc', 'abc'))
    assert.ok(!tokenMatches('abc', 'abd'))
    assert.ok(!tokenMatches('abc', undefined))
  })
})

describe('what is missing on this computer', () => {
  const mac: ToolProbe = { platform: 'darwin', tmuxVersion: null, brew: null, claudeBin: 'claude', claudeVersion: null, loggedIn: null, claudeOnPath: false }
  const fixes = (p: ToolProbe) => Object.fromEntries(toolChecks(p).map(c => [c.label, c]))

  it('on a Mac with nothing installed, walks through Homebrew, tmux and Claude Code', () => {
    const c = fixes(mac)
    assert.equal(c.tmux.ok, false)
    assert.ok(c.tmux.fix.some(l => l.includes('Homebrew/install')))
    assert.equal(c.tmux.fix.at(-1), 'brew install tmux')
    assert.equal(c['Claude Code'].ok, false)
    assert.equal(c['Claude Code'].fix[0], 'curl -fsSL https://claude.ai/install.sh | bash')
  })

  it('uses Homebrew by its full path when the shell cannot find it', () => {
    assert.deepEqual(fixes({ ...mac, brew: '/opt/homebrew/bin/brew' }).tmux.fix, ['/opt/homebrew/bin/brew install tmux'])
  })

  it('asks for a login, by full path when the shell cannot find claude', () => {
    const c = fixes({ ...mac, tmuxVersion: 'tmux 3.5a', claudeBin: '/Users/me/.local/bin/claude', claudeVersion: '2.1.322 (Claude Code)', loggedIn: false })
    assert.equal(c.tmux.ok, true)
    assert.equal(c['Claude Code'].ok, false)
    assert.equal(c['Claude Code'].fix.at(-1), '/Users/me/.local/bin/claude')
  })

  it('rejects a Claude Code too old for channels and a tmux too old for -e', () => {
    const c = fixes({ ...mac, tmuxVersion: 'tmux 2.9', brew: 'brew', claudeVersion: '2.1.79 (Claude Code)', loggedIn: true, claudeOnPath: true })
    assert.equal(c.tmux.ok, false)
    assert.deepEqual(c.tmux.fix, ['brew upgrade tmux'])
    assert.deepEqual(c['Claude Code'].fix, ['claude update'])
  })

  it('passes when everything is there, and does not block on a login state it cannot read', () => {
    const c = fixes({ ...mac, tmuxVersion: 'tmux 3.5a', claudeVersion: '2.1.80 (Claude Code)', loggedIn: null, claudeOnPath: true })
    assert.ok(c.tmux.ok && c['Claude Code'].ok)
    assert.deepEqual(formatCheck(c.tmux), ['✓ tmux               tmux 3.5a'])
  })

  it('on Linux, installs tmux with apt', () => {
    assert.deepEqual(fixes({ ...mac, platform: 'linux' }).tmux.fix, ['sudo apt update && sudo apt install -y tmux'])
  })
})

describe('the pairing code in a terminal', () => {
  const link = 'HTTPS://ROBERTS-MACBOOK-AIR.TAIL2F3BA6.TS.NET/P/7KQ2M9XA'
  type Decoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null
  const jsQR = ((jsQRModule as unknown as { default?: Decoder }).default ?? jsQRModule) as unknown as Decoder

  /** Paint the terminal lines as a picture, the way a phone's camera sees the screen. */
  function photograph(lines: string[], scale = 6): { data: Uint8ClampedArray; width: number; height: number } {
    const cell = /\x1b\[(?:38;5;(\d+);)?48;5;(\d+)m([ ▀])/g
    const rows: boolean[][] = []
    for (const line of lines) {
      const top: boolean[] = []
      const bottom: boolean[] = []
      for (const m of line.matchAll(cell)) {
        const bg = m[2] === '16'
        top.push(m[3] === '▀' ? m[1] === '16' : bg)
        bottom.push(bg)
      }
      rows.push(top, bottom)
    }
    const width = rows[0].length * scale
    const height = rows.length * scale
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = rows[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255
        data.set([v, v, v, 255], (y * width + x) * 4)
      }
    }
    return { data, width, height }
  }

  it('reads back as the link, drawn either way', () => {
    const small = photograph(terminalQr(link).lines)
    assert.equal(jsQR(small.data, small.width, small.height)?.data, link)
    // The full drawing: each square is two cells wide and one line tall, so photograph it at that shape.
    const full = terminalQr(link, { compact: false })
    const rows = full.lines.map(line => [...line.matchAll(/\x1b\[48;5;(\d+)m {2}/g)].map(m => m[1] === '16'))
    const scale = 6
    const width = rows[0].length * scale
    const data = new Uint8ClampedArray(width * rows.length * scale * 4)
    for (let y = 0; y < rows.length * scale; y++) {
      for (let x = 0; x < width; x++) {
        const v = rows[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255
        data.set([v, v, v, 255], (y * width + x) * 4)
      }
    }
    assert.equal(jsQR(data, width, rows.length * scale)?.data, link)
    assert.ok(!full.lines.join('').includes('▀'), 'the full drawing uses no characters a font could distort')
  })

  it('picks the drawing that cannot be distorted whenever the window is big enough', () => {
    assert.equal(terminalQrFor(link, { rows: 50, columns: 120 }).compact, false)
    const standard = terminalQrFor(link, { rows: 24, columns: 80 })
    assert.deepEqual([standard.compact, standard.fits], [true, true])
    assert.equal(terminalQrFor(link, { rows: 12, columns: 80 }).fits, false)
    assert.equal(terminalQrFor(link, {}).compact, true, 'not a terminal: the small one')
  })

  it('is coarse and small enough for a standard 80 by 24 window, with the lines printed around it', () => {
    const qr = terminalQr(link)
    assert.equal(qr.size, 29, 'a capitals-only link needs the smallest practical code')
    assert.ok(qr.width <= 80)
    assert.ok(qr.height + 5 <= 24)
    for (const line of qr.lines) assert.equal(line.replace(/\x1b\[[0-9;]*m/g, '').length, qr.width, 'every line is the same width')
    assert.ok(!qr.lines[0].includes('▀') && qr.lines[0].includes('48;5;231'), 'a white margin on top')
  })

  it('uses exact black and white, not the theme colours', () => {
    const colours = new Set([...terminalQr(link).lines.join('').matchAll(/[34]8;5;(\d+)/g)].map(m => m[1]))
    assert.deepEqual([...colours].sort(), ['16', '231'])
  })

  it('makes a page with the code, the link to type and when it stops working', async () => {
    const page = await pairingPage({ qrText: link, url: link.toLowerCase(), expiresAt: '2026-01-01T12:00:00Z' })
    assert.match(page, /<svg/)
    assert.ok(page.includes(link.toLowerCase()))
    assert.match(page, /Works until/)
  })
})
