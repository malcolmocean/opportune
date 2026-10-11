// Whereabouts inference for tweets: LLM batch when available, regex fallback otherwise.
// Output per tweet id: { place: string|null, window: { start, end }|null, kind: 'travel'|'event'|'hangout'|null }

const BATCH = 20
const KINDS = new Set(['travel', 'event', 'hangout'])

export async function inferBatch(ctx, tweets, { tz, personId } = {}) {
  const out = {}
  if (!tweets.length) return out
  if (ctx.llm?.enabled) {
    for (let i = 0; i < tweets.length; i += BATCH) {
      const chunk = tweets.slice(i, i + BATCH)
      let res = null
      try { res = await llmInfer(ctx, chunk, tz, personId) } catch (e) { ctx.log?.('tweets').warn('llm inference failed, falling back to regex:', e.message) }
      for (const t of chunk) out[t.id] = res ? clean(res[t.id]) : regexInfer(t.text, t.createdAt, tz)
    }
    return out
  }
  for (const t of tweets) out[t.id] = regexInfer(t.text, t.createdAt, tz)
  return out
}

const SYSTEM = `You extract whereabouts and plans from a person's tweets.
For each tweet decide whether it reveals where the author is, will be, or plans to be: travel ("landing in NYC Thursday", "in SF this week"), attending a specific event ("anyone at the Vulfpeck show tonight?"), or looking to meet people ("SF friends, who's around this weekend?").
Be conservative: report a place only when fairly confident the author is physically there or going there. Not when they discuss a city abstractly, quote news, or talk about someone else's travel.
Resolve relative times ("tonight", "this weekend", "Thursday", "Oct 14-18") against each tweet's created_at in the given timezone. If the author says they are somewhere now with no end, use the tweet day through 3 days later. "This week" runs through Sunday.
Respond with one JSON object keyed by tweet id. Include only tweets that reveal something; omit the rest (an empty object {} is fine).
Each value: { "place": "City" or "Neighborhood, City" with abbreviations expanded (SF -> San Francisco, NYC -> New York) or null, "window": { "start": ISO 8601 with offset, "end": ISO 8601 with offset } or null, "kind": "travel" | "event" | "hangout" | null }`

async function llmInfer(ctx, chunk, tz, personId) {
  const user = { timezone: tz || 'UTC', tweets: chunk.map(t => ({ id: t.id, created_at: t.createdAt, text: t.text })) }
  const res = await ctx.llm.json({ system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(user, null, 1) }], maxTokens: 2048 }, { personId, process: 'source:tweets' })
  if (!res || typeof res !== 'object') throw new Error('no parseable JSON')
  return res
}

function clean(v) {
  if (!v || typeof v !== 'object') return { place: null, window: null, kind: null }
  const place = typeof v.place === 'string' && v.place.trim() ? v.place.trim().slice(0, 80) : null
  const window = validWindow(v.window)
  const kind = KINDS.has(v.kind) ? v.kind : null
  return { place, window, kind }
}

export function validWindow(w) {
  if (!w?.start || !w?.end) return null
  const s = new Date(w.start), e = new Date(w.end)
  if (isNaN(s) || isNaN(e) || e < s) return null
  return { start: s.toISOString(), end: e.toISOString() }
}

// ---------- regex fallback ----------

