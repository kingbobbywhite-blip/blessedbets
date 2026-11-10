/**
 * Request plumbing shared by the routes that call the odds feeds: reading The
 * Odds API's quota headers and errors, turning a thrown fetch into a sentence,
 * and the two decisions every pull makes the same way (which games are still
 * worth pricing, and whether a pull priced anything at all).
 */

import {
  FeedKeyError,
  ODDS_API_KEY_SHAPE,
  describeKey,
  keySourceHint,
  looksLikeOddsApiKey,
  type ResolvedKey,
} from "./api-key"

/**
 * A count from a response header, or null when the header is absent or not a
 * number. Number(null) is 0, which read as "no requests left" whenever a
 * response arrived without the header.
 */
export function headerCount(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw == null || raw.trim() === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** The sentences that are there, joined. */
function sentences(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ")
}

/**
 * The Odds API ends its bad-key sentence with where to sign up. Said to
 * someone whose key the feed has just refused, that reads as "get another
 * key", and a new key changes nothing while the old one is still what this app
 * sends.
 */
function withoutSignupAdvice(detail: string): string {
  return detail.replace(/\s*Get an API key at \S+\s*$/i, "").trim()
}

/**
 * What to do about a key The Odds API refused, given the key that was sent.
 *
 * "The Odds API rejected the API key" is true and, on its own, no use to
 * someone looking at an account page that says the key is active. Both can be
 * right at once, because the key on the account page and the key this app sent
 * are not necessarily the same key, and nothing on screen showed the second
 * one: it sits in a masked field, or in a file on the server that outranks
 * that field. A real install was told its key was not valid while the feed
 * answered that same key correctly from anywhere else. So the refusal says
 * which key went, where it lives and how to tell it from the right one.
 *
 * A key from Settings is described back to the browser that sent it. A key
 * from the environment is named and never described: see describeKey.
 */
export function refusedOddsApiKeyAdvice(key: ResolvedKey | null): string {
  if (!key) return ""
  const shaped = looksLikeOddsApiKey(key.key)
  if (key.source === "environment") {
    return sentences(
      keySourceHint(key),
      shaped
        ? null
        : `What is there is not the shape of an Odds API key, which is ${ODDS_API_KEY_SHAPE}, so check it for anything besides the key.`,
    )
  }
  return sentences(
    `The key sent is the one saved in this browser under ${key.label}: ${describeKey(key.key)}.`,
    shaped
      ? // Either way the fix is the same paste, so it is said for both: a key
        // that ends the same and is still refused differs somewhere else.
        "Compare it with the key on your the-odds-api.com account. If that one ends differently, the saved key is out of date; either way, clear that field and paste the current key. Keys are kept per browser and per address the app is opened at, so a key changed on another device or at another address has not changed here."
      : `An Odds API key is ${ODDS_API_KEY_SHAPE}, so something else was saved with it or in its place: clear that field and paste the key on its own.`,
  )
}

/**
 * What a failed Odds API response means, read once: the sentence to show and
 * whether the key was what it refused.
 */
async function describeOddsApiFailure(
  res: Response,
  key: ResolvedKey | null,
): Promise<{ message: string; keyRejected: boolean }> {
  const text = await res.text().catch(() => "")
  let detail = text.slice(0, 300)
  let code: string | null = null
  try {
    const body = JSON.parse(text) as { message?: unknown; error_code?: unknown }
    if (typeof body.message === "string") detail = body.message
    if (typeof body.error_code === "string") code = body.error_code
  } catch {
    // Not JSON: the raw text is the best there is.
  }
  // Also a 401, and not about the key: a used-up month is fixed by waiting.
  if (code === "OUT_OF_USAGE_CREDITS") {
    return { message: sentences("The Odds API quota is used up for this period.", detail), keyRejected: false }
  }
  if (res.status === 401) {
    return {
      message: sentences(
        "The Odds API rejected the API key.",
        key ? withoutSignupAdvice(detail) : detail,
        refusedOddsApiKeyAdvice(key),
      ),
      keyRejected: true,
    }
  }
  if (res.status === 429) {
    return {
      message: sentences("The Odds API is limiting requests. Wait a minute and try again.", detail),
      keyRejected: false,
    }
  }
  return { message: sentences(`The Odds API returned ${res.status}.`, detail), keyRejected: false }
}

/**
 * A readable sentence from a failed Odds API response, naming an exhausted
 * quota as such and, given the key that was sent, saying where a refused one
 * came from.
 */
export async function oddsApiErrorText(res: Response, key?: ResolvedKey | null): Promise<string> {
  return (await describeOddsApiFailure(res, key ?? null)).message
}

/** The error to throw for a failed Odds API response, typed so a refused key is recognisable. */
export async function oddsApiFailure(res: Response, key?: ResolvedKey | null): Promise<Error> {
  const { message, keyRejected } = await describeOddsApiFailure(res, key ?? null)
  return keyRejected ? new FeedKeyError(message) : new Error(message)
}

/**
 * GET a JSON payload from The Odds API, with the quota it reports.
 *
 * `last` is what this one request cost, which the feed states and this app
 * used to throw away. It is the difference between telling someone what a
 * pull probably cost and telling them what it did cost, and the app's own
 * rule is that it does not present a number it cannot verify when it can.
 *
 * Read per request rather than as an x-requests-used delta on purpose: the
 * quota counter is per key, so a second device on the same key mid-pull makes
 * the delta measure someone else's pull as well as this one.
 *
 * `key` is the key the URL carries and where it came from, so a refusal can
 * say which key it was. It is never sent anywhere from here.
 */
export async function fetchOddsApi<T>(
  url: string,
  key?: ResolvedKey | null,
): Promise<{ data: T; remaining: number | null; used: number | null; last: number | null }> {
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw await oddsApiFailure(res, key)
  return {
    data: (await res.json()) as T,
    remaining: headerCount(res.headers, "x-requests-remaining"),
    used: headerCount(res.headers, "x-requests-used"),
    last: headerCount(res.headers, "x-requests-last"),
  }
}

/**
 * What a pull was actually billed, and how much of it could be read.
 *
 * `unmeasured` is the honest part. A response with no per-request cost is not
 * a free request, and the two must not collapse: Number(null) is 0, which is
 * the same trap headerCount exists to avoid, and a feed that omits the header
 * would otherwise make every pull look free.
 */
export interface MeasuredCost {
  /** Credits the feed said it charged, across the requests that reported one. */
  credits: number
  /** Requests that reported a cost. */
  measured: number
  /** Billed requests that reported none, so the total is a floor rather than a sum. */
  unmeasured: number
}

export function emptyCost(): MeasuredCost {
  return { credits: 0, measured: 0, unmeasured: 0 }
}

/** Fold in a billed request's reported cost, counting silence as a gap. */
export function addCost(cost: MeasuredCost, last: number | null): MeasuredCost {
  if (last == null) {
    cost.unmeasured++
    return cost
  }
  cost.credits += last
  cost.measured++
  return cost
}

/**
 * Fold in a request the estimate never charged for — the events listing, which
 * the vendor documents as free.
 *
 * Its cost is added when reported and ignored when not. A listing with no
 * figure is not a hole in the measurement; it is a request that was never in
 * the total being compared against, so counting it as unmeasured would make
 * every single pull read as impossible to total.
 */
export function addFreeCost(cost: MeasuredCost, last: number | null): MeasuredCost {
  if (last != null) cost.credits += last
  return cost
}

export function sumCosts(costs: MeasuredCost[]): MeasuredCost {
  return costs.reduce(
    (a, c) => ({
      credits: a.credits + c.credits,
      measured: a.measured + c.measured,
      unmeasured: a.unmeasured + c.unmeasured,
    }),
    emptyCost(),
  )
}

/**
 * The message for an error thrown while calling a feed. fetch reports an
 * unreachable host as a bare "fetch failed" and a non-JSON body as a parser
 * error, neither of which says that the feed, not the app, is the problem.
 */
export function feedErrorText(err: unknown, feed: string): string {
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return `Could not reach ${feed}. Check the internet connection and try again.`
  }
  if (err instanceof SyntaxError) return `${feed} sent a response this app could not read. Try again in a minute.`
  return err instanceof Error ? err.message : String(err)
}

/**
 * Whether a game is still ahead of us. Once it starts, its lines move with the
 * score and the pick'em apps close it, so a pregame pick on it can no longer be
 * played: pulling it spends quota on prices nobody can use. A start time that
 * cannot be read is kept, because there is no telling.
 */
export function notStarted(commenceTime: string | null | undefined, now: number): boolean {
  const t = commenceTime ? Date.parse(commenceTime) : NaN
  return !Number.isFinite(t) || t > now
}

/**
 * When every game's request failed, the error to answer with instead of an
 * empty slate. An empty 200 reads as "no props posted yet" and replaces the
 * last good pull, which may have cost credits that are now used up.
 */
export function noneCouldBePriced(selected: number, priced: number, failures: { error: string }[]): string | null {
  if (selected === 0 || priced > 0 || failures.length === 0) return null
  return `None of the ${selected} game${selected === 1 ? "" : "s"} could be priced. ${failures[0].error}`
}
