"use client"

import * as React from "react"
import { toast } from "sonner"
import { Camera, Loader2, Plus, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  DEFAULT_LEAGUE,
  LOGGED_LEAGUE_IDS,
  RETIRED_LEAGUES,
  isLeagueId,
  isRetiredLeagueId,
  loggedLeagueShort,
  sportOfLoggedLeague,
  type LoggedLeagueId,
} from "@/lib/leagues"
import { MARKETS, MARKET_KEYS, marketForSport, marketSport, type MarketKey } from "@/lib/nba/markets"
import { extractProps, isUnmodelledStat, leagueFromScreen, mergeReads, readEntryHeader } from "@/lib/ocr/extract"
import { normalizeName } from "@/lib/quant/correlation"
import { breakEvenLegProb, findApp, type CapturedPayout } from "@/lib/quant/payouts"
import { DEFAULT_VALUE_SETTINGS } from "@/lib/quant/valuebets"
import { useStore } from "@/lib/store/provider"
import type { LegResult, PickType, TrackedLeg, TrackedSlip } from "@/lib/store/schema"
import {
  draftFromCandidate,
  entryExpectation,
  legClash,
  legsFromText,
  localDay,
  matchLeg,
  settlementMode,
  withResults,
  type DraftLeg,
} from "@/lib/tracker/entries"
import { money, pct } from "@/lib/format"

/** Stat picker value for a stat the app does not model, such as a baseball leg in a mixed entry. */
const OTHER = "__other"

/** A leg being edited. `other` is set once the stat is confirmed as one the app does not model. */
type Row = DraftLeg & { other?: boolean }

/** Point each leg's stat at the league's sport: points, assists and blocked shots differ by sport. */
function inSport(rows: Row[], league: LoggedLeagueId): Row[] {
  const sport = sportOfLoggedLeague(league)
  return rows.map((l) => {
    if (!l.marketKey) return l
    const key = marketForSport(l.marketKey, sport)
    return key === l.marketKey ? l : { ...l, marketKey: key, marketLabel: MARKETS[key].label }
  })
}

const toRow = (d: DraftLeg): Row => ({ ...d, other: !d.marketKey && isUnmodelledStat(d.marketLabel) })
const emptyRow = (): Row => ({ player: "", marketKey: null, marketLabel: "", line: Number.NaN, side: null, result: "PENDING", note: null })

/**
 * Log an entry placed straight in a pick'em app.
 *
 * Most entries never pass through the build screen, so without this the
 * tracker only ever sees a sliver of what is actually played. Drop in the
 * entry's screenshot, or type the legs, set what happened, and it is scored at
 * what the app really paid, goblins, demons and all.
 */