// Names and aliases of the cities we recognize. UPPERCASE short aliases are case-sensitive (LA, DC, NY) to dodge "la", "dc".
const CITIES = [
  ['San Francisco', ['san francisco', 'sf', 'san fran']], ['Oakland', ['oakland']], ['San Jose', ['san jose']],
  ['Los Angeles', ['los angeles', 'LA']], ['San Diego', ['san diego']], ['Seattle', ['seattle']], ['Portland', ['portland', 'pdx']],
  ['Denver', ['denver']], ['Boulder', ['boulder']], ['Austin', ['austin']], ['Dallas', ['dallas']], ['Houston', ['houston']],
  ['Chicago', ['chicago']], ['Minneapolis', ['minneapolis']], ['Boston', ['boston']], ['New York', ['new york', 'nyc', 'manhattan', 'brooklyn', 'NY']],
  ['Philadelphia', ['philadelphia', 'philly']], ['Washington DC', ['washington dc', 'washington, dc', 'DC', 'D.C.']], ['Atlanta', ['atlanta', 'atl']],
  ['Miami', ['miami']], ['Nashville', ['nashville']], ['New Orleans', ['new orleans', 'nola']], ['Phoenix', ['phoenix']],
  ['Salt Lake City', ['salt lake city', 'slc']], ['Las Vegas', ['las vegas', 'vegas']], ['Toronto', ['toronto']], ['Vancouver', ['vancouver']],
  ['Montreal', ['montreal']], ['London', ['london']], ['Berlin', ['berlin']], ['Paris', ['paris']], ['Amsterdam', ['amsterdam']],
  ['Lisbon', ['lisbon']], ['Mexico City', ['mexico city', 'cdmx']], ['Tokyo', ['tokyo']],
]
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ALIASES = CITIES.flatMap(([name, al]) => al.map(a => ({ name, re: new RegExp(`(?<![\\w@#])${esc(a)}(?![\\w])`, a === a.toUpperCase() && a.length <= 4 ? '' : 'i') })))

// Something that says "I am / will be *at* this place", right before the city...
// A bare "to <City>" is too weak ("guide to nyc", "moved to"); require a motion verb in front of it.
const BEFORE = /(?:\b(?:in|at|hit|hitting|visit|visiting|landing|landed|flying|fly|heading|headed|off|back|here|arrived|arriving|coming|around|near|bound for|leaving for|reppin|repping|(?:fly(?:ing)?|head(?:ing|ed)?|going|back|trip|coming|way|road ?trip|train|driv(?:e|ing)|bound|off|welcome|en route)\s+to)\s+(?:the\s+|downtown\s+|beautiful\s+|sunny\s+|rainy\s+)?|->\s*|→\s*)$/i
// ...or a plan-ish word right after it ("SF this weekend", "NYC friends").
const AFTER = /^\s*(?:this|next)\s+(?:week|weekend|month)|^\s*(?:tonight|tomorrow|friends|people|folks|crew|fam|homies|peeps|trip|bound|til|till|until)\b/i

