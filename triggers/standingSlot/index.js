// Standing-slot finder. P said something like "weekly couples dinner Mon/Tue" (an 'intent'
// observation). For the next two weeks, find evenings on the allowed weekdays where P has
// nothing on and a candidate friend F also has nothing on. Pure calendar math; the Judge
// decides whether tonight's match is worth a nudge. We never claim a friend is free when we
// have no view of their calendar: those friends are reported as `unknownFriends`.
const DAYS_AHEAD = 14
const INTENT_DAYS = 60
const MAX_PER_INTENT = 2
const DEFAULT_START = 18, DEFAULT_END = 22
const HOSTY = /dinner|host|weekly|every (mon|tue|wed|thu|fri|sat|sun)/i
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_RE = /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|sday|nesday|rsday|urday)?s?\b/gi

export default {
  id: 'standingSlot',
  name: 'Standing slot finder',
  intervalMin: 720,
  runCron(ctx) {
    const now = new Date()
    const out = []
    for (const p of ctx.people.all()) {
      const intents = ctx.observations.recent(p.id, { kinds: ['intent'], since: new Date(now - INTENT_DAYS * 864e5).toISOString(), limit: 50 })
        .filter(o => o.data && (o.data.kind === 'host' || HOSTY.test(o.data.text || '')))
        .filter(o => !o.until || o.until > now.toISOString())
      if (!intents.length) continue
      const friends = ctx.people.friendsOf(p.id)
      const wantMore = friends.filter(f => f.want_more || ctx.people.rel(f.id, p.id)?.want_more)
      const today = localYmd(now, p.tz)
      for (const it of intents) {
        const { days, start, end } = parseWindow(it.data)
        const cands = it.data.people?.length
          ? it.data.people.map(id => friends.find(f => f.id === id) || ctx.people.get(id)).filter(Boolean)
          : wantMore
        if (!cands.length) continue
        const pairs = []
        for (let d = 0; d < DAYS_AHEAD; d++) {
          const ymd = addDays(today, d)
          const wd = weekdayOf(ymd)
          if (!days.includes(wd)) continue
          const s = zoned(ymd, start, p.tz), e = zoned(ymd, end, p.tz)
          if (s <= now) continue
          const mine = calendar(ctx, p.id, s, e)
          if (mine.busy.length) continue
          const free = [], unknown = []
          for (const f of cands) {
            if (!calendarKnown(ctx, f)) { unknown.push(f); continue }
            if (calendar(ctx, f.id, s, e).busy.length) continue
            free.push(f)
          }
          for (const f of free) pairs.push({ it, p, f, ymd, wd, d, s, e, free, unknown, myAllDay: mine.allDay })
        }
        for (const pr of pick(pairs)) out.push(opp(pr, { start, end, days }))
      }
    }
    return out
  },
}

// Up to MAX_PER_INTENT (slot, friend) pairs, preferring distinct dates so two friends free the
// same night don't crowd out next week.
function pick(pairs) {
  const chosen = []
  for (const pr of pairs) {
    if (chosen.length >= MAX_PER_INTENT) break
    if (!chosen.some(c => c.ymd === pr.ymd)) chosen.push(pr)
  }
  for (const pr of pairs) {
    if (chosen.length >= MAX_PER_INTENT) break
    if (!chosen.includes(pr)) chosen.push(pr)
  }
  return chosen
}

function opp({ it, p, f, ymd, wd, d, s, e, free, unknown, myAllDay }, { start, end, days }) {
  const others = free.filter(x => x.id !== f.id).map(x => x.display_name)
  const daysLabel = days.length === 7 ? 'any evening' : `${days.map(i => DAY[i]).join('/')} evenings`
  const date = fmtDate(ymd)
  const slotLabel = d === 0 ? `Tonight (${date})` : d === 1 ? `Tomorrow (${date})` : `${d < 7 ? 'This' : 'Next'} ${DAY[wd]} (${date})`
  let summary = `${p.display_name} wants "${it.data.text || it.data.kind}" (${daysLabel}). ${slotLabel}, ${fmtHour(start)}–${fmtHour(end)}, both ${p.display_name} and ${f.display_name} look free`
  if (others.length) summary += `, as ${others.length === 1 ? 'does' : 'do'} ${others.join(', ')}`
  summary += '.'
  if (unknown.length) summary += ` ${unknown.map(x => x.display_name).join(', ')} ${unknown.length === 1 ? 'hasn\'t' : 'haven\'t'} connected a calendar, so unknown.`
  if (myAllDay.length) summary += ` (${p.display_name} has all-day: ${myAllDay.join(', ')}.)`
  return {
    kind: 'standingSlot',
    participants: [p.id, f.id],
    primary: p.id,
    summary,
    evidence: {
      intentText: it.data.text || null,
      intentKind: it.data.kind || null,
      slot: { date: ymd, weekday: DAY[wd], start: s.toISOString(), end: e.toISOString(), tz: p.tz },
      freeFriends: free.map(x => x.display_name),
      unknownFriends: unknown.map(x => x.display_name),
      primaryAllDayEvents: myAllDay,
    },
    dedupeKey: `slot:${p.id}:${f.id}:${ymd}`,
    expiresAt: s.toISOString(),
  }
}

