/**
 * Five-field cron schedules, read against a wall clock in a named timezone:
 *
 *   minute  hour  day-of-month  month  day-of-week
 *   45      5     *             *      1-5          weekdays at 5:45
 *
 * Lists (1,15), ranges (1-5), steps (0 8-22/2) and names (MON, JAN) work. A
 * leading CRON_TZ=Area/City sets the zone for that one schedule. As in cron,
 * when both day fields are restricted a day matching either one counts.
 */
import { addDays, clockText, isTimeZone, localParts, parseDate, weekdayOf, zonedTime, type LocalParts } from './time.ts'

export interface CronSpec {
  minutes: number[]
  hours: number[]
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domAny: boolean
  dowAny: boolean
  /** From a CRON_TZ= prefix. */
  timezone: string | null
  source: string
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function parseField(text: string, min: number, max: number, names: string[] | null, label: string): { values: number[]; any: boolean } {
  const values = new Set<number>()
  let any = false
  const number = (raw: string): number => {
    const named = names ? names.indexOf(raw.toLowerCase().slice(0, 3)) : -1
    // Names are 0-based for days and 1-based for months.
    const n = named >= 0 && /^[a-z]+$/i.test(raw) ? named + (min === 1 ? 1 : 0) : Number(raw)
    if (!Number.isInteger(n) || !/^\d+$|^[a-z]+$/i.test(raw)) throw new Error(`"${raw}" is not a ${label}`)
    return n
  }
  for (const part of text.split(',')) {
    if (!part) throw new Error(`The ${label} field has an empty entry`)
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${part}" has a step that is not a whole number above zero`)
    let from: number
    let to: number
    if (range === '*') {
      from = min
      to = max
      if (stepText === undefined) any = true
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      from = number(a)
      to = number(b)
    } else {
      from = number(range)
      to = stepText === undefined ? from : max
    }
    // Day-of-week 7 is Sunday too.
    const top = label === 'day of the week' ? 7 : max
    if (from < min || to > top || from > to) throw new Error(`"${part}" is outside ${min}-${max} for the ${label}`)
    for (let v = from; v <= to; v += step) values.add(label === 'day of the week' ? v % 7 : v)
  }
  return { values: [...values].sort((a, b) => a - b), any }
}

/** Read a schedule. Throws with a sentence saying what is wrong. */
export function parseCron(expr: string): CronSpec {
  let text = String(expr ?? '').trim()
  let timezone: string | null = null
  const tz = /^(?:CRON_)?TZ=(\S+)\s+/.exec(text)
  if (tz) {
    if (!isTimeZone(tz[1])) throw new Error(`"${tz[1]}" is not a timezone. Use a name like America/Los_Angeles.`)
    timezone = tz[1]
    text = text.slice(tz[0].length)
  }
  const fields = text.split(/\s+/).filter(Boolean)
  if (fields.length !== 5) {
    throw new Error(`A schedule has five fields (minute hour day-of-month month day-of-week), for example "45 5 * * 1-5". This one has ${fields.length}.`)
  }
  const minutes = parseField(fields[0], 0, 59, null, 'minute')
  const hours = parseField(fields[1], 0, 23, null, 'hour')
  const dom = parseField(fields[2], 1, 31, null, 'day of the month')
  const months = parseField(fields[3], 1, 12, MONTH_NAMES, 'month')
  const dow = parseField(fields[4], 0, 6, DAY_NAMES, 'day of the week')
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: new Set(dom.values),
    months: new Set(months.values),
    daysOfWeek: new Set(dow.values),
    domAny: dom.any,
    dowAny: dow.any,
    timezone,
    source: text,
  }
}

function dayMatches(spec: CronSpec, p: { month: number; day: number; weekday: number }): boolean {
  if (!spec.months.has(p.month)) return false
  const dom = spec.daysOfMonth.has(p.day)
  const dow = spec.daysOfWeek.has(p.weekday)
  if (spec.domAny && spec.dowAny) return true
  if (spec.domAny) return dow
  if (spec.dowAny) return dom
  return dom || dow
}

export function cronMatches(spec: CronSpec, p: LocalParts): boolean {
  return dayMatches(spec, p) && spec.hours.includes(p.hour) && spec.minutes.includes(p.minute)
}

/**
 * The first time after `after` that the schedule fires, or null if it never
 * does (February 30th). Times a clock change skips are skipped.
 */
export function nextRun(spec: CronSpec, tz: string, after: Date): Date | null {
  const zone = spec.timezone ?? tz
  const start = localParts(after, zone)
  let day = `${String(start.year).padStart(4, '0')}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`
  // Four years covers February 29th.
  for (let i = 0; i < 366 * 4 + 2; i++, day = addDays(day, 1)) {
    const p = parseDate(day)!
    if (!dayMatches(spec, { month: p.month, day: p.day, weekday: weekdayOf(day) })) continue
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const at = zonedTime({ ...p, hour, minute }, zone)
        if (at && at.getTime() > after.getTime()) return at
      }
    }
  }
  return null
}

const ORDINAL = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`
const DAY_LABELS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

/** A schedule in words, for the common shapes: "Weekdays at 5:45 AM". Anything else comes back as written. */
export function describeCron(expr: string): string {
  let spec: CronSpec
  try {
    spec = parseCron(expr)
  } catch {
    return expr
  }
  const zone = spec.timezone ? ` (${spec.timezone})` : ''
  const dows = [...spec.daysOfWeek].sort((a, b) => a - b)
  let days: string
  if (spec.domAny && spec.dowAny) days = 'Every day'
  else if (spec.domAny) {
    if (dows.join() === '1,2,3,4,5') days = 'Weekdays'
    else if (dows.join() === '0,6') days = 'Weekends'
    else days = dows.map(d => DAY_LABELS[d]).join(', ')
  } else if (spec.dowAny) {
    days = `On the ${[...spec.daysOfMonth].sort((a, b) => a - b).map(ORDINAL).join(' and ')}`
  } else return expr
  if (spec.months.size !== 12) return expr

  if (spec.hours.length === 1 && spec.minutes.length === 1) return `${days} at ${clockText(spec.hours[0] * 60 + spec.minutes[0])}${zone}`
  if (spec.minutes.length === 1 && spec.hours.length > 1) {
    const gaps = new Set(spec.hours.slice(1).map((h, i) => h - spec.hours[i]))
    const first = clockText(spec.hours[0] * 60 + spec.minutes[0])
    const last = clockText(spec.hours[spec.hours.length - 1] * 60 + spec.minutes[0])
    if (gaps.size === 1) {
      const gap = [...gaps][0]
      const every = gap === 1 ? 'every hour' : `every ${gap} hours`
      return spec.hours.length === 24 / gap ? `${days}, ${every}${zone}` : `${days}, ${every} from ${first} to ${last}${zone}`
    }
    if (spec.hours.length <= 4) return `${days} at ${spec.hours.map(h => clockText(h * 60 + spec.minutes[0])).join(', ')}${zone}`
  }
  if (spec.hours.length === 24 && spec.minutes.length > 1) {
    const gaps = new Set(spec.minutes.slice(1).map((m, i) => m - spec.minutes[i]))
    if (gaps.size === 1) return `${days}, every ${[...gaps][0]} minutes${zone}`
  }
  return expr
}
