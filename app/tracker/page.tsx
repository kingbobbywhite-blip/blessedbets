"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { SideBadge } from "@/components/side-badge"
import { StatTile } from "@/components/stat-tile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  brierScore,
  calibrationBias,
  calibrationBuckets,
  groupedCalibration,
  logLoss,
  summarise,
  type Observation,
} from "@/lib/quant/calibration"
import { LogEntry } from "@/components/log-entry"
import { findApp, findMode } from "@/lib/quant/payouts"
import {
  compareSides,
  entryBreakEven,
  nightReviews,
  openExposure,
  recordBySide,
  recordByType,
  tableMultiple,
  withResults,
  type Exposure,
  type SideRecord,
} from "@/lib/tracker/entries"
import { useStore } from "@/lib/store/provider"
import { MAX_SNAPSHOT_ROWS, type LegResult, type TrackedSlip } from "@/lib/store/schema"
import { money, multiple, pct, shortDate, signedPct } from "@/lib/format"
import { isLoggedLeagueId, loggedLeagueLabel, loggedLeagueShort } from "@/lib/leagues"
import { MARKETS } from "@/lib/nba/markets"
import { fitMovement, lineMoves, summariseHistory } from "@/lib/quant/lines"
import { KICKOFF_VARIANCE_PER_DAY } from "@/lib/quant/valuebets"
import { cn } from "@/lib/utils"

/** Legs needed before the headline calibration number is worth reacting to. */
const CALIBRATION_MIN = 100

