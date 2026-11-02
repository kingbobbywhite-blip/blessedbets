"use client"

import * as React from "react"
import { TriangleAlert } from "lucide-react"
import { Input } from "@/components/ui/input"
import { SideBadge } from "@/components/side-badge"
import { CompetitionBadge } from "@/components/competition-badge"
import { pct, possessive } from "@/lib/format"
import { DEFAULT_APPS, findApp } from "@/lib/quant/payouts"
import { appVerdict, barFor, dfsVerdict, probAt, pushAt, type AppLine, type DfsTarget, type SideBars } from "@/lib/today/build"

/** "PrizePicks 24.5 over 58%", or the flavour and multiplier when the pick is not standard. */
function describeAppLine(l: AppLine): string {
  const name = findApp(DEFAULT_APPS, l.app)?.name ?? l.app
  const flavour = l.pickType === "standard" ? "" : ` ${l.pickType}`
  const sides: string[] = []
  if (l.overOffered) sides.push(`over ${pct(l.over, 0)}${l.overMultiplier != null ? ` ×${l.overMultiplier}` : ""}`)
  if (l.underOffered) sides.push(`under ${pct(l.under, 0)}${l.underMultiplier != null ? ` ×${l.underMultiplier}` : ""}`)
  // An app moves its lines, so one read a while ago is a guess about the
  // present rather than a reading of it, and the row has to say which it is.
  const age = l.isStale && l.ageMinutes != null ? ` · ${Math.round(l.ageMinutes)}m old` : ""
  return `${name}${flavour} ${l.line}: ${sides.join(", ")}${age}`
}

/**
 * One pick'em target: type the line your app is showing and get one answer.
 *
 * The thresholds stay visible as a rule ("over at 9.5 or lower, under at 16.5
 * or higher"), but never as two picks side by side, which is how both sides of
 * one prop ended up in two entries.
 *
 * When the pull carried the default app's own line, it is filled in, and the
 * answer follows the entry's rule: only a side the app offers as a standard
 * pick is named, so a discounted Underdog side reads as a pass with its reason.
 * Typing a different number still overrides it.
 */