const EVENT = /\b(?:show|concert|gig|conference|conf|summit|meetup|meet-up|talk|panel|festival|fest|party|wedding|hackathon|demo day|game|match|screening)\b/i
const HANGOUT = /\b(?:anyone|who'?s around|who is around|coffee|drinks|dinner|lunch|brunch|hang|hangout|meet up|catch up|dm me|dms open|hmu|hit me up|say hi)\b/i
const TRAVEL = /\b(?:landing|landed|flying|flight|airport|trip|visiting|in town|road ?trip|heading to|headed to|off to|arriv\w*|back in|this week in|here in|touch(?:ing|ed) down)\b/i

export function regexInfer(text, createdAt, tz) {
  const t = text || ''
  let place = null
  for (const { name, re } of ALIASES) {
    const m = re.exec(t)
    if (!m) continue
    const before = t.slice(0, m.index), after = t.slice(m.index + m[0].length)
    if (BEFORE.test(before) || AFTER.test(after)) { place = name; break }
  }
  const window = parseWindow(t, createdAt ? new Date(createdAt) : new Date(), tz)
  const kind = EVENT.test(t) ? 'event' : HANGOUT.test(t) ? 'hangout' : TRAVEL.test(t) ? 'travel' : place ? 'travel' : null
  return { place, window, kind }
}

// ---------- relative time → window, in the author's tz ----------

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const DATE_RANGE = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|—|to|through|thru|til|till|until)\\s*(?:${MON}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')
const DATE_ONE = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')
const WEEKDAY = /\b(?:on\s+|this\s+|next\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b/i

export function parseWindow(text, at, tz) {
  const t = text || ''
  const Z = safeTz(tz)
  const L = localParts(at, Z)
  const day = (offset, h0 = 0, m0 = 0) => ({ start: fromLocal(L.y, L.m, L.d + offset, h0, m0, Z), end: fromLocal(L.y, L.m, L.d + offset, 23, 59, Z) })
  const span = (o1, o2) => ({ start: fromLocal(L.y, L.m, L.d + o1, 0, 0, Z), end: fromLocal(L.y, L.m, L.d + o2, 23, 59, Z) })
  const iso = w => ({ start: w.start.toISOString(), end: w.end.toISOString() })

  let m
  if ((m = DATE_RANGE.exec(t))) {
    const m1 = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), d1 = +m[2]
    const m2 = m[3] ? MONTHS.indexOf(m[3].slice(0, 3).toLowerCase()) : m1, d2 = +m[4]
    const y = yearFor(L, m1)
    const s = fromLocal(y, m1 + 1, d1, 0, 0, Z), e = fromLocal(m2 < m1 ? y + 1 : y, m2 + 1, d2, 23, 59, Z)
    if (e >= s) return iso({ start: s, end: e })
  }
  if ((m = DATE_ONE.exec(t))) {
    const m1 = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), d1 = +m[2]
    const y = yearFor(L, m1)
    return iso({ start: fromLocal(y, m1 + 1, d1, 0, 0, Z), end: fromLocal(y, m1 + 1, d1, 23, 59, Z) })
  }
  if (/\btonight\b|\bthis evening\b/i.test(t)) return iso(day(0, 17))
  if (/\btomorrow night\b|\btomorrow evening\b/i.test(t)) return iso(day(1, 17))
  if (/\btomorrow\b|\btmrw\b|\btmr\b/i.test(t)) return iso(day(1))
  const thisSat = L.wd === 0 ? -1 : 6 - L.wd   // offset in days to the Saturday of the current weekend
  if (/\bnext weekend\b/i.test(t)) return iso(span(thisSat + 7, thisSat + 8))
  if (/\b(?:this|the)\s+weekend\b|\bthis wknd\b/i.test(t)) return iso(span(thisSat, thisSat + 1))
  if (/\bnext week\b/i.test(t)) { const mon = ((8 - L.wd) % 7) || 7; return iso(span(mon, mon + 6)) }
  if (/\bthis week\b|\ball week\b|\bfor the week\b/i.test(t)) { const sun = (7 - L.wd) % 7; return iso(span(0, sun)) }
  if ((m = WEEKDAY.exec(t))) {
    const wd = DAYS.indexOf(m[1].slice(0, 3).toLowerCase())
    const off = (wd - L.wd + 7) % 7
    return iso(day(/next\s+$/i.test(t.slice(0, m.index)) ? off + 7 : off))
  }
  if (/\bright now\b|\bcurrently\b|\bjust landed\b|\bhere in\b|\btoday\b|\bthis morning\b|\bthis afternoon\b/i.test(t)) return iso(day(0))
  return null
}

// month index → year such that the date is not far in the past relative to the tweet
const yearFor = (L, monthIdx) => (monthIdx + 1 < L.m - 2 ? L.y + 1 : L.y)

function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz || 'UTC' } catch { return 'UTC' }
}
function offsetMin(tz, date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'GMT'
  const m = s.match(/([+-])(\d{2}):?(\d{2})?/)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0
}
export function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(date).map(x => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, wd: DAYS.indexOf(p.weekday.slice(0, 3).toLowerCase()), h: +p.hour % 24 }
}
// local wall-clock → Date (day may overflow; Date.UTC normalizes)
export function fromLocal(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  return new Date(guess - offsetMin(tz, new Date(guess)) * 60e3)
}
