import { MARKETS, normalizeMarket, type MarketKey } from "@/lib/nba/markets"
import type { LoggedLeagueId } from "@/lib/leagues"
import type { Boost } from "./boost"
import type { Outcome } from "./ring"

/**
 * Turn OCR text from a DFS board screenshot into candidate props.
 *
 * This exists instead of scraping. Scraping a pick'em app's endpoints is against
 * their terms and gets accounts restricted, and the board is the half of the
 * data that carries no signal anyway: it tells you what is on offer, not what it
 * is worth. Reading your own screen is the honest way to get the offer side in.
 *
 * Nothing here is trusted. Every candidate lands in a review table where a human
 * confirms or corrects it before it becomes a prop, because OCR on a dense
 * mobile screenshot is wrong often enough that silently accepting it would
 * quietly poison the whole board.
 */

export interface OcrBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrLine {
  text: string
  /** 0-100 from the OCR engine, when available. */
  confidence?: number
  /**
   * Where the line sits in the image, when it came from OCR. Typed text has
   * none. With it, a stat is paired to the name beside or above it on screen;
   * without it, to the nearest name in reading order.
   */
  bbox?: OcrBox
  /** A goblin or demon face beside this line's value, found by colour (see boost.ts). */
  boost?: Boost | null
  /** The colour of the player's ring on this row of an entry screen: hit, missed, or neither (see ring.ts). */
  outcome?: Outcome | null
}

export type Side = "OVER" | "UNDER"

export interface PropCandidate {
  player: string
  marketKey: MarketKey | null
  marketLabel: string
  rawMarket: string
  line: number
  /** 0-1, how much of the candidate was read cleanly. */
  confidence: number
  /** Source line indices, so the review table can show the context. */
  sourceLines: number[]
  issues: string[]
  /**
   * The side taken, when the screenshot or text shows one: an entry screen's
   * up/down arrow, or "over"/"under" typed beside the line. Boards offer both
   * sides and leave this empty. Only logging an entry uses it.
   */
  side?: Side | null
  /** Marked "Reboot" on an entry screen: the player did not play. */
  dnp?: boolean
  /** A goblin or demon on the entry screen. Absent where the screenshot was not read in colour. */
  boost?: Boost | null
  /**
   * Whether the leg has hit or missed, from the colour of the player's ring on
   * an entry screen. Null where the ring was looked at and is neither, which
   * is a leg still open; absent where the screenshot was not read in colour.
   */
  outcome?: Outcome | null
}

export interface ExtractResult {
  candidates: PropCandidate[]
  /**
   * Player names read with no line near them. On an entry screen the line
   * sometimes sits under an icon the OCR cannot see through; listing the
   * player lets the tracker ask for it instead of silently dropping the leg.
   */
  unpairedNames: string[]
  /** Lines the extractor could not place, for the review screen. */
  leftover: { index: number; text: string }[]
}

const STAT_WORDS = [
  "points", "pts", "rebounds", "rebs", "reb", "assists", "ast", "asts",
  "3-pointers made", "3 pointers made", "three pointers made", "3-pt made", "3pt made", "threes",
  "steals", "stl", "blocks", "blk", "turnovers", "tov",
  "pts+rebs+asts", "pts+reb+ast", "points+rebounds+assists", "pra",
  "pts+rebs", "pts+reb", "pts+asts", "pts+ast", "rebs+asts", "reb+ast",
  "blks+stls", "blocks+steals", "steals+blocks", "stocks",
  "fantasy score", "fantasy points",
  "free throws made", "ftm", "field goals made", "fgm",
  "3-pointers attempted", "minutes",
  // Other phrasings the boards print. "Blocked Shots" matters most: missing
  // from this list, it reads as a two-word name and gets pinned to the wrong
  // player's line.
  "blocked shots", "blocked shot", "3-pointers", "3 pointers", "three pointers", "3pt", "3pm",
  "fg made", "ft made", "free throws", "fantasy pts", "stls+blks", "reb+asts", "pts+asts",
  // PrizePicks lineup and entry screens abbreviate threes as "3PTM".
  "3ptm", "3pt m",
  // NFL
  "pass yards", "passing yards", "pass yds", "pass tds", "passing tds", "pass completions", "completions",
  "pass attempts", "passing attempts", "interceptions", "interceptions thrown", "rush yards", "rushing yards",
  "rush yds", "rush attempts", "rushing attempts", "carries", "receptions", "receiving yards", "rec yards",
  "rec yds", "recs", "rec", "rush+rec yds", "rush + rec yds", "rush+rec yards", "rush + rec yards", "rushing+receiving yards",
  // NHL. "Points", "Assists" and "Blocked Shots" are already here and read as
  // basketball; an NHL entry swaps them (see marketForSport).
  "shots on goal", "sog", "goalie saves", "saves", "goals", "power play points",
]

/** Words that look like names to a regex but never are. */
const NOT_NAMES = new Set([
  "higher", "lower", "more", "less", "over", "under", "final", "live", "today", "tonight",
  "power", "flex", "play", "entry", "lineup", "picks", "pick", "board", "all", "sports",
  "nba", "wnba", "nfl", "cfb", "mlb", "nhl", "ncaa", "ncaaf", "quick", "demon", "goblin", "boost", "boosted",
  "my", "promo", "special", "combo", "vs", "at", "home", "away", "projection", "proj",
])

/**
 * Team codes every read consults: the NBA, the WNBA and the NFL.
 *
 * Nothing is ever removed from this set. What it actually buys is narrow and
 * real: a bare matchup row with no clock, no "vs" and no position — "Dal Den"
 * above a line and a stat — is the one input that reads as a player without
 * it. Emptying the set does not fail a single fixture, so the protection lives
 * off-fixture and has to be kept deliberately.
 */
const BASE_TEAM_CODES = new Set([
  // NBA
  "atl","bos","bkn","bkl","cha","chi","cle","dal","den","det","gsw","hou","ind","lac","lal",
  "mem","mia","mil","min","nop","nyk","okc","orl","phi","phx","por","sac","sas","tor","uta","was",
  // WNBA codes that are not already NBA codes. The WNBA is no longer one of the
  // leagues Today prices, but these stay: a logged WNBA entry still has to read
  // back off a screenshot, and settled history is the only thing that can tell
  // you the model was wrong.
  "lva","lv","nyl","ny","sea","con","conn","las","la","gsv",
  // NFL codes that are not already NBA or WNBA codes
  "ari","bal","buf","car","cin","gb","jax","jac","kc","lar","lv","lvr","ne","no","nyg","nyj","pit",
  "sf","tb","ten","wsh","wash",
])

/**
 * College football codes, consulted ONLY on a read the screen says is college.
 *
 * They cannot go in the set above, and this is measured rather than argued.
 * The check below rejects a whole line as a name when ANY of its words is a
 * code, so merging these globally silently destroys real NFL players: Rashee
 * Rice, Sam LaPorta, LaMelo Ball, Troy Franklin, Van Jefferson, Duke Johnson.
 * Not flagged for review — gone, with the prop and the name both dropped. A
 * college slate is the only place these are worth the risk, so a college
 * slate is the only place they are consulted.
 *
 * Codes that are also a word inside a real full name are left out for the same
 * reason, even on a college read: rice, ball, troy, sam, van, duke, kent,
 * temple, del, cal, stan and marsh all belong to somebody. A team code read as
 * a name lands in the review table, where you fix it in a second; a name read
 * as a team code is a prop that never appears. The first mistake is cheap and
 * the second is not, so the list errs toward letting a code through.
 */
