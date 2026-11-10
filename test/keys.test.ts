import { describe, expect, it } from "vitest"
import { NO_SERVER_KEYS, hasFeedKey, parseServerKeys, serverKeysFrom } from "@/lib/odds-feed/keys"
import { cleanApiKey, describeKey, looksLikeOddsApiKey, savedKeyNote, usableKey } from "@/lib/odds-feed/api-key"
import type { OddsFeedSettings } from "@/lib/store/schema"

type Feed = Pick<OddsFeedSettings, "provider" | "apiKey" | "proplineKey">

const oddsApi = (apiKey = "", proplineKey = ""): Feed => ({ provider: "theoddsapi", apiKey, proplineKey })
const propline = (proplineKey = "", apiKey = ""): Feed => ({ provider: "propline", apiKey, proplineKey })

describe("serverKeysFrom", () => {
  it("reports which keys the environment holds", () => {
    expect(serverKeysFrom({ ODDS_API_KEY: "abc" })).toEqual({ oddsApi: true, propline: false })
    expect(serverKeysFrom({ PROPLINE_API_KEY: "xyz" })).toEqual({ oddsApi: false, propline: true })
    expect(serverKeysFrom({ ODDS_API_KEY: "abc", PROPLINE_API_KEY: "xyz" })).toEqual({ oddsApi: true, propline: true })
    expect(serverKeysFrom({})).toEqual(NO_SERVER_KEYS)
  })

  it("treats a blank variable as unset, the way the routes do", () => {
    expect(serverKeysFrom({ ODDS_API_KEY: "", PROPLINE_API_KEY: "   " })).toEqual(NO_SERVER_KEYS)
  })

  it("returns booleans only, never a key", () => {
    const out = serverKeysFrom({ ODDS_API_KEY: "secret-odds", PROPLINE_API_KEY: "secret-propline" })
    expect(Object.keys(out).sort()).toEqual(["oddsApi", "propline"])
    expect(JSON.stringify(out)).not.toContain("secret")
  })
})

describe("parseServerKeys", () => {
  it("reads a well-formed response", () => {
    expect(parseServerKeys({ oddsApi: true, propline: false })).toEqual({ oddsApi: true, propline: false })
  })

  it("counts anything but a literal true as no key", () => {
    expect(parseServerKeys(null)).toEqual(NO_SERVER_KEYS)
    expect(parseServerKeys("yes")).toEqual(NO_SERVER_KEYS)
    expect(parseServerKeys({ oddsApi: "true", propline: 1 })).toEqual(NO_SERVER_KEYS)
  })
})

describe("placeholders are not keys", () => {
  it("does not report a placeholder in the environment as a key the server holds", () => {
    expect(serverKeysFrom({ ODDS_API_KEY: "your_api_key", PROPLINE_API_KEY: "changeme" })).toEqual(NO_SERVER_KEYS)
    expect(serverKeysFrom({ PROPLINE_API_KEY: ' "real-key" ' })).toEqual({ oddsApi: false, propline: true })
  })

  it("does not enable a pull for a placeholder typed into Settings", () => {
    expect(hasFeedKey(propline("your_api_key"), NO_SERVER_KEYS)).toBe(false)
    expect(hasFeedKey(oddsApi("xxxx"), NO_SERVER_KEYS)).toBe(false)
  })
})

