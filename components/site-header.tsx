import Link from "next/link"
import { Activity } from "lucide-react"
import { NavLinks } from "./nav-links"
import { StorageNotice } from "./storage-notice"
import { LEAGUES, LEAGUE_IDS } from "@/lib/leagues"

export function SiteHeader() {
  return (
    // Padded by the status bar's height: added to an iPhone home screen the
    // page draws under it (viewportFit "cover", status bar "black-translucent"),
    // and the logo and the nav sat behind the clock and the battery.
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 md:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
            <Activity className="size-4" aria-hidden />
          </span>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-sm font-semibold tracking-tight">BlessedBets</span>
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:inline">
              {LEAGUE_IDS.map((id) => LEAGUES[id].short).join(" · ")}
            </span>
          </div>
        </Link>
        <NavLinks />
      </div>
      <StorageNotice />
    </header>
  )
}