export default function TrackerPage() {
  const { state, updateSlip, removeSlip, ready } = useStore()
  const slips = state.slips

  const perf = React.useMemo(() => summarise(slips), [slips])

  const observations = React.useMemo<Observation[]>(
    () =>
      slips
        .flatMap((s) => s.legs)
        .filter((l) => (l.result === "WIN" || l.result === "LOSS") && l.pWinAtEntry != null)
        .map((l) => ({
          p: l.pWinAtEntry as number,
          win: l.result === "WIN",
          competition: l.competition,
          league: l.league,
          market: l.marketKey,
          marketLabel: l.marketLabel,
          side: l.side,
        })),
    [slips],
  )

  const buckets = React.useMemo(() => calibrationBuckets(observations), [observations])
  // The same legs along two more axes, one at a time. A competition-by-market
  // grid would be thirty cells of five results each.
  const byCompetition = React.useMemo(
    () =>
      groupedCalibration(observations, (o) => {
        const id = o.competition ?? o.league
        // A retired league still has logged entries, and they still have to
        // report: see RETIRED_LEAGUES.
        return id ? { key: id, label: isLoggedLeagueId(id) ? loggedLeagueLabel(id) : id } : null
      }),
    [observations],
  )
  const byMarket = React.useMemo(
    () =>
      groupedCalibration(observations, (o) => {
        // Stored slips are never normalised on load, so a leg can carry a
        // market key this version no longer models. Indexing the table by it
        // blind would take the whole page down with it.
        const label = o.market ? MARKETS[o.market]?.label : undefined
        if (o.market && label) return { key: o.market, label }
        return o.marketLabel ? { key: o.marketLabel, label: o.marketLabel } : null
      }),
    [observations],
  )
  // The model's own honesty, side by side: does it flatter NBA unders more
  // than NBA overs? Six cells at most, so one table does not become noise.
  const bySide = React.useMemo(
    () =>
      groupedCalibration(observations, (o) => {
        const id = o.competition ?? o.league
        if (!id || !o.side || !isLoggedLeagueId(id)) return null
        return { key: `${id}|${o.side}`, label: `${loggedLeagueShort(id)} ${o.side === "OVER" ? "overs" : "unders"}` }
      }),
    [observations],
  )
  // Line history: the only estimate of the kickoff widening that is not
  // circular, since a settled leg's probability already had it applied.
  const movement = React.useMemo(() => fitMovement(lineMoves(state.lines)), [state.lines])
  const history = React.useMemo(() => summariseHistory(state.lines), [state.lines])
  const bias = calibrationBias(observations)
  const brier = brierScore(observations)
  const ll = logLoss(observations)
  const exposure = React.useMemo(() => openExposure(slips), [slips])
  const nights = React.useMemo(() => nightReviews(slips).filter((n) => n.exposure.length > 0).slice(0, 3), [slips])
  const record = React.useMemo(() => recordByType(slips), [slips])
  const sides = React.useMemo(() => recordBySide(slips, state.settings.apps), [slips, state.settings.apps])
  // One sentence per league that has both: is the gap bigger than luck makes?
  const sideVerdicts = React.useMemo(() => {
    const out: { league: string; overs: SideRecord; unders: SideRecord; cmp: NonNullable<ReturnType<typeof compareSides>> }[] = []
    for (const o of sides) {
      if (o.side !== "OVER" || !o.league) continue
      const u = sides.find((r) => r.league === o.league && r.side === "UNDER")
      const cmp = u ? compareSides(o, u) : null
      if (u && cmp) out.push({ league: loggedLeagueShort(o.league), overs: o, unders: u, cmp })
    }
    return out
  }, [sides])
  const [logging, setLogging] = React.useState(false)

  // What each settled leg had to hit, on average, at the payouts actually played.
  const bar = React.useMemo(() => {
    let legs = 0
    let acc = 0
    for (const s of slips) {
      if (s.status !== "SETTLED") continue
      const be = entryBreakEven(s, state.settings.apps)
      if (be == null) continue
      const decided = s.legs.filter((l) => l.result === "WIN" || l.result === "LOSS").length
      legs += decided
      acc += be * decided
    }
    return legs > 0 ? acc / legs : null
  }, [slips, state.settings.apps])

  if (!ready) {
    return <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Loading…</p>
  }

  if (slips.length === 0) {
    return (
      <div className="space-y-6">
        <EmptyState
          title="Nothing logged yet"
          body="Log entries you placed below, or from the build screen, then settle each leg here once the games finish. Results are the only thing that can tell you whether the model is honest, and it takes a few hundred legs before the answer means much."
          actionLabel="Build entries"
          actionHref="/build"
        />
        <LogEntry />
      </div>
    )
  }

  function settleLeg(slip: TrackedSlip, index: number, result: LegResult) {
    // Settles against the payout captured from the screen, and the stored
    // table for a smaller size when a player did not play.
    updateSlip(slip.id, (s) => withResults(s, s.legs.map((l, i) => (i === index ? { ...l, result } : l)), state.settings.apps))
  }

  const decided = record.priced.wins + record.priced.losses + record.unpriced.wins + record.unpriced.losses
  const hits = record.priced.wins + record.unpriced.wins

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-lg font-semibold tracking-tight">Tracker</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Settle each leg and the entry prices itself against the payout table you used. Calibration compares what the
          model predicted against what happened, which is the only honest test of whether it works.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={logging ? "secondary" : "default"} onClick={() => setLogging((v) => !v)}>
          {logging ? "Close" : "Log an entry you placed"}
        </Button>
      </div>
      {logging ? <LogEntry onDone={() => setLogging(false)} /> : null}

      {exposure.length > 0 ? (
        <section className="rounded-lg border border-accent/40 bg-accent/5 p-4 text-xs leading-relaxed">
          <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-accent">Same player in several open entries</h2>
          <ul className="mt-2 space-y-1">
            {exposure.map((e) => (
              <ExposureItem key={e.player} e={e} open />
            ))}
          </ul>
        </section>
      ) : null}

      {nights.map((n) => (
        <section key={n.day} className="rounded-lg border border-border/60 bg-card/40 p-4 text-xs leading-relaxed">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Overlap on {new Date(`${n.day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </h2>
            <span className="font-mono text-[11px] text-muted-foreground">
              {n.entries} entries · {money(n.staked)} in · {money(n.returned)} back ·{" "}
              <span className={n.returned >= n.staked ? "text-primary" : "text-destructive"}>{money(n.returned - n.staked)}</span>
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {n.exposure.map((e) => (
              <ExposureItem key={e.player} e={e} />
            ))}
          </ul>
        </section>
      ))}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Settled" value={`${perf.settled}/${perf.entries}`} hint={`${perf.wins} returned a profit, ${perf.losses} did not.`} />
        <StatTile
          label="Profit"
          value={money(perf.profit)}
          tone={perf.profit > 0 ? "good" : perf.profit < 0 ? "bad" : "neutral"}
          hint={`${money(perf.staked)} staked, ${money(perf.returned)} returned.`}
        />
        <StatTile
          label="Return on stake"
          value={perf.roi == null ? "—" : signedPct(perf.roi)}
          tone={perf.roi != null && perf.roi > 0 ? "good" : perf.roi != null && perf.roi < 0 ? "bad" : "neutral"}
          hint={perf.expectedRoi == null ? "Settle an entry to compare." : `The model expected ${signedPct(perf.expectedRoi)}.`}
        />
        <StatTile
          label="Calibration bias"
          value={bias == null ? "—" : signedPct(bias)}
          /* Only call the bias good or bad once there is enough data to mean
             anything. Flagging a 4-leg sample in red would be exactly the
             mistake the calibration table below warns against. */
          tone={bias == null || observations.length < CALIBRATION_MIN ? "neutral" : Math.abs(bias) > 0.05 ? "bad" : "good"}
          hint={
            bias == null
              ? "Settle some legs first."
              : observations.length < CALIBRATION_MIN
                ? `Too few legs to read yet. ${observations.length} of roughly ${CALIBRATION_MIN} before this number means anything.`
                : bias > 0
                  ? "The model is claiming more than it delivers. Widen the outcome spread in settings."
                  : "The model is understating its legs."
          }
        />
      </div>

      {decided > 0 ? (
        <section className="rounded-lg border border-border/60 bg-card/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Your legs</h2>
            <span className="font-mono text-[11px] text-muted-foreground">
              {hits} of {decided} hit ({pct(hits / decided, 0)})
              {bar != null ? ` · needed about ${pct(bar, 0)} to break even` : ""}
            </span>
          </div>
          <table className="mt-3 w-full text-xs">
            <tbody>
              {[record.byPick, record.byType, [record.priced, record.unpriced]].map((group, g) =>
                group
                  .filter((r) => r.wins + r.losses > 0)
                  .map((r, i) => (
                    <tr key={`${g}-${r.label}`} className={cn("border-t border-border/40", i === 0 && g > 0 && "border-t-2")}>
                      <td className="py-1.5">{r.label}</td>
                      <td className="py-1.5 text-right font-mono tabular-nums">
                        {r.wins}-{r.losses}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                        {pct(r.wins / (r.wins + r.losses), 0)}
                      </td>
                    </tr>
                  )),
              )}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {decided < 50
              ? `${decided} legs is far too few to tell skill from luck: at a 55% true rate, anywhere from about ${pct(Math.max(0, 0.55 - 2 * Math.sqrt(0.2475 / decided)), 0)} to ${pct(Math.min(1, 0.55 + 2 * Math.sqrt(0.2475 / decided)), 0)} is normal. Use this to spot habits, not to judge them.`
              : "A row needs roughly 50 legs before its rate means much. Legs the app never priced are the ones to compare against the ones it did."}{" "}
            Did-not-play and pushes are left out. Goblins should hit far more often than standard picks: they pay
            less for it, so compare each against the bar its own payout set, not against each other.
          </p>

          {sides.length > 0 ? (
            <div className="mt-4 border-t border-border/40 pt-3">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Overs and unders</h3>
              <table className="mt-2 w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="pb-1">Side</th>
                    <th className="pb-1 text-right">Record</th>
                    <th className="pb-1 text-right">Hit</th>
                    <th className="pb-1 text-right">Needed</th>
                  </tr>
                </thead>
                <tbody>
                  {sides.map((r) => {
                    const n = r.wins + r.losses
                    const rate = r.wins / n
                    return (
                      <tr key={r.key} className="border-t border-border/40">
                        <td className="py-1.5">{r.label}</td>
                        <td className="py-1.5 text-right font-mono tabular-nums">
                          {r.wins}-{r.losses}
                        </td>
                        <td
                          className={cn(
                            "py-1.5 text-right font-mono tabular-nums",
                            // Coloured against its own bar only once there are
                            // enough legs for the colour to mean something.
                            r.needed == null || n < 20 ? "text-muted-foreground" : rate >= r.needed ? "text-primary" : "text-destructive",
                          )}
                        >
                          {pct(rate, 0)}
                        </td>
                        <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                          {r.needed != null ? pct(r.needed, 0) : "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {sideVerdicts.map(({ league, overs, unders, cmp }) => (
                  <span key={league} className="block">
                    <span className="text-foreground">
                      {league}: overs {pct(overs.wins / (overs.wins + overs.losses), 0)} over {overs.wins + overs.losses},
                      unders {pct(unders.wins / (unders.wins + unders.losses), 0)} over {unders.wins + unders.losses}.
                    </span>{" "}
                    {cmp.significant
                      ? `A gap of ${Math.round(Math.abs(cmp.gap) * 100)} points is more than twice what luck makes on these samples: the ${cmp.gap > 0 ? "unders" : "overs"} really are trailing. The unders margin under Settings → Odds feed decides how much more an ${league} under has to clear.`
                      : Math.min(overs.wins + overs.losses, unders.wins + unders.losses) < 20
                        ? "Too few to tell the sides apart: it needs twenty legs a side before a gap here can count."
                        : `Within what luck makes on these samples (±${Math.round(2 * cmp.stderr * 100)} points): no real difference yet.`}
                  </span>
                ))}
                Every decided leg counts here, priced or not, with its result read off the screenshot where the ring
                showed one. &ldquo;Needed&rdquo; is the per-leg rate those legs&apos; own entries had to hit to break even,
                which is the bar a side has to be judged against: goblin-heavy entries pay less, so they need more.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {observations.length > 0 ? (
        <section className="rounded-lg border border-border/60 bg-card/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Calibration</h2>
            <span className="font-mono text-[11px] text-muted-foreground">
              {observations.length} settled legs
              {brier != null ? ` · Brier ${brier.toFixed(3)}` : ""}
              {ll != null ? ` · log loss ${ll.toFixed(3)}` : ""}
            </span>
          </div>
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="pb-1">Predicted band</th>
                <th className="pb-1 text-right">Legs</th>
                <th className="pb-1 text-right">Model said</th>
                <th className="pb-1 text-right">Actual</th>
                <th className="pb-1 text-right">Gap</th>
              </tr>
            </thead>
            <tbody>
              {buckets.filter((b) => b.count > 0).map((b) => {
                const gap = b.actual - b.predicted
                const meaningful = Math.abs(gap) > 2 * b.stderr && b.count >= 20
                return (
                  <tr key={`${b.lo}-${b.hi}`} className="border-t border-border/40">
                    <td className="py-1.5 font-mono tabular-nums">
                      {pct(b.lo, 0)}–{pct(Math.min(b.hi, 1), 0)}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{b.count}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{pct(b.predicted)}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{pct(b.actual)}</td>
                    <td
                      className={cn(
                        "py-1.5 text-right font-mono tabular-nums",
                        meaningful ? (gap < 0 ? "text-destructive" : "text-primary") : "text-muted-foreground",
                      )}
                    >
                      {signedPct(gap)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            A gap is only highlighted once it exceeds two standard errors on at least twenty legs. Below that it is
            noise, and reacting to it will make the model worse rather than better.
          </p>

          {[
            { title: "By competition", rows: byCompetition },
            { title: "By market", rows: byMarket },
            { title: "By side", rows: bySide },
          ].map(({ title, rows }) =>
            rows.length === 0 ? null : (
              <div key={title} className="mt-4 border-t border-border/40 pt-3">
                <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{title}</h3>
                <table className="mt-2 w-full text-xs">
                  <thead>
                    <tr className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      <th className="pb-1">{title === "By market" ? "Market" : title === "By side" ? "Side" : "Competition"}</th>
                      <th className="pb-1 text-right">Legs</th>
                      <th className="pb-1 text-right">Model said</th>
                      <th className="pb-1 text-right">Actual</th>
                      <th className="pb-1 text-right">Gap</th>
                      <th className="pb-1 text-right">Spread implied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className="border-t border-border/40">
                        <td className="py-1.5">{r.label}</td>
                        <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{r.count}</td>
                        <td className="py-1.5 text-right font-mono tabular-nums">{pct(r.predicted)}</td>
                        <td className="py-1.5 text-right font-mono tabular-nums">{pct(r.actual)}</td>
                        <td
                          className={cn(
                            "py-1.5 text-right font-mono tabular-nums",
                            r.significant ? (r.bias > 0 ? "text-destructive" : "text-primary") : "text-muted-foreground",
                          )}
                        >
                          {signedPct(-r.bias)}
                        </td>
                        <td
                          className={cn(
                            "py-1.5 text-right font-mono tabular-nums",
                            r.dispersionPegged ? "text-accent" : "text-muted-foreground",
                          )}
                        >
                          {r.impliedDispersion != null
                            ? `${r.dispersionPegged ? "≥" : ""}×${r.impliedDispersion.toFixed(2)}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            &ldquo;Spread implied&rdquo; is the multiplier the outcome-spread slider in Settings would need for these
            predictions to have matched these results: above 1 the model was too confident. It is solved over the
            individual legs rather than their average, it appears only at 25 legs or more, and it is a normal
            approximation to count distributions rather than a fit. A ≥ means the gap is wider than the slider can
            express, so its limit is as far as you can go and it still will not be enough — look at the projections
            rather than the dial. It measures what is left AFTER every correction the app already applies. It cannot be used to fit the kickoff widening,
            because the stored probability already had that applied — only the line history below is independent of
            it. Legs logged before a competition was recorded sit in their own row: a leg keeps no game, so nothing
            can work out afterwards whether it was a college prop or an NFL one.
          </p>
        </section>
      ) : null}

      <section className="rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
            Line movement before kick-off
          </h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            {history.snapshots} pull{history.snapshots === 1 ? "" : "s"} · {history.props} props ·{" "}
            {history.paired} paired
          </span>
        </div>
        {movement.length > 0 ? (
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="pb-1">Market</th>
                <th className="pb-1 text-right">Pairs</th>
                <th className="pb-1 text-right">Days apart</th>
                <th className="pb-1 text-right">Line moved ±</th>
                <th className="pb-1 text-right">Variance / day</th>
                <th className="pb-1 text-right">In use</th>
              </tr>
            </thead>
            <tbody>
              {movement.map((m) => (
                <tr key={m.market} className="border-t border-border/40">
                  <td className="py-1.5">{m.marketLabel}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{m.pairs}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{m.days.toFixed(1)}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{m.sd.toFixed(1)}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {m.variancePerDay != null ? `${(m.variancePerDay * 100).toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                    {pct(KICKOFF_VARIANCE_PER_DAY, 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
          {movement.length > 0
            ? "The last column is the unfitted prior the app widens by: four percent of variance per day until kick-off, capped at twelve. The column beside it is what your own pulls measured, extrapolated to a day. They are directly comparable, and if yours is consistently larger the prior is too small."
            : history.paired > 0
              ? "Not enough pairs in any one market yet to measure anything. Eight is the floor, and a number built on fewer would be worse than the prior it replaced."
              : "Nothing to measure yet. This needs the same prop pulled twice, hours apart — the easiest way is a pull in the morning and another near the first kick-off. Nothing here can manufacture that second look: a refresh costs credits, and the cache exists precisely so the app never spends them on its own."}{" "}
          {history.truncated > 0 ? (
            <>
              {history.truncated} row{history.truncated === 1 ? "" : "s"} across the pulls held{" "}
              {history.truncated === 1 ? "was" : "were"} dropped to fit browser storage, which caps each pull at{" "}
              {MAX_SNAPSHOT_ROWS} props. The ones kept are chosen the same way in every pull — deepest markets first,
              then a fixed order — so a prop that survives one pull survives the next and can still pair. A slate this
              size still measures fewer props than it priced.{" "}
            </>
          ) : null}
          One limit worth knowing: Today pulls from local midnight to 11am tomorrow, so two looks at one prop can be
          hours to about a day apart, never the four days a midweek NFL line actually drifts over. What is measured
          here is the last day&apos;s movement scaled up, which is a lower bound on the week&apos;s. Until there is
          enough of it the widening stays an unfitted prior, and so do the college volatility multiplier and the
          yardage spread floors.
        </p>
      </section>

      <div className="space-y-3">
        {slips.map((s) => {
          const app = findApp(state.settings.apps, s.appId)
          const mode = findMode(app, s.modeId)
          const wins = s.legs.filter((l) => l.result === "WIN").length
          const legsSet = s.legs.every((l) => l.result !== "PENDING")
          const be = entryBreakEven(s, state.settings.apps)
          const table = s.paidOut != null ? tableMultiple(s, state.settings.apps) : null
          return (
            <div key={s.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-xs font-semibold">
                    {app?.name ?? s.appId} · {mode?.label ?? s.modeId} · {s.legs.length}-pick
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {shortDate(s.createdAt)} · {money(s.stake)} ·{" "}
                    {s.pAllHitAtEntry != null && s.evAtEntry != null
                      ? `model said ${pct(s.pAllHitAtEntry)} to sweep, ${signedPct(s.evAtEntry)} EV`
                      : s.source === "logged"
                        ? "logged, not priced by the app"
                        : "not priced"}
                    {be != null ? ` · each leg needed ${pct(be)}` : ""}
                  </div>
                  {s.capturedPayout ? (
                    <div className="font-mono text-[10px] text-muted-foreground">
                      payout captured:{" "}
                      {Object.entries(s.capturedPayout.tiers)
                        .sort((a, b) => Number(b[0]) - Number(a[0]))
                        .map(([k, v]) => `${k}/${s.capturedPayout!.picks} ${v}x`)
                        .join(" · ")}
                      {s.capturedPayout.confirmed ? "" : " (unconfirmed)"}
                    </div>
                  ) : null}
                  {s.paidOut != null ? (
                    <div className="font-mono text-[10px] text-muted-foreground">
                      settled at what the app paid: {money(s.paidOut)} on {money(s.stake)}
                      {s.paidOut > 0 && s.paidOut < s.stake ? ", a loss whatever its Win badge says" : ""}
                    </div>
                  ) : null}
                  {table != null && s.stake > 0 && Math.abs(table - s.paidOut! / s.stake) > 0.005 ? (
                    <div className="font-mono text-[10px] text-accent">
                      The payout table says {wins} of {s.legs.length} pays {multiple(table)}; the app paid{" "}
                      {multiple(s.paidOut! / s.stake)}. Goblins and demons move every tier, not just the top one.
                    </div>
                  ) : null}
                  {!s.capturedPayout && s.paidOut == null ? (
                    <div className="font-mono text-[10px] text-accent">
                      No payout captured for this entry, so it was settled at zero. Entries logged before payout capture
                      existed cannot be scored.
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {s.status === "SETTLED" ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-mono text-[11px]",
                        (s.actualMultiple ?? 0) > 1 ? "border-primary/40 text-primary" : "border-destructive/40 text-destructive",
                      )}
                    >
                      {legsSet ? `${wins}/${s.legs.length}` : "legs unset"} · {multiple(s.actualMultiple ?? 0)} ·{" "}
                      {money(s.stake * ((s.actualMultiple ?? 0) - 1))}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="font-mono text-[11px] text-muted-foreground">
                      {wins}/{s.legs.length} settled
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeSlip(s.id)}
                    aria-label="Delete entry"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>

              <ul className="mt-2 divide-y divide-border/40">
                {s.legs.map((l, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <span className="text-sm">{l.player}</span>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                        {l.marketLabel} {l.line} · {l.pWinAtEntry != null ? `model ${pct(l.pWinAtEntry, 0)}` : "not priced"}
                      </span>
                    </div>
                    <SideBadge side={l.side} />
                    <Select value={l.result} onValueChange={(v) => settleLeg(s, i, v as LegResult)}>
                      <SelectTrigger className="h-7 w-28 font-mono text-[11px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PENDING">Pending</SelectItem>
                        <SelectItem value="WIN">Win</SelectItem>
                        <SelectItem value="LOSS">Loss</SelectItem>
                        <SelectItem value="VOID">Did not play</SelectItem>
                        <SelectItem value="PUSH">Push</SelectItem>
                      </SelectContent>
                    </Select>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ExposureItem({ e, open = false }: { e: Exposure; open?: boolean }) {
  const where = open ? "open entries" : "entries"
  return (
    <li>
      <span className="font-medium">{e.player}</span>{" "}
      <span className="text-muted-foreground">
        is in {e.entries} {where} ({e.bets.join("; ")}).{" "}
        {e.cannotBothHit
          ? "Over in one entry and under in another, with the over's line at or above the under's: they cannot both hit, so one of those entries carried a miss before the game started."
          : e.conflicting
            ? "Over in one and under in another: both hit only if it lands between the lines; otherwise you were betting against yourself."
            : e.repeated
              ? "The same leg in several entries: it wins or loses all of them together, which multiplies the swing without adding edge."
              : "One game decides all of them together, which multiplies the swing without adding edge."}
      </span>
    </li>
  )
}
