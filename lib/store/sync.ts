import type { LeagueId } from "@/lib/leagues"
import {
  CORE,
  fingerprint,
  partLabel,
  partOf,
  partsOf,
  partsToWrite,
  readPart,
  recordKeys,
  recordKind,
  refsOf,
  sameRefs,
  withPart,
  type Part,
  type PartStore,
} from "./idb"
import { isQuotaError, readStored, saveReduced } from "./local"
import { mergeRecord, mergeState, withShed } from "./merge"
import { migrate, type AppState } from "./schema"

/**
 * Keeping one tab in step with storage, and through storage with every other
 * tab open on the app.
 *
 * A tab used to read storage once, on load, and from then on write records
 * whole from its own copy. Two tabs therefore never saw each other's changes,
 * and the one that had been open longer undid the other's every time it saved
 * anything at all. Three things replace that, in order of how much each is
 * relied on:
 *
 * 1. A write carries only what this tab changed. The record is read and
 *    written in one transaction, and if another tab has stored it since this
 *    one last looked, this tab's changes are added to what is there (see
 *    ./merge) instead of replacing it. This alone is what makes a stale tab
 *    harmless, and it does not depend on any message arriving.
 * 2. A tab that writes a record says so, by name, and the others read that one
 *    record again. This is what makes a change show up on the other screen.
 * 3. A tab looks at every record again when it comes back into view. A tab
 *    the browser froze in the background hears nothing while it is frozen.
 *
 * Nothing here ever takes anything off the screen to make a save fit. What is
 * taken off is only what another tab removed on purpose.
 */

/** A save that did not happen, by the record (or, without IndexedDB, the piece) it was for. */
export interface SaveFailure {
  label: string
  quota: boolean
  message: string
}

/** What keeping a tab in step needs from the tab. */
export interface TabHost {
  /**
   * The state as it is this instant, not as it was at the last render: a
   * character typed since then is in it. A change from another tab is laid
   * under whatever this returns, which is how nothing typed is ever lost to
   * one.
   */
  get(): AppState
  /** Puts a state on this tab's screen. */
  set(next: AppState): void
  /** Changes the record of which saves have failed. */
  failures(update: (prev: Record<string, SaveFailure>) => Record<string, SaveFailure>): void
  /** Tells the other tabs that a record has been written. */
  tell(key: string): void
}

export interface TabSync {
  /** Brings storage up to the tab's state. */
  save(): void
  /** Looks again at what another tab may have written: the records named, or all of them. */
  refresh(keys?: string[]): void
  /** Ends it. Whatever is still in flight finishes, and touches nothing. */
  stop(): void
}

/**
 * What the database held for a record when this tab last looked: the text's
 * fingerprint, and for a record that is merged, the value it stood for. That
 * value is the `base` of the next merge, the last point at which this tab and
 * the database agreed.
 */
interface Seen {
  mark: string | null
  value?: unknown
}

/** The records whose writes add to what is stored. A slate is written whole. */
function merges(key: string): boolean {
  const kind = recordKind(key)
  return kind === "core" || kind === "lines"
}

/**
 * A tab on IndexedDB, one record at a time.
 *
 * `loaded` is the state the tab starts from and the stored text of each
 * record it was read from.
 */
