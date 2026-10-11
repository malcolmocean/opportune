// Shared porchlight + at-home logic for triggers/porchlightProximity and queries/dropin.
// Deterministic, no LLM. Nothing here returns coordinates to a caller that will reveal them.

export const HOME_FRESH_MS = 60 * 60e3

// The person's declared home place.
export function homePlace(ctx, personId) {
  return ctx.people.home(personId)
}

// Effective porchlight right now: an explicit status observation still within its `until`,
// else an open window from policy.dropinWindows for the local time in the person's tz,
// else policy.dropinDefault. Returns { state, source, until?, note? }.
// `note` is the status's own note when it has one, else the person's standing dropin_note (set once, survives
// every status change; a status note replaces it for that status only). Absent when both are empty, and the standing
// note never shows under a closed porchlight (it is an invitation; the status's own note still can: "back at 9").
export function porchlight(ctx, person) {
  const row = ctx.observations.latest(person.id, 'status', { activeOnly: true })
  const defaultNote = person.dropin_note ?? ctx.people.get(person.id)?.dropin_note
  const withNote = (r, own) => { const note = own || (r.state !== 'closed' ? defaultNote : null); return note ? { ...r, note } : r }
  const pol = ctx.people.policy(person.id)
  // a timed status says what it falls back to when it ends (`then`), so the UI can say "until 8:00, then ask"
  if (['open', 'closed', 'ask'].includes(row?.data?.porchlight)) return withNote({ state: row.data.porchlight, source: 'status', until: row.until, ...(row.until ? { then: pol.dropinDefault || 'ask' } : {}) }, row.data.note)
  const { day, hour } = localNow(person.tz)
  const inWindow = (pol.dropinWindows || []).some(w => (!w.days || w.days.includes(day)) && spans(w.start, w.end, hour))
  if (inWindow) return withNote({ state: 'open', source: 'window' })
  return withNote({ state: pol.dropinDefault || 'ask', source: 'default' })
}

// The next instant that is `hour`:00 in the given tz, strictly after `from` (so "until morning" = next quiet-hours end).
export function nextLocalHour(tz, hour, from = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
  const parts = d => Object.fromEntries(fmt.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]))
  const p = parts(from)
  for (let add = 0; add <= 2; add++) {
    const guess = new Date(Date.UTC(p.year, p.month - 1, p.day + add, hour, 0, 0))   // right wall-clock, wrong zone
    const g = parts(guess)
    const offsetMs = Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute) - guess.getTime()   // local minus UTC at that instant
    const real = new Date(guess.getTime() - offsetMs)
    if (real > from) return real
  }
  return new Date(from.getTime() + 24 * 3600e3)
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