export function LogEntry({ onDone }: { onDone?: () => void }) {
  const { state, addSlip } = useStore()
  const s = state.settings
  const [appId, setAppId] = React.useState(s.defaultAppId)
  const [modeId, setModeId] = React.useState("power")
  // Wider than the leagues Today prices: a retired league still has to be
  // loggable, or its settled entries can never be recorded. See RETIRED_LEAGUES.
  const [league, setLeague] = React.useState<LoggedLeagueId>(s.daily.league)
  const [stake, setStake] = React.useState("")
  const [payout, setPayout] = React.useState("")
  const [paid, setPaid] = React.useState("")
  const [text, setText] = React.useState("")
  const [legs, setLegs] = React.useState<Row[]>([])
  const [busy, setBusy] = React.useState(false)

  const app = findApp(s.apps, appId)
  const dfsApps = s.apps.filter((a) => a.kind === "dfs")
  const stakeN = Number.parseFloat(stake)
  const payoutN = Number.parseFloat(payout)
  const paidN = paid.trim() === "" ? null : Number.parseFloat(paid)
  const paidOut = paidN != null && Number.isFinite(paidN) && paidN >= 0 ? paidN : null
  const n = legs.length
  // The all-hit multiple. A settled flex that paid out does not show it.
  const multiple = stakeN > 0 && payoutN > 0 ? payoutN / stakeN : null

  const capturedPayout = React.useMemo<CapturedPayout | null>(() => {
    if (!multiple || n < 2) return null
    const stored = app?.modes.find((m) => m.id === modeId)?.table[n] ?? {}
    // Power: the screen's "$X for $Y" is the only tier. Flex: the lower tiers
    // are not on the entry screen, so they come from the stored table.
    const tiers = modeId === "flex" ? { ...stored, [n]: multiple } : { [n]: multiple }
    return { picks: n, tiers, confirmed: modeId !== "flex", capturedAt: new Date().toISOString() }
  }, [multiple, n, modeId, app])

  const breakEven = React.useMemo(() => {
    if (!capturedPayout) return null
    return breakEvenLegProb(settlementMode({ appId, modeId, capturedPayout }, s.apps), n)
  }, [capturedPayout, appId, modeId, s.apps, n])

  const valueSettings = React.useMemo(
    () => ({
      ...DEFAULT_VALUE_SETTINGS,
      // A retired league has no slate to price against, so the priors fall
      // back rather than the lookup failing.
      projection: { ...s.projection, league: isLeagueId(league) ? league : DEFAULT_LEAGUE },
      requireSharpReference: s.daily.requireSharpReference,
    }),
    [s.projection, s.daily.requireSharpReference, league],
  )
  // No cache exists for a retired league, which is the right answer: there is
  // no NHL slate to match a logged NHL leg against, so it prices as unknown.
  const quotes = isLeagueId(league) ? state.daily[league]?.quotes : undefined
  // Matched rather than just priced: the competition is only knowable now,
  // because a logged leg keeps no game to look it up by later.
  const matched = legs.map((l) =>
    l.side && l.marketKey && Number.isFinite(l.line)
      ? matchLeg(quotes, { player: l.player, marketKey: l.marketKey, line: l.line, side: l.side }, valueSettings)
      : null,
  )
  const priced = matched.map((m) => m?.pWin ?? null)
  // Two players on the slate normalising to one name, and an entry screen
  // gives a name and a stat with no fixture — so the price shown may be the
  // other one's. Computed at match time and worth nothing unless it is said.
  const ambiguousNames = matched
    .map((m, i) => (m?.ambiguous ? legs[i].player.trim() : null))
    .filter((n): n is string => !!n)

  // Entries these legs could collide with: anything still open, and anything
  // logged today, which is where a night's settled screenshots all land.
  const others = React.useMemo(() => {
    const today = localDay(new Date().toISOString())
    return state.slips
      .filter((sl) => sl.status === "PENDING" || localDay(sl.createdAt) === today)
      .map((sl) => ({ id: sl.id, legs: sl.status === "PENDING" ? sl.legs.filter((l) => l.result === "PENDING") : sl.legs }))
  }, [state.slips])

  function clashNote(l: Row): string | null {
    if (!l.player.trim() || !l.side || !Number.isFinite(l.line)) return null
    const c = legClash({ player: l.player, marketKey: l.marketKey, marketLabel: l.marketLabel, line: l.line, side: l.side }, others)
    if (c.entries === 0) return null
    const other = (k: number) => `${k} other ${k === 1 ? "entry" : "entries"}`
    if (c.cannotBothHit) return "The other side of this is in another entry: they cannot both hit."
    if (c.oppositeSide) return "The other side of this stat is in another entry."
    if (c.repeated > 0) return `This exact leg is already in ${other(c.repeated)}.`
    return `Player already in ${other(c.entries)}, open or logged today.`
  }

  function readText() {
    const parsed = legsFromText(text)
    if (parsed.length === 0) return toast.error("Type one leg per line first")
    setLegs(parsed.map(toRow))
  }

  async function readScreenshot(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setBusy(true)
    try {
      const { readImage } = await import("@/lib/ocr/engine")
      const out = await readImage(file)
      // Read the league off the screen BEFORE extracting, because it decides
      // which team codes count as a team rather than a person. The league
      // already selected is the previous entry's and would be a worse guess
      // than none: a stray college code would cost a real NFL name.
      const screen = [...out.lines, ...out.cleanedLines].map((l) => l.text).join(" ")
      const named = leagueFromScreen(screen)
      const raw = extractProps(out.lines, { league: named })
      const cleaned = extractProps(out.cleanedLines, { league: named })
      const merged = mergeReads(raw.candidates, cleaned.candidates)
      let found: Row[] = merged.map((c) => toRow(draftFromCandidate(c)))
      const seen = new Set(found.map((l) => normalizeName(l.player)))
      for (const name of [...raw.unpairedNames, ...cleaned.unpairedNames]) {
        if (seen.has(normalizeName(name))) continue
        seen.add(normalizeName(name))
        found.push({ ...emptyRow(), player: name, note: "The line was not readable. Fill in the stat, line and side." })
      }
      const header = readEntryHeader(out.lines, out.cleanedLines)
      const mode = header?.mode ?? modeId
      if (header) {
        setStake(String(header.stake))
        setPayout(header.payout != null ? String(header.payout) : "")
        setPaid(header.paid != null ? String(header.paid) : "")
        if (header.mode) setModeId(header.mode)
      }
      // A power play that paid anything paid because every pick that played
      // hit, so those results are known. A flex that paid, or any loss, does
      // not say which legs missed.
      if (mode === "power" && header?.paid != null && header.paid > 0) {
        found = found.map((l) => (l.result === "VOID" ? l : { ...l, result: "WIN" }))
      }
      // Failing a league named on the screen, a football stat means an NFL
      // entry. College is never inferred that way: its stats are the NFL's.
      const sportSeen = (sport: string) => found.some((l) => l.marketKey && marketSport(l.marketKey) === sport)
      const leagueRead: LoggedLeagueId | null =
        named ?? (sportSeen("football") ? "nfl" : sportSeen("hockey") ? "nhl" : null)
      if (leagueRead) setLeague(leagueRead)
      // "Points" on an NHL screen is hockey points, not basketball's.
      setLegs(leagueRead ? inSport(found, leagueRead) : found)
      // The ring round each player says hit or missed once the leg is decided.
      // Say how many it settled, so a leg left open is a prompt rather than a
      // silent gap in the record by side.
      const decided = found.filter((l) => l.result === "WIN" || l.result === "LOSS").length
      if (found.length === 0) toast.error("No legs read from that screenshot", { description: "Type them in instead." })
      else
        toast.success(`Read ${found.length} legs`, {
          description:
            decided === found.length
              ? "Each result was read off the player's ring. Check them against the screen."
              : decided > 0
                ? `${decided} results read off the players' rings; set the rest.`
                : "Check each one and set what happened.",
        })
    } catch (err) {
      toast.error("Could not read the screenshot", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  function update(i: number, patch: Partial<Row>) {
    setLegs((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch, note: null } : l)))
  }

  const statOk = (l: Row) => !!l.marketKey || (!!l.other && l.marketLabel.trim().length > 0)
  const problems: string[] = []
  if (!(stakeN > 0)) problems.push("Enter the stake.")
  if (paid.trim() !== "" && paidOut == null) problems.push("What it paid must be a number, 0 for a loss.")
  if (payout.trim() !== "" && !(payoutN > stakeN)) problems.push("What it pays if every leg hits must be more than the stake.")
  if (paidOut == null && !(payoutN > stakeN)) problems.push("Enter what it pays if every leg hits, or what it paid if it has settled.")
  if (n < 2) problems.push("An entry needs at least two legs.")
  legs.forEach((l, i) => {
    if (!l.side || !statOk(l) || !Number.isFinite(l.line) || !l.player.trim()) problems.push(`Leg ${i + 1} needs a player, stat, line and side.`)
  })

  function save() {
    if (problems.length > 0) return
    const tracked: TrackedSlip = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      settledAt: null,
      appId,
      modeId,
      legs: legs.map<TrackedLeg>((l, i) => ({
        player: l.player.trim(),
        marketKey: l.marketKey,
        marketLabel: l.marketKey ? MARKETS[l.marketKey].label : l.marketLabel.trim(),
        line: l.line,
        side: l.side!,
        pWinAtEntry: priced[i],
        app: appId,
        result: l.result,
        actual: null,
        pickType: l.pickType,
        league,
        competition: matched[i]?.competition,
      })),
      stake: stakeN,
      capturedPayout,
      evAtEntry: null,
      pAllHitAtEntry: null,
      topMultiple: multiple,
      status: "PENDING",
      actualMultiple: null,
      paidOut,
      notes: "",
      source: "logged",
    }
    const exp = capturedPayout ? entryExpectation(priced, settlementMode({ ...tracked, capturedPayout }, s.apps)) : null
    if (exp) {
      tracked.evAtEntry = exp.ev
      tracked.pAllHitAtEntry = exp.pAllHit
    }
    addSlip(withResults(tracked, tracked.legs, s.apps))
    toast.success("Entry logged", {
      description:
        paidOut != null
          ? `${n} legs, ${money(stakeN)} in, ${money(paidOut)} back`
          : `${n} legs, ${money(stakeN)} to pay ${money(payoutN)}`,
    })
    setLegs([])
    setText("")
    setStake("")
    setPayout("")
    setPaid("")
    onDone?.()
  }

  const labelCls = "font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"

  return (
    <section className="space-y-4 rounded-lg border border-border/60 bg-card/40 p-4">
      <div>
        <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Log an entry you placed</h2>
        <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
          Drop in the entry&apos;s screenshot, or type one leg per line, like{" "}
          <code className="font-mono">Jordan Addison under 5.5 Recs win</code>, adding goblin or demon where it was
          one. The money comes off the entry screen:
          &quot;$2 for $12&quot; is the all-hit payout, and on a settled entry &quot;$10 paid $5&quot; is what it
          actually returned, which is what it is scored at.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <div>
          <Label className={labelCls}>App</Label>
          <Select value={appId} onValueChange={setAppId}>
            <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {dfsApps.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className={labelCls}>Type</Label>
          <Select value={modeId} onValueChange={setModeId}>
            <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(app?.modes ?? []).map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className={labelCls}>League</Label>
          <Select
            value={league}
            onValueChange={(v) => {
              setLeague(v as LoggedLeagueId)
              setLegs((prev) => inSport(prev, v as LoggedLeagueId))
            }}
          >
            <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {LOGGED_LEAGUE_IDS.map((id) => (
                <SelectItem key={id} value={id}>{loggedLeagueShort(id)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className={labelCls}>Stake $</Label>
          <Input inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="2" className="mt-1 h-8 text-xs" />
        </div>
        <div>
          <Label className={labelCls}>Pays if all hit $</Label>
          <Input inputMode="decimal" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="12" className="mt-1 h-8 text-xs" />
        </div>
        <div>
          <Label className={labelCls}>Paid $</Label>
          <Input
            inputMode="decimal"
            value={paid}
            onChange={(e) => setPaid(e.target.value)}
            placeholder="blank if open"
            className="mt-1 h-8 text-xs"
            aria-describedby="paid-hint"
          />
        </div>
      </div>
      <p id="paid-hint" className="-mt-2 text-[10px] leading-relaxed text-muted-foreground">
        Paid: what the settled entry returned, 0 for a loss. Leave it blank for an entry still in play and it settles
        from its legs instead.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="secondary" disabled={busy}>
          <label className="cursor-pointer">
            {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Camera className="mr-1 size-3.5" />}
            {busy ? "Reading…" : "Read a screenshot"}
            <input type="file" accept="image/*" className="hidden" onChange={readScreenshot} disabled={busy} />
          </label>
        </Button>
        <span className="text-[11px] text-muted-foreground">or type the legs:</span>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Jordan Addison under 5.5 Recs win\nTyler Allgeier over 2.5 Rush Yards loss\nJack Bech over 0.5 Rec Yards dnp"}
        className="min-h-24 font-mono text-[11px]"
        spellCheck={false}
      />
      <Button size="sm" variant="outline" disabled={!text.trim()} onClick={readText}>
        Read these legs
      </Button>

      {legs.length > 0 ? (
        <div className="space-y-2">
          {legs.map((l, i) => {
            const clash = clashNote(l)
            return (
              <div key={i} className="rounded-md border border-border/50 p-2">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-[1.4fr_1.2fr_0.6fr_0.8fr_0.9fr_1fr_auto]">
                  <Input value={l.player} onChange={(e) => update(i, { player: e.target.value })} className="col-span-2 h-8 text-xs md:col-span-1" aria-label="Player" />
                  <Select
                    value={l.marketKey ?? (l.other ? OTHER : "")}
                    onValueChange={(v) =>
                      v === OTHER
                        ? update(i, { marketKey: null, other: true, marketLabel: isUnmodelledStat(l.marketLabel) ? l.marketLabel : "" })
                        : update(i, { marketKey: v as MarketKey, marketLabel: MARKETS[v as MarketKey].label, other: false })
                    }
                  >
                    <SelectTrigger className="h-8 text-xs" aria-label="Stat"><SelectValue placeholder="Stat" /></SelectTrigger>
                    <SelectContent>
                      {MARKET_KEYS.filter((k) => marketSport(k) === sportOfLoggedLeague(league)).map((k) => (
                        <SelectItem key={k} value={k}>{MARKETS[k].label}</SelectItem>
                      ))}
                      <SelectItem value={OTHER}>Other stat (not priced)</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    inputMode="decimal"
                    value={Number.isFinite(l.line) ? String(l.line) : ""}
                    onChange={(e) => update(i, { line: e.target.value === "" ? Number.NaN : Number.parseFloat(e.target.value) })}
                    placeholder="Line"
                    className="h-8 text-xs"
                    aria-label="Line"
                  />
                  <Select value={l.side ?? ""} onValueChange={(v) => update(i, { side: v as "OVER" | "UNDER" })}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Side"><SelectValue placeholder="Side" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OVER">Over</SelectItem>
                      <SelectItem value="UNDER">Under</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={l.pickType ?? ""} onValueChange={(v) => update(i, { pickType: v as PickType })}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Pick type"><SelectValue placeholder="Pick type" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard</SelectItem>
                      <SelectItem value="goblin">Goblin</SelectItem>
                      <SelectItem value="demon">Demon</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={l.result} onValueChange={(v) => update(i, { result: v as LegResult })}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Result"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">Not settled</SelectItem>
                      <SelectItem value="WIN">Hit</SelectItem>
                      <SelectItem value="LOSS">Missed</SelectItem>
                      <SelectItem value="VOID">Did not play</SelectItem>
                      <SelectItem value="PUSH">Push</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => setLegs((p) => p.filter((_, j) => j !== i))} aria-label="Remove leg">
                    <X className="size-3.5" />
                  </Button>
                </div>
                {l.other ? (
                  <Input
                    value={l.marketLabel}
                    onChange={(e) => update(i, { marketLabel: e.target.value })}
                    placeholder="Stat as the app shows it, e.g. Hitter Fantasy Score"
                    className="mt-2 h-8 text-xs"
                    aria-label="Other stat"
                  />
                ) : null}
                <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
                  <span>{priced[i] != null ? `App's price from your last pull: ${pct(priced[i]!)} to hit` : "Not priced by the app"}</span>
                  {clash ? <span className="text-accent">{clash}</span> : null}
                  {l.note ? <span className="text-accent">{l.note}</span> : null}
                </div>
              </div>
            )
          })}
          <Button size="sm" variant="ghost" onClick={() => setLegs((p) => [...p, emptyRow()])}>
            <Plus className="mr-1 size-3.5" /> Add a leg
          </Button>
        </div>
      ) : null}

      {paidOut != null && stakeN > 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Paid {money(paidOut)} on {money(stakeN)}:{" "}
          <span className={paidOut >= stakeN ? "font-mono text-primary" : "font-mono text-destructive"}>
            {money(paidOut - stakeN)}
          </span>
          .{paidOut > 0 && paidOut < stakeN ? " The app may call that a win; it is a loss." : ""}
          {modeId === "flex" && paidOut > 0 ? " Set which legs hit so the record by stat stays right; the profit is already right." : ""}
        </p>
      ) : null}

      {breakEven != null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {money(stakeN)} to pay {money(payoutN)} is {multiple!.toFixed(2)}x on {n} legs, so each leg had to hit{" "}
          <span className="font-mono text-foreground">{pct(breakEven)}</span> of the time just to break even.
          {modeId === "flex" ? " Lower flex tiers come from the stored table and are unconfirmed." : ""}
        </p>
      ) : null}

      {legs.length > 0 && problems.length > 0 ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" /> {problems[0]}
        </p>
      ) : null}
      {isRetiredLeagueId(league) ? (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span>
            {RETIRED_LEAGUES[league].note} Its stats are still read as{" "}
            {sportOfLoggedLeague(league)}, so the legs are typed correctly, but nothing prices them: there is no{" "}
            {RETIRED_LEAGUES[league].short} slate to compare them against.
          </span>
        </p>
      ) : null}
      {league === "cfb" && !quotes?.some((q) => q.competition === "cfb") ? (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span>
            The last pull holds no college prices, so these legs log with no probability and nothing to calibrate
            against. College football is pulled with the NFL only when the companion switch is on in Settings — turn
            it on and refresh before logging, or log now and accept that the model never got a prediction on record.
          </span>
        </p>
      ) : null}
      {ambiguousNames.length > 0 ? (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-accent">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span>
            Two players on the last pull share {ambiguousNames.length === 1 ? "a name with" : "names with"}{" "}
            {ambiguousNames.join(", ")}, and an entry screen gives a name and a stat but never a fixture. The
            probability recorded for {ambiguousNames.length === 1 ? "that leg" : "those legs"} may be the other
            player&apos;s, so the calibration it feeds would be measuring the wrong prop. Check the game before
            logging it.
          </span>
        </p>
      ) : null}
      <Button size="sm" onClick={save} disabled={problems.length > 0}>
        Log this entry
      </Button>
    </section>
  )
}