export function syncParts(
  store: PartStore,
  host: TabHost,
  loaded: { state: AppState; stored: Record<string, string> },
): TabSync {
  /**
   * Each stored record, by the references its stored content is made of in
   * this tab's state. A part made of the same references has nothing new to
   * write. Empty for a record whose stored content is not what this tab holds.
   */
  const sent = new Map<string, unknown[]>()
  const seen = new Map<string, Seen>()
  /**
   * Records with a transaction under way, and whether it writes. One at a
   * time per record: the next starts from what the last one found, so a tab
   * never mistakes its own earlier write for another tab's.
   */
  const busy = new Map<string, "read" | "write">()
  /** Records another tab may have written since this one last looked. */
  const stale = new Set<string>()
  /** Records whose last write did not fit, by the references it was made from. */
  const full = new Map<string, unknown[]>()
  let stopped = false

  // What is stored is what was just read, so nothing is rewritten on the
  // first save. A stored record the state has no part for (a league since
  // retired) is given empty references, so the first save removes it rather
  // than leaving it to take up room forever.
  const current = new Map(partsOf(loaded.state).map((p) => [p.key, p]))
  for (const [key, text] of Object.entries(loaded.stored)) {
    const part = current.get(key)
    sent.set(key, part ? part.refs : [])
    seen.set(key, { mark: fingerprint(text), value: part && merges(key) ? part.value : undefined })
  }

  /** Does whatever a record needs: writes it if this tab changed it, reads it if another tab may have. */
  function run(key: string): void {
    if (stopped || busy.has(key)) return
    const mine = partOf(host.get(), key)
    const stored = sent.get(key)
    const differs = mine ? !sameRefs(stored, mine.refs) : stored !== undefined
    // A write that failed for want of room is not retried until the part
    // changes: the same megabytes would fail the same way on every keystroke.
    const write = differs && !(mine && sameRefs(full.get(key), mine.refs))
    if (!write && !stale.has(key)) return
    // A write answers a pending look as well: a merged record is read in the
    // same transaction, and a slate this tab has just pulled is the newer one.
    stale.delete(key)
    busy.set(key, write ? "write" : "read")
    void (write ? push(key, mine) : pull(key)).then(
      (again) => {
        busy.delete(key)
        // Anything typed, or announced, while that was under way.
        if (again) run(key)
      },
      () => {
        busy.delete(key)
      },
    )
  }

  /**
   * Writes one record, and answers whether to look at it again straight away.
   *
   * A slate goes in whole. The core record and the line history are read in
   * the same transaction, and where another tab has stored them since this
   * one last looked, what is written is that with this tab's changes added.
   */
  async function push(key: string, asked: Part | undefined): Promise<boolean> {
    // The part the write is made from, for the failure report below.
    let from = asked
    try {
      if (!asked) {
        await store.write(key, null)
        if (stopped) return false
        sent.delete(key)
        seen.delete(key)
      } else if (!merges(key)) {
        // Serialised before the transaction opens: a throw inside one would
        // leave it to commit whatever had been queued before the throw.
        const json = JSON.stringify(asked.value)
        await store.write(key, json)
        if (stopped) return false
        sent.set(key, asked.refs)
        seen.set(key, { mark: fingerprint(json) })
      } else {
        let made = null as { part: Part; value: unknown; json: string } | null
        await store.update(key, (text) => {
          // The state as it is now, inside the transaction, rather than as it
          // was when the write was asked for: anything typed in between goes
          // in this write instead of the next.
          const part = partOf(host.get(), key) ?? asked
          from = part
          let value = part.value
          const known = seen.get(key)
          if (fingerprint(text) !== (known?.mark ?? null)) {
            // Another tab has stored this record since this one last looked.
            // What it stored stays, and this tab's own changes go on top. A
            // record that cannot be read has nothing to keep.
            const theirs = text === undefined ? undefined : readPart(key, text)
            if (theirs !== undefined) value = mergeRecord(key, known?.value, part.value, theirs)
          }
          const json = JSON.stringify(value)
          made = { part, value, json }
          return json
        })
        if (stopped || !made) return false
        const { part, value, json } = made
        sent.set(key, refsOf(key, value))
        seen.set(key, { mark: fingerprint(json), value })
        if (value !== part.value) {
          // What is stored now holds another tab's changes as well as this
          // one's, so they belong on this screen too -- underneath anything
          // typed here since the transaction read the state.
          const state = host.get()
          const now = partOf(state, key)
          const next = !now || sameRefs(now.refs, part.refs) ? value : mergeRecord(key, part.value, now.value, value)
          if (!now || !sameRefs(refsOf(key, next), now.refs)) host.set(withPart(state, key, next))
        }
      }
    } catch (err) {
      if (stopped) return false
      const refs = from?.refs ?? []
      const quota = isQuotaError(err)
      // Not stored, and not taken off the screen either: what is on screen
      // stays on screen until a reload. The old rule -- shed from the state
      // until the save fits -- ended, on a slate too big to store, by
      // shedding the pull that had just come in, so a pull that succeeded
      // read as "Nothing pulled yet".
      if (quota) full.set(key, refs)
      const message = `Could not save ${partLabel(key)}: ${err instanceof Error ? err.message : String(err)}`
      host.failures((prev) => ({ ...prev, [key]: { label: partLabel(key), quota, message } }))
      // Any failure but room may be passing, so the next save tries it again.
      // Straight away only if the part has changed since this attempt, or a
      // store that will not take a write would be asked without pause.
      const now = partOf(host.get(), key)
      return now ? !sameRefs(refs, now.refs) : from !== undefined
    }
    full.delete(key)
    host.failures((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    host.tell(key)
    return true
  }

  /**
   * Reads one record another tab may have written and, if it has, puts what
   * it wrote on this tab's screen. Answers whether to look at the record
   * again straight away.
   *
   * The record's references are noted as stored, as the first load notes
   * them, so the save that follows a change of state finds nothing to write.
   * Without that the tab would store what it had just read, the tab that
   * wrote it would read that, and the two would pass it back and forth.
   */
  async function pull(key: string): Promise<boolean> {
    let text: string | undefined
    try {
      text = await store.read(key)
    } catch {
      // Not a save, so there is nothing to report. The record stays marked,
      // and the next look or the next save of it asks again.
      stale.add(key)
      return false
    }
    if (stopped) return false
    const mark = fingerprint(text)
    const known = seen.get(key)
    // Nothing has been written since this tab last looked.
    if (mark === (known?.mark ?? null)) return true

    if (text === undefined) {
      // Gone. The core record and the line history are never removed, so for
      // them to be missing the database itself must have been cleared, and
      // this tab's copy is left exactly as it is: on screen, and stored again
      // only when something here changes.
      if (recordKind(key) !== "slate") return true
      // A slate is removed on purpose in one case, a restore from a file that
      // has none for that league. But it is also missing when everything is,
      // and a slate that cost feed credits is not taken off the screen
      // because the browser emptied the database underneath it.
      try {
        if ((await store.read(CORE)) === undefined) return true
      } catch {
        stale.add(key)
        return false
      }
      if (stopped) return false
    }

    const state = host.get()
    const mine = partOf(state, key)
    // Whether this tab holds something for the record that the database does
    // not: a write that did not fit, one that failed, or one not yet made.
    const local = mine ? !sameRefs(sent.get(key), mine.refs) : sent.has(key)

    if (text === undefined) {
      // Removed in another tab, so it goes from this screen too, unless this
      // tab has a newer slate of its own waiting to be stored.
      seen.delete(key)
      sent.delete(key)
      if (mine && !local) host.set(withPart(state, key, null))
      return true
    }

    const theirs = readPart(key, text)
    if (theirs === undefined) {
      // Unreadable, or for a league this build does not have. There is
      // nothing to show; remembering the text saves reading it again.
      seen.set(key, { mark, value: known?.value })
      return true
    }

    if (mine && merges(key)) {
      // What was stored, with anything this tab has not yet managed to store
      // kept on top of it. With nothing of this tab's outstanding that is
      // simply what was stored, made of this tab's own objects where they
      // already say the same.
      const next = mergeRecord(key, known?.value, mine.value, theirs)
      seen.set(key, { mark, value: local ? theirs : next })
      sent.set(key, local ? [] : refsOf(key, next))
      if (!sameRefs(refsOf(key, next), mine.refs)) host.set(withPart(state, key, next))
      return true
    }

    seen.set(key, { mark })
    if (local) {
      // This tab's own slate stays on screen: it is the newer pull, or one
      // that did not fit and must not be taken off the screen for that.
      sent.set(key, [])
      return true
    }
    sent.set(key, refsOf(key, theirs))
    host.set(withPart(state, key, theirs))
    return true
  }

  return {
    save() {
      if (stopped) return
      for (const part of partsToWrite(sent, host.get())) run(part.key)
    },
    refresh(keys) {
      if (stopped) return
      const all = keys ?? [...new Set([...recordKeys(), ...sent.keys(), ...partsOf(host.get()).map((p) => p.key)])]
      for (const key of all) {
        // A look already under way will do for a general look round. One
        // asked for by name may be for a write made after that look began.
        if (!keys && busy.get(key) === "read") continue
        stale.add(key)
        run(key)
      }
    },
    stop() {
      stopped = true
    },
  }
}

/**
 * The most recently fetched slate, which a full localStorage keeps longest.
 * Not whichever tab is selected: switching tabs while a pull is in flight
 * would otherwise shed the slate the credits were just spent on.
 */
function newestLeague(state: AppState): LeagueId {
  const newest = (Object.keys(state.daily) as LeagueId[]).sort((a, b) =>
    (state.daily[b]?.fetchedAt ?? "").localeCompare(state.daily[a]?.fetchedAt ?? ""),
  )[0]
  return newest ?? state.settings.daily.league
}

function sameFailures(a: Record<string, SaveFailure>, b: Record<string, SaveFailure>): boolean {
  const ka = Object.keys(a)
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => b[k] && b[k].message === a[k].message && b[k].quota === a[k].quota)
  )
}

