/**
 * Reading a feed API key from the two places it can come from: the server's
 * environment and the key typed into Settings.
 *
 * Both routes used to take `process.env.X ?? body.x` and trim it. That trim is
 * not enough. A key copied out of a dashboard arrives with a newline; a key
 * written into .env.local as `KEY="abc"` keeps its quotes through some dotenv
 * versions; and a placeholder typed into .env.local from a tutorial or another
 * project's example file beats the real key in Settings and sends the feed a
 * string that was never a key. Each of those comes back as a 401 that reads as
 * "your key is wrong" when the real key is fine.
 */

/** A key's two possible homes, so an error can name the one that was rejected. */
export type KeySource = "environment" | "settings"

export interface ResolvedKey {
  key: string
  source: KeySource
  /** The environment variable or settings field it came from, for error text. */
  label: string
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
 * Characters a copy picks up from a web page or an email that cannot be seen
 * and are never part of a key: zero-width spaces and joiners, and the byte
 * order mark.
 */
const INVISIBLE = /[​-‍⁠﻿]/g

/**
 * The shortest unbroken run taken to be the key when other words came with
 * it. The words beside a key on an account page are labels, and labels are
 * short.
 */
const MIN_EMBEDDED_KEY = 20

/**
 * Strip what a copy-paste or a .env line leaves around a key: surrounding
 * whitespace, a wrapping pair of quotes, a trailing comma from a key lifted
 * out of JSON, characters that cannot be seen, and whatever the key was
 * copied along with.
 *
 * That last one is the case nothing on screen could show. A key rarely gets
 * copied alone: an account page prints "API Key" on the line above it, the
 * vendor's welcome email gives it inside a sample request ("...?apiKey=0123"),
 * and a line lifted from an env file reads "ODDS_API_KEY=0123". Pasted whole
 * into a one-line field that is a string the feed has never issued, and the
 * 401 it earns reads as "your key is wrong" about a key that is right.
 *
 * So two shapes are read through. A value that names the key and then gives
 * it ("apiKey=", "API Key:", "X-API-Key:") is the part after the name. And no
 * key contains a space, so a value that does is a key plus something: when
 * exactly one part of it is long enough to be a key, that part is the key.
 * With none or several there is no telling which, and the value is left for
 * the feed to refuse and the check in Settings to describe.
 *
 * A key that arrives on its own is never touched, whatever its shape.
 */
export function cleanApiKey(raw: string | undefined | null): string {
  const value = stripWrapping((raw ?? "").replace(INVISIBLE, "").replace(/ /g, " "))
  const named = value.match(/api[\s_-]?key["']?\s*[=:]\s*["']?([^\s"'&#,]+)/i)
  if (named) return named[1]
  if (!/\s/.test(value)) return value
  const candidates = value
    .split(/\s+/)
    .map((part) => stripWrapping(part).replace(/[.;:]+$/, ""))
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

/**
 * The last four characters of a key: enough to tell one key from another,
 * which is how keys get talked about ("the one ending 4026"), and too little
 * to be worth anything to anyone. Null for a key so short that four
 * characters would be a real part of it.
 */
export function keyEnding(key: string): string | null {
  return key.length >= 12 ? key.slice(-4) : null
}

/**
 * A key described closely enough to recognise and not closely enough to use:
 * how long it is and how it ends. That is what an account page can be held
 * against at a glance, and it is all Settings shows of a key while the field
 * is masked. Only ever for a key that came from Settings, so it is the
 * caller's own key being described back to them.
 */
export function describeKey(key: string): string {
  const size = `${key.length} character${key.length === 1 ? "" : "s"}`
  const ending = keyEnding(key)
  return ending ? `${size}, ending in "${ending}"` : size
}

/**
 * Whether a value has the shape of the keys The Odds API issues: 32
 * characters, each a digit or a letter from a to f.
 *
 * Advisory, and used only to explain a refusal. A key is never held back for
 * its shape, because the shape is what the vendor issues today rather than
 * something it has promised.
 */
export function looksLikeOddsApiKey(key: string): boolean {
  return /^[0-9a-f]{32}$/i.test(key)
}

/**
 * Where to go and fix the key that a feed just rejected.
 *
 * A key from Settings is named by its ending as well. "Rejected the API key"
 * was being answered by generating a new key, and then another, when the key
 * that had actually been sent was a different one altogether: an older key
 * still held by a tab that had been open a while, or by the other of Safari
 * and the home-screen app. Which key it was is the one thing the server knows
 * and the screen did not say.
 *
 * A key from the environment is never described at all. Not one character of
 * it leaves the server (see ./keys), and where it came from is the whole
 * answer anyway: retyping a key in Settings cannot change it.
 */
export function keySourceHint(
  resolved: (Pick<ResolvedKey, "source" | "label"> & { key?: string }) | null,
): string {
  if (!resolved) return ""
  if (resolved.source === "environment") {
    return `The key came from ${resolved.label} in the environment, which takes precedence over the one in Settings: correct it there, or remove it to use the key from Settings.`
  }
  const ending = resolved.key ? keyEnding(resolved.key) : null
  return ending
    ? `The key came from ${resolved.label} and ends in "${ending}".`
    : `The key came from ${resolved.label}.`
}
