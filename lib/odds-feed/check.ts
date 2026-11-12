import { DEFAULT_LEAGUE, leagueFor, type LeagueId } from "@/lib/leagues"
import { describeKey, looksLikeOddsApiKey, type KeySource, type ResolvedKey } from "./api-key"
import { describeOddsApiFailure, feedErrorText, headerCount } from "./http"
import { describeProplineFailure, proplineEventsUrl, proplineHeaders, proplineQuota } from "./propline"
import { sportsUrl } from "./theoddsapi"

/**
 * Asking a feed whether it accepts a key, without pulling anything.
 *
 * Every way a pull can fail on its key used to be found out the same way: by
 * pressing the button on Today and reading an error about a key nobody could
 * see, since both fields in Settings are masked. A key saved with its label,
 * the two keys in each other's fields, a key replaced on the vendor's site,
 * and a server variable outranking the field all came back as one sentence,
 * "rejected the API key", and were answered by generating another key. That
 * cannot help when the key being sent is not the one just made.
 *
 * So the question is asked where the key is typed, of the feed itself, about
 * exactly the key a pull would send -- resolved the way the pull routes
 * resolve it, environment first -- and the answer names that key by its
 * length and ending. Server-side only: the key travels in the request to the
 * vendor and nowhere else, and nothing of a key the server holds is returned.
 */

export type CheckedFeed = "theoddsapi" | "propline"

export type KeyCheckStatus =
  /** The feed accepted the key. */
  | "ok"
  /** The feed received the key and does not know it. */
  | "rejected"
  /** The feed knows the key and its allowance is used up: not a key problem. */
  | "quota"
  /** There was no key to send. */
  | "missing"
  /** The feed did not answer, which says nothing about the key. */
  | "unreachable"
  /** The feed answered with something else, which says nothing about the key either. */
  | "error"

export interface KeyCheck {
  feed: CheckedFeed
  status: KeyCheckStatus
  /** What to put on the screen. */
  message: string
  /** Where the key that was sent came from, or null when there was none. */
  source: KeySource | null
  /**
   * The key that was sent, by length and ending. Only ever for a key from
   * Settings: nothing describes a key held in the server's environment.
   */
  sent: string | null
  /** Requests left on the key's allowance, when the feed said. */
  remaining: number | null
  used: number | null
  /** What that allowance is counted over. */
  period: "month" | "day"
}

/** Long enough for a slow answer, short enough that the field does not sit on "checking". */
const CHECK_TIMEOUT_MS = 12_000

const NAMES: Record<CheckedFeed, string> = { theoddsapi: "The Odds API", propline: "PropLine" }
const PERIODS: Record<CheckedFeed, "month" | "day"> = { theoddsapi: "month", propline: "day" }

function result(
  feed: CheckedFeed,
  key: ResolvedKey | null,
  status: KeyCheckStatus,
  message: string,
  quota: { remaining: number | null; used: number | null } = { remaining: null, used: null },
): KeyCheck {
  return {
    feed,
    status,
    message,
    source: key?.source ?? null,
    sent: key && key.source === "settings" ? describeKey(key.key) : null,
    remaining: quota.remaining,
    used: quota.used,
    period: PERIODS[feed],
  }
}

/** "this key (32 characters, ending in "ab12")", or the server variable by name and nothing more. */
function named(key: ResolvedKey): string {
  return key.source === "environment" ? `the key in ${key.label}` : `this key (${describeKey(key.key)})`
}

/** Their own words, quoted, when they sent any. */
function quoted(said: string): string {
  const text = said.trim()
  return text ? ` It said: "${text}"` : ""
}

/** What to do about a key the feed does not know, which depends on where the key lives. */
function afterRejection(feed: CheckedFeed, key: ResolvedKey): string {
  if (key.source === "environment") {
    return ` This server sends ${key.label} instead of anything typed here, so correct or remove it where the server is configured: .env.local on your own machine, the project's environment variables on Vercel.`
  }
  const site = feed === "propline" ? "prop-line.com" : "the-odds-api.com"
  const oddsShape = looksLikeOddsApiKey(key.key)
  const shape =
    feed === "theoddsapi" && !oddsShape
      ? " An Odds API key is 32 characters, each 0-9 or a-f, and this is not that shape, so it is likely the PropLine key or something pasted along with the key."
      : feed === "propline" && oddsShape
        ? " It has the shape of an Odds API key, so the two keys may be in each other's fields."
        : ""
  return ` Hold that ending against the key on your ${site} account.${shape}`
}

function unreachable(feed: CheckedFeed, key: ResolvedKey, err: unknown): KeyCheck {
  return result(
    feed,
    key,
    "unreachable",
    `${feedErrorText(err, NAMES[feed])} That is the connection, not a verdict on the key.`,
  )
}

