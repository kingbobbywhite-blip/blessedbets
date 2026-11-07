"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Download, FileUp, ImageUp, Loader2, Plus, TriangleAlert } from "lucide-react"
import { ReviewTable } from "@/components/review-table"
import { StatTile } from "@/components/stat-tile"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { extractProps, linesFromText, mergeReads } from "@/lib/ocr/extract"
import { parseSlate, SAMPLE_CSV } from "@/lib/import/parse"
import {
  draftFromCandidate,
  draftFromRow,
  draftToRow,
  emptyDraft,
  summariseDrafts,
  validateDrafts,
  type DraftProp,
} from "@/lib/import/draft"
import { feedKeyFor } from "@/lib/odds-feed/theoddsapi"
import { attachQuotes, indexQuotes, type NormalizedQuote } from "@/lib/odds-feed/theoddsapi"
import { useStore } from "@/lib/store/provider"
import { LEAGUES, LEAGUE_IDS, leagueFor, maxGamesForLeague, type LeagueId } from "@/lib/leagues"

export default function ImportPage() {
  const router = useRouter()
  const { state, setSlate } = useStore()
  const [drafts, setDrafts] = React.useState<DraftProp[]>([])
  const [label, setLabel] = React.useState("")
  const [app, setApp] = React.useState("prizepicks")

  const [league, setLeague] = React.useState<LeagueId>(state.settings.daily.league)

  const [ocrBusy, setOcrBusy] = React.useState(false)
  const [ocrStatus, setOcrStatus] = React.useState("")
  const [pasteText, setPasteText] = React.useState("")

  // What the last read actually saw. Shown whenever a read finds nothing, or
  // leaves lines unplaced, so a failure is never just a silent empty table.
  const [lastRead, setLastRead] = React.useState<{
    source: "screenshot" | "paste"
    found: number
    lines: string[]
    leftover: string[]
  } | null>(null)

  const [oddsBusy, setOddsBusy] = React.useState(false)
  const [oddsReport, setOddsReport] = React.useState<{
    matched: number
    unmatched: { player: string; market: string }[]
    ambiguous?: { player: string; market: string; games: string[] }[]
    remaining: number | null
    error?: string
  } | null>(null)

  /**
   * Add rows, skipping any already in the table.
   *
   * Two screenshots of a scrolling board overlap at the seam, so the same card
   * arrives twice. A duplicate is a blocking problem at load time, which used
   * to leave the Load button greyed out for a reason that had nothing to do
   * with the data. Returns how many were skipped so the toast can say so.
   */
  // Latest rows, read synchronously. A state updater runs on the next render,
  // too late to report how many rows it skipped.
  const draftsRef = React.useRef(drafts)
  React.useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])

  function addDrafts(incoming: DraftProp[]): number {
    const key = (d: DraftProp) => `${d.player.trim().toLowerCase()}|${d.marketKey}|${d.line}|${d.app ?? ""}`
    const seen = new Set(draftsRef.current.map(key))
    const fresh: DraftProp[] = []
    let skipped = 0
    for (const d of incoming) {
      const k = key(d)
      if (seen.has(k)) {
        skipped++
        continue
      }
      seen.add(k)
      fresh.push(d)
    }
    draftsRef.current = [...draftsRef.current, ...fresh]
    setDrafts(draftsRef.current)
    return skipped
  }

  const summary = React.useMemo(() => summariseDrafts(drafts), [drafts])
  const blocking = React.useMemo(
    () => validateDrafts(drafts).filter((p) => p.message !== "Not reviewed yet."),
    [drafts],
  )
  const canLoad = drafts.length > 0 && summary.blocking === 0

  async function onScreenshots(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setOcrBusy(true)
    try {
      const { readImage } = await import("@/lib/ocr/engine")
      const found: DraftProp[] = []
      const seen: string[] = []
      const leftover: string[] = []
      for (let i = 0; i < files.length; i++) {
        setOcrStatus(`Reading image ${i + 1} of ${files.length}…`)
        const out = await readImage(files[i], (p) => setOcrStatus(`${p.status} ${Math.round(p.progress * 100)}%`))
        // The league is the one picked above the table, and the page already
        // says it has to match the players you capture. It decides which team
        // codes are a team rather than a person.
        const r = extractProps(out.lines, { league })
        const r2 = extractProps(out.cleanedLines, { league })
        for (const c of mergeReads(r.candidates, r2.candidates)) found.push(draftFromCandidate(c, app))
        // Show whichever read got further, so "what was read" is the useful one.
        const best = r2.candidates.length > r.candidates.length ? { res: r2, lines: out.cleanedLines } : { res: r, lines: out.lines }
        seen.push(...best.lines.map((l) => l.text))
        leftover.push(...best.res.leftover.map((l) => l.text))
      }
      const dupes = addDrafts(found)
      setLastRead({ source: "screenshot", found: found.length, lines: seen, leftover })
      if (found.length > 0) {
        toast.success(`Read ${found.length} props`, {
          description:
            (dupes > 0 ? `${dupes} already in the table, skipped. ` : "") + "Check every row before loading them.",
        })
      } else if (seen.length === 0) {
        toast.error("No text found in that image", {
          description: "Try a sharper screenshot, cropped to the cards, without the keyboard or notifications over it.",
        })
      } else {
        toast.error("Text found, but no props recognised", { description: "See what was read below." })
      }
    } catch (err) {
      toast.error("Could not read that image", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setOcrBusy(false)
      setOcrStatus("")
      e.target.value = ""
    }
  }

  function onPaste(text: string) {
    setPasteText(text)
    if (!text.trim()) return

    // A comma or tab on the first line used to send everything to the CSV
    // parser, which needs a header row. Plain text that happened to contain a
    // comma ("Tue, Sep 26") then came back with zero rows. Now the CSV reading
    // is tried first and the free-text reader takes over if it finds nothing.
    const looksStructured =
      /[,\t]/.test(text.split(/\r?\n/)[0] ?? "") || text.trim().startsWith("[") || text.trim().startsWith("{")
    if (looksStructured) {
      const r = parseSlate(text)
      if (r.rows.length > 0) {
        addDrafts(r.rows.map(draftFromRow))
        setLastRead(null)
        toast.success(`Read ${r.rows.length} rows`, {
          description: r.skipped.length > 0 ? `${r.skipped.length} lines could not be read.` : undefined,
        })
        setPasteText("")
        return
      }
    }

    const lines = linesFromText(text)
    const { candidates, leftover } = extractProps(lines, { league })
    const dupes = addDrafts(candidates.map((c) => ({ ...draftFromCandidate(c, app), origin: "paste" as const })))
    setLastRead({ source: "paste", found: candidates.length, lines: lines.map((l) => l.text), leftover: leftover.map((l) => l.text) })
    if (candidates.length > 0) {
      toast.success(`Found ${candidates.length} props`, {
        description: (dupes > 0 ? `${dupes} already in the table, skipped. ` : "") + "Check every row before loading them.",
      })
      setPasteText("")
    } else {
      // Keep the text in the box so it can be fixed rather than retyped.
      toast.error("No props recognised in that text", { description: "See the accepted formats below." })
    }
  }

  async function fetchOdds() {
    const wanted = Array.from(new Set(drafts.map((d) => d.marketKey).filter(Boolean)))
      .map((m) => feedKeyFor(m!))
      .filter((k): k is string => !!k)

    if (wanted.length === 0) {
      toast.error("Nothing to price yet")
      return
    }

    setOddsBusy(true)
    setOddsReport(null)
    try {
      const res = await fetch("/api/odds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: state.settings.oddsFeed.apiKey || undefined,
          provider: state.settings.oddsFeed.provider,
          proplineKey: state.settings.oddsFeed.proplineKey || undefined,
          league,
          from: startOfToday().toISOString(),
          to: endOfSlate().toISOString(),
          maxGames: maxGamesForLeague(league, { billsPerRequest: state.settings.oddsFeed.provider === "propline" }),
          markets: wanted,
          regions: state.settings.oddsFeed.regions,
          bookmakers: state.settings.oddsFeed.books,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setOddsReport({ matched: 0, unmatched: [], remaining: null, error: data.error ?? `Request failed (${res.status}).` })
        return
      }

      const index = indexQuotes((data.quotes ?? []) as NormalizedQuote[])
      const rows = drafts.map((d) => ({ player: d.player, marketKey: d.marketKey, marketLabel: "", draft: d }))
      const attached = attachQuotes(rows, index)
      setDrafts(attached.rows.map((r) => ({ ...r.draft, quotes: r.quotes })))
      setOddsReport({
        matched: attached.matched,
        unmatched: attached.unmatched,
        ambiguous: attached.ambiguous,
        remaining: data.requestsRemaining ?? null,
      })
      if (attached.matched > 0) {
        toast.success(`Priced ${attached.matched} of ${drafts.length} props`)
      } else if ((data.events ?? []).length === 0) {
        toast.error(
          data.startedCount > 0
            ? `Every ${leagueFor(league).label} game today has already started`
            : `No ${leagueFor(league).label} games today`,
          {
            description:
              data.startedCount > 0
                ? "Live games are not priced: their lines move with the score."
                : "Check the league picker matches the players you captured.",
          },
        )
      } else if (data.failures?.length) {
        // Some games failed. Their players are unmatched for that reason, not
        // because of a spelling, so say what the feed said.
        toast.warning(`${data.failures.length} of ${data.events.length} games could not be priced`, {
          description: data.failures[0].error,
        })
      } else {
        toast.warning("No prices matched", { description: "Names are matched exactly. Check spelling in the table." })
      }
    } catch (err) {
      setOddsReport({ matched: 0, unmatched: [], remaining: null, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setOddsBusy(false)
    }
  }

  function commit() {
    if (!canLoad) return
    setSlate({
      id: crypto.randomUUID(),
      label: label.trim() || `Slate ${new Date().toLocaleDateString()}`,
      importedAt: new Date().toISOString(),
      rows: drafts.map(draftToRow),
      source: drafts.some((d) => d.origin === "screenshot") ? "screenshot" : "paste",
      league,
    })
    toast.success(`Loaded ${drafts.length} props`, { description: "Opening the Board." })
    // The Board is where a captured slate is shown and priced. This used to go
    // to Today, which reads the odds feed and never looks at the slate, so a
    // successful capture appeared to vanish.
    router.push("/board")
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-lg font-semibold tracking-tight">Capture slate</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Read your own screenshots of the board, review every row, then attach sportsbook prices from the odds feed.
          The board tells you what is on offer. The sportsbook side is what tells you whether it is worth taking, and a
          prop without it stays unpriced.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">League</span>
          <div role="tablist" aria-label="League" className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/40 p-1">
            {LEAGUE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === league}
                onClick={() => setLeague(id)}
                className={
                  id === league
                    ? "rounded-md bg-primary/15 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-primary ring-1 ring-primary/30"
                    : "rounded-md px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground hover:bg-secondary hover:text-foreground"
                }
              >
                {LEAGUES[id].short}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground">
            Odds are pulled from this league&apos;s feed, so it must match the players you capture.
          </span>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Rows" value={String(summary.total)} hint="Props captured so far." />
        <StatTile
          label="Reviewed"
          value={`${summary.confirmed}/${summary.total}`}
          tone={summary.total > 0 && summary.confirmed === summary.total ? "good" : "warn"}
          hint="Tick each row once you have checked the player, market and line against the screenshot."
        />
        <StatTile
          label="Priced"
          value={String(summary.priced)}
          tone={summary.priced > 0 ? "good" : "neutral"}
          hint="Props with a sportsbook price attached. Only these can be built into entries."
        />
        <StatTile
          label="Blocking problems"
          value={String(summary.blocking)}
          tone={summary.blocking > 0 ? "bad" : "good"}
          hint="Rows that cannot be loaded until they are fixed or reviewed."
        />
      </div>

      <Tabs defaultValue="screenshot">
        <TabsList className="font-mono text-xs">
          <TabsTrigger value="screenshot">Screenshots</TabsTrigger>
          <TabsTrigger value="paste">Paste</TabsTrigger>
        </TabsList>

        <TabsContent value="screenshot" className="mt-4">
          <div className="rounded-lg border border-border/60 bg-card/40 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">App</Label>
                <Input value={app} onChange={(e) => setApp(e.target.value)} className="mt-1.5 h-9 w-40 font-mono text-xs" />
              </div>
              <Button asChild disabled={ocrBusy}>
                <label className="cursor-pointer">
                  {ocrBusy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <ImageUp className="mr-1 size-3.5" />}
                  {ocrBusy ? "Reading…" : "Add screenshots"}
                  <input type="file" accept="image/*" multiple className="hidden" onChange={onScreenshots} disabled={ocrBusy} />
                </label>
              </Button>
              {ocrStatus ? <span className="font-mono text-[11px] text-muted-foreground">{ocrStatus}</span> : null}
            </div>
            <p className="mt-3 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
              Screenshot the board on your phone and drop the images here. Reading happens entirely in this browser, so
              nothing is uploaded and no app is scraped. Capture the fifteen or so props you would genuinely consider
              rather than the whole board: every row still has to be checked by eye, and a shorter list gets checked
              properly.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="paste" className="mt-4">
          <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => onPaste(SAMPLE_CSV)}>
                <Download className="mr-1 size-3" /> Load worked example
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <label className="cursor-pointer">
                  <FileUp className="mr-1 size-3" /> Choose a file
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,.json"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (f) onPaste(await f.text())
                      e.target.value = ""
                    }}
                  />
                </label>
              </Button>
            </div>
            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"One prop per line:\n\nAnthony Edwards 24.5 Points\nCaitlin Clark over 8.5 assists\nJosh Allen 245.5 Pass Yards\n\nCSV or JSON with a header row also works."}
              className="min-h-40 font-mono text-[11px] leading-relaxed"
              spellCheck={false}
            />
            <Button size="sm" disabled={!pasteText.trim()} onClick={() => onPaste(pasteText)}>
              Add these rows
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {lastRead && (lastRead.found === 0 || lastRead.leftover.length > 0) ? (
        <section
          className={
            lastRead.found === 0
              ? "space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
              : "space-y-2 rounded-lg border border-border/60 bg-card/40 p-4"
          }
        >
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
              {lastRead.found === 0
                ? lastRead.lines.length === 0
                  ? "No text found"
                  : "Read, but no props recognised"
                : `${lastRead.leftover.length} line${lastRead.leftover.length === 1 ? "" : "s"} not used`}
            </h2>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setLastRead(null)}>
              Dismiss
            </Button>
          </div>

          {lastRead.found === 0 ? (
            <div className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <p>A prop needs three things close together: a player name, a line like 24.5, and a stat.</p>
              {lastRead.source === "paste" ? (
                <p>
                  Easiest is one prop per line: <code className="font-mono text-foreground">LeBron James 24.5 Points</code>.
                  &quot;over&quot;/&quot;under&quot; and shorthand like <code className="font-mono text-foreground">o24.5 pts</code> are fine.
                </p>
              ) : (
                <p>
                  Crop to the prop cards. Leave out the keyboard, notifications and your entry slip. If a card is only half on
                  screen, scroll and take another shot rather than including it.
                </p>
              )}
              <p>
                Or press <span className="text-foreground">Add row</span> below the table and type it in.
              </p>
            </div>
          ) : null}

          {(lastRead.found === 0 ? lastRead.lines : lastRead.leftover).length > 0 ? (
            <details className="text-[11px]" open={lastRead.found === 0}>
              <summary className="cursor-pointer font-mono text-muted-foreground">
                {lastRead.found === 0 ? "What was read" : "Show them"}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {(lastRead.found === 0 ? lastRead.lines : lastRead.leftover).join("\n")}
              </pre>
            </details>
          ) : null}
        </section>
      ) : null}

      {drafts.length === 0 && lastRead?.found === 0 ? (
        <Button variant="secondary" size="sm" onClick={() => setDrafts([emptyDraft(app)])}>
          <Plus className="mr-1 size-3" /> Add a row by hand
        </Button>
      ) : null}

      {drafts.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Review</h2>
            <Button variant="ghost" size="sm" onClick={() => setDrafts((d) => [...d, emptyDraft(app)])}>
              <Plus className="mr-1 size-3" /> Add row
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDrafts((d) => d.map((x) => ({ ...x, confirmed: true })))}
            >
              Mark all reviewed
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDrafts([])}>
              Clear
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={fetchOdds} disabled={oddsBusy}>
                {oddsBusy ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                Attach sportsbook odds
              </Button>
            </div>
          </div>

          {oddsReport ? (
            oddsReport.error ? (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {oddsReport.error} Props stay unpriced until a price is attached, so the optimizer will refuse to build
                  entries from them.
                </span>
              </p>
            ) : (
              <p className="rounded-lg border border-border/60 bg-card/40 p-3 text-xs leading-relaxed text-muted-foreground">
                Priced {oddsReport.matched} of {drafts.length}.
                {oddsReport.remaining != null ? ` ${oddsReport.remaining} feed requests left this period.` : ""}
                {oddsReport.ambiguous && oddsReport.ambiguous.length > 0 ? (
                  <span className="mt-1 block text-accent">
                    Two players of the same name:{" "}
                    {oddsReport.ambiguous
                      .slice(0, 6)
                      .map((a) => `${a.player} ${a.market} (${a.games.map((g) => g.replace("@", " at ")).join(", ")})`)
                      .join("; ")}
                    {oddsReport.ambiguous.length > 6 ? ` and ${oddsReport.ambiguous.length - 6} more` : ""}. The board
                    row says who, not which game, so the prices attached may be the other player&apos;s. Check these
                    before pricing them.
                  </span>
                ) : null}
                {oddsReport.unmatched.length > 0 ? (
                  <>
                    {" "}
                    No price found for: {oddsReport.unmatched.slice(0, 8).map((u) => `${u.player} ${u.market}`).join(", ")}
                    {oddsReport.unmatched.length > 8 ? ` and ${oddsReport.unmatched.length - 8} more` : ""}. Names are
                    matched exactly rather than approximately, so check spelling before assuming the book has no market.
                  </>
                ) : null}
              </p>
            )
          ) : null}

          <ReviewTable drafts={drafts} onChange={setDrafts} />

          {blocking.length > 0 ? (
            <ul className="space-y-1 text-[11px] text-destructive">
              {blocking.slice(0, 6).map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Slate name
              </Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Tuesday main slate"
                className="mt-1.5 h-9 w-56 font-mono text-xs"
              />
            </div>
            <Button onClick={commit} disabled={!canLoad}>
              Load {drafts.length} props
            </Button>
            {!canLoad ? (
              <span className="text-[11px] text-muted-foreground">
                {summary.confirmed < summary.total
                  ? `${summary.total - summary.confirmed} rows still need reviewing.`
                  : "Fix the problems above first."}
              </span>
            ) : summary.priced === 0 ? (
              // Loading is allowed, but an unpriced slate shows as dashes on the
              // Board, which looks like capture failed. Say so before, not after.
              <span className="max-w-sm text-[11px] leading-relaxed text-amber-500">
                None of these have a sportsbook price yet, so the Board will show them as unpriced. Press Attach
                sportsbook odds first.
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** Tomorrow 11am local: catches late tips that roll past midnight UTC. */
function endOfSlate(): Date {
  const d = startOfToday()
  d.setDate(d.getDate() + 1)
  d.setHours(11, 0, 0, 0)
  return d
}
