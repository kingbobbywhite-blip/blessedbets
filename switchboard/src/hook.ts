#!/usr/bin/env node
/**
 * Claude Code hook (SessionStart, UserPromptSubmit, Stop, Notification,
 * SessionEnd) that tells the Switchboard hub what a session is doing. It never
 * blocks or fails the session: whatever happens, it exits 0 within a few seconds.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const done = () => process.exit(0)
setTimeout(done, 4000).unref()

try {
  const input = fs.readFileSync(0, 'utf8')
  const payload = input.trim() ? JSON.parse(input) : {}
  const session = process.env.SWITCHBOARD_SESSION
  if (session) {
    const url = (process.env.SWITCHBOARD_URL || 'http://127.0.0.1:7700').replace(/\/+$/, '')
    let token = process.env.SWITCHBOARD_TOKEN || ''
    if (!token) {
      const dir = process.env.SWITCHBOARD_DATA_DIR || path.join(os.homedir(), '.switchboard')
      try {
        token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim()
      } catch {
        // no token, nothing to report to
      }
    }
    await fetch(`${url}/api/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: payload.hook_event_name, session, payload }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {})
  }
} catch {
  // a hook must never get in the way
}
done()