describe("hasFeedKey", () => {
  it("is ready with only ODDS_API_KEY in the environment and nothing in Settings", () => {
    expect(hasFeedKey(oddsApi(), { oddsApi: true, propline: false })).toBe(true)
  })

  it("is ready with only a key in Settings", () => {
    expect(hasFeedKey(oddsApi("abc"), NO_SERVER_KEYS)).toBe(true)
    expect(hasFeedKey(propline("xyz"), NO_SERVER_KEYS)).toBe(true)
  })

  it("is not ready with neither", () => {
    expect(hasFeedKey(oddsApi(), NO_SERVER_KEYS)).toBe(false)
    expect(hasFeedKey(oddsApi("   "), NO_SERVER_KEYS)).toBe(false)
    expect(hasFeedKey(propline(), NO_SERVER_KEYS)).toBe(false)
  })

  it("needs the key for the selected provider, not the other one", () => {
    expect(hasFeedKey(propline(), { oddsApi: true, propline: false })).toBe(false)
    expect(hasFeedKey(propline("", "abc"), NO_SERVER_KEYS)).toBe(false)
    expect(hasFeedKey(oddsApi(), { oddsApi: false, propline: true })).toBe(false)
    expect(hasFeedKey(oddsApi("", "xyz"), NO_SERVER_KEYS)).toBe(false)
  })

  it("is ready for PropLine with only PROPLINE_API_KEY in the environment", () => {
    expect(hasFeedKey(propline(), { oddsApi: false, propline: true })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A key the feed refuses while the account page says it is active
// ---------------------------------------------------------------------------

/** The shape of an Odds API key, and nobody's. */
const KEY = "0123456789abcdef0123456789abcdef"
const OTHER = "fedcba9876543210fedcba9876543210"

describe("a key copied with what was printed beside it", () => {
  it("takes the key out from under the label an account page prints above it", () => {
    // The report: the account page said Active, 204 of 500 credits used, and
    // the app said "API key is not valid". The page prints "API Key" on the
    // line above the key; select both, paste into a one-line field, and the
    // browser stores the line break as a space. Checked in Chromium, which
    // stores exactly the first string here: forty masked characters that the
    // feed refuses, about a key it accepts.
    expect(cleanApiKey(`API Key ${KEY}`)).toBe(KEY)
    expect(cleanApiKey(`API Key ${KEY} Usage this period`)).toBe(KEY)
    expect(cleanApiKey(`${KEY} Usage this period`)).toBe(KEY)
    expect(cleanApiKey(`API Key\n${KEY}\n`)).toBe(KEY)
    expect(usableKey(`API Key ${KEY}`)).toBe(KEY)
  })

  it("still strips quotes and a comma from a key that came with a name", () => {
    expect(cleanApiKey(`apiKey: "${KEY}",`)).toBe(KEY)
    expect(cleanApiKey(`"API Key ${KEY}"`)).toBe(KEY)
  })

  it("leaves alone what it cannot tell apart, for the feed to refuse and the error to describe", () => {
    // Two parts long enough to be a key: there is no telling which one is.
    expect(cleanApiKey(`${KEY} ${OTHER}`)).toBe(`${KEY} ${OTHER}`)
    // Nothing long enough to be a key, so a placeholder phrase stays one.
    expect(cleanApiKey("your api key")).toBe("your api key")
    expect(usableKey("your api key")).toBeNull()
    expect(cleanApiKey("API Key abc123")).toBe("API Key abc123")
  })

  it("never touches a key that came on its own, whatever it looks like", () => {
    // The shape is what one vendor issues today. A key with no space in it is
    // sent as it is: only the feed can say it is wrong.
    for (const key of [KEY, "abc123", "pk_live_0123456789abcdefghij", "c29tZS1iYXNlNjQta2V5LXZhbHVl=="]) {
      expect(cleanApiKey(key)).toBe(key)
    }
  })
})

describe("describing a key without showing it", () => {
  it("gives the length and the last four characters", () => {
    expect(describeKey(KEY)).toBe('32 characters, ending in "cdef"')
    expect(describeKey(`Key${KEY}`)).toBe('35 characters, ending in "cdef"')
  })

  it("gives only the length of a key too short for four characters to be a small part of it", () => {
    expect(describeKey("abc123")).toBe("6 characters")
    expect(describeKey("a")).toBe("1 character")
  })

  it("knows the shape of an Odds API key", () => {
    expect(looksLikeOddsApiKey(KEY)).toBe(true)
    expect(looksLikeOddsApiKey(KEY.toUpperCase())).toBe(true)
    expect(looksLikeOddsApiKey(KEY.slice(1))).toBe(false)
    expect(looksLikeOddsApiKey(`Key${KEY}`)).toBe(false)
    expect(looksLikeOddsApiKey(`${KEY.slice(0, 31)}g`)).toBe(false)
  })
})

describe("what Settings says beneath a masked key field", () => {
  const oddsField = { envName: "ODDS_API_KEY", serverHasKey: false, oddsApi: true }
  const proplineField = { envName: "PROPLINE_API_KEY", serverHasKey: false }

  it("says nothing about an empty field", () => {
    expect(savedKeyNote("", oddsField)).toBeNull()
    expect(savedKeyNote("   ", oddsField)).toBeNull()
    expect(savedKeyNote(undefined, proplineField)).toBeNull()
  })

  it("says what is saved, so it can be checked against the account page", () => {
    expect(savedKeyNote(KEY, oddsField)).toEqual({
      text: 'Saved in this browser: 32 characters, ending in "cdef".',
      warn: false,
    })
  })

  it("never shows more of the key than how it ends", () => {
    const note = savedKeyNote(KEY, { ...oddsField, serverHasKey: true })!
    expect(note.text).toContain('"cdef"')
    expect(note.text).not.toContain(KEY.slice(0, 28))
    expect(note.text).not.toContain(KEY.slice(-5))
  })

  it("says the label pasted with a key is ignored, since the field still holds it", () => {
    const note = savedKeyNote(`API Key ${KEY}`, oddsField)!
    expect(note.text).toBe('Saved in this browser: 32 characters, ending in "cdef". The other text pasted with it is ignored.')
    expect(note.warn).toBe(false)
  })

  it("warns when what is saved is not the shape of an Odds API key", () => {
    // The PropLine key in the wrong box, or a key with a stray character: the
    // same row of dots as the right key until this line says otherwise.
    const note = savedKeyNote(`${KEY}x`, oddsField)!
    expect(note.warn).toBe(true)
    expect(note.text).toContain('33 characters, ending in "defx"')
    expect(note.text).toContain("An Odds API key is 32 characters, each a digit or a letter from a to f")
  })

  it("makes no claim about the shape of a PropLine key, which this app does not know", () => {
    expect(savedKeyNote("pl_whatever_shape_this_is_0001", proplineField)).toEqual({
      text: 'Saved in this browser: 30 characters, ending in "0001".',
      warn: false,
    })
  })

  it("says a placeholder is not sent", () => {
    expect(savedKeyNote("your_api_key", oddsField)).toEqual({
      text: "That is a placeholder, not a key, so it is never sent.",
      warn: true,
    })
  })

  it("says when the server's own key is the one in use, because retyping this one changes nothing", () => {
    const held = { ...oddsField, serverHasKey: true }
    const typed = savedKeyNote(KEY, held)!
    expect(typed.warn).toBe(true)
    expect(typed.text).toContain("Not the key in use")
    expect(typed.text).toContain("ODDS_API_KEY")
    expect(typed.text).toContain("takes precedence")
    // Nothing typed is not a problem: the environment key is doing the job.
    expect(savedKeyNote("", held)).toEqual({
      text: "A pull sends the key in ODDS_API_KEY, set in this server's environment, so this field can stay empty.",
      warn: false,
    })
    expect(savedKeyNote("changeme", { ...proplineField, serverHasKey: true })).toEqual({
      text: "That is a placeholder, not a key. A pull sends the key in PROPLINE_API_KEY, set in this server's environment.",
      warn: false,
    })
  })
})
