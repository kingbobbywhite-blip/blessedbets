"use client"

import * as React from "react"
import { toast } from "sonner"
import { Download, RotateCcw, TriangleAlert, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { BOOK_PROFILES, RETAIL_WEIGHT_CAP } from "@/lib/quant/books"
import { DEVIG_METHODS, type DevigMethod } from "@/lib/quant/odds"
import { payoutMultiple, payoutVerified, supportedPickCounts } from "@/lib/quant/payouts"
import { exportState, importState } from "@/lib/store/local"
import { useStore } from "@/lib/store/provider"
import { companionsOf, creditPlan, leagueFor, maxGamesFor, pullPlan, reseedGameCap } from "@/lib/leagues"
import { marketsForCompetition, marketsForLeague } from "@/lib/odds-feed/theoddsapi"
import { DEFAULT_SETTINGS, marketsFor, withMarketsFor, type OddsProvider } from "@/lib/store/schema"
import { money } from "@/lib/format"

const TAB = "px-1.5 text-xs sm:px-2 sm:text-sm"

export default function SettingsPage() {
  const { state, setSettings, replaceAll, saveError, ready } = useStore()
  const s = state.settings
  const dailyLeague = leagueFor(s.daily.league)
  // Width is free on a per-request feed, so what a press actually asks for
  // depends on which feed is selected.
  const billsPerRequest = s.oddsFeed.provider === "propline"
  // The list typed for THIS feed. Stored per feed because blank means five
  // markets a game on The Odds API and the whole free board on PropLine, so
  // one shared box made switching feed change the bill invisibly.
  const typedMarkets = marketsFor(s.daily, s.oddsFeed.provider)
  const otherFeed: OddsProvider = billsPerRequest ? "theoddsapi" : "propline"
  const otherFeedLabel = billsPerRequest ? "The Odds API" : "PropLine"
  const otherFeedMarkets = marketsFor(s.daily, otherFeed)
  const dailyMarkets = marketsForLeague(dailyLeague.id, typedMarkets, { billsPerRequest })
  // What a typed market list is costing on a feed that does not charge for
  // width. Narrowing a per-market feed is a budget; narrowing a per-request
  // one is a straight loss, and the board cannot say so in the abstract -- it
  // has to name the markets that are being left on the table.
  const freeBoard = dailyLeague.deepMarkets ?? dailyLeague.markets
  const narrowingForFree = billsPerRequest ? freeBoard.filter((m) => !dailyMarkets.includes(m)) : []
  const companions = companionsOf(dailyLeague.id)
  // What one press of the selected league's button would spend, companions
  // included, billed per market per game at each competition's own list.
  const dailyCredits = pullPlan(dailyLeague.id, Math.max(1, Math.min(s.daily.maxGames, 20)), {
    companions: s.daily.companions,
    billsPerRequest,
  }).reduce(
    // Including the ranking call a depth-ranked companion buys, so this agrees
    // with the figure the Today screen gates on.
    (a, p) =>
      a + p.games * marketsForCompetition(p.league, typedMarkets, { billsPerRequest }).length +
      (p.league.depthRanked ? 1 : 0),
    0,
  )
  const dailyCost = creditPlan(dailyLeague.id, dailyCredits)

  if (!ready) {
    return <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Loading…</p>
  }

  function exportJson() {
    const blob = new Blob([exportState(state)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `blessedbets-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function importJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      replaceAll(importState(await file.text()))
      toast.success("Data restored")
    } catch (err) {
      toast.error("Could not read that file", { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-lg font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Everything is stored in this browser only. Export regularly: clearing site data deletes your history.
        </p>
      </header>

      {saveError ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {saveError}
        </p>
      ) : null}

      <Tabs defaultValue="bankroll">
        {/* Five tabs at full size overflow a 360px phone and push Data off the
            edge, so they shrink below sm and scroll rather than widen the page. */}
        <TabsList className="max-w-full justify-start overflow-x-auto font-mono text-xs">
          <TabsTrigger value="bankroll" className={TAB}>Bankroll</TabsTrigger>
          <TabsTrigger value="model" className={TAB}>Model</TabsTrigger>
          <TabsTrigger value="feed" className={TAB}>Odds feed</TabsTrigger>
          <TabsTrigger value="payouts" className={TAB}>Payouts</TabsTrigger>
          <TabsTrigger value="data" className={TAB}>Data</TabsTrigger>
        </TabsList>

        <TabsContent value="bankroll" className="mt-4 space-y-4">
          <div className="grid gap-4 rounded-lg border border-border/60 bg-card/40 p-4 md:grid-cols-2">
            <NumberField
              label="Bankroll"
              value={s.bankroll.bankroll}
              onChange={(v) => setSettings((p) => ({ ...p, bankroll: { ...p.bankroll, bankroll: v } }))}
              hint="The total amount you are willing to lose. Stake sizing is a fraction of this, so getting it wrong scales every recommendation."
            />
            <NumberField
              label="Unit size"
              value={s.bankroll.unitSize}
              onChange={(v) => setSettings((p) => ({ ...p, bankroll: { ...p.bankroll, unitSize: v } }))}
              hint="Only used to express stakes in units. It does not affect the maths."
            />
            <SliderRow
              label="Kelly fraction"
              value={s.bankroll.kellyFraction}
              min={0.05}
              max={1}
              step={0.05}
              format={(v) => `${(v * 100).toFixed(0)}%`}
              onChange={(v) => setSettings((p) => ({ ...p, bankroll: { ...p.bankroll, kellyFraction: v } }))}
              hint="Full Kelly is growth-optimal only if your probabilities are exactly right. They are estimates, so a quarter Kelly is the sane default and full Kelly is close to reckless."
            />
            <SliderRow
              label="Max stake per entry"
              value={s.bankroll.maxStakePct}
              min={0.005}
              max={0.1}
              step={0.005}
              format={(v) => `${(v * 100).toFixed(1)}% · ${money(v * s.bankroll.bankroll)}`}
              onChange={(v) => setSettings((p) => ({ ...p, bankroll: { ...p.bankroll, maxStakePct: v } }))}
              hint="A hard ceiling that overrides Kelly. Protects you from a single mispriced projection."
            />
          </div>
        </TabsContent>

        <TabsContent value="model" className="mt-4 space-y-4">
          <div className="grid gap-4 rounded-lg border border-border/60 bg-card/40 p-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Vig removal method
              </Label>
              <Select
                value={s.projection.devigMethod}
                onValueChange={(v) =>
                  setSettings((p) => ({ ...p, projection: { ...p.projection, devigMethod: v as DevigMethod } }))
                }
              >
                <SelectTrigger className="mt-1.5 h-9 font-mono text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEVIG_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {DEVIG_METHODS.find((m) => m.value === s.projection.devigMethod)?.blurb}
              </p>
              {s.projection.devigMethod === "multiplicative" ? (
                <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-accent">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                  Proportional devigging overstates longshot probability, which on a prop board means it overstates
                  exactly the sides furthest from the number. Power is the better default.
                </p>
              ) : null}
            </div>

            <div className="md:col-span-2 flex items-start justify-between gap-3 rounded-lg border border-border/50 p-3">
              <div>
                <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Require a market-making book
                </Label>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  When on, a prop priced only by retail books is treated as unpriced. Retail books follow the sharp
                  market rather than setting it, so their number carries much less information. Strict, and correct if
                  you are betting seriously.
                </p>
              </div>
              <Switch
                checked={s.projection.requireSharpBook}
                onCheckedChange={(v) =>
                  setSettings((p) => ({ ...p, projection: { ...p.projection, requireSharpBook: v } }))
                }
              />
            </div>

            <SliderRow
              label="Outcome spread"
              value={s.projection.dispersion.global ?? 1}
              min={0.7}
              max={1.8}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={(v) =>
                setSettings((p) => ({ ...p, projection: { ...p.projection, dispersion: { ...p.projection.dispersion, global: v } } }))
              }
              hint="Scales how volatile every stat is assumed to be. Raise it if the tracker says the model is overconfident: wider outcomes pull every probability toward 50%. The tracker's calibration table prints the multiplier your own settled legs imply, per competition and per market, which is the number to move this toward. The dispersion priors it scales — including college football's 1.2 and the yardage spread floors — are reasoned rather than fitted, so this dial is how you correct them until there is enough history to fit them properly."
            />
            <SliderRow
              label="Correlation strength"
              value={s.correlation.strength}
              min={0}
              max={1.5}
              step={0.05}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={(v) => setSettings((p) => ({ ...p, correlation: { ...p.correlation, strength: v } }))}
              hint="Scales every correlation between legs. Zero reproduces the naive assumption that legs are independent, which is what most tools do and is wrong. The coefficients it scales are structural priors — reasoned from how the sports work, not a covariance matrix fitted to results — and they are applied identically in every league, so this dial is how you correct them."
            />
            <SliderRow
              label="Stale after"
              value={s.projection.staleQuoteMinutes}
              min={10}
              max={180}
              step={5}
              format={(v) => `${v} min`}
              onChange={(v) => setSettings((p) => ({ ...p, projection: { ...p.projection, staleQuoteMinutes: v } }))}
              hint="Quotes older than this are flagged. Lines move on injury news, so a price from before the inactives were posted is worse than no price."
            />
            <SliderRow
              label="Discard after"
              value={s.projection.maxQuoteAgeMinutes}
              min={30}
              max={720}
              step={30}
              format={(v) => `${(v / 60).toFixed(1)} h`}
              onChange={(v) => setSettings((p) => ({ ...p, projection: { ...p.projection, maxQuoteAgeMinutes: v } }))}
              hint="Quotes older than this are thrown out entirely and the prop reverts to unpriced."
            />
          </div>

          <div className="rounded-lg border border-border/60 bg-card/40 p-4">
            <h3 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Book weighting</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Not every price carries the same information. A handful of books make the market; the rest copy them.
              Weighting them equally throws away the point of using market data, and because retail books copy the same
              source, five of them is one opinion counted five times rather than five opinions.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="pb-1">Book</th>
                    <th className="pb-1">Tier</th>
                    <th className="pb-1 text-right">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {BOOK_PROFILES.map((b) => (
                    <tr key={b.id} className="border-t border-border/40">
                      <td className="py-1.5">{b.name}</td>
                      <td className="py-1.5 font-mono text-[11px] text-muted-foreground">{b.tier}</td>
                      <td className="py-1.5 text-right font-mono tabular-nums">{b.weight.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              The combined weight of retail books, exchanges and unrecognised books is capped at{" "}
              {RETAIL_WEIGHT_CAP.toFixed(2)} regardless of how many are present.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="feed" className="mt-4 space-y-4">
          <div className="space-y-4 rounded-lg border border-border/60 bg-card/40 p-4">
            <div>
              <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Prices come from
              </Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {PROVIDER_CHOICES.map((p) => {
                  const on = s.oddsFeed.provider === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setSettings((prev) => ({
                          ...prev,
                          oddsFeed: {
                            ...prev.oddsFeed,
                            provider: p.id,
                            // A choice, so there is no longer a guess of the
                            // app's own to undo. See autoMovedToPropline.
                            autoMovedToPropline: false,
                          },
                          // The game cap follows the feed when it was only the
                          // other feed's default, and stays put when it was
                          // chosen. PropLine bills per request, so a cap sized
                          // for The Odds API's credits would leave part of the
                          // slate unpulled for no saving.
                          daily: {
                            ...prev.daily,
                            maxGames: reseedGameCap(leagueFor(prev.daily.league), prev.daily.maxGames, {
                              billsPerRequest: p.id === "propline",
                            }),
                          },
                        }))
                      }
                      className={
                        on
                          ? "rounded-md bg-primary/15 px-3 py-1.5 font-mono text-[11px] text-primary ring-1 ring-primary/30"
                          : "rounded-md px-3 py-1.5 font-mono text-[11px] text-muted-foreground ring-1 ring-border/60 hover:text-foreground"
                      }
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {s.oddsFeed.provider === "propline"
                  ? "PropLine: billed per request, 1,000 a day free, so a full slate is about one request per game whatever the markets. Carries FanDuel, DraftKings, Bovada, BetOnline, LowVig and exchanges, plus PrizePicks and Underdog lines. Its Pinnacle feed carries no basketball or football player props, so BetOnline and LowVig are the sharp references; a prop neither of them posts is left unpriced while \"require a sharp book\" is on."
                  : "The Odds API: carries Pinnacle's player props, the strongest reference there is, but bills per market per game against 500 credits a month."}
              </p>
            </div>

            <div>
              <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                PropLine key
              </Label>
              <Input
                type="password"
                value={s.oddsFeed.proplineKey}
                onChange={(e) =>
                  setSettings((p) => ({ ...p, oddsFeed: { ...p.oddsFeed, proplineKey: e.target.value } }))
                }
                placeholder="prop-line.com key"
                className="mt-1.5 font-mono text-xs"
              />
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Free at{" "}
                <a href="https://prop-line.com" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                  prop-line.com
                </a>
                . Stored in this browser and sent only to PropLine, through this app&apos;s server. PROPLINE_API_KEY in the
                environment takes precedence.
              </p>
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border border-border/50 p-3">
              <div>
                <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Pick&apos;em apps&apos; own lines
                </Label>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  Read the lines PrizePicks and Underdog are actually posting, through PropLine, so the pick&apos;em entry is
                  built at the line your app shows instead of the books&apos; line. Needs a PropLine key. With PropLine
                  pricing the slate they come free in the same requests; with The Odds API they cost one PropLine request
                  per game, never an Odds API credit. Lines only: what a pick is worth always comes from the sportsbooks.
                </p>
              </div>
              <Switch
                checked={s.oddsFeed.pickemLines}
                onCheckedChange={(v) => setSettings((p) => ({ ...p, oddsFeed: { ...p.oddsFeed, pickemLines: v } }))}
              />
            </div>

            <div>
              <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                The Odds API key
              </Label>
              <Input
                type="password"
                value={s.oddsFeed.apiKey}
                onChange={(e) => setSettings((p) => ({ ...p, oddsFeed: { ...p.oddsFeed, apiKey: e.target.value } }))}
                placeholder="the-odds-api.com key"
                className="mt-1.5 font-mono text-xs"
              />
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Stored in this browser and sent only to the odds feed, through this app's own server so it never appears
                in page JavaScript. You can also set ODDS_API_KEY in the environment instead, which takes precedence.
              </p>
            </div>

            <div>
              <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Where I can bet
              </Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {BETTABLE_CHOICES.map((b) => {
                  const on = s.oddsFeed.bettable.includes(b.id)
                  return (
                    <button
                      key={b.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setSettings((p) => ({
                          ...p,
                          oddsFeed: {
                            ...p.oddsFeed,
                            bettable: on ? p.oddsFeed.bettable.filter((x) => x !== b.id) : [...p.oddsFeed.bettable, b.id],
                          },
                        }))
                      }
                      className={
                        on
                          ? "rounded-md bg-primary/15 px-3 py-1.5 font-mono text-[11px] text-primary ring-1 ring-primary/30"
                          : "rounded-md px-3 py-1.5 font-mono text-[11px] text-muted-foreground ring-1 ring-border/60 hover:text-foreground"
                      }
                    >
                      {b.label}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Only books you have an account at. A bet is only ever recommended at one of these. Pinnacle, BetOnline and
                LowVig are still pulled to judge prices, but none of them takes US customers, so they are never offered
                as the place to bet.
              </p>
            </div>

            <div>
              <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Books to request
              </Label>
              <Input
                value={s.oddsFeed.books.join(", ")}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    oddsFeed: { ...p.oddsFeed, books: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) },
                  }))
                }
                className="mt-1.5 font-mono text-xs"
              />
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                The Odds API only; PropLine always returns every book it carries. Put Pinnacle first. Player props are
                billed per market per event, so a narrow book list and a short market list is the difference between a
                usable quota and an exhausted one.
              </p>
            </div>

            <div className="grid gap-4 border-t border-border/50 pt-4 md:grid-cols-2">
              <SliderRow
                label="Minimum edge"
                value={s.daily.minEdge}
                min={0}
                max={0.15}
                step={0.005}
                format={(v) => `${(v * 100).toFixed(1)}%`}
                onChange={(v) => setSettings((p) => ({ ...p, daily: { ...p.daily, minEdge: v } }))}
                hint="Ignore value bets below this. Real edges on a liquid market are low single digits; anything large is usually a line that already moved."
              />
              {companions.length > 0 ? (
                <div className="flex items-start justify-between gap-3 rounded-lg border border-border/50 p-3 md:col-span-2">
                  <div>
                    <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Pull {companions.map((l) => l.label).join(" and ")} with the {dailyLeague.label}
                    </Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      {companions.map((l) => l.label).join(" and ")} {companions.length === 1 ? "is" : "are"} the
                      same sport in the same week, so {companions.length === 1 ? "it rides" : "they ride"} inside
                      this section rather than taking a tab. Off by default because it is not free:{" "}
                      {billsPerRequest ? (
                        <>
                          on PropLine{" "}
                          {companions
                            .map((l) => `${maxGamesFor(l, { billsPerRequest })} more games`)
                            .join(", ")}
                          , so {companions.reduce((a, l) => a + maxGamesFor(l, { billsPerRequest }), 0)} more
                          requests of the 1,000 a day, whatever the markets.
                        </>
                      ) : (
                        <>
                          it costs credits on top of the {dailyLeague.label} slate:{" "}
                          {companions
                            .map((l) => `${maxGamesFor(l)} games at ${marketsForCompetition(l, typedMarkets).length} markets`)
                            .join(", ")}
                          , so about{" "}
                          {companions.reduce(
                            (a, l) => a + maxGamesFor(l) * marketsForCompetition(l, typedMarkets).length,
                            0,
                          )}{" "}
                          more per press.
                        </>
                      )}{" "}
                      Each is priced with its own numbers and badged on every row. Turning it off keeps the games
                      you have already paid for in this browser&apos;s cache and only leaves them out of the picks,
                      so you can turn it back on without spending anything.
                    </p>
                  </div>
                  <Switch
                    checked={s.daily.companions}
                    onCheckedChange={(v) => setSettings((p) => ({ ...p, daily: { ...p.daily, companions: v } }))}
                  />
                </div>
              ) : null}
              <div className="flex items-start justify-between gap-3 rounded-lg border border-border/50 p-3">
                <div>
                  <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Today: require a sharp book
                  </Label>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    When on, Today prices nothing unless Pinnacle, BetOnline, LowVig or another sharp book posted the
                    prop. College football props outside the televised games are often retail-only or unpriced, so
                    Today leaves them out. Turn off to price against
                    the retail consensus instead: weaker, and every result says so.
                  </p>
                </div>
                <Switch
                  checked={s.daily.requireSharpReference}
                  onCheckedChange={(v) =>
                    setSettings((p) => ({ ...p, daily: { ...p.daily, requireSharpReference: v } }))
                  }
                />
              </div>
              <SliderRow
                label="Pick'em ceiling"
                value={s.daily.pickemMaxProb}
                min={0.5}
                max={1}
                step={0.01}
                format={(v) => (v >= 1 ? "keep everything" : `${(v * 100).toFixed(0)}%`)}
                onChange={(v) => setSettings((p) => ({ ...p, daily: { ...p.daily, pickemMaxProb: v } }))}
                hint={
                  "The most lopsided a pick'em pick can be and still be assumed to exist. A flat payout table only works if both sides are plausible, so an app does not post a prop whose favoured side is a near-certainty, however happily a sportsbook prices one. Props above this are left out of the targets and listed under them by name, never silently. Move it to 100% to keep everything. A line PropLine shows an app actually posting is never removed, whatever this says."
                }
              />
              <SliderRow
                label={`${dailyLeague.short} unders: extra margin`}
                value={s.daily.underMargin[s.daily.league] ?? 0}
                min={0}
                max={0.1}
                step={0.005}
                format={(v) => (v <= 0 ? "none" : `+${(v * 100).toFixed(1)} pts`)}
                onChange={(v) =>
                  setSettings((p) => ({
                    ...p,
                    daily: { ...p.daily, underMargin: { ...p.daily.underMargin, [p.daily.league]: v } },
                  }))
                }
                hint={`How much more an ${dailyLeague.short} under has to clear in pick'em, on top of the bar: at +3 points a 56% bar asks 59% of an under and still 56% of an over. It only ever turns a play into a pass and never moves a probability, so it cannot make anything look better than the market says. The NBA starts at +3 because that is your experience of NBA unders, not a measured number; the tracker's overs-and-unders record shows whether your results back it, against the bar those legs actually needed. Set per league: this is the ${dailyLeague.label} tab's.`}
              />
              <SliderRow
                label="Parlay legs"
                value={s.daily.parlayLegs}
                min={2}
                max={6}
                step={1}
                format={(v) => `${v} legs`}
                onChange={(v) => setSettings((p) => ({ ...p, daily: { ...p.daily, parlayLegs: v } }))}
                hint="How many legs the daily parlays are built from."
              />
              <SliderRow
                label="Games per pull"
                value={s.daily.maxGames}
                min={1}
                max={20}
                step={1}
                format={(v) => `${v} games`}
                onChange={(v) => setSettings((p) => ({ ...p, daily: { ...p.daily, maxGames: v } }))}
                hint={
                  s.oddsFeed.provider === "propline"
                    ? `Caps the PropLine requests one refresh can spend: up to ${s.daily.maxGames + 1} of the daily 1,000, whatever the markets.`
                    : `Caps the credits one refresh can spend. At ${dailyMarkets.length} markets${
                        dailyCredits > s.daily.maxGames * dailyMarkets.length
                          ? `, with the companion on,`
                          : ``
                      } that is up to ${dailyCredits} credits, ${Math.round(dailyCost.pctOfQuota * 100)}% of a 500-request month.${
                        dailyCost.confirm ? " Today asks before spending this much." : ""
                      }`
                }
              />
              <div>
                <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Markets to pull · {billsPerRequest ? "PropLine" : "The Odds API"}
                </Label>
                <Input
                  value={typedMarkets?.join(", ") ?? ""}
                  placeholder={dailyMarkets.join(", ")}
                  onChange={(e) => {
                    const parsed = e.target.value.split(",").map((x) => x.trim()).filter(Boolean)
                    setSettings((p) => ({
                      ...p,
                      // Empty means "follow the league", which is the right
                      // default: each league posts different markets, and a
                      // market that comes back empty buys nothing.
                      daily: {
                        ...p.daily,
                        // Only this feed's slot. The other feed keeps whatever
                        // was typed for it, because a budget that matters on
                        // The Odds API buys nothing on PropLine and the two
                        // should not overwrite each other.
                        markets: withMarketsFor(
                          p.daily.markets,
                          p.oddsFeed.provider,
                          parsed.length > 0 ? parsed : null,
                        ),
                      },
                    }))
                  }}
                  className="mt-1.5 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {billsPerRequest
                    ? `PropLine bills per request, one per game whatever this says, so width costs nothing and a blank box pulls the whole board: ${dailyMarkets.join(", ")}. Narrowing it only loses pick'em lines.`
                    : `Billed per market per game. Every extra market multiplies the cost, so a blank box pulls the markets with the deepest pick'em interest rather than all of them: ${dailyMarkets.join(", ")}.${
                        dailyLeague.deepMarkets
                          ? ` The rest of the ${dailyLeague.label} board is ${dailyLeague.deepMarkets.filter((m) => !dailyMarkets.includes(m)).join(", ")}; add any of them here, or switch the feed to PropLine, where they are free.`
                          : ""
                      }`}{" "}
                  Markets from another sport are ignored for that league, so a basketball list is never billed on NFL
                  games.{" "}
                  <strong className="font-normal text-foreground">
                    This list belongs to {billsPerRequest ? "PropLine" : "The Odds API"} only.
                  </strong>{" "}
                  Blank does not mean the same thing on both feeds — {dailyMarkets.length} market
                  {dailyMarkets.length === 1 ? "" : "s"} here, the other feed&apos;s own there — so each keeps its
                  own and switching feed never silently changes what a press costs.{" "}
                  {otherFeedMarkets
                    ? `${otherFeedLabel} is set to ${otherFeedMarkets.length} market${otherFeedMarkets.length === 1 ? "" : "s"}: ${otherFeedMarkets.join(", ")}.`
                    : `${otherFeedLabel} is blank, so it pulls whatever its league posts.`}
                </p>
                {narrowingForFree.length > 0 ? (
                  <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[11px] leading-relaxed text-destructive">
                    This list is costing you {narrowingForFree.length} market
                    {narrowingForFree.length === 1 ? "" : "s"} for nothing. PropLine bills one request per game
                    whatever you ask for, so {narrowingForFree.join(", ")} would come back in the same{" "}
                    {s.daily.maxGames + 1} requests you are already spending. Every one left out is a pick&apos;em
                    line that cannot be read, and an entry is only ever built at a line an app is really posting — so
                    a market nobody asked for is a leg you cannot play. Clear the box to pull the whole board.
                  </p>
                ) : null}
              </div>
            </div>

            <div>
              <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Regions</Label>
              <Input
                value={s.oddsFeed.regions}
                onChange={(e) => setSettings((p) => ({ ...p, oddsFeed: { ...p.oddsFeed, regions: e.target.value } }))}
                className="mt-1.5 font-mono text-xs"
              />
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Pinnacle sits in the eu region, so leaving it out silently removes the most useful price on the board.
              </p>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="payouts" className="mt-4 space-y-4">
          <p className="flex items-start gap-2 rounded-lg border border-border/60 bg-card/40 p-3 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <span>
              These tables do not price a built entry: on the build screen they only pre-fill the capture form, where
              you read the multipliers off the app and confirm them before any expected value is computed. That is the
              only way to be sure the number being used is the number you will actually be paid, since operators change
              these by state, by promotion and by sport, and boosted picks override them outright.{" "}
              <strong className="font-semibold text-foreground">They are not inert on Today.</strong> There the
              selected app and mode set the per-leg bar that decides which props become pick&apos;em targets at all and
              which side each row recommends, which is why that screen marks the bar unverified on its face and
              withholds the entry&apos;s expected value until a table has been confirmed.
            </span>
          </p>
          <div className="space-y-3">
            {s.apps.map((a) => (
              <div key={a.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-mono text-sm font-semibold">{a.name}</h3>
                  {/* An unverified table still sets the Today bar, so this is
                      a thing to act on rather than a field to read past. */}
                  <span
                    className={
                      payoutVerified(a)
                        ? "font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                        : "flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-accent"
                    }
                  >
                    {payoutVerified(a) ? null : <TriangleAlert className="size-3" />}
                    {a.kind} · payouts {a.verifiedOn}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{a.notes}</p>
                {a.modes.filter((m) => Object.keys(m.table).length > 0).map((m) => (
                  <div key={m.id} className="mt-2">
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{m.label}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {supportedPickCounts(m).map((n) => (
                        <span key={n} className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] tabular-nums">
                          {n}: {payoutMultiple(m, n, n)}x
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="data" className="mt-4 space-y-4">
          <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={exportJson}>
                <Download className="mr-1 size-3.5" /> Export everything
              </Button>
              <Button variant="secondary" size="sm" asChild>
                <label className="cursor-pointer">
                  <Upload className="mr-1 size-3.5" /> Restore from file
                  <input type="file" accept=".json" className="hidden" onChange={importJson} />
                </label>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSettings(() => DEFAULT_SETTINGS)
                  toast.success("Settings reset. Your slate and tracker are untouched.")
                }}
              >
                <RotateCcw className="mr-1 size-3.5" /> Reset settings
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Holding {state.slips.length} logged entries and {state.slate?.rows.length ?? 0} slate lines. Export writes
              a single JSON file containing your settings, current slate and full betting history. The settings
              include any API keys entered here, so a restore brings them back; keep the file private.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  hint: string
}) {
  return (
    <div>
      <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={value}
        min={0}
        onChange={(e) => {
          const n = Number.parseFloat(e.target.value)
          if (Number.isFinite(n) && n >= 0) onChange(n)
        }}
        className="mt-1.5 font-mono text-xs tabular-nums"
      />
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  hint: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</Label>
        <span className="font-mono text-xs tabular-nums">{format(value)}</span>
      </div>
      <Slider className="mt-2.5" value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  )
}

/** US retail books a bet can be recommended at. Ids are the odds feed's. */
const PROVIDER_CHOICES: { id: OddsProvider; label: string }[] = [
  { id: "theoddsapi", label: "The Odds API" },
  { id: "propline", label: "PropLine" },
]

const BETTABLE_CHOICES = [
  { id: "fanduel", label: "FanDuel" },
  // Exchanges in the rotation. Only PropLine pulls carry their prices.
  { id: "prophetx", label: "ProphetX" },
  { id: "polymarket", label: "Polymarket" },
  { id: "draftkings", label: "DraftKings" },
  { id: "betmgm", label: "BetMGM" },
  { id: "williamhill_us", label: "Caesars" },
  { id: "espnbet", label: "ESPN BET" },
  { id: "betrivers", label: "BetRivers" },
  { id: "fanatics", label: "Fanatics" },
  { id: "hardrockbet", label: "Hard Rock" },
]
