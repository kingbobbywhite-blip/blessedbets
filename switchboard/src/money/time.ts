/**
 * Clock arithmetic in a named timezone. A trading day, a daily loss limit and
 * a 5:45 brief are all facts about a wall clock somewhere, not about UTC, and
 * the hub may run on a machine set to a different zone than the one you trade in.
 */

export interface LocalParts {
  year: number
  /** 1 to 12. */
  month: number
  day: number
  /** 0 to 23. */
  hour: number
  minute: number
  second: number
  /** 0 Sunday to 6 Saturday. */
  weekday: number
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    formatters.set(tz, f)
  }
  return f
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The zone this machine is set to. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** What a clock on the wall in `tz` reads at `date`. */
export function localParts(date: Date, tz: string): LocalParts {
  const out: Record<string, string> = {}
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday),
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

export function dateString(p: { year: number; month: number; day: number }): string {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** YYYY-MM-DD on the wall clock in `tz`. */
export function localDate(date: Date, tz: string): string {
  return dateString(localParts(date, tz))
}

export function parseDate(day: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const d = Number(m[3])
  const check = new Date(Date.UTC(year, month - 1, d))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== d) return null
  return { year, month, day: d }
}

/** Calendar arithmetic on a date string; no timezone involved. */
export function addDays(day: string, n: number): string {
  const p = parseDate(day)
  if (!p) throw new Error(`Not a date: ${day}`)
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n))
  return dateString({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() })
}

/** 0 Sunday to 6 Saturday. */
export function weekdayOf(day: string): number {
  const p = parseDate(day)
  if (!p) throw new Error(`Not a date: ${day}`)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/** The Monday of the week `day` is in. */
export function weekStart(day: string): string {
  const w = weekdayOf(day)
  return addDays(day, w === 0 ? -6 : 1 - w)
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`
}

export function yearStart(day: string): string {
  return `${day.slice(0, 4)}-01-01`
}

/** Minutes after midnight for "HH:MM", or null. */
export function parseClock(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * The instant at which a wall clock in `tz` reads the given time. Null when it
 * never does (the hour a spring clock change skips). When it reads it twice
 * (the hour an autumn change repeats), the first of the two.
 */
export function zonedTime(p: { year: number; month: number; day: number; hour?: number; minute?: number }, tz: string): Date | null {
  const hour = p.hour ?? 0
  const minute = p.minute ?? 0
  const wanted = Date.UTC(p.year, p.month - 1, p.day, hour, minute)
  const offsetAt = (instant: number) => {
    const l = localParts(new Date(instant), tz)
    return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - Math.floor(instant / 1000) * 1000
  }
  const candidates = new Set<number>()
  // The offset on either side of any change within a day of the wanted time.
  for (const probe of [wanted - 86_400_000, wanted, wanted + 86_400_000]) candidates.add(wanted - offsetAt(probe))
  const hits = [...candidates]
    .filter(instant => {
      const l = localParts(new Date(instant), tz)
      return l.year === p.year && l.month === p.month && l.day === p.day && l.hour === hour && l.minute === minute
    })
    .sort((a, b) => a - b)
  return hits.length ? new Date(hits[0]) : null
}

/** Midnight at the start of `day` in `tz`. Days always have a midnight or, failing that, a first minute. */
export function startOfDay(day: string, tz: string): Date {
  const p = parseDate(day)
  if (!p) throw new Error(`Not a date: ${day}`)
  for (let minute = 0; minute < 180; minute += 15) {
    const t = zonedTime({ ...p, hour: Math.floor(minute / 60), minute: minute % 60 }, tz)
    if (t) return t
  }
  return new Date(Date.UTC(p.year, p.month - 1, p.day))
}

/**
 * How far a trading day runs ahead of the calendar. With day_start "18:00" the
 * evening session belongs to the next day's date, so six hours.
 */
function sessionShiftMs(dayStart: string): number {
  const minutes = parseClock(dayStart) ?? 0
  return minutes === 0 ? 0 : (24 * 60 - minutes) * 60_000
}

/** The trading day `date` belongs to, as YYYY-MM-DD. */
export function tradingDay(date: Date, tz: string, dayStart = '00:00'): string {
  return localDate(new Date(date.getTime() + sessionShiftMs(dayStart)), tz)
}

/** The instants a trading day starts and ends (end not included). */
export function tradingDayBounds(day: string, tz: string, dayStart = '00:00'): { start: Date; end: Date } {
  const shift = sessionShiftMs(dayStart)
  return {
    start: new Date(startOfDay(day, tz).getTime() - shift),
    end: new Date(startOfDay(addDays(day, 1), tz).getTime() - shift),
  }
}

/** Whether the wall clock in `tz` is inside a window. A window may run past midnight ("18:00" to "02:00"). */
export function inWindow(date: Date, tz: string, window: { start: string; end: string; days?: number[] }): boolean {
  const start = parseClock(window.start)
  const end = parseClock(window.end)
  if (start === null || end === null) return true
  const l = localParts(date, tz)
  const now = l.hour * 60 + l.minute
  const overnight = end <= start
  const inside = overnight ? now >= start || now < end : now >= start && now < end
  if (!inside) return false
  if (!window.days?.length) return true
  // After midnight in an overnight window, the session is the one that began yesterday.
  const sessionDay = overnight && now < end ? (l.weekday + 6) % 7 : l.weekday
  return window.days.includes(sessionDay)
}

/** "6:30 AM" for 390. */
export function clockText(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`
}

/** "Mon Nov 16, 5:45 AM" on the wall clock in `tz`. */
export function localLabel(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

/** Whole days from one date string to another. */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from)
  const b = parseDate(to)
  if (!a || !b) throw new Error('Not a date')
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000)
}
