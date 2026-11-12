import type { SttConfig } from './config.ts'

/**
 * Speech to text through any OpenAI-compatible /audio/transcriptions endpoint:
 * OpenAI, Groq, or a model on your own machine (speaches, faster-whisper-server,
 * LocalAI). Phones and browsers that can transcribe on the device skip this.
 */
export async function transcribe(
  stt: SttConfig,
  audio: { data: Buffer; filename: string; mimetype: string },
  opts: { prompt?: string; language?: string } = {},
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio.data)], { type: audio.mimetype || 'application/octet-stream' }), audio.filename || 'audio.m4a')
  form.append('model', stt.model)
  if (opts.prompt) form.append('prompt', opts.prompt)
  if (opts.language) form.append('language', opts.language)
  form.append('response_format', 'json')
  const res = await fetch(`${stt.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${text.slice(0, 300)}`)
  try {
    const json = JSON.parse(text) as { text?: string }
    return (json.text ?? '').trim()
  } catch {
    return text.trim()
  }
}

export type Intent =
  | { kind: 'empty' }
  | { kind: 'permission'; behavior: 'allow' | 'deny' }
  | { kind: 'switch'; target: string }
  | { kind: 'message'; to: string; body: string }

/** Lowercase, letters and digits only: "API-worker" and "api worker" compare equal. */
export function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Match a spoken name against session names: exact, then squashed, then a unique prefix. */
export function matchSession(spoken: string, sessions: string[]): string | null {
  const s = squash(spoken)
  if (!s) return null
  const exact = sessions.find(n => n === spoken.trim().toLowerCase())
  if (exact) return exact
  const squashed = sessions.filter(n => squash(n) === s)
  if (squashed.length === 1) return squashed[0]
  const prefix = sessions.filter(n => squash(n).startsWith(s) && s.length >= 3)
  return prefix.length === 1 ? prefix[0] : null
}

const YES = /^(yes|yeah|yep|approve|approved|allow|allowed|go ahead|do it|ok|okay|sure|confirm|accept)( it| that| please)?[.!]?$/i
const NO = /^(no|nope|deny|denied|reject|rejected|don't|do not|cancel|stop)( it| that| please)?[.!]?$/i

/**
 * Read one spoken (or typed-in-walk-mode) utterance:
 * - "approve" / "deny" answers the open tool approval, when one is waiting;
 * - "switch to api" / "talk to api" changes who you are talking to;
 * - "api, run the tests" or "@api run the tests" goes to that session once;
 * - anything else goes to the current target.
 */
export function parseUtterance(
  raw: string,
  ctx: { target: string; sessions: string[]; permissionPending: boolean },
): Intent {
  const text = raw.trim().replace(/\s+/g, ' ')
  if (!text) return { kind: 'empty' }

  if (ctx.permissionPending) {
    if (YES.test(text)) return { kind: 'permission', behavior: 'allow' }
    if (NO.test(text)) return { kind: 'permission', behavior: 'deny' }
  }

  const sw = /^(?:switch|talk|go|change|connect)(?: me)? (?:over )?to (.+?)[.!]?$/i.exec(text)
  if (sw) {
    const target = matchSession(sw[1].replace(/^(the )?(session )?/i, ''), ctx.sessions)
    if (target) return { kind: 'switch', target }
  }

  const at = /^@([a-z0-9_-]+)[\s,:]+(.+)$/i.exec(text)
  if (at) {
    const to = matchSession(at[1], ctx.sessions)
    if (to) return { kind: 'message', to, body: at[2].trim() }
  }

  // "api worker, run the tests" / "hey boss: what's next" / "tell api to ..." is left to the orchestrator.
  const addressed = /^(?:hey |ok |okay )?([a-z0-9][a-z0-9 _-]{0,40}?)\s*[,:]\s+(.+)$/i.exec(text)
  if (addressed) {
    const to = matchSession(addressed[1], ctx.sessions)
    if (to) return { kind: 'message', to, body: addressed[2].trim() }
  }

  return { kind: 'message', to: ctx.target, body: text }
}
