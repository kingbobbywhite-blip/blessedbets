import * as React from "react"
import { readApiJson } from "@/lib/api-response"
import { usableKey } from "@/lib/odds-feed/api-key"
import { parseKeyCheck, type CheckedFeed, type KeyCheck } from "@/lib/odds-feed/check"
import type { LeagueId } from "@/lib/leagues"

export interface KeyCheckState {
  /** The feed is being asked right now. */
  checking: boolean
  /** The feed's answer about the key as it stands in the field, or null before there is one. */
  result: KeyCheck | null
  /** Why there is no answer, when this app's own server was the reason rather than the feed. */
  problem: string | null
  /** Whether there is anything to ask about: a key in the field, or one the server holds. */
  canCheck: boolean
  /** Ask now, whatever was answered before. */
  check: () => void
}

/**
 * Shorter than any key either feed issues. A key still being typed is not
 * asked about on its own; the button asks about whatever is there.
 */
const MIN_TO_ASK_UNPROMPTED = 16

/** How long the field has to stay still before the feed is asked. */
const PAUSE_MS = 700

/** How long an answer stands in for asking again, so moving between tabs of Settings costs nothing. */
const FRESH_MS = 60_000

/** Answers by what they were about, shared by every field on the page. Held in memory only. */
const answers = new Map<string, { at: number; result: KeyCheck }>()

/** For tests: forget every answer. */
export function forgetKeyChecks(): void {
  answers.clear()
}

/**
 * Whether a feed accepts the key a pull would send, asked as the key is typed.
 *
 * The answer always belongs to the key in the field at that moment: editing
 * the field retires it at once, and an answer that arrives for a key since
 * changed is dropped rather than shown against the wrong one. The key the
 * server holds in its environment outranks the field, exactly as on a pull,
 * so with one set the question is about that key and the field is not sent.
 */
export function useKeyCheck(
  feed: CheckedFeed,
  typed: string,
  opts: { serverHasKey: boolean | null; league: LeagueId },
): KeyCheckState {
  const { serverHasKey, league } = opts
  const key = usableKey(typed)
  // What the question is about. Unknown until the server has said whether it
  // holds a key of its own, since that decides which key would be sent.
  const subject = serverHasKey === null ? null : serverHasKey ? "server" : key ? `typed:${key}` : null
  // PropLine is asked for a league's listing, so its answer belongs to the league too.
  const about = subject == null ? null : `${feed}|${subject}|${feed === "propline" ? league : ""}`

  const [answer, setAnswer] = React.useState<{
    about: string
    result: KeyCheck | null
    problem: string | null
  } | null>(null)
  const [asking, setAsking] = React.useState<string | null>(null)
  const turn = React.useRef(0)
  // What to send, as it stands when the request is made rather than when it was scheduled.
  const sending = React.useRef({ typed, league })
  React.useEffect(() => {
    sending.current = { typed, league }
  }, [typed, league])

  const ask = React.useCallback(
    async (subjectKey: string) => {
      const id = ++turn.current
      setAsking(subjectKey)
      try {
        const { typed: value, league: forLeague } = sending.current
        const res = await fetch("/api/keys/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            feed,
            apiKey: feed === "theoddsapi" ? value || undefined : undefined,
            proplineKey: feed === "propline" ? value || undefined : undefined,
            league: forLeague,
          }),
        })
        const json = await readApiJson(res)
        if (id !== turn.current) return
        const result = parseKeyCheck(json)
        if (result) {
          answers.set(subjectKey, { at: Date.now(), result })
          setAnswer({ about: subjectKey, result, problem: null })
        } else {
          const said = (json as { error?: unknown }).error
          setAnswer({
            about: subjectKey,
            result: null,
            problem: typeof said === "string" ? said : `The check could not be made (HTTP ${res.status}).`,
          })
        }
      } catch (err) {
        if (id !== turn.current) return
        setAnswer({
          about: subjectKey,
          result: null,
          problem:
            err instanceof TypeError
              ? "Could not reach this app's server to make the check. Check the connection and try again."
              : err instanceof Error
                ? err.message
                : String(err),
        })
      } finally {
        if (id === turn.current) setAsking(null)
      }
    },
    [feed],
  )

  React.useEffect(() => {
    if (about == null) return
    const known = answers.get(about)
    if (known && Date.now() - known.at < FRESH_MS) {
      setAnswer({ about, result: known.result, problem: null })
      return
    }
    if (subject !== "server" && (key?.length ?? 0) < MIN_TO_ASK_UNPROMPTED) return
    const timer = setTimeout(() => void ask(about), PAUSE_MS)
    return () => clearTimeout(timer)
  }, [about, subject, key, ask])

  // An answer still on its way when the field goes away is nobody's.
  React.useEffect(
    () => () => {
      turn.current++
    },
    [],
  )

  const mine = answer != null && answer.about === about ? answer : null
  return {
    checking: asking != null && asking === about,
    result: mine?.result ?? null,
    problem: mine?.problem ?? null,
    canCheck: about != null,
    check: () => {
      if (about != null) void ask(about)
    },
  }
}
