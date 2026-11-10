import { LEAGUE_IDS, type LeagueId } from "@/lib/leagues"
import { isQuotaError } from "./local"
import { migrate, type AppState, type DailyCache, type LineSnapshot } from "./schema"

/**
 * Persistence in IndexedDB, one record per part of the state.
 *
 * localStorage was the wrong place for this app's data, and a real NBA pull
 * proved it: the whole PropLine board is eleven-plus markets across every game
 * at every book, verbatim, and that does not fit in localStorage's ~5MiB on
 * an iPhone even with nothing beside it. The save failed, the shedding ran out
 * of other things to drop, and the last thing it dropped was the pull itself —
 * from the screen as well as from storage, so a pull that succeeded read as
 * "Nothing pulled yet". IndexedDB is metered against the device's disk rather
 * than a fixed 5MiB, so a full slate fits with room to spare.
 *
 * Split into parts because the parts change at very different rates. Settings
 * change on every keystroke in a form; a slate changes once a pull. Written as
 * one blob, every keystroke re-serialised megabytes of quotes. Written as
 * parts, only what changed is written, and a part too big to store fails on
 * its own instead of taking the settings and slips down with it.
 *
 * A record is also the unit two open tabs share. Each tab holds its own copy
 * of the state in memory, so a record written whole from one tab's copy puts
 * back everything in it that the other tab has changed since. `read` and
 * `update` are what stop that: a tab can look at one record again when another
 * tab says it wrote it, and can add its own changes to what is stored in the
 * same transaction that reads it. See ./sync for how they are used.
 */

/**
 * The database's name, which is NOT the app's name and must not follow it.
 *
 * The app was called WagerWise when this was written and is BlessedBets now.
 * This string is the address every install's settings, slips, tracker history
 * and line history are stored under, so changing it opens a fresh, empty
 * database on the next load and the data is stranded in the old one. Settled
 * history is the only evidence in this app that can show the model is wrong,
 * and losing it to a rename would be the worst trade available. A migration
 * could copy it across, but would have to keep this string anyway to find the
 * old data, so it would add risk to every load without removing the name.
 */
const DB_NAME = "wagerwise"
const DB_VERSION = 1
const STORE = "state"

/**
 * The record holding everything but the slates and the line history. It is
 * the first thing ever stored and is never removed, so a database without it
 * holds nothing: one that has not been seeded yet, or one that was cleared.
 */
export const CORE = "core"
const LINES = "lines"
const DAILY = "daily:"

/** What the core record holds. */
export type CoreRecord = Pick<AppState, "version" | "settings" | "slate" | "slips">

/**
 * Which kind of record a key names, or null for a key this build does not
 * write. The kinds differ in what two tabs' changes to one come to: see
 * mergeRecord in ./merge.
 */
export function recordKind(key: string): "core" | "lines" | "slate" | null {
  if (key === CORE) return "core"
  if (key === LINES) return "lines"
  return key.startsWith(DAILY) ? "slate" : null
}

/** Every record this build can hold, whether or not it is stored yet. */
export function recordKeys(): string[] {
  return [CORE, LINES, ...LEAGUE_IDS.map((id) => `${DAILY}${id}`)]
}

export interface Part {
  key: string
  /** What is stored. Null removes the record. */
  value: unknown
  /**
   * The references this part was made from, compared to tell whether it
   * changed. State is updated immutably, so a part whose references are all
   * unchanged has nothing new to write.
   */
  refs: unknown[]
}

/** The state as the records it is stored in. */
export function partsOf(state: AppState): Part[] {
  const core: CoreRecord = { version: state.version, settings: state.settings, slate: state.slate, slips: state.slips }
  const parts: Part[] = [
    { key: CORE, value: core, refs: refsOf(CORE, core) },
    { key: LINES, value: state.lines, refs: refsOf(LINES, state.lines) },
  ]
  for (const [id, daily] of Object.entries(state.daily)) {
    if (daily) parts.push({ key: `${DAILY}${id}`, value: daily, refs: refsOf(`${DAILY}${id}`, daily) })
  }
  return parts
}

/**
 * The references a record's value is made of. The core record is a wrapper
 * built afresh each time it is asked for, so it is compared by what it wraps;
 * every other record is one value and is its own reference.
 */
export function refsOf(key: string, value: unknown): unknown[] {
  if (key !== CORE) return [value]
  const core = value as CoreRecord
  return [core.version, core.settings, core.slate, core.slips]
}

/** One record of the state, or undefined where the state has nothing for it. */
export function partOf(state: AppState, key: string): Part | undefined {
  return partsOf(state).find((p) => p.key === key)
}

/**
 * The state with one record's content put in place of its own, and the rest
 * of it untouched: the same objects, so nothing that reads them recomputes.
 *
 * Null takes a slate out. The core record and the line history are never
 * absent from a state, so null leaves the first alone and empties the second.
 */
