import type { LeagueId } from "@/lib/leagues"
import { isQuotaError } from "./local"
import type { AppState } from "./schema"

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

/** The record holding everything but the slates and the line history. */
const CORE = "core"
const LINES = "lines"
const DAILY = "daily:"

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
  const parts: Part[] = [
    {
      key: CORE,
      value: { version: state.version, settings: state.settings, slate: state.slate, slips: state.slips },
      refs: [state.version, state.settings, state.slate, state.slips],
    },
    { key: LINES, value: state.lines, refs: [state.lines] },
  ]
  for (const [id, daily] of Object.entries(state.daily)) {
    if (daily) parts.push({ key: `${DAILY}${id}`, value: daily, refs: [daily] })
  }
  return parts
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

function sameRefs(a: unknown[] | undefined, b: unknown[]): boolean {
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

/** What a record holds, in words, for a notice that says it could not be kept. */
export function partLabel(key: string): string {
  if (key === CORE) return "your settings and slips"
  if (key === LINES) return "the line history"
  if (key.startsWith(DAILY)) return `the ${(key.slice(DAILY.length) as LeagueId).toUpperCase()} slate`
  return key
}

export interface PartStore {
  /** Every stored record, parsed. */
  readAll(): Promise<Record<string, unknown>>
  /** Stores one record, or removes it when the value is null. */
  write(key: string, value: unknown): Promise<void>
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
   */
  async function run(mode: IDBTransactionMode, body: (store: IDBObjectStore) => void): Promise<void> {
    const used = conn
    try {
      await once(await used, mode, body)
    } catch (e) {
      if (isQuotaError(e)) throw e
      // Only the first failure on a connection replaces it.
      if (conn === used) conn = openDb()
      await once(await conn, mode, body)
    }
  }
  return {
    async readAll() {
      const out: Record<string, unknown> = {}
      await run("readonly", (store) => {
        const req = store.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          // Stored as JSON text, so what comes back is exactly what a
          // JSON round trip gives, as it was in localStorage. A record that
          // will not parse is skipped rather than failing the load.
          try {
            out[String(cursor.key)] = JSON.parse(String(cursor.value))
          } catch {
            // Corrupt records must not take the whole app down.
          }
          cursor.continue()
        }
      })
      return out
    },
    async write(key, value) {
      // Serialised before the transaction opens: a throw inside one would
      // leave it to commit whatever had been queued before the throw.
      const json = value == null ? null : JSON.stringify(value)
      await run("readwrite", (store) => {
        if (json == null) store.delete(key)
        else store.put(json, key)
      })
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
