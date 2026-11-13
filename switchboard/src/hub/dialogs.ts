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

const OPTION_RE = /^[\s│|]*(?:(❯|›|>)\s*)?(\d{1,2})[.)]\s+(.+?)\s*[│|]?\s*$/

export function parseOptions(screen: string): DialogOption[] {
  const options: DialogOption[] = []
  for (const line of screen.split('\n')) {
    const m = OPTION_RE.exec(line)
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
  if (options.length < 2) return unnumberedDevChannels(tail, opts.autoAccept)
  const pick = (re: RegExp) => (opts.autoAccept ? (options.find(o => re.test(o.label)) ?? null) : null)

  if (/development channels?|local development/i.test(tail) && options.some(o => /local development/i.test(o.label))) {
    return { kind: 'dev_channels', options, answer: pick(/local development/i) }
  }
  if (/trust (the files in )?this folder|do you trust|project you created or one you trust|safety check/i.test(tail)) {
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

/** The development-channels warning, in case a version draws its two choices without numbers. */
function unnumberedDevChannels(tail: string, autoAccept: boolean): Dialog | null {
  if (!/development channels?/i.test(tail)) return null
  const lines = tail.split('\n')
  const dev = lines.find(l => /I am using this for local development/i.test(l))
  const exit = lines.find(l => /^[\s│|❯›>]*Exit\s*[│|]?\s*$/.test(l))
  if (!dev || !exit) return null
  const exitFocused = /[❯›>]/.test(exit) && !/[❯›>]/.test(dev)
  const options: DialogOption[] = [
    { number: 1, label: 'I am using this for local development', focused: !exitFocused },
    { number: 2, label: 'Exit', focused: exitFocused },
  ]
  return { kind: 'dev_channels', options, answer: autoAccept ? options[0] : null }
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

/** Keys that move the highlight from the focused option to `target` and press Enter. */
export function keysToChoose(options: DialogOption[], target: DialogOption): string[] {
  const focused = options.findIndex(o => o.focused)
  const from = focused === -1 ? 0 : focused
  const to = options.indexOf(target)
  const keys: string[] = []
  for (let i = from; i < to; i++) keys.push('Down')
  for (let i = from; i > to; i--) keys.push('Up')
  keys.push('Enter')
  return keys
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
