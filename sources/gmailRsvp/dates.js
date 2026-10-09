// Date parsing for event emails. Pure functions, no deps.
// The hard part: emails say "Saturday, October 18 · 7:00 PM PDT" with no year and an
// abbreviation for a zone. We resolve wall-clock time in a named IANA zone with Intl.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 }
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const WEEKDAY_RE = '(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s+)?'

// Common zone abbreviations → IANA. An abbreviation in the email beats person.tz.
export const TZ_ABBR = {
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago',
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York',
  akst: 'America/Anchorage', akdt: 'America/Anchorage', hst: 'Pacific/Honolulu',
  gmt: 'UTC', utc: 'UTC', bst: 'Europe/London', wet: 'Europe/Lisbon', west: 'Europe/Lisbon',
  cet: 'Europe/Berlin', cest: 'Europe/Berlin', eet: 'Europe/Athens', eest: 'Europe/Athens',
  ist: 'Asia/Kolkata', jst: 'Asia/Tokyo', aest: 'Australia/Sydney', aedt: 'Australia/Sydney',
}
const TZ_RE = '\\(?\\b(' + Object.keys(TZ_ABBR).sort((a, b) => b.length - a.length).join('|') + ')\\b\\)?'

// Offset (ms) of `tz` from UTC at instant `ts`. Positive = ahead of UTC.
export function tzOffsetMs(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map(x => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return asUtc - Math.floor(ts / 1000) * 1000
}

export function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// Wall-clock { y, m (0-based), d, hh, mm } in `tz` → Date (UTC instant). Two-pass for DST edges.
export function zonedToDate({ y, m, d, hh = 0, mm = 0 }, tz) {
  const guess = Date.UTC(y, m, d, hh, mm)
  let utc = guess - tzOffsetMs(guess, tz)
  const off2 = tzOffsetMs(utc, tz)
  if (guess - off2 !== utc) utc = guess - off2
  return new Date(utc)
}

// Resolve a named zone from an abbreviation found in text, else null.
export function tzFromText(text) {
  const m = (text || '').match(new RegExp(TZ_RE, 'i'))
  return m ? TZ_ABBR[m[1].toLowerCase()] : null
}

const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?'
const SEP = '\\s*(?:-|–|—|to|until|till)\\s*'

function toHour(h, ampm, defaultPm) {
  h = +h
  const ap = (ampm || '').replace(/\./g, '').toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  else if (ap === 'am' && h === 12) h = 0
  else if (!ap && defaultPm && h < 12) h += 12   // "7 - 9pm": first hour inherits pm
  return h
}

// Pick a year when the email omits one: the year of `ref`, bumped if that lands >60 days in the past
// (invites are for the future; a reminder might reference something a few weeks back).
function inferYear(m, d, ref) {
  const r = ref ? new Date(ref) : new Date()
  let y = r.getUTCFullYear()
  const cand = Date.UTC(y, m, d)
  if (cand < r.getTime() - 60 * 864e5) y += 1
  else if (cand > r.getTime() + 300 * 864e5) y -= 1
  return y
}

// Find the first "date (+ optional time range)" in `text`.
// Returns { start: Date, end: Date|null, allDay: bool, tz } or null.
export function parseWhen(text, { tz = 'UTC', ref } = {}) {
  if (!text) return null
  if (!validTz(tz)) tz = 'UTC'
  const t = text.replace(/ /g, ' ').replace(/[·•|@]/g, ' ').replace(/\s+/g, ' ')

  // Form A: "Saturday, October 18[, 2026] [at|from] 7:00 PM [- 10:00 PM] [PDT]"
  const A = new RegExp(WEEKDAY_RE + MONTH_RE + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?(?:,|\\s+at|\\s+from)?\\s*(?:' + TIME + '(?:' + SEP + TIME + ')?)?\\s*(?:' + TZ_RE + ')?', 'ig')
  // Form B: "18 October 2026, 19:00" (European)
  const B = new RegExp(WEEKDAY_RE + '(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH_RE + '\\.?(?:\\s+(\\d{4}))?(?:,|\\s+at|\\s+from)?\\s*(?:' + TIME + '(?:' + SEP + TIME + ')?)?\\s*(?:' + TZ_RE + ')?', 'ig')
  // Form C: numeric "10/18/2026 7:00 PM" (US)
  const C = new RegExp('\\b(\\d{1,2})/(\\d{1,2})/(\\d{4})(?:,|\\s+at)?\\s*(?:' + TIME + '(?:' + SEP + TIME + ')?)?\\s*(?:' + TZ_RE + ')?', 'ig')

  const candidates = []
  for (const m of t.matchAll(A)) candidates.push(build({ mon: m[1], day: m[2], year: m[3], h1: m[4], m1: m[5], ap1: m[6], h2: m[7], m2: m[8], ap2: m[9], abbr: m[10] }, m.index))
  for (const m of t.matchAll(B)) candidates.push(build({ day: m[1], mon: m[2], year: m[3], h1: m[4], m1: m[5], ap1: m[6], h2: m[7], m2: m[8], ap2: m[9], abbr: m[10] }, m.index))
  for (const m of t.matchAll(C)) candidates.push(build({ monNum: m[1], day: m[2], year: m[3], h1: m[4], m1: m[5], ap1: m[6], h2: m[7], m2: m[8], ap2: m[9], abbr: m[10] }, m.index))
  const ok = candidates.filter(Boolean).sort((a, b) => a.index - b.index)
  if (!ok.length) return null
  // prefer the first candidate that carries a time; otherwise the first date (all-day)
  return ok.find(c => !c.allDay) || ok[0]

  function build(g, index) {
    const m = g.monNum != null ? +g.monNum - 1 : MONTHS[g.mon.toLowerCase().slice(0, 3)]
    const d = +g.day
    if (m == null || m < 0 || m > 11 || d < 1 || d > 31) return null
    const y = g.year ? +g.year : inferYear(m, d, ref)
    const zone = g.abbr ? TZ_ABBR[g.abbr.toLowerCase()] : tz
    if (g.h1 == null) return { start: zonedToDate({ y, m, d }, zone), end: null, allDay: true, tz: zone, index }
    const hh1 = toHour(g.h1, g.ap1, !g.ap1 && g.ap2 && /p/i.test(g.ap2) && +g.h1 < 12 && +g.h1 <= (+g.h2 || 12))
    if (hh1 > 23 || +(g.m1 || 0) > 59) return null
    const start = zonedToDate({ y, m, d, hh: hh1, mm: +(g.m1 || 0) }, zone)
    let end = null
    if (g.h2 != null) {
      const hh2 = toHour(g.h2, g.ap2 || (g.ap1 && +g.h2 < 12 && +g.h2 >= hh1 % 12 ? g.ap1 : null), false)
      if (hh2 <= 23 && +(g.m2 || 0) <= 59) {
        end = zonedToDate({ y, m, d, hh: hh2, mm: +(g.m2 || 0) }, zone)
        if (end <= start) end = new Date(end.getTime() + 864e5)   // crosses midnight
      }
    }
    return { start, end, allDay: false, tz: zone, index }
  }
}

// Google Calendar subject: "Invitation: Dinner @ Sat Oct 18, 2026 7pm - 9pm (PDT) (malcolm@x.com)"
// Also handles multi-day "Fri Oct 17, 2026 7pm - Sat Oct 18, 2026 9am" and all-day "Sat Oct 18, 2026".
export function parseGoogleSubjectWhen(whenPart, { tz = 'UTC', ref } = {}) {
  if (!whenPart) return null
  const abbr = tzFromText(whenPart)
  const zone = abbr || (validTz(tz) ? tz : 'UTC')
  const clean = whenPart.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const halves = clean.split(/\s+[-–—]\s+/)
  const first = parseWhen(halves[0], { tz: zone, ref })
  if (!first) return null
  if (halves.length < 2) return first
  const second = halves[1]
  // second half may be just a time ("9pm") or a full date-time
  let end = parseWhen(second, { tz: zone, ref })?.start
  if (!end || /^\s*\d{1,2}(:\d{2})?\s*(am|pm)?\s*$/i.test(second)) {
    const tm = second.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
    if (tm) {
      const hh = toHour(tm[1], tm[3], false)
      const s = first.start
      const parts = partsIn(s, zone)
      end = zonedToDate({ ...parts, hh, mm: +(tm[2] || 0) }, zone)
      if (end <= s) end = new Date(end.getTime() + 864e5)
    }
  }
  return { ...first, end: end || first.end }
}

export function partsIn(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]))
  return { y: +p.year, m: +p.month - 1, d: +p.day }
}
