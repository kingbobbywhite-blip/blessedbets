import { partOf, partsOf, recordKind, sameRefs, withPart, type CoreRecord } from "./idb"
import { MAX_LINE_SNAPSHOTS, type AppState, type LineSnapshot, type TrackedSlip } from "./schema"

/**
 * What two tabs' changes to one record come to.
 *
 * Every open tab holds its own copy of the state. A tab used to write a record
 * whole from that copy, so a tab that had been open a while put back, along
 * with the one thing it had changed, everything else in the record as it
 * stood when the tab loaded. The report behind this file: an Odds API key
 * pasted into Settings in one tab was gone, or was an older key again, the
 * moment a Today screen left open in another tab switched league, and the
 * next pull failed with "The Odds API rejected the API key" for a key that
 * was right.
 *
 * The rule here makes that impossible rather than unlikely: a write carries
 * only what the tab making it changed. Three versions of a record go in --
 * `base`, the record as this tab last knew it to be stored; `mine`, this
 * tab's copy now; `theirs`, what is stored now -- and what comes out is
 * `theirs` with the difference between `base` and `mine` applied. What this
 * tab did not touch is taken as stored, whoever stored it. What it did touch
 * stands, and where both touched the same thing the tab doing the writing
 * wins, being the later of the two to act.
 *
 * How small "the same thing" is depends on the record. A setting is one
 * field, however deep it sits, and a list inside the settings is one field. A
 * logged entry is one thing, whole: its status and its payout are worked out
 * from its legs, so taking the legs from one tab and the status from another
 * would store an entry neither tab ever showed. A slate is one pull, whole.
 *
 * Everything here hands back this tab's own objects wherever they already say
 * what the result says. State is compared by reference all over the app -- a
 * memo that prices several hundred props reruns when `settings.projection` is
 * a new object -- so taking a record from another tab as a tree of fresh
 * objects would recompute every screen each time a character was typed in a
 * different tab.
 */

type Fields = Record<string, unknown>

/** A plain object: something with fields to merge one at a time. */
function isFields(v: unknown): v is Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Whether two values are the same once stored.
 *
 * As JSON would have it, so a key holding undefined is a key left out: a
 * record read back from storage has lost those, and must still compare equal
 * to the copy in memory that it was written from.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b || (a !== a && b !== b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  }
  const x = a as Fields
  const y = b as Fields
  for (const k of Object.keys(x)) if (!sameValue(x[k], y[k])) return false
  for (const k of Object.keys(y)) if (x[k] === undefined && y[k] !== undefined) return false
  return true
}

/** `theirs`, made of `mine`'s own objects wherever the two say the same. */
export function reuse<T>(mine: unknown, theirs: T): T {
  if (mine === theirs || typeof mine !== "object" || typeof theirs !== "object" || mine === null || theirs === null) {
    return theirs
  }
  if (Array.isArray(theirs)) {
    if (!Array.isArray(mine)) return theirs
    let same = mine.length === theirs.length
    const out = theirs.map((t, i) => {
      const v = reuse(mine[i], t)
      if (v !== mine[i]) same = false
      return v
    })
    return (same ? mine : out) as T
  }
  if (Array.isArray(mine)) return theirs
  const m = mine as Fields
  const t = theirs as Fields
  let same = true
  const out: Fields = {}
  for (const k of Object.keys(t)) {
    // Assigning this key would set the object's prototype rather than a field.
    if (k === "__proto__" || t[k] === undefined) continue
    out[k] = reuse(m[k], t[k])
    if (out[k] !== m[k]) same = false
  }
  for (const k of Object.keys(m)) if (m[k] !== undefined && t[k] === undefined) same = false
  return (same ? mine : out) as T
}

/** A value that is one thing: this tab's if this tab changed it, the stored one if not. */
export function mergeWhole<T>(base: unknown, mine: T, theirs: T): T {
  const untouched = mine === base || (mine == null && base == null) || sameValue(mine, base)
  return untouched ? reuse(mine, theirs) : mine
}

/**
 * Field by field, as deep as the fields go.
 *
 * A field this tab changed keeps this tab's value, and so does one it added
 * or removed. Every other field is as stored. Anything that is not a plain
 * object is a single field: a number, a string, a list.
 */
export function mergeFields(base: unknown, mine: unknown, theirs: unknown): unknown {
  // The same object it was when last stored: nothing of this tab's to keep.
  if (mine === base) return reuse(mine, theirs)
  if (!isFields(mine) || !isFields(theirs)) return mergeWhole(base, mine, theirs)
  const was = isFields(base) ? base : {}
  let same = true
  const out: Fields = {}
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    if (k === "__proto__") continue
    const v = mergeFields(was[k], mine[k], theirs[k])
    if (v !== undefined) out[k] = v
    if (v !== mine[k]) same = false
  }
  return same ? mine : out
}

