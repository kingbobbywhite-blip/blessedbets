/**
 * Reading a feed API key from the two places it can come from: the server's
 * environment and the key typed into Settings.
 *
 * Both routes used to take `process.env.X ?? body.x` and trim it. That trim is
 * not enough. A key copied out of a dashboard arrives with a newline, or with
 * the label printed above it; a key written into .env.local as `KEY="abc"`
 * keeps its quotes through some dotenv versions; and a placeholder typed into
 * .env.local from a tutorial or another project's example file beats the real
 * key in Settings and sends the feed a string that was never a key. Each of
 * those comes back as a 401 that reads as "your key is wrong" when the real key
 * is fine.
 */

/** A key's two possible homes, so an error can name the one that was rejected. */
export type KeySource = "environment" | "settings"

export interface ResolvedKey {
  key: string
  source: KeySource
  /** The environment variable or settings field it came from, for error text. */
  label: string
}

/**
 * A feed failure the key is to blame for. Separate from any other error
 * because no retry fixes it and the screen should offer Settings rather than
 * invite a retry that fails the same way.
 */
export class FeedKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FeedKeyError"
  }
}

/** Surrounding whitespace, a trailing comma from a key lifted out of JSON, and a wrapping pair of quotes. */
function stripWrapping(raw: string): string {
  let value = raw.trim()
  if (value.endsWith(",")) value = value.slice(0, -1).trim()
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  if (quoted) value = value.slice(1, -1).trim()
  return value
}

/**
 * The shortest unbroken run of characters taken to be a key when it arrives
 * with other words around it. The words beside a key on an account page are
 * labels, and labels are short.
 */
const MIN_EMBEDDED_KEY = 20

/**
 * Strip what a copy-paste or a .env line leaves around a key: surrounding
 * whitespace, a wrapping pair of quotes, a trailing comma from a key lifted
 * out of JSON, and the label it was copied with.
 *
 * The label is the one that cannot be seen. An account page prints "API Key"
 * on the line above the key, a selection on a phone takes both, and a browser
 * pastes the line break into a one-line field as a space. The field is masked,
 * so "API Key 0123…" is forty dots where thirty-two were meant, and the feed
 * answers the whole string with "API key is not valid" about a key that is
 * valid. No key contains a space, so a value that does is a key plus
 * something: when exactly one part of it is long enough to be a key, that part
 * is the key. With none or several there is no telling which, and the value is
 * left as it is for the feed to refuse and the error to describe.
 */
export function cleanApiKey(raw: string | undefined | null): string {
  const value = stripWrapping(raw ?? "")
  if (!/\s/.test(value)) return value
  const candidates = value
    .split(/\s+/)
    .map(stripWrapping)
    .filter((part) => part.length >= MIN_EMBEDDED_KEY)
  return candidates.length === 1 ? candidates[0] : value
}

/**
 * Placeholders that ship in example files and tutorials. Treating one as a key
 * spends a request to be told it is invalid, and worse, an environment
 * placeholder silently outranks the real key in Settings.
 */
const PLACEHOLDERS = new Set([
  "your_api_key",
  "your_api_key_here",
  "your_key_here",
  "yourkeyhere",
  "api_key",
  "apikey",
  "changeme",
  "change_me",
  "replace_me",
  "replaceme",
  "todo",
  "tbd",
  "none",
  "null",
  "undefined",
  "xxx",
  "xxxx",
  "test",
  "placeholder",
])

/** Whether a cleaned value is a placeholder rather than a key. */
export function isPlaceholderKey(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_")
  return PLACEHOLDERS.has(normalized) || /^x{4,}$/i.test(value)
}

/** A cleaned value that is neither empty nor a placeholder. */
export function usableKey(raw: string | undefined | null): string | null {
  const value = cleanApiKey(raw)
  return value && !isPlaceholderKey(value) ? value : null
}

/**
 * The key to use, and where it came from. The environment wins when it holds a
 * real key, so a deployment's own key cannot be overridden from a browser; a
 * placeholder there is not a real key, and the one in Settings is used instead.
 */
export function resolveKey(
  fromEnv: string | undefined | null,
  fromBody: string | undefined | null,
  labels: { env: string; settings: string },
): ResolvedKey | null {
  const env = usableKey(fromEnv)
  if (env) return { key: env, source: "environment", label: labels.env }
  const body = usableKey(fromBody)
  if (body) return { key: body, source: "settings", label: labels.settings }
  return null
}

