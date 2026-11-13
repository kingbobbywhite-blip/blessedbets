import fs from 'node:fs/promises'

export interface TranscriptEntry {
  uuid: string
  role: 'user' | 'assistant'
  body: string
  created_at: string
  claude_session_id: string
}

export interface ParsedChunk {
  entries: TranscriptEntry[]
  /** Switchboard message ids that showed up in the transcript: Claude has them in context. */
  seenMessageIds: number[]
  /** Bytes consumed, up to the last complete line. */
  consumed: number
}

const MAX_BODY = 20_000
const CHANNEL_ID_RE = /<channel\b[^>]*\bsource="[^"]*switchboard[^"]*"[^>]*\bmessage_id="(\d+)"/g
/** The same message typed into the terminal, for sessions without a channel. */
const TYPED_ID_RE = /\[switchboard from="[^"]*"[^\]]*\bid="(\d+)"\]/g

/** Read new lines of a Claude Code transcript (.jsonl) starting at `offset`. */
export async function readTranscript(file: string, offset: number): Promise<ParsedChunk> {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size < offset) offset = 0 // file was replaced
    if (size === offset) return { entries: [], seenMessageIds: [], consumed: offset }
    const length = Math.min(size - offset, 32 * 1024 * 1024)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, offset)
    const lastNewline = buf.lastIndexOf(0x0a)
    if (lastNewline === -1) return { entries: [], seenMessageIds: [], consumed: offset }
    const text = buf.subarray(0, lastNewline + 1).toString('utf8')
    const parsed = parseTranscriptLines(text)
    return { ...parsed, consumed: offset + lastNewline + 1 }
  } finally {
    await handle.close()
  }
}

export function parseTranscriptLines(text: string): Omit<ParsedChunk, 'consumed'> {
  const entries: TranscriptEntry[] = []
  const seen = new Set<number>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, any>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const content = row.message?.content
    const flat = typeof content === 'string' ? content : Array.isArray(content) ? JSON.stringify(content) : ''
    if (flat.includes('<channel') || flat.includes('[switchboard from=')) {
      const raw = typeof content === 'string' ? content : collectText(content, true)
      const before = seen.size
      for (const m of raw.matchAll(CHANNEL_ID_RE)) seen.add(Number(m[1]))
      for (const m of raw.matchAll(TYPED_ID_RE)) seen.add(Number(m[1]))
      if (seen.size > before) continue // the message itself is already stored, with who sent it
    }
    if (row.isSidechain || row.isMeta || !row.uuid) continue
    if (row.type !== 'user' && row.type !== 'assistant') continue
    const body = collectText(content, false).trim()
    if (!body) continue
    if (row.type === 'user' && /^(<command-|<local-command-|<bash-|<system-reminder>|Caveat: )/.test(body)) continue
    entries.push({
      uuid: String(row.uuid),
      role: row.type,
      body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) + ' …' : body,
      created_at: typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString(),
      claude_session_id: String(row.sessionId ?? ''),
    })
  }
  return { entries, seenMessageIds: [...seen] }
}

/** Text parts of a message, leaving out tool calls, tool results and thinking. */
function collectText(content: unknown, includeAll: boolean): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (part && typeof part === 'object') {
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      else if (includeAll && typeof part.content === 'string') parts.push(part.content)
    }
  }
  return parts.join('\n')
}
