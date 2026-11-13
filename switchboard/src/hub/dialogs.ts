/**
 * Claude Code asks a few questions at startup before a session can take
 * messages. The hub answers the ones you agreed to by starting a session from
 * Switchboard, and leaves the rest on screen for you (or the orchestrator, via
 * read_screen and send_keys) to answer.
 */

export interface DialogOption {
  number: number
  label: string
  focused: boolean
}

export type DialogKind = 'dev_channels' | 'trust_folder' | 'bypass_permissions' | 'mcp_consent' | 'resume_choice' | 'unknown_select'

export interface Dialog {
  kind: DialogKind
  options: DialogOption[]
  /** The option the hub would pick, if it answers this kind of dialog at all. */
  answer: DialogOption | null
}

const NUMBERED_RE = /^[\s│|]*(?:(❯|›|>)\s*)?(\d{1,2})[.)]\s+(.+?)\s*[│|]?\s*$/
const POINTER_RE = /^(\s*)([❯›>])(\s+)(\S.*?)\s*$/
const NUMBER_PREFIX_RE = /^\d{1,2}[.)]\s+/

/** A dialog is sometimes drawn inside a box: drop its side borders but keep every column where it was. */
function stripFrame(line: string): string {
  return line.replace(/^(\s*)[│|](?=\s|$)/, '$1 ').replace(/\s*[│|]\s*$/, '')
}

/**
 * The choices of the menu at the bottom of the screen, in order, and which one
 * is highlighted. Claude Code draws a menu as rows of text with a pointer (❯)
 * in front of the highlighted one; some are numbered ("❯ 1. Yes") and some are
 * not ("❯ No, exit" above "  Yes, I trust this folder"), and in those the
 * number keys do nothing, so the highlight has to be moved with the arrow keys.
 */
export function parseOptions(screen: string): DialogOption[] {
  const lines = screen.split('\n').map(stripFrame)
  for (let p = lines.length - 1; p >= 0; p--) {
    const m = POINTER_RE.exec(lines[p])
    if (!m) continue
    // ">" alone also starts a quoted line or an old-style prompt; only trust it in front of a number.
    if (m[2] === '>' && !NUMBER_PREFIX_RE.test(m[4])) continue
    const col = m[1].length + m[2].length + m[3].length
    // Rows of the same menu start in the same column. A row whose text starts further right is a
    // wrapped label or a description under a choice; anything else ends the menu.
    const kind = (line: string): 'option' | 'continuation' | 'end' => {
      if (!line.trim()) return 'end'
      const indent = line.length - line.trimStart().length
      return indent === col ? 'option' : indent > col ? 'continuation' : 'end'
    }
    const rows: { label: string; focused: boolean }[] = [{ label: m[4], focused: true }]
    for (let i = p - 1; i >= 0; i--) {
      const k = kind(lines[i])
      if (k === 'end') break
      if (k === 'option') rows.unshift({ label: lines[i].trim(), focused: false })
    }
    for (let i = p + 1; i < lines.length; i++) {
      const k = kind(lines[i])
      if (k === 'end') break
      if (k === 'option') rows.push({ label: lines[i].trim(), focused: false })
    }
    // One row with a pointer is the input prompt, not a menu, and it is the newest thing on screen.
    if (rows.length < 2) return []
    return rows.map((r, i) => ({ number: i + 1, label: r.label.replace(NUMBER_PREFIX_RE, ''), focused: r.focused }))
  }
  // No pointer anywhere (a terminal that cannot draw it): fall back to a run of numbered rows.
  const options: DialogOption[] = []
  for (const line of lines) {
    const m = NUMBERED_RE.exec(line)
    if (!m) continue
    const number = Number(m[2])
    // Options are numbered from 1 in order; anything else is a numbered list in the conversation.
    if (number !== options.length + 1) {
      if (number === 1) options.length = 0
      else continue
    }
    options.push({ number, label: m[3].trim(), focused: Boolean(m[1]) })
  }
  return options
}

export function detectDialog(screen: string, opts: { autoAccept: boolean }): Dialog | null {
  // Only the bottom of the screen matters: older dialogs scroll up and stay in the capture.
  const tail = screen.split('\n').slice(-45).join('\n')
  const options = parseOptions(tail)
  if (options.length < 2) return null
  const pick = (re: RegExp) => (opts.autoAccept ? (options.find(o => re.test(o.label)) ?? null) : null)

  if (/development channels?|local development/i.test(tail) && options.some(o => /local development/i.test(o.label))) {
    return { kind: 'dev_channels', options, answer: pick(/local development/i) }
  }
  if (/trust (the files in )?this folder|do you trust|project you created or one you trust|safety check|accessing workspace/i.test(tail)) {
    return { kind: 'trust_folder', options, answer: pick(/^yes\b/i) }
  }
  if (/bypass permissions mode/i.test(tail) && options.some(o => /yes, i accept/i.test(o.label))) {
    // Running with no permission checks at all is for you to accept, in the terminal, every time.
    return { kind: 'bypass_permissions', options, answer: null }
  }
  if (/new MCP servers? found|MCP servers? (found|detected) in/i.test(tail)) {
    // A project's own .mcp.json can run anything; that stays your call.
    return { kind: 'mcp_consent', options, answer: null }
  }
  return { kind: 'unknown_select', options, answer: null }
}

/**
 * A tool approval on screen ("Do you want to proceed?  1. Yes  2. Yes, and
 * don't ask again...  3. No, and tell Claude what to do differently").
 */
export function isToolApproval(screen: string): boolean {
  const tail = screen.split('\n').slice(-25).join('\n')
  const options = parseOptions(tail)
  if (options.length < 2 || !/^yes\b/i.test(options[0].label)) return false
  return (
    /do you want to (proceed|make this edit|create|allow|run|overwrite|use)/i.test(tail) ||
    options.some(o => /don.t ask again|allow all edits|tell claude what to do/i.test(o.label))
  )
}

/** Arrow keys that move the highlight from the focused option to `target`. Empty when it is already there. */
export function movesTo(options: DialogOption[], target: DialogOption): string[] {
  const focused = options.findIndex(o => o.focused)
  const from = focused === -1 ? 0 : focused
  const to = options.indexOf(target)
  const keys: string[] = []
  for (let i = from; i < to; i++) keys.push('Down')
  for (let i = from; i > to; i--) keys.push('Up')
  return keys
}

/** Keys that move the highlight from the focused option to `target` and press Enter. */
export function keysToChoose(options: DialogOption[], target: DialogOption): string[] {
  return [...movesTo(options, target), 'Enter']
}

/**
 * What the session is doing, read off the bottom of its screen. Hooks report
 * the same thing more precisely when they are installed; this covers sessions
 * that were started some other way.
 */
export function screenStatus(screen: string): 'busy' | 'waiting' | 'idle' {
  const tail = screen.split('\n').slice(-25).join('\n')
  // A tool approval can sit under a spinner line, so look for it first.
  if (
    /do you want to (proceed|make this edit|create|allow|run|overwrite|use)/i.test(tail) ||
    (/❯\s*1\.\s*yes/i.test(tail) && /\b2\.\s*(yes|no)/i.test(tail))
  ) {
    return 'waiting'
  }
  if (/esc to interrupt/i.test(tail)) return 'busy'
  return 'idle'
}
