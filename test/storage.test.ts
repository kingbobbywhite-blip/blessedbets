import { afterEach, describe, expect, it, vi } from "vitest"
import { joinParts, partLabel, partsOf, partsToWrite } from "@/lib/store/idb"
import { saveReduced } from "@/lib/store/local"
import { EMPTY_STATE, migrate, type AppState, type DailyCache } from "@/lib/store/schema"

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