// Events overlapping [s, e) for one person, split into blocking (`busy`) and all-day
// (holidays, birthdays, "OOO" banners: shown to the Judge, not treated as blocking).
function calendar(ctx, personId, s, e) {
  const tz = ctx.people.get(personId)?.tz
  const busy = [], allDay = []
  for (const ev of ctx.observations.eventsIn(personId, s.toISOString(), e.toISOString())) {
    if (ev.data?.busy === false) continue
    if (String(ev.data?.status || '').toUpperCase() === 'CANCELLED') continue
    if (isAllDay(ev, tz)) allDay.push(ev.data.title)
    else busy.push(ev)
  }
  return { busy, allDay }
}

// We only know someone's evenings if some event-producing source is connected, or events
// have been pushed for them (federation /observe, seed). Location-only people are unknown.
function calendarKnown(ctx, f) {
  const hasSource = ctx.sources.forPerson(f.id).some(sc => sc.enabled && (ctx.plugins.sources[sc.source_id]?.kinds || []).includes('event'))
  return hasSource || !!ctx.observations.latest(f.id, 'event')
}

function parseWindow(data) {
  const w = data.window || {}
  let days = normDays(w.days)
  if (!days) days = daysFromText(data.text || '')
  if (!days.length) days = [0, 1, 2, 3, 4, 5, 6]
  const start = Number.isInteger(w.start) && w.start >= 0 && w.start < 24 ? w.start : DEFAULT_START
  const end = Number.isInteger(w.end) && w.end > start && w.end <= 24 ? w.end : Math.max(start + 1, DEFAULT_END)
  return { days, start, end }
}
function normDays(list) {
  if (!Array.isArray(list) || !list.length) return null
  const out = new Set()
  for (const x of list) {
    if (Number.isInteger(x) && x >= 0 && x <= 6) out.add(x)
    else if (typeof x === 'string') { const i = DAY.findIndex(d => x.toLowerCase().startsWith(d.toLowerCase())); if (i >= 0) out.add(i) }
  }
  return out.size ? [...out].sort() : null
}
function daysFromText(text) {
  const out = new Set()
  if (/\bweekends?\b/i.test(text)) { out.add(0); out.add(6) }
  if (/\bweek(days?|nights?)\b/i.test(text)) for (const i of [1, 2, 3, 4, 5]) out.add(i)
  if (/\b(every ?day|daily|any (night|evening|day))\b/i.test(text)) for (let i = 0; i < 7; i++) out.add(i)
  for (const m of text.matchAll(DAY_RE)) out.add(DAY.findIndex(d => m[1].toLowerCase().startsWith(d.toLowerCase())))
  return [...out].sort()
}

// ---- time helpers: everything is reasoned about in P's tz ----
const partsIn = (date, tz) => {
  const o = {}
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date)) o[p.type] = p.value
  return o
}
const localYmd = (date, tz) => { const o = partsIn(date, tz); return `${o.year}-${o.month}-${o.day}` }
const tzOffsetMin = (date, tz) => {
  const o = partsIn(date, tz)
  return (Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - date.getTime()) / 60e3
}
// 'YYYY-MM-DD' + hour in tz → instant. Two passes so DST transition days land right.
function zoned(ymd, hour, tz) {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour)
  let off = tzOffsetMin(new Date(guess), tz)
  let t = guess - off * 60e3
  const off2 = tzOffsetMin(new Date(t), tz)
  if (off2 !== off) t = guess - off2 * 60e3
  return new Date(t)
}
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) }
const weekdayOf = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
const fmtDate = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) }
const fmtHour = h => h === 0 || h === 24 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`
const isAllDay = (ev, tz) => {
  if (!ev.until) return false
  if (new Date(ev.until) - new Date(ev.at) < 23 * 3600e3) return false
  const o = partsIn(new Date(ev.at), tz)
  return (+o.hour % 24) === 0 && o.minute === '00'
}