/** Where to go and fix the key that a feed just rejected. */
export function keySourceHint(resolved: Pick<ResolvedKey, "source" | "label"> | null): string {
  if (!resolved) return ""
  return resolved.source === "environment"
    ? `The key came from ${resolved.label} in the environment, which takes precedence over the one in Settings: correct it there, or remove it to use the key from Settings.`
    : `The key came from ${resolved.label}.`
}

/** Below this, four characters are too much of a key to show. */
const MIN_LENGTH_FOR_TAIL = 12

/**
 * A key described closely enough to recognise and not closely enough to use:
 * how long it is and how it ends.
 *
 * "The key was rejected" leaves someone holding a working key with nothing to
 * check it against, because the field it sits in is masked. Length and the
 * last four characters are what an account page can be compared with at a
 * glance, and they are the convention for showing a secret that is already on
 * its owner's screen. Only ever for a key that came from Settings, so it is
 * the caller's own key being described back to them: nothing about a key held
 * in the server's environment is returned, not even this much.
 */
export function describeKey(key: string): string {
  const size = `${key.length} character${key.length === 1 ? "" : "s"}`
  return key.length >= MIN_LENGTH_FOR_TAIL ? `${size}, ending in "${key.slice(-4)}"` : size
}

/**
 * Whether a value has the shape of the keys The Odds API issues: 32
 * characters, each a digit or a letter from a to f.
 *
 * Advisory, and used only to explain: a key is never held back for its shape,
 * because the shape is what the vendor issues today rather than something it
 * has promised. Once the feed has refused a key, though, a shape that is wrong
 * says what kind of wrong it is -- something saved with the key or in its
 * place, rather than a key that has been replaced.
 */
export function looksLikeOddsApiKey(key: string): boolean {
  return /^[0-9a-f]{32}$/i.test(key)
}

/** The shape above, in words. */
export const ODDS_API_KEY_SHAPE = "32 characters, each a digit or a letter from a to f"

/** What Settings says beneath a key field, and whether it is a warning. */
export interface SavedKeyNote {
  text: string
  warn: boolean
}

/**
 * The line beneath a key field in Settings: what is saved there, and whether
 * it is the key a pull will send.
 *
 * Both fields are masked, so until this existed there was no way to see what
 * was in one. A key that had been replaced on the vendor's site, a key saved
 * with its label, and the PropLine key pasted into the wrong box all looked
 * the same: a row of dots. Null when there is nothing to say.
 */
export function savedKeyNote(
  raw: string | undefined | null,
  opts: {
    /** The environment variable that outranks this field, e.g. ODDS_API_KEY. */
    envName: string
    /** Whether the server holds that variable, as /api/keys reports it. */
    serverHasKey: boolean
    /** True for The Odds API's field, whose keys have a known shape. */
    oddsApi?: boolean
  },
): SavedKeyNote | null {
  const typed = (raw ?? "").trim()
  // The environment outranks this field, so with a key there this one is not sent.
  const serverKey = `the key in ${opts.envName}, set in this server's environment`
  if (!typed) {
    return opts.serverHasKey ? { text: `A pull sends ${serverKey}, so this field can stay empty.`, warn: false } : null
  }
  const key = usableKey(typed)
  if (!key) {
    return opts.serverHasKey
      ? { text: `That is a placeholder, not a key. A pull sends ${serverKey}.`, warn: false }
      : { text: "That is a placeholder, not a key, so it is never sent.", warn: true }
  }
  const parts = [`Saved in this browser: ${describeKey(key)}.`]
  // Said because the field still holds what was pasted: the dots outnumber the key.
  if (key !== typed) parts.push("The other text pasted with it is ignored.")
  const misshapen = !!opts.oddsApi && !looksLikeOddsApiKey(key)
  if (misshapen) {
    parts.push(
      `An Odds API key is ${ODDS_API_KEY_SHAPE}, so check this against the one on your the-odds-api.com account.`,
    )
  }
  if (opts.serverHasKey) {
    parts.push(
      `Not the key in use: a pull sends ${serverKey}, which takes precedence. Change or remove it there to use this one.`,
    )
  }
  return { text: parts.join(" "), warn: misshapen || opts.serverHasKey }
}
