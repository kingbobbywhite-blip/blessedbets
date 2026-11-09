import type { LeagueId } from "@/lib/leagues"
import { EMPTY_STATE, migrate, type AppState } from "./schema"

/**
 * Persistence.
 *
 * Everything lives in the browser. That is a deliberate trade: the app runs with
 * zero configuration, no account and no database, and your betting history never
 * leaves your machine. The cost is that clearing site data wipes it, so the
 * settings page offers a one-click JSON export and import.
 *
 * IndexedDB is where it lives now (see idb.ts). What is here is the old home:
 * one localStorage blob, read once to move an existing install across, and
 * written to only where IndexedDB cannot be opened at all.
 */

/**
 * The storage key: an address, not the app's name. Kept through the rename to
 * BlessedBets for the same reason as DB_NAME in ./idb -- changing it strands
 * every install's data under the old key.
 */
const KEY = "wagerwise.state.v1"

export function loadState(): AppState {
  if (typeof window === "undefined") return EMPTY_STATE
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return EMPTY_STATE
    return migrate(JSON.parse(raw))
  } catch {
    // Corrupt or unreadable storage must not take the whole app down.
    return EMPTY_STATE
  }
}

/**
 * True when a storage failure was for want of room.
 *
 * Browsers disagree about the name and the message. Safari throws
 * QuotaExceededError, Firefox NS_ERROR_DOM_QUOTA_REACHED, and the legacy code
 * 22 is still what some report.
 */
export function isQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  const name = e instanceof Error ? e.name : ""
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code?: number }).code : undefined
  return /quota|NS_ERROR_DOM_QUOTA_REACHED/i.test(`${name} ${msg}`) || code === 22 || name === "QuotaExceededError"
}

/** Removes the old blob once IndexedDB holds everything it did, freeing its share of the quota. */
export function clearLegacyState(): void {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // Nothing depends on it going: IndexedDB is read first from now on.
  }
}

export interface SaveResult {
  ok: boolean
  error?: string
  /**
   * True only when the write failed for want of room.
   *
   * The distinction decides whether anything may be thrown away. Shedding data
   * is the right answer to a full quota and the wrong answer to every other
   * failure: storage disabled in a private window, or a value that would not
   * serialise, would otherwise have the app delete slate after slate in a loop
   * trying to fix a problem that was never about size.
   */
  quota?: boolean
}

export function saveState(state: AppState): SaveResult {
  if (typeof window === "undefined") return { ok: false, error: "No browser storage available." }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state))
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const quota = isQuotaError(e)
    return {
      ok: false,
      quota,
      error: quota ? "Browser storage is full. Export your data, then clear old slates." : `Could not save: ${msg}`,
    }
  }
}

/**
 * Progressively smaller versions of the state, for when storage is full.
 *
 * This is not hypothetical. One 14-game NFL pull at eight books is roughly
 * 1,100 props x 8 quotes x ~320 bytes, which is 2.8MB of JSON; browsers meter
 * localStorage in UTF-16 code units, so that is over 5MiB of a ~5MiB quota
 * before an NBA or NFL cache sits beside it. A pull can therefore fail to save
 * at all, and until now it failed silently on the one screen that causes it:
 * the slate lived in React state, looked fine, and vanished on reload along
 * with the feed credits that bought it.
 *
 * So a failed save sheds load rather than giving up, oldest and cheapest
 * first, and says what it dropped. The order is deliberate: line history is
 * research and can be thinned, another league's slate is yesterday's problem,
 * and the pull you just paid for is the last thing to go. Slips are never
 * dropped — they are the only record of what the model got right.
 *
 * What is shed is shed from the STORED copy only. It used to be shed from the
 * state on screen as well, and on a slate too big to store on its own the
 * last step dropped the pull that had just come in: the pull succeeded, its
 * warnings showed, and the screen said "Nothing pulled yet". Only used now
 * where IndexedDB cannot be opened; see saveReduced.
 */
export function reduceForQuota(
  state: AppState,
  keep?: LeagueId | null,
): { state: AppState; dropped: string } | null {
  // 1. Thin the line history to the newest few pulls.
  if (state.lines.length > 2) {
    return {
      state: { ...state, lines: state.lines.slice(0, 2) },
      dropped: `${state.lines.length - 2} older line snapshots`,
    }
  }
  // 2. Drop other leagues' slates, newest kept.
  const others = (Object.keys(state.daily) as LeagueId[]).filter((id) => id !== keep)
  if (others.length > 0) {
    const oldest = others.sort((a, b) =>
      (state.daily[a]?.fetchedAt ?? "").localeCompare(state.daily[b]?.fetchedAt ?? ""),
    )[0]
    const daily = { ...state.daily }
    delete daily[oldest]
    return { state: { ...state, daily }, dropped: `the ${oldest.toUpperCase()} slate` }
  }
  // 3. The line history entirely.
  if (state.lines.length > 0) {
    return { state: { ...state, lines: [] }, dropped: "the line history" }
  }
  // 4. The imported board, which can be captured again.
  if (state.slate) {
    return { state: { ...state, slate: null }, dropped: "the imported board" }
  }
  // 5. The last slate standing. Beyond this there is nothing safe to shed:
  // slips are the only record of what the model predicted.
  if (Object.keys(state.daily).length > 0) {
    return { state: { ...state, daily: {} }, dropped: "every cached slate" }
  }
  return null
}

export function exportState(state: AppState): string {
  return JSON.stringify(state, null, 2)
}

export function importState(json: string): AppState {
  return migrate(JSON.parse(json))
}

/**
 * Saves as much of the state as fits, shedding from the stored copy in
 * reduceForQuota's order, and says what had to be left out.
 *
 * The state passed in is never changed: whatever is shed stays on screen
 * until a reload, which is what the notice that reports it says.
 */
export function saveReduced(
  state: AppState,
  keep?: LeagueId | null,
): { ok: boolean; dropped: string[]; error?: string } {
  const dropped: string[] = []
  let copy = state
  for (;;) {
    const r = saveState(copy)
    if (r.ok) return { ok: true, dropped }
    // Shedding is only an answer to a full quota; see SaveResult.quota.
    const reduced = r.quota ? reduceForQuota(copy, keep) : null
    if (!reduced) return { ok: false, dropped, error: r.error }
    dropped.push(reduced.dropped)
    copy = reduced.state
  }
}
