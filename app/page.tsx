"use client"

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"
import { CalendarDays, KeyRound, Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { SlipCard } from "@/components/slip-card"
import { StatTile } from "@/components/stat-tile"
import { ValueBetRow } from "@/components/value-bet-row"
import { DfsTargetRow } from "@/components/dfs-target-row"
import { PayoutCapture } from "@/components/payout-capture"
import { SideBadge } from "@/components/side-badge"
import { CompetitionBadge } from "@/components/competition-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DEFAULT_CORRELATION } from "@/lib/quant/correlation"
import { bookProfile, isSharp } from "@/lib/quant/books"
import {
  DEFAULT_APPS,
  capturedFromMode,
  findApp,
  findMode,
  capturedPayoutChanged,
  offeredMultiples,
  payoutKey,
  pickemBar,
  validateCapture,
  pickemPricingModeFor,
  type CapturedPayout,
} from "@/lib/quant/payouts"
import type { FeedQuote } from "@/lib/quant/valuebets"
import { buildPickemEntry, hasAppLines, pickemPlays, sideBars, upcomingQuotes } from "@/lib/today/build"
import { useDailyPicks, type PickInputs } from "@/hooks/use-daily-picks"
import { snapshotFor } from "@/lib/quant/lines"
import { entryExpectation } from "@/lib/tracker/entries"
import { marketsForCompetition } from "@/lib/odds-feed/theoddsapi"
import { PROPLINE_FREE_DAILY } from "@/lib/odds-feed/propline"
import { NO_SERVER_KEYS, hasFeedKey, parseServerKeys, type ServerKeys } from "@/lib/odds-feed/keys"
import { usableKey } from "@/lib/odds-feed/api-key"
import { notStarted } from "@/lib/odds-feed/http"
import { useStore } from "@/lib/store/provider"
import {
  LEAGUES,
  TAB_LEAGUE_IDS,
  companionsOf,
  creditPlan,
  inSeason,
  leagueFor,
  pullPlan,
  type LeagueId,
} from "@/lib/leagues"
import { pct, possessive, shortDate, signedPct } from "@/lib/format"

/** "Minnesota Lynx at New York Liberty, Tue, Sep 29, 8:00 PM" in the viewer's own timezone. */
function nextGameText(e: { commence_time: string; home_team: string; away_team: string }): string {
  const when = new Date(e.commence_time).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  return `${e.away_team} at ${e.home_team}, ${when}`
}

/** "prizepicks" to "PrizePicks", for the pick'em apps PropLine carries. */
function appName(id: string): string {
  return findApp(DEFAULT_APPS, id)?.name ?? id
}

export default function TodayPage() {
  const { state, setDaily, setSettings, addLineSnapshot, ready } = useStore()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [needsKey, setNeedsKey] = React.useState(false)
  // The spend the button is waiting to be told to make, or null.
  const [confirmSpend, setConfirmSpend] = React.useState<string | null>(null)
  // Which keys the server holds in its environment, which the routes use
  // before any key from Settings. Null until the server has answered.
  const [serverKeys, setServerKeys] = React.useState<ServerKeys | null>(null)
  // The clock that retires games from a cached pull as they start. A minute is
  // fine-grained enough for tip-off and cheap enough to rebuild the picks on.
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  React.useEffect(() => {
    let live = true
    fetch("/api/keys", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (live) setServerKeys(parseServerKeys(json))
      })
      .catch(() => {
        if (live) setServerKeys(NO_SERVER_KEYS)
      })
    return () => {
      live = false
    }
  }, [])

  const s = state.settings
  const usePropline = s.oddsFeed.provider === "propline"
  const hasKey = hasFeedKey(s.oddsFeed, serverKeys ?? NO_SERVER_KEYS)
  // Hold the setup card back until the server has said whether it has a key,
  // so an install set up through .env.local never flashes it.
  const needsSetup = !hasKey && serverKeys !== null
  // The switch decides whether pick'em lines are used at all. The server
  // pulls them only when it has a PropLine key, from Settings or the environment.
  const wantPickem = s.oddsFeed.pickemLines

  const leagueId = s.daily.league
  const league = leagueFor(leagueId)
  // Companions are opt-in, and the switch only means something where the
  // league has one. College football rides inside the NFL section.
  const companions = companionsOf(leagueId)
  const wantCompanions = s.daily.companions && companions.length > 0
  // Only ever show the cache belonging to the league on screen. Rendering an
  // NBA pull under an NFL heading would be worse than showing nothing.
  const daily = state.daily[leagueId] ?? null
  // Only games still to start are worth a pick; the rest of the pull is kept,
  // so this undoes itself if the clock was wrong.
  const upcoming = React.useMemo(() => {
    if (!daily) return []
    const live = upcomingQuotes(daily.quotes as FeedQuote[], now)
    // With the switch off, a companion's games from an earlier pull stay in
    // the cache but out of the picks, so the screen matches the setting and
    // turning the switch back on costs nothing.
    return wantCompanions ? live : live.filter((q) => !q.competition || q.competition === leagueId)
  }, [daily, now, wantCompanions, leagueId])
  // Companion games held back that way, counted rather than silently dropped.
  const companionHeld = React.useMemo(() => {
    if (!daily || wantCompanions) return 0
    return new Set(
      daily.quotes
        // Only games still to start: one that kicked off is gone whatever the
        // switch says, and promising it back by flicking a setting is a lie.
        .filter((q) => q.competition && q.competition !== leagueId && notStarted(q.commenceTime, now))
        .map((q) => q.gameId),
    ).size
  }, [daily, wantCompanions, leagueId, now])
  const startedSincePull = daily
    ? new Set(daily.quotes.filter((q) => !notStarted(q.commenceTime, now)).map((q) => q.gameId)).size
    : 0
  // A PropLine pull carries the lines whatever the switch says; it is honoured here.
  const pickemLines = wantPickem ? daily?.pickemLines : undefined
  // Credits are The Odds API's monthly quota. PropLine counts requests per day,
  // one per game whatever the markets, so a slate is never a quota event there.
  // Mirrors the route: the body's cap, floored at 1 and ceilinged at 20.
  const requestedMaxGames = Math.max(1, Math.min(s.daily.maxGames, 20))
  // What the next press would spend, per competition. Each competition can be
  // asked for a different market list, and credits are billed per market per
  // game, so a combined game count times one market count is the wrong sum.
  const plannedCredits = React.useMemo(
    () =>
      // The cap the REQUEST sends, not the league's default. Clamping the
      // preview to the league default while the body sent the dial's value
      // meant a raised cap was never priced and the gate never opened: 20 NBA
      // games at five markets is 100 credits shown as 70. The market list
      // depends on the feed too, since width is free on a per-request one.
      pullPlan(leagueId, requestedMaxGames, { companions: wantCompanions }).reduce(
        (a, p) =>
          a +
          p.games * marketsForCompetition(p.league, s.daily.markets, { billsPerRequest: usePropline }).length +
          // A competition that chooses its games by market depth buys one
          // sport-level call to do it. Whether it fires depends on the slate
          // being bigger than the cap, which cannot be known before the press,
          // so it is counted: the gate asking a credit early is the safe way
          // to be wrong about it.
          (p.league.depthRanked ? 1 : 0),
        0,
      ),
    [leagueId, requestedMaxGames, s.daily.markets, wantCompanions, usePropline],
  )
  const cost = usePropline
    ? { message: null, severe: false, confirm: false, prompt: null, credits: 0 }
    : creditPlan(leagueId, plannedCredits)

  function selectLeague(next: LeagueId) {
    setSettings((prev) => ({
      ...prev,
      // The game cap travels with the league: an NFL cap on an NBA slate
      // misses part of it, and each league's cap is sized to its own slate.
      daily: { ...prev.daily, league: next, maxGames: LEAGUES[next].maxGames },
    }))
    setError(null)
    setNeedsKey(false)
  }

  const entryApp = findApp(s.apps, s.defaultAppId)
  const entryMode = findMode(entryApp, s.defaultModeId)
  // The payout read off your own screen for this exact entry size, if there
  // is one. It beats every stored table, because it is the only one anybody
  // has actually read.
  const payoutSlot = payoutKey(s.defaultAppId, s.defaultModeId, s.constraints.picks)
  const savedPayout = s.capturedPayouts[payoutSlot] ?? null
  // What the capture form is showing. Seeded from the saved capture when there
  // is one, else from the stored table so the form starts somewhere rather
  // than blank — the seed is never treated as read, only as a starting point,
  // because `confirmed` is what makes a capture count.
  const [capture, setCapture] = React.useState<CapturedPayout | null>(null)
  const seededCapture = React.useMemo<CapturedPayout>(() => {
    if (savedPayout) return savedPayout
    if (entryMode) return capturedFromMode(entryMode, s.constraints.picks)
    // capturedAt is stamped when the form is confirmed, so an unconfirmed
    // seed's value never reaches storage; a fixed one keeps this memo from
    // changing identity every time the minute clock ticks.
    return { picks: s.constraints.picks, tiers: {}, confirmed: false, capturedAt: "" }
  }, [savedPayout, entryMode, s.constraints.picks])
  // A change of app, mode or entry size is a different payout, so the form
  // follows it rather than keeping a number read for something else.
  React.useEffect(() => setCapture(null), [payoutSlot])
  const captureValue = capture ?? seededCapture

  /**
   * Only a confirmed capture is stored; anything else is a half-typed table.
   *
   * And settings are only touched when what is STORED would actually change.
   * Every write persists the whole state blob, which on a full slate is
   * megabytes of quotes, so writing once per keystroke made typing a payout
   * in re-serialise the entire cache on every character. The in-progress form
   * lives in React state, where it costs nothing.
   */
  const saveCapture = React.useCallback(
    (next: CapturedPayout) => {
      setCapture(next)
      if (!capturedPayoutChanged(savedPayout, next)) return
      const keep = next.confirmed && validateCapture(next).length === 0
      setSettings((prev) => {
        // Keyed off prev, not the render's slot: the two agree unless the app,
        // mode or size changed in between, and then prev is the right one.
        const slot = payoutKey(prev.defaultAppId, prev.defaultModeId, prev.constraints.picks)
        const kept = { ...prev.capturedPayouts }
        if (keep) kept[slot] = next
        else delete kept[slot]
        return { ...prev, capturedPayouts: kept }
      })
    },
    [setSettings, savedPayout],
  )

  // The bar a pick'em leg has to clear. It is not a priced number: it is read
  // off a stored payout table, and every table this app ships is one nobody
  // has confirmed against a real entry screen. Because that bar decides which
  // props become targets at all and which side each row recommends, where it
  // came from travels with it and is printed beside it.
  //
  // Below a capture, the bar comes from your own logged entries of this size
  // where they were offered less than the stored table: PrizePicks varies the
  // multiplier from entry to entry, and a leg has to clear the bar at the
  // payout the entry may actually get.
  const offered = React.useMemo(
    () => offeredMultiples(state.slips, s.defaultAppId, s.defaultModeId, s.constraints.picks),
    [state.slips, s.defaultAppId, s.defaultModeId, s.constraints.picks],
  )
  const bar = React.useMemo(
    () => pickemBar(entryApp, entryMode, s.constraints.picks, savedPayout, offered),
    [entryApp, entryMode, s.constraints.picks, savedPayout, offered],
  )
  // The same bar for each side: an under in this league may have to clear a
  // margin on top, set in Settings. It turns plays into passes and moves no
  // probability. See SideBars.
  const underMargin = s.daily.underMargin[leagueId] ?? 0
  const bars = React.useMemo(() => sideBars(bar.prob, underMargin), [bar.prob, underMargin])
  // An expected value is the table's number as much as the legs', so it is
  // withheld when no table has been checked. Null here is the point.
  const pricingMode = React.useMemo(
    () => pickemPricingModeFor(entryApp, entryMode, s.constraints.picks, savedPayout),
    [entryApp, entryMode, s.constraints.picks, savedPayout],
  )

  // Everything the picks are built from, as one value. The build takes a second
  // or more on a full football Sunday, so it runs off the page's thread (see
  // useDailyPicks): built during render, it froze the page, and a click on the
  // NFL tab could not even highlight it until the build was done.
  const pickInputs = React.useMemo((): PickInputs | null => {
    if (!daily || upcoming.length === 0) return null
    return {
      leagueId,
      pull: daily,
      quotes: upcoming,
      options: {
        value: {
          projection: { ...s.projection, league: leagueId },
          minEdge: s.daily.minEdge,
          suspiciousEdge: 0.12,
          requireSharpReference: s.daily.requireSharpReference,
          maxAmerican: 400,
          // Exchanges take commission on winnings (ProphetX 2%); the app ids match the feed's book keys.
          commission: Object.fromEntries(s.apps.filter((a) => (a.commission ?? 0) > 0).map((a) => [a.id, a.commission!])),
        },
        correlation: s.correlation ?? DEFAULT_CORRELATION,
        constraints: { ...s.constraints, picks: s.daily.parlayLegs },
        dfsBreakEven: bar.prob,
        underMargin,
        pickemMaxProb: s.daily.pickemMaxProb,
        parlayCount: 4,
        bettableBooks: s.oddsFeed.bettable,
        pickemLines,
      },
    }
  }, [daily, upcoming, pickemLines, leagueId, s.projection, s.daily, s.correlation, s.constraints, bar.prob, underMargin, s.oddsFeed.bettable, s.apps])
  const built = useDailyPicks(pickInputs)
  // Picks are shown only while the pull they were built from is the one on
  // screen: never another league's, never a pull a refresh has replaced, and
  // never one an import or a restore has swapped out, which would leave picks
  // up with no pull behind them. A rebuild from the same pull (the minute clock, a
  // settings change) keeps the last picks up until the new ones land, so the
  // screen does not blank once a minute.
  const builtHere = !!daily && built.builtFrom?.pull === daily
  const picks = builtHere ? built.picks : null
  const pricing = built.pricing
  // A build that failed says so, rather than reading as a slate with nothing in it.
  const buildError = builtHere ? built.error : null

  // A ready-to-play pick'em entry at the default app's size and table.
  const entry = React.useMemo(
    () => (picks ? buildPickemEntry(picks.dfsTargets, s.constraints.picks, bars, 2, s.defaultAppId, now) : null),
    [picks, s.constraints.picks, bars, s.defaultAppId, now],
  )
  // What the entry could not use, and why. An entry at the app's own lines
  // leaves out every prop it has no line for, and the difference between "the
  // app is not offering it" and "we never heard" is the user's to see.
  const plays = React.useMemo(
    () => (picks ? pickemPlays(picks.dfsTargets, s.defaultAppId, now) : null),
    [picks, s.defaultAppId, now],
  )
  // Whether this pull carried the default app's own lines, so the entry and
  // the targets can say which line they are at.
  const appLinesLive = !!picks && hasAppLines(picks.dfsTargets, s.defaultAppId)
  // Which apps turned up, counted before the filter shed what nothing could
  // price. Deriving it from the kept lines made an app whose every line was
  // shed read as "posted none in this pull", contradicted by the shed-lines
  // note in the same paragraph. A pull from before this was recorded has only
  // the kept lines to go on, which is the old answer and the best available.
  const pickemAppsSeen =
    daily?.pickemAppsPosted ?? Array.from(new Set((pickemLines ?? []).map((l) => l.app)))
  // Two different claims, and only one of them needs the payout table. The
  // chance every leg hits is a product of leg probabilities and owes the table
  // nothing, so it survives an unverified one. The expected value is a sum
  // over the table's tiers and does not, so it is withheld rather than
  // invented. The cut is exact rather than blunt.
  const entryExp = entry && pricingMode ? entryExpectation(entry.map((l) => l.prob), pricingMode) : null
  const entryAllHit = entry ? entry.reduce((a, l) => a * l.prob, 1) : null
  /**
   * Flavoured lines the default app is posting on this board.
   *
   * A goblin is a safer line that pays less, and a demon a harder one that
   * pays more — and on PrizePicks the change lands on the ENTRY multiplier,
   * not the leg. So a stored standard table does not describe an entry that
   * holds one, and the bar it produces is a floor rather than the bar.
   *
   * This is not theoretical. Four real settled entries paid 8x, 8.5x, 4.5x
   * and 3.75x where the stored table said 10x, 10x, 6x and 6x; the bar was
   * 55-56% where the truth was 59-64%. Eight of their fourteen legs were
   * goblins or demons. An unflagged bar that is nine points light is the app
   * calling a losing leg a target.
   */
  const flavouredOnBoard = React.useMemo(() => {
    if (!picks) return 0
    let n = 0
    for (const t of picks.dfsTargets) {
      if ((t.appLines ?? []).some((l) => l.app === s.defaultAppId && l.pickType !== "standard")) n++
    }
    return n
  }, [picks, s.defaultAppId])

  // Nothing disappears without being counted. "Not offering it" and "we never
  // heard" are different facts and lead to different next steps, so they are
  // never merged into one number.
  const leftOutText = React.useMemo(() => {
    if (!plays || !plays.live) return null
    const name = entryApp?.name ?? "the app"
    const parts: string[] = []
    if (plays.notOffered > 0) {
      parts.push(`${plays.notOffered} ${name} covers and is not posting`)
    }
    if (plays.unknown > 0) {
      parts.push(`${plays.unknown} no ${name} line reached at all`)
    }
    if (parts.length === 0) return null
    return `Left out: ${parts.join("; ")}. Any of them inside the targets below is at the books' line, to check against your screen.`
  }, [plays, entryApp])
  // The 30 likeliest, plus every leg the entry used. A leg's row is where its
  // line can be checked and overridden, so it is shown whether or not it made
  // the top 30.
  const shownTargets = React.useMemo(() => {
    if (!picks) return []
    // Ranked by the chance at the line you can actually play, which is exactly
    // what the Chance column shows: the app's own line where this pull carried
    // one, the books' line where it did not. Ranking everything by the books'
    // line put props at the top that the app posts at a different number, so
    // the order described a board nobody was looking at.
    //
    // A prop with no line from the app keeps its books' chance here rather
    // than sinking below every playable row. It is out of the entry and it is
    // still a row worth seeing: its own line can be typed in, and the card
    // under the entry promises it is here.
    const playable = new Map((plays?.plays ?? []).map((p) => [p.target.key, p.prob]))
    const ranked = appLinesLive
      ? [...picks.dfsTargets].sort(
          (a, b) => (playable.get(b.key) ?? b.marketProb) - (playable.get(a.key) ?? a.marketProb),
        )
      : picks.dfsTargets
    const top = ranked.slice(0, 30)
    const extra = (entry ?? []).map((l) => l.target).filter((t) => !top.includes(t))
    return [...top, ...extra]
  }, [picks, entry, plays, appLinesLive])

  // Books you bet at that the cached pull has no prices from, usually because
  // the pull predates adding them. Refreshing brings them in.
  const missingBettable = picks
    ? s.oddsFeed.bettable.filter((id) => !picks.stats.booksSeen.includes(id)).map((id) => bookProfile(id).name)
    : []

  // Today refuses to price without a sharp reference. When the whole pull is
  // retail-only, that, not a lack of edges, is why the screen is empty.
  const noSharpBook =
    !!picks && s.daily.requireSharpReference && picks.stats.pricedProps === 0 && !picks.stats.booksSeen.some(isSharp)

  // A spend big enough to matter is a question the button asks, not a note it
  // prints: a note beside the button is read after the credits are gone.
  function requestRefresh() {
    if (cost.confirm && cost.prompt) {
      setConfirmSpend(cost.prompt)
      return
    }
    void refresh()
  }

  async function refresh() {
    setConfirmSpend(null)
    setBusy(true)
    setError(null)
    setNeedsKey(false)
    try {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      end.setHours(11, 0, 0, 0) // catch late tips that roll past midnight UTC

      const res = await fetch("/api/today", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: s.oddsFeed.apiKey || undefined,
          provider: s.oddsFeed.provider,
          proplineKey: s.oddsFeed.proplineKey || undefined,
          pickemLines: wantPickem,
          league: leagueId,
          companions: wantCompanions,
          from: start.toISOString(),
          to: end.toISOString(),
          markets: s.daily.markets ?? undefined,
          // References plus every book you can bet at. The feed bills per ten
          // bookmakers as one region, so up to ten costs the same as five.
          bookmakers: Array.from(new Set([...s.oddsFeed.books, ...s.oddsFeed.bettable])).slice(0, 10),
          regions: s.oddsFeed.regions,
          maxGames: s.daily.maxGames,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setNeedsKey(!!data.needsKey)
        setError(data.error ?? `Request failed (${res.status}).`)
        return
      }
      setDaily({
        league: leagueId,
        fetchedAt: data.fetchedAt ?? new Date().toISOString(),
        quotes: data.quotes ?? [],
        events: data.events ?? [],
        requestsRemaining: data.requestsRemaining ?? null,
        // The feed's own figure when it reported one, the estimate when it did
        // not. This field's name has always promised a measurement; until the
        // per-request cost was read it only ever held a forecast.
        creditsSpent: data.measuredCredits ?? data.estimatedCredits ?? 0,
        nextEvent: data.nextEvent,
        startedCount: data.startedCount ?? 0,
        provider: data.provider ?? s.oddsFeed.provider,
        // Only kept when they will be used: each pull lives in this browser's storage.
        pickemLines: wantPickem ? (data.pickemLines ?? undefined) : undefined,
        pickemNote: data.pickemNote ?? null,
        depthNote: data.depthNote ?? null,
        creditNote: data.creditNote ?? null,
        marketsNote: data.marketsNote ?? null,
        creditsMeasured: data.measuredCredits != null,
        pickemAppsPosted: wantPickem ? (data.pickemAppsPosted ?? undefined) : undefined,
      })
      // Keep this pull's lines, compacted, beside the slate itself. The slate
      // is overwritten by the next pull; this is not, and the same prop seen
      // twice at different distances from kick-off is the only thing that can
      // fit the kickoff widening without arguing in a circle.
      if ((data.quotes ?? []).length > 0) {
        addLineSnapshot(
          snapshotFor(
            leagueId,
            data.quotes as FeedQuote[],
            {
              projection: { ...s.projection, league: leagueId },
              minEdge: s.daily.minEdge,
              suspiciousEdge: 0.12,
              requireSharpReference: s.daily.requireSharpReference,
              maxAmerican: 400,
            },
            Date.now(),
            data.fetchedAt ?? new Date().toISOString(),
          ),
        )
      }
      const n = (data.quotes ?? []).length
      toast.success(
        n > 0
          ? `Pulled ${n} ${league.label} prices`
          : data.startedCount > 0
            ? `Every ${league.label} game today has already started`
            : data.nextEvent
              ? `No ${league.label} games today. Next: ${nextGameText(data.nextEvent)}`
              : data.note ?? `No ${league.label} prices for today`,
      )
      if (n > 0 && data.startedCount > 0) {
        toast.info(
          `${data.startedCount} game${data.startedCount === 1 ? " had" : "s had"} already started and ${data.startedCount === 1 ? "was" : "were"} skipped: live games are not priced.`,
        )
      }
      if (data.costSevere && data.costWarning) toast.warning(data.costWarning)
      if (data.cappedOut > 0) {
        toast.info(`${data.cappedOut} more games on the slate were not pulled, to protect your feed quota.`)
      }
      if (data.failures?.length) {
        toast.warning(
          `${data.failures.length} of ${(data.events ?? []).length} games could not be priced`,
          { description: data.failures[0].error },
        )
      }
      if (data.pickemNote && wantPickem) {
        toast.info(data.pickemNote)
      }
      if (data.depthNote) toast.info(data.depthNote)
      if (data.marketsNote) toast.warning(data.marketsNote)
      if (data.creditNote) toast.info(data.creditNote)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!ready) {
    return <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Loading…</p>
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6">
        <header className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-mono text-lg font-semibold tracking-tight">Today</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {daily
                  ? `${daily.events.length} ${league.label} games · pulled ${shortDate(daily.fetchedAt)}${
                      daily.provider === "propline" ? " from PropLine" : ""
                    }${
                      daily.requestsRemaining != null
                        ? daily.provider === "propline"
                          ? ` · ${daily.requestsRemaining} PropLine requests left today`
                          : ` · ${daily.requestsRemaining} feed requests left`
                        : ""
                    }${pickemAppsSeen.length > 0 ? ` · lines from ${pickemAppsSeen.map(appName).join(", ")}` : ""}${
                      startedSincePull > 0
                        ? ` · ${startedSincePull} game${startedSincePull === 1 ? " has" : "s have"} started since, and ${startedSincePull === 1 ? "is" : "are"} hidden`
                        : ""
                    }`
                  : `Pull today's ${league.label} slate and price it.`}
              </p>
            </div>
            <Button onClick={requestRefresh} disabled={busy || !hasKey}>
              {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <RefreshCw className="mr-1 size-3.5" />}
              {daily ? "Refresh" : "Get today's picks"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              role="tablist"
              aria-label="League"
              className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/40 p-1"
            >
              {TAB_LEAGUE_IDS.map((id) => {
                const l = LEAGUES[id]
                const active = id === leagueId
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => selectLeague(id)}
                    className={
                      active
                        ? "rounded-md bg-primary/15 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-primary ring-1 ring-primary/30"
                        : "rounded-md px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    }
                  >
                    {l.short}
                    {state.daily[id] ? <span className="ml-1.5 text-[9px] opacity-60">●</span> : null}
                  </button>
                )
              })}
            </div>
            {wantCompanions ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-primary/80">
                incl. {companions.map((l) => l.short).join(", ")}
              </span>
            ) : companions.length > 0 ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {companions.map((l) => l.short).join(", ")} off
              </span>
            ) : null}
            {!inSeason(leagueId, new Date(), { companions: wantCompanions }) ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                out of season
              </span>
            ) : null}
            {cost.message ? (
              <span
                className={
                  cost.severe
                    ? "text-[11px] text-destructive"
                    : "text-[11px] text-muted-foreground"
                }
              >
                {cost.severe ? <TriangleAlert className="mr-1 inline size-3" /> : null}
                {cost.message}
              </span>
            ) : null}
          </div>

          <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">{league.note}</p>
        </header>

        <AlertDialog open={confirmSpend != null} onOpenChange={(open) => !open && setConfirmSpend(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-mono text-sm">
                Spend {cost.credits} feed credits?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-xs leading-relaxed">
                {confirmSpend}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
              <AlertDialogAction className="font-mono text-xs" onClick={() => void refresh()}>
                Pull anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {companionHeld > 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {companionHeld} {companions.map((l) => l.label).join(" and ")} game
            {companionHeld === 1 ? "" : "s"} from an earlier pull {companionHeld === 1 ? "is" : "are"} held back
            while the companion switch is off. They are still in this browser&apos;s cache, so turning the switch
            back on in{" "}
            <Link href="/settings" className="text-primary underline underline-offset-2">
              Settings
            </Link>{" "}
            shows them again without spending a credit.
          </p>
        ) : null}

        {needsSetup ? (
          <div className="rounded-xl border border-accent/40 bg-accent/5 p-5">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-accent" />
              <div>
                <h2 className="font-mono text-sm font-semibold">One thing to set up</h2>
                <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  This app needs sportsbook prices. Without them there is nothing to compare a line against, and it
                  will refuse to guess rather than invent an edge for you.
                </p>
                <ol className="mt-3 max-w-2xl list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
                  {usePropline ? (
                    <li>
                      Get a free key at{" "}
                      <a
                        href="https://prop-line.com"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline underline-offset-2"
                      >
                        prop-line.com
                      </a>
                      . The free tier is {PROPLINE_FREE_DAILY.toLocaleString()} requests a day, and it also carries
                      PrizePicks and Underdog lines.
                    </li>
                  ) : (
                    <li>
                      Get a free key at{" "}
                      <a
                        href="https://the-odds-api.com"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline underline-offset-2"
                      >
                        the-odds-api.com
                      </a>
                      . The free tier is 500 requests a month. Or switch the provider to PropLine in Settings: 1,000
                      requests a day, with the pick&apos;em apps&apos; own lines included.
                    </li>
                  )}
                  <li>
                    Paste it into <Link href="/settings" className="text-primary underline underline-offset-2">Settings → Odds feed</Link>,
                    or put{" "}
                    <code className="font-mono">{usePropline ? "PROPLINE_API_KEY" : "ODDS_API_KEY"}=…</code> in a{" "}
                    <code className="font-mono">.env.local</code> file.
                  </li>
                  <li>Come back here and press the button.</li>
                </ol>
              </div>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {error}
              {needsKey ? (
                <>
                  {" "}
                  <Link href="/settings" className="underline underline-offset-2">Open settings</Link>.
                </>
              ) : null}
            </span>
          </p>
        ) : null}

        {picks ? (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile label="Games" value={String(picks.games.length)} hint={`${picks.stats.pricedProps} of ${picks.stats.props} player props priced.`} />
              <StatTile
                label="Value bets"
                value={String(picks.valueBets.length)}
                tone={picks.valueBets.length > 0 ? "good" : "neutral"}
                hint="Offers priced better than the sharp consensus of the other books."
              />
              <StatTile
                label="Parlays"
                value={String(picks.parlays.length)}
                tone={picks.parlays.length > 0 ? "good" : "neutral"}
                hint="Built only from legs that are individually positive expected value."
              />
              <StatTile
                label="Books seen"
                value={String(picks.stats.booksSeen.length)}
                hint={picks.stats.booksSeen.join(", ")}
              />
            </div>

            {picks.parlays.length > 0 ? (
              <section className="space-y-3">
                <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Best parlays today
                </h2>
                <div className="grid gap-4 lg:grid-cols-2">
                  {picks.parlays.map((p) => (
                    <SlipCard
                      key={p.id}
                      slip={p}
                      appId="sportsbook"
                      modeId="parlay"
                      league={leagueId}
                      capturedPayout={{
                        picks: p.legs.length,
                        tiers: { [p.legs.length]: p.evaluation.topMultiple },
                        confirmed: true,
                        capturedAt: new Date().toISOString(),
                      }}
                    />
                  ))}
                </div>
              </section>
            ) : (
              <section className="rounded-lg border border-dashed border-border/60 p-5 text-xs leading-relaxed text-muted-foreground">
                <span className="font-mono uppercase tracking-[0.14em]">No parlay worth playing</span>
                <p className="mt-2 max-w-2xl">
                  A parlay is only worth building from legs that are each positive expected value on their own. There
                  are {picks.valueBets.length} such legs on this slate, and{" "}
                  {picks.valueBets.length < s.daily.parlayLegs
                    ? `a ${s.daily.parlayLegs}-leg parlay needs at least that many.`
                    : "none of the combinations cleared the correlation and diversification limits."}{" "}
                  Betting them singly is the correct move.
                </p>
              </section>
            )}

            {picks.valueBets.length > 0 ? (
              <section className="space-y-3">
                <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Best single bets
                </h2>
                <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
                  Most likely to hit first, by win probability; every one also beats the fair price by your minimum
                  edge. A likelier bet is not a bigger one: a short price pays less, which the stake column accounts
                  for. Each bet names the book to place it at. Prices are from {shortDate(daily!.fetchedAt)} and move;
                  if a line is gone or different in the app, refresh before betting.
                  {picks.stats.hiddenOffers > 0
                    ? ` ${picks.stats.hiddenOffers} more edge${picks.stats.hiddenOffers === 1 ? " was" : "s were"} at books you don't bet at, so ${picks.stats.hiddenOffers === 1 ? "it is" : "they are"} hidden. Change that in Settings.`
                    : ""}
                </p>
                <div className="overflow-x-auto rounded-lg border border-border/60">
                  <table className="w-full min-w-[820px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border/60 bg-card/40 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        <th className="px-3 py-2">Player</th>
                        <th className="px-3 py-2">Market</th>
                        <th className="px-3 py-2">Book</th>
                        <th className="px-3 py-2">Side</th>
                        <th className="px-3 py-2 text-right">Line</th>
                        <th className="px-3 py-2 text-right">Price</th>
                        <th className="px-3 py-2 text-right">Fair</th>
                        <th className="px-3 py-2 text-right">Win prob</th>
                        <th className="px-3 py-2 text-right">Edge</th>
                        <th className="px-3 py-2 text-right">Stake</th>
                      </tr>
                    </thead>
                    <tbody>
                      {picks.valueBets.slice(0, 25).map((b) => (
                        <ValueBetRow key={b.id} bet={b} bankroll={s.bankroll} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : (
              <section className="rounded-lg border border-dashed border-border/60 p-5 text-xs leading-relaxed text-muted-foreground">
                <span className="font-mono uppercase tracking-[0.14em]">No value bets at your books</span>
                <p className="mt-2 max-w-2xl">
                  {noSharpBook
                    ? `Only retail books (${picks.stats.booksSeen.map((id) => bookProfile(id).name).join(", ")}) posted these props, and none of them is a sharp book like Pinnacle, BetOnline or LowVig. Retail books copy each other, so without a sharp price there is nothing trustworthy to measure them against, and the app prices nothing rather than guess. Sharp books often post ${league.label} props closer to tip, so refresh then; or turn off "Today: require a sharp book" in Settings to price against the retail consensus (weaker). `
                    : picks.stats.hiddenOffers > 0
                    ? `${picks.stats.hiddenOffers} edge${picks.stats.hiddenOffers === 1 ? " was" : "s were"} found, but only at books you don't bet at (${picks.stats.hiddenBooks.map((id) => bookProfile(id).name).join(", ")}), so ${picks.stats.hiddenOffers === 1 ? "it is" : "they are"} not shown. `
                    : "None of the prices in this pull beat the fair value by your minimum edge. "}
                  {missingBettable.length > 0
                    ? `This pull has no prices from ${missingBettable.join(", ")}. Refresh to ask for them; a book that doesn't post ${league.label} props will still be missing. `
                    : ""}
                  Your books: {s.oddsFeed.bettable.map((id) => bookProfile(id).name).join(", ") || "none"}.{" "}
                  <Link href="/settings" className="text-primary underline underline-offset-2">Change in Settings</Link>
                  {picks.dfsTargets.length > 0 ? ". The pick'em targets below still apply to PrizePicks and the other apps." : "."}
                </p>
              </section>
            )}

            {picks.dfsTargets.length > 0 ? (
              <section className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-primary">
                    Pick&apos;em entry · {entryApp?.name ?? "your app"} {s.constraints.picks}-pick {entryMode?.label ?? ""}
                  </h2>
                  {/* The bar below is read off this table, so whether anybody
                      has checked it belongs next to the heading rather than
                      buried in Settings. */}
                  {bar.source === "captured" ? (
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">
                      payout read {shortDate(bar.capturedAt ?? "")}
                    </span>
                  ) : bar.source === "tracked" && bar.tracked ? (
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">
                      bar at {bar.tracked.multiple}x, the lowest of your last {bar.tracked.entries} logged
                    </span>
                  ) : bar.source === "placeholder" ? (
                    <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-accent">
                      <TriangleAlert className="size-3" /> no payout table
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-accent">
                      <TriangleAlert className="size-3" /> payouts unverified
                    </span>
                  )}
                </div>

                {/* The bar below is read off a payout table, and a goblin or
                    demon changes the entry's multiplier rather than the leg's,
                    so a standard table cannot describe an entry holding one.
                    Four settled entries put real numbers on what that costs. */}
                {bar.source !== "captured" && flavouredOnBoard > 0 ? (
                  <p className="flex items-start gap-1.5 rounded-lg border border-accent/40 bg-accent/5 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0 text-accent" />
                    <span>
                      <strong className="font-semibold text-foreground">
                        The {pct(bar.prob)} bar is a floor, not the bar.
                      </strong>{" "}
                      {entryApp?.name ?? "This app"} is posting a goblin or demon on {flavouredOnBoard} of these props,
                      and a flavoured pick changes the multiplier for the whole entry rather than for its own leg — so
                      a standard table cannot describe an entry that holds one, and it errs low every time. Read the{" "}
                      &ldquo;$X for $Y&rdquo; off your own entry screen below and this becomes the real bar.
                    </span>
                  </p>
                ) : null}

                <details className="rounded-lg border border-border/60 bg-card/30">
                  <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {bar.source === "captured" ? "Payout you read in" : "Read in the payout your app shows"}
                  </summary>
                  <div className="px-3 pb-3">
                    <PayoutCapture
                      value={captureValue}
                      onChange={saveCapture}
                      suggestedFrom={`${entryApp?.name ?? ""} ${entryMode?.label ?? ""}`.trim()}
                    />
                  </div>
                </details>
                {entry ? (
                  <>
                    <ul className="divide-y divide-border/40 text-sm">
                      {entry.map((l) => (
                        <li key={l.target.key} className="flex items-center justify-between gap-2 py-1.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="font-medium">{l.target.player}</span>
                            <CompetitionBadge competition={l.target.competition} />
                            <span className="font-mono text-[10px] text-muted-foreground">{l.target.marketLabel}</span>
                          </span>
                          <span className="flex items-center gap-1.5 font-mono text-xs">
                            <SideBadge side={l.side} /> {l.line} · {pct(l.prob, 0)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {entryAllHit != null ? `All ${entry.length} hit ${pct(entryAllHit, 1)} of the time. ` : ""}
                      {entryExp
                        ? `At ${possessive(entryApp?.name ?? "the app")} ${entryMode?.label ?? ""} table, read on ${entryApp?.verifiedOn}, that is ${signedPct(entryExp.ev)} expected per entry. `
                        : `There is no expected value here, and that is deliberate: an expected value is the payout table's number as much as the legs', and ${bar.source === "placeholder" ? `no stored table covers a ${s.constraints.picks}-pick ${entryMode?.label ?? "entry"}` : `nobody has confirmed ${possessive(entryApp?.name ?? "this app")} stored table against a real entry screen`}. The chance above owes the table nothing, so it stands. Read the payout off your own entry screen above and it appears. `}
                      One leg per player — keyed on the player and blind to the market, so it never holds a man&apos;s
                      points beside his pts+reb+ast, or his steals beside his steals+blocks — and at most two per
                      game.{" "}
                      {appLinesLive
                        ? `Every line here is ${possessive(entryApp?.name ?? "the app")} own, read through PropLine at ${shortDate(daily!.fetchedAt)}, and each chance is the books' consensus at that exact line. The entry is never built at a line ${entryApp?.name ?? "the app"} may not be posting, so a prop with no line from it is left out whichever reason it has.${leftOutText ? ` ${leftOutText}` : ""} Lines move: if one on your screen differs, check it in the table below.`
                        : `No ${entryApp?.name ?? "app"} lines came through in this pull, so every line here is the books' own — the number to go and look for, not one ${entryApp?.name ?? "the app"} is known to be posting. PrizePicks, Underdog, Sleeper and Real almost always copy it; check each one on your screen before playing it.`}{" "}
                      {bar.source === "captured"
                        ? "Standard picks only. A goblin or demon would change the multiplier, and the payout read in above is for the entry as it stands. "
                        : "Standard picks only — and if you add a goblin or demon yourself, the multiplier drops and this bar becomes too easy, which is the single commonest way an entry that looked like a target was not one. Read your payout in above and the bar follows it. "}
                      Legs are treated as independent, which
                      is safe here rather than a shortcut: there is no same-player pair in the entry at all, and at
                      most two per game leaves only shared game pace, which is small and pulls the answer the
                      pessimistic way.
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Fewer than {s.constraints.picks} props clear the {pct(bar.prob)} bar on this slate, one per
                    player{appLinesLive ? `, at the lines ${entryApp?.name ?? "the app"} is actually posting` : ""}.
                    Padding the entry with coin flips is the bet the bar exists to stop: play a smaller entry, or pass.
                    {underMargin > 0 ? ` Unders have to clear ${pct(bars.under)}, with your margin on ${league.short} unders.` : ""}
                    {appLinesLive && leftOutText ? ` ${leftOutText}` : ""}
                    {bar.source === "placeholder"
                      ? ` That bar is a placeholder, not a table: no stored payout covers a ${s.constraints.picks}-pick ${entryMode?.label ?? "entry"}.`
                      : !bar.verified
                        ? " That bar comes from a payout table nobody has confirmed against a real entry screen, so treat it as a guide rather than a threshold."
                        : ""}
                  </p>
                )}
              </section>
            ) : null}

            {picks.dfsTargets.length > 0 || picks.lopsided.length > 0 ? (
              <section className="space-y-3">
                <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Pick'em targets
                </h2>
                {picks.dfsTargets.length === 0 ? (
                  <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
                    Nothing on this slate is a pick&apos;em target. Every prop that priced was more lopsided than a
                    board would post, and they are all listed below rather than left unmentioned.
                  </p>
                ) : null}
                <p
                  className={
                    picks.dfsTargets.length > 0
                      ? "max-w-3xl text-[11px] leading-relaxed text-muted-foreground"
                      : "hidden"
                  }
                >
                  Most likely to hit first.{" "}
                  {appLinesLive
                    ? `Chance is the favoured side at ${possessive(entryApp?.name ?? "your app")} own line where this pull carried one, and at the books' line where it did not. The row always names which, because only one of the two is on your screen.`
                    : "Chance is the side the books favour, at the line they hang, which is the line a pick'em app almost always copies — not a line any app is known to be posting."}{" "}
                  {!wantPickem
                    ? "The pick'em apps' own lines are switched off in Settings, so if your app shows a different line, type it in. "
                    : pickemAppsSeen.length > 0
                      ? `The apps' own lines (${pickemAppsSeen.map(appName).join(", ")}) are listed under each player, priced off the same books, and ${
                          appLinesLive
                            ? `${possessive(entryApp?.name ?? "your app")} line is filled in for you`
                            : pickemAppsSeen.includes(s.defaultAppId)
                              ? `none of ${possessive(entryApp?.name ?? "your app")} lines matched these props, so type its line in`
                              : `${entryApp?.name ?? "your default app"} posted none in this pull, so type its line in`
                        }. `
                      : usableKey(s.oddsFeed.proplineKey) || serverKeys?.propline
                        ? "No pick'em lines came through in this pull, so if your app shows a different line, type it in. "
                        : "Nothing here can see what PrizePicks or Underdog are offering unless a PropLine key is set in Settings, so if your app shows a different line, type it in. "}
                  You get one answer: the over, the under, or pass. Never both: on a pick&apos;em app one
                  of the two always loses. The bar is a {pct(bar.prob)} per-leg hit rate, from your default{" "}
                  {s.constraints.picks}-pick entry, for standard picks; a goblin or demon pays differently and needs
                  its own bar.
                  {underMargin > 0
                    ? ` An under here has to clear ${pct(bars.under)}: the bar plus the ${(underMargin * 100).toFixed(1)}-point margin on ${league.short} unders you set in Settings. It moves no probability, only which side is a pass, and the tracker's overs-and-unders record is where it gets tested.`
                    : ""}
                  {bar.source === "tracked" && bar.tracked
                    ? ` It is set at ${bar.tracked.multiple}x, the lowest "if every leg hits" payout among your last ${bar.tracked.entries} logged ${entryApp?.name ?? ""} ${s.constraints.picks}-pick entries of standard picks, rather than the stored table's: the multiplier varies from entry to entry, and a leg has to clear the bar at the payout it may actually get.`
                    : ""}
                  {bar.source === "placeholder"
                    ? ` No stored payout table covers that entry size, so the bar is a placeholder and the line between a target and a pass is softer than it looks.`
                    : !bar.verified
                      ? ` That bar is read off a payout table nobody has confirmed, so the line between a target and a pass is softer than it looks.`
                      : ""}
                  {wantPickem && daily?.pickemNote ? ` ${daily.pickemNote}` : ""}
                </p>
                <div
                  className={
                    picks.dfsTargets.length > 0 ? "overflow-x-auto rounded-lg border border-border/60" : "hidden"
                  }
                >
                  <table className="w-full min-w-[760px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border/60 bg-card/40 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        <th className="px-3 py-2">Player</th>
                        <th className="px-3 py-2">Market</th>
                        <th className="px-3 py-2 text-right">Projection</th>
                        <th className="px-3 py-2">Chance</th>
                        <th className="px-3 py-2">Your app&apos;s line</th>
                        <th className="px-3 py-2">Play</th>
                        <th className="px-3 py-2 text-right">Conf</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownTargets.map((t) => (
                        <DfsTargetRow key={t.key} t={t} bar={bars} app={s.defaultAppId} />
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* A table that silently stops at thirty reads as the whole
                    board. It is not, and the entry card above points at these
                    rows, so the count has to be on the page. */}
                {picks.dfsTargets.length > shownTargets.length ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Showing {shownTargets.length} of {picks.dfsTargets.length} targets — the likeliest at the line you
                    can play, plus every leg the entry used. The rest priced the same way and are left out of this
                    table only for length.
                  </p>
                ) : null}
                {picks.lopsided.length > 0 ? (
                  <details className="rounded-lg border border-dashed border-border/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
                    <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em]">
                      {picks.lopsided.length} prop{picks.lopsided.length === 1 ? "" : "s"} left out as too lopsided
                      for a pick&apos;em board
                    </summary>
                    <p className="mt-2 max-w-3xl">
                      The books price these, and the favoured side clears{" "}
                      {pct(s.daily.pickemMaxProb, 0)}, which is the ceiling set in Settings. A flat payout table only
                      works if both sides are plausible, so an app is assumed not to post them at all. That is a
                      judgement about boards rather than a fault in the price: the single bets above still price
                      them, and a line PropLine shows an app really posting is never removed this way. Raise the
                      ceiling in{" "}
                      <Link href="/settings" className="text-primary underline underline-offset-2">
                        Settings
                      </Link>{" "}
                      to see them as targets.
                    </p>
                    <ul className="mt-2 space-y-0.5 font-mono text-[10px]">
                      {picks.lopsided.map((l) => (
                        <li key={l.key} className="flex flex-wrap items-center gap-1.5">
                          <span className="text-foreground/80">{l.player}</span>
                          <CompetitionBadge competition={l.competition} />
                          <span>
                            {l.marketLabel} {l.line} · {pct(l.prob, 0)} one way · {l.gameId.replace("@", " at ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </section>
            ) : null}

            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Games</h2>
              {/* What the pull cost, said once. The figure beside the Refresh
                  button is a forecast made before the press; this is what the
                  feed charged, when the feed said. */}
              {daily ? (
                <p className="mt-2 max-w-3xl font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {daily.provider === "propline"
                    ? `${daily.creditsSpent > 0 ? `${daily.creditsSpent} ` : ""}one request per game against PropLine's daily 1,000, which it does not itemise.`
                    : daily.creditsMeasured
                      ? `${daily.creditsSpent} feed credits, billed by the feed itself.`
                      : daily.creditsMeasured === false
                        ? `About ${daily.creditsSpent} feed credits, estimated: this pull's responses did not say what they cost.`
                        : /* The field is absent, so this pull predates the
                             measurement. Saying its responses were silent
                             would be a claim about responses nothing read. */
                          `About ${daily.creditsSpent} feed credits, estimated. This pull was made before the app read what the feed charged; refresh to measure it.`}
                </p>
              ) : null}
              {daily?.marketsNote ? (
                <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-accent">{daily.marketsNote}</p>
              ) : null}
              {daily?.creditNote ? (
                <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">{daily.creditNote}</p>
              ) : null}
              {daily?.depthNote ? (
                <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">{daily.depthNote}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {picks.games.map((g) => (
                  <Badge key={g.gameId} variant="outline" className="max-w-full whitespace-normal font-mono text-[11px]">
                    <CalendarDays className="mr-1 size-3" />
                    {g.awayTeam} at {g.homeTeam}
                    <span className="ml-1.5 text-muted-foreground">{g.propCount}</span>
                  </Badge>
                ))}
              </div>
            </section>
          </>
        ) : pricing ? (
          <section
            role="status"
            className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/30 p-8 font-mono text-sm uppercase tracking-[0.14em] text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            Pricing the {league.label} slate
          </section>
        ) : buildError ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>Could not price this slate: {buildError}</span>
          </p>
        ) : hasKey && !busy ? (
          <section className="rounded-xl border border-dashed border-border/70 bg-card/30 p-8 text-center">
            <p className="font-mono text-sm uppercase tracking-[0.14em] text-muted-foreground">
              {daily ? `No ${league.label} prices for today` : "Nothing pulled yet"}
            </p>
            <p className="mx-auto mt-3 max-w-lg text-xs leading-relaxed text-muted-foreground">
              {!daily
                ? "Press the button above to pull today's slate. Player props are billed per market per game, so nothing is fetched until you ask."
                : companionHeld > 0
                  ? `Everything still to start in this pull is ${companions.map((l) => l.label).join(" or ")}, which the companion switch is holding back. Nothing has been lost: turn it on in Settings and these games come back without a credit.`
                  : daily.quotes.length > 0
                  ? `Every game in this pull has started since it was pulled, so nothing in it can still be played. Press Refresh for any later games today.`
                  : daily.startedCount
                    ? `Every ${league.label} game today has already started, and live games are not priced: their lines move with the score and the pick'em apps have closed them.${daily.nextEvent ? ` The next game is ${nextGameText(daily.nextEvent)}.` : ""}`
                    : daily.nextEvent
                  ? `There is no ${league.label} game today, so there is nothing to price. The next game is ${nextGameText(daily.nextEvent)}. Press Refresh that day; props usually go up a few hours before tip.`
                  : daily.nextEvent === null
                    ? `The feed lists no upcoming ${league.label} games at all, so the season looks to be over or the next schedule is not posted yet. Nothing is broken; switch leagues above.`
                    : !inSeason(leagueId)
                  ? `${league.label} is out of season right now, so an empty slate is expected rather than a fault. Switch leagues above, or come back when the season starts.`
                  : `The feed returned no ${league.label} player props in today's window. That usually means no games today, or the books have not posted props yet, which is normal until a few hours before tip.`}
            </p>
          </section>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
