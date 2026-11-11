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

/**
 * Strip what a copy-paste or a .env line leaves around a key: surrounding
 * whitespace, a wrapping pair of quotes, and a trailing comma from a key
 * lifted out of JSON.
 */
export function cleanApiKey(raw: string | undefined | null): string {
  let value = (raw ?? "").trim()
  if (value.endsWith(",")) value = value.slice(0, -1).trim()
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  if (quoted) value = value.slice(1, -1).trim()
  return value
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