const CFB_TEAM_CODES = new Set([
  // SEC
  "ala","bama","ark","aub","fla","fsu","ga","uga","ky","lsu","miss","ole","msst","miz","mizz","sc",
  "tenn","tex","tamu","vandy","okla","ou","okst",
  // Big Ten
  "ill","mich","msu","minn","neb","nw","psu","pur","umd","wis","iowa","rut","ucla","usc","ore",
  "wash","uw",
  // Big 12
  "byu","tcu","smu","ttu","baylor","kan","ku","ksu","isu","cin","hou","ucf","wvu","asu","ariz",
  "colo","utah","orst","wsu","utsa",
  // ACC
  "unc","ncst","wake","pitt","bc","syr","cuse","lou","uva","vt","clem","gt","nd","miami","cuse",
  // Group of five and independents
  "army","navy","af","tulsa","tulane","memp","usf","fau","fiu","uab","unt","mtsu","usm","ulm","ull",
  "arst","txst","app","ccu","gaso","jmu","odu","lib","akr","bg","bgsu","cmu","emu","wmu","niu",
  "tol","ohio","buff","nev","unlv","sdsu","sjsu","fres","haw","wyo","usu","nmsu","unm","utst",
  "utep","jvst","kenn","wku","boise","bois",
])

/**
 * Which league a screenshot is of, from its own text.
 *
 * Every game on an entry screen is headed by its league: "NHL MIN 2 vs NYL 87",
 * "CFB OSU 24 vs PSU 17". The NHL is still read here although Today no longer
 * prices it: an NHL screen's "Points" is the hockey market, and a read that
 * forgot the league would type it as basketball. See RETIRED_LEAGUES.
 *
 * Three things this has to get right:
 *
 *   The apps do not all write it the same way. PrizePicks says CFB; others
 *   say NCAAF, and the odds feeds say NCAAF too, so both have to resolve to
 *   the same league.
 *
 *   A first match in key order is not a reading. A college slip whose chrome
 *   says "NFL" anywhere once read as NFL, which then pointed the extractor at
 *   the wrong team codes. Counting which league the screen actually names more
 *   often is the honest answer, and a tie is no answer at all.
 *
 *   "WNBA" is not "NBA". There is no word boundary between the W and the N, so
 *   a WNBA screen names no league we price, which is correct: the WNBA is gone
 *   from Today and its entries still have to read back.
 */
const LEAGUE_WORDS: { league: LoggedLeagueId; pattern: RegExp }[] = [
  { league: "nba", pattern: /\bnba\b/gi },
  { league: "nfl", pattern: /\bnfl\b/gi },
  { league: "cfb", pattern: /\b(?:cfb|ncaaf|ncaa\s*fb|cfp)\b/gi },
  { league: "nhl", pattern: /\bnhl\b/gi },
]

export function leagueFromScreen(text: string): LoggedLeagueId | null {
  let best: LoggedLeagueId | null = null
  let bestCount = 0
  let tied = false
  for (const { league, pattern } of LEAGUE_WORDS) {
    const count = (text.match(pattern) ?? []).length
    if (count === 0) continue
    if (count > bestCount) {
      best = league
      bestCount = count
      tied = false
    } else if (count === bestCount) {
      tied = true
    }
  }
  // A screen naming two leagues equally often is a mixed slip, and guessing
  // between them would point the extractor at the wrong team codes. No hint
  // leaves it reading exactly as it did before college football existed.
  return tied ? null : best
}

/**
 * The codes to consult for a read, given what the screen said the league was.
 *
 * No hint means exactly today's set: the extractor has no idea what sport it
 * is looking at unless the caller says, and guessing wrong here costs a prop.
 */
export function teamCodesFor(league?: LoggedLeagueId | null): ReadonlySet<string> {
  return league === "cfb" ? new Set([...BASE_TEAM_CODES, ...CFB_TEAM_CODES]) : BASE_TEAM_CODES
}

// Single positions plus the combined tags boards print, such as "G/F" or "F-C",
// which reach here with the separator stripped.
const POSITIONS = new Set([
  "pg", "sg", "sf", "pf", "c", "g", "f", "gf", "fg", "fc", "cf", "gc",
  // NFL
  "qb", "rb", "wr", "te", "fb",
])

/** Direction words a person might type beside a line. Stripped, never a name. */
const SIDE_WORDS = new Set(["over", "under", "o", "u", "ov", "un", "more", "less", "higher", "lower"])
const OVER_WORDS = new Set(["over", "o", "ov", "more", "higher"])

/** The side named in a typed line, if exactly one is: "Jordan Addison under 5.5 Recs". */
function typedSide(tokens: string[]): Side | null {
  let side: Side | null = null
  for (const t of tokens) {
    const w = t.toLowerCase()
    const m = w.match(/^([ou])\d/)
    const s: Side | null = SIDE_WORDS.has(w) ? (OVER_WORDS.has(w) ? "OVER" : "UNDER") : m ? (m[1] === "o" ? "OVER" : "UNDER") : null
    if (!s) continue
    if (side && side !== s) return null
    side = s
  }
  return side
}

/** Tokens that separate parts of a typed line and carry no meaning of their own. */
const SEPARATOR = /^[-\u2013\u2014:|\u2022\u00b7,/]+$/

/**
 * Common OCR confusions in numbers. Applied only to strings that are otherwise
 * numeric, so a name containing an O is never mangled.
 */
function repairNumeric(raw: string): string {
  return raw
    .replace(/[Oo]/g, "0")
    .replace(/[lI|]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/[,]/g, ".")
    .replace(/\s+/g, "")
}

/**
 * The arrow PrizePicks prints before a line, as OCR renders it.
 *
 * Read from fifteen real settled-entry screenshots: up came out as "tT",
 * "oT", "St", "T", "t", "r", "*", a quote mark and, six times, a "4"; down as
 * "J", "wv", "oY", "U", "v", a backslash and a "1". The digits only count as
 * a token of their own right before the value ("Kelsey Mitchell 4 15"), or
 * glued to its front when the stat rules the whole number out ("415").
 *
 * A goblin or demon icon sits just before the arrow and reads as letters too:
 * "OW", "Ow", "Oo", "OS", "w", "@". So the side comes from the arrow glyph
 * nearest the value, not from everything in front of it: "OW r15" is a goblin
 * then an up arrow, and read as a whole its W looked like a down arrow. W is
 * not an arrow glyph at all; the down arrow's "wv" still ends in v. With no
 * arrow glyph, the side is unknown: reported when the glyph says so, never
 * guessed.
 */
