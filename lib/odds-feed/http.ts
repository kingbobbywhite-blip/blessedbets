import { FeedKeyError, keySourceHint, type ResolvedKey } from "./api-key"

/**
 * Request plumbing shared by the routes that call the odds feeds: reading The
 * Odds API's quota headers and errors, turning a thrown fetch into a sentence,
 * and the two decisions every pull makes the same way (which games are still
 * worth pricing, and whether a pull priced anything at all).
 */

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

/**
 * What a failed Odds API response means, read once: the sentence to show, and
 * whether the key was what it refused.
 *
 * An exhausted quota comes back with the same 401 as a bad key and is not a
 * key problem: the key is fine and no other key from the same account would
 * do better, so it must not send anyone to Settings to replace it.
 */
export async function describeOddsApiFailure(
  res: Response,
): Promise<{ message: string; keyRejected: boolean; outOfCredits: boolean; detail: string }> {
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
  const say = (lead: string, keyRejected = false, outOfCredits = false) => ({
    message: `${lead} ${detail}`.trim(),
    keyRejected,
    outOfCredits,
    detail: detail.trim(),
  })
  if (code === "OUT_OF_USAGE_CREDITS") return say("The Odds API quota is used up for this period.", false, true)
  if (res.status === 401) return say("The Odds API rejected the API key.", true)
  if (res.status === 429) return say("The Odds API is limiting requests. Wait a minute and try again.")
  return say(`The Odds API returned ${res.status}.`)
}

/** A readable sentence from a failed Odds API response, naming an exhausted quota as such. */
export async function oddsApiErrorText(res: Response): Promise<string> {
  return (await describeOddsApiFailure(res)).message
}

/** The error for a failed Odds API response: a FeedKeyError when the key is what it refused. */
export async function oddsApiFailure(res: Response): Promise<Error> {
  const { message, keyRejected } = await describeOddsApiFailure(res)
  return keyRejected ? new FeedKeyError(message) : new Error(message)
}

/**
 * What a route answers with when a call to The Odds API threw.
 *
 * A refused key says which key it was. The feed's own sentence -- "API key is
 * not valid" -- reads as "the key you just typed is wrong", and was answered
 * by generating a new key and then another, none of which could help when the
 * key that had been sent was not the one just typed: ODDS_API_KEY in the
 * environment outranks Settings, and a tab that had been open a while could
 * still be holding an older key. PropLine's rejection has named its key since
 * the same thing happened there; this one never did.
 *
 * `needsKey` sends the screen to Settings, so it is only set when Settings is
 * where the refused key came from. For a key from the environment that would
 * be the wrong door: nothing typed there changes which key is sent.
 */
export function oddsApiFailureBody(err: unknown, key: ResolvedKey | null): { error: string; needsKey?: true } {
  const error = feedErrorText(err, "The Odds API")
  if (!(err instanceof FeedKeyError)) return { error }
  // The feed ends its sentence on a link, with no full stop to follow it.
  const said = /[.!?]$/.test(error) ? error : `${error}.`
  return {
    error: [said, keySourceHint(key)].filter(Boolean).join(" "),
    ...(key?.source === "settings" ? { needsKey: true as const } : {}),
  }
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
 */
export async function fetchOddsApi<T>(
  url: string,
): Promise<{ data: T; remaining: number | null; used: number | null; last: number | null }> {
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw await oddsApiFailure(res)
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
  // A request given a time limit that ran out (AbortSignal.timeout).
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `${feed} did not answer in time. Try again in a minute.`
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