export function withPart(state: AppState, key: string, value: unknown): AppState {
  if (key === CORE) {
    if (!value) return state
    const core = value as CoreRecord
    return { ...state, version: core.version, settings: core.settings, slate: core.slate, slips: core.slips }
  }
  if (key === LINES) return { ...state, lines: (value as LineSnapshot[] | null) ?? [] }
  if (!key.startsWith(DAILY)) return state
  const daily = { ...state.daily }
  const id = key.slice(DAILY.length) as LeagueId
  if (value) daily[id] = value as DailyCache
  else delete daily[id]
  return { ...state, daily }
}

/**
 * What has to be written to bring storage from `sent` to `state`.
 *
 * `sent` maps each record to the references it was last written from. A part
 * missing from it, or made from different references, is written; a record in
 * it that the state no longer has is removed.
 */
export function partsToWrite(sent: ReadonlyMap<string, unknown[]>, state: AppState): Part[] {
  const parts = partsOf(state)
  const present = new Set(parts.map((p) => p.key))
  const writes = parts.filter((p) => !sameRefs(sent.get(p.key), p.refs))
  for (const key of sent.keys()) {
    if (!present.has(key)) writes.push({ key, value: null, refs: [] })
  }
  return writes
}

/** Whether a record is still made of the references it was last stored from. */
export function sameRefs(a: unknown[] | undefined, b: unknown[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x === b[i])
}

/** The stored records put back together, in the shape `migrate` reads. */
export function joinParts(records: Record<string, unknown>): unknown {
  const core = records[CORE]
  if (!core || typeof core !== "object") return null
  const daily: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(records)) {
    if (key.startsWith(DAILY) && value) daily[key.slice(DAILY.length)] = value
  }
  return { ...(core as object), lines: records[LINES], daily }
}

/**
 * The stored texts as the records they hold.
 *
 * Stored as JSON text, so what comes back is exactly what a JSON round trip
 * gives, as it was in localStorage. A record that will not parse is skipped
 * rather than failing the load: corrupt records must not take the whole app
 * down.
 */
export function parseRecords(texts: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, text] of Object.entries(texts)) {
    try {
      out[key] = JSON.parse(text)
    } catch {
      // Skipped, as above.
    }
  }
  return out
}

/**
 * One stored record as the state holds it, or undefined when it cannot be
 * read or belongs to nothing this build knows.
 *
 * Through `joinParts` and `migrate`, exactly as a load reads it, so a record
 * picked up from another tab is the same in memory as it would be after a
 * reload. The other records are stood in for by an empty core, which only has
 * to be there for the join to go ahead.
 */
export function readPart(key: string, text: string): unknown {
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return undefined
  }
  const raw = joinParts({ [CORE]: {}, [key]: record })
  return raw ? partOf(migrate(raw), key)?.value : undefined
}

/**
 * A record's text, reduced to a few characters that change when it does, or
 * null for no record.
 *
 * This is how a tab tells that another tab has written a record since it last
 * looked: the text stored now does not have the fingerprint of the text it
 * knew. Kept instead of the text because a slate is megabytes and there is
 * one per league. Kept instead of a counter beside the record because a
 * counter is only as good as every writer remembering to move it, and a tab
 * still running an older build of this app never will.
 *
 * Two mixes and the length, so a different text passing for the same one
 * takes a simultaneous collision in both.
 */
export function fingerprint(text: string | undefined): string | null {
  if (text === undefined) return null
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b + c, 0x85ebca6b)
    b ^= b >>> 13
  }
  return `${text.length}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`
}

/** What a record holds, in words, for a notice that says it could not be kept. */
export function partLabel(key: string): string {
  if (key === CORE) return "your settings and slips"
  if (key === LINES) return "the line history"
  if (key.startsWith(DAILY)) return `the ${(key.slice(DAILY.length) as LeagueId).toUpperCase()} slate`
  return key
}

export interface PartStore {
  /** Every stored record, as the JSON text it is stored as. See parseRecords. */
  readAll(): Promise<Record<string, string>>
  /** One stored record's text, or undefined where there is none. */
  read(key: string): Promise<string | undefined>
  /** Stores one record's text, or removes the record when it is null. */
  write(key: string, json: string | null): Promise<void>
  /**
   * Reads one record and stores what `next` makes of it, in one transaction.
   *
   * One transaction because that is the only thing that makes "add my changes
   * to what is stored" true: read in one and written in another, a second tab
   * could write between the two and have its change put back. The browser
   * runs the writing transactions on a store one after another, across every
   * tab, so nothing can land between this read and this write.
   *
   * `next` is given the stored text, or undefined where there is none, and
   * answers with the text to store, null to remove the record, or undefined to
   * leave it as it is. It runs inside the transaction and may run twice (see
   * `run`), so it must work the answer out afresh each time and do nothing
   * else. If it throws, nothing is written and the call rejects with what it
   * threw.
   */
  update(key: string, next: (stored: string | undefined) => string | null | undefined): Promise<void>
  /**
   * Stores these parts only if nothing is stored yet, in one transaction, and
   * says whether it did. One transaction because two tabs opening at once
   * would otherwise both find the database empty, and the slower one could
   * write a state read after the faster one had moved the old data out.
   */
  seed(parts: Part[]): Promise<boolean>
}