export function DfsTargetRow({ t, bar, app }: { t: DfsTarget; bar: number | SideBars; app?: string | null }) {
  // One bar per side: an under may carry a margin the over does not.
  const bars: SideBars = typeof bar === "number" ? { over: bar, under: bar } : bar
  const atApp = app ? appVerdict(t, app, bars) : null
  const appLabel = (app && findApp(DEFAULT_APPS, app)?.name) || app || "the app"
  // The chance the row leads with is the chance at the line you can play: the
  // app's own when the pull carried it, the books' when it did not. Both are
  // real numbers; only one of them is on your screen, so the row names which.
  const atAppLine = atApp ? t.appLines?.find((l) => l.app === app && Math.abs(l.line - atApp.line) < 1e-9) : undefined
  const chanceSide: "OVER" | "UNDER" | null = atApp
    ? atAppLine
      ? atAppLine.over >= atAppLine.under
        ? "OVER"
        : "UNDER"
      : atApp.side
    : t.marketSide
  const chanceProb = atApp
    ? atAppLine
      ? Math.max(atAppLine.over, atAppLine.under)
      : (atApp.prob ?? t.marketProb)
    : t.marketProb
  // A line the app posted a long time ago has very likely moved since. The one
  // that matters is the line being acted on: a stale demon beside a fresh
  // standard line is not a reason to doubt the number in the box.
  const staleAppLine = atAppLine?.isStale ? atAppLine : undefined
  const [typed, setTyped] = React.useState<string | null>(null)
  const fromApp = typed == null && atApp != null
  const line = typed ?? (atApp ? String(atApp.line) : "")
  const value = Number.parseFloat(line)
  const verdict = fromApp
    ? (atApp.side ?? "PASS")
    : line.trim() === ""
      ? null
      : dfsVerdict(t, value)
  // The ladder holds only half-point lines; on a whole number the app line
  // priced at that exact number (push included) has the chance.
  const atThisLine = t.appLines?.find((l) => l.app === app && Math.abs(l.line - value) < 1e-9)
  const chance = fromApp
    ? atApp.prob
    : verdict && verdict !== "PASS"
      ? (probAt(t, value, verdict) ?? (atThisLine ? (verdict === "OVER" ? atThisLine.over : atThisLine.under) : null))
      : null
  // The chance the line in the box lands exactly on itself. Zero on a
  // half-point, which is most of them; on a whole number it is the most
  // important thing about the line, because the leg is voided rather than won
  // and an all-or-nothing entry shrinks around it.
  const pushHere = Number.isFinite(value) ? (atThisLine?.push ?? pushAt(t, value) ?? 0) : 0
  const passReason = fromApp && atApp.reason ? atApp.reason : `neither side clears at ${value}`

  const rule = [
    t.overAt != null ? `over if ${t.overAt} or lower` : null,
    t.underAt != null ? `under if ${t.underAt} or higher` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <tr className="border-b border-border/40 last:border-0 hover:bg-card/40">
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5 font-medium leading-tight">
          {t.player}
          <CompetitionBadge competition={t.competition} />
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">{t.gameId.replace("@", " at ")}</div>
        {t.warnings?.map((w) => (
          <div key={w} className="mt-0.5 flex max-w-xs items-start gap-1 text-[10px] leading-snug text-accent">
            <TriangleAlert className="mt-0.5 size-2.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}
        {t.appLines && t.appLines.length > 0 ? (
          <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground">
            {t.appLines.map((l) => (
              <li key={`${l.app}|${l.line}|${l.pickType}`} className={l.app === app ? "text-foreground/80" : undefined}>
                {describeAppLine(l)}
              </li>
            ))}
          </ul>
        ) : null}
      </td>
      <td className="px-3 py-2 font-mono text-xs">{t.marketLabel}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">
        {t.mean.toFixed(1)}
        <span className="ml-1 text-[10px] text-muted-foreground">±{t.sd.toFixed(1)}</span>
        <div className="text-[10px] text-muted-foreground">fair {t.fairLine}</div>
      </td>
      <td className="px-3 py-2">
        {/* The chance at the line you can actually play, which is the app's own
            when the pull carried it. Reading the books' number as the app's is
            the single easiest mistake to make on this screen, so the line is
            always named and the two are never shown as one.

            Below the bar, neither side is a pick'em play, so no side is shown:
            a 52% "under" here beside a sportsbook's priced "over" read as two
            picks. */}
        {chanceSide && chanceProb >= barFor(bars, chanceSide) ? (
          <div className="flex items-center gap-1.5">
            <SideBadge side={chanceSide} />
            <span className="font-mono text-xs tabular-nums">{pct(chanceProb, 0)}</span>
          </div>
        ) : (
          <div className="font-mono text-xs text-muted-foreground">Pass · {pct(chanceProb, 0)} at most</div>
        )}
        <div className="font-mono text-[10px] text-muted-foreground">
          {atApp ? `at ${possessive(appLabel)} ${atApp.line}` : `at the books' ${t.marketLine}`}
        </div>
        {atApp && Math.abs(atApp.line - t.marketLine) > 1e-9 ? (
          <div className="font-mono text-[10px] text-muted-foreground/70">books&apos; {t.marketLine}</div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <Input
          inputMode="decimal"
          value={line}
          onChange={(e) => setTyped(e.target.value.trim() === "" ? null : e.target.value)}
          placeholder={String(t.marketLine)}
          className="h-7 w-20 font-mono text-xs"
          aria-label={`Line your app shows for ${t.player} ${t.marketLabel}`}
        />
        {fromApp ? (
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {possessive(appLabel)} line
          </div>
        ) : null}
        {staleAppLine && staleAppLine.ageMinutes != null ? (
          <div className="mt-0.5 font-mono text-[10px] leading-snug text-accent">
            read {Math.round(staleAppLine.ageMinutes)}m ago; check it
          </div>
        ) : null}
        {pushHere > 0.005 ? (
          <div className="mt-0.5 font-mono text-[10px] leading-snug text-accent">
            voids {pct(pushHere, 0)} of the time
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        {verdict == null ? (
          <span className="font-mono text-[10px] text-muted-foreground">{rule}; pass between</span>
        ) : verdict === "PASS" ? (
          <span className="font-mono text-xs text-muted-foreground">Pass: {passReason}</span>
        ) : (
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <SideBadge side={verdict} />
              <span className="font-mono text-xs">only{chance != null ? ` · ${pct(chance, 0)}` : ""}</span>
            </span>
            {/* A whole number is not a half-point with a rounder name. Landing
                on it is neither side: the leg is voided and an all-or-nothing
                entry shrinks to one fewer pick, at a lower multiplier. */}
            {pushHere > 0.005 ? (
              <span className="font-mono text-[10px] leading-snug text-accent">
                {value} is a whole number: {pct(pushHere, 0)} of the time it lands exactly there and the leg voids,
                shrinking the entry
              </span>
            ) : null}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{t.confidence}</td>
    </tr>
  )
}
