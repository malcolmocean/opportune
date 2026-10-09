// Shared porchlight + at-home logic for triggers/porchlightProximity and queries/dropin.
// Deterministic, no LLM. Nothing here returns coordinates to a caller that will reveal them.

export const HOME_FRESH_MS = 60 * 60e3

// The person's declared home place (ctx.people.places also returns shared places; we only want theirs).
export function homePlace(ctx, personId) {
  return ctx.people.places(personId).find(p => p.owner_id === personId && p.name === 'home') || null
}

// Effective porchlight right now: an explicit status observation still within its `until`,
// else an open window from policy.dropinWindows for the local time in the person's tz,
// else policy.dropinDefault. Returns { state, source, until? }.
export function porchlight(ctx, person) {
  const nowIso = new Date().toISOString()
  const row = ctx.db.get(
    `select * from observations where person_id = ? and kind = 'status' and (until is null or until > ?) order by at desc, rowid desc limit 1`,
    person.id, nowIso,
  )
  if (row) {
    let data = row.data
    try { data = typeof data === 'string' ? JSON.parse(data) : data } catch {}
    if (['open', 'closed', 'ask'].includes(data?.porchlight)) return { state: data.porchlight, source: 'status', until: row.until, note: data.note }
  }
  const pol = ctx.people.policy(person.id)
  const { day, hour } = localNow(person.tz)
  const inWindow = (pol.dropinWindows || []).some(w => (!w.days || w.days.includes(day)) && spans(w.start, w.end, hour))
  if (inWindow) return { state: 'open', source: 'window' }
  return { state: pol.dropinDefault || 'ask', source: 'default' }
}

// { day: 0..6 (Sun..Sat), hour: 0..23 } in the given IANA tz.
export function localNow(tz, d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(d)
  const wd = parts.find(p => p.type === 'weekday')?.value
  const hour = Number(parts.find(p => p.type === 'hour')?.value) % 24
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour }
}

// hour in [start, end), wrapping midnight when start > end
const spans = (start, end, hour) => (start > end ? hour >= start || hour < end : hour >= start && hour < end)

// Is this location observation at the person's home? placeName 'home', or within the home place's radius.
export function atHome(ctx, personId, loc, home = homePlace(ctx, personId)) {
  if (!loc?.data) return false
  if (loc.data.placeName === 'home') return true
  if (!home || loc.data.lat == null) return false
  return ctx.geo.distanceM(loc.data, home) <= (home.radius_m || 150)
}

// Latest fresh location + whether it's home. { loc, home, isHome }
export function presence(ctx, personId) {
  const home = homePlace(ctx, personId)
  const loc = ctx.observations.latest(personId, 'location', { within: HOME_FRESH_MS })
  return { loc, home, isHome: atHome(ctx, personId, loc, home) }
}
