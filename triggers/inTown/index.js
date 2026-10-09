import { cityFor, matchesCity } from './cities.js'

// A tweeted (or otherwise mentioned) whereabouts for A lands in the city where friend F lives.
// F is the local who should hear that A is visiting. Deterministic: the source did the inference.
const STALE_MS = 10 * 864e5
const DEFAULT_TTL_MS = 7 * 864e5
const HOSTING = /party|dinner|birthday|housewarming/i

export default {
  id: 'inTown',
  name: 'Out-of-towner is in town',
  on: ['mention'],
  run(ctx, { observation: o, person: a }) {
    const place = o.data?.inferredPlace
    if (!place) return []
    const window = validWindow(o.data.inferredWindow)
    const now = Date.now()
    if (window && new Date(window.end).getTime() < now) return []
    if (!window && now - new Date(o.at).getTime() > STALE_MS) return []
    const myCity = cityFor(homeOf(ctx, a), ctx.geo.distanceM)
    const out = []
    for (const f of ctx.people.all()) {
      if (f.id === a.id) continue
      const af = ctx.people.rel(a.id, f.id), fa = ctx.people.rel(f.id, a.id)
      if (!af && !fa) continue
      if (!(af?.want_more || fa?.want_more)) continue
      const city = cityFor(homeOf(ctx, f), ctx.geo.distanceM)
      if (!city || !matchesCity(place, city)) continue
      if (myCity && myCity.slug === city.slug) continue   // A lives there too; not news
      out.push(opp(ctx, { a, f, af, fa, city, o, window, now }))
    }
    return out
  },
}

function opp(ctx, { a, f, af, fa, city, o, window, now }) {
  const label = city.short || city.name
  const expiresAt = window?.end || new Date(now + DEFAULT_TTL_MS).toISOString()
  const when = window ? fmtWindow(window, f.tz) : ''
  const wants = af?.want_more && fa?.want_more
    ? `${f.display_name} (${label}) and ${a.display_name} both want to see more of each other.`
    : fa?.want_more ? `${f.display_name} (${label}) wants to see more of ${a.display_name}.`
    : `${a.display_name} wants to see more of ${f.display_name} (${label}).`
  let summary = `${a.display_name} tweeted they're in ${label}${when ? ' ' + when : ''}. ${wants}`
  const evidence = [{ kind: 'mention', who: a.id, tweetUrl: o.data.url, text: o.data.text, place: o.data.inferredPlace, window, at: o.at }]
  const [ws, we] = window ? [window.start, window.end] : [new Date(now).toISOString(), expiresAt]
  const hosted = ctx.observations.eventsIn(f.id, ws, we).find(e => (e.data?.attendees?.length || 0) >= 3 || HOSTING.test(e.data?.title || ''))
  if (hosted) {
    summary += ` ${f.display_name} is hosting "${hosted.data.title}" on ${dayName(hosted.at, f.tz)} — invite them?`
    evidence.push({ kind: 'event', who: f.id, title: hosted.data.title, at: hosted.at, attendees: hosted.data.attendees?.length || 0, url: hosted.data.url || null })
  }
  return {
    kind: 'inTown', participants: [a.id, f.id], primary: f.id, summary, evidence,
    dedupeKey: `intown:${a.id}:${f.id}:${city.slug}:${isoWeek(window?.start || o.at)}`,
    expiresAt,
  }
}

function homeOf(ctx, p) {
  const mine = ctx.people.places(p.id).filter(pl => pl.owner_id === p.id)
  return mine.find(pl => pl.id === p.home_place_id) || mine.find(pl => /^home$/i.test(pl.name)) || null
}

function validWindow(w) {
  if (!w?.start || !w?.end) return null
  const s = new Date(w.start), e = new Date(w.end)
  if (isNaN(s) || isNaN(e) || e < s) return null
  return { start: s.toISOString(), end: e.toISOString() }
}

const fmtDay = (iso, tz, opts) => { try { return new Date(iso).toLocaleDateString('en-US', { ...opts, timeZone: tz }) } catch { return new Date(iso).toLocaleDateString('en-US', opts) } }
const dayName = (iso, tz) => fmtDay(iso, tz, { weekday: 'short' })
function fmtWindow(w, tz) {
  const s = fmtDay(w.start, tz, { month: 'short', day: 'numeric' }), e = fmtDay(w.end, tz, { month: 'short', day: 'numeric' })
  if (s === e) return `on ${s}`
  const [sm, sd] = s.split(' '), [em, ed] = e.split(' ')
  return sm === em ? `${sm} ${sd}–${ed}` : `${s}–${e}`
}

export function isoWeek(iso) {
  const d = new Date(iso)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = t.getUTCFullYear()
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7)
  return `${y}-W${String(w).padStart(2, '0')}`
}