/**
 * How long opening the database may take before this visit gives up on it.
 * Some Safari releases never answered an open on a page's first load, and an
 * app stuck on "Loading…" is far worse than one on the old storage for a visit.
 */
const OPEN_TIMEOUT_MS = 4000

/**
 * Opens the app's database, or rejects where IndexedDB cannot be used: a
 * browser without it, one that refuses it, or one that does not answer.
 */
export async function openPartStore(): Promise<PartStore> {
  return partStore(await openDb())
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available."))
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(e)
      return
    }
    let gaveUp = false
    const timer = setTimeout(() => {
      gaveUp = true
      reject(new Error("IndexedDB did not open."))
    }, OPEN_TIMEOUT_MS)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      clearTimeout(timer)
      const db = req.result
      if (gaveUp) {
        db.close()
        return
      }
      // A newer version opening in another tab waits until every older
      // connection closes. Closing this one lets it in, and the next request
      // here reconnects (see partStore).
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => {
      clearTimeout(timer)
      reject(req.error ?? new Error("Could not open IndexedDB."))
    }
  })
}

function partStore(first: IDBDatabase): PartStore {
  let conn: Promise<IDBDatabase> = Promise.resolve(first)

  /** One transaction, resolved when it commits and rejected with its error when it does not. */
  function once(db: IDBDatabase, mode: IDBTransactionMode, body: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error("The write was aborted."))
      body(tx.objectStore(STORE))
    })
  }

  /**
   * One transaction, tried once more on a fresh connection when it fails for
   * any reason but room. iOS drops the connection of a home-screen app left
   * in the background ("Connection to Indexed Database server lost"), and
   * every request on a dropped connection fails from then on, so without
   * this a phone would stop saving until the app was killed. Every body here
   * is safe to run twice: a failed transaction committed nothing.
   *
   * `again` is asked before the second try, for a body that can tell a
   * failure of its own making from one of the connection's.
   */
  async function run(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => void,
    again: () => boolean = () => true,
  ): Promise<void> {
    const used = conn
    try {
      await once(await used, mode, body)
    } catch (e) {
      if (isQuotaError(e) || !again()) throw e
      // Only the first failure on a connection replaces it.
      if (conn === used) conn = openDb()
      await once(await conn, mode, body)
    }
  }
  return {
    async readAll() {
      let out: Record<string, string> = {}
      await run("readonly", (store) => {
        out = {}
        const req = store.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          out[String(cursor.key)] = String(cursor.value)
          cursor.continue()
        }
      })
      return out
    },
    async read(key) {
      let out: string | undefined
      await run("readonly", (store) => {
        out = undefined
        const req = store.get(key)
        req.onsuccess = () => {
          out = req.result === undefined ? undefined : String(req.result)
        }
      })
      return out
    },
    async write(key, json) {
      // Already text when it gets here: serialising inside the transaction
      // could throw part-way, and a throw inside one would leave it to commit
      // whatever had been queued before the throw.
      await run("readwrite", (store) => {
        if (json == null) store.delete(key)
        else store.put(json, key)
      })
    },
    async update(key, next) {
      // What `next` threw, if it did. It has to run inside the transaction,
      // after the read, so the rule `write` keeps by taking text is kept here
      // by hand: a throw aborts the transaction before anything is queued,
      // and is not mistaken for a dropped connection and tried again.
      const thrown: unknown[] = []
      try {
        await run(
          "readwrite",
          (store) => {
            thrown.length = 0
            const req = store.get(key)
            req.onsuccess = () => {
              try {
                const json = next(req.result === undefined ? undefined : String(req.result))
                if (json === null) store.delete(key)
                else if (json !== undefined) store.put(json, key)
              } catch (error) {
                thrown.push(error)
                store.transaction.abort()
              }
            }
          },
          () => thrown.length === 0,
        )
      } catch (e) {
        throw thrown.length > 0 ? thrown[0] : e
      }
    },
    async seed(parts) {
      const rows = parts.map((p) => [p.key, JSON.stringify(p.value)] as const)
      let wrote = false
      await run("readwrite", (store) => {
        const req = store.get(CORE)
        req.onsuccess = () => {
          if (req.result !== undefined) return
          for (const [key, json] of rows) store.put(json, key)
          wrote = true
        }
      })
      return wrote
    },
  }
}
