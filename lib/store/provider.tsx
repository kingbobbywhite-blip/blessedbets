"use client"

import * as React from "react"
import { clearLegacyState, loadState, onStored } from "./local"
import { joinParts, openPartStore, parseRecords, partsOf, type PartStore } from "./idb"
import { openTabs, syncBlob, syncParts, type SaveFailure, type TabHost, type TabSync } from "./sync"
import {
  EMPTY_STATE,
  MAX_LINE_SNAPSHOTS,
  migrate,
  type AppSettings,
  type AppState,
  type DailyCache,
  type LineSnapshot,
  type Slate,
  type TrackedSlip,
} from "./schema"

interface StoreValue {
  state: AppState
  /** False until storage has been read, so the UI can avoid flashing empty. */
  ready: boolean
  /** Why a save failed, when it failed for some reason other than room. */
  saveError: string | null
  /**
   * What could not be kept for want of room, in words. It is still in the
   * state and on screen: nothing is ever taken off the screen to make a save
   * fit. It is gone after a reload.
   */
  unsaved: string[]
  setSettings: (updater: (s: AppSettings) => AppSettings) => void
  setSlate: (slate: Slate | null) => void
  /** Store a pull under its own league, leaving the other leagues' caches intact. */
  setDaily: (daily: DailyCache) => void
  /** Keep a pull's lines for later comparison against the same props nearer kick-off. */
  addLineSnapshot: (snapshot: LineSnapshot) => void
  addSlip: (slip: TrackedSlip) => void
  updateSlip: (id: string, updater: (s: TrackedSlip) => TrackedSlip) => void
  removeSlip: (id: string) => void
  replaceAll: (next: AppState) => void
}

const Ctx = React.createContext<StoreValue | null>(null)

/**
 * How long another tab has to stop storing the blob before this one reads it.
 * Without IndexedDB every keystroke in a form stores the whole state again,
 * megabytes of it, and reading each of those in full would keep this tab busy
 * for as long as someone typed in the other.
 */
const STORED_PAUSE_MS = 200

/**
 * Opens IndexedDB and reads the state out of it, moving an install still on
 * the old localStorage blob across first. Rejects where IndexedDB cannot be
 * used, and the caller falls back to that blob.
 */
