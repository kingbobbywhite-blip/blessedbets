"use client"

import * as React from "react"
import { ArrowLeftRight, CircleCheck, CircleX, Eye, EyeOff, Loader2, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useKeyCheck } from "@/hooks/use-key-check"
import { cleanApiKey, describeKey, looksLikeOddsApiKey, usableKey } from "@/lib/odds-feed/api-key"
import type { CheckedFeed } from "@/lib/odds-feed/check"
import type { LeagueId } from "@/lib/leagues"
import { cn } from "@/lib/utils"

const FEED_NAMES: Record<CheckedFeed, string> = { theoddsapi: "The Odds API", propline: "PropLine" }

/**
 * One feed's API key in Settings: the field, what is saved in it, and whether
 * the feed accepts it.
 *
 * The two key fields used to be bare password inputs, and every way of
 * holding the wrong key looked the same in them: a row of dots. Four things
 * are different here, each for a failure that was real.
 *
 * A paste replaces the field. Pasting a new key into a field that still held
 * the old one put the new key inside or after it, and the dots only got
 * longer -- sixty-four where thirty-two were meant. The feed refused the lot,
 * and the error's "ends in" matched the new key, because the new key was the
 * end of it. Nobody pastes half a key, so a paste is the whole key.
 *
 * It is not a password field. A browser's password manager offers to save
 * what is typed into one and puts a saved value back later, and here every
 * change to the field is a change to the stored key: an old key put back by
 * the browser replaced the new one without a keystroke. The dots are drawn by
 * the stylesheet instead, and the field can be shown.
 *
 * What is saved is said underneath -- how long it is, how it ends, and which
 * address it is saved for, since each address this app is opened at keeps
 * keys of its own.
 *
 * And the feed is asked. As soon as a whole key is in the field the feed says
 * whether it knows it, about exactly the key a pull would send, so a key
 * problem is found here, in a second, rather than by a failed pull on Today.
 */
export function FeedKeyField({
  feed,
  label,
  value,
  onChange,
  placeholder,
  envName,
  serverHasKey,
  league,
  onSwap,
  swapLabel,
  children,
}: {
  feed: CheckedFeed
  label: string
  /** The key as stored. */
  value: string
  onChange: (next: string) => void
  placeholder: string
  /** The environment variable that outranks this field, e.g. ODDS_API_KEY. */
  envName: string
  /** Whether the server holds that variable. Null until it has answered. */
  serverHasKey: boolean | null
  /** The league on Today, whose listing PropLine is asked for. */
  league: LeagueId
  /** Exchanges this field's key with the other feed's. Offered when the feed refuses this one. */
  onSwap?: () => void
  swapLabel?: string
  /** The field's standing explanation. */
  children?: React.ReactNode
}) {
  const id = React.useId()
  const [shown, setShown] = React.useState(false)
  // Read after mount: there is no address while the page is being prerendered.
  const [host, setHost] = React.useState<string | null>(null)
  React.useEffect(() => setHost(window.location.host), [])

  const name = FEED_NAMES[feed]
  const key = usableKey(value)
  const check = useKeyCheck(feed, value, { serverHasKey, league })
  const verdict = check.result
  // The shape is a guess about what the vendor issues; its own answer is not.
  const oddShape = feed === "theoddsapi" && key != null && !looksLikeOddsApiKey(key) && verdict?.status !== "ok"

  return (
    <div>
      <Label htmlFor={id} className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </Label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <Input
          id={id}
          type="text"
          name={`feed-key-${feed}`}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(cleanApiKey(e.target.value))}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text")
            if (!pasted.trim()) return
            // The whole key, in place of whatever was there. See above.
            e.preventDefault()
            onChange(cleanApiKey(pasted))
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          // Password managers are asked to leave it alone, each in its own dialect.
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          aria-describedby={`${id}-saved ${id}-status`}
          className={cn("min-w-48 flex-1 font-mono text-xs", !shown && value ? "[-webkit-text-security:disc]" : "")}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-9 font-mono text-[11px]"
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {shown ? "Hide" : "Show"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-9 font-mono text-[11px]"
          disabled={!check.canCheck || check.checking}
          onClick={check.check}
        >
          {check.checking ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Test key
        </Button>
      </div>

      <p id={`${id}-saved`} className="mt-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {key
          ? `Saved in this browser${host ? ` for ${host}` : ""}: ${describeKey(key)}.`
          : value.trim()
            ? "That is a placeholder, not a key, so it is never sent."
            : `No ${feed === "theoddsapi" ? "Odds API" : name} key saved in this browser${host ? ` for ${host}` : ""}.`}
      </p>

      {oddShape ? (
        <p role="note" className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-accent">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span>
            An Odds API key is normally 32 characters, each 0-9 or a-f, and this is {key!.length}.{" "}
            {/^[0-9a-f]{64}$/i.test(key!)
              ? "That is the length of two keys run together: clear the field and paste the key once."
              : "It may be the PropLine key, or have something else pasted along with it."}
          </span>
        </p>
      ) : null}

      <div id={`${id}-status`} role="status" aria-live="polite" className="mt-1 text-[11px] leading-relaxed">
        {check.checking ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            Asking {name} about this key…
          </p>
        ) : check.problem ? (
          <p className="flex items-start gap-1.5 text-accent">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
            <span>{check.problem}</span>
          </p>
        ) : verdict && verdict.status === "ok" ? (
          <p className="flex items-start gap-1.5 text-primary">
            <CircleCheck className="mt-0.5 size-3 shrink-0" />
            <span>{verdict.message}</span>
          </p>
        ) : verdict && verdict.status === "rejected" ? (
          <div className="space-y-1.5">
            <p className="flex items-start gap-1.5 text-destructive">
              <CircleX className="mt-0.5 size-3 shrink-0" />
              <span>{verdict.message}</span>
            </p>
            {onSwap && verdict.source === "settings" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 font-mono text-[11px]"
                onClick={onSwap}
              >
                <ArrowLeftRight className="size-3" />
                {swapLabel ?? "Swap the two keys"}
              </Button>
            ) : null}
          </div>
        ) : verdict && verdict.status !== "missing" ? (
          <p className="flex items-start gap-1.5 text-accent">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
            <span>{verdict.message}</span>
          </p>
        ) : null}
      </div>

      {children ? <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{children}</p> : null}

      {serverHasKey ? (
        <p role="note" className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-accent">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span>
            This server has {envName} set in its environment, and that is the key every pull sends. A key typed here
            is kept but not used until {envName} is removed there: on Vercel, under the project&apos;s Settings →
            Environment Variables, followed by a redeploy; on your own machine, in .env.local, followed by a restart.
          </span>
        </p>
      ) : null}
    </div>
  )
}