/** A list by its entries' ids, or null where two entries share one. */
function byId<T>(list: readonly T[], id: (entry: T) => string): Map<string, T> | null {
  const out = new Map<string, T>()
  for (const entry of list) {
    const k = id(entry)
    if (out.has(k)) return null
    out.set(k, entry)
  }
  return out
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * Entry by entry, for a list whose entries have ids.
 *
 * An entry this tab added, changed or removed is as this tab has it; every
 * other entry is as stored, including the ones another tab added, which go in
 * front because that is where an add puts them. With nothing of this tab's to
 * keep, the answer is the stored list in the stored order.
 *
 * This is what keeps an entry logged in one tab when an entry is logged in
 * another: as one field, the later list would simply replace the earlier.
 */
export function mergeEntries<T>(base: T[] | undefined, mine: T[], theirs: T[], id: (entry: T) => string): T[] {
  const was = byId(base ?? [], id)
  const now = byId(mine, id)
  const stored = byId(theirs, id)
  // Entries that cannot be told apart cannot be merged one at a time.
  if (!was || !now || !stored) return mergeWhole(base, mine, theirs)
  let out: T[]
  if (mine === base) {
    out = theirs.map((t) => reuse(now.get(id(t)), t))
  } else {
    out = theirs.filter((t) => !was.has(id(t)) && !now.has(id(t)))
    for (const m of mine) {
      const k = id(m)
      const b = was.get(k)
      if (!was.has(k) || (m !== b && !sameValue(m, b))) out.push(m)
      else if (stored.has(k)) out.push(reuse(m, stored.get(k) as T))
    }
  }
  return sameList(out, mine) ? mine : out
}

const slipId = (slip: TrackedSlip): string => String((slip as { id?: unknown } | null)?.id)

/** A pull's lines are one pull's: the moment and the league say which. */
const snapshotId = (snap: LineSnapshot): string => `${snap?.pulledAt}|${snap?.league}`

/** Settings field by field, logged entries one by one, the imported board whole. */
function mergeCore(base: CoreRecord | undefined, mine: CoreRecord, theirs: CoreRecord): CoreRecord {
  const settings = mergeFields(base?.settings, mine.settings, theirs.settings) as CoreRecord["settings"]
  const slate = mergeWhole(base?.slate, mine.slate, theirs.slate)
  const slips = mergeEntries(base?.slips, mine.slips, theirs.slips, slipId)
  if (settings === mine.settings && slate === mine.slate && slips === mine.slips) return mine
  return { version: mine.version, settings, slate, slips }
}

/**
 * Pull by pull, then newest first and capped, which is the order and the cap
 * a load applies (see migrateLines). Two tabs that each keep a pull would
 * otherwise store nine and have the load quietly drop one.
 */
function mergeLines(base: LineSnapshot[] | undefined, mine: LineSnapshot[], theirs: LineSnapshot[]): LineSnapshot[] {
  const merged = mergeEntries(base, mine, theirs, snapshotId)
  const kept = [...merged]
    .sort((a, b) => String(b.pulledAt).localeCompare(String(a.pulledAt)))
    .slice(0, MAX_LINE_SNAPSHOTS)
  if (sameList(kept, mine)) return mine
  return sameList(kept, merged) ? merged : kept
}

/**
 * One record: `theirs`, with what this tab changed between `base` and `mine`
 * kept. `base` is undefined where this tab never knew the record stored, and
 * then everything this tab holds counts as its own.
 */
export function mergeRecord(key: string, base: unknown, mine: unknown, theirs: unknown): unknown {
  switch (recordKind(key)) {
    case "core":
      return mergeCore(base as CoreRecord | undefined, mine as CoreRecord, theirs as CoreRecord)
    case "lines":
      return mergeLines(base as LineSnapshot[] | undefined, mine as LineSnapshot[], theirs as LineSnapshot[])
    default:
      return mergeWhole(base, mine, theirs)
  }
}

/**
 * A whole state, record by record: `theirs`, with what this tab changed
 * between `base` and `mine` kept. A slate added on either side is there. One
 * this tab removed stays removed, and one removed in the other tab goes here
 * too unless this tab has changed it since.
 *
 * Only for where the state is stored as one piece (see ./local). In
 * IndexedDB each record is merged on its own, as it is written.
 */
export function mergeState(base: AppState, mine: AppState, theirs: AppState): AppState {
  let out = mine
  const keys = new Set([...partsOf(base), ...partsOf(mine), ...partsOf(theirs)].map((p) => p.key))
  for (const key of keys) {
    const b = partOf(base, key)
    const m = partOf(mine, key)
    const t = partOf(theirs, key)
    if (m && t) {
      const value = mergeRecord(key, b?.value, m.value, t.value)
      if (value !== m.value) out = withPart(out, key, value)
    } else if (t) {
      // Stored and not here: added there, unless this tab is the one that removed it.
      if (!b) out = withPart(out, key, t.value)
    } else if (m && b && sameRefs(m.refs, b.refs)) {
      // Here, untouched, and no longer stored: removed there.
      out = withPart(out, key, null)
    }
  }
  return out
}

/**
 * What the one-piece copy would hold if nothing had been shed from it.
 *
 * A save that does not fit in localStorage sheds from the stored copy -- line
 * history, other leagues' slates, the imported board -- and leaves the state
 * on screen alone (see reduceForQuota). Read back in another tab, a shed
 * slate is indistinguishable from a removed one, and taking it as removed
 * would take it off that tab's screen: the exact thing shedding from the
 * stored copy exists not to do. So whatever the stored copy lacks is filled
 * from what this tab last knew to be there, and nothing is ever removed
 * because the copy is missing it.
 *
 * The cost is that a real removal in another tab is not picked up either.
 * That is one case, a restore from a file that has no slate for a league, and
 * the stale slate goes at the next reload.
 */
export function withShed(base: AppState, stored: AppState): AppState {
  const have = new Set(stored.lines.map(snapshotId))
  const shed = base.lines.filter((snap) => !have.has(snapshotId(snap)))
  return {
    ...stored,
    slate: stored.slate ?? base.slate,
    daily: { ...base.daily, ...stored.daily },
    lines: shed.length > 0 ? [...stored.lines, ...shed] : stored.lines,
  }
}
