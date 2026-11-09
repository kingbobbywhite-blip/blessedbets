import { describe, expect, it } from "vitest"
import { appIsBehind, lineChanges, sinceLabel } from "@/lib/quant/lines"
import type { LineSnapshot, LineSnapshotRow } from "@/lib/store/schema"

const START = "2026-11-09T00:30:00.000Z"
const row = (key: string, line: number, startsAt: string | null = START): LineSnapshotRow => ({
  key, player: key, market: "PTS", hoursToStart: 5, startsAt, line, mean: null, books: 5,
})
const snap = (pulledAt: string, rows: LineSnapshotRow[], league: "nba" | "nfl" = "nba"): LineSnapshot => ({
  pulledAt, league, rows,
})

describe("lineChanges", () => {
  const morning = snap("2026-11-08T15:00:00.000Z", [row("a", 23.5), row("b", 8.5), row("c", 4.5)])
  const evening = snap("2026-11-08T22:00:00.000Z", [row("a", 25), row("b", 8.5), row("c", 3.5), row("d", 12.5)])

  it("reports each prop the books moved since the most recent earlier pull, and nothing else", () => {
    const m = lineChanges([evening, morning], "nba", evening.pulledAt)
    expect(m.get(`a|${START}`)).toEqual({ from: 23.5, to: 25, delta: 1.5, since: morning.pulledAt })
    expect(m.get(`c|${START}`)).toEqual({ from: 4.5, to: 3.5, delta: -1, since: morning.pulledAt })
    // Unmoved, and new since the morning: neither is movement.
    expect(m.has(`b|${START}`)).toBe(false)
    expect(m.has(`d|${START}`)).toBe(false)
    expect(m.size).toBe(2)
  })

  it("compares against the MOST RECENT earlier look, not the first one ever", () => {
    const noon = snap("2026-11-08T18:00:00.000Z", [row("a", 24.5)])
    const m = lineChanges([morning, evening, noon], "nba", evening.pulledAt)
    // 24.5 at noon -> 25 now; the 23.5 from the morning is older news.
    expect(m.get(`a|${START}`)).toEqual({ from: 24.5, to: 25, delta: 0.5, since: noon.pulledAt })
  })

  it("is anchored on the pull on screen, and says nothing when that pull was not stored", () => {
    // A later pull exists but is not the one displayed: never compare past it.
    const later = snap("2026-11-09T00:00:00.000Z", [row("a", 30)])
    expect(lineChanges([later, evening, morning], "nba", evening.pulledAt).get(`a|${START}`)?.to).toBe(25)
    // The displayed pull's snapshot is missing (not saved, or shed for room):
    // nothing, rather than the difference between two older pulls.
    expect(lineChanges([evening, morning], "nba", "2026-11-08T23:59:00.000Z").size).toBe(0)
    expect(lineChanges([evening, morning], "nba", null).size).toBe(0)
  })

  it("keeps leagues apart and never pairs the same teams meeting again", () => {
    const nfl = snap("2026-11-08T14:00:00.000Z", [row("a", 10)], "nfl")
    expect(lineChanges([evening, nfl], "nba", evening.pulledAt).size).toBe(0)
    // Same key, different start: a different game, so not a move.
    const rematch = snap("2026-11-08T15:00:00.000Z", [row("a", 18.5, "2026-12-01T00:30:00.000Z")])
    expect(lineChanges([evening, rematch], "nba", evening.pulledAt).size).toBe(0)
  })
})

describe("appIsBehind", () => {
  const up = { from: 23.5, to: 25, delta: 1.5, since: "" }
  it("is true when the app's line sits nearer where the books were than where they are", () => {
    expect(appIsBehind(up, 23.5)).toBe(true) // never followed
    expect(appIsBehind(up, 24)).toBe(true)
  })
  it("is false when the app has followed, or there is no app line", () => {
    expect(appIsBehind(up, 25)).toBe(false)
    expect(appIsBehind(up, 24.5)).toBe(false)
    expect(appIsBehind(up, 24.25)).toBe(false) // equidistant is not behind
    expect(appIsBehind(up, null)).toBe(false)
    expect(appIsBehind(up, Number.NaN)).toBe(false)
  })
})

describe("sinceLabel", () => {
  const t0 = Date.parse("2026-11-08T12:00:00.000Z")
  it("reads as minutes, then hours, then days", () => {
    expect(sinceLabel("2026-11-08T11:40:00.000Z", t0)).toBe("20m ago")
    expect(sinceLabel("2026-11-08T09:00:00.000Z", t0)).toBe("3h ago")
    expect(sinceLabel("2026-11-06T12:00:00.000Z", t0)).toBe("2d ago")
    expect(sinceLabel("not a date", t0)).toBe("")
  })
})