async function loadFromIndexedDb(): Promise<{ db: PartStore; state: AppState; stored: Record<string, string> }> {
  const db = await openPartStore()
  // The old blob, or the empty state on a fresh install, written only if the
  // database holds nothing yet. The blob is cleared once it is in, giving its
  // share of the localStorage quota back.
  if (await db.seed(partsOf(loadState()))) clearLegacyState()
  // Read back rather than trusted: if another tab seeded first, its state is
  // the one stored, and this tab has to show the same.
  const texts = await db.readAll()
  const records = parseRecords(texts)
  const raw = joinParts(records)
  // Only what could be read counts as stored. A record that would not parse
  // is one to write over, not one to add this tab's changes to.
  const stored = Object.fromEntries(Object.keys(records).map((key) => [key, texts[key]]))
  return { db, state: raw ? migrate(raw) : EMPTY_STATE, stored }
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AppState>(EMPTY_STATE)
  const [ready, setReady] = React.useState(false)
  const [failures, setFailures] = React.useState<Record<string, SaveFailure>>({})
  // The state itself. `state` above is React's copy of it and can be a render
  // behind: a change another tab made is laid under whatever was typed here
  // an instant ago, and that needs the state as it is now, not as it was last
  // drawn. Every change goes through `show`, which moves both.
  const latest = React.useRef<AppState>(EMPTY_STATE)
  // What keeps this tab in step with storage and with the other tabs: on
  // IndexedDB, or on the localStorage blob. Null until storage has been read.
  const sync = React.useRef<TabSync | null>(null)

  const show = React.useCallback((next: AppState) => {
    if (next === latest.current) return
    latest.current = next
    setState(next)
  }, [])
  const change = React.useCallback((update: (s: AppState) => AppState) => show(update(latest.current)), [show])

  React.useEffect(() => {
    let live = true
    let unwatch = () => {}
    // Listening before the first read, not after it: a record another tab
    // writes while this one is still loading is announced once, and a tab
    // that was not yet listening would show the older one until it next came
    // into view. What is heard early is looked at as soon as there is a state
    // to compare it with.
    const early: string[] = []
    const tabs = openTabs((key) => {
      if (sync.current) sync.current.refresh([key])
      else early.push(key)
    })
    const host: TabHost = { get: () => latest.current, set: show, failures: setFailures, tell: tabs.tell }

    // A tab the browser froze in the background, or put aside whole and then
    // restored, heard nothing while it was away. Coming back into view is
    // when that matters, so that is when it looks at everything again.
    const look = () => sync.current?.refresh()
    const onVisible = () => {
      if (document.visibilityState === "visible") look()
    }
    const onRestored = (e: PageTransitionEvent) => {
      if (e.persisted) look()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("pageshow", onRestored)
    window.addEventListener("focus", look)

    loadFromIndexedDb().then(
      (loaded) => {
        if (!live) return
        show(loaded.state)
        sync.current = syncParts(loaded.db, host, loaded)
        sync.current.refresh(early)
        setReady(true)
      },
      () => {
        if (!live) return
        // No IndexedDB: the one localStorage blob. The browser itself says
        // when another tab stores it.
        let timer: ReturnType<typeof setTimeout> | undefined
        const stop = onStored(() => {
          clearTimeout(timer)
          timer = setTimeout(look, STORED_PAUSE_MS)
        })
        unwatch = () => {
          clearTimeout(timer)
          stop()
        }
        show(loadState())
        sync.current = syncBlob(host)
        setReady(true)
      },
    )
    return () => {
      live = false
      sync.current?.stop()
      sync.current = null
      tabs.close()
      unwatch()
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pageshow", onRestored)
      window.removeEventListener("focus", look)
    }
  }, [show])

  // Persist on every change, but not before the initial read has happened, or
  // we would overwrite stored data with the empty default on first paint.
  //
  // A save never changes the state to make itself fit. One that does not fit
  // is reported and left at that: what is on screen stays on screen until a
  // reload. The old rule — shed from the state until the save fits — ended, on
  // a slate too big to store, by shedding the pull that had just come in, so a
  // pull that succeeded read as "Nothing pulled yet". What a save can do is
  // bring in what another tab stored in the meantime: see ./sync.
  React.useEffect(() => {
    if (ready) sync.current?.save()
  }, [state, ready])

  const unsaved = React.useMemo(
    () =>
      Object.values(failures)
        .filter((f) => f.quota)
        .map((f) => f.label),
    [failures],
  )
  const saveError = Object.values(failures).find((f) => !f.quota)?.message ?? null

  const value = React.useMemo<StoreValue>(
    () => ({
      state,
      ready,
      saveError,
      unsaved,
      setSettings: (updater) => change((s) => ({ ...s, settings: updater(s.settings) })),
      setSlate: (slate) => change((s) => ({ ...s, slate })),
      setDaily: (daily) => change((s) => ({ ...s, daily: { ...s.daily, [daily.league]: daily } })),
      addLineSnapshot: (snapshot) =>
        change((s) => ({ ...s, lines: [snapshot, ...s.lines].slice(0, MAX_LINE_SNAPSHOTS) })),
      addSlip: (slip) => change((s) => ({ ...s, slips: [slip, ...s.slips] })),
      updateSlip: (id, updater) =>
        change((s) => ({ ...s, slips: s.slips.map((x) => (x.id === id ? updater(x) : x)) })),
      removeSlip: (id) => change((s) => ({ ...s, slips: s.slips.filter((x) => x.id !== id) })),
      replaceAll: (next) => show(next),
    }),
    [state, ready, saveError, unsaved, change, show],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): StoreValue {
  const v = React.useContext(Ctx)
  if (!v) throw new Error("useStore must be used inside StoreProvider")
  return v
}
