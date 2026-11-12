import { NextResponse } from "next/server"
import { crossSiteRejection } from "@/lib/odds-feed/same-origin"
import { resolveKey } from "@/lib/odds-feed/api-key"
import { checkOddsApiKey, checkProplineKey } from "@/lib/odds-feed/check"
import { resolveProplineKeySource } from "@/lib/odds-feed/propline"
import { DEFAULT_LEAGUE, isLeagueId } from "@/lib/leagues"

export const runtime = "nodejs"
// The environment is read on every request, never at build time, for the same
// reason as /api/keys: a key added after a build must still count.
export const dynamic = "force-dynamic"

/**
 * Asks a feed whether it accepts the key a pull would send, and pulls nothing.
 *
 * The key is resolved exactly as the pull routes resolve it -- the server's
 * environment first, then the key sent from Settings -- so the answer is about
 * the key that would really go, which is not always the one just typed. It is
 * sent to that feed and nowhere else, never logged, and never returned: a key
 * from Settings comes back only as its length and last four characters, and a
 * key the server holds is not described at all.
 *
 * The Odds API is asked for its sports listing, which is free of the usage
 * quota. PropLine is asked for the league's events listing, the request a
 * pull starts with, at most one of its 1,000 a day.
 */

interface RequestBody {
  /** "theoddsapi" or "propline": which feed to ask. */
  feed?: string
  apiKey?: string
  proplineKey?: string
  /** The league whose listing PropLine is asked for. Defaults to the NBA. */
  league?: string
}

export async function POST(request: Request) {
  // Before any key is read: another site's page must not probe this server's keys.
  const refused = crossSiteRejection(request)
  if (refused) return refused

  let body: RequestBody
  try {
    body = (await request.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: "Request body was not valid JSON." }, { status: 400 })
  }
  if (body.feed !== "theoddsapi" && body.feed !== "propline") {
    return NextResponse.json({ error: 'Say which feed to check: "theoddsapi" or "propline".' }, { status: 400 })
  }

  const check =
    body.feed === "propline"
      ? await checkProplineKey(
          resolveProplineKeySource(body.proplineKey),
          isLeagueId(body.league) ? body.league : DEFAULT_LEAGUE,
        )
      : await checkOddsApiKey(
          resolveKey(process.env.ODDS_API_KEY, body.apiKey, {
            env: "ODDS_API_KEY",
            settings: "Settings → Odds feed → The Odds API key",
          }),
        )
  return NextResponse.json(check, { headers: { "cache-control": "no-store" } })
}
