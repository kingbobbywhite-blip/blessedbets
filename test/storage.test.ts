import { afterEach, describe, expect, it, vi } from "vitest"
import {
  fingerprint,
  joinParts,
  parseRecords,
  partLabel,
  partOf,
  partsOf,
  partsToWrite,
  readPart,
  withPart,
  type CoreRecord,
  type PartStore,
} from "@/lib/store/idb"
import { loadState, onStored, saveReduced } from "@/lib/store/local"
import { mergeRecord, mergeState, sameValue, withShed } from "@/lib/store/merge"
import { openTabs, recordNamed, syncBlob, syncParts, type SaveFailure, type TabSync } from "@/lib/store/sync"
import {
  EMPTY_STATE,
  MAX_LINE_SNAPSHOTS,
  migrate,
  type AppState,
  type DailyCache,
  type LineSnapshot,
  type TrackedSlip,
} from "@/lib/store/schema"

/**
 * Where the state is kept, and what happens when it does not fit.
 *
 * The report behind this file: a PropLine NBA pull succeeded, its warnings
 * showed, and the screen said "Nothing pulled yet". The whole board did not
 * fit in localStorage on an iPhone, and the shedding meant to make room ran
 * out of other things to drop and dropped the pull itself — from the screen,
 * not just from storage.
 */

const slate = (league: "nba" | "nfl", fetchedAt: string): DailyCache => ({
  league,
  fetchedAt,
  quotes: [],
  events: [],
  requestsRemaining: null,
  creditsSpent: 0,
})

const STATE: AppState = {
  ...EMPTY_STATE,
  slips: [{ id: "s1" }] as never,
  daily: { nba: slate("nba", "2026-10-25T20:00:00Z"), nfl: slate("nfl", "2026-10-24T20:00:00Z") },
  lines: [{ pulledAt: "2026-10-25T20:00:00Z", league: "nba", rows: [] }],
}

describe("the state as stored parts", () => {
  it("writes a slate apart from the settings, so a keystroke does not rewrite megabytes", () => {
    // Everything as one blob meant every character typed into a form
    // re-serialised every quote of every cached slate.
    const sent = new Map(partsOf(STATE).map((p) => [p.key, p.refs]))
    const typed = { ...STATE, settings: { ...STATE.settings, defaultAppId: "underdog" } }
    expect(partsToWrite(sent, typed).map((p) => p.key)).toEqual(["core"])

    const pulled = { ...STATE, daily: { ...STATE.daily, nba: slate("nba", "2026-10-25T21:00:00Z") } }
    expect(partsToWrite(sent, pulled).map((p) => p.key)).toEqual(["daily:nba"])

    // Nothing changed, nothing written.
    expect(partsToWrite(sent, STATE)).toEqual([])
  })

  it("removes a slate the state no longer has", () => {
    const sent = new Map(partsOf(STATE).map((p) => [p.key, p.refs]))
    const writes = partsToWrite(sent, { ...STATE, daily: { nba: STATE.daily.nba } })
    expect(writes).toEqual([{ key: "daily:nfl", value: null, refs: [] }])
  })

  it("reads back as the state it was written from", () => {
    // Through JSON, as IndexedDB stores it, and through migrate, as a load does.
    const records = Object.fromEntries(partsOf(STATE).map((p) => [p.key, JSON.parse(JSON.stringify(p.value))]))
    const back = migrate(joinParts(records))
    expect(back.daily.nba?.fetchedAt).toBe(STATE.daily.nba?.fetchedAt)
    expect(back.daily.nfl?.fetchedAt).toBe(STATE.daily.nfl?.fetchedAt)
    expect(back.slips).toEqual(STATE.slips)
    expect(back.lines).toHaveLength(1)
    expect(back.settings.defaultAppId).toBe(STATE.settings.defaultAppId)
  })

  it("reads nothing stored as nothing, so the old blob is moved across", () => {
    // No core record means the database has not been seeded: the load falls
    // through to localStorage instead of starting from an empty state.
    expect(joinParts({})).toBeNull()
    expect(joinParts({ "daily:nba": slate("nba", "x") })).toBeNull()
  })

  it("names each part in words for the notice", () => {
    expect(partLabel("daily:nba")).toBe("the NBA slate")
    expect(partLabel("lines")).toBe("the line history")
    expect(partLabel("core")).toContain("slips")
  })
})

describe("a localStorage save that does not fit", () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A localStorage that holds at most `room` characters. */
  function stubStorage(room: number) {
    const store: Record<string, string> = {}
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          if (v.length > room) {
            const err = new Error("The quota has been exceeded.")
            err.name = "QuotaExceededError"
            throw err
          }
          store[k] = v
        },
      },
    })
    return store
  }

  it("never takes the pull off the screen, even when nothing else is left to shed", () => {
    // The exact failure: a slate too big to store on its own. The old rule
    // shed from the state itself until a save fit, and its last step was
    // "every cached slate" — the pull that had just come in.
    const big: AppState = {
      ...EMPTY_STATE,
      daily: { nba: { ...slate("nba", "2026-10-25T20:00:00Z"), quotes: Array(5000).fill({ book: "x" }) as never } },
    }
    const room = JSON.stringify({ ...big, daily: {} }).length + 10
    const store = stubStorage(room)
    const before = JSON.stringify(big)

    const r = saveReduced(big, "nba")
    // What was stored had the slate shed, and says so...
    expect(r.ok).toBe(true)
    expect(r.dropped).toEqual(["every cached slate"])
    expect(JSON.parse(Object.values(store)[0]).daily).toEqual({})
    // ...and the state on screen still has it, untouched.
    expect(JSON.stringify(big)).toBe(before)
    expect(big.daily.nba?.quotes).toHaveLength(5000)
  })

  it("sheds nothing when it fits", () => {
    stubStorage(10_000_000)
    expect(saveReduced(STATE, "nba")).toEqual({ ok: true, dropped: [] })
  })

  it("sheds nothing for a failure that is not about room", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("Access is denied for this document.")
        },
      },
    })
    const r = saveReduced(STATE, "nba")
    expect(r.ok).toBe(false)
    expect(r.dropped).toEqual([])
    expect(r.error).toContain("Could not save")
  })
})