/**
 * Whether The Odds API accepts a key, from its sports listing, which the
 * vendor documents as free of the usage quota.
 */
export async function checkOddsApiKey(key: ResolvedKey | null): Promise<KeyCheck> {
  const feed = "theoddsapi" as const
  if (!key) return result(feed, null, "missing", "No Odds API key to check.")
  let res: Response
  try {
    res = await fetch(sportsUrl(key.key), { cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  } catch (err) {
    return unreachable(feed, key, err)
  }
  const quota = {
    remaining: headerCount(res.headers, "x-requests-remaining"),
    used: headerCount(res.headers, "x-requests-used"),
  }
  if (res.ok) {
    const left =
      quota.remaining != null
        ? ` ${quota.remaining.toLocaleString("en-US")} requests left this month${
            quota.used != null ? `, ${quota.used.toLocaleString("en-US")} used` : ""
          }.`
        : ""
    const lead =
      key.source === "environment"
        ? `The Odds API accepted the key in ${key.label}, which this server sends on every pull.`
        : "The Odds API accepted this key."
    return result(feed, key, "ok", `${lead}${left}`, quota)
  }
  const failure = await describeOddsApiFailure(res)
  if (failure.outOfCredits) {
    return result(
      feed,
      key,
      "quota",
      `The Odds API knows ${named(key)}, but its requests are used up for this period. Another key from the same account will not help; the allowance resets monthly.`,
      quota,
    )
  }
  if (failure.keyRejected) {
    return result(
      feed,
      key,
      "rejected",
      `The Odds API does not recognise ${named(key)}.${quoted(failure.detail)}${afterRejection(feed, key)}`,
    )
  }
  return result(feed, key, "error", `${failure.message} That says nothing about the key itself; try again in a minute.`)
}

/**
 * Whether PropLine accepts a key, from a league's events listing: the request
 * every pull starts with, and one PropLine documents as free. So an accepted
 * key here is a pull's own first request having worked.
 */
export async function checkProplineKey(key: ResolvedKey | null, league: LeagueId = DEFAULT_LEAGUE): Promise<KeyCheck> {
  const feed = "propline" as const
  if (!key) return result(feed, null, "missing", "No PropLine key to check.")
  let res: Response
  try {
    res = await fetch(proplineEventsUrl(league), {
      headers: proplineHeaders(key.key),
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch (err) {
    return unreachable(feed, key, err)
  }
  const q = proplineQuota(res.headers)
  const quota = { remaining: q?.remaining ?? null, used: q?.used ?? null }
  if (res.ok) {
    // The listing itself, counted, so "accepted" is seen to mean data came back.
    const listed = await res.json().catch(() => null)
    const games = Array.isArray(listed)
      ? ` It lists ${listed.length} upcoming ${leagueFor(league).label} game${listed.length === 1 ? "" : "s"}.`
      : ""
    const left = q
      ? ` ${q.remaining.toLocaleString("en-US")} of ${q.limit.toLocaleString("en-US")} requests left today.`
      : ""
    const lead =
      key.source === "environment"
        ? `PropLine accepted the key in ${key.label}, which this server sends on every pull.`
        : "PropLine accepted this key."
    return result(feed, key, "ok", `${lead}${left}${games}`, quota)
  }
  const failure = await describeProplineFailure(res, key)
  if (failure.outOfRequests) {
    return result(
      feed,
      key,
      "quota",
      `PropLine knows ${named(key)}, but today's requests are used up. They reset at 00:00 UTC, and another key from the same account will not help.`,
      quota,
    )
  }
  if (failure.keyRejected) {
    return result(
      feed,
      key,
      "rejected",
      `PropLine does not recognise ${named(key)}.${quoted(failure.said)}${afterRejection(feed, key)}`,
    )
  }
  return result(feed, key, "error", `${failure.message} That says nothing about the key itself.`)
}

/** The /api/keys/check response, read defensively: anything malformed is no result. */
export function parseKeyCheck(json: unknown): KeyCheck | null {
  if (!json || typeof json !== "object") return null
  const o = json as Record<string, unknown>
  const feeds: CheckedFeed[] = ["theoddsapi", "propline"]
  const statuses: KeyCheckStatus[] = ["ok", "rejected", "quota", "missing", "unreachable", "error"]
  if (!feeds.includes(o.feed as CheckedFeed) || !statuses.includes(o.status as KeyCheckStatus)) return null
  if (typeof o.message !== "string") return null
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  return {
    feed: o.feed as CheckedFeed,
    status: o.status as KeyCheckStatus,
    message: o.message,
    source: o.source === "environment" || o.source === "settings" ? o.source : null,
    sent: typeof o.sent === "string" ? o.sent : null,
    remaining: count(o.remaining),
    used: count(o.used),
    period: o.period === "day" ? "day" : "month",
  }
}
