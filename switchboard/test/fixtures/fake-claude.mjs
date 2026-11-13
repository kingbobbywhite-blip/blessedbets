#!/usr/bin/env node
/**
 * Stands in for the `claude` CLI in tests: shows the same startup dialogs
 * (development channels, folder trust), starts the MCP servers from
 * --mcp-config the way Claude Code does, prints channel events, answers
 * keystrokes, and exits on /exit. Never calls a model.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

const args = process.argv.slice(2)
// The two questions `switchboard up` and `switchboard doctor` ask before starting anything.
if (args[0] === '--version') {
  console.log('2.1.999 (Fake Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_OUT ? false : true }))
  process.exit(process.env.FAKE_CLAUDE_LOGGED_OUT ? 1 : 0)
}
const flag = name => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
const out = s => process.stdout.write(s)
const trustFile = path.join(process.env.FAKE_CLAUDE_STATE ?? '/tmp', 'fake-claude-trusted.json')
const trusted = fs.existsSync(trustFile) ? JSON.parse(fs.readFileSync(trustFile, 'utf8')) : []

process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')

let keyHandler = null
process.stdin.on('data', data => keyHandler?.(data))

/**
 * A menu drawn the way Claude Code draws its own (copied from the real program's dialogs):
 * a pointer in front of the highlighted row; rows numbered or not; in the un-numbered ones the
 * number keys do nothing; and keys are ignored for a moment after the menu opens.
 */
function select(title, body, options, { numbered = true, focus = 0, digits = true, refuseMs = 0, boxed = true } = {}) {
  return new Promise(resolve => {
    let focused = focus
    const openedAt = Date.now()
    const row = (o, i) => (i === focused ? '❯ ' : '  ') + (numbered ? `${i + 1}. ${o}` : o)
    const draw = () => {
      out('\x1b[2J\x1b[H')
      if (boxed) {
        out(`╭${'─'.repeat(70)}╮\n│ ${title.padEnd(69)}│\n│${' '.repeat(70)}│\n`)
        for (const line of body) out(`│ ${line.padEnd(69)}│\n`)
        out(`│${' '.repeat(70)}│\n`)
        options.forEach((o, i) => out(`│ ${row(o, i).padEnd(69)}│\n`))
        out(`╰${'─'.repeat(70)}╯\n`)
      } else {
        out(` ${title}\n\n`)
        for (const line of body) out(` ${line}\n\n`)
        options.forEach((o, i) => out(` ${row(o, i)}\n`))
        out('\n Enter to confirm · Esc to cancel\n')
      }
    }
    draw()
    keyHandler = data => {
      if (Date.now() - openedAt < refuseMs) return // too soon after opening: not meant for this menu
      // Keys can arrive several at a time.
      for (const key of data.match(/\x1b\[[AB]|\r|\n|[1-9]|[\s\S]/g) ?? []) {
        if (key === '\x1b[B') focused = Math.min(focused + 1, options.length - 1)
        else if (key === '\x1b[A') focused = Math.max(focused - 1, 0)
        else if (key === '\r' || key === '\n') {
          keyHandler = null
          return resolve(focused)
        } else if (digits && /^[1-9]$/.test(key) && Number(key) <= options.length) focused = Number(key) - 1
      }
      draw()
    }
  })
}

const cwd = process.cwd()
if (!trusted.includes(cwd)) {
  // The real one: no numbers, "No, exit" first and highlighted, number keys off.
  const choice = await select(
    'Accessing workspace:',
    [cwd, 'Quick safety check: Is this a project you created or one you trust? If not, take a moment to review it first.', "Claude Code'll be able to read, edit, and execute files here."],
    ['No, exit', 'Yes, I trust this folder'],
    { numbered: false, focus: 0, digits: false, refuseMs: 500, boxed: false },
  )
  if (choice !== 1) process.exit(1)
  fs.writeFileSync(trustFile, JSON.stringify([...trusted, cwd]))
}
const devChannels = flag('--dangerously-load-development-channels')
if (devChannels) {
  const choice = await select('WARNING: Loading development channels', [
    `--dangerously-load-development-channels is for local channel development only.`,
    `Channels: ${devChannels}`,
  ], ['I am using this for local development', 'Exit'])
  if (choice !== 0) process.exit(1)
}
const noChannels = args.includes('--fake-no-channels')

out('\x1b[2J\x1b[H✻ Welcome to Fake Claude Code\n')
if (devChannels) out(noChannels ? 'Channels are not currently available\n' : `Channels (experimental) messages from ${devChannels} inject directly in this session\n`)
const log = line => out(`${line}\n`)

// Start MCP servers like Claude Code does.
const clients = []
const configFile = flag('--mcp-config')
if (configFile) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    const transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], env: { ...process.env, ...(server.env ?? {}) }, stderr: 'ignore' })
    const client = new Client({ name: 'claude-code', version: '9.9.9' }, { capabilities: {} })
    client.setNotificationHandler(
      z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) }),
      n => {
        if (noChannels) return // dropped silently, as Claude Code does when channels are off
        const attrs = Object.entries(n.params.meta ?? {}).map(([k, v]) => `${k}="${v}"`).join(' ')
        log(`← ${name}: ${n.params.content}`)
        fs.appendFileSync(process.env.FAKE_CLAUDE_EVENTS ?? '/dev/null', `<channel source="${name}" ${attrs}>${n.params.content}</channel>\n`)
      },
    )
    await client.connect(transport)
    clients.push({ name, client })
  }
}

out('\n> \n  ? for shortcuts\n')
let line = ''
let approvalOpen = false
keyHandler = data => {
  if (data === '\x1b') return log('Interrupted by user')
  if (data === '\r' || data === '\n') {
    const input = line
    line = ''
    if (input.trim() === '/exit') {
      for (const { client } of clients) client.close().catch(() => {})
      process.exit(0)
    }
    if (approvalOpen) {
      // Answering the approval clears it off the screen.
      approvalOpen = false
      out('\x1b[2J\x1b[H> \n  ? for shortcuts\n')
      return
    }
    if (input.trim() === '/approve-me') {
      // What a real tool approval looks like on screen.
      approvalOpen = true
      log('Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again for rm commands\n  3. No, and tell Claude what to do differently (esc)')
      return
    }
    if (input) log(`> ${input}`)
    fs.appendFileSync(process.env.FAKE_CLAUDE_EVENTS ?? '/dev/null', `TYPED ${input}\n`)
    return
  }
  line += data
}
setInterval(() => {}, 1 << 30)