describe("the game cap across a feed change", () => {
  // An install that predates the per-request cap stored 14, the credit
  // default. On PropLine that silently leaves the last game of a 15-game
  // night unpulled to save credits PropLine does not charge.
  it("lifts a seeded cap to the per-request default for a PropLine install", () => {
    const state = migrate({
      settings: { daily: { league: "nba", maxGames: 14 }, oddsFeed: { provider: "propline" } },
    })
    expect(state.settings.daily.maxGames).toBe(15)
  })

  it("leaves the credit default alone for an Odds API install", () => {
    const state = migrate({
      settings: { daily: { league: "nba", maxGames: 14 }, oddsFeed: { provider: "theoddsapi" } },
    })
    expect(state.settings.daily.maxGames).toBe(14)
  })

  it("never overrules a cap somebody chose", () => {
    for (const provider of ["propline", "theoddsapi"]) {
      const state = migrate({
        settings: { daily: { league: "nba", maxGames: 6 }, oddsFeed: { provider } },
      })
      expect(state.settings.daily.maxGames, provider).toBe(6)
    }
  })

  it("leaves a league with a single cap untouched on either feed", () => {
    for (const provider of ["propline", "theoddsapi"]) {
      const state = migrate({
        settings: { daily: { league: "nfl", maxGames: 14 }, oddsFeed: { provider } },
      })
      expect(state.settings.daily.maxGames, provider).toBe(14)
    }
  })
})

describe("the rename to BlessedBets", () => {
  // The app's name changed; the addresses its data lives under must not. An
  // install's settings, slips, tracker history and line history are stored
  // under these two names, so renaming either opens an empty store on the next
  // load and strands everything in the old one. These are tripwires for a
  // well-meant cleanup that "finishes" the rename.
  afterEach(() => vi.unstubAllGlobals())

  it("still reads an existing install's data from the original localStorage key", async () => {
    const { loadState } = await import("@/lib/store/local")
    const stored = migrate({ version: 3, settings: { daily: { league: "nba", minEdge: 0.07 } } })
    const store: Record<string, string> = { "wagerwise.state.v1": JSON.stringify(stored) }
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) },
    })
    // 0.07 is not a default, so reading it back proves the old key was found.
    expect(loadState().settings.daily.minEdge).toBe(0.07)
  })

  it("still opens the original IndexedDB database", async () => {
    const opened: string[] = []
    vi.stubGlobal("indexedDB", {
      open: (name: string) => {
        opened.push(name)
        throw new Error("stubbed: only the name is under test")
      },
    })
    const { openPartStore } = await import("@/lib/store/idb")
    await expect(openPartStore()).rejects.toThrow("stubbed")
    expect(opened).toEqual(["wagerwise"])
  })
})

/**
 * Two tabs open on the same data.
 *
 * The report behind everything below: an Odds API key pasted into Settings in
 * one tab was gone, or was an older key again, as soon as a Today screen left
 * open in another tab changed any setting at all. Each tab read storage once
 * and from then on wrote the whole settings-and-slips record from its own
 * copy, so the tab that had been open longer put the old key back, and the
 * next pull failed with "The Odds API rejected the API key" for a key that
 * was right.
 */

const withKey = (apiKey: string) => (s: AppState): AppState => ({
  ...s,
  settings: { ...s.settings, oddsFeed: { ...s.settings.oddsFeed, apiKey } },
})
const withRegions = (regions: string) => (s: AppState): AppState => ({
  ...s,
  settings: { ...s.settings, oddsFeed: { ...s.settings.oddsFeed, regions } },
})
const withLeague = (league: "nba" | "nfl") => (s: AppState): AppState => ({
  ...s,
  settings: { ...s.settings, daily: { ...s.settings.daily, league } },
})
const withSlip = (id: string) => (s: AppState): AppState => ({ ...s, slips: [slip(id), ...s.slips] })
const withPull = (daily: DailyCache) => (s: AppState): AppState => ({ ...s, daily: { ...s.daily, [daily.league]: daily } })
const withLines = (snap: LineSnapshot) => (s: AppState): AppState => ({
  ...s,
  lines: [snap, ...s.lines].slice(0, MAX_LINE_SNAPSHOTS),
})
const slip = (id: string, notes = ""): TrackedSlip => ({ id, notes, legs: [], status: "PENDING" }) as never
const snapshot = (pulledAt: string, league: "nba" | "nfl" = "nba"): LineSnapshot => ({ pulledAt, league, rows: [] })
const core = (s: AppState) => partOf(s, "core")!.value as CoreRecord
/** A record as another tab would hand it over: through storage, so made of none of this tab's objects. */
const stored = <T>(key: string, value: T): T => readPart(key, JSON.stringify(value)) as T
const ids = (list: { id: string }[]) => list.map((x) => x.id)