const UP_GLYPH = /[tTr4*^"'\u2191\u201c\u201d]/
const DOWN_GLYPH = /[JjvVyYU1\\\u2193]/

function glyphSide(glyphs: string): Side | null {
  for (let i = glyphs.length - 1; i >= 0; i--) {
    if (UP_GLYPH.test(glyphs[i])) return "OVER"
    if (DOWN_GLYPH.test(glyphs[i])) return "UNDER"
  }
  return null
}

/** A short token that is an arrow, icon or stray mark rather than a word: "tT", "J", "@", "+.)". */
function isGlyphToken(tok: string): boolean {
  if (/\d/.test(tok)) return false
  // Name suffixes are words, not arrows: "Kenneth Walker III 72.5". A lone
  // "v" is not one: before a value it is the down arrow ("OW v 25"), and
  // reading it as a suffix lost both the side and the decimal point.
  if (/^(jr|sr|ii|iii|iv)\.?$/i.test(tok)) return false
  const letters = tok.replace(/[^A-Za-z]/g, "").length
  if (letters === 0) return tok.length <= 4
  return letters <= 2 && tok.length <= 4
}

/**
 * Restore a decimal point an arrow swallowed: "445" after an arrow is 44.5.
 * Lines on these apps end in .5 almost without exception, so a run of two or
 * more digits ending in 5 or 0 with no point gets one before its last digit.
 * A single digit stays as it is: whole-number lines such as 9 do exist.
 */
function restoreDecimal(digits: string): { value: number; repaired: boolean } | null {
  let t = digits.replace(",", ".")
  let repaired = t !== digits
  if (!t.includes(".") && t.length >= 2 && /[05]$/.test(t)) {
    t = `${t.slice(0, -1)}.${t.slice(-1)}`
    repaired = true
  }
  const v = Number.parseFloat(t)
  if (!Number.isFinite(v) || v >= 1000) return null
  return { value: v, repaired }
}

interface TrailingValue {
  value: number
  /**
   * The value if a leading 7 was really the arrow: "71.5" for an up-arrow 1.5.
   * Which one is right depends on the stat, so the choice waits for it.
   */
  alt?: number
  /** The side the digit read as an arrow points, when `alt` is taken. */
  altSide?: Side
  repaired: boolean
  side: Side | null
  /** Tokens left before the value and its arrow: a name, or nothing. */
  before: string[]
  raw: string
}

/**
 * A line value at the end of a run of tokens, with whatever arrow sits in
 * front of it, as entry screens print it: "Cade Otton J 65.5", "tT 05",
 * "Jordan Addison U55", 'Kiki Iriafen "9'.
 *
 * With no arrow at all, only a clean value counts ("65.5", "36"), exactly as
 * before; the decimal repair is reserved for values an arrow was read beside.
 */
function trailingValue(tokens: string[]): TrailingValue | null {
  if (tokens.length === 0) return null
  const last = tokens[tokens.length - 1]
  let glyphs = ""
  let digits: string | null = null

  const attached =
    last.match(/^([A-Za-z*\\"'^\u2191\u2193\u201c\u201d]{1,2})(\d{1,4}(?:[.,]\d)?)$/) ??
    // The arrow's tip read as a stray point: "v.25" is a down arrow and 2.5.
    // Two digits at least, so "T.5" is not taken for a 5.
    last.match(/^([A-Za-z*\\"'^\u2191\u2193\u201c\u201d]{1,2})[.,](\d{2,4})$/)
  const plain = last.match(/^(\d{1,4}(?:[.,]\d)?)$/)
  if (attached) {
    glyphs = attached[1]
    digits = attached[2]
    // The 1 of a 1.5 read as an i or l and swallowed into the arrow: "vi5".
    if (/[ilI|]$/.test(glyphs) && digits.length === 1 && glyphs.length > 1) {
      glyphs = glyphs.slice(0, -1)
      digits = `1${digits}`
    }
  } else if (plain) {
    digits = plain[1]
  } else {
    return null
  }

  let i = tokens.length - 1
  // A lone 4 or 1 right before the value is the arrow, not a number: nothing
  // else sits between a name and its line on these screens.
  if (i > 0 && /^[41]$/.test(tokens[i - 1])) {
    glyphs = tokens[i - 1] + glyphs
    i--
  }
  while (i > 0 && tokens.length - 1 - i < 3 && isGlyphToken(tokens[i - 1])) {
    glyphs = tokens[i - 1] + glyphs
    i--
  }
  const before = tokens.slice(0, i)
  const hasArrow = glyphs.replace(/[@\u00ae\u00a9()]/g, "").length > 0

  if (!hasArrow) {
    const strict = digits.match(LINE_VALUE)
    if (strict) {
      const seven = digits.match(/^7(\d{1,2}(?:[.,]\d)?)$/)
      const alt = seven ? restoreDecimal(seven[1])?.value : undefined
      return { value: Number.parseFloat(strict[1]), alt, altSide: alt != null ? "OVER" : undefined, repaired: false, side: null, before, raw: last }
    }
    // An arrow read as a digit and glued on: "415" is an up arrow and 1.5,
    // "125" a down arrow and 2.5, "715" an up arrow again. Or a 41.5 that lost
    // its point. The whole number is the value and the arrow reading the
    // alternative; the stat picks between them, as it does for a 71.5.
    const glued = digits.match(/^([741])(\d{2})$/)
    if (!glued) return null
    const whole = restoreDecimal(digits)
    const alt = restoreDecimal(glued[2])
    if (!whole || !alt) return null
    return { value: whole.value, alt: alt.value, altSide: glued[1] === "1" ? "UNDER" : "OVER", repaired: true, side: null, before, raw: last }
  }
  const v = restoreDecimal(digits)
  if (!v) return null
  return { value: v.value, repaired: v.repaired, side: glyphSide(glyphs), before, raw: glyphs ? `${glyphs} ${digits}` : last }
}

/**
 * A line value: up to two digits (every basketball line, and most NFL ones), or
 * three digits WITH a decimal for NFL yardage such as 245.5. A bare three-digit
 * number is left alone, because on a board that is far more often an entry fee,
 * a payout or a count than a line.
 */
const LINE_VALUE = /^(\d{1,2}(?:\.\d)?|\d{3}\.\d)$/

/** Extract a plausible prop line from a fragment. */
export function parseLineValue(raw: string): { value: number; repaired: boolean } | null {
  const t = raw.trim()
  if (!t) return null

  const direct = t.match(LINE_VALUE)
  if (direct) {
    const v = Number.parseFloat(direct[1])
    return Number.isFinite(v) ? { value: v, repaired: false } : null
  }

  const looksNumeric = /^[\d.,OolIS|s]{1,5}$/.test(t)
  if (looksNumeric) {
    const fixed = repairNumeric(t)
    const m = fixed.match(LINE_VALUE)
    if (m) {
      const v = Number.parseFloat(m[1])
      if (Number.isFinite(v)) return { value: v, repaired: fixed !== t }
    }
  }
  return null
}

/**
 * Stats the pick'em apps post that this app does not model, mostly baseball,
 * which turns up in the same entry as basketball legs. Recognising them keeps
 * the leg, unpriced, under the label the app printed, where before "Hitter FS"
 * read as a player's name and the leg vanished, and an entry with one could
 * not be logged at all. Checked ahead of the modelled stats, so "Hitter
 * Fantasy Score" never turns into basketball's Fantasy Score.
 */
const UNMODELLED_STATS: [RegExp, string][] = [
  [/^hitter (fs|fantasy score)$/, "Hitter Fantasy Score"],
  [/^pitcher (fs|fantasy score)$/, "Pitcher Fantasy Score"],
  // OCR reads the I in RBIs as an l.
  [/^hits ?\+ ?runs ?\+ ?rb[il1]s$/, "Hits + Runs + RBIs"],
  [/^total bases$/, "Total Bases"],
  [/^pitcher strikeouts$/, "Pitcher Strikeouts"],
  [/^hitter strikeouts$/, "Hitter Strikeouts"],
  [/^hits allowed$/, "Hits Allowed"],
  [/^earned runs allowed$/, "Earned Runs Allowed"],
  [/^pitching outs$/, "Pitching Outs"],
  [/^walks allowed$/, "Walks Allowed"],
  [/^home runs$/, "Home Runs"],
  [/^stolen bases$/, "Stolen Bases"],
  [/^rb[il1]s$/, "RBIs"],
  // NHL stats the app does not price.
  [/^hits$/, "Hits"],
  [/^faceoffs won$/, "Faceoffs Won"],
  [/^time on ice$/, "Time On Ice"],
  [/^goals allowed$/, "Goals Allowed"],
]

const UNMODELLED_LABELS = new Set(UNMODELLED_STATS.map(([, label]) => label))

/** Is this a stat label the app recognises but does not model? */
export function isUnmodelledStat(label: string): boolean {
  return UNMODELLED_LABELS.has(label)
}

function isStatLine(text: string): { label: string; key: MarketKey | null } | null {
  const lower = text.replace(/[\u2122\u00ae\u00a9]/g, "").toLowerCase().trim().replace(/\s+/g, " ")
  if (!lower) return null
  // Strip a leading number so "24.5 Points" is recognised as a stat line.
  const withoutNumber = lower.replace(/^[\d.,ols|]+\s+/, "").trim()
  for (const candidate of [lower, withoutNumber]) {
    const other = UNMODELLED_STATS.find(([re]) => re.test(candidate))
    if (other) return { label: other[1], key: null }
  }
  for (const candidate of [lower, withoutNumber]) {
    if (!candidate) continue
    if (STAT_WORDS.some((w) => candidate === w || candidate.startsWith(w + " ") || candidate === w + "s")) {
      const norm = normalizeMarket(candidate)
      return { label: norm.label, key: norm.key }
    }
  }
  return null
}

/**
 * Drop tokens with no letters or digits from the ends of a line.
 *
 * OCR on dark cards often picks up a stray "." or "|" from a card edge, turning
 * "Caitlin Clark" into "Caitlin Clark ." That then fails an exact name match
 * against the odds feed, so the prop silently never prices.
 */
function trimNoise(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  while (words.length > 0 && !/[A-Za-z0-9]/.test(words[0])) words.shift()
  while (words.length > 0 && !/[A-Za-z0-9]/.test(words[words.length - 1])) words.pop()
  return words.join(" ")
}

/**
 * Could this be a player name?
 *
 * Strict mode is for OCR lines, where a board capitalises names and a stray
 * capitalised word is the main source of false positives. Lenient mode is for a
 * line someone typed, where "lebron james" is obviously a name and one word
 * ("Jokic") is common enough to accept, flagged for review.
 */
function looksLikeName(text: string, opts: { lenient?: boolean; codes?: ReadonlySet<string> } = {}): boolean {
  const t = trimNoise(text)
  if (t.length < (opts.lenient ? 3 : 4) || t.length > 40) return false
  if (/\d/.test(t)) return false
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length < (opts.lenient ? 1 : 2) || words.length > 4) return false
  for (const [idx, w] of words.entries()) {
    const bare = w.replace(/[^A-Za-z.'-]/g, "")
    if (bare.length === 0) return false
    const lower = bare.toLowerCase().replace(/[.'-]/g, "")
    if (lower.length === 0) return false
    if (NOT_NAMES.has(lower)) return false
    // Two capitals opening a name of three or more words are initials, even
    // when they spell a team: "KC Concepcion Jr.", not the Chiefs.
    const initials = idx === 0 && words.length >= 3 && /^[A-Z]{2}$/.test(bare)
    if ((opts.codes ?? BASE_TEAM_CODES).has(lower) && !initials) return false
    if (POSITIONS.has(lower)) return false
    if (SIDE_WORDS.has(lower)) return false
    // Names are capitalised on these boards; typed input may not be.
    if (!opts.lenient && bare[0] !== bare[0].toUpperCase()) return false
  }
  return true
}

function isNameLine(text: string, codes?: ReadonlySet<string>): boolean {
  return looksLikeName(text, { codes })
}

/**
 * "lebron james" -> "Lebron James", leaving already-capitalised names alone.
 * Strips punctuation a typed separator leaves on the last word ("James:"), but
 * not a full stop, which belongs to "Jr." and "P.J.".
 */
function tidyName(text: string): string {
  const t = trimNoise(text)
    .replace(/[:;,|]+$/, "")
    // OCR reads a capital I as a lowercase l: "Kiki lriafen". No name word
    // starts with l then a consonant, so that pattern is always an I.
    .replace(/(^|\s)l(?=[^aeiouyl'\s][a-z])/g, "$1I")
  if (t !== t.toLowerCase()) return t
  return t.replace(/\b([a-z])/g, (m) => m.toUpperCase())
}

/** A standalone line value, allowing a typed "o24.5" or "u8.5" prefix. */
function valueToken(tok: string): number | null {
  const m = tok.match(/^[ou]?(\d{1,2}(?:\.\d)?|\d{3}\.\d)$/i)
  if (!m) return null
  const v = Number.parseFloat(m[1])
  return Number.isFinite(v) ? v : null
}

function stripSides(tokens: string[]): string[] {
  return tokens.filter((t) => !SIDE_WORDS.has(t.toLowerCase()))
}

/**
 * The player in the text before a line value, if there is one.
 *
 * Takes the whole prefix when it reads as a name. Otherwise takes the longest
 * run of two to four name-like words at its end, so "Tue Sep 26 Anthony
 * Edwards" still yields the player. A matchup such as "IND vs CON 7:00PM"
 * yields nothing, which is right: its name is on the row above.
 */
function nameFromPrefix(prefix: string, codes?: ReadonlySet<string>): string | null {
  if (!prefix) return null
  if (looksLikeName(prefix, { lenient: true, codes })) return prefix
  const words = prefix.split(/\s+/).filter(Boolean)
  for (let k = Math.min(4, words.length - 1); k >= 2; k--) {
    const tail = words.slice(words.length - k).join(" ")
    if (looksLikeName(tail, { lenient: true, codes })) return tail
  }
  return null
}

/**
 * A line value at the end of a name row, as PrizePicks entry and lineup
 * screens print it: "Jonquel Jones  (goblin) \u2191 1.5".
 *
 * OCR reads the arrow as a "T" or a "7" and often drops the decimal point, so
 * "\u2191 1.5" arrives as "T15", "715" or "71.5", and "\u2191 0.5" as "T05".
 * Strip one arrow-like character, and if the remainder lost its decimal point,
 * put it back before the final digit. Lines on these apps end in .5 almost
 * without exception, so "15" after an arrow is 1.5, not fifteen. Every repair
 * is flagged for the review table.
 */
function loosePrefixedValue(tok: string): { value: number; repaired: boolean } | null {
  const t = tok.replace(/^[@\u00ae\u00a9]+/, "")
  const strict = t.match(LINE_VALUE)
  const arrow = t.match(/^[Tt7\u2191\u2193]+(\d{1,4}(?:\.\d)?)$/)
  if (arrow) {
    let rest = arrow[1]
    if (!rest.includes(".") && rest.length >= 2 && /[05]$/.test(rest)) rest = `${rest.slice(0, -1)}.${rest.slice(-1)}`
    const v = Number.parseFloat(rest)
    // Up to 999.5 so an NFL passing line ("T2455" -> 245.5) survives.
    if (Number.isFinite(v) && v < 1000) return { value: v, repaired: true }
  }
  if (strict) return { value: Number.parseFloat(strict[1]), repaired: t !== tok }
  return null
}

/** Drop trailing tokens that cannot be part of a name: stray glyphs, lone characters, numbers. */
function trimTrailingJunk(tokens: string[]): string[] {
  const out = [...tokens]
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (/[A-Za-z]{2,}/.test(last) && !/\d/.test(last)) break
    out.pop()
  }
  return out
}

/**
 * A row holding a player and a line but no stat: "Jonquel Jones @ T15".
 * The stat sits on the row below, beside the team and jersey number.
 */
function findNameValue(
  text: string,
  codes?: ReadonlySet<string>,
): { name: string; value: number; alt?: number; altSide?: Side; repaired: boolean; raw: string; side: Side | null } | null {
  // The arrow read as its own token ("Cade Otton J 65.5") or as letters stuck
  // to the value ("Jordan Addison U55"). Checked first: a plain "25" after an
  // arrow is 2.5 with its decimal swallowed, not twenty-five.
  const tv = trailingValue(text.trim().split(/\s+/).filter(Boolean))
  if (tv && tv.before.length > 0) {
    const name = nameFromPrefix(trimNoise(trimTrailingJunk(tv.before).join(" ")), codes)
    if (name) return { name: tidyName(name), value: tv.value, alt: tv.alt, altSide: tv.altSide, repaired: tv.repaired, raw: tv.raw, side: tv.side }
  }
  // The arrow read as a 7 stuck to the value: "Jonquel Jones 715".
  const tokens = trimNoise(text).split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null
  const raw = tokens[tokens.length - 1]
  const v = loosePrefixedValue(raw)
  if (!v) return null
  const prefix = trimTrailingJunk(tokens.slice(0, -1)).join(" ")
  const name = nameFromPrefix(trimNoise(prefix), codes)
  if (!name) return null
  return { name: tidyName(name), value: v.value, repaired: v.repaired, raw, side: glyphSide(raw.replace(/[\d.,]/g, "")) }
}

/**
 * A name with junk from a jersey or icon in front of it: "99 Brock Bowers",
 * "8 \u2018\\ Jack Bech". Leading tokens with digits, no letters, or a single
 * character are dropped, and what is left must still read as a name.
 */
function nameAfterJunk(text: string, codes?: ReadonlySet<string>): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length && (/\d/.test(words[i]) || !/[A-Za-z]{2,}/.test(words[i]))) i++
  if (i === 0 || i >= words.length) return null
  const rest = words.slice(i).join(" ")
  return looksLikeName(rest, { codes }) ? trimNoise(rest) : null
}

/** A stat at the end of a row after other text: "NYL-C- #35 Assists". */
function statSuffix(text: string): { stat: { label: string; key: MarketKey | null }; statText: string } | null {
  const tokens = trimNoise(text).split(/\s+/).filter(Boolean)
  for (let k = Math.min(4, tokens.length - 1); k >= 1; k--) {
    const statText = tokens.slice(tokens.length - k).join(" ")
    const stat = isStatLine(statText)
    if (stat && (stat.key || isUnmodelledStat(stat.label))) return { stat, statText }
  }
  return null
}

interface InlineMatch {
  value: number
  stat: { label: string; key: MarketKey | null }
  statText: string
  /** Whatever precedes the value and stat, cleaned: a name, a matchup, or nothing. */
  prefix: string
  side: Side | null
}

/**
 * Find a line value and a stat inside one line.
 *
 * Covers the layouts that put both on a single row:
 *   "24.5 Points"                        stacked boards, value then stat
 *   "LeBron James 24.5 Points"           typed, name first
 *   "LeBron James over 24.5 points"      typed with a direction
 *   "LeBron James o24.5 pts"             shorthand
 *   "LeBron James: Points 24.5"          stat before value
 *   "IND vs CON 7:00PM 8.5 Assists"      a list board whose right-aligned value
 *                                        OCR fuses onto the matchup line
 */
function findInline(text: string): InlineMatch | null {
  const tokens = trimNoise(text)
    .split(/[\s,;]+/)
    .filter((t) => t.length > 0 && !SEPARATOR.test(t))
  if (tokens.length === 0) return null
  const side = typedSide(tokens)

  for (let i = 0; i < tokens.length; i++) {
    const value = valueToken(tokens[i])
    if (value == null) continue

    // Value then stat: "24.5 Points", "LeBron James 24.5 Pts + Rebs + Asts".
    const after = stripSides(tokens.slice(i + 1))
    if (after.length > 0) {
      const statText = after.join(" ")
      const stat = isStatLine(statText)
      if (stat) {
        return { value, stat, statText, prefix: stripSides(tokens.slice(0, i)).join(" "), side }
      }
    }

    // Stat then value: "LeBron James Points 24.5". Try the longest stat suffix.
    const before = stripSides(tokens.slice(0, i))
    for (let k = Math.min(5, before.length); k >= 1; k--) {
      const statText = before.slice(before.length - k).join(" ")
      const stat = isStatLine(statText)
      if (stat) {
        return { value, stat, statText, prefix: before.slice(0, before.length - k).join(" "), side }
      }
    }
  }
  return null
}

interface Classified {
  index: number
  text: string
  confidence: number
  /** "prop" is a whole prop on one line: name, value and stat together. */
  kind: "prop" | "name" | "stat" | "number" | "namevalue" | "noise"
  stat?: { label: string; key: MarketKey | null }
  statText?: string
  number?: { value: number; repaired: boolean; alt?: number; altSide?: Side }
  name?: string
  bbox?: OcrBox
  /** Raw token a repaired line value was read from, for the review note. */
  rawValue?: string
  side?: Side | null
}

function classify(lines: OcrLine[], codes?: ReadonlySet<string>): Classified[] {
  return lines.map((l, index) => {
    const text = trimNoise(l.text)
    const confidence = (l.confidence ?? 80) / 100
    const bbox = l.bbox

    const inline = findInline(text)
    if (inline) {
      const number = { value: inline.value, repaired: false }
      const player = nameFromPrefix(inline.prefix, codes)
      if (player) {
        return {
          index, text, confidence, bbox, kind: "prop" as const,
          stat: inline.stat, statText: inline.statText, number, name: tidyName(player), side: inline.side,
        }
      }
      // Value and stat but no name on this line: a stacked card, or a list row
      // whose matchup text got fused on. The name comes from a nearby line.
      return { index, text, confidence, bbox, kind: "stat" as const, stat: inline.stat, statText: inline.statText, number }
    }

    const stat = isStatLine(text)
    if (stat) {
      // A stat line may still carry an OCR-damaged number, e.g. "24.S Points".
      const numMatch = text.match(/^([\d.,OolIS|s]{1,5})\s+/)
      const number = numMatch ? parseLineValue(numMatch[1]) : null
      return { index, text, confidence, bbox, kind: "stat" as const, stat, number: number ?? undefined }
    }
    // A value on its own, possibly behind an arrow: "tT 4.5", "wv 445", "\\ 65.5".
    const lone = trailingValue(l.text.trim().split(/\s+/).filter(Boolean))
    if (lone && lone.before.length === 0) {
      return {
        index, text, confidence, bbox, kind: "number" as const,
        number: { value: lone.value, repaired: lone.repaired, alt: lone.alt, altSide: lone.altSide }, rawValue: lone.raw, side: lone.side,
      }
    }
    const num = parseLineValue(text)
    if (num) return { index, text, confidence, bbox, kind: "number" as const, number: num }
    const nv = findNameValue(text, codes)
    if (nv) {
      return {
        index, text, confidence, bbox, kind: "namevalue" as const,
        name: nv.name, number: { value: nv.value, repaired: nv.repaired, alt: nv.alt, altSide: nv.altSide }, rawValue: nv.raw, side: nv.side,
      }
    }
    if (isNameLine(text, codes)) return { index, text, confidence, bbox, kind: "name" as const, name: tidyName(text) }
    const junkName = nameAfterJunk(text, codes)
    if (junkName) return { index, text, confidence, bbox, kind: "name" as const, name: tidyName(junkName) }
    const suffix = statSuffix(text)
    if (suffix) return { index, text, confidence, bbox, kind: "stat" as const, stat: suffix.stat, statText: suffix.statText }
    return { index, text, confidence, bbox, kind: "noise" as const }
  })
}

const cy = (b: OcrBox) => (b.y0 + b.y1) / 2
const overlapsX = (a: OcrBox, b: OcrBox) => a.x0 < b.x1 && b.x0 < a.x1

/**
 * The best line of a kind for a stat, judged by position on screen.
 *
 * Candidates must sit above or level with the stat, never below it, and within
 * a few card-heights. The one in the same column wins; failing that, the
 * closest one vertically. That handles both layouts that broke order-based
 * pairing:
 *
 *   Two-column grid: a stat has a name above it in its own column and another,
 *   equally high, in the other column. Same-column wins.
 *
 *   List with right-aligned values: the value sits level with its name but in
 *   a different column, and AUTO segmentation emits all the values after all
 *   the names. Nearest-above wins, and "below" is ruled out, so the value can
 *   never reach down to the next player.
 */
function pickByPosition(
  items: Classified[],
  stat: Classified,
  kind: "name" | "number" | "namevalue",
  used: Set<number>,
  lineHeight: number,
  maxLines: number,
): number | null {
  const box = stat.bbox
  if (!box) return null
  const statCy = cy(box)

  const inRange = items.filter((c) => {
    if (c.kind !== kind || used.has(c.index) || !c.bbox) return false
    if (cy(c.bbox) > box.y1) return false // below the stat
    return statCy - cy(c.bbox) <= maxLines * lineHeight // not too far above
  })

  // Same column is a hard rule, not a preference. A soft penalty got tuned
  // wrong: in a grid, the name sits five lines up its own card, and a stray
  // capitalised label level with the stat in the next column scored closer.
  // Only when nothing in range shares the stat's column, as on a list board
  // with right-aligned values, does position across columns decide.
  const sameColumn = inRange.filter((c) => overlapsX(c.bbox!, box))
  const pool = sameColumn.length > 0 ? sameColumn : inRange

  let best: number | null = null
  let bestDy = Infinity
  for (const c of pool) {
    const dy = Math.max(0, statCy - cy(c.bbox!))
    if (dy < bestDy) {
      bestDy = dy
      best = c.index
    }
  }
  return best
}

function medianLineHeight(items: Classified[]): number {
  const hs = items.flatMap((i) => (i.bbox ? [i.bbox.y1 - i.bbox.y0] : [])).sort((a, b) => a - b)
  return hs.length > 0 ? Math.max(1, hs[Math.floor(hs.length / 2)]) : 1
}

/**
 * Associate each detected stat with the nearest number and name.
 *
 * Boards differ in layout: PrizePicks stacks name, meta, number then stat, while
 * others put the number and stat on one line. Rather than encoding one layout,
 * this searches a small window around each stat, which handles both and degrades
 * predictably when the OCR drops a line.
 */
export function extractProps(lines: OcrLine[], hint?: { league?: LoggedLeagueId | null }): ExtractResult {
  // Resolved once per read. Without a hint this is the same set the extractor
  // has always used, so every existing caller behaves exactly as before.
  const items = classify(lines, teamCodesFor(hint?.league))
  const candidates: PropCandidate[] = []
  const used = new Set<number>()

  // Whole props on one line need no neighbours.
  for (const item of items) {
    if (item.kind !== "prop" || !item.stat || !item.number || !item.name) continue
    const issues: string[] = []
    if (!item.stat.key) issues.push(statNote(item.stat.label, item.statText ?? item.text))
    if (!item.name.includes(" ")) {
      issues.push("Only one name was given. Use the full name, or the odds feed cannot match it.")
    }
    used.add(item.index)
    candidates.push({
      player: item.name,
      marketKey: item.stat.key,
      marketLabel: item.stat.label,
      rawMarket: item.statText ?? item.text,
      line: item.number.value,
      confidence: Math.max(0.05, Math.min(1, item.confidence - issues.length * 0.15)),
      sourceLines: [item.index],
      issues,
      side: item.side ?? null,
      boost: lines[item.index]?.boost,
      outcome: outcomeOf([lines[item.index]?.outcome]),
    })
  }

  // Pair by position when OCR supplied it for every line; otherwise by order.
  const geometric = items.length > 0 && items.every((i) => i.bbox)
  const lineHeight = geometric ? medianLineHeight(items) : 1

  for (const item of items) {
    if (item.kind !== "stat" || !item.stat) continue

    const issues: string[] = []
    const sourceLines = [item.index]

    // Number: on the stat line itself, else the closest unused number within
    // two lines either side, preferring the one before.
    let number = item.number ?? null
    let name: string | null = null
    let side: Side | null = item.side ?? null

    // Name and value on the row above, as on a PrizePicks entry screen.
    if (!number) {
      let nvIndex: number | null = null
      if (geometric) nvIndex = pickByPosition(items, item, "namevalue", used, lineHeight, 3)
      else {
        for (const i of [item.index - 1, item.index - 2]) {
          if (items[i]?.kind === "namevalue" && !used.has(i)) {
            nvIndex = i
            break
          }
        }
      }
      if (nvIndex != null) {
        const nv = items[nvIndex]
        number = nv.number!
        name = nv.name!
        side = nv.side ?? side
        used.add(nvIndex)
        sourceLines.push(nvIndex)
        if (nv.number!.repaired) {
          issues.push(`Line read as "${nv.rawValue}" and taken as ${nv.number!.value}. Check it against the app.`)
        }
      }
    }

    if (!number && geometric) {
      const i = pickByPosition(items, item, "number", used, lineHeight, 3)
      if (i != null) {
        number = items[i].number!
        side = items[i].side ?? side
        used.add(i)
        sourceLines.push(i)
        if (number.repaired && items[i].rawValue) {
          issues.push(`Line read as "${items[i].rawValue}" and taken as ${number.value}. Check it against the app.`)
        }
      }
    }
    if (!number && !geometric) {
      const order = [item.index - 1, item.index + 1, item.index - 2, item.index + 2]
      for (const i of order) {
        const c = items[i]
        if (c && c.kind === "number" && !used.has(i)) {
          number = c.number!
          side = c.side ?? side
          used.add(i)
          sourceLines.push(i)
          break
        }
      }
    }
    if (!number) {
      issues.push("No line value found near this stat.")
      continue
    }
    // "71.5" beside Assists is an up-arrow read as a 7 in front of 1.5; beside
    // Receiving Yards, 71.5 is just 71.5. The stat decides.
    if (number.alt != null && item.stat.key && !plausibleLine(item.stat.key, number.value)) {
      const read = number.value
      side = number.altSide ?? side
      number = { value: number.alt, repaired: true }
      // One note about the value, not a read-as-41.5 then a read-as-1.5.
      for (let k = issues.length - 1; k >= 0; k--) if (issues[k].startsWith("Line read as")) issues.splice(k, 1)
      issues.push(`Line read as "${read}" and taken as ${number.value}, reading its first digit as the arrow. Check it against the app.`)
    }
    if (number.repaired && !name && !issues.some((m) => m.startsWith("Line read as"))) {
      issues.push("Line value needed character repair; check it.")
    }

    // Name: by position when available, else nearest unused name above, then below.
    if (!name && geometric) {
      const i = pickByPosition(items, item, "name", used, lineHeight, 8)
      if (i != null) {
        name = items[i].name ?? items[i].text
        used.add(i)
        sourceLines.push(i)
      }
    }
    for (let i = item.index - 1; !geometric && !name && i >= Math.max(0, item.index - 5); i--) {
      const c = items[i]
      if (c && c.kind === "name" && !used.has(i)) {
        name = c.name ?? c.text
        used.add(i)
        sourceLines.push(i)
        break
      }
    }
    if (!name && !geometric) {
      for (let i = item.index + 1; i <= Math.min(items.length - 1, item.index + 3); i++) {
        const c = items[i]
        if (c && c.kind === "name" && !used.has(i)) {
          name = c.name ?? c.text
          used.add(i)
          sourceLines.push(i)
          break
        }
      }
    }
    if (!name) {
      issues.push("No player name found near this stat.")
      continue
    }

    used.add(item.index)
    if (!item.stat.key) issues.push(statNote(item.stat.label, item.text))

    // "Reboot" beside the player on an entry screen: they did not play.
    const dnp = markedReboot(items, sourceLines, lineHeight, geometric)
    if (dnp) issues.push("Marked Reboot on the screenshot: the player did not play.")

    const lineConfidences = sourceLines.map((i) => items[i]?.confidence ?? 0.8)
    const base = lineConfidences.reduce((a, b) => a + b, 0) / lineConfidences.length
    const penalty = issues.filter((m) => !m.startsWith("Marked Reboot")).length * 0.15
    candidates.push({
      player: name,
      marketKey: item.stat.key,
      marketLabel: item.stat.label,
      rawMarket: item.statText ?? item.text,
      line: number.value,
      confidence: Math.max(0.05, Math.min(1, base - penalty)),
      sourceLines: sourceLines.sort((a, b) => a - b),
      issues,
      side,
      dnp,
      boost: boostOf(sourceLines.map((i) => lines[i]?.boost)),
      outcome: outcomeOf(sourceLines.map((i) => lines[i]?.outcome)),
    })
  }

  const leftover = items
    .filter((i) => !used.has(i.index) && i.kind !== "noise")
    .map((i) => ({ index: i.index, text: i.text }))

  const paired = new Set(candidates.map((c) => nameKey(c.player)))
  const unpairedNames = Array.from(
    new Set(
      items
        .filter((i) => i.kind === "name" && !used.has(i.index) && i.name)
        .map((i) => i.name!)
        .filter((n) => n.includes(" ") && !paired.has(nameKey(n))),
    ),
  )

  return { candidates: dedupe(candidates), leftover, unpairedNames }
}

/** A face on any of a candidate's lines; null if they were checked and had none; undefined if never checked. */
function boostOf(tags: (Boost | null | undefined)[]): Boost | null | undefined {
  const checked = tags.filter((t) => t !== undefined)
  return checked.find((t) => t) ?? (checked.length > 0 ? null : undefined)
}

/**
 * One outcome from a candidate's lines. The name row and the stat row both
 * cross the ring, so they normally agree; when they do not, nothing is
 * claimed, because a wrong result is worse than an empty one the person fills
 * in. Undefined when no line was read in colour.
 */
function outcomeOf(tags: (Outcome | null | undefined)[]): Outcome | null | undefined {
  const checked = tags.filter((t) => t !== undefined)
  if (checked.length === 0) return undefined
  const seen = new Set(checked.filter((t): t is Outcome => t != null))
  return seen.size === 1 ? [...seen][0] : null
}

/** Why a leg has no modelled stat: one the app does not model, or one it could not read. */
function statNote(label: string, raw: string): string {
  return isUnmodelledStat(label)
    ? `${label} is not a stat this app models. The leg is kept, unpriced.`
    : `Stat "${raw}" was not recognised.`
}

/** Could this line be posted for this stat at all? Generous: only rules out the absurd. */
function plausibleLine(key: MarketKey, value: number): boolean {
  return value <= Math.max(10, MARKETS[key].typicalMean * 4)
}

function markedReboot(items: Classified[], sourceLines: number[], lineHeight: number, geometric: boolean): boolean {
  const says = (i: Classified) => /\breboot\b/i.test(i.text)
  if (sourceLines.some((i) => items[i] && says(items[i]))) return true
  if (!geometric) return false
  const boxes = sourceLines.map((i) => items[i]?.bbox).filter((b): b is OcrBox => !!b)
  if (boxes.length === 0) return false
  const top = Math.min(...boxes.map((b) => b.y0)) - lineHeight / 2
  const bottom = Math.max(...boxes.map((b) => b.y1)) + lineHeight / 2
  return items.some((i) => i.bbox && says(i) && cy(i.bbox) >= top && cy(i.bbox) <= bottom)
}

const nameKey = (n: string) => n.toLowerCase().replace(/[^a-z]/g, "")

/** Boards repeat props across carousels; keep the highest-confidence copy. */
function dedupe(candidates: PropCandidate[]): PropCandidate[] {
  const best = new Map<string, PropCandidate>()
  for (const c of candidates) {
    const key = `${c.player.toLowerCase()}|${c.marketKey ?? c.marketLabel}|${c.line}`
    const existing = best.get(key)
    if (!existing || c.confidence > existing.confidence) best.set(key, c)
  }
  return Array.from(best.values())
}

export interface EntryHeader {
  stake: number
  /** What it pays if every leg hits: "$2 for $12". A settled entry that paid out shows what it paid instead. */
  payout: number | null
  /**
   * What the entry returned once settled: "$10 paid $5", or 0 for one marked
   * Loss. Null while it is open, or when the screen did not say.
   */
  paid: number | null
  picks: number | null
  mode: "power" | "flex" | null
}

/**
 * The stake, payout and entry type from the top of an entry screen:
 * "$2 for $12" and "3-Pick Power Play Loss", or "$3.75 to win $24.38" on an
 * entry still in play. The cleaned read turns "$" into "S", so either is
 * accepted.
 *
 * A settled entry that paid anything says so instead: "$10 paid $5". That is
 * the result, and the only trustworthy one: a 6-pick flex of goblins that hit
 * five paid half the stake back under a green Win badge, where the stored
 * table says 2x. A Loss badge means it paid nothing.
 *
 * Pass both reads of a screenshot. Each field comes from the first read that
 * has it: the raw read of one real screen turned the Loss badge into "Less",
 * and the cleaned read of the same screen got it right.
 */
export function readEntryHeader(...reads: OcrLine[][]): EntryHeader | null {
  const found = reads.map(headerFrom)
  const first = <K extends Exclude<keyof RawHeader, "lost">>(k: K): RawHeader[K] | null =>
    found.find((h) => h[k] != null)?.[k] ?? null
  const stake = first("stake")
  const payout = first("payout")
  const paid = first("paid") ?? (found.some((h) => h.lost) ? 0 : null)
  if (stake == null || !(stake > 0)) return null
  if (payout == null && paid == null) return null
  if (payout != null && !(payout > 0)) return null
  return { stake, payout, paid, picks: first("picks"), mode: first("mode") }
}

interface RawHeader {
  stake: number | null
  payout: number | null
  paid: number | null
  lost: boolean
  picks: number | null
  mode: EntryHeader["mode"]
}

function headerFrom(lines: OcrLine[]): RawHeader {
  const h: RawHeader = { stake: null, payout: null, paid: null, lost: false, picks: null, mode: null }
  for (const l of lines) {
    // An entry still in play says "$3.75 to win $24.38" rather than "$X for
    // $Y". It is the same number: the whole return if every leg hits, not the
    // profit. Read as profit, that 4-pick of two goblins would be 7.5x; read
    // as the return it is 6.5x, which is where the same night's four-goblin
    // 4-pick at "$10 for $40" (4x) puts it — each goblin cutting the 10x
    // table by about a fifth.
    const money = l.text.match(/[$S]\s?(\d{1,5}(?:\.\d{1,2})?)\s*(for|paid|to\s*win)\s*[$S]\s?(\d{1,6}(?:\.\d{1,2})?)/i)
    if (money && h.stake == null) {
      h.stake = Number.parseFloat(money[1])
      const amount = Number.parseFloat(money[3])
      if (money[2].toLowerCase() === "paid") h.paid = amount
      else h.payout = amount
    }
    const kind = l.text.match(/(\d{1,2})\s*-?\s*Pick\s+(Power|Flex)/i)
    if (kind && h.picks == null) {
      h.picks = Number.parseInt(kind[1], 10)
      h.mode = kind[2].toLowerCase() === "flex" ? "flex" : "power"
      // The result badge shares this row, and nothing else does, so "Less"
      // here is a misread Loss rather than the pick'em word.
      if (/\bl[oe]ss\b/i.test(l.text)) h.lost = true
    }
  }
  return h
}

/** Split raw OCR output into lines the extractor can work with. */
export function linesFromText(text: string): OcrLine[] {
  return text
    .split(/\r?\n/)
    .map((t) => ({ text: t.trim() }))
    .filter((l) => l.text.length > 0)
}

/**
 * Combine two reads of the same screenshot: as-is, and cleaned up.
 *
 * Neither read is right everywhere. On boards with a large line value the raw
 * read is exact and cleanup can turn 3.5 into 3.9; on entry screens with small
 * values beside icons the raw read gets nothing and cleanup recovers them. So:
 * a prop both reads agree on is kept once; a prop they disagree on keeps the
 * raw value and says so, rather than silently choosing; a prop only the
 * cleaned read found is added.
 */
export function mergeReads(primary: PropCandidate[], secondary: PropCandidate[]): PropCandidate[] {
  const out = primary.map((c) => ({ ...c, issues: [...c.issues] }))
  for (const c of secondary) {
    const existing = out.find((e) => samePlayer(e, c))
    if (!existing) {
      out.push({ ...c, issues: [...c.issues] })
      continue
    }
    // The same player read two ways: "Ga Cade Otton" and "Cade Otton", or
    // "Juszezyk" and "Juszczyk". Keep the cleaner name, and say so when the
    // spellings genuinely differ.
    if (nameKey(existing.player) !== nameKey(c.player)) {
      const pick = betterName(existing, c)
      if (!contains(existing.player, c.player) && !contains(c.player, existing.player)) {
        existing.issues.push(`The two reads spell the name "${existing.player}" and "${c.player}". Check it.`)
      }
      existing.player = pick
    }
    if (existing.line !== c.line) {
      const kept = settleDisagreement(existing, c.line)
      existing.issues.push(
        kept === existing.line
          ? `Two reads of the screenshot disagree: ${existing.line} and ${c.line}. Check it against the app.`
          : `Two reads of the screenshot disagree: ${existing.line} and ${c.line}. Took ${kept}; check it against the app.`,
      )
      existing.line = kept
      existing.confidence = Math.max(0.05, existing.confidence - 0.3)
    }
    if (existing.side == null) existing.side = c.side ?? null
    else if (c.side && c.side !== existing.side) existing.side = null
    if (existing.boost === undefined || (existing.boost === null && c.boost)) existing.boost = c.boost
    // The same rule across the two reads: a colour one read saw and the other
    // missed is kept; two reads that disagree claim nothing.
    if (existing.outcome === undefined || (existing.outcome === null && c.outcome)) existing.outcome = c.outcome
    else if (existing.outcome && c.outcome && existing.outcome !== c.outcome) existing.outcome = null
    if (c.dnp && !existing.dnp) {
      existing.dnp = true
      existing.issues.push("Marked Reboot on the screenshot: the player did not play.")
    }
  }
  return out
}

/**
 * Which of two reads of one line value to keep. The as-is read wins by
 * default, except where it is plainly the one that lost its decimal point:
 *
 *   - it is impossible for the stat and the other read is not: 35 rebounds
 *     beside 3.5;
 *   - the two are the same digits and only the other has a point, at .5: 25
 *     and 2.5. Lines end in .5 almost without exception; the whole-number
 *     ones that do exist (Pts+Rebs 33) never lose to a 3.3.
 */
function settleDisagreement(existing: PropCandidate, other: number): number {
  const a = existing.line
  const key = existing.marketKey
  if (key) {
    const okA = plausibleLine(key, a)
    const okB = plausibleLine(key, other)
    if (okA !== okB) return okA ? a : other
  }
  const digits = (v: number) => String(v).replace(".", "")
  if (digits(a) === digits(other) && Number.isInteger(a) && other % 1 === 0.5) return other
  return a
}

const words = (n: string) => n.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean)

/** Is b's name a run of words inside a's? "Ga Cade Otton" contains "Cade Otton". */
function contains(a: string, b: string): boolean {
  const wa = words(a)
  const wb = words(b)
  if (wb.length < 2 || wb.length > wa.length) return false
  for (let i = 0; i + wb.length <= wa.length; i++) {
    if (wb.every((w, j) => wa[i + j] === w)) return true
  }
  return false
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

function samePlayer(a: PropCandidate, b: PropCandidate): boolean {
  if ((a.marketKey ?? a.marketLabel) !== (b.marketKey ?? b.marketLabel)) return false
  const ka = nameKey(a.player)
  const kb = nameKey(b.player)
  if (ka === kb) return true
  if (contains(a.player, b.player) || contains(b.player, a.player)) return true
  // A one- or two-letter misread in a long name, on the same line: same player.
  return a.line === b.line && Math.min(ka.length, kb.length) >= 8 && editDistance(ka, kb) <= 2
}

function betterName(a: PropCandidate, b: PropCandidate): string {
  if (contains(a.player, b.player)) return b.player
  if (contains(b.player, a.player)) return a.player
  return b.confidence > a.confidence ? b.player : a.player
}
