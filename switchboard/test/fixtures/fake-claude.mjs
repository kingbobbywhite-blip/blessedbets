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

function select(title, body, options) {
  return new Promise(resolve => {
    let focused = 0
    const draw = () => {
      out('\x1b[2J\x1b[H')
      out(`╭${'─'.repeat(70)}╮\n│ ${title.padEnd(69)}│\n│${' '.repeat(70)}│\n`)
      for (const line of body) out(`│ ${line.padEnd(69)}│\n`)
      out(`│${' '.repeat(70)}│\n`)
      options.forEach((o, i) => out(`│ ${(i === focused ? '❯ ' : '  ') + `${i + 1}. ${o}`.padEnd(67)}│\n`))
      out(`╰${'─'.repeat(70)}╯\n`)
    }
    draw()
    keyHandler = data => {
      if (data === '\x1b[B') focused = Math.min(focused + 1, options.length - 1)
      else if (data === '\x1b[A') focused = Math.max(focused - 1, 0)
      else if (data === '\r' || data === '\n') {
        keyHandler = null
        return resolve(focused)
      } else if (/^[1-9]$/.test(data) && Number(data) <= options.length) focused = Number(data) - 1
      draw()
    }
  })
}

const devChannels = flag('--dangerously-load-development-channels')
if (devChannels) {
  const choice = await select('WARNING: Loading development channels', [
    `--dangerously-load-development-channels is for local channel development only.`,
    `Channels: ${devChannels}`,
  ], ['I am using this for local development', 'Exit'])
  if (choice !== 0) process.exit(1)
}
const cwd = process.cwd()
if (!trusted.includes(cwd)) {
  const choice = await select('Do you trust the files in this folder?', [cwd, 'Claude Code may read, write, or execute files here.'], [
    'Yes, proceed',
    'No, exit',
  ])
  if (choice !== 0) process.exit(1)
  fs.writeFileSync(trustFile, JSON.stringify([...trusted, cwd]))
}

out('\x1b[2J\x1b[H✻ Welcome to Fake Claude Code\n')
if (devChannels) out(`Channels (experimental) messages from ${devChannels} inject directly in this session\n`)
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
keyHandler = data => {
  if (data === '\x1b') return log('Interrupted by user')
  if (data === '\r' || data === '\n') {
    const input = line
    line = ''
    if (input.trim() === '/exit') {
      for (const { client } of clients) client.close().catch(() => {})
      process.exit(0)
    }
    if (input) log(`> ${input}`)
    fs.appendFileSync(process.env.FAKE_CLAUDE_EVENTS ?? '/dev/null', `TYPED ${input}\n`)
    return
  }
  line += data
}
setInterval(() => {}, 1 << 30)