describe("two tabs' changes to one record", () => {
  it("keeps a key saved in another tab when this tab changes something else", () => {
    // The report, as three versions of one record. This tab loaded before the
    // key existed and has only switched league.
    const base = core(STATE)
    const mine = core(withLeague("nfl")(STATE))
    const theirs = stored("core", core(withKey("the-key-just-pasted")(STATE)))
    const out = mergeRecord("core", base, mine, theirs) as CoreRecord
    expect(out.settings.oddsFeed.apiKey).toBe("the-key-just-pasted")
    expect(out.settings.daily.league).toBe("nfl")
  })

  it("lets this tab's own change to a field stand over a stored one", () => {
    // Both changed the same field. The tab doing the writing is the later of
    // the two to act, so its value is the one kept.
    const out = mergeRecord(
      "core",
      core(STATE),
      core(withKey("typed-here")(STATE)),
      stored("core", core(withKey("typed-there")(STATE))),
    ) as CoreRecord
    expect(out.settings.oddsFeed.apiKey).toBe("typed-here")
  })

  it("does not count a field as changed because the object around it is new", () => {
    // Every setter spreads its way down to the field it sets, so the objects
    // on the way are new whether or not anything else in them moved. Judged
    // by reference alone, a league switch would claim the whole of `daily`.
    const mine = core(withLeague("nfl")(STATE))
    const theirs = stored("core", core({ ...STATE, settings: { ...STATE.settings, daily: { ...STATE.settings.daily, minEdge: 0.07 } } }))
    const out = mergeRecord("core", core(STATE), mine, theirs) as CoreRecord
    expect(out.settings.daily.league).toBe("nfl")
    expect(out.settings.daily.minEdge).toBe(0.07)
  })

  it("adds and removes keyed settings one key at a time", () => {
    // Confirmed payouts are filed by key. Reading one off the screen in each
    // tab must leave both, and clearing one here must not bring it back.
    const capture = (picks: number) => ({ picks, tiers: { [picks]: 5 }, confirmed: true, capturedAt: "2026-10-25T20:00:00Z" })
    const payouts = (p: Record<string, unknown>) => (s: AppState): AppState =>
      ({ ...s, settings: { ...s.settings, capturedPayouts: p } }) as AppState
    const base = core(payouts({ old: capture(2), stale: capture(3) })(STATE))
    const mine = core(payouts({ old: capture(2), here: capture(4) })(STATE))
    const theirs = stored("core", core(payouts({ old: capture(2), stale: capture(3), there: capture(5) })(STATE)))
    const out = mergeRecord("core", base, mine, theirs) as CoreRecord
    expect(Object.keys(out.settings.capturedPayouts).sort()).toEqual(["here", "old", "there"])
  })

  it("treats a list inside the settings as one field", () => {
    // Half of one tab's book list and half of the other's is a list nobody chose.
    const books = (b: string[]) => (s: AppState): AppState => ({
      ...s,
      settings: { ...s.settings, oddsFeed: { ...s.settings.oddsFeed, bettable: b } },
    })
    const out = mergeRecord(
      "core",
      core(STATE),
      core(books(["fanduel", "draftkings"])(STATE)),
      stored("core", core(books(["betmgm"])(STATE))),
    ) as CoreRecord
    expect(out.settings.oddsFeed.bettable).toEqual(["fanduel", "draftkings"])
  })

  it("keeps an entry logged in each tab", () => {
    // As one field, the later list would replace the earlier and an entry
    // would vanish from the tracker without anyone removing it.
    const out = mergeRecord(
      "core",
      core(STATE),
      core(withSlip("logged-here")(STATE)),
      stored("core", core(withSlip("logged-there")(STATE))),
    ) as CoreRecord
    expect(ids(out.slips).sort()).toEqual(["logged-here", "logged-there", "s1"])
  })

  it("keeps an entry settled here, and drops one removed there", () => {
    const start = { ...STATE, slips: [slip("a"), slip("b"), slip("c")] }
    const settled = { ...start, slips: start.slips.map((x) => (x.id === "a" ? { ...x, notes: "won" } : x)) }
    const removed = { ...start, slips: start.slips.filter((x) => x.id !== "b") }
    const out = mergeRecord("core", core(start), core(settled), stored("core", core(removed))) as CoreRecord
    expect(out.slips.map((x) => [x.id, x.notes])).toEqual([["a", "won"], ["c", ""]])
  })

  it("keeps an entry whole rather than mixing two tabs' versions of it", () => {
    // An entry's status and payout are worked out from its legs. Legs from one
    // tab under a status from the other is an entry neither tab ever showed.
    const start = { ...STATE, slips: [slip("a")] }
    const here = { ...start, slips: [{ ...slip("a"), notes: "here", status: "SETTLED" as const }] }
    const there = { ...start, slips: [{ ...slip("a"), stake: 25 }] }
    const out = mergeRecord("core", core(start), core(here), stored("core", core(there))) as CoreRecord
    expect(out.slips).toEqual(here.slips)
  })

  it("keeps the imported board this tab captured over the one stored", () => {
    const board = (id: string) => ({ id, label: id, importedAt: "2026-10-25T20:00:00Z", rows: [], source: "" })
    const mine = core({ ...STATE, slate: board("captured-here") })
    const untouched = mergeRecord("core", core(STATE), core(STATE), stored("core", core({ ...STATE, slate: board("there") })))
    expect((untouched as CoreRecord).slate?.id).toBe("there")
    const kept = mergeRecord("core", core(STATE), mine, stored("core", core({ ...STATE, slate: board("there") })))
    expect((kept as CoreRecord).slate?.id).toBe("captured-here")
  })

  it("keeps both tabs' pulls in the line history, newest first, and no more than a load would", () => {
    const base = [snapshot("2026-10-20T20:00:00Z")]
    const mine = [snapshot("2026-10-25T20:00:00Z"), ...base]
    const theirs = stored("lines", [snapshot("2026-10-24T20:00:00Z", "nfl"), ...base])
    const out = mergeRecord("lines", base, mine, theirs) as LineSnapshot[]
    expect(out.map((x) => x.pulledAt.slice(8, 10))).toEqual(["25", "24", "20"])

    // Two tabs at the cap each add one: the load would drop the ninth, so the
    // merge does, rather than store something a reload reads differently.
    const full = Array.from({ length: MAX_LINE_SNAPSHOTS }, (_, i) => snapshot(`2026-10-${10 + i}T20:00:00Z`)).reverse()
    const a = [snapshot("2026-10-30T20:00:00Z"), ...full].slice(0, MAX_LINE_SNAPSHOTS)
    const b = stored("lines", [snapshot("2026-10-29T20:00:00Z"), ...full].slice(0, MAX_LINE_SNAPSHOTS))
    const capped = mergeRecord("lines", full, a, b) as LineSnapshot[]
    expect(capped).toHaveLength(MAX_LINE_SNAPSHOTS)
    expect(capped.slice(0, 2).map((x) => x.pulledAt.slice(8, 10))).toEqual(["30", "29"])
    expect(capped.map((x) => x.pulledAt)).toEqual(migrate({ lines: capped }).lines.map((x) => x.pulledAt))
  })

  it("takes a slate whole: this tab's pull if it made one, the stored one if not", () => {
    const old = slate("nba", "2026-10-25T20:00:00Z")
    const here = slate("nba", "2026-10-25T22:00:00Z")
    const there = stored("daily:nba", slate("nba", "2026-10-25T21:00:00Z"))
    expect((mergeRecord("daily:nba", old, old, there) as DailyCache).fetchedAt).toBe("2026-10-25T21:00:00Z")
    expect(mergeRecord("daily:nba", old, here, there)).toBe(here)
  })

  it("hands back this tab's own objects for everything that did not change", () => {
    // State is compared by reference all over the app: the board re-prices
    // every prop when settings.projection is a new object. A record taken
    // from another tab as all-new objects would recompute every screen each
    // time a character was typed in a different tab.
    const mine = core({ ...STATE, slate: { id: "b", label: "b", importedAt: "x", rows: [], source: "" } })
    const out = mergeRecord("core", mine, mine, stored("core", core(withKey("typed-there")({ ...STATE, slate: mine.slate })))) as CoreRecord
    expect(out.settings.oddsFeed.apiKey).toBe("typed-there")
    expect(out.settings).not.toBe(mine.settings)
    expect(out.settings.projection).toBe(mine.settings.projection)
    expect(out.settings.apps).toBe(mine.settings.apps)
    expect(out.slate).toBe(mine.slate)
    expect(out.slips).toBe(mine.slips)
  })

  it("is the very same record when what is stored says nothing new", () => {
    // Which is how a tab that reads a record knows there is nothing to show.
    // It also pins the property the whole thing rests on: what a load makes
    // of a stored state is the state that was stored.
    const mine = core(STATE)
    expect(mergeRecord("core", mine, mine, stored("core", mine))).toBe(mine)
    expect(mergeRecord("lines", STATE.lines, STATE.lines, stored("lines", STATE.lines))).toBe(STATE.lines)
    expect(sameValue(migrate(JSON.parse(JSON.stringify(EMPTY_STATE))), EMPTY_STATE)).toBe(true)
  })

  it("compares a record with the copy it was stored from as storage would", () => {
    // JSON has no undefined, so a key holding it comes back missing.
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 1, b: null })).toBe(false)
    expect(sameValue([1, { x: [2] }], [1, { x: [2] }])).toBe(true)
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false)
    expect(sameValue({ a: [] }, { a: {} })).toBe(false)
  })

  it("leaves a list alone when its entries cannot be told apart", () => {
    // Two entries under one id cannot be merged one at a time without losing
    // one of them, so the list is then a single value like any other.
    const twins = { ...STATE, slips: [slip("x"), slip("x", "second")] }
    const out = mergeRecord("core", core(STATE), core(twins), stored("core", core(withSlip("there")(STATE)))) as CoreRecord
    expect(out.slips).toEqual(twins.slips)
  })

  it("does not let a stored key named __proto__ reach an object's prototype", () => {
    const theirs = JSON.parse('{"__proto__":{"polluted":true},"regions":"us"}')
    const out = mergeRecord("core", core(STATE), core(withLeague("nfl")(STATE)), {
      ...core(STATE),
      settings: { ...STATE.settings, oddsFeed: theirs },
    }) as CoreRecord
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect((out.settings.oddsFeed as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe("one record of the state", () => {
  it("is taken out and put back without touching the rest", () => {
    const pulled = slate("nba", "2026-10-26T20:00:00Z")
    const next = withPart(STATE, "daily:nba", pulled)
    expect(next.daily.nba).toBe(pulled)
    expect(next.daily.nfl).toBe(STATE.daily.nfl)
    expect(next.settings).toBe(STATE.settings)
    expect(next.lines).toBe(STATE.lines)

    const moved = withPart(STATE, "core", core(withKey("k")(STATE)))
    expect(moved.settings.oddsFeed.apiKey).toBe("k")
    expect(moved.daily).toBe(STATE.daily)
    // The references a record was read as are the ones a save compares, so
    // putting a record in place leaves nothing to write for it.
    const sent = new Map(partsOf(moved).map((p) => [p.key, p.refs]))
    expect(partsToWrite(sent, withPart(moved, "core", partOf(moved, "core")!.value))).toEqual([])
  })

  it("takes a slate out, and never the settings", () => {
    expect(Object.keys(withPart(STATE, "daily:nfl", null).daily)).toEqual(["nba"])
    expect(withPart(STATE, "core", null)).toBe(STATE)
    expect(withPart(STATE, "lines", null).lines).toEqual([])
    expect(withPart(STATE, "something-else", {})).toBe(STATE)
  })

  it("reads one stored record exactly as a load would", () => {
    const parts = Object.fromEntries(partsOf(STATE).map((p) => [p.key, JSON.stringify(p.value)]))
    const loaded = migrate(joinParts(parseRecords(parts)))
    for (const part of partsOf(loaded)) {
      expect(readPart(part.key, parts[part.key]), part.key).toEqual(part.value)
    }
  })

  it("reads nothing from a record it cannot use", () => {
    expect(readPart("core", "{not json")).toBeUndefined()
    expect(readPart("core", '"a string"')).toBeUndefined()
    // A league this build does not have, and a slate with no quotes in it.
    expect(readPart("daily:wnba", JSON.stringify(slate("nba", "x")))).toBeUndefined()
    expect(readPart("daily:nba", "{}")).toBeUndefined()
    expect(readPart("lines", '"nonsense"')).toEqual([])
    expect(parseRecords({ core: "{}", lines: "[" })).toEqual({ core: {} })
  })

  it("tells a rewritten record from an unchanged one without keeping its text", () => {
    const a = JSON.stringify(core(STATE))
    const b = JSON.stringify(core(withKey("0123456789abcdef0123456789abcdef")(STATE)))
    expect(fingerprint(a)).toBe(fingerprint(a.slice()))
    expect(fingerprint(a)).not.toBe(fingerprint(b))
    // Same length, one character different, anywhere in a long text.
    const long = "x".repeat(200_000)
    expect(fingerprint(long + "a")).not.toBe(fingerprint(long + "b"))
    expect(fingerprint("a" + long)).not.toBe(fingerprint("b" + long))
    // No record is not the same as an empty one.
    expect(fingerprint(undefined)).toBeNull()
    expect(fingerprint("")).not.toBeNull()
    // And megabytes come down to a few characters, which is the point of it.
    expect(fingerprint(long) ?? "").toMatch(/^.{1,39}$/)
  })
})

/**
 * One database and the tabs open on it, without a browser.
 *
 * The database runs one transaction at a time in the order they were asked
 * for, which is what IndexedDB does for writes to one store across every tab
 * of an origin, and is the only property of it the tabs rely on.
 */
function database(opts: { fits?: (key: string, json: string) => boolean } = {}) {
  const records = new Map<string, string>()
  let last: Promise<unknown> = Promise.resolve()
  function transact<T>(body: () => T): Promise<T> {
    const done = last.then(body)
    last = done.catch(() => {})
    return done
  }
  const db = {
    records,
    /** Every write that landed, as "tab record". */
    writes: [] as string[],
    /** Every write that was tried, landed or not. */
    tries: [] as string[],
    /** Every read of one record, as "tab record". */
    reads: [] as string[],
    /** Set to make every write fail the way a dropped connection does. */
    broken: false,
    /**
     * Runs once, after a merged write has been worked out and before it
     * lands: the gap a real transaction has between reading and committing.
     */
    between: null as (() => void) | null,
    /** A read's answer is held back until this resolves: it was read, but has not arrived. */
    held: null as Promise<void> | null,
    tabs: [] as Tab[],
    record: (key: string) => JSON.parse(records.get(key) ?? "null"),
    store(tab: string): PartStore {
      const put = (key: string, json: string | null) => {
        db.tries.push(`${tab} ${key}`)
        // Not for ever: a tab that asked again without pause would never let
        // the test reach the line that says it must not.
        if (db.broken && db.tries.length < 50) throw new Error("Connection to Indexed Database server lost.")
        if (json !== null && opts.fits && !opts.fits(key, json)) {
          throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" })
        }
        db.writes.push(`${tab} ${key}`)
        if (json === null) records.delete(key)
        else records.set(key, json)
      }
      return {
        readAll: () => transact(() => Object.fromEntries(records)),
        read: (key) => {
          const held = db.held
          db.reads.push(`${tab} ${key}`)
          return transact(() => records.get(key)).then(async (text) => {
            await held
            return text
          })
        },
        write: (key, json) => transact(() => put(key, json)),
        update: (key, next) =>
          transact(() => {
            const json = next(records.get(key))
            const between = db.between
            db.between = null
            between?.()
            if (json !== undefined) put(key, json)
          }),
        seed: (parts) =>
          transact(() => {
            if (records.has("core")) return false
            for (const part of parts) records.set(part.key, JSON.stringify(part.value))
            return true
          }),
      }
    },
  }
  return db
}

interface Tab {
  state: AppState
  failures: Record<string, SaveFailure>
  hears: boolean
  sync: TabSync
  /** What a setter does: a new state, then the save that follows it. */
  change(update: (s: AppState) => AppState): void
}

/** Opens a tab the way the provider does: seed if empty, read everything, start from that. */
async function openTab(db: ReturnType<typeof database>, name: string, opts: { hears?: boolean } = {}): Promise<Tab> {
  const store = db.store(name)
  await store.seed(partsOf(EMPTY_STATE))
  const texts = await store.readAll()
  const records = parseRecords(texts)
  const raw = joinParts(records)
  const tab: Tab = {
    state: raw ? migrate(raw) : EMPTY_STATE,
    failures: {},
    hears: opts.hears ?? true,
    sync: null as unknown as TabSync,
    change(update) {
      tab.state = update(tab.state)
      tab.sync.save()
    },
  }
  tab.sync = syncParts(
    store,
    {
      get: () => tab.state,
      // A state put on screen is followed by a save, as any change of state is.
      set: (next) => {
        tab.state = next
        queueMicrotask(() => tab.sync.save())
      },
      failures: (update) => {
        tab.failures = update(tab.failures)
      },
      tell: (key) => {
        for (const other of db.tabs) if (other !== tab && other.hears) queueMicrotask(() => other.sync.refresh([key]))
      },
    },
    { state: tab.state, stored: Object.fromEntries(Object.keys(records).map((key) => [key, texts[key]])) },
  )
  db.tabs.push(tab)
  return tab
}

/** Lets every transaction, message and save that is under way finish. */
async function settled() {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("two tabs on one database", () => {
  it("cannot wipe a key saved in the other tab, even having heard nothing of it", async () => {
    // The report itself, with every way of hearing about the other tab's
    // write taken away: no message, never brought back into view. All that is
    // left is the write, which reads the record before it stores it.
    const db = database()
    const today = await openTab(db, "today", { hears: false })
    const settings = await openTab(db, "settings", { hears: false })
    settings.change(withKey("the-key-just-pasted"))
    await settled()

    today.change(withLeague("nfl"))
    await settled()
    expect(db.record("core").settings.oddsFeed.apiKey).toBe("the-key-just-pasted")
    expect(db.record("core").settings.daily.league).toBe("nfl")
    // And the write that found the key brought it onto this tab's screen, so
    // the pull it makes next sends the key that was pasted, not the old one.
    expect(today.state.settings.oddsFeed.apiKey).toBe("the-key-just-pasted")
    expect(today.failures).toEqual({})
  })

  it("shows a change in the other tab, which then writes nothing back", async () => {
    const db = database()
    const today = await openTab(db, "today")
    const settings = await openTab(db, "settings")
    settings.change(withKey("the-key-just-pasted"))
    await settled()
    expect(today.state.settings.oddsFeed.apiKey).toBe("the-key-just-pasted")
    // The tab that only heard stored nothing. If it stored what it had just
    // read, the first tab would read that, and the two would never stop.
    expect(db.writes).toEqual(["settings core"])

    today.change(withLeague("nfl"))
    await settled()
    expect(settings.state.settings.daily.league).toBe("nfl")
    expect(db.writes).toEqual(["settings core", "today core"])
  })

  it("writes nothing when a tab opens, and one record for one change", async () => {
    const db = database()
    const a = await openTab(db, "a")
    a.sync.save()
    await settled()
    expect(db.tries).toEqual([])
    a.change(withPull(slate("nba", "2026-10-25T20:00:00Z")))
    await settled()
    expect(db.writes).toEqual(["a daily:nba"])
  })

  it("stores a run of keystrokes that came before the first could land as one write", async () => {
    // A write is made from the state as it is when the transaction runs, not
    // as it was when the write was asked for, so whatever was typed in
    // between goes in that write rather than queueing one each behind it.
    const db = database()
    const a = await openTab(db, "a")
    for (const typed of ["0", "01", "012", "0123"]) a.change(withKey(typed))
    await settled()
    expect(db.record("core").settings.oddsFeed.apiKey).toBe("0123")
    expect(db.writes).toEqual(["a core"])
  })

  it("keeps a character typed while another tab's change is on its way in", async () => {
    // Settings change on every keystroke. Replacing this tab's record with
    // the stored one whenever another tab wrote would eat whatever was typed
    // between the read being asked for and its answer.
    const db = database()
    const a = await openTab(db, "a", { hears: false })
    const b = await openTab(db, "b", { hears: false })
    b.change(withKey("pasted-in-b"))
    await settled()

    a.sync.refresh(["core"]) // the read is asked for...
    a.change(withRegions("us")) // ...and a character is typed before it answers
    a.change(withRegions("us,"))
    await settled()
    expect(a.state.settings.oddsFeed.regions).toBe("us,")
    expect(a.state.settings.oddsFeed.apiKey).toBe("pasted-in-b")
    expect(db.record("core").settings.oddsFeed).toMatchObject({ regions: "us,", apiKey: "pasted-in-b" })
  })

  it("keeps a character typed between a write being worked out and it landing", async () => {
    // The write below finds the other tab's key and stores both. That result
    // then has to go on this screen, and by the time it does another
    // character has been typed. Put on screen as it stands, it would take
    // that character back off, and with nothing left to save, for good.
    const db = database()
    const a = await openTab(db, "a", { hears: false })
    const b = await openTab(db, "b", { hears: false })
    b.change(withKey("pasted-in-b"))
    await settled()

    db.between = () => a.change(withRegions("us"))
    a.change(withRegions("u"))
    await settled()
    expect(a.state.settings.oddsFeed).toMatchObject({ regions: "us", apiKey: "pasted-in-b" })
    expect(db.record("core").settings.oddsFeed).toMatchObject({ regions: "us", apiKey: "pasted-in-b" })
  })

  it("looks again when told of a write made after the look it already has under way", async () => {
    // The answer on its way was read before the other tab wrote. Taking it as
    // the answer to "this record was just written" would leave this tab on
    // the old one, sure it was up to date.
    const db = database()
    const a = await openTab(db, "a")
    const b = await openTab(db, "b")
    let arrive = () => {}
    db.held = new Promise((resolve) => (arrive = resolve))
    a.sync.refresh(["core"])
    await settled()
    db.held = null

    b.change(withKey("typed-in-b"))
    await settled()
    expect(a.state.settings.oddsFeed.apiKey).toBe("")
    arrive()
    await settled()
    expect(a.state.settings.oddsFeed.apiKey).toBe("typed-in-b")
  })

  it("keeps what both tabs typed when they type at the same moment", async () => {
    const db = database()
    const a = await openTab(db, "a")
    const b = await openTab(db, "b")
    for (let i = 1; i <= 8; i++) {
      a.change(withKey("a".repeat(i)))
      b.change(withRegions("b".repeat(i)))
      // Sometimes between keystrokes the tabs get a moment, sometimes not.
      if (i % 3 === 0) await settled()
    }
    await settled()
    for (const tab of [a, b]) {
      expect(tab.state.settings.oddsFeed.apiKey).toBe("aaaaaaaa")
      expect(tab.state.settings.oddsFeed.regions).toBe("bbbbbbbb")
    }
    expect(db.record("core").settings.oddsFeed).toMatchObject({ apiKey: "aaaaaaaa", regions: "bbbbbbbb" })
  })

  it("stores a field taken back to what it was, not the value in between", async () => {
    // Typed and deleted before the first write lands. If the second write
    // took the first for another tab's, "back to what it was" would read as
    // "not changed by me" and the deleted character would be stored.
    const db = database()
    const a = await openTab(db, "a")
    const blank = a.state.settings.oddsFeed.apiKey
    a.change(withKey("x"))
    a.change(withKey(blank))
    await settled()
    expect(db.record("core").settings.oddsFeed.apiKey).toBe(blank)
    expect(a.state.settings.oddsFeed.apiKey).toBe(blank)

    // The same with another tab's write landing in between the two.
    const b = await openTab(db, "b", { hears: false })
    a.change(withKey("y"))
    b.change(withRegions("eu"))
    a.change(withKey(blank))
    await settled()
    expect(db.record("core").settings.oddsFeed).toMatchObject({ apiKey: blank, regions: "eu" })
  })

  it("keeps an entry logged in each tab at the same moment", async () => {
    const db = database()
    const a = await openTab(db, "a")
    const b = await openTab(db, "b")
    a.change(withSlip("logged-in-a"))
    b.change(withSlip("logged-in-b"))
    await settled()
    expect(ids(db.record("core").slips).sort()).toEqual(["logged-in-a", "logged-in-b"])
    expect(ids(a.state.slips)).toEqual(ids(b.state.slips))
    expect(ids(a.state.slips).sort()).toEqual(["logged-in-a", "logged-in-b"])
  })

  it("shows a pull made in the other tab, with its lines", async () => {
    const db = database()
    const a = await openTab(db, "a")
    const b = await openTab(db, "b")
    a.change((s) => withLines(snapshot("2026-10-25T20:00:00Z"))(withPull(slate("nba", "2026-10-25T20:00:00Z"))(s)))
    await settled()
    expect(b.state.daily.nba?.fetchedAt).toBe("2026-10-25T20:00:00Z")
    expect(b.state.lines).toHaveLength(1)
    expect(db.writes.sort()).toEqual(["a daily:nba", "a lines"])

    // Each then pulls a different league at once: both slates, both snapshots.
    a.change((s) => withLines(snapshot("2026-10-26T20:00:00Z"))(withPull(slate("nba", "2026-10-26T20:00:00Z"))(s)))
    b.change((s) => withLines(snapshot("2026-10-26T21:00:00Z", "nfl"))(withPull(slate("nfl", "2026-10-26T21:00:00Z"))(s)))
    await settled()
    for (const tab of [a, b]) {
      expect(tab.state.daily.nba?.fetchedAt).toBe("2026-10-26T20:00:00Z")
      expect(tab.state.daily.nfl?.fetchedAt).toBe("2026-10-26T21:00:00Z")
      expect(tab.state.lines.map((x) => x.pulledAt.slice(8, 13))).toEqual(["26T21", "26T20", "25T20"])
    }
  })

  it("adds to what a tab on an older build stored, though that tab never says it wrote", async () => {
    // A window left open across a deploy still writes the old way and sends
    // no message. Its write is noticed anyway, because the stored text is not
    // the text this tab knew: no counter the old build would have to bump.
    const db = database()
    const a = await openTab(db, "a")
    db.records.set("core", JSON.stringify(core(withSlip("logged-in-the-old-window")(EMPTY_STATE))))
    a.change(withKey("typed-in-a"))
    await settled()
    expect(ids(db.record("core").slips)).toEqual(["logged-in-the-old-window"])
    expect(db.record("core").settings.oddsFeed.apiKey).toBe("typed-in-a")
    expect(ids(a.state.slips)).toEqual(["logged-in-the-old-window"])
  })

  it("catches up on everything when asked to look round", async () => {
    // A tab the browser froze in the background, coming back into view.
    const db = database()
    const frozen = await openTab(db, "frozen", { hears: false })
    const awake = await openTab(db, "awake")
    awake.change((s) => withKey("k")(withSlip("s")(withPull(slate("nfl", "2026-10-25T20:00:00Z"))(s))))
    await settled()
    expect(frozen.state.daily.nfl).toBeUndefined()

    frozen.sync.refresh()
    frozen.sync.refresh() // a second look while the first is under way adds none
    await settled()
    // Each record read once: a slate is megabytes, and coming into view and
    // being given the focus arrive together.
    expect(db.reads.filter((r) => r === "frozen core")).toHaveLength(1)
    expect(db.reads.filter((r) => r === "frozen daily:nfl")).toHaveLength(1)
    expect(frozen.state.settings.oddsFeed.apiKey).toBe("k")
    expect(ids(frozen.state.slips)).toEqual(["s"])
    expect(frozen.state.daily.nfl?.fetchedAt).toBe("2026-10-25T20:00:00Z")
    expect(db.writes.filter((w) => w.startsWith("frozen"))).toEqual([])
  })

  it("removes a slate the other tab removed, but not one that went with the whole database", async () => {
    const db = database()
    const a = await openTab(db, "a")
    const b = await openTab(db, "b")
    a.change((s) => withPull(slate("nfl", "2026-10-24T20:00:00Z"))(withPull(slate("nba", "2026-10-25T20:00:00Z"))(s)))
    await settled()
    expect(Object.keys(b.state.daily).sort()).toEqual(["nba", "nfl"])

    // A restore from a file with no NFL slate.
    a.change((s) => ({ ...s, daily: { nba: s.daily.nba } }))
    await settled()
    expect(db.records.has("daily:nfl")).toBe(false)
    expect(Object.keys(b.state.daily)).toEqual(["nba"])

    // The browser empties the database under an open tab. Nothing asked for
    // the NBA slate to go, and it cost feed credits: it stays on screen.
    db.records.clear()
    b.sync.refresh()
    await settled()
    expect(b.state.daily.nba?.fetchedAt).toBe("2026-10-25T20:00:00Z")
    expect(db.records.size).toBe(0)
    // Nothing is stored again until something here changes, and then it is.
    b.change(withKey("k"))
    await settled()
    expect(db.record("core").settings.oddsFeed.apiKey).toBe("k")
  })

  it("keeps a slate that does not fit on screen, says so, and does not try it again unasked", async () => {
    // The existing rule, unchanged by any of this: a save that does not fit
    // is reported and never takes anything off the screen.
    const db = database({ fits: (key) => key !== "daily:nba" })
    const a = await openTab(db, "a")
    const b = await openTab(db, "b")
    a.change(withPull(slate("nba", "2026-10-25T20:00:00Z")))
    await settled()
    expect(a.state.daily.nba?.fetchedAt).toBe("2026-10-25T20:00:00Z")
    expect(a.failures["daily:nba"]).toMatchObject({ quota: true, label: "the NBA slate" })
    expect(db.records.has("daily:nba")).toBe(false)

    // The same megabytes would fail the same way on every keystroke.
    a.change(withRegions("us"))
    a.change(withRegions("us,eu"))
    await settled()
    expect(db.tries.filter((t) => t === "a daily:nba")).toHaveLength(1)

    // Another tab's change still arrives, and still nothing leaves the screen.
    b.change(withKey("typed-in-b"))
    a.sync.refresh()
    await settled()
    expect(a.state.settings.oddsFeed.apiKey).toBe("typed-in-b")
    expect(a.state.daily.nba?.fetchedAt).toBe("2026-10-25T20:00:00Z")
    expect(a.failures["daily:nba"]?.quota).toBe(true)
    expect(db.tries.filter((t) => t === "a daily:nba")).toHaveLength(1)

    // A new pull is a new part, and is tried.
    a.change(withPull(slate("nba", "2026-10-25T22:00:00Z")))
    await settled()
    expect(db.tries.filter((t) => t === "a daily:nba")).toHaveLength(2)
  })

  it("keeps this tab's own slate on screen when it did not fit and another tab's did", async () => {
    // Two pulls of one league. This tab's is too big to store and is still
    // the one on its screen: showing the other tab's instead would take a
    // pull off the screen because it could not be saved, which is the one
    // thing a save that does not fit must never do.
    const big = { ...slate("nba", "2026-10-25T22:00:00Z"), quotes: Array(500).fill({ book: "x" }) as never }
    const db = database({ fits: (_, json) => json.length < 2000 })
    const a = await openTab(db, "a")
    const b = await openTab(db, "b")
    a.change(withPull(big))
    await settled()
    expect(a.failures["daily:nba"]?.quota).toBe(true)

    b.change(withPull(slate("nba", "2026-10-25T21:00:00Z")))
    await settled()
    expect(db.record("daily:nba").fetchedAt).toBe("2026-10-25T21:00:00Z")
    expect(a.state.daily.nba?.quotes).toHaveLength(500)
    expect(a.failures["daily:nba"]?.quota).toBe(true)
    expect(db.tries.filter((t) => t === "a daily:nba")).toHaveLength(1)
  })

  it("keeps settings that could not be stored through another tab's change, and stores them when it can", async () => {
    let room = false
    const db = database({ fits: (key) => key !== "core" || room })
    const a = await openTab(db, "a")
    a.change(withKey("typed-in-a"))
    await settled()
    expect(a.failures.core).toMatchObject({ quota: true, label: "your settings and slips" })
    expect(a.state.settings.oddsFeed.apiKey).toBe("typed-in-a")

    // Stored by another tab meanwhile (one with room to: say, after a clear-out).
    db.records.set("core", JSON.stringify(core(withRegions("eu")(EMPTY_STATE))))
    a.sync.refresh(["core"])
    await settled()
    expect(a.state.settings.oddsFeed).toMatchObject({ apiKey: "typed-in-a", regions: "eu" })

    room = true
    a.change(withLeague("nfl"))
    await settled()
    expect(a.failures).toEqual({})
    expect(db.record("core").settings.oddsFeed).toMatchObject({ apiKey: "typed-in-a", regions: "eu" })
    expect(db.record("core").settings.daily.league).toBe("nfl")
  })

  it("reports a write that failed for some other reason and tries it again at the next save", async () => {
    const db = database()
    const a = await openTab(db, "a")
    db.broken = true
    a.change(withKey("typed-while-broken"))
    await settled()
    expect(a.failures.core.quota).toBe(false)
    expect(a.failures.core.message).toContain("Could not save your settings and slips")
    expect(a.state.settings.oddsFeed.apiKey).toBe("typed-while-broken")
    // Once, not over and over: a store that will not take a write is not asked without pause.
    expect(db.tries).toEqual(["a core"])

    db.broken = false
    a.change(withRegions("us"))
    await settled()
    expect(a.failures).toEqual({})
    expect(db.record("core").settings.oddsFeed).toMatchObject({ apiKey: "typed-while-broken", regions: "us" })
  })

  it("writes over a record it could not read rather than adding to it", async () => {
    const db = database()
    db.records.set("core", "{cut off mid-wri")
    const a = await openTab(db, "a")
    expect(a.state).toBe(EMPTY_STATE)
    a.change(withKey("k"))
    await settled()
    expect(db.record("core").settings.oddsFeed.apiKey).toBe("k")
  })

  it("touches nothing once it has been stopped", async () => {
    const db = database()
    const a = await openTab(db, "a")
    const b = await openTab(db, "b")
    a.sync.stop()
    b.change(withKey("typed-in-b"))
    a.sync.refresh()
    a.change(withRegions("us"))
    await settled()
    expect(a.state.settings.oddsFeed.apiKey).toBe("")
    expect(db.writes).toEqual(["b core"])
  })
})

describe("two tabs on the localStorage blob", () => {
  afterEach(() => vi.unstubAllGlobals())

  /** One localStorage for every tab, holding at most `room` characters. */
  function stubShared(room = 10_000_000) {
    const store: Record<string, string> = {}
    const sets: string[] = []
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          if (v.length > room) throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" })
          sets.push(k)
          store[k] = v
        },
      },
    })
    return { store, sets, blob: () => JSON.parse(store["wagerwise.state.v1"]) as AppState }
  }

  function blobTab() {
    const tab = {
      state: loadState(),
      failures: {} as Record<string, SaveFailure>,
      sync: null as unknown as TabSync,
      change(update: (s: AppState) => AppState) {
        tab.state = update(tab.state)
        tab.sync.save()
      },
    }
    tab.sync = syncBlob({
      get: () => tab.state,
      set: (next) => {
        tab.state = next
        tab.sync.save()
      },
      failures: (update) => {
        tab.failures = update(tab.failures)
      },
      tell: () => {
        throw new Error("the browser tells the other tabs about a stored blob; nothing here should")
      },
    })
    return tab
  }

  it("cannot wipe a key saved in the other tab", () => {
    const { blob } = stubShared()
    const today = blobTab()
    const settings = blobTab()
    settings.change(withKey("the-key-just-pasted"))
    // Never told: the save itself reads the blob before it stores it.
    today.change(withLeague("nfl"))
    expect(blob().settings.oddsFeed.apiKey).toBe("the-key-just-pasted")
    expect(blob().settings.daily.league).toBe("nfl")
    expect(today.state.settings.oddsFeed.apiKey).toBe("the-key-just-pasted")
  })

  it("shows what the other tab stored, and stores nothing back", () => {
    const { sets } = stubShared()
    const a = blobTab()
    const b = blobTab()
    a.sync.save()
    expect(sets).toEqual([]) // nothing changed, nothing written
    b.change((s) => withSlip("logged-in-b")(withKey("typed-in-b")(s)))
    a.sync.refresh() // what the browser's storage event leads to
    expect(a.state.settings.oddsFeed.apiKey).toBe("typed-in-b")
    expect(ids(a.state.slips)).toEqual(["logged-in-b"])
    expect(sets).toHaveLength(1)
    a.sync.refresh()
    expect(sets).toHaveLength(1)
  })

  it("keeps an entry logged in each tab", () => {
    const { blob } = stubShared()
    const a = blobTab()
    const b = blobTab()
    a.change(withSlip("logged-in-a"))
    b.change(withSlip("logged-in-b"))
    expect(ids(blob().slips).sort()).toEqual(["logged-in-a", "logged-in-b"])
    a.sync.refresh()
    expect(ids(a.state.slips).sort()).toEqual(["logged-in-a", "logged-in-b"])
  })

  it("does not take a slate off one tab's screen because it was shed from the stored copy", () => {
    // Shedding is from the stored copy only, so the tab that pulled keeps its
    // slate on screen. Another tab then saves a setting, and the blob it
    // writes has no slate in it either. Read back as "the slate was removed",
    // that would take a pull that cost credits off the first tab's screen.
    const big = { ...slate("nba", "2026-10-25T20:00:00Z"), quotes: Array(4000).fill({ book: "x" }) as never }
    const { blob } = stubShared(JSON.stringify(EMPTY_STATE).length + 2000)
    const a = blobTab()
    const b = blobTab()
    a.change((s) => withLines(snapshot("2026-10-25T20:00:00Z"))(withPull(big)(s)))
    expect(a.failures).toHaveProperty("every cached slate")
    expect(blob().daily).toEqual({})

    b.change(withKey("typed-in-b"))
    a.sync.refresh()
    expect(a.state.settings.oddsFeed.apiKey).toBe("typed-in-b")
    expect(a.state.daily.nba?.quotes).toHaveLength(4000)
    expect(a.state.lines).toHaveLength(1)
  })

  it("fills what the stored copy lacks from what was there, and takes everything else as stored", () => {
    const stored = withKey("there")({ ...STATE, daily: { nfl: slate("nfl", "2026-10-26T20:00:00Z") }, lines: [], slate: null })
    const board = { id: "b", label: "b", importedAt: "x", rows: [], source: "" }
    const out = withShed({ ...STATE, slate: board }, stored)
    expect(out.daily.nba).toBe(STATE.daily.nba)
    expect(out.daily.nfl?.fetchedAt).toBe("2026-10-26T20:00:00Z")
    expect(out.lines).toEqual(STATE.lines)
    expect(out.slate).toBe(board)
    expect(out.settings.oddsFeed.apiKey).toBe("there")
  })

  it("merges a whole state record by record", () => {
    const mine = withLeague("nfl")(withPull(slate("nba", "2026-10-26T20:00:00Z"))(STATE))
    const theirs = migrate(JSON.parse(JSON.stringify(withKey("there")({ ...STATE, daily: { nba: STATE.daily.nba } }))))
    const out = mergeState(STATE, mine, theirs)
    expect(out.settings.oddsFeed.apiKey).toBe("there")
    expect(out.settings.daily.league).toBe("nfl")
    expect(out.daily.nba?.fetchedAt).toBe("2026-10-26T20:00:00Z") // pulled here
    expect(out.daily.nfl).toBeUndefined() // removed there, untouched here
    expect(mergeState(STATE, STATE, migrate(JSON.parse(JSON.stringify(STATE))))).toBe(STATE)
  })

  it("hears another tab store the blob, and nothing else", () => {
    const handlers: ((e: unknown) => void)[] = []
    vi.stubGlobal("window", {
      addEventListener: (_: string, h: (e: unknown) => void) => handlers.push(h),
      removeEventListener: (_: string, h: (e: unknown) => void) => handlers.splice(handlers.indexOf(h), 1),
    })
    let heard = 0
    const stop = onStored(() => heard++)
    handlers[0]({ key: "wagerwise.state.v1" })
    handlers[0]({ key: "theme" })
    handlers[0]({ key: null }) // storage cleared
    expect(heard).toBe(2)
    stop()
    expect(handlers).toHaveLength(0)
  })
})

describe("telling the other tabs", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("names a record and nothing more", () => {
    expect(recordNamed({ key: "core" })).toBe("core")
    expect(recordNamed({ key: "daily:nfl" })).toBe("daily:nfl")
    // Anything else a page on this origin might post is not a record.
    for (const junk of [null, "core", 7, {}, { key: 7 }, { key: "settings" }, { key: "" }]) {
      expect(recordNamed(junk), JSON.stringify(junk)).toBeNull()
    }
  })

  it("reaches every other tab and not the one that wrote", () => {
    const open: { name: string; onmessage: ((e: { data: unknown }) => void) | null }[] = []
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: ((e: { data: unknown }) => void) | null = null
        constructor(public name: string) {
          open.push(this)
        }
        postMessage(data: unknown) {
          for (const other of open) if (other !== this && other.name === this.name) other.onmessage?.({ data })
        }
        close() {
          open.splice(open.indexOf(this), 1)
        }
      },
    )
    const heard: string[] = []
    const a = openTabs((key) => heard.push(`a ${key}`))
    const b = openTabs((key) => heard.push(`b ${key}`))
    const c = openTabs((key) => heard.push(`c ${key}`))
    a.tell("core")
    expect(heard).toEqual(["b core", "c core"])
    // The content never travels this way: a record's name is the whole message.
    open[1].onmessage?.({ data: { key: "core", settings: { oddsFeed: { apiKey: "x" } } } })
    open[1].onmessage?.({ data: { key: "not-a-record" } })
    expect(heard).toEqual(["b core", "c core", "b core"])
    c.close()
    b.tell("lines")
    expect(heard.slice(3)).toEqual(["a lines"])
    a.close()
    b.close()
  })

  it("does nothing where the browser has no way to tell", () => {
    vi.stubGlobal("BroadcastChannel", undefined)
    const tabs = openTabs(() => {
      throw new Error("nothing to hear")
    })
    expect(() => {
      tabs.tell("core")
      tabs.close()
    }).not.toThrow()
  })
})