/**
 * A tab where IndexedDB cannot be opened: the one localStorage blob, shed
 * from the stored copy until it fits.
 *
 * The same three things as on IndexedDB, as far as one blob allows. Before a
 * save the blob is read, and if another tab has stored it since this one last
 * looked, this tab's changes are added to what is there. There are no
 * transactions in localStorage, so another tab could in principle store
 * between that read and the write that follows it in the same instant; the
 * window is a few lines of synchronous code rather than however long a tab
 * has been open. The other tabs hear of a write from the browser itself (see
 * onStored), so `tell` is never used here.
 *
 * The state must already be the one loaded from the blob when this is made.
 */
export function syncBlob(host: TabHost): TabSync {
  /** The blob's text as this tab last read or wrote it. */
  let known = readStored()
  /** The state this tab and the blob last agreed on: the `base` of the next merge. */
  let base = host.get()
  let stopped = false

  /** Puts on this tab's screen whatever another tab has stored since it last looked. */
  function take(): void {
    const text = readStored()
    if (text === known) return
    known = text
    // Cleared, or unreadable: nothing to show, and this tab's copy stays.
    if (text == null) return
    let stored: AppState
    try {
      stored = withShed(base, migrate(JSON.parse(text)))
    } catch {
      return
    }
    const mine = host.get()
    const next = mergeState(base, mine, stored)
    // With nothing of this tab's own outstanding, what is on screen is what
    // is stored and there is nothing to save. Otherwise the two still differ
    // by this tab's changes, which the next save stores.
    base = mine === base ? next : stored
    if (next !== mine) host.set(next)
  }

  return {
    save() {
      if (stopped) return
      take()
      const state = host.get()
      // Just read, or just taken from another tab: storing it again would
      // have the two tabs pass the same blob back and forth.
      if (state === base) return
      const r = saveReduced(state, newestLeague(state))
      const next: Record<string, SaveFailure> = {}
      for (const d of r.dropped) next[d] = { label: d, quota: true, message: "" }
      if (!r.ok) next["*"] = { label: "everything", quota: false, message: r.error ?? "Could not save." }
      host.failures((prev) => (sameFailures(prev, next) ? prev : next))
      if (!r.ok) return
      base = state
      // Read back rather than worked out, because what was stored may be a
      // shed copy. It is this tab's own write that comes back: within one
      // turn a tab sees what it stored, and another tab's write reaches it
      // only afterwards, as the event that leads to `refresh`.
      known = readStored()
    },
    refresh() {
      if (!stopped) take()
    },
    stop() {
      stopped = true
    },
  }
}

