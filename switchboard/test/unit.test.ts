import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitArgs, tokenMatches } from '../src/hub/config.ts'
import { detectDialog, keysToChoose, parseOptions, screenStatus } from '../src/hub/dialogs.ts'
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
  it('compares tokens', () => {
    assert.ok(tokenMatches('abc', 'abc'))
    assert.ok(!tokenMatches('abc', 'abd'))
    assert.ok(!tokenMatches('abc', undefined))
  })
})