/**
 * The name the tabs of this app find each other under. An address, like the
 * database's name in ./idb, and for the same reason not the app's name: two
 * builds that disagree on it cannot hear each other.
 */
const CHANNEL = "wagerwise.records"

/**
 * The record a message from another tab names, or null for anything else.
 *
 * A message is a record's name and nothing more. The content, which includes
 * the feed keys, is only ever read from the database.
 */
export function recordNamed(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const key = (data as { key?: unknown }).key
  return typeof key === "string" && recordKind(key) !== null ? key : null
}

export interface Tabs {
  /** Tells the other tabs a record has been written. */
  tell(key: string): void
  close(): void
}

/**
 * Opens the line to the other tabs, calling `heard` with the name of each
 * record one of them writes. Where the browser has no BroadcastChannel this
 * does nothing, and a tab catches up when it next comes into view.
 */
export function openTabs(heard: (key: string) => void): Tabs {
  const none: Tabs = { tell() {}, close() {} }
  if (typeof BroadcastChannel === "undefined") return none
  let channel: BroadcastChannel
  try {
    channel = new BroadcastChannel(CHANNEL)
  } catch {
    return none
  }
  channel.onmessage = (e: MessageEvent) => {
    const key = recordNamed(e.data)
    if (key !== null) heard(key)
  }
  return {
    tell(key) {
      try {
        channel.postMessage({ key })
      } catch {
        // Closed. The tabs that did not hear catch up when they come into view.
      }
    },
    close() {
      channel.close()
    },
  }
}
